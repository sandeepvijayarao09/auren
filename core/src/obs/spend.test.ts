// R13: the token alarm and limit, alone and through Core's HTTP routes.
import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { serve } from "@hono/node-server";
import type { MuseLike } from "../agent/loop.ts";
import { EventLog } from "../eventlog.ts";
import { Ledger, ledgerMuse } from "../security/ledger.ts";
import { createServer, SESSION } from "../server.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { OpsLog } from "./opslog.ts";
import { SpendGuard, type SpendEvent } from "./spend.ts";

const model = (tokensIn: number, tokensOut = 0) => ({ service: "Meta Model API", operation: "responses.create muse-wonder-1.0", status: "ok" as const, ms: 5, bytesOut: 10, model: "muse-wonder-1.0", tokensIn, tokensOut });

test("the alarm fires once, and the limit refuses new commands", () => {
  const ledger = new Ledger();
  const lines: string[] = [];
  const crossed: SpendEvent[] = [];
  const spend = new SpendGuard(ledger, { alarm: 1000, limit: 2000, ops: new OpsLog({ write: (l) => lines.push(l) }), onCross: (e) => crossed.push(e) });
  ledger.record(model(600, 100));
  assert.deepEqual([crossed.length, spend.refusal()], [0, null]);
  ledger.record(model(300, 50)); // 1,050: past the alarm
  ledger.record(model(100)); // still past it: no second alarm
  ledger.record({ service: "Google", operation: "GET /calendar", status: "ok", ms: 3, bytesOut: 0 }); // no tokens
  assert.deepEqual(crossed.map((e) => [e.level, e.tokens]), [["alarm", 1050]]);
  assert.match(crossed[0].message, /^Token alarm: Auren has used 1,050 model tokens, past AUREN_TOKEN_ALARM \(1,000\)/);
  assert.equal(spend.refusal(), null, "the alarm only warns");
  ledger.record(model(900)); // 2,050: the limit
  assert.deepEqual(crossed.map((e) => e.level), ["alarm", "limit"]);
  assert.match(spend.refusal() ?? "", /^Token limit reached: Auren has used 2,050 of AUREN_TOKEN_LIMIT \(2,000\)/);
  const events = lines.map((l) => JSON.parse(l));
  assert.deepEqual(events.map((e) => [e.level, e.event, e.total_tokens]), [["warn", "usage.alarm", 1050], ["error", "usage.limit", 2050]]);
  const status = spend.status();
  assert.deepEqual([status.total, status.alarmed, status.limited, status.alarm, status.limit], [2050, true, true, 1000, 2000]);
});

test("a ledger already past its lines at start-up doesn't announce them again, and 0 turns them off", () => {
  const ledger = new Ledger();
  ledger.record(model(5000));
  const crossed: SpendEvent[] = [];
  const spend = new SpendGuard(ledger, { alarm: 1000, limit: 4000, onCross: (e) => crossed.push(e) });
  ledger.record(model(10));
  assert.equal(crossed.length, 0);
  assert.ok(spend.refusal(), "but the limit still holds");
  const off = new SpendGuard(new Ledger(), { alarm: 0, limit: 0 });
  assert.deepEqual([off.refusal(), off.status().alarm, off.status().limit], [null, null, null]);
});

test("at the limit, Core refuses new commands with a clear error, while a tap already waiting still resolves", async () => {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry({ onEvent: (kind, data) => log.append(SESSION, kind, data) });
  const tools = new ToolRegistry().add(...createDemoWorld().namespaces);
  const ledger = new Ledger();
  const spend = new SpendGuard(ledger, { alarm: 200, limit: 500, onCross: (e) => log.append(SESSION, "usage", { ...e }) });
  // One turn that asks to post (and spends 600 tokens), then the closing sentence.
  let turn = 0;
  const fake: MuseLike = {
    responses: {
      async create() {
        return turn++ === 0
          ? { id: "r1", usage: { input_tokens: 580, output_tokens: 20 }, output: [{ type: "function_call", call_id: "c1", namespace: "slack", name: "post_message", arguments: JSON.stringify({ channel_id: "C01", text: "Running late." }) }] }
          : { id: "r2", usage: { input_tokens: 40, output_tokens: 5 }, output: [], output_text: "Posted." };
      },
    },
  };
  const core = createServer({ muse: ledgerMuse(fake, ledger), tools, surfaces, log, agentModel: "muse-wonder-1.0" }, { token: "", museReady: true, ledger, spend });
  const http = serve({ fetch: core.app.fetch, port: 0, hostname: "127.0.0.1" });
  await once(http, "listening");
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  surfaces.join({ id: "web", kind: "web", name: "console", inputs: ["text", "touch"], outputs: ["screen"] }, () => {});
  try {
    assert.equal((await post("/v1/command", { text: "Tell office hours I'm late" })).status, 202);
    // The model's first turn crossed the alarm and the limit; the post now waits for a tap.
    const asked = await waitFor(() => log.since(SESSION).find((e) => e.kind === "approval" && e.data.status === "requested"));
    const usage = log.since(SESSION).filter((e) => e.kind === "usage").map((e) => e.data.level);
    assert.deepEqual(usage, ["alarm", "limit"]);

    const refused = await post("/v1/command", { text: "And tell #general too" });
    assert.equal(refused.status, 429);
    assert.match((await refused.json()).error, /^Token limit reached/);
    assert.match(String(log.since(SESSION).filter((e) => e.kind === "error").at(-1)?.data.message), /^Token limit reached/);

    // The tap already waiting still goes through, and so does the rest of that command.
    assert.equal((await post(`/v1/approvals/${asked.data.request_id}`, { approved: true })).status, 200);
    await waitFor(() => log.since(SESSION).find((e) => e.kind === "reply"));
    assert.ok(log.since(SESSION).some((e) => e.kind === "receipt" && e.data.tool === "post_message"));

    const trust = await (await fetch(`${base}/v1/trust`)).json();
    assert.deepEqual([trust.usage.total, trust.usage.limited, trust.usage.by_model[0].model, trust.usage.by_model[0].calls], [645, true, "muse-wonder-1.0", 2]);
  } finally {
    core.close();
    http.close();
  }
});

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
