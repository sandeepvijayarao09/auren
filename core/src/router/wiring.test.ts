// The Auren Router in the agent loop: hints only. It preloads namespaces, starts
// the camera early and shapes the ack, and it can't move a tier either way.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, type MuseLike } from "../agent/loop.ts";
import { EventLog } from "../eventlog.ts";
import { OpsLog } from "../obs/opslog.ts";
import type { Manifest, ServerMessage } from "../protocol.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { CaptureBroker } from "../vision/capture.ts";
import { CropStore } from "../vision/crops.ts";
import { createGlasses } from "../vision/look.ts";
import { posterJpeg } from "../vision/test-frames.ts";
import { createRouter, type Route, type RouterLike } from "./router.ts";

const call = (call_id: string, namespace: string, name: string, args: object) => ({ type: "function_call", call_id, namespace, name, arguments: JSON.stringify(args) });
const watch: Manifest = { id: "watch", kind: "watch", name: "Apple Watch", inputs: ["voice", "text", "touch"], outputs: ["voice", "haptic", "screen"] };
const glasses: Manifest = { id: "glasses", kind: "glasses", name: "Ray-Ban Meta", inputs: ["voice", "camera"], outputs: ["voice"] };

/** Wonder follows the script; anything sent to the fast model is recorded and answered "On it." */
function scripted(turns: Array<{ output: unknown[]; output_text?: string }>, opts: { wonderMs?: number } = {}) {
  const requests: Array<Record<string, any> & { at: number }> = [];
  const t0 = performance.now();
  let i = 0;
  const muse: MuseLike = {
    responses: {
      async create(params) {
        requests.push({ ...params, at: performance.now() - t0 });
        if (params.model === "muse-spark-1.3") return { output_text: "On it." };
        if (opts.wonderMs) await new Promise((r) => setTimeout(r, opts.wonderMs));
        const t = turns[Math.min(i, turns.length - 1)];
        return { id: `resp_${i++}`, output: t.output, output_text: t.output_text ?? "" };
      },
    },
  };
  return { muse, requests, wonder: () => requests.filter((r) => r.model === "muse-wonder-1.0") };
}

/** A router that always says `route`, after `ms`. */
const fixed = (route: Route, opts: { ms?: number; holdMs?: number } = {}): RouterLike => ({
  holdMs: opts.holdMs ?? 300,
  route: async () => {
    if (opts.ms) await new Promise((r) => setTimeout(r, opts.ms));
    return { route, source: "glimmer", ms: opts.ms ?? 0 };
  },
});

function setup(turns: Array<{ output: unknown[]; output_text?: string }>, extra: { router?: RouterLike; fastModel?: string; approve?: boolean; wonderMs?: number } = {}) {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry();
  const world = createDemoWorld();
  const tools = new ToolRegistry().add(...world.namespaces);
  const { muse, requests, wonder } = scripted(turns, { wonderMs: extra.wonderMs });
  const inbox: ServerMessage[] = [];
  surfaces.join(watch, (m) => {
    inbox.push(m);
    if (m.type === "approval_request") queueMicrotask(() => surfaces.answer(m.request_id, extra.approve ?? true, "watch"));
  });
  const deps = { muse, tools, surfaces, log, agentModel: "muse-wonder-1.0", fastModel: extra.fastModel, router: extra.router };
  return { deps, log, world, tools, surfaces, requests, wonder, inbox };
}

/** The function names in one namespace of a request's inventory, with whether each is deferred. */
function inventory(req: Record<string, any>): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  for (const t of req.tools as Array<any>) {
    if (t.type === "tool_search") out.tool_search = {};
    if (t.type === "namespace") out[t.name] = Object.fromEntries(t.tools.map((f: any) => [f.name, Boolean(f.defer_loading)]));
  }
  return out;
}

const DONE = [{ output: [], output_text: "Done." }];
const ROUTE: Route = { apps: ["slack", "calendar"], risk_tier: "send", reply_surface: "watch", needs_vision: false };

// ── preload ─────────────────────────────────────────────────────────────────

test("preload: the route's namespaces skip tool_search on the first turn; the rest stay deferred", async () => {
  const before = setup(DONE);
  await runCommand(before.deps, { session: "s", text: "Tell office hours and push my 3 PM.", originSurfaceId: "watch" });
  const base = inventory(before.wonder()[0]);
  assert.equal(base.slack.post_message, true, "without a router, post_message is behind tool_search");

  const { deps, wonder } = setup(DONE, { router: fixed(ROUTE) });
  await runCommand(deps, { session: "s", text: "Tell office hours and push my 3 PM.", originSurfaceId: "watch" });
  const first = inventory(wonder()[0]);
  assert.equal(first.slack.post_message, false);
  assert.equal(first.calendar.move_event, false);
  assert.equal(first.calendar.invite, false);
  assert.equal(first.gmail.create_draft, true, "gmail wasn't named, so it stays deferred");
  assert.ok("tool_search" in first);
  assert.deepEqual(Object.keys(first).sort(), Object.keys(base).sort(), "the router adds no namespace and hides none");

  const all = setup(DONE, { router: fixed({ ...ROUTE, apps: ["slack", "calendar", "gmail"] }) });
  await runCommand(all.deps, { session: "s", text: "GP1", originSurfaceId: "watch" });
  assert.ok(!("tool_search" in inventory(all.wonder()[0])), "nothing left deferred, so no tool_search");
});

