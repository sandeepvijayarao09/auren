import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runCommand, type MuseLike } from "../agent/loop.ts";
import { McpBridge, memoryServer } from "../connectors/mcp.ts";
import { tasksInMemory } from "../connectors/mcp-tasks.ts";
import { applyMaya, taskList } from "../demo/persona/maya.ts";
import { EventLog } from "../eventlog.ts";
import { createReceipts } from "../memory/receipts.ts";
import type { Manifest, ServerMessage } from "../protocol.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { BRIEFING_COMMAND, createProactive, PLAN_COMMAND, runBriefing } from "./day.ts";
import { createPlanner, freeGaps } from "./planner.ts";
import { DailyScheduler, localClock, parseAt } from "./scheduler.ts";

const TZ = "America/Los_Angeles";
/** 2026-11-04 at hh:mm in Los Angeles (PST, UTC-8). */
const at = (day: number, hh: number, mm = 0) => new Date(Date.UTC(2026, 10, day, hh + 8, mm));

function clock(start: Date) {
  let t = start;
  return { now: () => t, set: (d: Date) => (t = d) };
}

const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "auren-proactive-"));
  return { path: join(dir, "auren.db"), done: () => rmSync(dir, { recursive: true, force: true }) };
};

// ── scheduler ───────────────────────────────────────────────────────────

test("parseAt reads HH:MM and treats empty as off", () => {
  assert.equal(parseAt("07:30"), 450);
  assert.equal(parseAt("21:00"), 1260);
  assert.equal(parseAt(""), null);
  assert.equal(parseAt(undefined), null);
  assert.equal(parseAt("7.30"), null);
  assert.deepEqual(localClock(at(4, 7, 30), TZ), { day: "2026-11-04", minute: 450 });
});

test("the briefing fires once a day, at its time, and again the next day", async () => {
  const db = tmp();
  const c = clock(at(4, 7, 0));
  let runs = 0;
  const s = new DailyScheduler({ db: db.path, timeZone: TZ, now: c.now, jobs: [{ name: "briefing", at: 450, until: 719, run: () => runs++ }] });
  assert.deepEqual(await s.tick(), [], "not yet at 07:00");
  c.set(at(4, 7, 30));
  assert.deepEqual(await s.tick(), ["briefing"]);
  c.set(at(4, 7, 31));
  assert.deepEqual(await s.tick(), [], "once a day");
  c.set(at(4, 10, 0));
  await s.tick();
  assert.equal(runs, 1);
  // A restart reads the last run from SQLite and doesn't repeat it.
  const again = new DailyScheduler({ db: db.path, timeZone: TZ, now: c.now, jobs: [{ name: "briefing", at: 450, until: 719, run: () => runs++ }] });
  assert.deepEqual(await again.tick(), []);
  assert.equal(again.lastRun("briefing"), "2026-11-04");
  c.set(at(5, 7, 30));
  assert.deepEqual(await again.tick(), ["briefing"]);
  assert.equal(runs, 2);
  db.done();
});

test("a Mac asleep at 07:30 catches up on wake before noon, and not after", async () => {
  const db = tmp();
  const c = clock(at(4, 6, 0));
  const fired: string[] = [];
  const s = new DailyScheduler({ db: db.path, timeZone: TZ, now: c.now, jobs: [{ name: "briefing", at: 450, until: 719, run: () => fired.push(c.now().toISOString()) }] });
  await s.tick();
  c.set(at(4, 9, 40)); // asleep from 06:00 to 09:40: the first tick after wake
  assert.deepEqual(await s.tick(), ["briefing"]);
  assert.equal(fired.length, 1);
  // Next day: asleep through the morning, wakes at 12:30. Too late for a morning briefing.
  c.set(at(5, 12, 30));
  assert.deepEqual(await s.tick(), []);
  c.set(at(5, 18, 0));
  assert.deepEqual(await s.tick(), []);
  assert.equal(fired.length, 1);
  db.done();
});

