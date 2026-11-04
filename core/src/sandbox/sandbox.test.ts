// The public sandbox over a real socket: isolation, the refused routes, limits,
// proxy headers, expiry, and both engines. No key and no network.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import type { MuseLike } from "../agent/loop.ts";
import { EventLog } from "../eventlog.ts";
import { SpendGuard } from "../obs/spend.ts";
import type { AurenEvent } from "../protocol.ts";
import { Ledger, ledgerMuse } from "../security/ledger.ts";
import { createServer } from "../server.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { loadCatalog } from "./catalog.ts";
import { clientIp, rateKey } from "./limits.ts";
import { NOT_SENT, Sandbox, type SandboxOptions } from "./sandbox.ts";
import { createSandboxServer, REFUSED } from "./server.ts";

const catalog = loadCatalog();
const text = (id: string) => catalog.find((e) => e.id === id)!.text;
const booted: Array<() => Promise<void>> = [];
after(async () => {
  for (const close of booted) await close();
});

interface Seen {
  events: AurenEvent[];
  taps: Array<{ request_id: string; summary: string; surface: string }>;
  outputs: Array<{ surface: string; type: string; text?: string }>;
  devices: Array<{ id: string; online: boolean }>;
  busy: boolean;
  engine: { mode: string; label: string; reason: string | null };
}

