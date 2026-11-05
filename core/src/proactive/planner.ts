// planner.plan_tomorrow: reads tomorrow's calendar, the open tasks and what was
// left unfinished today (open tasks due by today, drafts that never went out),
// then puts focus blocks and task slots in tomorrow's free time as calendar events.
// It only ever calls calendar.create_event (a write that sends no invitations),
// writes one receipt per event with its own Undo, and never invites anyone:
// sharing a block is calendar.invite, a send, which still needs a tap.
import { z } from "zod";
import type { EventLog } from "../eventlog.ts";
import { receiptsIn, sessionEvents } from "../memory/history.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { Namespace, ToolContext } from "../tools/types.ts";
import { params } from "../tools/types.ts";
import { localClock } from "./scheduler.ts";

export interface PlannerDeps {
  log: EventLog;
  /** Where calendar, tasks and receipts are found. Usually the registry this namespace joins. */
  tools: ToolRegistry;
  timeZone?: string;
  now?: () => Date;
  /** The working day the plan fills, in minutes after midnight (default 09:00 to 18:00). */
  dayStart?: number;
  dayEnd?: number;
}

export interface Block { title: string; start: string; end: string; kind: "focus" | "task" }

interface Item { title: string; why: string; rank: number }

const Args = z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(), focus_minutes: z.coerce.number().int().min(30).max(240).nullish() });

