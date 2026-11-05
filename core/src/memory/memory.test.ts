import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runCommand, type MuseLike } from "../agent/loop.ts";
import { EventLog } from "../eventlog.ts";
import { OpsLog } from "../obs/opslog.ts";
import type { ServerMessage } from "../protocol.ts";
import { Ledger } from "../security/ledger.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { surfacesNamespace } from "../tools/surfaces.ts";
import { keywords } from "./history.ts";
import { createMemory } from "./memory.ts";
import { createReceipts } from "./receipts.ts";
import { sparkOpen, SPARK_OPEN, type ChatLike, type ChatParams } from "./spark.ts";

const call = (call_id: string, namespace: string, name: string, args: object) => ({
  type: "function_call", call_id, namespace, name, arguments: JSON.stringify(args),
});

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

/** A fake Baseten: records every request and answers, fails, or never answers. */
function fakeBaseten(answer: string | Error | "hang" = "You moved office hours to 3:15, told the TAs on Slack and drafted a reply to Prof. Lee.") {
  const calls: ChatParams[] = [];
  const client: ChatLike = {
    chat: {
      completions: {
        async create(params, options) {
          calls.push(params);
          if (answer instanceof Error) throw answer;
          if (answer === "hang") return new Promise((_, reject) => options?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
          return { choices: [{ message: { content: answer } }], usage: { prompt_tokens: 180, completion_tokens: 24 } };
        },
      },
    },
  };
  return { client, calls };
}

const now = new Date();
const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const GP1 = [
  { output: [
    call("c1", "calendar", "move_event", { event_id: "evt_1", new_start: `${day}T15:15` }),
    call("c2", "slack", "post_message", { channel_id: "C01", text: "Running 15 min late to office hours." }),
    call("c3", "gmail", "create_draft", { thread_id: "thr_9", body: "Grades will be in by 5." }),
  ] },
  { output: [], output_text: "Done." },
];

/** The demo world after GP1, with Auren Memory and receipts registered the way index.ts does it. */
async function afterGP1(answer?: string | Error | "hang", opts: { spark?: boolean; timeoutMs?: number } = {}) {
  const log = new EventLog();
  const ledger = new Ledger();
  const opsLines: Array<Record<string, unknown>> = [];
  const ops = new OpsLog({ write: (l) => opsLines.push(JSON.parse(l)) });
  const surfaces = new SurfaceRegistry();
  const inbox: ServerMessage[] = [];
  surfaces.join({ id: "phone", kind: "phone", name: "Phone", inputs: ["voice", "touch"], outputs: ["voice", "screen"] }, (m) => {
    inbox.push(m);
    if (m.type === "approval_request") queueMicrotask(() => surfaces.answer(m.request_id, true, "phone"));
  });
  const world = createDemoWorld();
  const baseten = fakeBaseten(answer);
  const spark = opts.spark === false ? undefined : sparkOpen({ client: baseten.client, ledger, ops, timeoutMs: opts.timeoutMs });
  const tools = new ToolRegistry().add(...world.namespaces, surfacesNamespace);
  tools.add(createMemory({ log, spark, ops }), createReceipts({ log, tools }));

  await runCommand({ muse: scriptedMuse(GP1).muse, tools, surfaces, log, agentModel: "muse-wonder-1.0" }, { session: "s", text: "I'm running 15 late…", originSurfaceId: "phone" });
  const ctx = { session: "s", surfaces, trace: "t1" };
  const run = (ns: string, name: string, args: object = {}) => tools.resolve(name, ns)!.tool.run(args, ctx);
  const receipts = () => log.since("s").filter((e) => e.kind === "receipt");
  return { log, ledger, opsLines, surfaces, inbox, world, tools, baseten, run, receipts };
}

test("recap sends Spark Open only receipt summaries and times, wrapped as untrusted", async () => {
  const { run, baseten, inbox } = await afterGP1();
  const out = await run("memory", "recap");

  assert.equal(out.source, "muse-spark-open");
  assert.equal(out.items, 3);
  assert.match(out.recap, /office hours to 3:15/);
  assert.equal(baseten.calls.length, 1);
  const req = baseten.calls[0];
  assert.equal(req.model, SPARK_OPEN);
  assert.equal(req.messages[0].role, "system");
  assert.match(req.messages[0].content, /untrusted_data/);

  const sent = JSON.parse(req.messages[1].content);
  assert.equal(sent.receipts.length, 3);
  for (const r of sent.receipts) {
    assert.deepEqual(Object.keys(r).filter((k) => !["time", "app", "did", "sent", "undone"].includes(k)), [], "only times, apps, summaries and flags");
    assert.match(r.time, /^\d{1,2}:\d{2} [AP]M$/);
    assert.equal(typeof r.did.untrusted_data, "string", "every summary is wrapped");
  }
  assert.deepEqual(sent.receipts.map((r: { app: string }) => r.app).sort(), ["Gmail", "Google Calendar", "Slack"]);
  assert.equal(sent.receipts.find((r: { app: string }) => r.app === "Slack").sent, true);
  const body = req.messages[1].content;
  for (const id of ["evt_1", "thr_9", "C01", "dr_", "event_id", "draft_id", "undo"]) assert.ok(!body.includes(id), `${id} must not leave Core`);

  const card = inbox.find((m) => m.type === "show_card");
  assert.ok(card && card.type === "show_card" && card.title === "Today" && card.body.split("\n").length === 3, "the receipt list goes on the screen");
});

test("every Spark Open call lands in the outbound ledger as Baseten, and in the ops log without contents", async () => {
  const { run, ledger, opsLines } = await afterGP1();
  await run("memory", "recap");

  const rows = ledger.list().filter((r) => r.service === "Baseten");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].operation, `chat.completions ${SPARK_OPEN}`);
  assert.equal(rows[0].status, "ok");
  assert.ok(rows[0].bytesOut > 100);

  const line = opsLines.find((l) => l.event === "memory.call");
  assert.ok(line);
  assert.equal(line.tool, "recap");
  assert.equal(line.trace, "t1");
  // Logged like model.call's token counts (which the ops log's /token/ key rule currently redacts).
  assert.ok("input_tokens" in line && "output_tokens" in line && typeof line.ms === "number");
  assert.ok(!JSON.stringify(opsLines).includes("Grades will be in by 5"), "no contents in the ops log");
});

