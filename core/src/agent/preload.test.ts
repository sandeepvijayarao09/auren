import assert from "node:assert/strict";
import { test } from "node:test";
import { EventLog } from "../eventlog.ts";
import type { ServerMessage } from "../protocol.ts";
import { examplesFrom } from "../router/examples.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { runCommand, type MuseLike } from "./loop.ts";
import { inviteeNames } from "./preload.ts";

const call = (call_id: string, namespace: string, name: string, args: object) => ({
  type: "function_call", call_id, namespace, name, arguments: JSON.stringify(args),
});

function setup(turns: Array<{ output: unknown[]; output_text?: string }>) {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry();
  const world = createDemoWorld();
  let finds = 0;
  for (const ns of world.namespaces) {
    for (const t of ns.tools) {
      if (t.name !== "find_contact") continue;
      const run = t.run;
      t.run = (args, ctx) => (finds++, run(args, ctx));
    }
  }
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
    if (m.type === "approval_request") queueMicrotask(() => surfaces.answer(m.request_id, true, "watch"));
  });
  return { deps: { muse, tools, surfaces, log, agentModel: "m" }, log, world, requests, watch, finds: () => finds };
}

test("inviteeNames reads who to invite, and nothing else", () => {
  assert.deepEqual(inviteeNames("Add this, and invite Priya."), ["Priya"]);
  assert.deepEqual(inviteeNames("Invite Priya Shah and Lee to it"), ["Priya Shah", "Lee"]);
  assert.deepEqual(inviteeNames("invite Sam, Lena & Jo, and invite Sam"), ["Sam", "Lena", "Jo"]);
  assert.deepEqual(inviteeNames("invite everyone on the team"), []);
  assert.deepEqual(inviteeNames("Invite them"), []);
  assert.deepEqual(inviteeNames("Message Priya that I'm late."), [], "only invites; messages have their own lookups");
  assert.deepEqual(inviteeNames("invite Ann, Bo, Cy and Di"), ["Ann", "Bo", "Cy"], "at most three");
});

const day = new Intl.DateTimeFormat("en-CA").format(new Date());

test("GP2: Priya's lookup starts with the command and goes in after the first turn, so the invite is one turn sooner", async () => {
  const { deps, log, world, requests, watch, finds } = setup([
    // The model only creates the event; it never asks for find_contact itself.
    { output: [call("c1", "calendar", "create_event", { title: "Demo night", start: `${day}T18:00` })] },
    { output: [call("c2", "calendar", "invite", { event_id: "evt_101", emails: ["priya@example.com"] })] },
    { output: [], output_text: "Added and invited Priya." },
  ]);
  await runCommand(deps, { session: "s", text: "Add Demo night at 6, and invite Priya.", originSurfaceId: "watch" });
  assert.equal(finds(), 1);
  assert.equal(requests.length, 3);
  // Turn 2 sees the lookup as a call and its result, right after turn 1's own.
  const turn2 = requests[1].input as Array<{ type?: string; call_id?: string; name?: string; output?: string }>;
  const pre = turn2.findIndex((o) => o.type === "function_call" && o.call_id === "auren_preload_0");
  assert.ok(pre > 0, "the preloaded call is in the history");
  assert.equal(turn2[pre].name, "find_contact");
  assert.equal(turn2[pre + 1].type, "function_call_output");
  assert.deepEqual(JSON.parse(turn2[pre + 1].output!).matches, [{ name: "Priya Raman", email: "priya@example.com" }]);
  // It is logged as Core's own read, and the invite still waits for its tap.
  const lookup = log.since("s").find((e) => e.kind === "tool_call" && e.data.tool === "find_contact");
  assert.deepEqual([lookup?.data.tier, lookup?.data.preload], ["read", true]);
  assert.equal(watch.filter((m) => m.type === "approval_request").length, 1);
  assert.deepEqual(world.state.events.get("evt_101")?.invitees, ["priya@example.com"]);
  // The router's training examples don't count Core's preload as the command's choice.
  assert.deepEqual(examplesFrom(log.since("s")).map((x) => x.label.apps), [["calendar"]]);
});

test("when the model asks for the same contact itself, the started lookup is reused, not run twice", async () => {
  const { deps, requests, finds } = setup([
    { output: [call("c1", "calendar", "find_contact", { name: "priya" }), call("c2", "calendar", "create_event", { title: "Demo night", start: `${day}T18:00` })] },
    { output: [], output_text: "Added. Invite Priya Raman?" },
  ]);
  await runCommand(deps, { session: "s", text: "Add Demo night, and invite Priya." });
  assert.equal(finds(), 1);
  const turn2 = requests[1].input as Array<{ type?: string; call_id?: string }>;
  assert.ok(turn2.some((o) => o.type === "function_call_output" && o.call_id === "c1"), "answered under the model's own call id");
  assert.ok(!turn2.some((o) => o.call_id === "auren_preload_0"), "and not added a second time");
});

test("when the model looks the person up under another name, the preload isn't added on top", async () => {
  const { deps, requests } = setup([
    { output: [call("c1", "calendar", "find_contact", { name: "Priya Raman" })] },
    { output: [], output_text: "Invite Priya Raman?" },
  ]);
  await runCommand(deps, { session: "s", text: "Add this, and invite Priya." });
  const turn2 = requests[1].input as Array<{ call_id?: string }>;
  assert.ok(!turn2.some((o) => o.call_id === "auren_preload_0"));
});

test("no preload for a command without an invite, for a command Auren gives itself, or when the model answers at once", async () => {
  const a = setup([{ output: [], output_text: "Which Priya?" }]);
  await runCommand(a.deps, { session: "s", text: "Message Priya that I'm late." });
  assert.equal(a.finds(), 0);
  const b = setup([{ output: [], output_text: "ok" }]);
  await runCommand(b.deps, { session: "s", text: "invite Priya", system: "plan" });
  assert.equal(b.finds(), 0);
  const c = setup([{ output: [], output_text: "Sure." }]);
  await runCommand(c.deps, { session: "s", text: "invite Priya" });
  assert.equal(c.requests.length, 1, "a lookup the model never needed doesn't cost a turn");
});
