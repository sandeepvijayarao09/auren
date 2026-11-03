// Reading the session back out of the event log: receipts with their undo
// state, local days and times, and the keywords that recall and "undo the
// calendar move" match on. No vector store: the log is small and structured.
import { z } from "zod";
import type { EventLog } from "../eventlog.ts";
import type { AurenEvent, Tier } from "../protocol.ts";
import type { UndoStep } from "../tools/types.ts";

/** Every event in the session, oldest first. `since` returns 500 at a time. */
export function sessionEvents(log: EventLog, session: string): AurenEvent[] {
  const all: AurenEvent[] = [];
  for (let page = log.since(session, 0); page.length; page = log.since(session, page[page.length - 1].id)) all.push(...page);
  return all;
}

const ReceiptData = z.object({
  app: z.string(),
  namespace: z.string(),
  tool: z.string(),
  tier: z.enum(["read", "write", "send"]),
  summary: z.string(),
  undo: z.object({ namespace: z.string(), tool: z.string(), args: z.record(z.string(), z.unknown()) }).nullish(),
  undoes: z.number().int().optional(),
});

export interface Receipt {
  id: number;
  at: number;
  app: string;
  namespace: string;
  tool: string;
  tier: Tier;
  summary: string;
  undo: UndoStep | null;
  /** The receipt this one reversed. */
  undoes?: number;
  /** The receipt that reversed this one. */
  undoneBy?: number;
}

/** The session's receipts, oldest first, each marked with the undo that reversed it. */
export function receiptsIn(events: AurenEvent[]): Receipt[] {
  const out: Receipt[] = [];
  for (const e of events) {
    if (e.kind !== "receipt") continue;
    const d = ReceiptData.safeParse(e.data);
    if (!d.success) continue;
    out.push({ id: e.id, at: e.at, ...d.data, undo: d.data.undo ?? null });
  }
  const byId = new Map(out.map((r) => [r.id, r]));
  for (const r of out) {
    const target = r.undoes === undefined ? undefined : byId.get(r.undoes);
    if (target) target.undoneBy = r.id;
  }
  return out;
}

/** "2026-11-02" in the user's time zone. */
export function dayOf(at: number | Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(at);
}

/** "3:02 PM" on `today`, "Nov 1, 3:02 PM" on any other day. */
export function when(at: number, timeZone: string, today: string): string {
  const time = new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(at);
  const date = dayOf(at, timeZone) === today ? "" : `${new Intl.DateTimeFormat("en-US", { timeZone, month: "short", day: "numeric" }).format(at)}, `;
  // ICU puts a narrow no-break space before AM/PM; a plain space reads and speaks the same.
  return `${date}${time}`.replace(/ /g, " ");
}

/** "Monday, November 2" for a YYYY-MM-DD day. */
export function longDay(day: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", month: "long", day: "numeric" }).format(new Date(`${day}T12:00:00Z`));
}

// Words people use for each app, so "the meeting" finds a calendar receipt and "the email" a draft.
const APP_WORDS: Record<string, string> = {
  calendar: "calendar event meeting appointment schedule",
  gmail: "gmail email mail reply draft",
  slack: "slack message chat channel post",
  browser: "browser web site booking reservation",
};

const STOP = new Set(
  ("a an the i me my mine you your we us it its this that these those there here to of in on at for from by with and or but not " +
    "is are was were be been am do did does done doing what when where which who whom how why can could would should will " +
    "today yesterday earlier just please undo revert reverse last latest thing things one something get got").split(" "),
);

/** Lowercase, drop stop words, and strip common endings so "moved", "moving" and "move" match. */
export function keywords(text: string): string[] {
  const out = new Set<string>();
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (STOP.has(word) || word.length < 2) continue;
    const stem = word.replace(/(ing|ed|es|e|s)$/, "");
    out.add(stem.length >= 3 ? stem : word);
  }
  return [...out];
}

/** The words a receipt can be found by: its app, the app's everyday names, the tool and the summary. */
export function receiptWords(r: Receipt): Set<string> {
  return new Set(keywords(`${r.app} ${r.namespace} ${APP_WORDS[r.namespace] ?? ""} ${r.tool.replace(/_/g, " ")} ${r.summary}`));
}

/** How many of the query's keywords appear in `words`. */
export function score(query: string[], words: Set<string>): number {
  return query.filter((k) => words.has(k)).length;
}