test("preload: a route slower than the hold doesn't delay Wonder, and isn't used for the inventory", async () => {
  const { deps, wonder } = setup(DONE, { router: fixed(ROUTE, { ms: 250, holdMs: 20 }) });
  await runCommand(deps, { session: "s", text: "Tell office hours and push my 3 PM.", originSurfaceId: "watch" });
  assert.ok(wonder()[0].at < 150, `Wonder started at ${Math.round(wonder()[0].at)} ms`);
  assert.equal(inventory(wonder()[0]).slack.post_message, true);
});

// ── tiers ───────────────────────────────────────────────────────────────────

test("the router can't change a tier: \"read\" for a Slack post still asks for a tap, and \"send\" for a read doesn't", async () => {
  const post = [{ output: [call("c1", "slack", "post_message", { channel_id: "C01", text: "Running 15 late." })] }, ...DONE];
  const lying = setup(post, { router: fixed({ apps: ["slack"], risk_tier: "read", reply_surface: "watch", needs_vision: false }) });
  await runCommand(lying.deps, { session: "s", text: "Tell office hours I'm running 15 late.", originSurfaceId: "watch" });
  assert.equal(lying.inbox.filter((m) => m.type === "approval_request").length, 1, "the send still asked");
  assert.deepEqual(lying.log.since("s").filter((e) => e.kind === "receipt").map((r) => r.data.tier), ["send"]);
  assert.equal(lying.world.state.posts.length, 1);

  const declined = setup(post, { router: fixed({ apps: ["slack"], risk_tier: "read", reply_surface: "watch", needs_vision: false }), approve: false });
  await runCommand(declined.deps, { session: "s", text: "Tell office hours I'm running 15 late.", originSurfaceId: "watch" });
  assert.equal(declined.world.state.posts.length, 0, "a decline still stops it");

  const read = [{ output: [call("c1", "calendar", "list_events", { date: "2026-11-03" })] }, ...DONE];
  const scary = setup(read, { router: fixed({ apps: ["calendar"], risk_tier: "send", reply_surface: "watch", needs_vision: false }) });
  await runCommand(scary.deps, { session: "s", text: "What's on my calendar?", originSurfaceId: "watch" });
  assert.equal(scary.inbox.filter((m) => m.type === "approval_request").length, 0);
});

// ── the ack ─────────────────────────────────────────────────────────────────

test("the ack: a route with apps shapes it, and Spark isn't asked; an empty route falls back to Spark", async () => {
  const gp1 = "I'm running 15 late. Tell office hours, push my 3 PM, and draft a reply to Prof. Lee.";
  const rules = createRouter({ namespaces: () => ["calendar", "slack", "gmail"] });
  const { deps, log, requests } = setup(DONE, { router: rules, fastModel: "muse-spark-1.3", wonderMs: 30 });
  await runCommand(deps, { session: "s", text: gp1, originSurfaceId: "watch" });
  assert.deepEqual(log.since("s").filter((e) => e.kind === "ack").map((e) => e.data.text), ["On it: Slack, calendar and Gmail."]);
  assert.equal(requests.filter((r) => r.model === "muse-spark-1.3").length, 0);

  const empty = setup(DONE, { router: rules, fastModel: "muse-spark-1.3", wonderMs: 30 });
  await runCommand(empty.deps, { session: "s", text: "Hey, are you there?", originSurfaceId: "watch" });
  assert.deepEqual(empty.log.since("s").filter((e) => e.kind === "ack").map((e) => e.data.text), ["On it."]);
});

// ── the early frame ───────────────────────────────────────────────────────────

/** Glasses that record each capture request; with `frame`, they answer it a moment later, as the iPhone app does. */
function camera(opts: { prefetchTtlMs?: number; frame?: Buffer } = {}) {
  const surfaces = new SurfaceRegistry();
  const broker = new CaptureBroker(surfaces, { timeoutMs: 1_000, prefetchTtlMs: opts.prefetchTtlMs });
  const asked: Array<{ request_id: string; purpose: string }> = [];
  surfaces.join(glasses, (m) => {
    if (m.type !== "capture_request") return;
    asked.push(m);
    if (opts.frame) setTimeout(() => broker.deliver(m.request_id, "glasses", opts.frame!), 5);
  });
  return { surfaces, broker, asked };
}

