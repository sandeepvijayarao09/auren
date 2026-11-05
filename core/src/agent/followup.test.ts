import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog } from "../eventlog.ts";
import type { ServerMessage } from "../protocol.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { followUpContext, FOLLOWUP_MAX_CHARS, FOLLOWUP_PREFIX } from "./followup.ts";
import { runCommand, type MuseLike } from "./loop.ts";

const call = (call_id: string, namespace: string, name: string, args: object) => ({
  type: "function_call", call_id, namespace, name, arguments: JSON.stringify(args),
});

const now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** A scripted model across several commands; every request the loop sends is kept. */
function setup(turns: Array<{ output: unknown[]; output_text?: string }>, approve = true) {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry();
  const world = createDemoWorld();
  const tools = new ToolRegistry().add(...world.namespaces);
  const requests: Array<Record<string, unknown>> = [];
  let i = 0;
  const muse: MuseLike = {
    responses: {
      async create(params) {
        requests.push(params);
        const t = turns[i++];
        if (!t) throw new Error("script ran out");
        return { id: `r${i}`, output: t.output, output_text: t.output_text ?? "" };
      },
    },
  };
  const watch: ServerMessage[] = [];
  surfaces.join({ id: "watch", kind: "watch", name: "Watch", inputs: ["voice", "touch"], outputs: ["voice", "haptic"] }, (m) => {
    watch.push(m);
    if (m.type === "approval_request") queueMicrotask(() => surfaces.answer(m.request_id, approve, "watch"));
  });
  return { deps: { muse, tools, surfaces, log, agentModel: "m" }, log, world, requests, watch };
}

const MOVE_TO_330 = [
  { output: [call("c1", "calendar", "list_events", { date: day })] },
  { output: [call("c2", "calendar", "move_event", { event_id: "evt_1", new_start: `${day}T15:30` })] },
  { output: [], output_text: "Office hours now start at 3:30." },
];

