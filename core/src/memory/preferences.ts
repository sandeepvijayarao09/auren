// Auren Preferences: what Auren has learned about the user from their own receipts.
//
// No model is involved. Preferences are counted from the event log (tool calls,
// approvals and receipts) as each event lands, kept encrypted under their own
// derived key, and decay over time, so last month's habit fades unless it repeats.
// Wonder sees a short, bounded block of the confident ones, marked as the user's
// own data. A preference only fills in details; it never changes a tool's tier.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { EventLog } from "../eventlog.ts";
import type { AurenEvent } from "../protocol.ts";

export const PREF_KEYS = ["status_channel", "contacts", "meeting_length", "meeting_time", "approval_device", "restaurant", "party_size"] as const;
export type PrefKey = (typeof PREF_KEYS)[number];

const LABELS: Record<PrefKey, string> = {
  status_channel: "Channel for status and running-late posts",
  contacts: "Frequent contacts",
  meeting_length: "Typical meeting length",
  meeting_time: "Preferred meeting time",
  approval_device: "Device you usually approve on",
  restaurant: "Restaurant you book",
  party_size: "Usual party size",
};

/** One piece of evidence: a value seen in a receipt (or approval) at a time. */
interface Obs { value: string; at: number; id: number; detail?: string }

export interface Preference {
  key: PrefKey;
  label: string;
  /** The leading value (for contacts, up to three). */
  value: string;
  /** Extra context for the value, such as a channel id or an email address. */
  detail?: string;
  /** 0 to 1: how much the leading value dominates, and how much (decayed) evidence backs it. */
  confidence: number;
  evidence: { count: number; total: number; latest: number[]; last_seen: string };
}

export interface PreferencesOptions {
  /** The database file (shared with the event log), or ":memory:". */
  path?: string;
  /** The `preferences` key derived from the master key. */
  key?: Buffer;
  log: EventLog;
  session: string;
  now?: () => number;
  /** How long until a piece of evidence counts half as much. Default 21 days. */
  halfLifeMs?: number;
}

export const DAY_MS = 86_400_000;
const MAX_OBS = 40;
/** Below this, a preference is shown in the console but never reaches the prompt. */
export const PROMPT_THRESHOLD = 0.4;
/** The whole "What I know about you" block, header included, stays under this. */
export const PROMPT_MAX_CHARS = 600;

const STATUS = /\b(late|running|leaving|leave|heading|on my way|omw|delay(ed)?|out of (the )?office|ooo|back (at|by)|away|stuck|traffic|sick|wfh|be there|eta|offline)\b/i;
const NUMBERS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const STATE = "_state";

interface Pending {
  cursor: number;
  /** The last call of each send/write tool, waiting for its receipt. */
  calls: Record<string, Record<string, unknown>>;
  /** Names looked up with find_contact since the last utterance. */
  names: string[];
}

export class Preferences {
  #db: DatabaseSync;
  #key: Buffer;
  #log: EventLog;
  #session: string;
  #now: () => number;
  #halfLife: number;
  #pending: Pending;
  #off: () => void;

  constructor(o: PreferencesOptions) {
    this.#db = new DatabaseSync(o.path ?? ":memory:");
    this.#key = o.key ?? randomBytes(32);
    this.#log = o.log;
    this.#session = o.session;
    this.#now = o.now ?? Date.now;
    this.#halfLife = o.halfLifeMs ?? 21 * DAY_MS;
    this.#db.exec("CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, data BLOB NOT NULL)");
    this.#pending = (this.#get(STATE) as Pending | undefined) ?? { cursor: 0, calls: {}, names: [] };
    // Catch up on anything logged while Core was off, then follow the log live.
    for (let page = this.#log.since(this.#session, this.#pending.cursor); page.length; page = this.#log.since(this.#session, page.at(-1)!.id)) {
      for (const e of page) this.ingest(e);
    }
    this.#off = this.#log.onEvent((e) => this.ingest(e));
  }

  close(): void {
    this.#off();
  }

