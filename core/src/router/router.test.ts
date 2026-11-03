// The Auren Router: the schema and prompt it shares with router/ (Python), the
// Glimmer → Spark → rules fallback with a fake endpoint, and the rules themselves.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { MuseLike } from "../agent/loop.ts";
import { OpsLog } from "../obs/opslog.ts";
import { Ledger, ledgerMuse } from "../security/ledger.ts";
import { renderUser, routerMessages, stripFences, SYSTEM, type RouteContext } from "./prompt.ts";
import { ackFor, APPS, createRouter, parseRoute, rulesRoute, SURFACES, TIERS, type Route } from "./router.ts";

const ROUTER_DIR = new URL("../../../router/", import.meta.url);

// The same two goldens are in router/tests/test_prompt.py. A changed prompt is a
// different model, so both suites have to change together.
const GOLDEN_SYSTEM_SHA256 = "21f6664c5582ef8132a9caa90726d72cd122366b43cebe1fbe17a0a068286de1";
const GOLDEN_USER = [
  "Command: I'm running 15 late. Tell office hours, push my 3 PM, and draft a reply to Prof. Lee.",
  "Spoken into: watch",
  "Devices online:",
  "- watch (active): in voice, text, touch; out voice, screen, haptic",
  "- phone: in voice, text, camera, touch; out voice, screen",
  "- web: in text, touch; out voice, screen",
].join("\n");
const GP1_TEXT = "I'm running 15 late.  Tell office hours, push my 3 PM,\n and draft a reply to Prof. Lee.";
const GP1_CONTEXT: RouteContext = {
  origin: "watch",
  devices: [
    { kind: "web", inputs: ["touch", "text"], outputs: ["voice", "screen"], active: false },
    { kind: "watch", inputs: ["voice", "text", "touch"], outputs: ["voice", "haptic", "screen"], active: true },
    { kind: "phone", inputs: ["voice", "text", "touch", "camera"], outputs: ["voice", "screen"], active: false },
  ],
};
const GP1: Route = { apps: ["slack", "calendar", "gmail"], risk_tier: "send", reply_surface: "watch", needs_vision: false };

type Device = Omit<RouteContext["devices"][number], "active">;
const W: Device = { kind: "watch", inputs: ["voice", "text", "touch"], outputs: ["voice", "haptic", "screen"] };
const G: Device = { kind: "glasses", inputs: ["voice", "camera"], outputs: ["voice"] };
const P: Device = { kind: "phone", inputs: ["voice", "text", "touch", "camera"], outputs: ["voice", "screen"] };
const M: Device = { kind: "web", inputs: ["text", "touch"], outputs: ["screen", "voice"] };
/** A context whose first device is the active one. */
const ctx = (origin: RouteContext["origin"], ...devices: Device[]): RouteContext => ({
  origin,
  devices: devices.map((d, i) => ({ kind: d.kind, inputs: [...d.inputs], outputs: [...d.outputs], active: i === 0 })),
});

// ── shared with router/ ─────────────────────────────────────────────────────

