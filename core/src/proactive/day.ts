// The proactive day: a morning briefing and an evening "plan tomorrow" offer.
// The briefing is a system command through the normal agent loop, so the tier
// gate is unchanged: reads run, writes leave receipts, sends still need a tap.
import { runCommand, type AgentDeps } from "../agent/loop.ts";
import { DailyScheduler, parseAt, type DailyJob } from "./scheduler.ts";

export const BRIEFING_COMMAND = "Morning briefing: today's schedule, what needs an answer from me, and tasks from new email.";
export const PLAN_COMMAND = "Plan tomorrow.";
export const EVENING_OFFER = { title: "Tomorrow", body: "Want me to plan tomorrow?", action: { label: "Plan tomorrow", command: PLAN_COMMAND } };

const NOON = 12 * 60;

/**
 * Runs the briefing now. The reply is spoken on the best active voice device
 * (runCommand's speak); with no voice device online, or when it runs to several lines, it goes on the phone as a card.
 */
export async function runBriefing(deps: AgentDeps, session: string, by: "schedule" | "button" | "test" = "schedule") {
  deps.log.append(session, "proactive", { job: "briefing", by, status: "started" });
  const { reply, spokenOn } = await runCommand(deps, { session, text: BRIEFING_COMMAND, system: "briefing" });
  const voice = deps.surfaces.online().some((m) => m.id === spokenOn && m.outputs.includes("voice"));
  // A briefing with several lines also goes on the phone, where it can be read back.
  const shownOn = voice && !reply.includes("\n") ? null : deps.surfaces.showCard("Morning briefing", reply);
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
