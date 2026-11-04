// The public sandbox: isolated visitors, limits, expiry and the two engines.
//   live    with MODEL_API_KEY: Muse plans on the visitor's demo world, under a token budget
//   replay  without a key, or once the budget is spent: the golden paths play from eval/scripts
//           through the real loop with the scripted model, so the page always works
// Either way Core is real: the tier gate, the tap on the simulated watch, receipts and Undo.
// Vision and computer use are always replayed: the synthetic poster and the demo booking page.
import { runCommand, undoReceipt, type AgentDeps, type MuseLike } from "../agent/loop.ts";
import { latestReceipt, receiptRefs, ScriptedMuse } from "../eval/scripted.ts";
import { applyFixtures } from "../eval/world.ts";
import { receiptsIn, sessionEvents } from "../memory/history.ts";
import { whyNot } from "../memory/receipts.ts";
import { silentOps, type OpsLog } from "../obs/opslog.ts";
import type { SpendGuard } from "../obs/spend.ts";
import type { AurenEvent } from "../protocol.ts";
import type { Ledger } from "../security/ledger.ts";
import { examples, loadCatalog, match, type Example, type ReplayEntry } from "./catalog.ts";
import { Limiter, rateKey } from "./limits.ts";
import { DEVICES, SESSION, Visitor, type DeviceId } from "./visitor.ts";

export interface LiveEngine {
  muse: MuseLike;
  agentModel: string;
  fastModel?: string;
  /** Where the live engine's tokens are counted (in memory in sandbox mode). */
  ledger: Ledger;
  /** AUREN_TOKEN_LIMIT, over the same ledger. */
  spend?: SpendGuard;
}

export interface SandboxOptions {
  /** Without it, every command replays. */
  live?: LiveEngine;
  /** Tokens the live engine may spend, across every visitor. 0 means replay only. */
  tokenBudget: number;
  /** Commands per visitor address, per minute and per UTC day. */
  rpm: number;
  daily: number;
  maxVisitors: number;
  /** Proxies in front whose X-Forwarded-For is trusted (AUREN_TRUST_PROXY). 0 ignores the header. */
  trustProxy: number;
  /** Commands running at once, across every visitor. */
  maxConcurrent?: number;
  /** Sessions per visitor address; a new one replaces that address's oldest. */
  perAddress?: number;
  /** Requests of any kind per address per minute. */
  requestsPerMinute?: number;
  maxChars?: number;
  idleMs?: number;
  maxLifeMs?: number;
  approvalTimeoutMs?: number;
  timeZone?: string;
  ops?: OpsLog;
  now?: () => number;
}

export interface Engine {
  mode: "live" | "replay";
  label: string;
  /** Why it's replaying: no_key, replay_only, budget, limit or failing. Null when live. */
  reason: string | null;
  model?: string;
}

export const DEFAULTS = {
  maxConcurrent: 12,
  perAddress: 3,
  requestsPerMinute: 600,
  maxChars: 280,
  idleMs: 30 * 60_000,
  maxLifeMs: 4 * 60 * 60_000,
  approvalTimeoutMs: 60_000,
};

const REPLAY_ACK = "replay-ack";
/** In a replay, a script that expected a tap ends with this when the tap was declined, never with its canned "Done". */
export const NOT_SENT = "Nothing went out without your tap. Anything else I did is on the timeline, with Undo.";

const WHY_REPLAY: Record<string, string> = {
  no_key: "The live model isn't connected here",
  replay_only: "This sandbox is set to replay",
  budget: "The live model's budget for this sandbox is spent",
  limit: "Auren's token limit is reached",
  failing: "The live model isn't answering right now",
};

export const displayModel = (id: string) => (/wonder/i.test(id) ? "Muse Wonder" : /spark/i.test(id) ? "Muse Spark" : id);

export type Opened = { ok: true; visitor: Visitor } | { ok: false; status: 429 | 503; error: string };
export type Answer = { status: 200 | 202 | 400 | 404 | 409 | 429 | 503; body: Record<string, unknown>; retryAfterS?: number };

export class Sandbox {
  readonly catalog: ReplayEntry[];
  readonly visitors = new Map<string, Visitor>();
  readonly requests: Limiter;
  running = 0;
  #o: SandboxOptions & typeof DEFAULTS;
  #commands: Limiter;
  #ops: OpsLog;
  #now: () => number;
  #liveFailures = 0;
  #livePausedUntil = 0;
  #ticker: ReturnType<typeof setInterval>;
  #sweeper: ReturnType<typeof setInterval>;

