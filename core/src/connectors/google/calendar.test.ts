import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContext } from "../../tools/types.ts";
import { createGoogleCalendar, normalizeLocal, offsetOn, toLocal, type GoogleApi } from "./calendar.ts";

const TZ = "America/Los_Angeles";
const ctx = {} as ToolContext;

/** A fake Google: records every call and answers from a handler. */
function fakeGoogle(handler: (url: URL, init: RequestInit) => unknown) {
  const calls: Array<{ url: URL; method: string; body?: any }> = [];
  const google: GoogleApi = {
    async json(url: string, init: RequestInit = {}) {
      const u = new URL(url);
      calls.push({ url: u, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
      return handler(u, init) as any;
    },
  };
  return { google, calls };
}
const tool = (google: GoogleApi, name: string) => createGoogleCalendar(google, { timeZone: TZ }).tools.find((t) => t.name === name)!;

test("time helpers speak local wall-clock time", () => {
  assert.equal(toLocal({ dateTime: "2026-10-31T22:00:00Z" }, TZ), "2026-10-31T15:00");
  assert.equal(toLocal({ date: "2026-10-31" }, TZ), "2026-10-31");
  assert.equal(offsetOn("2026-10-31", TZ), "-07:00");
  assert.equal(offsetOn("2026-11-02", TZ), "-08:00");
  assert.equal(offsetOn("2026-11-02", "Asia/Kolkata"), "+05:30");
  assert.equal(normalizeLocal("2026-10-31T15:15:00", TZ), "2026-10-31T15:15");
  assert.equal(normalizeLocal("2026-10-31T22:15:00Z", TZ), "2026-10-31T15:15");
  assert.throws(() => normalizeLocal("3:15pm", TZ), /local ISO/);
});

test("list_events asks for the whole local day and returns local times", async () => {
  const { google, calls } = fakeGoogle(() => ({
    items: [
      { id: "e1", summary: "Office hours", start: { dateTime: "2026-10-31T15:00:00-07:00" }, end: { dateTime: "2026-10-31T16:00:00-07:00" }, attendees: [{ email: "me@x.com", self: true }, { email: "lee@example.edu" }], htmlLink: "https://cal/e1" },
      { id: "e2", summary: "Gone", status: "cancelled", start: { dateTime: "2026-10-31T09:00:00-07:00" } },
    ],
  }));
  const t = tool(google, "list_events");
  assert.equal(t.external, true);
  const res = await t.run({ date: "2026-10-31" }, ctx);
  assert.equal(calls[0].url.searchParams.get("timeMin"), "2026-10-31T00:00:00-07:00");
  assert.equal(calls[0].url.searchParams.get("singleEvents"), "true");
  assert.deepEqual(res.events, [{ id: "e1", title: "Office hours", start: "2026-10-31T15:00", end: "2026-10-31T16:00", attendees: ["lee@example.edu"], link: "https://cal/e1" }]);
});

test("move_event keeps the duration, emails nobody and can be undone", async () => {
  const { google, calls } = fakeGoogle((_u, init) =>
    init.method === "PATCH"
      ? { id: "e1", htmlLink: "https://cal/e1" }
      : { id: "e1", summary: "Office hours", start: { dateTime: "2026-10-31T15:00:00-07:00" }, end: { dateTime: "2026-10-31T16:30:00-07:00" }, attendees: [{ email: "lee@example.edu" }] },
  );
  const t = tool(google, "move_event");
  const args = { event_id: "e1", new_start: "2026-10-31T15:15" };
  const res = await t.run(args, ctx);
  const patch = calls[1];
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url.searchParams.get("sendUpdates"), "none");
  assert.deepEqual(patch.body, { start: { dateTime: "2026-10-31T15:15:00", timeZone: TZ }, end: { dateTime: "2026-10-31T16:45:00", timeZone: TZ } });
  assert.equal(res.attendees_not_notified, 1);
  assert.equal(t.summarize!(args, res), 'Moved "Office hours" to 15:15');
  assert.deepEqual(t.undo!(args, res), { namespace: "calendar", tool: "move_event", args: { event_id: "e1", new_start: "2026-10-31T15:00" } });
  assert.equal(t.proof!(args, res), "https://cal/e1");
});

test("create_event defaults to an hour and undoes by deleting", async () => {
  const { google, calls } = fakeGoogle(() => ({ id: "new1", htmlLink: "https://cal/new1" }));
  const t = tool(google, "create_event");
  const args = { title: "Demo night", start: "2026-11-05T18:00", location: "Room 214" };
  const res = await t.run(args, ctx);
  assert.equal(calls[0].url.searchParams.get("sendUpdates"), "none");
  assert.deepEqual(calls[0].body.end, { dateTime: "2026-11-05T19:00:00", timeZone: TZ });
  assert.deepEqual(t.undo!(args, res), { namespace: "calendar", tool: "delete_event", args: { event_id: "new1" } });
});

test("invite is the only send-tier tool, and it notifies", async () => {
  const { google, calls } = fakeGoogle((_u, init) => (init.method === "PATCH" ? { htmlLink: "https://cal/e1" } : { attendees: [{ email: "Priya@example.com" }] }));
  const ns = createGoogleCalendar(google, { timeZone: TZ });
  assert.deepEqual(ns.tools.filter((t) => t.tier === "send").map((t) => t.name), ["invite"]);
  const t = tool(google, "invite");
  await t.run({ event_id: "e1", emails: ["priya@example.com", "lee@example.edu"] }, ctx);
  assert.equal(calls[1].url.searchParams.get("sendUpdates"), "all");
  assert.deepEqual(calls[1].body.attendees.map((a: { email: string }) => a.email), ["Priya@example.com", "lee@example.edu"]);
  await assert.rejects(t.run({ event_id: "e1", emails: ["priya"] }, ctx), /Not email addresses/);
  assert.equal(t.summarize!({ emails: ["a@b.co"] }), "Send an invite to a@b.co?");
});

test("delete_event treats an already-deleted event as done", async () => {
  const { google } = fakeGoogle(() => {
    throw Object.assign(new Error("Google 410: Resource has been deleted"), { status: 410 });
  });
  assert.deepEqual(await tool(google, "delete_event").run({ event_id: "e1" }, ctx), { ok: false, reason: "already gone" });
});

test("find_contact warms up once, then returns names with emails", async () => {
  const { google, calls } = fakeGoogle((u) =>
    u.searchParams.get("query") ? { results: [{ person: { names: [{ displayName: "Priya Raman" }], emailAddresses: [{ value: "priya@example.com" }] } }, { person: { names: [{ displayName: "No Email" }] } }] } : {},
  );
  const t = tool(google, "find_contact");
  assert.deepEqual(await t.run({ name: "Priya" }, ctx), { matches: [{ name: "Priya Raman", email: "priya@example.com" }] });
  await t.run({ name: "Lee" }, ctx);
  assert.equal(calls.filter((c) => c.url.searchParams.get("query") === "").length, 1);
});
