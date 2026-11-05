/**
 * Checks a model's parsed tool arguments against the tool's `parameters` schema before
 * the tool runs: required keys present, no unknown keys, top-level types right. A key
 * the model misnamed (`channel` for `channel_id`, a near typo) maps to the declared key
 * when exactly one declared key fits, and the mapping is reported so it can be logged.
 * Anything else comes back as an error naming the expected keys, so the model retries.
 */

export interface ArgMapping {
  from: string;
  to: string;
}

export type ArgCheck =
  | { ok: true; args: Record<string, unknown>; mapped: ArgMapping[] }
  | { ok: false; error: { error: "invalid_arguments"; message: string; expected: { required: string[]; optional: string[] }; problems: string[] } };

type Schema = Record<string, unknown>;

export function validateArgs(parameters: Schema | undefined, raw: unknown): ArgCheck {
  const props = (parameters?.properties && typeof parameters.properties === "object" ? parameters.properties : {}) as Record<string, Schema>;
  const declared = Object.keys(props);
  const required = Array.isArray(parameters?.required) ? (parameters.required as unknown[]).filter((r): r is string => typeof r === "string") : [];
  const optional = declared.filter((k) => !required.includes(k));
  // JSON Schema allows extra keys unless additionalProperties is false; Auren's own schemas set it false.
  const openExtras = parameters?.additionalProperties !== undefined && parameters.additionalProperties !== false;
  const problems: string[] = [];
  const fail = (): ArgCheck => ({
    ok: false,
    error: {
      error: "invalid_arguments",
      message: `Invalid arguments: ${problems.join("; ")}. Expected keys: ${describe(required, optional)}. Call the tool again with those keys.`,
      expected: { required, optional },
      problems,
    },
  });

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    problems.push("arguments must be a JSON object");
    return fail();
  }

  const args: Record<string, unknown> = {};
  const mapped: ArgMapping[] = [];
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k in props) args[k] = v;
    else unknown.push(k);
  }
  for (const k of unknown) {
    const target = openExtras ? undefined : nearKey(k, declared.filter((d) => !(d in args)));
    if (target) {
      args[target] = (raw as Record<string, unknown>)[k];
      mapped.push({ from: k, to: target });
    } else if (openExtras) {
      args[k] = (raw as Record<string, unknown>)[k];
    } else {
      problems.push(`unknown key "${k}"`);
    }
  }

  // A null for an optional key means "not given" (models do this); drop it rather than fail.
  for (const k of optional) if (args[k] === null && !allows(props[k], "null")) delete args[k];

  for (const k of required) if (args[k] === undefined) problems.push(`missing required key "${k}"`);
  for (const [k, v] of Object.entries(args)) {
    const schema = props[k];
    if (!schema || v === undefined) continue;
    const want = types(schema);
    if (want.length && !want.some((t) => matches(t, v))) problems.push(`"${k}" should be ${want.join(" or ")}, got ${kind(v)}`);
    else if (Array.isArray(schema.enum) && schema.enum.length && !schema.enum.includes(v)) problems.push(`"${k}" should be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  return problems.length ? fail() : { ok: true, args, mapped };
}

/** The one declared key a misnamed key most plausibly means, or undefined if none or several fit. */
export function nearKey(key: string, candidates: string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const n = norm(key);
  const pick = (hits: string[]) => (hits.length === 1 ? hits[0] : undefined);
  // `channel` → `channel_id`, `channelId` → `channel_id`, `Channel-ID` → `channel_id`.
  const idForm = pick(candidates.filter((c) => norm(c) === n || norm(c) === `${n}id` || (c.endsWith("_id") && norm(c.slice(0, -3)) === n)));
  if (idForm) return idForm;
  if (n.length < 4) return undefined;
  return pick(candidates.filter((c) => levenshtein(n, norm(c)) <= (n.length >= 8 ? 2 : 1)));
}

function levenshtein(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length];
}

function types(schema: Schema): string[] {
  if (typeof schema.type === "string") return [schema.type];
  if (Array.isArray(schema.type)) return schema.type.filter((t): t is string => typeof t === "string");
  return [];
}

function allows(schema: Schema | undefined, t: string): boolean {
  return Boolean(schema) && types(schema!).includes(t);
}

function matches(t: string, v: unknown): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return Boolean(v) && typeof v === "object" && !Array.isArray(v);
    case "null":
      return v === null;
    default:
      return true;
  }
}

function kind(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function describe(required: string[], optional: string[]): string {
  const parts = [...required, ...optional.map((k) => `${k} (optional)`)];
  return parts.length ? parts.join(", ") : "none";
}
