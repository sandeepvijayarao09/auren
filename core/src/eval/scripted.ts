// The scripted model: plays a case's model turns from eval/scripts/<case-id>.json
// through the real agent loop, so Core runs end to end with no key and no network.
// The eval runner uses it for every scripted case, and the public sandbox's
// "replay" engine (R13) uses it for the golden paths.
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { MuseLike } from "../agent/loop.ts";
import type { EventLog } from "../eventlog.ts";

export const EVAL_DIR = new URL("../../../eval/", import.meta.url);

/** One scripted model turn: some tool calls, or the final spoken sentence. `ms` stands in for model time. */
export const Turn = z.strictObject({
  ms: z.number().min(0).optional(),
  calls: z.array(z.strictObject({ tool: z.string(), args: z.record(z.string(), z.unknown()) })).optional(),
  say: z.string().optional(),
});
export type Turn = z.infer<typeof Turn>;

export const Script = z.strictObject({
  case: z.string(),
  note: z.string().optional(),
  commands: z.array(z.strictObject({ ack: z.string().optional(), turns: z.array(Turn).min(1) })),
});
export type Script = z.infer<typeof Script>;
export type ScriptCommand = Script["commands"][number];

export function loadScript(id: string): Script | null {
  try {
    return Script.parse(JSON.parse(readFileSync(new URL(`scripts/${id}.json`, EVAL_DIR), "utf8")));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Where a script plays: the log its `{{receipt:…}}` placeholders read, and a timer the host can cancel. */
export interface ScriptHost {
  readonly log: EventLog;
  readonly session: string;
  later(ms: number, fn: () => void): void;
}

const today = () => new Intl.DateTimeFormat("en-CA").format(new Date());
const RECEIPT = /^\{\{receipt:([a-z_]+)\.([a-z_]+)\}\}$/;
const OUTPUT = /^\{\{output:([a-z_]+)\}\}$/;

/** The latest receipt from `namespace.tool` in the host's log: what `{{receipt:ns.tool}}` resolves to. */
export function latestReceipt(host: Pick<ScriptHost, "log" | "session">, namespace: string, tool: string) {
  return host.log.since(host.session, 0, 10_000).reverse().find((e) => e.kind === "receipt" && e.data.namespace === namespace && e.data.tool === tool);
}

/** Every `{{receipt:ns.tool}}` a scripted command uses, as [namespace, tool]. */
export function receiptRefs(cmd: ScriptCommand): Array<[string, string]> {
  const refs: Array<[string, string]> = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      const m = v.match(RECEIPT);
      if (m) refs.push([m[1], m[2]]);
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  for (const t of cmd.turns) for (const c of t.calls ?? []) walk(c.args);
  return refs;
}

/** Serves a case's scripted turns, one command at a time. */
export class ScriptedMuse implements MuseLike {
  #turns: Turn[] = [];
  #ack: string | undefined;
  #i = 0;
  #n = 0;
  readonly host: ScriptHost;
  readonly fastModel: string;

  constructor(host: ScriptHost, fastModel: string) {
    this.host = host;
    this.fastModel = fastModel;
  }

  load(cmd: ScriptCommand) {
    this.#turns = cmd.turns;
    this.#ack = cmd.ack;
    this.#i = 0;
  }

  get unused() {
    return this.#turns.length - this.#i;
  }

  responses = {
    create: async (params: Record<string, unknown>) => {
      const id = `resp_${++this.#n}`;
      if (params.model === this.fastModel) return { id, output: [], output_text: this.#ack ?? "" };
      const turn = this.#turns[this.#i++];
      if (!turn) throw new Error("the script ran out of turns: the loop asked the model again");
      if (turn.ms) await new Promise((r) => this.host.later(turn.ms!, () => r(null)));
      if (turn.say !== undefined) return { id, output: [], output_text: turn.say };
      const outputs = toolOutputs(params.input);
      return {
        id,
        output_text: "",
        output: (turn.calls ?? []).map((c, k) => {
          const [namespace, name] = c.tool.split(".");
          return { type: "function_call", call_id: `call_${this.#n}_${k}`, namespace, name, arguments: JSON.stringify(this.#fill(c.args, outputs)) };
        }),
      };
    },
  };

  /**
   * `{{today}}` is the local date; a value of `{{receipt:ns.tool}}` is the id of that tool's latest receipt;
   * a value of `{{output:key}}` is `key` from the tool results this turn was handed, as a model would read it.
   */
  #fill(value: unknown, outputs: Array<Record<string, unknown>>): unknown {
    if (typeof value === "string") {
      const receipt = value.match(RECEIPT);
      if (receipt) return latestReceipt(this.host, receipt[1], receipt[2])?.id ?? null;
      const output = value.match(OUTPUT);
      if (output) return outputs.find((o) => output[1] in o)?.[output[1]] ?? null;
      return value.replaceAll("{{today}}", today());
    }
    if (Array.isArray(value)) return value.map((v) => this.#fill(v, outputs));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.#fill(v, outputs)]));
    return value;
  }
}

/** The JSON objects in a turn's function_call_output items. */
function toolOutputs(input: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(input)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const item of input) {
    if (item?.type !== "function_call_output" || typeof item.output !== "string") continue;
    try {
      const v = JSON.parse(item.output);
      if (v && typeof v === "object" && !Array.isArray(v)) out.push(v);
    } catch {
      // not JSON: nothing to read
    }
  }
  return out;
}