const MAX_TASK_SLOTS = 4;
const TASK_MINUTES = 30;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const minuteOf = (iso: string) => {
  const m = iso.match(/T(\d{2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

/** Free gaps between `from` and `to`, given busy [start, end) minute ranges. */
export function freeGaps(busy: Array<[number, number]>, from: number, to: number): Array<[number, number]> {
  const gaps: Array<[number, number]> = [];
  let cursor = from;
  for (const [s, e] of [...busy].sort((a, b) => a[0] - b[0])) {
    if (s > cursor) gaps.push([cursor, Math.min(s, to)]);
    cursor = Math.max(cursor, e);
    if (cursor >= to) break;
  }
  if (cursor < to) gaps.push([cursor, to]);
  return gaps.filter(([s, e]) => e - s >= 15);
}

/** The plan: one focus block in the longest morning-first gap, then task slots in what's left. Pure, for tests. */
export function proposeBlocks(date: string, busy: Array<[number, number]>, items: Item[], opts: { dayStart: number; dayEnd: number; focusMinutes: number }): Block[] {
  let gaps = freeGaps(busy, opts.dayStart, opts.dayEnd);
  const blocks: Block[] = [];
  const take = (minutes: number, prefer: "first" | "longest"): [number, number] | undefined => {
    const fits = gaps.filter(([s, e]) => e - s >= minutes);
    const g = prefer === "first" ? fits[0] : fits.sort((a, b) => b[1] - b[0] - (a[1] - a[0]))[0];
    if (!g) return undefined;
    gaps = gaps.flatMap((x) => (x === g ? (g[1] - (g[0] + minutes) >= 15 ? [[g[0] + minutes, g[1]] as [number, number]] : []) : [x])).sort((a, b) => a[0] - b[0]);
    return [g[0], g[0] + minutes];
  };
  // Deep work goes first in the day; a shorter block if the morning is broken up.
  const focus = take(opts.focusMinutes, "first") ?? take(60, "longest");
  if (focus) blocks.push({ title: "Focus block", start: `${date}T${hhmm(focus[0])}`, end: `${date}T${hhmm(focus[1])}`, kind: "focus" });
  for (const item of [...items].sort((a, b) => a.rank - b.rank).slice(0, MAX_TASK_SLOTS)) {
    const slot = take(TASK_MINUTES, "first");
    if (!slot) break;
    blocks.push({ title: `Task: ${item.title}`, start: `${date}T${hhmm(slot[0])}`, end: `${date}T${hhmm(slot[1])}`, kind: "task" });
  }
  return blocks.sort((a, b) => a.start.localeCompare(b.start));
}

/** A tool result from either a demo namespace or an MCP server ({ structured } or JSON text). */
function field<T>(result: unknown, key: string): T[] {
  const r = (result ?? {}) as Record<string, unknown>;
  const direct = r[key] ?? (r.structured as Record<string, unknown> | undefined)?.[key];
  if (Array.isArray(direct)) return direct as T[];
  if (typeof r.text === "string") {
    try {
      const v = JSON.parse(r.text)?.[key];
      if (Array.isArray(v)) return v as T[];
    } catch {
      // not JSON
    }
  }
  return [];
}

export function createPlanner(deps: PlannerDeps): Namespace {
  const tz = deps.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const now = () => deps.now?.() ?? new Date();

  async function read(ns: string, tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> {
    const found = deps.tools.resolve(tool, ns);
    // Reads only: the planner never runs another namespace's write or send through here.
    if (!found || found.tool.tier !== "read") return undefined;
    try {
      return await found.tool.run(args, ctx);
    } catch {
      return undefined;
    }
  }

  return {
    name: "planner",
    app: "Auren Planner",
    description:
      'Plans the user\'s next day. For "plan tomorrow" or "plan my day tomorrow", call plan_tomorrow: it reads the calendar, open tasks and what\'s unfinished today, ' +
      "and adds focus blocks and task slots to the calendar, each with Undo. It never invites anyone.",
    tools: [
      {
        name: "plan_tomorrow",
        description:
          "Read tomorrow's calendar, open tasks and today's unfinished items, then add a focus block and task slots to tomorrow's free time as calendar events (no invitations). Each one gets a receipt with Undo.",
        parameters: params(
          { date: { type: "string", description: "YYYY-MM-DD. Leave out for tomorrow." }, focus_minutes: { type: "integer", description: "Length of the focus block (default 120)." } },
          ["date", "focus_minutes"],
        ),
        tier: "write",
        // One receipt per created event, each with its own Undo, written below.
        ownReceipt: true,
        // Event and task titles can come from other people.
        external: true,
        async run(args: unknown, ctx) {
          const a = Args.parse(args ?? {});
          const clock = localClock(now(), tz);
          const date = a.date ?? localClock(new Date(now().getTime() + 86_400_000), tz).day;
          const dayStart = deps.dayStart ?? 9 * 60;
          const dayEnd = deps.dayEnd ?? 18 * 60;

          const events = field<{ title?: string; start?: string; end?: string }>(await read("calendar", "list_events", { date }, ctx), "events");
          const busy = events
            .map((e) => [e.start ? minuteOf(e.start) : null, e.end ? minuteOf(e.end) : null] as const)
            .filter((b): b is [number, number] => b[0] !== null && b[1] !== null)
            .map(([s, e]) => [s, e <= s ? 24 * 60 : e] as [number, number]);

          // Open tasks: overdue and due today first (today's unfinished), then due on the day, then the rest.
          const tasks = field<{ title: string; due?: string; done?: boolean }>(await read("tasks", "list_tasks", {}, ctx), "tasks").filter((t) => !t.done);
          const items: Item[] = tasks.map((t) => ({
            title: t.title,
            why: !t.due ? "open" : t.due <= clock.day ? "unfinished today" : t.due === date ? "due that day" : `due ${t.due}`,
            rank: !t.due ? 3 : t.due <= clock.day ? 0 : t.due === date ? 1 : 2,
          }));
          // Today's drafts that never went out, from the receipts.
          const today = receiptsIn(sessionEvents(deps.log, ctx.session)).filter((r) => localClock(new Date(r.at), tz).day === clock.day);
          for (const r of today) {
            if (r.namespace === "gmail" && r.tool === "create_draft" && r.undoneBy === undefined) {
              items.push({ title: `Finish: ${r.summary.replace(/^Drafted: /, "")}`.slice(0, 120), why: "drafted today, not sent", rank: 0 });
            }
          }

          const blocks = proposeBlocks(date, busy, items, { dayStart, dayEnd, focusMinutes: a.focus_minutes ?? 120 });
          const create = deps.tools.resolve("create_event", "calendar");
          if (!create || create.tool.tier !== "write") throw new Error("calendar.create_event isn't available");

          const created: Array<Block & { event_id: string; receipt_id: number }> = [];
          for (const b of blocks) {
            // Title, start and end only: create_event sends no invitations, and the planner never adds attendees.
            const result = (await create.tool.run({ title: b.title, start: b.start, end: b.end }, ctx)) as { event_id?: string; link?: string };
            if (!result?.event_id) continue;
            const receipt = deps.log.append(ctx.session, "receipt", {
              app: create.ns.app,
              namespace: "calendar",
              tool: "create_event",
              tier: "write",
              summary: `Planned "${b.title}" ${b.start.slice(11)}–${b.end.slice(11)} on ${date}`,
              undo: { namespace: "calendar", tool: "delete_event", args: { event_id: result.event_id } },
              link: /^https:\/\//.test(result.link ?? "") ? result.link : null,
              by: "planner.plan_tomorrow",
            });
            created.push({ ...b, event_id: result.event_id, receipt_id: receipt.id });
          }
          return {
            date,
            existing: events.length,
            considered: items.map((i) => ({ title: i.title, why: i.why })),
            created: created.map((c) => ({ title: c.title, start: c.start, end: c.end, kind: c.kind })),
            invited: 0,
            note: created.length ? "Each block has its own Undo. Nobody was invited." : "No free time to plan in.",
          };
        },
      },
    ],
  };
}
