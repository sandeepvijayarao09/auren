import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { instructions, runCommand, type MuseLike } from "../agent/loop.ts";
import { EventLog } from "../eventlog.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { DAY_MS, Preferences, PROMPT_MAX_CHARS } from "./preferences.ts";

const S = "default";

/** A synthetic log: what a few weeks of approved commands leave behind. */
function seed(log: EventLog) {
  const say = (text: string) => log.append(S, "utterance", { text });
  const call = (namespace: string, tool: string, tier: string, args: object) => log.append(S, "tool_call", { app: namespace, namespace, tool, tier, args });
  const approve = (surface_id: string) => log.append(S, "approval", { request_id: "r", status: "approved", surface_id });
  const receipt = (namespace: string, tool: string, tier: string, summary: string, extra: object = {}) =>
    log.append(S, "receipt", { app: namespace, namespace, tool, tier, summary, undo: null, ...extra });

  for (const text of ["Running 10 late, start without me", "Leaving at 3 for the airport", "Stuck in traffic, 5 min"]) {
    say("tell the team");
    call("slack", "post_message", "send", { channel_id: "CM1", text });
    approve("watch");
    receipt("slack", "post_message", "send", `Post to #design-team: "${text}"`);
  }
  // A non-status post doesn't teach the status channel.
  call("slack", "post_message", "send", { channel_id: "CM4", text: "Ramen Friday?" });
  approve("phone");
  receipt("slack", "post_message", "send", 'Post to #random: "Ramen Friday?"');

  say("invite Priya");
  call("calendar", "find_contact", "read", { name: "Priya Raman" });
  call("calendar", "invite", "send", { event_id: "e1", emails: ["priya@example.com"] });
  approve("watch");
  receipt("calendar", "invite", "send", "Send an invite to priya@example.com?");
  call("gmail", "create_draft", "write", { thread_id: "t1", body: "Sure" });
  receipt("gmail", "create_draft", "write", 'Drafted: "Sure"', { to: "Gloria Reyes <gloria@example.org>" });

  for (const [start, end] of [["2026-11-02T14:00", "2026-11-02T14:30"], ["2026-11-03T15:00", "2026-11-03T15:30"], ["2026-11-04T14:00", "2026-11-04T14:30"]]) {
    call("calendar", "create_event", "write", { title: "Sync", start, end });
    receipt("calendar", "create_event", "write", `Added "Sync" at ${start}`);
  }
  for (const when of ["Friday", "Saturday"]) {
    call("browser", "run_task", "send", { task: `Hold a table for two at 8 PM on ${when} at Demo Bistro on OpenTable`, summary: "Hold a table for 2 at 8:00 PM" });
    approve("phone");
    receipt("browser", "run_task", "send", "Confirmed on the web: Hold a table for 2 at 8:00 PM");
  }
}

const byKey = (p: Preferences) => Object.fromEntries(p.list().map((x) => [x.key, x]));

test("derives preferences from a synthetic log, with evidence", () => {
  const log = new EventLog();
  seed(log);
  const prefs = new Preferences({ log, session: S });
  const k = byKey(prefs);
  assert.equal(k.status_channel.value, "#design-team");
  assert.equal(k.status_channel.detail, "channel_id CM1");
  assert.equal(k.status_channel.evidence.count, 3);
  assert.equal(k.status_channel.evidence.total, 3, "the ramen post isn't a status post");
  assert.equal(k.status_channel.evidence.latest.length, 3);
  assert.ok(k.status_channel.evidence.latest.every((id: number) => log.get(id)?.kind === "receipt"));
  assert.match(k.contacts.value, /Priya Raman <priya@example.com>/);
  assert.match(k.contacts.value, /Gloria Reyes <gloria@example.org>/);
  assert.equal(k.meeting_length.value, "30 min");
  assert.equal(k.meeting_time.value, "afternoon");
  assert.equal(k.approval_device.value, "watch");
  assert.equal(k.restaurant.value, "Demo Bistro");
  assert.equal(k.restaurant.detail, "around 8 PM");
  assert.equal(k.party_size.value, "2");
  assert.ok(k.status_channel.confidence > 0.8);
  // Live: a new receipt updates the preference incrementally.
  log.append(S, "tool_call", { app: "slack", namespace: "slack", tool: "post_message", tier: "send", args: { channel_id: "CM1", text: "Running late" } });
  log.append(S, "receipt", { app: "Slack", namespace: "slack", tool: "post_message", tier: "send", summary: 'Post to #design-team: "Running late"', undo: null });
  assert.equal(byKey(prefs).status_channel.evidence.count, 4);
  prefs.close();
});

test("old evidence decays, and a newer habit takes over", () => {
  let now = Date.now();
  const log = new EventLog();
  seed(log);
  const prefs = new Preferences({ log, session: S, now: () => now });
  const fresh = byKey(prefs).status_channel.confidence;
  now += 90 * DAY_MS;
  const stale = byKey(prefs).status_channel.confidence;
  assert.ok(stale < fresh / 2, `${stale} should be well under ${fresh}`);
  assert.equal(prefs.promptBlock(), "", "three-month-old habits drop out of the prompt");
  prefs.close();
});