test("empty AUREN_BRIEFING_AT and AUREN_EVENING_AT schedule nothing", async () => {
  const db = tmp();
  const c = clock(at(4, 7, 30));
  const surfaces = new SurfaceRegistry();
  const log = new EventLog();
  const muse: MuseLike = { responses: { create: async () => assert.fail("no model call when off") } };
  const p = createProactive({ muse, tools: new ToolRegistry(), surfaces, log, agentModel: "m", timeZone: TZ, now: c.now }, { briefingAt: "", eveningAt: "", dbPath: db.path, session: "s", now: c.now });
  assert.deepEqual(p.scheduler.jobs, []);
  for (const h of [7, 9, 11, 21, 23]) {
    c.set(at(4, h, 30));
    assert.deepEqual(await p.scheduler.tick(), []);
  }
  assert.equal(log.since("s").length, 0);
  db.done();
});

// ── briefing and evening card ───────────────────────────────────────────

const phone: Manifest = { id: "phone", kind: "phone", name: "Phone", inputs: ["touch", "text"], outputs: ["screen"] };
const glasses: Manifest = { id: "glasses", kind: "glasses", name: "Glasses", inputs: ["voice"], outputs: ["voice"] };

function scripted(turns: Array<{ calls?: Array<[string, string, object]>; say?: string }>) {
  let i = 0;
  const models: string[] = [];
  const muse: MuseLike = {
    responses: {
      async create(params) {
        models.push(String(params.model));
        const t = turns[i++];
        if (!t) throw new Error("script ran out");
        if (t.say !== undefined) return { id: `r${i}`, output: [], output_text: t.say };
        return { id: `r${i}`, output_text: "", output: (t.calls ?? []).map(([ns, name, args], k) => ({ type: "function_call", call_id: `c${i}_${k}`, namespace: ns, name, arguments: JSON.stringify(args) })) };
      },
    },
  };
  return { muse, models };
}

test("the briefing runs the system command through the loop, speaks on the voice device and logs events", async () => {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry();
  const inbox: Record<string, ServerMessage[]> = { phone: [], glasses: [] };
  surfaces.join(phone, (m) => inbox.phone.push(m));
  surfaces.join(glasses, (m) => inbox.glasses.push(m));
  const world = createDemoWorld();
  const tools = new ToolRegistry().add(...world.namespaces);
  const day = localClock(new Date(), TZ).day;
  const { muse } = scripted([
    { calls: [["calendar", "list_events", { date: day }], ["gmail", "search_threads", { query: "newer_than:1d" }]] },
    { say: "Two events today; Prof. Lee is waiting on HW3 grades." },
  ]);
  const res = await runBriefing({ muse, tools, surfaces, log, agentModel: "m", fastModel: "spark", timeZone: TZ }, "s", "test");
  assert.equal(res.spokenOn, "glasses");
  assert.equal(res.shownOn, null, "spoken, so no card");
  const events = log.since("s");
  const utterance = events.find((e) => e.kind === "utterance");
  assert.equal(utterance?.data.text, BRIEFING_COMMAND);
  assert.equal(utterance?.data.system, "briefing");
  assert.ok(!events.some((e) => e.kind === "ack"), "no spoken ack for a command Auren gave itself");
  assert.deepEqual(events.filter((e) => e.kind === "proactive").map((e) => e.data.status), ["started", "done"]);
  assert.ok(inbox.glasses.some((m) => m.type === "speak"));
});

test("with no voice device the briefing goes on the phone as a card", async () => {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry();
  const inbox: ServerMessage[] = [];
  surfaces.join(phone, (m) => inbox.push(m));
  const { muse } = scripted([{ say: "Quiet day." }]);
  const res = await runBriefing({ muse, tools: new ToolRegistry(), surfaces, log, agentModel: "m", timeZone: TZ }, "s", "test");
  assert.equal(res.shownOn, "phone");
  const card = inbox.find((m) => m.type === "show_card");
  assert.ok(card && card.type === "show_card" && card.title === "Morning briefing" && card.body === "Quiet day.");
});