test("recap falls back to a local list without a key, on errors, on timeouts and on empty answers", async () => {
  for (const [label, answer, opts] of [
    ["no key", undefined, { spark: false }],
    ["error", new Error("503 from Baseten"), {}],
    ["timeout", "hang", { timeoutMs: 30 }],
    ["empty", "", {}],
  ] as const) {
    const { run, ledger, opsLines } = await afterGP1(answer, opts);
    const t0 = performance.now();
    const out = await run("memory", "recap");
    assert.equal(out.source, "local", label);
    assert.ok(performance.now() - t0 < 1000, `${label}: falls back quickly`);
    assert.match(out.recap, /^3 things today\./, label);
    for (const s of ['Moved "Office hours (CS 5800)" to 15:15', "Post to #office-hours", 'Drafted: "Grades will be in by 5."']) assert.ok(out.recap.includes(s), `${label}: lists ${s}`);
    assert.ok(opsLines.some((l) => l.event === "memory.fallback" && l.tool === "recap"), `${label}: fallback logged`);
    const baseten = ledger.list().filter((r) => r.service === "Baseten");
    if (label === "no key") assert.equal(baseten.length, 0, "nothing leaves without a key");
    else assert.equal(baseten[0].status, label === "error" || label === "timeout" ? "error" : "ok", label);
  }
});

test("recap of an empty day says so without calling Spark Open", async () => {
  const { run, baseten } = await afterGP1();
  const out = await run("memory", "recap", { date: "2001-01-01" });
  assert.equal(out.items, 0);
  assert.match(out.recap, /^Nothing done on Monday, January 1\.$/);
  assert.equal(baseten.calls.length, 0);
});

test("recall filters the log by keyword, then asks Spark Open over just the matches", async () => {
  const { run, baseten } = await afterGP1("You drafted a reply to Prof. Lee saying grades are in by 5.");
  const out = await run("memory", "recall", { query: "What did I tell Prof. Lee about the grades?" });

  assert.equal(out.source, "muse-spark-open");
  assert.match(out.answer, /Prof\. Lee/);
  const sent = JSON.parse(baseten.calls[0].messages[1].content);
  assert.equal(sent.question, "What did I tell Prof. Lee about the grades?");
  const texts = sent.entries.map((e: { text: string | { untrusted_data: string } }) => (typeof e.text === "string" ? e.text : e.text.untrusted_data));
  assert.ok(texts.some((t: string) => t.includes("Grades will be in by 5")), "the draft matches");
  assert.ok(!texts.some((t: string) => t.includes("Office hours")), "the calendar move doesn't");
  for (const e of sent.entries) if (e.who === "Auren") assert.equal(typeof e.text.untrusted_data, "string", "Auren's side is wrapped");
});

