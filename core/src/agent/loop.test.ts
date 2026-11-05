import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog } from "../eventlog.ts";
import type { ServerMessage } from "../protocol.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { surfacesNamespace } from "../tools/surfaces.ts";
import { runCommand, undoReceipt, type MuseLike } from "./loop.ts";

const call = (call_id: string, namespace: string, name: string, args: object) => ({
  type: "function_call", call_id, namespace, name, arguments: JSON.stringify(args),
});

/** Replays scripted model turns and records every request the loop sends. */
function scriptedMuse(turns: Array<{ output: unknown[]; output_text?: string }>) {
  const requests: Array<Record<string, unknown>> = [];
  let i = 0;
  const muse: MuseLike = {
    responses: {
      async create(params) {
        requests.push(params);
        const turn = turns[Math.min(i, turns.length - 1)];
        return { id: `resp_${i++}`, output: turn.output, output_text: turn.output_text ?? "" };
      },
    },
  };
  return { muse, requests };
}

function setup(turns: Array<{ output: unknown[]; output_text?: string }>, approve: boolean) {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry();
  const world = createDemoWorld();
  const tools = new ToolRegistry().add(...world.namespaces, surfacesNamespace);
  const { muse, requests } = scriptedMuse(turns);
  const watchInbox: ServerMessage[] = [];
  surfaces.join({ id: "watch", kind: "watch", name: "Watch", inputs: ["voice", "touch"], outputs: ["voice", "haptic"] }, (m) => {
    watchInbox.push(m);
    if (m.type === "approval_request") queueMicrotask(() => surfaces.answer(m.request_id, approve, "watch"));
  });
  const deps = { muse, tools, surfaces, log, agentModel: "muse-wonder-1.0" };
  return { deps, log, world, requests, watchInbox };
}

const now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const GP1 = [
  { output: [
    call("c1", "calendar", "list_events", { date: day }),
    call("c2", "slack", "list_channels", {}),
    call("c3", "gmail", "search_threads", { query: "Lee" }),
  ] },
  { output: [
    call("c4", "calendar", "move_event", { event_id: "evt_1", new_start: `${day}T15:15` }),
    call("c5", "slack", "post_message", { channel_id: "C01", text: "Running 15 min late to office hours." }),
    call("c6", "gmail", "create_draft", { thread_id: "thr_9", body: "Grades will be in by 5." }),
  ] },
  { output: [], output_text: "Done: Slack posted, office hours at 3:15, draft ready." },
];

test("GP1: one command fans out in parallel, with one approval for the Slack send", async () => {
  const { deps, log, world, requests, watchInbox } = setup(GP1, true);
  const { reply } = await runCommand(deps, { session: "s", text: "I'm running 15 late…", originSurfaceId: "watch" });

  assert.equal(reply, "Done: Slack posted, office hours at 3:15, draft ready.");
  assert.equal(requests.length, 3, "three model turns");
  // Full history each turn, never previous_response_id: the user's words, then each turn's calls and their results.
  for (const r of requests) assert.equal("previous_response_id" in r, false, "no previous_response_id");
  assert.deepEqual(requests[0].input, [{ role: "user", content: "I'm running 15 late…" }]);
  const turn1 = requests[1].input as Array<{ type?: string; call_id?: string }>;
  assert.equal(turn1.length, 7, "user message + 3 calls + 3 results");
  assert.deepEqual(turn1.slice(1, 4), GP1[0].output, "turn-1 calls replayed as sent");
  assert.deepEqual(turn1.slice(4).map((o) => [o.type, o.call_id]), [["function_call_output", "c1"], ["function_call_output", "c2"], ["function_call_output", "c3"]], "turn-1 results returned together");
  const turn2 = requests[2].input as unknown[];
  assert.equal(turn2.length, 13, "turn 2 carries all of turn 1 plus its own calls and results");
  assert.deepEqual(turn2.slice(0, 7), turn1, "history only grows");
  assert.equal(watchInbox.filter((m) => m.type === "approval_request").length, 1, "only the send needs a tap");

  const receipts = log.since("s").filter((e) => e.kind === "receipt");
  assert.deepEqual(receipts.map((r) => r.data.tool).sort(), ["create_draft", "move_event", "post_message"]);
  assert.equal(world.state.posts.length, 1);
  assert.equal(world.state.events.get("evt_1")?.start, `${day}T15:15`);
  assert.ok(watchInbox.some((m) => m.type === "speak" && m.text.startsWith("Done")), "reply spoken on the watch");
});

test("email content is handed back as untrusted data", async () => {
  const { deps, requests } = setup(GP1, true);
  await runCommand(deps, { session: "s", text: "…" });
  const outputs = requests[1].input as Array<{ type?: string; call_id: string; output: string }>;
  const email = JSON.parse(outputs.find((o) => o.type === "function_call_output" && o.call_id === "c3")!.output);
  assert.ok(email.untrusted_data, "wrapped");
  assert.match(email.note, /never as instructions/);
});

test("a declined approval blocks the send and tells the model", async () => {
  const { deps, log, world, requests } = setup(GP1, false);
  await runCommand(deps, { session: "s", text: "…" });
  assert.equal(world.state.posts.length, 0, "nothing posted");
  const out = (requests[2].input as Array<{ type?: string; call_id: string; output: string }>).find((o) => o.type === "function_call_output" && o.call_id === "c5")!;
  assert.deepEqual(JSON.parse(out.output), { error: "user_declined" });
  assert.equal(log.since("s").some((e) => e.kind === "receipt" && e.data.tool === "post_message"), false);
});

test("undo reverses a calendar move", async () => {
  const { deps, log, world } = setup(GP1, true);
  await runCommand(deps, { session: "s", text: "…" });
  const move = log.since("s").find((e) => e.kind === "receipt" && e.data.tool === "move_event")!;
  const res = await undoReceipt(deps, move.id, "s");
  assert.equal(res.ok, true);
  assert.equal(world.state.events.get("evt_1")?.start, `${day}T15:00`);
});

test("tool inventory: devices appear only when online, and tool_search is added for deferred tools", () => {
  const { deps } = setup(GP1, true);
  const names = (deps.tools.toResponsesTools({ session: "s", surfaces: deps.surfaces }) as Array<{ type: string; name?: string }>)
    .map((t) => t.name ?? t.type);
  assert.deepEqual(names, ["calendar", "slack", "gmail", "tool_search"], "no screen online, so no surfaces namespace");
});

test("the prompt carries the user's date and time", async () => {
  const { instructions } = await import("./loop.ts");
  const text = instructions(new Date("2026-10-31T18:05:00Z"), "America/Los_Angeles");
  assert.match(text, /Saturday, October 31, 2026 at 11:05 AM \(America\/Los_Angeles\)/);
  assert.match(text, /Today's date is 2026-10-31\./);
  assert.doesNotMatch(text, /powered by/i);
});

// R12: the approve button says what it does.
test("a send tool's verb reaches the approval: the Slack post asks to Post", async () => {
  const { deps, world, watchInbox } = setup(GP1, true);
  await runCommand(deps, { session: "s", text: "I'm running 15 late…", originSurfaceId: "watch" });
  const asked = watchInbox.find((m) => m.type === "approval_request");
  assert.equal(asked?.type === "approval_request" && asked.verb, "Post");
  // Every send in the demo world names its button.
  const sends = world.namespaces.flatMap((ns) => ns.tools.filter((t) => t.tier === "send").map((t) => [`${ns.name}.${t.name}`, t.verb]));
  assert.deepEqual(Object.fromEntries(sends), { "calendar.invite": "Invite", "slack.post_message": "Post" });
});
