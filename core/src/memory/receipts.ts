// The receipts namespace: "undo that" and "undo the calendar move" by voice.
// It finds the receipt and runs its stored undo step through undoReceipt,
// the same path as the Undo button. Sends reached someone, so they're never undone.
import { z } from "zod";
import { undoReceipt } from "../agent/loop.ts";
import type { EventLog } from "../eventlog.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Namespace } from "../tools/types.ts";
import { params } from "../tools/types.ts";
import { dayOf, keywords, receiptsIn, receiptWords, score, sessionEvents, when, type Receipt } from "./history.ts";

export interface ReceiptsDeps {
  log: EventLog;
  /** Resolves each receipt's undo step. The receipts namespace is usually registered in this same registry. */
  tools: ToolRegistry;
  timeZone?: string;
  now?: () => Date;
}

const ListArgs = z.object({ limit: z.coerce.number().int().positive().nullish() });
const UndoArgs = z.object({
  receipt_id: z.coerce.number().int().positive().nullish(),
  description: z.string().max(300).nullish(),
});

/** Why a receipt can't be undone, or undefined if it can. */
export function whyNot(r: Receipt, tools: ToolRegistry): string | undefined {
  if (r.tier === "send" || tools.resolve(r.tool, r.namespace)?.tool.tier === "send") return `"${quote(r.summary)}" was sent, and sends can't be undone`;
  if (r.undoes !== undefined) return `"${quote(r.summary)}" is itself an undo`;
  if (r.undoneBy !== undefined) return `"${quote(r.summary)}" was already undone`;
  if (!r.undo) return `"${quote(r.summary)}" has no undo step`;
  const step = tools.resolve(r.undo.tool, r.undo.namespace);
  if (!step) return `the undo step for "${quote(r.summary)}" isn't available right now`;
  // Undo steps run without a tap, so one that would send is refused outright.
  if (step.tool.tier === "send") return `undoing "${quote(r.summary)}" would send something`;
  return undefined;
}

/**
 * The receipt a description means: the most recent one that best matches its
 * keywords, or simply the most recent for "that". Already-undone receipts and
 * undos themselves are skipped. Sends stay in, so "undo the Slack post" is
 * refused instead of undoing something else.
 */
export function findReceipt(all: Receipt[], description: string): Receipt | undefined {
  const live = all.filter((r) => r.undoes === undefined && r.undoneBy === undefined);
  const wanted = keywords(description);
  if (!wanted.length) return live.at(-1);
  let best: Receipt | undefined;
  let bestScore = 0;
  for (const r of live) {
    const s = score(wanted, receiptWords(r));
    if (s > 0 && s >= bestScore) [best, bestScore] = [r, s];
  }
  return best;
}

export function createReceipts(deps: ReceiptsDeps): Namespace {
  const tz = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = () => deps.now?.() ?? new Date();

  return {
    name: "receipts",
    app: "Auren",
    description:
      "Everything Auren changed or sent for the user, with undo. " +
      'For "undo that" or "undo the calendar move", call undo with the user\'s words as description. Sends (messages, invites) can\'t be undone.',
    tools: [
      {
        name: "list_recent",
        description: "List recent receipts, newest first, with their ids and whether each can be undone.",
        parameters: params({ limit: { type: "integer", description: "How many (default 10, at most 25)." } }, ["limit"]),
        tier: "read",
        // Summaries can quote email and chat.
        external: true,
        async run(args: unknown, ctx) {
          const limit = Math.min(ListArgs.parse(args ?? {}).limit ?? 10, 25);
          const today = dayOf(now(), tz);
          const recent = receiptsIn(sessionEvents(deps.log, ctx.session)).slice(-limit).reverse();
          return {
            receipts: recent.map((r) => {
              const why = whyNot(r, deps.tools);
              return {
                id: r.id,
                when: when(r.at, tz, today),
                app: r.app,
                summary: r.summary,
                can_undo: !why,
                ...(why ? { why_not: why } : {}),
              };
            }),
          };
        },
      },
      {
        name: "undo",
        description:
          'Undo one receipt, by receipt_id or by description (the user\'s words, such as "the calendar move"; leave both out for the most recent). ' +
          "Refuses sends and anything without an undo step.",
        parameters: params(
          { receipt_id: { type: "integer", description: "From list_recent." }, description: { type: "string", description: "What to undo, in the user's words." } },
          ["receipt_id", "description"],
        ),
        tier: "write",
        // undoReceipt writes the "Undid: …" receipt, marked with what it reverses.
        ownReceipt: true,
        external: true,
        async run(args: unknown, ctx) {
          const a = UndoArgs.parse(args ?? {});
          const all = receiptsIn(sessionEvents(deps.log, ctx.session));
          const target = a.receipt_id ? all.find((r) => r.id === a.receipt_id) : findReceipt(all, a.description ?? "");
          if (!target) {
            return { ok: false, message: a.receipt_id ? `There's no receipt ${a.receipt_id}.` : `Nothing to undo matches "${a.description ?? ""}".` };
          }
          const why = whyNot(target, deps.tools);
          if (why) return { ok: false, message: `Can't undo: ${why}.` };
          const res = await undoReceipt({ log: deps.log, tools: deps.tools, surfaces: ctx.surfaces }, target.id, ctx.session);
          return { ...res, undid: target.id };
        },
      },
    ],
  };
}

const quote = (s: string) => (s.length > 80 ? `${s.slice(0, 79)}…` : s).replace(/\?$/, "");
