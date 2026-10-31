// Google Calendar as the `calendar` namespace. Same tools and arguments as the
// demo world, so the agent loop, the tests and the eval cases don't change.
// Moves and new events never email anyone (sendUpdates=none); only `invite`
// notifies people, which is why it is the one send-tier tool here.
import type { Namespace, ToolSpec } from "../../tools/types.ts";
import { params } from "../../tools/types.ts";
import type { GoogleAuth } from "./auth.ts";

export type GoogleApi = Pick<GoogleAuth, "json">;

const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const PEOPLE = "https://people.googleapis.com/v1/people:searchContacts";

interface GTime { dateTime?: string; date?: string; timeZone?: string }
interface GEvent {
  id: string;
  summary?: string;
  status?: string;
  location?: string;
  htmlLink?: string;
  start?: GTime;
  end?: GTime;
  attendees?: Array<{ email: string; self?: boolean }>;
}

/** A Google time as local wall-clock ISO in `timeZone`: "2026-10-31T15:00". All-day events stay "2026-10-31". */
export function toLocal(t: GTime | undefined, timeZone: string): string {
  if (!t?.dateTime) return t?.date ?? "";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(t.dateTime))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The zone's UTC offset around noon on `date`, as "-07:00" or "+05:30". */
export function offsetOn(date: string, timeZone: string): string {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(`${date}T12:00:00Z`))
    .find((x) => x.type === "timeZoneName")?.value ?? "GMT";
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] ?? "00"}` : "+00:00";
}

/** Accepts what the model sends ("2026-10-31T15:15", with seconds, or with an offset) and returns local "YYYY-MM-DDTHH:MM". */
export function normalizeLocal(value: string, timeZone: string): string {
  const v = value.trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) return v.slice(0, 16);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}.*(Z|[+-]\d{2}:?\d{2})$/.test(v)) return toLocal({ dateTime: v }, timeZone);
  throw new Error(`"${value}" isn't a time I can use. Send local ISO like 2026-10-31T15:15.`);
}

const addMinutes = (local: string, minutes: number) => new Date(Date.parse(`${local}:00Z`) + minutes * 60_000).toISOString().slice(0, 16);
const hhmm = (local: string) => local.slice(11, 16);
const enc = encodeURIComponent;

