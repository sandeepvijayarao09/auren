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