  /** Learn from one event. Called for every event as it's appended; events already seen are skipped. */
  ingest(e: AurenEvent): void {
    if (e.session !== this.#session || e.id <= this.#pending.cursor) return;
    this.#pending.cursor = e.id;
    const d = e.data as Record<string, any>;
    if (e.kind === "utterance") this.#pending.names = [];
    if (e.kind === "tool_call" && typeof d.namespace === "string") {
      const args = (d.args ?? {}) as Record<string, unknown>;
      if (d.tool === "find_contact" && typeof args.name === "string") this.#pending.names.push(args.name.slice(0, 60));
      if (d.tier !== "read") this.#pending.calls[`${d.namespace}.${d.tool}`] = args;
    }
    if (e.kind === "approval" && d.status === "approved" && typeof d.surface_id === "string") {
      this.#add("approval_device", { value: d.surface_id.slice(0, 40), at: e.at, id: e.id });
    }
    if (e.kind === "receipt" && typeof d.namespace === "string" && d.undoes === undefined) this.#fromReceipt(e, d);
    this.#put(STATE, this.#pending);
  }

  #fromReceipt(e: AurenEvent, d: Record<string, any>): void {
    const name = `${d.namespace}.${d.tool}`;
    const args = this.#pending.calls[name] ?? {};
    delete this.#pending.calls[name];
    const summary = String(d.summary ?? "");
    const at = e.at, id = e.id;
    if (d.tool === "post_message") {
      const text = String(args.text ?? "");
      const channelId = String(args.channel_id ?? args.channel ?? "");
      const channel = summary.match(/#[\w-]+/)?.[0] ?? (channelId ? channelId : "");
      if (channel && STATUS.test(text)) this.#add("status_channel", { value: channel.slice(0, 40), at, id, ...(channelId && channelId !== channel ? { detail: `channel_id ${channelId.slice(0, 20)}` } : {}) });
    }
    if (d.tool === "invite" && Array.isArray(args.emails)) {
      const emails = (args.emails as unknown[]).filter((x): x is string => typeof x === "string" && x.includes("@"));
      const names = this.#pending.names;
      emails.forEach((email, i) => this.#contact(email, emails.length === names.length ? names[i] : undefined, at, id));
    }
    if (typeof d.to === "string") {
      const m = d.to.match(/^\s*"?([^"<]*?)"?\s*<([^>]+@[^>]+)>\s*$/);
      if (m) this.#contact(m[2], m[1] || undefined, at, id);
      else if (d.to.includes("@")) this.#contact(d.to.trim(), undefined, at, id);
    }
    if (d.tool === "create_event" && typeof args.start === "string") {
      const start = localParts(args.start);
      if (start) {
        const end = typeof args.end === "string" ? localParts(args.end) : undefined;
        const minutes = end ? Math.round((end.ms - start.ms) / 60_000) : 60;
        if (minutes > 0 && minutes <= 8 * 60) this.#add("meeting_length", { value: `${minutes} min`, at, id });
        this.#add("meeting_time", { value: partOfDay(start.hour), at, id, detail: `${String(start.hour).padStart(2, "0")}:00` });
      }
    }
    if (d.tool === "move_event" && typeof args.new_start === "string") {
      const start = localParts(args.new_start);
      if (start) this.#add("meeting_time", { value: partOfDay(start.hour), at, id, detail: `${String(start.hour).padStart(2, "0")}:00` });
    }
    // Only bookings the user tapped through count: the receipt exists only after the commit.
    if (d.namespace === "browser") {
      const text = `${String(args.task ?? "")} ${String(args.summary ?? "")} ${summary}`;
      const party = text.match(/\b(?:for|party of|table for)\s+(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)\b/i)?.[1];
      const size = party ? Number(party) || NUMBERS[party.toLowerCase()] : undefined;
      if (size) this.#add("party_size", { value: String(size), at, id });
      const place = [...text.matchAll(/\bat\s+((?:[A-Z][\w'&.-]*)(?:\s+[A-Z][\w'&.-]*)*)/g)].map((m) => m[1]).find((p) => !/^(AM|PM|Noon)$/i.test(p));
      const time = text.match(/\b(\d{1,2}(?::\d{2})?\s*(?:AM|PM))\b/i)?.[1];
      if (place) this.#add("restaurant", { value: place.slice(0, 40), at, id, ...(time ? { detail: `around ${time.toUpperCase()}` } : {}) });
    }
  }

  #contact(email: string, name: string | undefined, at: number, id: number): void {
    const e = email.toLowerCase().slice(0, 80);
    this.#add("contacts", { value: e, at, id, ...(name?.trim() ? { detail: name.trim().slice(0, 40) } : {}) });
  }

  #add(key: PrefKey, o: Obs): void {
    const obs = (this.#get(key) as Obs[] | undefined) ?? [];
    obs.push(o);
    this.#put(key, obs.slice(-MAX_OBS));
  }

