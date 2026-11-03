// Free labels: real commands through the agent loop, then the event log read back
// as router examples. And the export endpoint answers only on this Mac.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import { runCommand, type MuseLike } from "../agent/loop.ts";
import { EventLog } from "../eventlog.ts";
import type { Manifest } from "../protocol.ts";
import { createServer } from "../server.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { CaptureBroker } from "../vision/capture.ts";
import { CropStore } from "../vision/crops.ts";
import { createGlasses } from "../vision/look.ts";
import { posterJpeg } from "../vision/test-frames.ts";
import { examplesFrom, examplesJsonl } from "./examples.ts";
import { parseRoute } from "./router.ts";

const call = (call_id: string, namespace: string, name: string, args: object) => ({ type: "function_call", call_id, namespace, name, arguments: JSON.stringify(args) });
const watch: Manifest = { id: "watch", kind: "watch", name: "Apple Watch", inputs: ["voice", "text", "touch"], outputs: ["voice", "haptic", "screen"] };
const phone: Manifest = { id: "phone", kind: "phone", name: "iPhone", inputs: ["voice", "text", "touch", "camera"], outputs: ["voice", "screen"] };
const glasses: Manifest = { id: "glasses", kind: "glasses", name: "Ray-Ban Meta", inputs: ["voice", "camera"], outputs: ["voice"] };
type Turn = { output: unknown[]; output_text?: string };

/** One session in the demo world, with the watch (it approves, or not), the phone and the glasses online. */
function world(approve = true) {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry({ onEvent: (kind, data) => log.append("default", kind, data) });
  const broker = new CaptureBroker(surfaces, { timeoutMs: 1_000 });
  const tools = new ToolRegistry().add(...createDemoWorld().namespaces);
  tools.add(createGlasses({ broker, reader: { read: async () => ({ title: "Demo night", date: "2026-11-05", start: "18:00", place: "Room 214" }) }, segmenter: { segment: async () => null }, crops: new CropStore() }));
  surfaces.join(watch, (m) => m.type === "approval_request" && queueMicrotask(() => surfaces.answer(m.request_id, approve, "watch")));
  surfaces.join(phone, () => {});
  surfaces.join(glasses, (m) => m.type === "capture_request" && queueMicrotask(() => broker.deliver(m.request_id, "glasses", posterJpeg())));
  surfaces.heartbeat("watch", true);
  surfaces.heartbeat("phone", false);
  surfaces.heartbeat("glasses", false);
  const run = (text: string, origin: string, turns: Turn[]) => {
    let i = 0;
    const muse: MuseLike = { responses: { create: async () => ({ id: `r${i}`, ...turns[Math.min(i++, turns.length - 1)] }) } };
    return runCommand({ muse, tools, surfaces, log, agentModel: "muse-wonder-1.0" }, { session: "default", text, originSurfaceId: origin });
  };
  return { log, surfaces, run };
}

const say = (text: string): Turn => ({ output: [], output_text: text });
const GP1: Turn[] = [
  { output: [call("c1", "slack", "list_channels", {}), call("c2", "calendar", "list_events", { date: "2026-11-03" }), call("c3", "gmail", "search_threads", { query: "Lee" })] },
  { output: [call("c4", "slack", "post_message", { channel_id: "C01", text: "Running 15 late." }), call("c5", "calendar", "move_event", { event_id: "evt_1", new_start: "2026-11-03T15:15" }), call("c6", "gmail", "create_draft", { thread_id: "thr_9", body: "Grades by 5." })] },
  say("Done."),
];

