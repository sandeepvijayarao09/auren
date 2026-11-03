// Muse Spark Open, Meta's open-weight model, on Baseten's OpenAI-compatible
// chat completions. Auren Memory runs here because the log is the most personal
// data Auren holds, and open weights run on a deployment you choose.
import { z } from "zod";
import { silentOps, type OpsLog } from "../obs/opslog.ts";
import type { Ledger } from "../security/ledger.ts";

export const SPARK_OPEN = "meta-models/muse-spark-open-1026";

export interface ChatParams {
  model: string;
  max_tokens: number;
  temperature: number;
  messages: Array<{ role: "system"; content: string } | { role: "user"; content: string }>;
}

/** The slice of an OpenAI-compatible client Auren Memory uses (Baseten is drop-in). */
export interface ChatLike {
  chat: { completions: { create(params: ChatParams, options?: { signal?: AbortSignal }): Promise<unknown> } };
}

export interface SparkOptions {
  client: ChatLike;
  model?: string;
  /** Every call is recorded here as "Baseten", without contents. */
  ledger?: Ledger;
  /** Latency and token counts per call. Never contents. */
  ops?: OpsLog;
  /** After this, the call is abandoned and the caller falls back. */
  timeoutMs?: number;
}

export interface Spark {
  model: string;
  /** One chat completion. Throws on failure, timeout or an empty answer, so the caller can fall back. */
  complete(req: { tool: string; system: string; user: string; maxTokens: number; trace?: string }): Promise<string>;
}

const Completion = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullish() }) })).min(1),
  usage: z.object({ prompt_tokens: z.number().optional(), completion_tokens: z.number().optional() }).nullish(),
});

export function sparkOpen(o: SparkOptions): Spark {
  const model = o.model ?? SPARK_OPEN;
  const ops = o.ops ?? silentOps;
  return {
    model,
    async complete({ tool, system, user, maxTokens, trace }) {
      const params: ChatParams = {
        model,
        max_tokens: maxTokens,
        temperature: 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      };
      const t0 = performance.now();
      const call = { service: "Baseten", operation: `chat.completions ${model}`, bytesOut: Buffer.byteLength(JSON.stringify(params)) };
      let raw: unknown;
      try {
        raw = await withTimeout(o.timeoutMs ?? 8000, (signal) => o.client.chat.completions.create(params, { signal }));
      } catch (err) {
        const ms = performance.now() - t0;
        o.ledger?.record({ ...call, status: "error", ms });
        ops.warn("memory.call", { trace: trace ?? null, tool, model, ms: Math.round(ms), ok: false, message: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      const ms = performance.now() - t0;
      o.ledger?.record({ ...call, status: "ok", ms });
      const parsed = Completion.safeParse(raw);
      const text = parsed.success ? stripThinking(parsed.data.choices[0].message.content ?? "") : "";
      ops.info("memory.call", {
        trace: trace ?? null,
        tool,
        model,
        ms: Math.round(ms),
        input_tokens: parsed.data?.usage?.prompt_tokens ?? null,
        output_tokens: parsed.data?.usage?.completion_tokens ?? null,
        ok: Boolean(text),
      });
      if (!text) throw new Error(parsed.success ? "Spark Open returned an empty answer" : "Spark Open returned an unexpected response");
      return text.slice(0, 1500);
    },
  };
}

/** Open-weight chat models sometimes return their reasoning inline. Only the answer is kept. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abort.abort();
      reject(new Error(`Spark Open didn't answer in ${ms} ms`));
    }, ms);
  });
  try {
    return await Promise.race([run(abort.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