test("prefetch: look takes the frame already in flight, and no second capture is asked", async () => {
  const { broker, asked } = camera();
  assert.equal(broker.prefetch("Add this"), true);
  assert.equal(broker.prefetch("Add this"), true, "one early frame at a time");
  assert.equal(asked.length, 1);
  const frame = posterJpeg();
  assert.equal(broker.deliver(asked[0].request_id, "glasses", frame), "accepted");
  const got = await broker.request("the event on this poster");
  assert.equal(got.jpeg, frame);
  assert.equal(asked.length, 1, "request() used the early frame");
  // Used once: the next look asks again.
  void broker.request("again").catch(() => {});
  assert.equal(asked.length, 2);
});

test("prefetch: an early frame expires after its TTL; a late frame is refused and look asks afresh", async () => {
  const { broker, asked } = camera({ prefetchTtlMs: 30 });
  broker.prefetch("Add this");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(broker.target(asked[0].request_id), undefined, "nothing waits on the expired capture");
  assert.equal(broker.deliver(asked[0].request_id, "glasses", posterJpeg()), "unknown");
  const fresh = broker.request("look");
  assert.equal(asked.length, 2);
  broker.deliver(asked[1].request_id, "glasses", posterJpeg());
  assert.equal((await fresh).requestId, asked[1].request_id);
});

test("prefetch: never without a camera, and never on top of a capture look already asked for", () => {
  const blind = new CaptureBroker(new SurfaceRegistry());
  assert.equal(blind.prefetch("Add this"), false);
  const { broker, asked } = camera();
  void broker.request("look").catch(() => {});
  assert.equal(broker.prefetch("Add this"), false);
  assert.equal(asked.length, 1);
});

test("GP2 through the loop: the rules see \"this\" with the glasses on, the capture starts before Wonder's first turn, and look uses it", async () => {
  const log = new EventLog();
  const { surfaces, broker, asked } = camera({ frame: posterJpeg(96, 64) });
  const lines: Array<Record<string, any>> = [];
  const ops = new OpsLog({ write: (l) => lines.push(JSON.parse(l)) });
  const world = createDemoWorld();
  const tools = new ToolRegistry().add(...world.namespaces);
  const fields = { title: "Demo night", date: "2026-11-05", start: "18:00", place: "Room 214" };
  tools.add(createGlasses({ broker, reader: { read: async () => fields }, segmenter: { segment: async () => null }, crops: new CropStore() }));
  let firstTurnAsked = -1;
  const turns = [
    { output: [call("c1", "glasses", "look", { question: "the event on this poster" })] },
    { output: [call("c2", "calendar", "create_event", { title: "Demo night", start: "2026-11-05T18:00", location: "Room 214" })] },
    { output: [], output_text: "Added Demo night." },
  ];
  let i = 0;
  const muse: MuseLike = {
    responses: {
      async create() {
        if (i === 0) firstTurnAsked = asked.length;
        const t = turns[Math.min(i++, turns.length - 1)];
        return { id: `r${i}`, output: t.output, output_text: t.output_text ?? "" };
      },
    },
  };
  const router = createRouter({ namespaces: () => tools.names(), ops });
  const deps = { muse, tools, surfaces, log, agentModel: "muse-wonder-1.0", router, ops, prefetchFrame: (p: string) => void broker.prefetch(p) };

  const { reply } = await runCommand(deps, { session: "s", text: "Add this to my calendar.", originSurfaceId: "glasses" });
  assert.equal(reply, "Added Demo night.");
  assert.equal(firstTurnAsked, 1, "the capture went out before Wonder's first turn");
  assert.deepEqual(asked.map((a) => a.purpose), ["Add this to my calendar."], "one frame for the whole command");
  assert.deepEqual(lines.filter((l) => l.event === "router.prefetch").map((l) => l.source), ["rules"]);
  assert.deepEqual(log.since("s").filter((e) => e.kind === "receipt").map((r) => r.data.tool), ["create_event"]);
});

test("no early frame for a command that doesn't point at anything, even with the glasses on", async () => {
  const log = new EventLog();
  const { surfaces, broker, asked } = camera();
  const tools = new ToolRegistry().add(...createDemoWorld().namespaces);
  const deps = { muse: scripted(DONE).muse, tools, surfaces, log, agentModel: "muse-wonder-1.0", router: createRouter({ namespaces: () => tools.names() }), prefetchFrame: (p: string) => void broker.prefetch(p) };
  await runCommand(deps, { session: "s", text: "What did I tell office hours this morning?", originSurfaceId: "glasses" });
  assert.equal(asked.length, 0);
});