test("Route mirrors schema.py: the same apps, tiers and surfaces, in the same order", () => {
  const py = readFileSync(new URL("auren_router/schema.py", ROUTER_DIR), "utf8");
  const tuple = (name: string) => [...py.match(new RegExp(`^${name} = \\(([^)]*)\\)`, "m"))![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tuple("APPS"), [...APPS]);
  assert.deepEqual(tuple("TIERS"), [...TIERS]);
  assert.deepEqual(tuple("SURFACES"), [...SURFACES]);
});

test("Route accepts and rejects exactly what parse() does (router/tests/parity.json)", () => {
  const cases = JSON.parse(readFileSync(new URL("tests/parity.json", ROUTER_DIR), "utf8")) as { valid: Array<{ text: string; apps: string[] }>; invalid: string[] };
  for (const c of cases.valid) assert.deepEqual(parseRoute(c.text).apps, c.apps, c.text);
  for (const text of cases.invalid) assert.throws(() => parseRoute(text), Error, text);
  // Every seed label is a valid Route too.
  const seed = readFileSync(new URL("seed/seed.jsonl", ROUTER_DIR), "utf8").trim().split("\n");
  for (const line of seed) parseRoute(JSON.stringify(JSON.parse(line).label));
});

test("the prompt is the one the router was trained on (golden, shared with test_prompt.py)", () => {
  assert.equal(createHash("sha256").update(SYSTEM).digest("hex"), GOLDEN_SYSTEM_SHA256);
  assert.equal(renderUser(GP1_TEXT, GP1_CONTEXT), GOLDEN_USER);
  assert.deepEqual(routerMessages(GP1_TEXT, GP1_CONTEXT).map((m) => m.role), ["system", "user"]);
  assert.equal(renderUser("hi", { origin: null, devices: [] }), "Command: hi\nSpoken into: none\nDevices online: none");
  assert.equal(stripFences('```json\n{"a":1}\n```'), '{"a":1}');
});

// ── Glimmer, then Spark, then rules ───────────────────────────────────────────

function opsLines() {
  const lines: Array<Record<string, any>> = [];
  return { ops: new OpsLog({ write: (l) => lines.push(JSON.parse(l)) }), lines };
}

/** A fake OpenAI-compatible endpoint. `answer` can be slow, ignore the abort, or fail. */
function fakeEndpoint(answer: (signal: AbortSignal) => Promise<Response>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return answer(init.signal!);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const completion = (content: string, status = 200) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), { status });

function sparkMuse(text: string | Error, delayMs = 0) {
  const requests: Array<Record<string, any>> = [];
  const muse: MuseLike = {
    responses: {
      async create(params) {
        requests.push(params);
        await new Promise((r) => setTimeout(r, delayMs));
        if (text instanceof Error) throw text;
        return { output_text: text };
      },
    },
  };
  return { muse, requests };
}

test("Glimmer answers within budget: Core's prompt goes out, the route comes back, one ledger row, no text in the ops log", async () => {
  const { fetch, calls } = fakeEndpoint(async () => completion(JSON.stringify(GP1)));
  const { ops, lines } = opsLines();
  const ledger = new Ledger();
  const router = createRouter({ url: "https://router.example.test/v1/", key: "rk-test", model: "auren-router", namespaces: () => [...APPS], fetch, ledger, ops });

  const routed = await router.route(GP1_TEXT, GP1_CONTEXT, "t1");
  assert.equal(routed.source, "glimmer");
  assert.deepEqual(routed.route, GP1);
  assert.equal(router.holdMs, 300);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://router.example.test/v1/chat/completions");
  assert.equal(calls[0].headers.authorization, "Bearer rk-test");
  assert.deepEqual(calls[0].body, { model: "auren-router", messages: routerMessages(GP1_TEXT, GP1_CONTEXT), temperature: 0, max_tokens: 64 });

  assert.deepEqual(ledger.list().map((r) => [r.service, r.operation, r.status]), [["Auren Router", "chat.completions router.example.test", "ok"]]);
  assert.deepEqual(lines.map((l) => [l.event, l.source, l.ok, l.trace]), [["router.route", "glimmer", true, "t1"]]);
  assert.equal(typeof lines[0].ms, "number");
  const logged = JSON.stringify(lines);
  for (const word of ["running", "office hours", "Prof. Lee"]) assert.ok(!logged.includes(word), `ops log never carries the command (${word})`);
});

