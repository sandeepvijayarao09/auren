// In-memory Calendar, Slack and Gmail with fictional people. The agent runs
// end to end before any real account is connected, and the eval replays
// against it. Live connectors replace these namespaces one by one.
import type { Namespace, ToolSpec } from "./types.ts";
import { params } from "./types.ts";

interface CalEvent { id: string; title: string; start: string; end: string; location?: string; invitees: string[] }
interface Draft { id: string; thread_id: string; body: string }

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localDateTime = (d: Date) => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const today = () => localDate(new Date());

export function createDemoWorld() {
  const day = today();
  const state = {
    events: new Map<string, CalEvent>([
      ["evt_1", { id: "evt_1", title: "Office hours (CS 5800)", start: `${day}T15:00`, end: `${day}T16:00`, location: "Room 214", invitees: [] }],
      ["evt_2", { id: "evt_2", title: "Thesis sync with Prof. Lee", start: `${day}T17:30`, end: `${day}T18:00`, invitees: ["lee@example.edu"] }],
    ]),
    channels: [{ id: "C01", name: "office-hours" }, { id: "C02", name: "cs5800-tas" }, { id: "C03", name: "general" }],
    posts: [] as Array<{ channel_id: string; text: string; ts: string }>,
    threads: [{ id: "thr_9", from: "Prof. Lee <lee@example.edu>", subject: "HW3 grades?", snippet: "Hi, when will HW3 grades be posted?" }],
    drafts: new Map<string, Draft>(),
    contacts: [{ name: "Priya Raman", email: "priya@example.com" }, { name: "Prof. Lee", email: "lee@example.edu" }],
    seq: 100,
  };
  const id = (p: string) => `${p}_${++state.seq}`;

  const moveEvent: ToolSpec<{ event_id: string; new_start: string }> = {
    name: "move_event",
    description: "Move a calendar event to a new start time (local ISO, e.g. 2026-10-27T15:15). Keeps its duration.",
    parameters: params({ event_id: { type: "string" }, new_start: { type: "string" } }),
    tier: "write",
    deferred: true,
    async run({ event_id, new_start }) {
      const e = state.events.get(event_id);
      if (!e) throw new Error(`no event ${event_id}`);
      const dur = Date.parse(e.end) - Date.parse(e.start);
      const before = e.start;
      e.start = new_start;
      e.end = localDateTime(new Date(Date.parse(new_start) + dur));
      return { ok: true, event_id, title: e.title, before, start: e.start };
    },
    summarize: (a, r) => `Moved "${r?.title ?? a.event_id}" to ${a.new_start.slice(11)}`,
    undo: (a, r) => ({ namespace: "calendar", tool: "move_event", args: { event_id: a.event_id, new_start: r.before } }),
  };

  const calendar: Namespace = {
    name: "calendar",
    app: "Google Calendar",
    description: "The user's calendar: list, move and create events, and invite people.",
    tools: [
      {
        name: "list_events",
        description: "List the user's events on a date (YYYY-MM-DD).",
        parameters: params({ date: { type: "string" } }),
        tier: "read",
        async run({ date }: { date: string }) {
          return { events: [...state.events.values()].filter((e) => e.start.startsWith(date)) };
        },
      },
      moveEvent,
      {
        name: "create_event",
        description: "Create an event on the user's calendar (no invitations are sent).",
        parameters: params({ title: { type: "string" }, start: { type: "string" }, end: { type: "string" }, location: { type: "string" } }, ["end", "location"]),
        tier: "write",
        deferred: true,
        async run(a: { title: string; start: string; end?: string; location?: string }) {
          const e: CalEvent = { id: id("evt"), title: a.title, start: a.start, end: a.end ?? a.start, location: a.location, invitees: [] };
          state.events.set(e.id, e);
          return { ok: true, event_id: e.id };
        },
        summarize: (a: { title: string; start: string }) => `Added "${a.title}" at ${a.start.replace("T", " ")}`,
        undo: (_a, r: { event_id: string }) => ({ namespace: "calendar", tool: "delete_event", args: { event_id: r.event_id } }),
      },
      {
        name: "invite",
        description: "Send calendar invitations for an event to people (by email).",
        parameters: params({ event_id: { type: "string" }, emails: { type: "array", items: { type: "string" } } }),
        tier: "send",
        deferred: true,
        async run({ event_id, emails }: { event_id: string; emails: string[] }) {
          const e = state.events.get(event_id);
          if (!e) throw new Error(`no event ${event_id}`);
          e.invitees.push(...emails);
          return { ok: true, invited: emails };
        },
        summarize: (a: { emails: string[] }) => `Send an invite to ${a.emails.join(", ")}?`,
      },
      {
        name: "delete_event",
        description: "Delete an event.",
        parameters: params({ event_id: { type: "string" } }),
        tier: "write",
        hidden: true,
        async run({ event_id }: { event_id: string }) {
          return { ok: state.events.delete(event_id) };
        },
        summarize: () => "Removed the event",
      },
      {
        name: "find_contact",
        description: "Look up a person's email by name.",
        parameters: params({ name: { type: "string" } }),
        tier: "read",
        deferred: true,
        async run({ name }: { name: string }) {
          return { matches: state.contacts.filter((c) => c.name.toLowerCase().includes(name.toLowerCase())) };
        },
      },
    ],
  };

  const slack: Namespace = {
    name: "slack",
    app: "Slack",
    description: "Team chat: find channels and post messages.",
    tools: [
      {
        name: "list_channels",
        description: "List the Slack channels the user is in.",
        parameters: params({}),
        tier: "read",
        async run() {
          return { channels: state.channels };
        },
      },
      {
        name: "post_message",
        description: "Post a message to a Slack channel as the user.",
        parameters: params({ channel_id: { type: "string" }, text: { type: "string" } }),
        tier: "send",
        deferred: true,
        async run({ channel_id, text }: { channel_id: string; text: string }) {
          const ts = `${Date.now() / 1000}`;
          state.posts.push({ channel_id, text, ts });
          return { ok: true, ts };
        },
        summarize: (a: { channel_id: string; text: string }) =>
          `Post to #${state.channels.find((c) => c.id === a.channel_id)?.name ?? a.channel_id}: "${a.text}"`,
      },
    ],
  };

  const gmail: Namespace = {
    name: "gmail",
    app: "Gmail",
    description: "The user's email: search threads, draft replies, send.",
    tools: [
      {
        name: "search_threads",
        description: "Search the user's email threads.",
        parameters: params({ query: { type: "string" } }),
        tier: "read",
        external: true,
        async run({ query }: { query: string }) {
          const q = query.toLowerCase();
          const hits = state.threads.filter((t) => `${t.from} ${t.subject} ${t.snippet}`.toLowerCase().includes(q));
          return { threads: hits.length ? hits : state.threads };
        },
      },
      {
        name: "create_draft",
        description: "Create a reply draft in an email thread. Does not send.",
        parameters: params({ thread_id: { type: "string" }, body: { type: "string" } }),
        tier: "write",
        deferred: true,
        async run({ thread_id, body }: { thread_id: string; body: string }) {
          const d = { id: id("dr"), thread_id, body };
          state.drafts.set(d.id, d);
          return { ok: true, draft_id: d.id };
        },
        summarize: (a: { body: string }) => `Drafted: "${a.body.slice(0, 60)}"`,
        undo: (_a, r: { draft_id: string }) => ({ namespace: "gmail", tool: "delete_draft", args: { draft_id: r.draft_id } }),
      },
      {
        name: "delete_draft",
        description: "Delete a draft.",
        parameters: params({ draft_id: { type: "string" } }),
        tier: "write",
        hidden: true,
        async run({ draft_id }: { draft_id: string }) {
          return { ok: state.drafts.delete(draft_id) };
        },
        summarize: () => "Deleted the draft",
      },
    ],
  };

  return { state, namespaces: [calendar, slack, gmail] };
}
