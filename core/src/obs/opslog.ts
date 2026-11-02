// The operational log: one JSON line per step, with a trace id per command,
// for debugging and the README numbers. It never carries tokens, keys or
// message bodies; `redact` scrubs anything that slips in.
import { appendFileSync } from "node:fs";

const SENSITIVE_KEY = /token|secret|password|passwd|authorization|api[_-]?key|cookie|verifier|credential/i;
const SENSITIVE_VALUE: RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/g,
  /\bya29\.[A-Za-z0-9._-]+/g,
  /\b1\/\/[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]+/g,
  /\bsk-[A-Za-z0-9_-]{12,}/g,
  /\b[0-9a-f]{64}\b/gi,
];
const MAX_STRING = 200;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (typeof value === "string") {
    let s = value;
    for (const re of SENSITIVE_VALUE) s = s.replace(re, "[redacted]");
    return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… (${s.length} chars)` : s;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v, depth + 1)]));
  }
  return value;
}

type Level = "info" | "warn" | "error";

export class OpsLog {
  #write: (line: string) => void;

  constructor(opts: { write?: (line: string) => void; file?: string } = {}) {
    const file = opts.file;
    this.#write =
      opts.write ??
      ((line) => {
        process.stdout.write(`${line}\n`);
        if (file) appendFileSync(file, `${line}\n`);
      });
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.#emit("info", event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.#emit("warn", event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.#emit("error", event, fields);
  }

  #emit(level: Level, event: string, fields: Record<string, unknown>): void {
    this.#write(JSON.stringify({ t: new Date().toISOString(), level, event, ...(redact(fields) as object) }));
  }
}

/** For tests and callers that don't log. */
export const silentOps = new OpsLog({ write: () => {} });