test("Glimmer over budget: aborted at the deadline, then Muse Spark routes (and lands in the ledger)", async () => {
  // This endpoint never answers unless aborted.
  const { fetch } = fakeEndpoint((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const { ops, lines } = opsLines();
  const ledger = new Ledger();
  const spark = sparkMuse('```json\n{"apps":["slack","calendar","gmail"],"risk_tier":"send","reply_surface":"watch","needs_vision":false}\n```');
  const router = createRouter({ url: "https://router.example.test/v1", budgetMs: 40, muse: ledgerMuse(spark.muse, ledger), sparkModel: "muse-spark-1.3", namespaces: () => [...APPS], fetch, ledger, ops });

  const t0 = performance.now();
  const routed = await router.route(GP1_TEXT, GP1_CONTEXT);
  assert.ok(performance.now() - t0 < 400, "the 40 ms budget held");
  assert.equal(routed.source, "spark");
  assert.deepEqual(routed.route, GP1);
  assert.deepEqual(lines.map((l) => [l.source, l.ok, l.reason ?? null]), [["glimmer", false, "timeout"], ["spark", true, null]]);
  // Spark got the same prompt as Glimmer, through the Responses API, at minimal effort.
  assert.equal(spark.requests[0].instructions, SYSTEM);
  assert.equal(spark.requests[0].input, renderUser(GP1_TEXT, GP1_CONTEXT));
  assert.deepEqual(spark.requests[0].reasoning, { effort: "minimal" });
  assert.deepEqual(ledger.list().map((r) => [r.service, r.status]).reverse(), [["Auren Router", "error"], ["Meta Model API", "ok"]]);
});

test("an endpoint that ignores the abort still can't hold Core past the budget", async () => {
  const { fetch } = fakeEndpoint(() => new Promise((r) => setTimeout(() => r(completion(JSON.stringify(GP1))), 300)));
  const router = createRouter({ url: "https://router.example.test/v1", budgetMs: 30, namespaces: () => [...APPS], fetch });
  const t0 = performance.now();
  const routed = await router.route(GP1_TEXT, GP1_CONTEXT);
  assert.ok(performance.now() - t0 < 200);
  assert.equal(routed.source, "rules", "no key, so no Spark: straight to the rules");
});

test("off-schema or failed answers fall back: bad JSON, an unknown app, an extra field, HTTP 500, a slow or broken Spark", async () => {
  const bad: Array<[string, () => Promise<Response>, string]> = [
    ["prose", async () => completion("Sure! Slack and calendar."), "bad_output"],
    ["unknown app", async () => completion('{"apps":["venmo"],"risk_tier":"send","reply_surface":"watch","needs_vision":false}'), "bad_output"],
    ["a tier grant", async () => completion('{"apps":["slack"],"risk_tier":"read","reply_surface":"watch","needs_vision":false,"grant":"send"}'), "bad_output"],
    ["no choices", async () => new Response("{}", { status: 200 }), "bad_output"],
    ["HTTP 500", async () => completion("{}", 500), "http 500"],
    ["network", async () => Promise.reject(new TypeError("fetch failed")), "network"],
  ];
  for (const [name, answer, reason] of bad) {
    const { ops, lines } = opsLines();
    const router = createRouter({ url: "https://router.example.test/v1", namespaces: () => [...APPS], fetch: fakeEndpoint(answer).fetch, ops });
    const routed = await router.route(GP1_TEXT, GP1_CONTEXT);
    assert.equal(routed.source, "rules", name);
    assert.deepEqual(lines.map((l) => [l.source, l.ok, l.reason ?? null]), [["glimmer", false, reason], ["rules", true, null]], name);
  }
  for (const [name, spark] of [["slow", sparkMuse(JSON.stringify(GP1), 200)], ["off-schema", sparkMuse("calendar, I think")], ["error", sparkMuse(new Error("429"))]] as const) {
    const router = createRouter({ muse: spark.muse, sparkModel: "muse-spark-1.3", sparkBudgetMs: 50, namespaces: () => [...APPS] });
    assert.equal(router.holdMs, 0, "without Glimmer, Wonder never waits on the router");
    assert.equal((await router.route(GP1_TEXT, GP1_CONTEXT)).source, "rules", name);
  }
});

// ── the rules ─────────────────────────────────────────────────────────────────

test("rules: the golden paths", () => {
  const all = [...APPS];
  assert.deepEqual(rulesRoute(GP1_TEXT, GP1_CONTEXT, all), GP1);
  assert.deepEqual(rulesRoute("Add this, and invite Priya.", ctx("glasses", G, W), all), { apps: ["glasses", "calendar"], risk_tier: "send", reply_surface: "glasses", needs_vision: true });
  assert.deepEqual(rulesRoute("What did I get done today?", ctx("web", M), all), { apps: ["memory"], risk_tier: "read", reply_surface: "web", needs_vision: false });
  assert.deepEqual(rulesRoute("Undo the calendar move.", ctx("web", M), all), { apps: ["receipts"], risk_tier: "write", reply_surface: "web", needs_vision: false });
  assert.deepEqual(rulesRoute("Find a table for two near there at 8 and hold it.", ctx("phone", P, M), all), { apps: ["browser"], risk_tier: "send", reply_surface: "phone", needs_vision: false });
});

test("rules: \"this\" needs a camera online, and time words and \"that's\" aren't pointing at anything", () => {
  const all = [...APPS];
  const blind = rulesRoute("Add this, and invite Priya.", ctx("watch", W, M), all);
  assert.equal(blind.needs_vision, false);
  assert.deepEqual(blind.apps, ["calendar"]);
  for (const text of ["What did I tell office hours this morning?", "Thanks, that's all.", "Delete that draft to Prof. Lee.", "How many emails did Prof. Lee send this week?", "Find a cafe near here."]) {
    const r = rulesRoute(text, ctx("glasses", G, P), all);
    assert.equal(r.needs_vision, false, text);
    assert.ok(!r.apps.includes("glasses"), text);
  }
  assert.deepEqual(rulesRoute("What did I tell office hours this morning?", ctx("watch", W, P), all).apps, ["memory"], "recall, not a Slack post");
  assert.equal(rulesRoute("How many emails did Prof. Lee send this week?", ctx("web", M), all).risk_tier, "read", "a question about sending is a read");
});

test("rules: the reply goes where the rubric says, and only registered namespaces are named", () => {
  const all = [...APPS];
  const screenOnly: Device = { kind: "web", inputs: ["text", "touch"], outputs: ["screen"] };
  const typed = ctx("web", screenOnly, W);
  typed.devices[0].active = false;
  typed.devices[1].active = true;
  assert.equal(rulesRoute("What's on my calendar today?", typed, all).reply_surface, "watch", "no voice out: the active voice device");
  assert.equal(rulesRoute("Show me my week.", ctx("watch", W, P), all).reply_surface, "phone", "visual: the phone");
  assert.equal(rulesRoute("Show me my week.", ctx("glasses", G, W), all).reply_surface, "glasses", "no phone: stay put");
  const api = ctx(null, M, W);
  api.devices[0].active = false;
  api.devices[1].active = true;
  assert.equal(rulesRoute("What's my first meeting?", api, all).reply_surface, "watch", "typed into the API: the active voice device");
  assert.deepEqual(rulesRoute("Book a table for two at 7 and add it to my calendar.", ctx("phone", P), ["calendar", "slack", "gmail"]).apps, ["calendar"], "no browser registered");
});

test("rules: at least 85% exact on the hand-written seed (written alongside it, so an upper bound, not a held-out score)", () => {
  const rows = readFileSync(new URL("seed/seed.jsonl", ROUTER_DIR), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const exact = rows.filter((r) => JSON.stringify(rulesRoute(r.text, r.context, [...APPS])) === JSON.stringify(parseRoute(JSON.stringify(r.label)))).length;
  assert.ok(exact / rows.length >= 0.85, `${exact} of ${rows.length}`);
});

test("the ack a route implies", () => {
  assert.equal(ackFor(GP1, false), "On it: Slack, calendar and Gmail.");
  assert.equal(ackFor({ apps: ["calendar"], risk_tier: "read", reply_surface: "watch", needs_vision: false }, false), "Checking calendar.");
  assert.equal(ackFor({ apps: ["glasses", "calendar"], risk_tier: "send", reply_surface: "glasses", needs_vision: true }, true), "Looking now, then calendar.");
  assert.equal(ackFor({ apps: ["glasses", "calendar"], risk_tier: "send", reply_surface: "glasses", needs_vision: true }, false), "On it: calendar.", "no camera, no promise to look");
  assert.equal(ackFor({ apps: [], risk_tier: "read", reply_surface: "web", needs_vision: false }, true), null);
});