test("each command becomes an example: the apps it called, the highest tier, where the reply went, and whether it looked", async () => {
  const { log, run } = world();
  await run("I'm running 15 late. Tell office hours, push my 3 PM, and draft a reply to Prof. Lee.", "watch", GP1);
  await run("Add this, and invite Priya.", "glasses", [
    { output: [call("c1", "glasses", "look", { question: "the event on this poster" })] },
    { output: [call("c2", "calendar", "create_event", { title: "Demo night", start: "2026-11-05T18:00" })] },
    { output: [call("c3", "calendar", "invite", { event_id: "evt_101", emails: ["priya@example.com"] })] },
    say("Added, and Priya's invited."),
  ]);
  await run("What's on my calendar?", "phone", [{ output: [call("c1", "calendar", "list_events", { date: "2026-11-03" })] }, say("Two meetings.")]);
  await run("Thanks, that's all.", "watch", [say("Anytime.")]);

  const examples = examplesFrom(log.since("default"));
  assert.deepEqual(
    examples.map((x) => [x.text, x.context.origin, x.label]),
    [
      ["I'm running 15 late. Tell office hours, push my 3 PM, and draft a reply to Prof. Lee.", "watch", { apps: ["slack", "calendar", "gmail"], risk_tier: "send", reply_surface: "watch", needs_vision: false }],
      ["Add this, and invite Priya.", "glasses", { apps: ["glasses", "calendar"], risk_tier: "send", reply_surface: "glasses", needs_vision: true }],
      ["What's on my calendar?", "phone", { apps: ["calendar"], risk_tier: "read", reply_surface: "phone", needs_vision: false }],
      ["Thanks, that's all.", "watch", { apps: [], risk_tier: "read", reply_surface: "watch", needs_vision: false }],
    ],
  );
  // The context is what was online then: kinds, inputs, outputs and the active flag, never ids.
  assert.deepEqual(examples[0].context.devices.map((d) => [d.kind, d.active]), [["watch", true], ["phone", false], ["glasses", false]]);
  assert.ok(!JSON.stringify(examples[0].context).includes('"id"'));
  for (const x of examples) parseRoute(JSON.stringify(x.label));
});

test("a declined send still labels send; an overlapping pair and a failed command are left out", async () => {
  const { log, run } = world(false);
  await run("Tell office hours I'm late.", "watch", [{ output: [call("c1", "slack", "post_message", { channel_id: "C01", text: "Late." })] }, say("Okay, I didn't post it.")]);
  // Two commands at once: the log can't say whose calls were whose.
  await Promise.all([run("Push my 3 PM.", "watch", [say("Pushed.")]), run("Check my email.", "phone", [say("Nothing new.")])]);
  // A command whose model call fails.
  const failing = world();
  let calls = 0;
  const muse: MuseLike = { responses: { create: async () => (calls++ ? Promise.reject(new Error("boom")) : { id: "r", output: [call("c1", "calendar", "list_events", { date: "2026-11-03" })] }) } };
  await runCommand({ muse, tools: new ToolRegistry().add(...createDemoWorld().namespaces), surfaces: failing.surfaces, log, agentModel: "muse-wonder-1.0" }, { session: "default", text: "What's next?", originSurfaceId: "watch" });

  const examples = examplesFrom(log.since("default"));
  assert.deepEqual(examples.map((x) => [x.text, x.label.risk_tier]), [["Tell office hours I'm late.", "send"]]);
});

test("GET /v1/router/examples: JSON lines on this Mac, refused through a tunnel", async () => {
  const { log, surfaces, run } = world();
  await run("What's on my calendar?", "phone", [{ output: [call("c1", "calendar", "list_events", { date: "2026-11-03" })] }, say("Two meetings.")]);
  const core = createServer({ muse: { responses: { create: async () => ({ output: [] }) } }, tools: new ToolRegistry(), surfaces, log, agentModel: "muse-wonder-1.0" }, { token: "", museReady: false });
  const http = serve({ fetch: core.app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise((r) => http.once("listening", r));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/v1/router/examples`;
  try {
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/x-ndjson/);
    const body = await res.text();
    assert.equal(body, examplesJsonl(log, "default"));
    const lines = body.trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(lines.map((l) => [l.text, l.source, l.label.apps]), [["What's on my calendar?", "logged", ["calendar"]]]);
    assert.deepEqual(Object.keys(lines[0]).sort(), ["at", "context", "event_id", "label", "source", "text"]);

    const tunnelled = await fetch(url, { headers: { "x-forwarded-for": "203.0.113.7" } });
    assert.equal(tunnelled.status, 403);
  } finally {
    core.close();
    http.close();
  }
});
