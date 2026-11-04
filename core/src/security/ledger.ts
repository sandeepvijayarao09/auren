// The outbound ledger: one row for every call that leaves this Mac (Meta's
// Model API, Google, Slack). Service, operation, size and timing only, never
// contents, so you can see exactly what crossed the edge and when.
// R13: model calls also carry their token counts, so usage and the spend limits have one source.
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { MuseLike } from "../agent/loop.ts";
import type { OpsLog } from "../obs/opslog.ts";

export interface OutboundCall {
  service: string;
  operation: string;
  status: "ok" | "error";
  ms: number;
  bytesOut: number;
  // R13: for model calls, the model and the tokens the provider reported in `usage`.
  model?: string | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
}

export interface LedgerRow extends OutboundCall {
  id: number;
  at: number;
}

// R13: token totals, overall and per model.
export interface TokenTotals {
  input: number;
  output: number;
  total: number;
}
export interface Usage extends TokenTotals {
  /** Model calls that reported usage. */
  calls: number;
  by_model: Array<TokenTotals & { service: string; model: string; calls: number }>;
}

/** "/calendar/v3/calendars/primary/events/3k9x…" → "/calendar/v3/calendars/primary/events/:id" */
export function pathTemplate(url: string): string {
  try {
    return new URL(url).pathname
      .split("/")
      .map((seg) => (/^[A-Za-z0-9_-]{16,}$/.test(seg) || /\d{4,}/.test(seg) ? ":id" : seg))
      .join("/");
  } catch {
    return "?";
  }
}

export class Ledger {
  #db: DatabaseSync;

  // R13: running token totals (read once from the table), and who to tell when they grow.
  #totals: TokenTotals = { input: 0, output: 0, total: 0 };
  #onUsage: Array<(totals: TokenTotals) => void> = [];