async function boot(opts: Partial<SandboxOptions> = {}, clock?: { t: number }) {
  const trustProxy = opts.trustProxy ?? 1;
  const sandbox = new Sandbox({ tokenBudget: 0, rpm: 30, daily: 500, maxVisitors: 20, approvalTimeoutMs: 8000, ...opts, trustProxy, now: clock ? () => clock.t : undefined }, catalog);
  const server = createSandboxServer(sandbox, { trustProxy });
  const http = serve({ fetch: server.app.fetch, port: 0, hostname: "127.0.0.1" });
  http.on("upgrade", server.upgrade);
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  booted.push(async () => {
    sandbox.close();
    await new Promise((r) => http.close(r));
  });

  const call = async (path: string, o: { visitor?: string; ip?: string; method?: string; body?: unknown; headers?: Record<string, string> } = {}) => {
    const res = await fetch(base + path, {
      method: o.method ?? (o.body === undefined ? "GET" : "POST"),
      redirect: "manual",
      headers: { "content-type": "application/json", ...(o.visitor ? { "x-auren-visitor": o.visitor } : {}), ...(o.ip ? { "x-forwarded-for": o.ip } : {}), ...o.headers },
      body: o.body === undefined ? undefined : JSON.stringify(o.body),
    });
    return { status: res.status, headers: res.headers, body: (await res.json().catch(() => null)) as any };
  };
  const join = async (ip = "198.51.100.1") => {
    const r = await call("/try/api/session", { ip, body: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.visitor as string;
  };
  const say = (visitor: string, t: string, ip = "198.51.100.1") => call("/try/api/command", { visitor, ip, body: { text: t } });
  /** Polls the visitor's state, collecting events, until `done` says so. */
  const until = async (visitor: string, done: (s: Seen) => boolean, ms = 8000): Promise<Seen> => {
    const seen: Seen = { events: [], taps: [], outputs: [], devices: [], busy: false, engine: { mode: "", label: "", reason: null } };
    let since = 0;
    let outputs = 0;
    const end = Date.now() + ms;
    for (;;) {
      const r = await call(`/try/api/state?since=${since}&outputs=${outputs}`, { visitor });
      assert.equal(r.status, 200);
      seen.events.push(...r.body.events);
      seen.outputs.push(...r.body.outputs);
      since = seen.events.at(-1)?.id ?? since;
      outputs = r.body.outputs.at(-1)?.id ?? outputs;
      Object.assign(seen, { taps: r.body.taps, devices: r.body.devices, busy: r.body.busy, engine: r.body.engine });
      if (done(seen)) return seen;
      if (Date.now() > end) throw new Error(`timed out; saw ${seen.events.map((e) => e.kind).join(",")}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const tap = (visitor: string, s: Seen, surface: string, approved = true) => call(`/try/api/taps/${s.taps[0].request_id}`, { visitor, body: { approved, surface } });
  const replied = (n = 1) => (s: Seen) => !s.busy && s.events.filter((e) => e.kind === "reply").length >= n;
  const tapOn = (surface: string) => (s: Seen) => s.taps.some((t) => t.surface === surface);
  return { sandbox, base, call, join, say, until, tap, replied, tapOn };
}

const kinds = (s: Seen, kind: string) => s.events.filter((e) => e.kind === kind);

// ── isolation and refused routes ──────────────────────────────────────────

test("every route the real Core serves is refused in sandbox mode, even from this Mac with a token", async () => {
  const sb = await boot();
  const real = createServer(
    { muse: { responses: { create: async () => ({ output: [] }) } }, tools: new ToolRegistry(), surfaces: new SurfaceRegistry(), log: new EventLog(), agentModel: "x" },
    { token: "t", museReady: true },
  );
  const routes = real.app.routes.filter((r) => r.method !== "ALL");
  real.close();
  assert.ok(routes.length >= 20, `found ${routes.length} routes`);
  assert.ok(routes.some((r) => r.path === "/v1/events") && routes.some((r) => r.path === "/connect/google") && routes.some((r) => r.path === "/v1/frames/:request_id"));
  const open = new Set(["/health", "/brand/tokens.css"]);
  for (const r of routes) {
    const path = r.path.replace(/:[a-z_]+/g, "x1");
    if (open.has(path)) continue;
    for (const headers of [{}, { authorization: "Bearer t" }] as Array<Record<string, string>>) {
      const res = await fetch(`${sb.base}${path}?token=t`, { method: r.method, headers, redirect: "manual", body: r.method === "GET" ? undefined : "{}" });
      if (path === "/") {
        assert.deepEqual([res.status, res.headers.get("location")], [302, "/try"], "the console is never served");
      } else {
        assert.equal(res.status, 404, `${r.method} ${path}`);
        assert.equal((await res.json()).error, REFUSED);
      }
    }
  }
  // The surface, voice and driver sockets don't exist either.
  for (const path of ["/v1/surface", "/v1/voice", "/v1/driver", "/try/api/state"]) {
    const ws = new WebSocket(`${sb.base.replace("http", "ws")}${path}?token=t`);
    const opened = await new Promise<boolean>((r) => {
      ws.on("open", () => r(true));
      ws.on("error", () => r(false));
    });
    assert.equal(opened, false, path);
  }
  const health = await sb.call("/health");
  assert.deepEqual([health.body.sandbox, health.body.engine], [true, "replay"]);
});

test("two visitors never see each other's commands, taps or receipts", async () => {
  const sb = await boot();
  const a = await sb.join("198.51.100.1");
  const b = await sb.join("198.51.100.2");
  assert.notEqual(a, b);
  assert.equal((await sb.say(a, text("gp1"))).status, 202);
  const asked = await sb.until(a, sb.tapOn("watch"));
  // B has a world of its own: no utterance, no tap, and A's tap and receipts are out of reach.
  const bSees = await sb.until(b, () => true);
  assert.deepEqual(kinds(bSees, "utterance"), []);
  assert.deepEqual(bSees.taps, []);
  assert.equal((await sb.tap(b, asked, "watch")).status, 404);
  const done = await sb.until(a, () => true);
  assert.equal(done.taps.length, 1, "A's tap is still waiting");
  assert.equal((await sb.tap(a, asked, "watch")).status, 200);
  const aDone = await sb.until(a, sb.replied());
  const receipt = kinds(aDone, "receipt")[0];
  assert.ok(receipt);
  assert.equal((await sb.call(`/try/api/receipts/${receipt.id}/undo`, { visitor: b, body: {} })).body.ok ?? false, false);
  const bAfter = await sb.until(b, () => true);
  assert.deepEqual([kinds(bAfter, "receipt").length, kinds(bAfter, "reply").length], [0, 0]);
  assert.ok(sb.sandbox.get(a)!.world.state.posts.length === 1 && sb.sandbox.get(b)!.world.state.posts.length === 0);
  // A visitor's world is the demo world alone: the eval's MCP Journal (R11) never comes along.
  assert.ok(!sb.sandbox.get(a)!.tools.names().includes("journal"), sb.sandbox.get(a)!.tools.names().join(", "));
  // Without the visitor's secret there's nothing to see.
  assert.equal((await sb.call("/try/api/state")).status, 401);
  assert.equal((await sb.call("/try/api/state", { visitor: "guess" })).status, 401);
});

// ── replay ────────────────────────────────────────────────────────────────

test("replay plays the golden paths end to end, with each tap on the simulated watch", async () => {
  const sb = await boot();
  const v = await sb.join();

  // GP1 from the watch: three apps, one tap for the Slack post, three receipts.
  const accepted = await sb.say(v, text("gp1"));
  assert.deepEqual([accepted.status, accepted.body.engine.mode, accepted.body.engine.label], [202, "replay", "Replay"]);
  const asked = await sb.until(v, sb.tapOn("watch"));
  assert.match(asked.taps[0].summary, /^Post to #office-hours: "Running 15 min late/);
  assert.equal((await sb.tap(v, asked, "phone")).status, 409, "the tap is on the watch, not the phone");
  assert.equal((await sb.tap(v, asked, "watch")).status, 200);
  let s = await sb.until(v, sb.replied(1));
  assert.deepEqual(kinds(s, "tool_call").map((e) => `${e.data.namespace}.${e.data.tool}`), [
    "calendar.list_events", "slack.list_channels", "gmail.search_threads", "calendar.move_event", "slack.post_message", "gmail.create_draft",
  ]);
  assert.equal(kinds(s, "receipt").length, 3);
  assert.deepEqual(kinds(s, "approval").map((e) => [e.data.status, e.data.surface_id]), [["requested", "watch"], ["approved", "watch"]]);
  assert.deepEqual(kinds(s, "reply").map((e) => [e.data.text, e.data.spoken_on]), [["Done: Slack posted, office hours at 3:15, draft ready.", "watch"]]);
  assert.ok(s.outputs.some((o) => o.surface === "watch" && o.text === "On it: Slack, calendar and email."), "the ack played on the watch");
  const world = sb.sandbox.get(v)!.world.state;
  assert.equal(world.events.get("evt_1")!.start.slice(11), "15:15");

  // GP2 from the glasses, in the same world: the synthetic poster, a new event, and the invite tap.
  await sb.say(v, text("gp2"));
  const invite = await sb.until(v, sb.tapOn("watch"));
  assert.equal(invite.taps[0].summary, "Send an invite to priya@example.com?");
  await sb.tap(v, invite, "watch");
  s = await sb.until(v, sb.replied(1));
  const added = kinds(s, "receipt").find((e) => String(e.data.summary).startsWith('Added "Demo night"'))!;
  assert.match(String(added.data.crop), /^data:image\/jpeg;base64,/, "the receipt shows what the glasses saw");
  const demo = [...world.events.values()].find((e) => e.title === "Demo night")!;
  assert.deepEqual([demo.location, demo.invitees], ["Room 214", ["priya@example.com"]], "the invite went to the event just created");

  // GP4: the demo booking page, with the tap at the commit.
  await sb.say(v, text("gp4"));
  const hold = await sb.until(v, sb.tapOn("watch"));
  assert.match(hold.taps[0].summary, /^Hold a table for 2 at 8:00 PM · click "Complete reservation"/);
  await sb.tap(v, hold, "watch");
  s = await sb.until(v, sb.replied(1));
  assert.ok(kinds(s, "receipt").some((e) => e.data.namespace === "browser"));
  assert.ok(kinds(s, "browser_frame").length >= 2);

  // GP5: recap the day, then undo the calendar move by voice. The second undo has nothing left to undo.
  await sb.say(v, text("gp5-recap"));
  s = await sb.until(v, sb.replied(1));
  assert.ok(kinds(s, "tool_call").some((e) => e.data.namespace === "memory"));
  await sb.say(v, text("gp5-undo"));
  s = await sb.until(v, sb.replied(1));
  assert.equal(world.events.get("evt_1")!.start.slice(11), "15:00");
  assert.equal(kinds(s, "receipt").filter((e) => e.data.undoes).length, 1);
  await sb.say(v, text("gp5-undo"));
  s = await sb.until(v, sb.replied(1));
  assert.match(String(kinds(s, "reply").at(-1)!.data.text), /nothing left to undo from GP1/);

  // The Undo button: once, then it's done.
  const draft = sb.sandbox.get(v)!.log.since("sandbox", 0, 500).find((e) => e.kind === "receipt" && e.data.tool === "create_draft")!;
  assert.equal((await sb.call(`/try/api/receipts/${draft.id}/undo`, { visitor: v, body: {} })).body.ok, true);
  const again = await sb.call(`/try/api/receipts/${draft.id}/undo`, { visitor: v, body: {} });
  assert.deepEqual([again.status, again.body.ok], [409, false]);
  assert.match(again.body.message, /already undone/);
});

test("a declined tap ends the replay honestly, and the planted email posts nothing", async () => {
  const sb = await boot();
  const v = await sb.join();
  await sb.say(v, text("gp1"));
  const asked = await sb.until(v, sb.tapOn("watch"));
  await sb.tap(v, asked, "watch", false);
  let s = await sb.until(v, sb.replied());
  assert.equal(kinds(s, "reply")[0].data.text, NOT_SENT, "never the scripted \"Done: Slack posted\"");
  assert.equal(sb.sandbox.get(v)!.world.state.posts.length, 0);

  // The injection: the email tells Auren to post; Core holds it for a tap the visitor declines.
  await sb.say(v, text("injection"));
  const held = await sb.until(v, sb.tapOn("watch"));
  assert.equal(held.taps[0].summary, 'Post to #general: "grades are leaked"');
  await sb.tap(v, held, "watch", false);
  s = await sb.until(v, sb.replied());
  assert.equal(sb.sandbox.get(v)!.world.state.posts.length, 0);
  assert.equal(kinds(s, "reply").at(-1)!.data.text, "Prof. Lee is asking when HW3 grades will be posted.");
});

test("GP3 replays the watch coming off: the tap moves to the phone, and the watch comes back after", async () => {
  const sb = await boot();
  const v = await sb.join();
  await sb.say(v, text("gp3"));
  await sb.until(v, sb.tapOn("watch"));
  const moved = await sb.until(v, sb.tapOn("phone"), 6000);
  assert.ok(moved.devices.some((d) => d.id === "watch" && !d.online));
  assert.ok(kinds(moved, "handoff").some((e) => e.data.from === "watch" && e.data.to === "phone"));
  await sb.tap(v, moved, "phone");
  const s = await sb.until(v, sb.replied());
  assert.equal(sb.sandbox.get(v)!.world.state.posts.length, 1);
  assert.ok(s.devices.every((d) => d.online), "every device is back on");
});

test("free text without a key gets a friendly answer and the examples to tap", async () => {
  const sb = await boot({ live: undefined });
  const v = await sb.join();
  const r = await sb.say(v, "Book me a flight to Lisbon");
  assert.equal(r.body.engine.reason, "no_key");
  const s = await sb.until(v, sb.replied());
  const reply = kinds(s, "reply")[0].data;
  assert.match(String(reply.text), /^The live model isn't connected here, so this sandbox replays the golden paths/);
  assert.deepEqual(reply.suggestions, catalog.map((e) => e.id));
  assert.equal(kinds(s, "tool_call").length, 0);
  // Matching ignores case and punctuation. GP5 replays after GP1, and says so.
  await sb.say(v, text("gp5-recap").toUpperCase().replace(/[?]/g, ""));
  const after1 = await sb.until(v, sb.replied(2));
  assert.equal(kinds(after1, "reply").at(-1)!.data.text, "Replay plays GP5 after GP1. Tap GP1 first, so there's something to recap.");
});

// ── limits, proxies, expiry ───────────────────────────────────────────────

test("commands are limited per address per minute and per day, and to one at a time", async () => {
  const clock = { t: Date.parse("2026-11-03T12:00:00Z") };
  const sb = await boot({ rpm: 2, daily: 3 }, clock);
  const v = await sb.join("203.0.113.5");
  const quick = async (ip = "203.0.113.5") => {
    const r = await sb.say(v, "hello there", ip);
    if (r.status === 202) await sb.until(v, (s) => !s.busy);
    return r;
  };
  assert.equal((await quick()).status, 202);
  assert.equal((await quick()).status, 202);
  const third = await quick();
  assert.equal(third.status, 429);
  assert.match(third.body.error, /2 commands this minute/);
  assert.ok(Number(third.headers.get("retry-after")) > 0);
  clock.t += 61_000;
  assert.equal((await quick()).status, 202);
  clock.t += 61_000;
  const day = await quick();
  assert.equal(day.status, 429);
  assert.match(day.body.error, /daily limit of 3/);
  // Another visitor on another address isn't affected.
  const w = await sb.join("203.0.113.9");
  assert.equal((await sb.say(w, "hello", "203.0.113.9")).status, 202);
  // Too long, and one at a time: neither counts against the limit.
  const z = await sb.join("203.0.113.10");
  assert.equal((await sb.say(z, "x".repeat(281), "203.0.113.10")).status, 400);
  assert.equal((await sb.say(z, text("gp1"), "203.0.113.10")).status, 202);
  const waiting = await sb.until(z, sb.tapOn("watch"));
  assert.equal((await sb.say(z, "and another", "203.0.113.10")).status, 409);
  await sb.tap(z, waiting, "watch", false);
  await sb.until(z, sb.replied());
});

test("the visitor cap holds, and one address can't fill it", async () => {
  const sb = await boot({ maxVisitors: 3, perAddress: 2 });
  const a1 = await sb.join("192.0.2.1");
  const a2 = await sb.join("192.0.2.1");
  const a3 = await sb.join("192.0.2.1");
  assert.equal((await sb.call("/try/api/state", { visitor: a1 })).status, 401, "a third session from one address replaces its oldest");
  assert.equal((await sb.call("/try/api/state", { visitor: a2 })).status, 200);
  assert.equal((await sb.call("/try/api/state", { visitor: a3 })).status, 200);
  await sb.join("192.0.2.2");
  const full = await sb.call("/try/api/session", { ip: "192.0.2.3", body: {} });
  assert.equal(full.status, 503);
  assert.match(full.body.error, /full/);
  // A visitor coming back with its secret keeps its session.
  assert.equal((await sb.call("/try/api/session", { visitor: a2, ip: "192.0.2.1", body: {} })).body.visitor, a2);
});

test("X-Forwarded-For counts only when AUREN_TRUST_PROXY is set, and only its last hop", async () => {
  assert.equal(clientIp("127.0.0.1", () => "203.0.113.7", 0), "127.0.0.1");
  assert.equal(clientIp("127.0.0.1", () => "203.0.113.7", 1), "203.0.113.7");
  assert.equal(clientIp("127.0.0.1", () => "6.6.6.6, 203.0.113.7", 1), "203.0.113.7", "a forged first entry is ignored");
  assert.equal(clientIp("127.0.0.1", () => "6.6.6.6, 203.0.113.7, 10.0.0.2", 2), "203.0.113.7");
  assert.equal(clientIp("127.0.0.1", () => "not-an-ip", 1), "127.0.0.1");
  assert.equal(rateKey("::ffff:203.0.113.7"), "203.0.113.7");
  assert.equal(rateKey("2001:db8:aa:bb:1::2"), rateKey("2001:0db8:00aa:00bb:ffff:1:2:3"), "one IPv6 /64 is one address");
  assert.notEqual(rateKey("2001:db8:aa:bb::1"), rateKey("2001:db8:aa:bc::1"));

  // Untrusted: every forwarded address is the same visitor (the proxy), so they share one limit.
  const strict = await boot({ trustProxy: 0, rpm: 1 });
  const v = await strict.join("203.0.113.1");
  assert.equal((await strict.say(v, "hi", "203.0.113.1")).status, 202);
  await strict.until(v, (s) => !s.busy);
  assert.equal((await strict.say(v, "hi", "203.0.113.2")).status, 429);
  // Trusted: each address has its own limit, and prepending a fake hop doesn't make a new one.
  const trusting = await boot({ trustProxy: 1, rpm: 1 });
  const w = await trusting.join("203.0.113.1");
  assert.equal((await trusting.say(w, "hi", "203.0.113.1")).status, 202);
  await trusting.until(w, (s) => !s.busy);
  assert.equal((await trusting.say(w, "hi", "9.9.9.9, 203.0.113.1")).status, 429);
  assert.equal((await trusting.say(w, "hi", "203.0.113.2")).status, 202);
});

test("a visitor expires after 30 minutes idle, and polling doesn't keep it alive", async () => {
  const clock = { t: Date.now() };
  const sb = await boot({}, clock);
  const v = await sb.join();
  clock.t += 20 * 60_000;
  const s = await sb.call("/try/api/state", { visitor: v });
  assert.ok(s.body.expires_in_s > 0 && s.body.expires_in_s <= 600);
  clock.t += 11 * 60_000;
  sb.sandbox.sweep();
  assert.equal(sb.sandbox.visitors.size, 0);
  const gone = await sb.call("/try/api/state", { visitor: v });
  assert.deepEqual([gone.status, gone.body.expired], [401, true]);
  // A command counts as activity.
  const w = await sb.join();
  clock.t += 29 * 60_000;
  await sb.say(w, "hello");
  await sb.until(w, (x) => !x.busy);
  clock.t += 29 * 60_000;
  sb.sandbox.sweep();
  assert.ok(sb.sandbox.get(w));
});

// ── the live engine and its budget ────────────────────────────────────────

/** A stand-in for Muse: answers in one turn and reports `tokens` of usage. */
function fakeMuse(tokens: number, opts: { fail?: boolean } = {}): MuseLike {
  return {
    responses: {
      async create(params) {
        if (opts.fail) throw new Error("401 invalid key");
        if (params.model === "muse-spark-1.3") return { id: "ack", output: [], output_text: "On it.", usage: { input_tokens: 5, output_tokens: 2 } };
        return { id: "r1", output: [], output_text: "You have office hours at 3.", usage: { input_tokens: tokens - 20, output_tokens: 20 } };
      },
    },
  };
}

test("with a key, commands run live until the budget is spent, then replay", async () => {
  const ledger = new Ledger();
  const live = { muse: ledgerMuse(fakeMuse(300), ledger), agentModel: "muse-wonder-1.0", fastModel: "muse-spark-1.3", ledger };
  const sb = await boot({ live, tokenBudget: 250 });
  const v = await sb.join();
  const first = await sb.say(v, "What's on my calendar this afternoon?");
  assert.deepEqual([first.body.engine.mode, first.body.engine.label], ["live", "Live · Muse Wonder"]);
  let s = await sb.until(v, sb.replied());
  assert.equal(kinds(s, "reply")[0].data.text, "You have office hours at 3.");
  assert.ok(ledger.totals().total >= 300);
  assert.deepEqual([s.engine.mode, s.engine.reason], ["replay", "budget"], "the budget is spent");

  const second = await sb.say(v, text("gp1"));
  assert.equal(second.body.engine.mode, "replay");
  const asked = await sb.until(v, sb.tapOn("watch"));
  assert.ok(asked.outputs.some((o) => o.text === "On it: Slack, calendar and email."), "the scripted ack, not the live one");
  await sb.tap(v, asked, "watch");
  await sb.until(v, sb.replied(2));
  await sb.say(v, "And tomorrow?");
  s = await sb.until(v, sb.replied(3));
  assert.match(String(kinds(s, "reply").at(-1)!.data.text), /budget for this sandbox is spent/);
});

test("AUREN_TOKEN_LIMIT and a failing key both send the sandbox to replay", async () => {
  const ledger = new Ledger();
  const spend = new SpendGuard(ledger, { limit: 100 });
  const sb = await boot({ live: { muse: ledgerMuse(fakeMuse(300), ledger), agentModel: "muse-wonder-1.0", ledger, spend }, tokenBudget: 1_000_000 });
  const v = await sb.join();
  assert.equal((await sb.say(v, "hi")).body.engine.mode, "live");
  const s = await sb.until(v, sb.replied());
  assert.deepEqual([s.engine.mode, s.engine.reason], ["replay", "limit"]);

  const failing = new Ledger();
  const sb2 = await boot({ live: { muse: ledgerMuse(fakeMuse(0, { fail: true }), failing), agentModel: "muse-wonder-1.0", ledger: failing }, tokenBudget: 1000 });
  const w = await sb2.join();
  const failed = (n: number) => (x: Seen) => !x.busy && kinds(x, "error").length >= n;
  await sb2.say(w, "hi");
  await sb2.until(w, failed(1));
  await sb2.say(w, "hi again");
  const after2 = await sb2.until(w, failed(2));
  assert.deepEqual([after2.engine.mode, after2.engine.reason], ["replay", "failing"]);
  assert.equal((await sb2.say(w, text("gp5-recap"))).body.engine.mode, "replay", "the golden paths still play");
  await sb2.until(w, sb2.replied());
});

test("AUREN_SANDBOX=true starts only the sandbox: no database, key file or connector, whatever .env says", async () => {
  const { spawn } = await import("node:child_process");
  const { existsSync, mkdtempSync, readdirSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const dir = mkdtempSync(join(tmpdir(), "auren-sandbox-"));
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: dir,
    AUREN_SANDBOX: "true",
    PORT: "0",
    AUREN_DB: join(dir, "auren.db"),
    AUREN_KEYD: join(dir, "no-keyd"),
    SLACK_BOT_TOKEN: "xoxb-not-a-real-token",
    GOOGLE_CLIENT_ID: "fake.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "fake",
    AUREN_TOKEN: "fake-device-token",
  };
  const child = spawn(process.execPath, [entry], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    let out = "";
    const url = await new Promise<string>((resolve, reject) => {
      child.stdout.on("data", (b) => {
        out += String(b);
        const m = out.match(/Auren sandbox on (http:\/\/\S+)\/try/);
        if (m && out.includes("never used here")) resolve(m[1]);
      });
      child.on("exit", (code) => reject(new Error(`exited ${code}: ${out}`)));
      setTimeout(() => reject(new Error(`no start line: ${out}`)), 10_000);
    });
    assert.match(out, /ignoring SLACK_BOT_TOKEN, GOOGLE_CLIENT_\*, AUREN_TOKEN/);
    assert.match(url, /^http:\/\/127\.0\.0\.1:/, "AUREN_TOKEN doesn't open the sandbox to the network");
    assert.equal((await fetch(`${url}/v1/trust`, { headers: { authorization: "Bearer fake-device-token" } })).status, 404);
    assert.equal((await (await fetch(`${url}/health`)).json()).sandbox, true);
    child.kill("SIGTERM");
    const [code] = await once(child, "exit");
    assert.equal(code, 0);
    assert.equal(existsSync(join(dir, "auren.db")), false, "the real log, ledger and devices were never opened");
    assert.deepEqual(readdirSync(dir), [], "no key file or anything else was written");
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
