// Live bake-off of Muse models as the router ("Muse decisions"). Sends Core's exact
// router request (SYSTEM instructions, renderUser input, max_output_tokens 400) to the
// Responses API, with reasoning {effort: <mode>}, or no reasoning field for mode "omit".
// Usage: node --env-file=../.env src/router/bakeoff.ts [--models a,b] [--modes minimal,none] [--limit N] [--out file.json]
// Never prints the key; writes per-config summaries (and per-example rows) as JSON.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { renderUser, SYSTEM, type RouteContext } from "./prompt.ts";
import { parseRoute, SPARK_BUDGET_MS, type Route } from "./router.ts";

const { values: args } = parseArgs({
  options: {
    models: { type: "string", default: "muse-spark-1.3,muse-spark-1.2,muse-spark-1.1,muse-spark-1.3-contributor,muse-spark-1.2-contributor" },
    modes: { type: "string", default: "minimal,omit" },
    limit: { type: "string", default: "0" },
    concurrency: { type: "string", default: "4" },
    out: { type: "string", default: "bakeoff.json" },
  },
});

const base = (process.env.MUSE_BASE_URL ?? "https://api.meta.ai/v1").replace(/\/+$/, "");
const key = process.env.MODEL_API_KEY ?? "";
if (!key) throw new Error("MODEL_API_KEY is not set");

interface Example { text: string; context: RouteContext; label: Route }
const seed: Example[] = readFileSync(new URL("../../../router/seed/seed.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
// An evenly spread subset when --limit is set, so it still covers every kind of command.
const limit = Number(args.limit);
const examples = limit > 0 ? Array.from({ length: limit }, (_, i) => seed[Math.floor((i * seed.length) / limit)]) : seed;

const FIELDS = ["apps", "risk_tier", "reply_surface", "needs_vision"] as const;

function outputText(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text) return resp.output_text;
  const parts: string[] = [];
  for (const item of resp?.output ?? []) if (item.type === "message") for (const c of item.content ?? []) if (c.type === "output_text" && c.text) parts.push(c.text);
  return parts.join("");
}

interface Row { i: number; ms: number; ok: boolean; err?: string; hits?: Record<string, boolean>; out: number; reasoning: number; input: number; status?: string }

async function one(model: string, mode: string, ex: Example, i: number): Promise<Row> {
  const body: Record<string, unknown> = { model, instructions: SYSTEM, input: renderUser(ex.text, ex.context), max_output_tokens: 400 };
  if (mode !== "omit") body.reasoning = { effort: mode };
  const t0 = performance.now();
  try {
    const res = await fetch(`${base}/responses`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const ms = performance.now() - t0;
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) return { i, ms, ok: false, err: `http ${res.status}: ${String(json?.error?.message ?? "").slice(0, 160)}`, out: 0, reasoning: 0, input: 0 };
    const u = json.usage ?? {};
    const row: Row = { i, ms, ok: false, out: u.output_tokens ?? 0, reasoning: u.output_tokens_details?.reasoning_tokens ?? 0, input: u.input_tokens ?? 0, status: json.status };
    try {
      const pred = parseRoute(outputText(json));
      const gold = ex.label;
      row.ok = true;
      row.hits = {
        apps: JSON.stringify(pred.apps) === JSON.stringify(gold.apps),
        risk_tier: pred.risk_tier === gold.risk_tier,
        reply_surface: pred.reply_surface === gold.reply_surface,
        needs_vision: pred.needs_vision === gold.needs_vision,
      };
    } catch {
      row.err = "parse";
    }
    return row;
  } catch (e) {
    return { i, ms: performance.now() - t0, ok: false, err: (e as Error).name, out: 0, reasoning: 0, input: 0 };
  }
}

async function pool<T>(n: number, jobs: Array<() => Promise<T>>): Promise<T[]> {
  const out: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < jobs.length) { const j = next++; out[j] = await jobs[j](); } }));
  return out;
}

const pct = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]; };
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function summarise(model: string, mode: string, rows: Row[]) {
  const answered = rows.filter((r) => !r.err || r.err === "parse");
  const http = rows.filter((r) => r.err && r.err !== "parse");
  const n = rows.length;
  const acc = Object.fromEntries(FIELDS.map((f) => [f, rows.filter((r) => r.hits?.[f]).length / n]));
  const exact = rows.filter((r) => r.hits && FIELDS.every((f) => r.hits![f])).length / n;
  const ms = answered.map((r) => r.ms);
  return {
    model, mode, n,
    http_errors: http.length, first_error: http[0]?.err,
    parse_fail: rows.filter((r) => r.err === "parse").length / Math.max(1, answered.length),
    acc, exact,
    // Usable in Core: answered, parsed and inside the router budget.
    under_budget: rows.filter((r) => r.ok && r.ms < SPARK_BUDGET_MS).length / n,
    p50: pct(ms, 0.5), p95: pct(ms, 0.95),
    mean_out: mean(answered.map((r) => r.out)), mean_reasoning: mean(answered.map((r) => r.reasoning)), mean_in: mean(answered.map((r) => r.input)),
    rows,
  };
}

const configs = args.models!.split(",").flatMap((m) => args.modes!.split(",").map((mode) => [m, mode] as const));
// Configs run side by side, each with its own pool of `concurrency` requests.
const results = await Promise.all(
  configs.map(async ([model, mode]) => {
    const rows = await pool(Number(args.concurrency), examples.map((ex, i) => () => one(model, mode, ex, i)));
    const s = summarise(model, mode, rows);
    console.log(`${model} ${mode}: exact ${(s.exact * 100).toFixed(1)}% p50 ${s.p50?.toFixed(0)} p95 ${s.p95?.toFixed(0)} <2.5s ${(s.under_budget * 100).toFixed(0)}% parse_fail ${(s.parse_fail * 100).toFixed(1)}% http_err ${s.http_errors}${s.first_error ? ` (${s.first_error})` : ""} out ${s.mean_out.toFixed(0)} (reasoning ${s.mean_reasoning.toFixed(0)})`);
    return s;
  }),
);
writeFileSync(args.out!, JSON.stringify(results, null, 2));
