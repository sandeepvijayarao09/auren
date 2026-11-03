// Record and replay for connector calls. Record the real responses once (with
// tokens stripped), then replay them in tests and evals with no network, no
// accounts and no cost. A call that isn't on the tape fails loudly.
import { readFileSync, writeFileSync } from "node:fs";

export interface TapeEntry {
  method: string;
  url: string;
  status: number;
  body: unknown;
}

export interface Tape {
  entries: TapeEntry[];
}

const SECRET_KEYS = /^(access_token|refresh_token|id_token|token|client_secret)$/i;

/** Drops token-shaped fields from a recorded response; everything else is kept as is. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[scrubbed]" : scrub(v)]));
  }
  return value;
}

const keyOf = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

/** Wraps a real fetch and appends every call to the tape. */
export function recorder(real: typeof fetch, tape: Tape): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init.method ?? "GET";
    const res = await real(input, init);
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON: keep the text.
    }
    tape.entries.push({ method, url, status: res.status, body: scrub(body) });
    return new Response(text, { status: res.status, headers: res.headers });
  }) as typeof fetch;
}

/** Serves calls from the tape, each entry once, in order per method and URL. */
export function player(tape: Tape): typeof fetch {
  const queues = new Map<string, TapeEntry[]>();
  for (const e of tape.entries) {
    const k = keyOf(e.method, e.url);
    queues.set(k, [...(queues.get(k) ?? []), e]);
  }
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    const entry = queues.get(keyOf(init.method ?? "GET", url))?.shift();
    if (!entry) throw new Error(`Not on the tape: ${keyOf(init.method ?? "GET", url)}`);
    if (entry.status === 204) return new Response(null, { status: 204 });
    return new Response(typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body), {
      status: entry.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

export const loadTape = (path: string): Tape => JSON.parse(readFileSync(path, "utf8")) as Tape;
export const saveTape = (path: string, tape: Tape) => writeFileSync(path, `${JSON.stringify(tape, null, 2)}\n`);