  constructor(opts: SandboxOptions, catalog: ReplayEntry[] = loadCatalog()) {
    this.#o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) } as SandboxOptions & typeof DEFAULTS;
    this.catalog = catalog;
    this.#ops = opts.ops ?? silentOps;
    this.#now = opts.now ?? Date.now;
    this.#commands = new Limiter({ perMinute: this.#o.rpm, perDay: this.#o.daily, now: this.#now });
    this.requests = new Limiter({ perMinute: this.#o.requestsPerMinute, now: this.#now });
    // Simulated devices stay present while their visitor exists.
    this.#ticker = setInterval(() => {
      for (const v of this.visitors.values()) v.beat();
    }, 500);
    this.#sweeper = setInterval(() => this.sweep(), 30_000);
    this.#ticker.unref();
    this.#sweeper.unref();
  }

  get limits() {
    return { rpm: this.#o.rpm, daily: this.#o.daily, max_chars: this.#o.maxChars, idle_minutes: Math.round(this.#o.idleMs / 60_000) };
  }

  examples(): Example[] {
    return examples(this.catalog);
  }

  engine(): Engine {
    const live = this.#o.live;
    const replay = (reason: string): Engine => ({ mode: "replay", label: "Replay", reason });
    if (!live) return replay("no_key");
    if (this.#o.tokenBudget <= 0) return replay("replay_only");
    if (live.spend?.refusal()) return replay("limit");
    if (live.ledger.totals().total >= this.#o.tokenBudget) return replay("budget");
    if (this.#now() < this.#livePausedUntil) return replay("failing");
    return { mode: "live", label: `Live · ${displayModel(live.agentModel)}`, reason: null, model: live.agentModel };
  }

  // ── visitors ───────────────────────────────────────────────────────────

  /** A visitor's session, or a new one. A full address gives up its oldest idle session first. */
  open(ip: string, existing?: string | null): Opened {
    const known = existing ? this.get(existing) : undefined;
    if (known) return { ok: true, visitor: known };
    this.sweep();
    const key = rateKey(ip);
    const mine = [...this.visitors.values()].filter((v) => rateKey(v.ip) === key).sort((a, b) => a.lastActive - b.lastActive);
    if (mine.length >= this.#o.perAddress) {
      const oldest = mine.find((v) => !v.busy);
      if (!oldest) return { ok: false, status: 429, error: "Too many sandbox sessions from your network are busy. Try again in a minute." };
      this.#drop(oldest, "replaced");
    }
    if (this.visitors.size >= this.#o.maxVisitors) {
      this.#ops.warn("sandbox.full", { visitors: this.visitors.size });
      return { ok: false, status: 503, error: "The sandbox is full right now. Try again in a few minutes." };
    }
    const v = new Visitor(ip, this.#now());
    // Vision always reads the eval's synthetic poster, so a live model sees the same event GP2 does.
    const gp2 = this.catalog.find((e) => e.case.fixtures.poster);
    if (gp2) applyFixtures(v.world, { poster: gp2.case.fixtures.poster });
    this.visitors.set(v.id, v);
    this.#ops.info("sandbox.visitor", { status: "joined", visitors: this.visitors.size });
    return { ok: true, visitor: v };
  }

  get(id: string): Visitor | undefined {
    return this.visitors.get(id);
  }

  /** Expires idle visitors (30 min by default) and any older than the absolute limit, unless mid-command. */
  sweep(): void {
    const now = this.#now();
    for (const v of this.visitors.values()) {
      if (v.busy) continue;
      if (now - v.lastActive > this.#o.idleMs || now - v.createdAt > this.#o.maxLifeMs) this.#drop(v, "expired");
    }
    this.#commands.sweep();
    this.requests.sweep();
  }

  #drop(v: Visitor, status: string): void {
    v.close();
    this.visitors.delete(v.id);
    this.#ops.info("sandbox.visitor", { status, visitors: this.visitors.size });
  }

  close(): void {
    clearInterval(this.#ticker);
    clearInterval(this.#sweeper);
    for (const v of this.visitors.values()) v.close();
    this.visitors.clear();
  }

  // ── what a visitor can do ──────────────────────────────────────────────

  /** Checks a command from `ip` against every limit, then starts it. The reply arrives in the visitor's log. */
  command(v: Visitor, raw: string, ip: string = v.ip): Answer {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return { status: 400, body: { error: "Say something first." } };
    if (text.length > this.#o.maxChars) return { status: 400, body: { error: `Keep it under ${this.#o.maxChars} characters.` } };
    if (v.busy) return { status: 409, body: { error: "Auren is still on your last command. Answer the tap, or give it a moment." } };
    if (this.running >= this.#o.maxConcurrent) {
      this.#ops.warn("sandbox.refused", { reason: "concurrency", running: this.running });
      return { status: 503, body: { error: "The sandbox is busy right now. Try again in a few seconds." }, retryAfterS: 5 };
    }
    const rate = this.#commands.take(rateKey(ip));
    if (!rate.ok) {
      this.#ops.info("sandbox.refused", { reason: rate.why });
      const error =
        rate.why === "day" ? `That's the daily limit of ${this.#o.daily} commands from your network. Come back tomorrow.`
        : rate.why === "minute" ? `That's ${this.#o.rpm} commands this minute. Try again in ${rate.retryAfterS} s.`
        : "The sandbox is busy right now. Try again in a minute.";
      return { status: 429, body: { error }, retryAfterS: rate.retryAfterS };
    }
    v.lastActive = this.#now();
    const engine = this.engine();
    void this.run(v, text, engine);
    return { status: 202, body: { accepted: true, engine } };
  }

  /** A tap on one of the visitor's own simulated devices, for a request that device holds. */
  answer(v: Visitor, requestId: string, approved: boolean, surface: DeviceId): Answer {
    const tap = v.taps.get(requestId);
    if (!tap) return { status: 404, body: { error: "That tap isn't waiting any more." } };
    if (tap.surface !== surface) return { status: 409, body: { error: `That tap is on the ${surface === "watch" ? "phone" : "watch"} now.` } };
    v.lastActive = this.#now();
    return v.surfaces.answer(requestId, approved, surface) ? { status: 200, body: { ok: true } } : { status: 404, body: { error: "That tap isn't waiting any more." } };
  }

  /** The Undo button: the same path as the console, with the same checks as "undo that". */
  async undo(v: Visitor, receiptId: number): Promise<Answer> {
    const r = receiptsIn(sessionEvents(v.log, SESSION)).find((x) => x.id === receiptId);
    if (!r) return { status: 404, body: { ok: false, message: "No such receipt." } };
    const why = whyNot(r, v.tools);
    if (why) return { status: 409, body: { ok: false, message: `Can't undo: ${why}.` } };
    v.lastActive = this.#now();
    try {
      return { status: 200, body: await undoReceipt({ log: v.log, tools: v.tools, surfaces: v.surfaces }, receiptId, SESSION) };
    } catch (err) {
      return { status: 409, body: { ok: false, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  /** Everything the page shows, since the last poll. Polling isn't activity, so an open tab still expires. */
  state(v: Visitor, since: number, outputsSince: number) {
    return {
      events: v.log.since(SESSION, since, 200).map((e) => present(v, e)),
      outputs: v.outputs.filter((o) => o.id > outputsSince),
      taps: [...v.taps.values()],
      devices: DEVICES.map((d) => ({ id: d.id, kind: d.kind, name: d.name, online: v.isUp(d.id) })),
      busy: v.busy,
      engine: this.engine(),
      expires_in_s: Math.max(0, Math.round((v.lastActive + this.#o.idleMs - this.#now()) / 1000)),
    };
  }

  // ── the engines ────────────────────────────────────────────────────────

  async run(v: Visitor, text: string, engine: Engine = this.engine()): Promise<void> {
    const entry = match(this.catalog, text);
    const origin: DeviceId = entry?.where ?? "phone";
    v.busy = true;
    v.declined = false;
    this.running++;
    this.#ops.info("sandbox.command", { engine: engine.mode, replay: entry?.id ?? null, chars: text.length });
    // A case's timed script (GP3 takes the watch off at 3 s) plays in both engines, and is undone after.
    const timers = entry ? entry.case.script.map((s) => v.later(s.at_ms, () => (s.action === "drop" ? v.down(s.surface as DeviceId) : v.up(s.surface as DeviceId)))) : [];
    try {
      if (entry && !v.seeded.has(entry.case.id)) {
        v.seeded.add(entry.case.id);
        applyFixtures(v.world, entry.case.fixtures);
      }
      if (engine.mode === "live") await this.#live(v, text, origin);
      else if (entry) await this.#replay(v, text, entry, origin);
      else this.#say(v, text, origin, `${WHY_REPLAY[engine.reason ?? "no_key"]}, so this sandbox replays the golden paths. Try one of these.`, engine.reason);
      if (entry) v.played.add(entry.case.id);
    } catch (err) {
      v.log.append(SESSION, "error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      for (const t of timers) v.cancel(t);
      v.restore();
      v.busy = false;
      this.running--;
      v.lastActive = this.#now();
    }
  }

  async #live(v: Visitor, text: string, origin: DeviceId): Promise<void> {
    const live = this.#o.live!;
    const { reply } = await runCommand(this.#deps(v, live.muse, live.agentModel, live.fastModel), { session: SESSION, text, originSurfaceId: origin });
    // Two failures in a row (a bad key, the credits gone): replay for five minutes, so the page keeps working.
    if (reply.startsWith("error:")) {
      if (++this.#liveFailures >= 2) {
        this.#livePausedUntil = this.#now() + 5 * 60_000;
        this.#liveFailures = 0;
        this.#ops.warn("sandbox.live_paused", { minutes: 5 });
      }
    } else this.#liveFailures = 0;
  }

  async #replay(v: Visitor, text: string, entry: ReplayEntry, origin: DeviceId): Promise<void> {
    const blocked = this.#blocked(v, entry);
    if (blocked) return this.#say(v, text, origin, blocked, "needs_first");
    const scripted = new ScriptedMuse(v, REPLAY_ACK);
    scripted.load(entry.command);
    // The script's last line assumes the person approved. If they didn't, Auren says so instead.
    const expectsTap = entry.case.expect.approvals.length > 0;
    const muse: MuseLike = {
      responses: {
        create: async (params) => {
          const resp = await scripted.responses.create(params);
          const final = params.model !== REPLAY_ACK && !(resp.output ?? []).length;
          return final && expectsTap && v.declined ? { ...resp, output_text: NOT_SENT } : resp;
        },
      },
    };
    await runCommand(this.#deps(v, muse, "replay", REPLAY_ACK), { session: SESSION, text, originSurfaceId: origin });
  }

  /** Why an example can't replay yet: GP5 recaps and undoes what GP1 did, so GP1 comes first. */
  #blocked(v: Visitor, entry: ReplayEntry): string | null {
    const after = typeof entry.case.fixtures.after === "string" ? entry.case.fixtures.after : null;
    const first = this.catalog.find((e) => e.case.id === after)?.golden ?? "GP1";
    if (after && !v.played.has(after)) return `Replay plays ${entry.golden} after ${first}. Tap ${first} first, so there's something to ${entry.index ? "undo" : "recap"}.`;
    for (const [ns, tool] of receiptRefs(entry.command)) {
      const r = latestReceipt(v, ns, tool);
      const all = r ? receiptsIn(sessionEvents(v.log, SESSION)) : [];
      const target = all.find((x) => x.id === r?.id);
      if (!target || target.undoes !== undefined || target.undoneBy !== undefined || !target.undo) {
        return `There's nothing left to undo from ${first}. Tap ${first} again to make a new change.`;
      }
    }
    return null;
  }

  /** A reply without the agent loop: what the visitor said, and Auren's answer with examples to tap. */
  #say(v: Visitor, text: string, origin: DeviceId, reply: string, reason: string | null): void {
    v.log.append(SESSION, "utterance", { text, surface_id: origin });
    v.log.append(SESSION, "reply", { text: reply, spoken_on: v.surfaces.speak(reply, origin), sandbox: reason, suggestions: this.catalog.map((e) => e.id) });
  }

  #deps(v: Visitor, muse: MuseLike, agentModel: string, fastModel?: string): AgentDeps {
    return {
      muse,
      tools: v.tools,
      surfaces: v.surfaces,
      log: v.log,
      agentModel,
      fastModel,
      timeZone: this.#o.timeZone,
      maxTurns: 8,
      approvalTimeoutMs: this.#o.approvalTimeoutMs,
      ops: this.#ops,
    };
  }
}

/** Receipts that followed glasses.look carry the crop SAM outlined, inline, since the page has no other way to fetch it. */
function present(v: Visitor, e: AurenEvent): AurenEvent {
  const crop = e.kind === "receipt" && typeof e.data.crop_id === "string" ? v.world.crops.get(e.data.crop_id) : undefined;
  return crop ? { ...e, data: { ...e.data, crop: `data:image/jpeg;base64,${crop.toString("base64")}` } } : e;
}