test("a follow-up starts with a labelled note of the last command: what was said, the reply, and the receipt with its event id", async () => {
  const { deps, log, world, requests } = setup([
    ...MOVE_TO_330,
    { output: [call("c3", "calendar", "move_event", { event_id: "evt_1", new_start: `${day}T16:00` })] },
    { output: [], output_text: "Moved to 4." },
  ]);
  await runCommand(deps, { session: "s", text: "Push my office hours to 3:30." });
  assert.deepEqual(requests[0].input, [{ role: "user", content: "Push my office hours to 3:30." }], "the first command has nothing to carry");

  await runCommand(deps, { session: "s", text: "Actually, move it to 4 instead." });
  const input = requests[3].input as Array<{ role: string; content: string }>;
  assert.equal(input.length, 2);
  assert.deepEqual(input[1], { role: "user", content: "Actually, move it to 4 instead." }, "the user's words stay their own item");
  const note = input[0].content;
  const receipt = log.since("s").find((e) => e.kind === "receipt")!;
  assert.ok(note.startsWith(FOLLOWUP_PREFIX));
  assert.match(note, /a record, not a request/);
  assert.match(note, /User said: "Push my office hours to 3:30\."/);
  assert.match(note, /Auren replied: "Office hours now start at 3:30\."/);
  assert.match(note, new RegExp(`receipt ${receipt.id}: calendar\\.move_event \\(event_id=evt_1, new_start=${day}T15:30\\)`));
  assert.match(note, /looked up calendar\.list_events \(date=/);
  assert.equal(world.state.events.get("evt_1")?.start, `${day}T16:00`);
});

test("no note outside the window, with the window off, for a command Auren gives itself, or across sessions", async () => {
  const { deps, log, requests } = setup([...MOVE_TO_330, { output: [], output_text: "a" }, { output: [], output_text: "b" }, { output: [], output_text: "c" }]);
  await runCommand(deps, { session: "s", text: "Push my office hours to 3:30." });
  const ended = log.since("s").find((e) => e.kind === "reply")!.at;
  assert.ok(followUpContext(log, "s", { now: ended + 299_000 }));
  assert.equal(followUpContext(log, "s", { now: ended + 301_000 }), "", "five minutes later it's a new conversation");
  assert.equal(followUpContext(log, "s", { windowMs: 0 }), "", "AUREN_FOLLOWUP_WINDOW_S=0 turns it off");
  assert.equal(followUpContext(log, "other"), "", "another session's command isn't carried");

  await runCommand({ ...deps, followUpWindowMs: 0 }, { session: "s", text: "and again" });
  assert.equal((requests[3].input as unknown[]).length, 1);
  await runCommand(deps, { session: "s", text: "Morning briefing.", system: "briefing" });
  assert.equal((requests[4].input as unknown[]).length, 1, "the briefing starts clean");
  await runCommand(deps, { session: "t", text: "hello" });
  assert.equal((requests[5].input as unknown[]).length, 1);
});

test("no note while the last command is still running (no reply yet)", () => {
  const log = new EventLog();
  log.append("s", "utterance", { text: "Push my office hours to 3:30." });
  log.append("s", "tool_call", { app: "Calendar", namespace: "calendar", tool: "move_event", tier: "write", args: { event_id: "evt_1" } });
  // A tool's own error doesn't end the command.
  log.append("s", "error", { app: "Calendar", tool: "move_event", message: "503" });
  assert.equal(followUpContext(log, "s"), "");
  log.append("s", "error", { message: "the model is down" });
  assert.match(followUpContext(log, "s"), /It ended in an error\./);
});

test("the note stays small: long replies are clipped and free text from arguments stays out", () => {
  const log = new EventLog();
  log.append("s", "utterance", { text: "Tell #general the demo moved." });
  log.append("s", "tool_call", { app: "Slack", namespace: "slack", tool: "post_message", tier: "send", args: { channel_id: "C03", text: "SECRET BODY ".repeat(50) } });
  log.append("s", "receipt", { app: "Slack", namespace: "slack", tool: "post_message", tier: "send", summary: "Posted to #general", undo: null });
  for (let i = 0; i < 40; i++) log.append("s", "tool_call", { app: "Gmail", namespace: "gmail", tool: "search_threads", tier: "read", args: { query: `q${i} ${"x".repeat(50)}` } });
  log.append("s", "reply", { text: "Posted. ".repeat(200) });
  const note = followUpContext(log, "s");
  assert.ok(note.length <= FOLLOWUP_MAX_CHARS, `${note.length} chars`);
  assert.match(note, /slack\.post_message \(channel_id=C03\): Posted to #general/);
  assert.doesNotMatch(note, /SECRET BODY/, "message bodies aren't carried");
});

test("the note can't skip a tap: a follow-up send still asks, and a decline still stops it", async () => {
  const { deps, world, watch } = setup([
    { output: [call("c1", "slack", "post_message", { channel_id: "C01", text: "Running late." })] },
    { output: [], output_text: "Posted." },
    { output: [call("c2", "slack", "post_message", { channel_id: "C01", text: "Make that 20 minutes." })] },
    { output: [], output_text: "Not posted." },
  ]);
  await runCommand(deps, { session: "s", text: "Tell office hours I'm late.", originSurfaceId: "watch" });
  deps.surfaces.leave("watch");
  const declines: ServerMessage[] = [];
  deps.surfaces.join({ id: "watch", kind: "watch", name: "Watch", inputs: ["voice", "touch"], outputs: ["voice", "haptic"] }, (m) => {
    declines.push(m);
    if (m.type === "approval_request") queueMicrotask(() => deps.surfaces.answer(m.request_id, false, "watch"));
  });
  await runCommand(deps, { session: "s", text: "Actually say 20 minutes.", originSurfaceId: "watch" });
  assert.equal(watch.filter((m) => m.type === "approval_request").length, 1);
  assert.equal(declines.filter((m) => m.type === "approval_request").length, 1, "the follow-up's send asked for its own tap");
  assert.deepEqual(world.state.posts.map((p) => p.text), ["Running late."]);
});
