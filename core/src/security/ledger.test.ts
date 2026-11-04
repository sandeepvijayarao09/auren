import assert from "node:assert/strict";
import { test } from "node:test";
import { Ledger, ledgerMuse, pathTemplate } from "./ledger.ts";

test("paths keep their shape but lose their ids", () => {
  assert.equal(pathTemplate("https://www.googleapis.com/calendar/v3/calendars/primary/events/3k9x2qmd0a7vjk1nq6m5?sendUpdates=none"), "/calendar/v3/calendars/primary/events/:id");
  assert.equal(pathTemplate("https://people.googleapis.com/v1/people:searchContacts?query=Priya"), "/v1/people:searchContacts");
});

test("every model request is recorded with size and timing, never contents", async () => {
  const ledger = new Ledger();
  const muse = ledgerMuse({ responses: { create: async () => ({ id: "r1", output: [] }) } }, ledger);
  await muse.responses.create({ model: "muse-wonder-1.0", input: "Tell office hours I'm running late" });
  const failing = ledgerMuse({ responses: { create: async () => { throw new Error("429"); } } }, ledger);
  await assert.rejects(failing.responses.create({ model: "muse-spark-1.3", input: "x" }));

  const [err, ok] = ledger.list();
  assert.equal(ok.service, "Meta Model API");
  assert.equal(ok.operation, "responses.create muse-wonder-1.0");
  assert.equal(ok.status, "ok");
  assert.ok(ok.bytesOut > 30);
  assert.equal(err.status, "error");
  assert.ok(!JSON.stringify(ledger.list()).includes("office hours"));
  assert.deepEqual(ledger.summary().map((s) => [s.service, s.calls]), [["Meta Model API", 2]]);
});

// ── R13: token usage ─────────────────────────────────────────────────────

test("every model call's tokens are counted through ledgerMuse: the agent loop, the fast ack and vision", async () => {
  const { runCommand } = await import("../agent/loop.ts");
  const { EventLog } = await import("../eventlog.ts");
  const { SurfaceRegistry } = await import("../surfaces.ts");
  const { ToolRegistry } = await import("../tools/registry.ts");
  const { OpsLog } = await import("../obs/opslog.ts");
  const { sparkReader } = await import("../vision/models.ts");
  const { posterJpeg } = await import("../vision/test-frames.ts");
  const ledger = new Ledger();
  const lines: string[] = [];
  const usage: Record<string, { input_tokens: number; output_tokens: number }> = {
    "muse-wonder-1.0": { input_tokens: 1200, output_tokens: 40 },
    "muse-spark-1.3": { input_tokens: 90, output_tokens: 8 },
  };
  const muse = ledgerMuse(
    {
      responses: {
        create: async (p) =>
          p.instructions && String(p.instructions).startsWith("You read event posters")
            ? { id: "v", output: [], output_text: '{"title":"Demo night","date":null,"start":"18:00","place":"Room 214"}', usage: { input_tokens: 700, output_tokens: 30 } }
            : { id: "r", output: [], output_text: "Done.", usage: usage[String(p.model)] },
      },
    },
    ledger,
    new OpsLog({ write: (l) => lines.push(l) }),
  );
  await runCommand(
    { muse, tools: new ToolRegistry(), surfaces: new SurfaceRegistry(), log: new EventLog(), agentModel: "muse-wonder-1.0", fastModel: "muse-spark-1.3" },
    { session: "s", text: "What's next?" },
  );
  await sparkReader(muse).read(posterJpeg(), { question: "What event?", today: "2026-11-03" });

  const u = ledger.usage();
  assert.deepEqual([u.input, u.output, u.total, u.calls], [1990, 78, 2068, 3]);
  assert.deepEqual(u.by_model.map((m) => [m.model, m.calls, m.total]), [["muse-wonder-1.0", 1, 1240], ["muse-spark-1.3", 2, 828]]);
  assert.deepEqual(ledger.totals(), { input: 1990, output: 78, total: 2068 });
  const rows = ledger.list();
  assert.ok(rows.every((r) => r.tokensIn !== null && r.model), "every row carries its model and tokens");
  // One `usage` line per call in the ops log, with counts that survive redaction.
  const logged = lines.map((l) => JSON.parse(l)).filter((l) => l.event === "usage");
  assert.equal(logged.length, 3);
  assert.deepEqual(Object.keys(logged[0]).sort(), ["event", "input_tokens", "level", "model", "output_tokens", "service", "t", "total_tokens"]);
  assert.equal(logged.at(-1).total_tokens, 2068);
});

test("a call without usage, and a failed call, record no tokens", async () => {
  const ledger = new Ledger();
  await ledgerMuse({ responses: { create: async () => ({ id: "r", output: [] }) } }, ledger).responses.create({ model: "m" });
  await assert.rejects(ledgerMuse({ responses: { create: async () => { throw new Error("500"); } } }, ledger).responses.create({ model: "m" }));
  assert.deepEqual(ledger.list().map((r) => [r.status, r.tokensIn, r.tokensOut]), [["error", null, null], ["ok", null, null]]);
  assert.deepEqual([ledger.usage().calls, ledger.totals().total], [0, 0]);
});

test("Spark Open's tokens are counted too", async () => {
  const { sparkOpen } = await import("../memory/spark.ts");
  const ledger = new Ledger();
  const spark = sparkOpen({ client: { chat: { completions: { create: async () => ({ choices: [{ message: { content: "You moved office hours." } }], usage: { prompt_tokens: 300, completion_tokens: 12 } }) } } }, ledger });
  await spark.complete({ tool: "recap", system: "s", user: "u", maxTokens: 100 });
  assert.deepEqual(ledger.usage().by_model.map((m) => [m.service, m.model, m.input, m.output]), [["Baseten", "meta-models/muse-spark-open-1026", 300, 12]]);
});

test("an older ledger gains the token columns, and its rows read back without tokens", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { DatabaseSync } = await import("node:sqlite");
  const dir = mkdtempSync(join(tmpdir(), "auren-ledger-"));
  try {
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec("CREATE TABLE outbound (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, service TEXT NOT NULL, operation TEXT NOT NULL, status TEXT NOT NULL, ms INTEGER NOT NULL, bytes_out INTEGER NOT NULL)");
    old.prepare("INSERT INTO outbound (at, service, operation, status, ms, bytes_out) VALUES (1, 'Slack', 'POST chat.postMessage', 'ok', 80, 120)").run();
    old.close();
    const ledger = new Ledger(path);
    ledger.record({ service: "Meta Model API", operation: "responses.create muse-wonder-1.0", status: "ok", ms: 900, bytesOut: 2000, model: "muse-wonder-1.0", tokensIn: 50, tokensOut: 5 });
    const [fresh, kept] = ledger.list();
    assert.deepEqual([kept.service, kept.tokensIn, kept.model], ["Slack", null, null]);
    assert.deepEqual([fresh.tokensIn, fresh.tokensOut], [50, 5]);
    // And a reopened ledger starts from the stored totals.
    assert.equal(new Ledger(path).totals().total, 55);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