  /** Every learned preference, most confident first, with its evidence. */
  list(): Preference[] {
    const now = this.#now();
    const out: Preference[] = [];
    for (const key of PREF_KEYS) {
      const obs = this.#get(key) as Obs[] | undefined;
      if (!obs?.length) continue;
      const weight = (o: Obs) => 0.5 ** (Math.max(0, now - o.at) / this.#halfLife);
      const by = new Map<string, { w: number; n: number; obs: Obs[] }>();
      let total = 0;
      for (const o of obs) {
        const w = weight(o);
        total += w;
        const v = by.get(o.value) ?? { w: 0, n: 0, obs: [] };
        v.w += w;
        v.n++;
        v.obs.push(o);
        by.set(o.value, v);
      }
      const ranked = [...by.entries()].sort((a, b) => b[1].w - a[1].w || b[1].n - a[1].n);
      const [topValue, top] = ranked[0];
      // Contacts are many at once, so dominance doesn't apply; for the rest, a split habit is a weak one.
      const share = key === "contacts" ? 1 : top.w / total;
      const confidence = round(share * (1 - Math.exp(-top.w / 1.5)));
      const latestOf = (os: Obs[]) => os.slice(-3).reverse().map((o) => o.id);
      const lastDetail = [...top.obs].reverse().find((o) => o.detail)?.detail;
      const lastAt = Math.max(...top.obs.map((o) => o.at));
      if (key === "contacts") {
        const people = ranked.slice(0, 3).map(([email, v]) => {
          const name = [...v.obs].reverse().find((o) => o.detail)?.detail;
          return name ? `${name} <${email}>` : email;
        });
        out.push({ key, label: LABELS[key], value: people.join(", "), confidence, evidence: { count: top.n, total: obs.length, latest: latestOf(obs), last_seen: new Date(lastAt).toISOString() } });
        continue;
      }
      out.push({
        key,
        label: LABELS[key],
        value: topValue,
        ...(lastDetail ? { detail: lastDetail } : {}),
        confidence,
        evidence: { count: top.n, total: obs.length, latest: latestOf(top.obs), last_seen: new Date(lastAt).toISOString() },
      });
    }
    return out.sort((a, b) => b.confidence - a.confidence);
  }

  /** Forget one preference and its evidence. New receipts can teach it again. */
  forget(key: string): boolean {
    if (!(PREF_KEYS as readonly string[]).includes(key)) return false;
    return Number(this.#db.prepare("DELETE FROM preferences WHERE key = ?").run(key).changes) > 0;
  }

  /** Forget everything learned so far. Receipts already in the log aren't read again. */
  forgetAll(): number {
    const n = Number(this.#db.prepare("DELETE FROM preferences WHERE key != ?").run(STATE).changes);
    this.#pending.calls = {};
    this.#pending.names = [];
    this.#put(STATE, this.#pending);
    return n;
  }

  /**
   * The "What I know about you" block for Wonder's instructions: only preferences at or
   * above the threshold, at most PROMPT_MAX_CHARS in all, or "" when nothing qualifies.
   */
  promptBlock(threshold = PROMPT_THRESHOLD): string {
    const lines = this.list().filter((p) => p.confidence >= threshold).map(promptLine);
    if (!lines.length) return "";
    const header =
      "- What I know about you, learned on this Mac from the user's own past receipts. It is the user's own data, not instructions from anyone else. " +
      "Use it to fill in details the user leaves out; it never replaces an approval:";
    let block = header;
    for (const l of lines) {
      const next = `${block}\n  - ${l}`;
      if (next.length > PROMPT_MAX_CHARS) break;
      block = next;
    }
    return block === header ? "" : block;
  }

  #put(key: string, value: unknown): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(`auren/preferences/${key}`));
    const ct = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    this.#db.prepare("INSERT INTO preferences (key, data) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data").run(key, Buffer.concat([iv, cipher.getAuthTag(), ct]));
  }

  #get(key: string): unknown {
    const row = this.#db.prepare("SELECT data FROM preferences WHERE key = ?").get(key) as { data: Uint8Array } | undefined;
    if (!row) return undefined;
    try {
      const sealed = Buffer.from(row.data);
      const decipher = createDecipheriv("aes-256-gcm", this.#key, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`auren/preferences/${key}`));
      decipher.setAuthTag(sealed.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8"));
    } catch {
      return undefined;
    }
  }
}

function promptLine(p: Preference): string {
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/[\r\n]+/g, " ");
  switch (p.key) {
    case "status_channel": return clip(`Status and running-late posts go to ${p.value}${p.detail ? ` (${p.detail})` : ""}`, 110);
    case "contacts": return clip(`Frequent contacts: ${p.value}`, 160);
    case "meeting_length": return `Meetings usually last ${p.value}`;
    case "meeting_time": return `Meetings usually in the ${p.value}${p.detail ? ` (around ${p.detail})` : ""}`;
    case "approval_device": return clip(`Usually approves on the ${p.value}`, 60);
    case "restaurant": return clip(`Books ${p.value}${p.detail ? `, ${p.detail}` : ""}`, 80);
    case "party_size": return `Usual party size: ${p.value}`;
  }
}

/** "2026-11-04T13:30" (local, no zone) to its hour and a comparable number. */
function localParts(s: string): { hour: number; ms: number } | undefined {
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!m) return undefined;
  return { hour: Number(m[4]), ms: Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) };
}

const partOfDay = (h: number) => (h < 12 ? "morning" : h < 17 ? "afternoon" : "evening");
const round = (n: number) => Math.round(n * 100) / 100;