  constructor(path = ":memory:") {
    this.#db = new DatabaseSync(path);
    this.#db.exec(`CREATE TABLE IF NOT EXISTS outbound (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at INTEGER NOT NULL,
      service TEXT NOT NULL,
      operation TEXT NOT NULL,
      status TEXT NOT NULL,
      ms INTEGER NOT NULL,
      bytes_out INTEGER NOT NULL
    )`);
    // R13: additive migration. Older ledgers gain the columns; their rows read back with no tokens.
    const cols = new Set((this.#db.prepare("PRAGMA table_info(outbound)").all() as Array<{ name: string }>).map((c) => c.name));
    for (const [col, type] of [["model", "TEXT"], ["tokens_in", "INTEGER"], ["tokens_out", "INTEGER"]]) {
      if (!cols.has(col)) this.#db.exec(`ALTER TABLE outbound ADD COLUMN ${col} ${type}`);
    }
    const t = this.#db.prepare("SELECT COALESCE(SUM(tokens_in), 0) AS i, COALESCE(SUM(tokens_out), 0) AS o FROM outbound").get() as { i: number; o: number };
    this.#totals = { input: Number(t.i), output: Number(t.o), total: Number(t.i) + Number(t.o) };
  }

  record(c: OutboundCall): void {
    const tokensIn = c.tokensIn ?? null;
    const tokensOut = c.tokensOut ?? null;
    this.#db
      .prepare("INSERT INTO outbound (at, service, operation, status, ms, bytes_out, model, tokens_in, tokens_out) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), c.service, c.operation, c.status, Math.round(c.ms), c.bytesOut, c.model ?? null, tokensIn, tokensOut);
    if (tokensIn === null && tokensOut === null) return;
    this.#totals = { input: this.#totals.input + (tokensIn ?? 0), output: this.#totals.output + (tokensOut ?? 0), total: this.#totals.total + (tokensIn ?? 0) + (tokensOut ?? 0) };
    for (const fn of this.#onUsage) fn(this.#totals);
  }

  // ── R13: token usage ──────────────────────────────────────────────────
  /** Every token recorded in this ledger. Cheap: kept in memory. */
  totals(): TokenTotals {
    return { ...this.#totals };
  }

  /** Totals, and the same per service and model, for /v1/trust. */
  usage(): Usage {
    const rows = this.#db
      .prepare(`SELECT service, COALESCE(model, '') AS model, COUNT(*) AS calls, COALESCE(SUM(tokens_in), 0) AS i, COALESCE(SUM(tokens_out), 0) AS o
        FROM outbound WHERE tokens_in IS NOT NULL OR tokens_out IS NOT NULL GROUP BY service, model ORDER BY (i + o) DESC`)
      .all() as Array<{ service: string; model: string; calls: number; i: number; o: number }>;
    const by_model = rows.map((r) => ({ service: r.service, model: r.model, calls: Number(r.calls), input: Number(r.i), output: Number(r.o), total: Number(r.i) + Number(r.o) }));
    return { ...this.totals(), calls: by_model.reduce((n, r) => n + r.calls, 0), by_model };
  }

  /** Called with the new totals after every call that reported tokens. */
  onUsage(fn: (totals: TokenTotals) => void): void {
    this.#onUsage.push(fn);
  }

  list(limit = 50): LedgerRow[] {
    const rows = this.#db.prepare("SELECT * FROM outbound ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, number | string | null>>;
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      service: String(r.service),
      operation: String(r.operation),
      status: r.status === "ok" ? "ok" : "error",
      ms: Number(r.ms),
      bytesOut: Number(r.bytes_out),
      model: r.model == null ? null : String(r.model),
      tokensIn: r.tokens_in == null ? null : Number(r.tokens_in),
      tokensOut: r.tokens_out == null ? null : Number(r.tokens_out),
    }));
  }

  summary(): Array<{ service: string; calls: number; bytesOut: number; lastAt: number }> {
    const rows = this.#db
      .prepare("SELECT service, COUNT(*) AS calls, SUM(bytes_out) AS bytes, MAX(at) AS last FROM outbound GROUP BY service ORDER BY last DESC")
      .all() as Array<{ service: string; calls: number; bytes: number; last: number }>;
    return rows.map((r) => ({ service: r.service, calls: Number(r.calls), bytesOut: Number(r.bytes), lastAt: Number(r.last) }));
  }
}

// R13: what a provider reports in `usage`. Responses API names, with the chat-completions names as a fallback.
const UsageShape = z
  .object({
    input_tokens: z.number().int().nonnegative().optional(),
    output_tokens: z.number().int().nonnegative().optional(),
    prompt_tokens: z.number().int().nonnegative().optional(),
    completion_tokens: z.number().int().nonnegative().optional(),
  })
  .nullish()
  .catch(null);

/** The tokens in a model response's `usage`, or null when it reported none. */
export function tokensOf(usage: unknown): { input: number; output: number } | null {
  const u = UsageShape.parse(usage);
  const input = u?.input_tokens ?? u?.prompt_tokens;
  const output = u?.output_tokens ?? u?.completion_tokens;
  return input === undefined && output === undefined ? null : { input: input ?? 0, output: output ?? 0 };
}

/**
 * Wraps the Muse client so every model request lands in the ledger. Every model call in Core goes
 * through here (the agent loop, the fast ack, vision, computer use), so R13 counts tokens here too,
 * with one `usage` line per call in the ops log.
 */
export function ledgerMuse(muse: MuseLike, ledger: Ledger, ops?: OpsLog): MuseLike {
  return {
    responses: {
      async create(params) {
        const t0 = performance.now();
        const model = String(params.model ?? "");
        const call = { service: "Meta Model API", operation: `responses.create ${model}`.trim(), bytesOut: Buffer.byteLength(JSON.stringify(params)), model: model || null };
        try {
          const res = await muse.responses.create(params);
          const tokens = tokensOf(res?.usage);
          ledger.record({ ...call, status: "ok", ms: performance.now() - t0, tokensIn: tokens?.input ?? null, tokensOut: tokens?.output ?? null });
          if (tokens) ops?.info("usage", { service: call.service, model, input_tokens: tokens.input, output_tokens: tokens.output, total_tokens: ledger.totals().total });
          return res;
        } catch (err) {
          ledger.record({ ...call, status: "error", ms: performance.now() - t0 });
          throw err;
        }
      },
    },
  };
}