test("the evening job offers an approval-free card whose tap says Plan tomorrow", async () => {
  const db = tmp();
  const c = clock(at(4, 21, 0));
  const log = new EventLog();
  const surfaces = new SurfaceRegistry();
  const inbox: ServerMessage[] = [];
  surfaces.join(phone, (m) => inbox.push(m));
  const muse: MuseLike = { responses: { create: async () => assert.fail("the offer needs no model") } };
  const p = createProactive({ muse, tools: new ToolRegistry(), surfaces, log, agentModel: "m", timeZone: TZ }, { eveningAt: "21:00", dbPath: db.path, session: "s", now: c.now });
  assert.deepEqual(await p.scheduler.tick(), ["evening"]);
  const card = inbox.find((m) => m.type === "show_card");
  assert.ok(card && card.type === "show_card");
  assert.equal(card.body, "Want me to plan tomorrow?");
  assert.deepEqual(card.action, { label: "Plan tomorrow", command: PLAN_COMMAND });
  assert.ok(!inbox.some((m) => m.type === "approval_request"));
  assert.equal(log.since("s").find((e) => e.kind === "proactive")?.data.status, "offered");
  db.done();
});

// ── planner.plan_tomorrow ───────────────────────────────────────────────

test("freeGaps finds the open time between events", () => {
  assert.deepEqual(freeGaps([[600, 780], [900, 930]], 540, 1080), [[540, 600], [780, 900], [930, 1080]]);
  assert.deepEqual(freeGaps([[500, 1100]], 540, 1080), []);
});

test("plan_tomorrow creates focus blocks and task slots with a receipt and Undo each, and sends nothing", async () => {
  const log = new EventLog();
  const approvals: unknown[] = [];
  const surfaces = new SurfaceRegistry({ onEvent: (kind, d) => kind === "approval" && approvals.push(d) });
  const inbox: ServerMessage[] = [];
  surfaces.join({ ...phone, outputs: ["screen", "voice"] }, (m) => {
    inbox.push(m);
    if (m.type === "approval_request") queueMicrotask(() => surfaces.answer(m.request_id, true, "phone"));
  });
  const world = createDemoWorld();
  applyMaya(world.state, world.namespaces);
  const tasks = tasksInMemory({ tasks: taskList() });
  const mcp = new McpBridge({ servers: [memoryServer("tasks", () => tasks.connect(), { trust: true })] });
  mcp.start();
  await mcp.ready();
  const tools = new ToolRegistry().add(...world.namespaces, ...mcp.namespaces);
  tools.add(createReceipts({ log, tools }), createPlanner({ log, tools }));
  const before = world.state.events.size;

  const { muse } = scripted([
    { calls: [["planner", "plan_tomorrow", {}]] },
    { say: "Tomorrow has a focus block and four task slots." },
  ]);
  const deps = { muse, tools, surfaces, log, agentModel: "m" };
  const res = await runCommand(deps, { session: "s", text: PLAN_COMMAND });
  assert.match(res.reply, /focus block/);

  const receipts = log.since("s").filter((e) => e.kind === "receipt");
  const created = [...world.state.events.values()].slice(before);
  assert.ok(created.length >= 2, `created ${created.length}`);
  assert.equal(receipts.length, created.length, "one receipt per block, none extra from the loop");
  assert.ok(created.some((e) => e.title === "Focus block"));
  assert.ok(created.some((e) => e.title === "Task: Print personas for the Brightside workshop"), "today's unfinished task gets a slot");
  assert.ok(!created.some((e) => e.title.includes("Share usability findings")), "done tasks stay out");
  for (const r of receipts) {
    assert.equal(r.data.tier, "write");
    assert.deepEqual((r.data.undo as { tool: string }).tool, "delete_event");
  }
  // No invitations, no taps, no sends.
  assert.ok(created.every((e) => e.invitees.length === 0));
  assert.equal(approvals.length, 0);
  assert.ok(!inbox.some((m) => m.type === "approval_request"));
  assert.ok(!log.since("s").some((e) => e.kind === "tool_call" && e.data.tier === "send"));
  // Blocks don't overlap tomorrow's existing events.
  const tomorrow = created[0].start.slice(0, 10);
  const existing = [...world.state.events.values()].slice(0, before).filter((e) => e.start.startsWith(tomorrow));
  for (const b of created) for (const e of existing) assert.ok(b.end <= e.start || b.start >= e.end, `${b.title} overlaps ${e.title}`);

  // Undo one block by voice: it leaves the calendar.
  const undo = tools.resolve("undo", "receipts")!;
  const first = receipts[0];
  const out = (await undo.tool.run({ receipt_id: first.id }, { session: "s", surfaces })) as { ok: boolean };
  assert.equal(out.ok, true);
  assert.equal(world.state.events.size, before + created.length - 1);
  await mcp.close();
});