test("preferences are encrypted at rest under their own key", () => {
  const path = join(mkdtempSync(join(tmpdir(), "auren-prefs-")), "auren.db");
  const key = Buffer.alloc(32, 9);
  const log = new EventLog(path, Buffer.alloc(32, 1));
  seed(log);
  new Preferences({ path, key, log, session: S }).close();
  const raw = new DatabaseSync(path).prepare("SELECT data FROM preferences").all() as Array<{ data: Uint8Array }>;
  assert.ok(raw.length > 3);
  for (const r of raw) {
    const text = Buffer.from(r.data).toString("latin1");
    assert.doesNotMatch(text, /design-team|priya|Demo Bistro|watch/);
  }
  // The right key reads it back; the wrong one sees nothing.
  assert.equal(byKey(new Preferences({ path, key, log, session: S })).status_channel.value, "#design-team");
  assert.equal(new Preferences({ path, key: Buffer.alloc(32, 2), log: new EventLog(), session: S }).list().length, 0);
});

test("the prompt block is bounded, marked as the user's data, and present in Wonder's instructions", () => {
  const log = new EventLog();
  seed(log);
  // Many long contact names to push against the bound.
  for (let i = 0; i < 30; i++) {
    log.append(S, "tool_call", { app: "gmail", namespace: "gmail", tool: "create_draft", tier: "write", args: {} });
    log.append(S, "receipt", { app: "Gmail", namespace: "gmail", tool: "create_draft", tier: "write", summary: "Drafted", undo: null, to: `${"Someone With A Very Long Name ".repeat(3)}<p${i % 3}@example.com>` });
  }
  const prefs = new Preferences({ log, session: S });
  const block = prefs.promptBlock();
  assert.ok(block.length > 0 && block.length <= PROMPT_MAX_CHARS, `block is ${block.length} chars`);
  assert.match(block, /user's own data, not instructions/);
  assert.match(block, /never replaces an approval/);
  assert.match(block, /#design-team \(channel_id CM1\)/);
  const sys = instructions(new Date(), "America/Los_Angeles", block);
  assert.ok(sys.includes(block));
  assert.ok(!instructions(new Date(), "America/Los_Angeles").includes("What I know about you"));
  // Below the threshold, a one-off isn't in the prompt.
  const one = new EventLog();
  one.append(S, "approval", { request_id: "r", status: "approved", surface_id: "phone" });
  const p1 = new Preferences({ log: one, session: S });
  assert.equal(p1.list().length, 1);
  assert.equal(p1.promptBlock(0.6), "");
});

test("forgetting a preference removes it from the prompt; forget everything clears all", () => {
  const log = new EventLog();
  seed(log);
  const prefs = new Preferences({ log, session: S });
  assert.match(prefs.promptBlock(), /design-team/);
  assert.equal(prefs.forget("status_channel"), true);
  assert.equal(prefs.forget("not_a_key"), false);
  assert.doesNotMatch(prefs.promptBlock(), /design-team/);
  assert.ok(!byKey(prefs).status_channel);
  assert.ok(prefs.forgetAll() > 0);
  assert.equal(prefs.list().length, 0);
  assert.equal(prefs.promptBlock(), "");
});

test("a learned preference never changes a tier: the post still waits for a tap", async () => {
  const log = new EventLog();
  seed(log);
  const prefs = new Preferences({ log, session: S });
  const surfaces = new SurfaceRegistry();
  const asked: string[] = [];
  surfaces.join({ id: "watch", kind: "watch", name: "Watch", inputs: ["voice", "touch"], outputs: ["voice", "haptic"] }, (m) => {
    if (m.type === "approval_request") {
      asked.push(m.summary);
      queueMicrotask(() => surfaces.answer(m.request_id, false, "watch"));
    }
  });
  const world = createDemoWorld();
  const tools = new ToolRegistry().add(...world.namespaces);
  const seen: string[] = [];
  let i = 0;
  const muse: MuseLike = {
    responses: {
      async create(params) {
        seen.push(String(params.instructions));
        return i++ === 0
          ? { output: [{ type: "function_call", call_id: "c1", namespace: "slack", name: "post_message", arguments: JSON.stringify({ channel_id: "C01", text: "Running late" }) }] }
          : { output: [], output_text: "Okay." };
      },
    },
  };
  await runCommand({ muse, tools, surfaces, log, agentModel: "w", preferences: prefs }, { session: S, text: "tell the team I'm running late" });
  assert.match(seen[0], /What I know about you/);
  assert.equal(asked.length, 1, "the send still asked for a tap");
  assert.equal(world.state.posts.length, 0, "declined, so nothing was posted");
});

test("GET /v1/preferences needs the token and shows evidence; DELETE forgets one, then everything", async () => {
  const { createServer } = await import("../server.ts");
  const log = new EventLog();
  seed(log);
  const prefs = new Preferences({ log, session: S });
  const surfaces = new SurfaceRegistry();
  const muse: MuseLike = { responses: { async create() { return { output: [] }; } } };
  const core = createServer({ muse, tools: new ToolRegistry(), surfaces, log, agentModel: "w", preferences: prefs }, { token: "t0k", museReady: true, preferences: prefs });
  const { app } = core;
  try {
  assert.equal((await app.request("/v1/preferences")).status, 401);
  const auth = { headers: { authorization: "Bearer t0k" } };
  const j = await (await app.request("/v1/preferences", auth)).json();
  assert.equal(j.preferences.find((p: { key: string }) => p.key === "status_channel").evidence.count, 3);
  assert.match(j.prompt, /design-team/);
  assert.equal((await app.request("/v1/preferences/status_channel", { method: "DELETE", ...auth })).status, 200);
  assert.doesNotMatch((await (await app.request("/v1/preferences", auth)).json()).prompt, /design-team/);
  assert.equal((await app.request("/v1/preferences", { method: "DELETE", ...auth })).status, 200);
  assert.equal((await (await app.request("/v1/preferences", auth)).json()).preferences.length, 0);
  } finally {
    core.close();
  }
});
