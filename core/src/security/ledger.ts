// The outbound ledger: one row for every call that leaves this Mac (Meta's
// Model API, Google, Slack). Service, operation, size and timing only, never
// contents, so you can see exactly what crossed the edge and when.
import { DatabaseSync } from "node:sqlite";
import type { MuseLike } from "../agent/loop.ts";

export interface OutboundCall {
  service: string;
  operation: string;
  status: "ok" | "error";
  ms: number;
  bytesOut: number;
}

export interface LedgerRow extends OutboundCall {
  id: number;
  at: number;
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
  }

  record(c: OutboundCall): void {
    this.#db
      .prepare("INSERT INTO outbound (at, service, operation, status, ms, bytes_out) VALUES (?, ?, ?, ?, ?, ?)")
      .run(Date.now(), c.service, c.operation, c.status, Math.round(c.ms), c.bytesOut);
  }

  list(limit = 50): LedgerRow[] {
    const rows = this.#db.prepare("SELECT * FROM outbound ORDER BY id DESC LIMIT ?").all(limit) as Array<Record<string, number | string>>;
    return rows.map((r) => ({
      id: Number(r.id),
      at: Number(r.at),
      service: String(r.service),
      operation: String(r.operation),
      status: r.status === "ok" ? "ok" : "error",
      ms: Number(r.ms),
      bytesOut: Number(r.bytes_out),
    }));
  }

  summary(): Array<{ service: string; calls: number; bytesOut: number; lastAt: number }> {
    const rows = this.#db
      .prepare("SELECT service, COUNT(*) AS calls, SUM(bytes_out) AS bytes, MAX(at) AS last FROM outbound GROUP BY service ORDER BY last DESC")
      .all() as Array<{ service: string; calls: number; bytes: number; last: number }>;
    return rows.map((r) => ({ service: r.service, calls: Number(r.calls), bytesOut: Number(r.bytes), lastAt: Number(r.last) }));
  }
}

/** Wraps the Muse client so every model request lands in the ledger. */
export function ledgerMuse(muse: MuseLike, ledger: Ledger): MuseLike {
  return {
    responses: {
      async create(params) {
        const t0 = performance.now();
        const call = { service: "Meta Model API", operation: `responses.create ${String(params.model ?? "")}`.trim(), bytesOut: Buffer.byteLength(JSON.stringify(params)) };
        try {
          const res = await muse.responses.create(params);
          ledger.record({ ...call, status: "ok", ms: performance.now() - t0 });
          return res;
        } catch (err) {
          ledger.record({ ...call, status: "error", ms: performance.now() - t0 });
          throw err;
        }
      },
    },
  };
}