test("recall with no matching events answers locally and sends nothing", async () => {
  const { run, baseten, ledger } = await afterGP1();
  const out = await run("memory", "recall", { query: "What did I order for lunch?" });
  assert.equal(out.matches, 0);
  assert.equal(out.source, "local");
  assert.equal(baseten.calls.length, 0);
  assert.equal(ledger.list().length, 0);
});

test("recall falls back to the matching entries when Spark Open fails", async () => {
  const { run } = await afterGP1(new Error("boom"));
  const out = await run("memory", "recall", { query: "slack post" });
  assert.equal(out.source, "local");
  assert.match(out.answer, /^From your log: .*Slack: Post to #office-hours/);
});

test("undo by description reverses the most recent matching receipt, with one receipt of its own", async () => {
  const { run, world, receipts, baseten } = await afterGP1();
  assert.equal(world.state.events.get("evt_1")?.start, `${day}T15:15`);
  const before = receipts().length;
  const move = receipts().find((r) => r.data.tool === "move_event")!;

  const out = await run("receipts", "undo", { description: "the calendar move" });
  assert.equal(out.ok, true);
  assert.equal(out.undid, move.id);
  assert.equal(world.state.events.get("evt_1")?.start, `${day}T15:00`, "office hours is back at 3");
  const added = receipts().slice(before);
  assert.equal(added.length, 1, "the undo writes exactly one receipt");
  assert.equal(added[0].data.undoes, move.id);
  assert.match(String(added[0].data.summary), /^Undid: Moved/);

  const again = await run("receipts", "undo", { description: "the calendar move" });
  assert.equal(again.ok, false, "already undone, and nothing else matches");
  assert.equal(world.state.events.get("evt_1")?.start, `${day}T15:00`);

  const recap = await run("memory", "recap");
  assert.equal(recap.items, 3, "the undo shows as a flag, not a fourth item");
  const sent = JSON.parse(baseten.calls.at(-1)!.messages[1].content);
  assert.equal(sent.receipts.find((r: { app: string }) => r.app === "Google Calendar").undone, true);
});

test("undo refuses sends, by description and by id, and changes nothing", async () => {
  const { run, world, receipts } = await afterGP1();
  const post = receipts().find((r) => r.data.tool === "post_message")!;
  const before = receipts().length;

  for (const args of [{ description: "the Slack post" }, { receipt_id: post.id }]) {
    const out = await run("receipts", "undo", args);
    assert.equal(out.ok, false);
    assert.match(out.message, /sent, and sends can't be undone/);
  }
  assert.equal(world.state.posts.length, 1);
  assert.equal(receipts().length, before, "a refusal writes no receipt");
});

test("undo refuses receipts without an undo step, undos themselves, and ids from nowhere", async () => {
  const { run, log, receipts } = await afterGP1();
  const noStep = log.append("s", "receipt", { app: "Google Calendar", namespace: "calendar", tool: "move_event", tier: "write", summary: "Moved something by hand", undo: null });
  assert.match((await run("receipts", "undo", { receipt_id: noStep.id })).message, /has no undo step/);

  const draft = receipts().find((r) => r.data.tool === "create_draft")!;
  assert.equal((await run("receipts", "undo", { receipt_id: draft.id })).ok, true);
  const undo = receipts().at(-1)!;
  assert.match((await run("receipts", "undo", { receipt_id: undo.id })).message, /is itself an undo/);
  assert.match((await run("receipts", "undo", { receipt_id: draft.id })).message, /already undone/);
  assert.match((await run("receipts", "undo", { receipt_id: 9999 })).message, /no receipt 9999/);
});

test("list_recent shows the newest receipts first, with what can be undone", async () => {
  const { run } = await afterGP1();
  const { receipts } = await run("receipts", "list_recent", { limit: 2 });
  assert.equal(receipts.length, 2);
  assert.ok(receipts[0].id > receipts[1].id);
  const all = (await run("receipts", "list_recent")).receipts;
  const byTool = (s: string) => all.find((r: { summary: string }) => r.summary.includes(s));
  assert.equal(byTool("Moved").can_undo, true);
  assert.equal(byTool("Post to").can_undo, false);
  assert.match(byTool("Post to").why_not, /sends can't be undone/);
});

test("GP5 by voice: the loop recaps, then undoes the calendar move with a single receipt", async () => {
  const { log, surfaces, tools, world, receipts } = await afterGP1(undefined, { spark: false });
  const before = receipts().length;
  const { muse, requests } = scriptedMuse([
    { output: [call("r1", "memory", "recap", {})] },
    { output: [], output_text: "Three things: office hours moved, Slack posted, a draft for Prof. Lee." },
    { output: [call("u1", "receipts", "undo", { description: "the calendar move" })] },
    { output: [], output_text: "Office hours is back at 3." },
  ]);
  const deps = { muse, tools, surfaces, log, agentModel: "muse-wonder-1.0" };

  await runCommand(deps, { session: "s", text: "What did I get done today?", originSurfaceId: "phone" });
  const inventory = (requests[0].tools as Array<{ name?: string }>).map((t) => t.name);
  assert.ok(inventory.includes("memory") && inventory.includes("receipts"), "both namespaces are offered");
  const recapOut = JSON.parse((requests[1].input as Array<{ type: string; output: string }>).find((o) => o.type === "function_call_output")!.output);
  assert.ok(recapOut.untrusted_data?.recap, "the loop hands the recap back as untrusted data");

  const { reply } = await runCommand(deps, { session: "s", text: "Undo the calendar move.", originSurfaceId: "phone" });
  assert.equal(reply, "Office hours is back at 3.");
  assert.equal(world.state.events.get("evt_1")?.start, `${day}T15:00`);
  assert.equal(receipts().length - before, 1, "gp5-recap-then-undo expects one receipt");
  assert.equal(receipts().at(-1)?.data.tool, "move_event");
});

test("undo-a-draft by voice: 'undo that' removes the draft the last write created", async () => {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry();
  const world = createDemoWorld();
  const tools = new ToolRegistry().add(...world.namespaces, surfacesNamespace);
  tools.add(createMemory({ log }), createReceipts({ log, tools }));
  const { muse } = scriptedMuse([
    { output: [call("d1", "gmail", "create_draft", { thread_id: "thr_9", body: "Grades are in by 5." })] },
    { output: [], output_text: "Draft ready." },
    { output: [call("u1", "receipts", "undo", { description: "that" })] },
    { output: [], output_text: "Draft deleted." },
  ]);
  const deps = { muse, tools, surfaces, log, agentModel: "muse-wonder-1.0" };
  await runCommand(deps, { session: "s", text: "Draft a reply to Prof. Lee saying grades are in by 5." });
  assert.equal(world.state.drafts.size, 1);
  await runCommand(deps, { session: "s", text: "Undo that." });
  assert.equal(world.state.drafts.size, 0);
  assert.equal(log.since("s").filter((e) => e.kind === "receipt").length, 2, "undo-a-draft expects two receipts");
});

test("the eval cases' memory and receipts tools exist, with the right tiers", () => {
  const log = new EventLog();
  const tools = new ToolRegistry();
  tools.add(createMemory({ log }), createReceipts({ log, tools }));
  for (const f of ["gp5-recap-then-undo.json", "undo-a-draft.json"]) {
    const c = JSON.parse(readFileSync(new URL(`../../../eval/cases/${f}`, import.meta.url), "utf8"));
    for (const name of c.expect.tools.filter((t: string) => /^(memory|receipts)\./.test(t))) {
      const [ns, fn] = name.split(".");
      assert.ok(tools.resolve(fn, ns), `${f}: ${name} exists`);
    }
  }
  assert.equal(tools.resolve("recap", "memory")?.tool.tier, "read");
  assert.equal(tools.resolve("recall", "memory")?.tool.tier, "read");
  assert.equal(tools.resolve("list_recent", "receipts")?.tool.tier, "read");
  assert.equal(tools.resolve("undo", "receipts")?.tool.tier, "write");
});

test("keywords match across word forms and drop filler", () => {
  assert.deepEqual(keywords("Undo the calendar move"), ["calendar", "mov"]);
  assert.deepEqual(keywords("Moved \"Office hours\""), ["mov", "offic", "hour"]);
  assert.deepEqual(keywords("undo that"), []);
});