export function createGoogleCalendar(google: GoogleApi, opts: { timeZone: string }): Namespace {
  const tz = opts.timeZone;
  const at = (local: string) => ({ dateTime: `${local}:00`, timeZone: tz });
  const view = (e: GEvent) => ({
    id: e.id,
    title: e.summary ?? "(no title)",
    start: toLocal(e.start, tz),
    end: toLocal(e.end, tz),
    ...(e.location ? { location: e.location } : {}),
    attendees: (e.attendees ?? []).filter((a) => !a.self).map((a) => a.email),
    link: e.htmlLink,
  });
  let contactsWarm = false;

  const moveEvent: ToolSpec<{ event_id: string; new_start: string }> = {
    name: "move_event",
    description: "Move a calendar event to a new start time (local ISO, e.g. 2026-10-31T15:15). Keeps its duration. Attendees are not emailed.",
    parameters: params({ event_id: { type: "string" }, new_start: { type: "string" } }),
    tier: "write",
    deferred: true,
    async run({ event_id, new_start }) {
      const e = await google.json<GEvent>(`${EVENTS}/${enc(event_id)}`);
      if (!e.start?.dateTime || !e.end?.dateTime) throw new Error(`"${e.summary}" is an all-day event; Auren only moves timed events.`);
      const start = normalizeLocal(new_start, tz);
      const end = addMinutes(start, (Date.parse(e.end.dateTime) - Date.parse(e.start.dateTime)) / 60_000);
      const before = toLocal(e.start, tz);
      const updated = await google.json<GEvent>(`${EVENTS}/${enc(event_id)}?sendUpdates=none`, {
        method: "PATCH",
        body: JSON.stringify({ start: at(start), end: at(end) }),
      });
      return { ok: true, event_id, title: e.summary, before, start, link: updated.htmlLink, attendees_not_notified: view(e).attendees.length };
    },
    summarize: (a, r) => `Moved "${r?.title ?? a.event_id}" to ${hhmm(r?.start ?? a.new_start)}`,
    undo: (a, r) => ({ namespace: "calendar", tool: "move_event", args: { event_id: a.event_id, new_start: r.before } }),
    proof: (_a, r) => r?.link,
  };

  return {
    name: "calendar",
    app: "Google Calendar",
    description: "The user's Google Calendar: list, move and create events, and invite people.",
    tools: [
      {
        name: "list_events",
        description: "List the user's events on a date (YYYY-MM-DD).",
        parameters: params({ date: { type: "string" } }),
        tier: "read",
        // Titles and places can come from other people's invitations.
        external: true,
        async run({ date }: { date: string }) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`"${date}" isn't a date. Send YYYY-MM-DD.`);
          const off = offsetOn(date, tz);
          const q = new URLSearchParams({
            timeMin: `${date}T00:00:00${off}`,
            timeMax: `${date}T23:59:59${off}`,
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "50",
            timeZone: tz,
          });
          const res = await google.json<{ items?: GEvent[] }>(`${EVENTS}?${q}`);
          return { events: (res.items ?? []).filter((e) => e.status !== "cancelled").map(view) };
        },
      },
      moveEvent,
      {
        name: "create_event",
        description: "Create an event on the user's calendar. No invitations are sent. Without an end, it lasts an hour.",
        parameters: params({ title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" } }, ["end", "location"]),
        tier: "write",
        deferred: true,
        async run(a: { title: string; start: string; end?: string; location?: string }) {
          const start = normalizeLocal(a.start, tz);
          const end = a.end ? normalizeLocal(a.end, tz) : addMinutes(start, 60);
          const e = await google.json<GEvent>(`${EVENTS}?sendUpdates=none`, {
            method: "POST",
            body: JSON.stringify({ summary: a.title, ...(a.location ? { location: a.location } : {}), start: at(start), end: at(end) }),
          });
          return { ok: true, event_id: e.id, link: e.htmlLink };
        },
        summarize: (a: { title: string; start: string }) => `Added "${a.title}" at ${a.start.replace("T", " ").slice(0, 16)}`,
        undo: (_a, r: { event_id: string }) => ({ namespace: "calendar", tool: "delete_event", args: { event_id: r.event_id } }),
        proof: (_a, r: { link?: string }) => r?.link,
      },
      {
        name: "invite",
        description: "Invite people (by email) to an event. Google emails them an invitation.",
        parameters: params({ event_id: { type: "string" }, emails: { type: "array", items: { type: "string" } } }),
        tier: "send",
        deferred: true,
        async run({ event_id, emails }: { event_id: string; emails: string[] }) {
          const bad = emails.filter((m) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m));
          if (bad.length) throw new Error(`Not email addresses: ${bad.join(", ")}`);
          const e = await google.json<GEvent>(`${EVENTS}/${enc(event_id)}`);
          const seen = new Set<string>();
          const attendees = [...(e.attendees ?? []), ...emails.map((email) => ({ email }))].filter((a) => {
            const k = a.email.toLowerCase();
            return seen.has(k) ? false : (seen.add(k), true);
          });
          const updated = await google.json<GEvent>(`${EVENTS}/${enc(event_id)}?sendUpdates=all`, {
            method: "PATCH",
            body: JSON.stringify({ attendees }),
          });
          return { ok: true, invited: emails, link: updated.htmlLink };
        },
        summarize: (a: { emails: string[] }, r?: unknown) => (r ? `Invited ${a.emails.join(", ")}` : `Send an invite to ${a.emails.join(", ")}?`),
        proof: (_a, r: { link?: string }) => r?.link,
      },
      {
        name: "delete_event",
        description: "Delete an event.",
        parameters: params({ event_id: { type: "string" } }),
        tier: "write",
        hidden: true,
        async run({ event_id }: { event_id: string }) {
          try {
            await google.json(`${EVENTS}/${enc(event_id)}?sendUpdates=none`, { method: "DELETE" });
            return { ok: true };
          } catch (err) {
            if ([404, 410].includes((err as { status?: number }).status ?? 0)) return { ok: false, reason: "already gone" };
            throw err;
          }
        },
        summarize: () => "Removed the event",
      },
      {
        name: "find_contact",
        description: "Look up a person's email by name in the user's Google contacts.",
        parameters: params({ name: { type: "string" } }),
        tier: "read",
        deferred: true,
        async run({ name }: { name: string }) {
          const mask = "names,emailAddresses";
          // Google asks for an empty warm-up search before the first real one.
          if (!contactsWarm) {
            await google.json(`${PEOPLE}?${new URLSearchParams({ query: "", readMask: mask })}`).catch(() => undefined);
            contactsWarm = true;
          }
          const res = await google.json<{ results?: Array<{ person?: { names?: Array<{ displayName?: string }>; emailAddresses?: Array<{ value?: string }> } }> }>(
            `${PEOPLE}?${new URLSearchParams({ query: name, readMask: mask, pageSize: "5" })}`,
          );
          const matches = (res.results ?? [])
            .map((r) => ({ name: r.person?.names?.[0]?.displayName ?? "", email: r.person?.emailAddresses?.[0]?.value ?? "" }))
            .filter((m) => m.email);
          return { matches };
        },
      },
    ],
  };
}
