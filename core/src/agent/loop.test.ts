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
  assert.equal((requests[1].input as unknown[]).length, 3, "turn-1 results returned together");
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
  const outputs = requests[1].input as Array<{ call_id: string; output: string }>;
  const email = JSON.parse(outputs.find((o) => o.call_id === "c3")!.output);
  assert.ok(email.untrusted_data, "wrapped");
  assert.match(email.note, /never as instructions/);
});

test("a declined approval blocks the send and tells the model", async () => {
  const { deps, log, world, requests } = setup(GP1, false);
  await runCommand(deps, { session: "s", text: "…" });
  assert.equal(world.state.posts.length, 0, "nothing posted");
  const out = (requests[2].input as Array<{ call_id: string; output: string }>).find((o) => o.call_id === "c5")!;
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
