// The proactive day: a morning briefing and an evening "plan tomorrow" offer.
// The briefing is a system command through the normal agent loop, so the tier
// gate is unchanged: reads run, writes leave receipts, sends still need a tap.
import { runCommand, type AgentDeps } from "../agent/loop.ts";
import { DailyScheduler, parseAt, type DailyJob } from "./scheduler.ts";

export const BRIEFING_COMMAND = "Morning briefing: today's schedule, what needs an answer from me, and tasks from new email.";
export const PLAN_COMMAND = "Plan tomorrow.";
export const EVENING_OFFER = { title: "Tomorrow", body: "Want me to plan tomorrow?", action: { label: "Plan tomorrow", command: PLAN_COMMAND } };

const NOON = 12 * 60;

// One spoken sentence is at most this long; the full briefing is on the card.
const SPOKEN_MAX = 160;
// Abbreviations whose period doesn't end a sentence ("Prof. Lee is waiting").
const ABBREV = /\b(prof|dr|mr|mrs|ms|st|vs|etc|e\.g|i\.e|approx|no|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/i;

/** A markdown line as plain words: no heading marks, bullets, emphasis, code ticks or link targets. */
function plain(line: string): string {
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*•+]\s+|\d+[.)]\s+)/, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|\*|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The briefing's first sentence, for speaking: the model's reply is often a markdown
 * list, which is long to hear. Deterministic, so it doesn't depend on the model
 * following a format. Headings and lead-ins ("Here's your day:") are skipped, and a
 * long sentence is cut at a word. Empty when there's nothing to say.
 */
export function spokenLine(reply: string): string {
  for (const raw of reply.split("\n")) {
    const line = plain(raw);
    // A heading or a lead-in to a list has no sentence of its own.
    if (!line || /:$/.test(line) || (!/[.!?]$/.test(line) && line.split(" ").length < 4)) continue;
    let end = line.length;
    for (const m of line.matchAll(/[.!?](?=\s+["“(]?[A-Z0-9]|$)/g)) {
      if (m[0] === "." && ABBREV.test(line.slice(0, m.index + 1))) continue;
      end = m.index + 1;
      break;
    }
    let sentence = line.slice(0, end).trim();
    if (sentence.length > SPOKEN_MAX) {
      const cut = sentence.slice(0, SPOKEN_MAX);
      sentence = `${cut.slice(0, Math.max(cut.lastIndexOf(" "), 40)).replace(/[,;:\s—-]+$/, "")}…`;
    }
    return sentence;
  }
  return "";
}

const words = (s: string) => s.replace(/[^a-z0-9]+/gi, " ").trim().toLowerCase();

/**
 * Runs the briefing now. One short sentence is spoken on the best active voice device
 * (runCommand's speak); the full briefing goes on the phone as a card whenever there's
 * more to it than that sentence, or when no voice device is online.
 */
export async function runBriefing(deps: AgentDeps, session: string, by: "schedule" | "button" | "test" = "schedule") {
  deps.log.append(session, "proactive", { job: "briefing", by, status: "started" });
  let more = false;
  const speak = (full: string) => {
    const line = spokenLine(full) || "Your briefing is ready.";
    more = words(line.replace(/…$/, "")) !== words(full);
    const screen = deps.surfaces.online().filter((m) => m.outputs.includes("screen"));
    if (!more || !screen.length) return line;
    return `${line} The rest is on your ${screen.some((m) => m.kind === "phone") ? "phone" : "screen"}.`;
  };
  const { reply, spokenOn } = await runCommand(deps, { session, text: BRIEFING_COMMAND, system: "briefing", speak });
  const voice = deps.surfaces.online().some((m) => m.id === spokenOn && m.outputs.includes("voice"));
  // The card carries the whole briefing, where it can be read back.
  const shownOn = voice && !more ? null : deps.surfaces.showCard("Morning briefing", reply);
  deps.log.append(session, "proactive", { job: "briefing", by, status: "done", spoken_on: voice ? spokenOn : null, shown_on: shownOn });
  return { reply, spokenOn: voice ? spokenOn : null, shownOn };
}

/** The evening card: no approval, no model call. Tapping it says "Plan tomorrow." */
export function offerPlan(deps: Pick<AgentDeps, "log" | "surfaces">, session: string) {
  const shownOn = deps.surfaces.showCard(EVENING_OFFER.title, EVENING_OFFER.body, EVENING_OFFER.action);
  deps.log.append(session, "proactive", { job: "evening", status: "offered", text: EVENING_OFFER.body, shown_on: shownOn });
  return { shownOn };
}

export interface ProactiveOptions {
  /** AUREN_BRIEFING_AT, e.g. "07:30". Empty is off. */
  briefingAt?: string;
  /** AUREN_EVENING_AT, e.g. "21:00". Empty is off. */
  eveningAt?: string;
  dbPath: string;
  session: string;
  /** False while there's no model key: the briefing would only log an error. */
  ready?: boolean;
  now?: () => Date;
  tickMs?: number;
}

/** The two daily jobs. The briefing catches up after sleep only before noon; the evening card until midnight. */
export function createProactive(deps: AgentDeps, opts: ProactiveOptions) {
  const jobs: DailyJob[] = [];
  const briefing = parseAt(opts.briefingAt);
  if (briefing !== null && opts.ready !== false) {
    jobs.push({ name: "briefing", at: briefing, until: briefing < NOON ? NOON - 1 : briefing + 60, run: () => runBriefing(deps, opts.session) });
  }
  const evening = parseAt(opts.eveningAt);
  if (evening !== null) jobs.push({ name: "evening", at: evening, run: () => offerPlan(deps, opts.session) });
  const scheduler = new DailyScheduler({
    db: opts.dbPath,
    timeZone: deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    jobs,
    now: opts.now,
    tickMs: opts.tickMs,
    onError: (job, err) => deps.ops?.error("proactive.error", { job, message: err instanceof Error ? err.message : String(err) }),
  });
  return {
    scheduler,
    briefingNow: () => runBriefing(deps, opts.session, "button"),
    status: () => ({ briefing_at: briefing === null ? null : opts.briefingAt, evening_at: evening === null ? null : opts.eveningAt, last: Object.fromEntries(scheduler.jobs.map((j) => [j, scheduler.lastRun(j) ?? null])) }),
  };
}
