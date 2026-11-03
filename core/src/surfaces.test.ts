import assert from "node:assert/strict";
import { test } from "node:test";
import type { Manifest, ServerMessage } from "./protocol.ts";
import { SurfaceRegistry } from "./surfaces.ts";

const watch: Manifest = { id: "watch", kind: "watch", name: "Watch", inputs: ["voice", "touch"], outputs: ["voice", "haptic", "screen"] };
const phone: Manifest = { id: "phone", kind: "phone", name: "Phone", inputs: ["voice", "touch", "camera"], outputs: ["voice", "screen"] };
const glasses: Manifest = { id: "glasses", kind: "glasses", name: "Glasses", inputs: ["voice", "camera"], outputs: ["voice"] };

function setup() {
  let t = 0;
  const events: Array<[string, Record<string, unknown>]> = [];
  const reg = new SurfaceRegistry({ now: () => t, presenceTimeoutMs: 3000, onEvent: (k, d) => events.push([k, d]) });
  const inbox: Record<string, ServerMessage[]> = {};
  const join = (m: Manifest) => {
    inbox[m.id] = [];
    reg.join(m, (msg) => inbox[m.id].push(msg));
  };
  return { reg, inbox, events, join, tick: (ms: number) => (t += ms) };
}

test("approvals go to the haptic surface first", async () => {
  const { reg, inbox, join } = setup();
  join(phone);
  join(watch);
  const p = reg.requestApproval("Post to #office-hours?", "send", 10_000);
  const req = inbox.watch.find((m) => m.type === "approval_request");
  assert.ok(req, "watch got the request");
  assert.equal(inbox.phone.some((m) => m.type === "approval_request"), false);
  reg.answer((req as { request_id: string }).request_id, true, "watch");
  assert.equal(await p, true);
});

test("handoff: a pending approval moves when its surface goes offline", async () => {
  const { reg, inbox, events, join, tick } = setup();
  join(phone);
  join(watch);
  const p = reg.requestApproval("Send invite to Priya?", "send", 60_000);
  const id = (inbox.watch.find((m) => m.type === "approval_request") as { request_id: string }).request_id;

  // The watch stops sending heartbeats; the phone keeps going.
  tick(2000);
  reg.heartbeat("phone", true);
  tick(2000);
  reg.heartbeat("phone", true);
  reg.sweep();

  assert.ok(inbox.watch.some((m) => m.type === "approval_cancel" && m.reason === "moved"));
  assert.ok(inbox.phone.some((m) => m.type === "approval_request" && m.request_id === id));
  assert.ok(events.some(([k, d]) => k === "handoff" && d.from === "watch" && d.to === "phone"));
  reg.answer(id, true, "phone");
  assert.equal(await p, true);
});

test("speech returns to the surface the person spoke from", () => {
  const { reg, join } = setup();
  join(phone);
  join(glasses);
  assert.equal(reg.speak("On it.", "glasses"), "glasses");
});

test("speech falls back to the most recently active voice surface", () => {
  const { reg, join, tick } = setup();
  join(phone);
  join(watch);
  tick(1000);
  reg.heartbeat("phone", false);
  reg.heartbeat("watch", true);
  assert.equal(reg.speak("Done.", "glasses-that-left"), "watch");
});

test("cards prefer the phone screen", () => {
  const { reg, join } = setup();
  join(watch);
  join(phone);
  assert.equal(reg.showCard("Table held", "8 PM, 2 people"), "phone");
});

test("an approval with no surface waits for one to join", async () => {
  const { reg, inbox, join } = setup();
  const p = reg.requestApproval("Post?", "send", 10_000);
  join(watch);
  const req = inbox.watch.find((m) => m.type === "approval_request") as { request_id: string };
  assert.ok(req);
  reg.answer(req.request_id, false, "watch");
  assert.equal(await p, false);
});

test("replies are split into sentences, short ones merged and long ones wrapped", async () => {
  const { splitSpeech } = await import("./surfaces.ts");
  assert.deepEqual(splitSpeech("On it. Moved your 3 PM to 3:15. Reply to Prof. Lee is drafted."), ["On it. Moved your 3 PM to 3:15.", "Reply to Prof. Lee is drafted."]);
  const long = splitSpeech(`${"word ".repeat(80)}end.`, 100);
  assert.ok(long.length >= 4 && long.every((c) => c.length <= 100));
  assert.deepEqual(splitSpeech("   "), []);
});

test("GP3: glasses come off mid-reply and the rest plays on the watch within 2 seconds", () => {
  const { reg, inbox, events, join, tick } = setup();
  join(glasses);
  join(watch);
  join(phone);
  assert.equal(reg.heartbeatMsFor("glasses"), 500);
  assert.equal(reg.heartbeatMsFor("watch"), 1000);

  reg.speak("Your afternoon has three things. Office hours at 3:15. Thesis sync with Prof. Lee at 5:30.", "glasses");
  const sent = inbox.glasses.filter((m) => m.type === "speak") as Array<{ reply_id: string; seq: number; text: string; final: boolean }>;
  assert.equal(sent.length, 3);
  assert.equal(sent.at(-1)?.final, true);
  reg.progress(sent[0].reply_id, 0, "glasses");

  // The glasses go silent. Everything else keeps beating, and Core sweeps every 500 ms.
  let elapsed = 0;
  while (!events.some(([k, d]) => k === "handoff" && d.what === "speech") && elapsed < 5000) {
    tick(500);
    elapsed += 500;
    reg.heartbeat("watch", true);
    reg.heartbeat("phone", false);
    reg.sweep();
  }
  assert.ok(elapsed <= 2000, `moved after ${elapsed} ms`);
  const moved = inbox.watch.filter((m) => m.type === "speak") as Array<{ reply_id: string; seq: number; text: string }>;
  assert.deepEqual(moved.map((m) => m.seq), [1, 2]);
  assert.equal(moved[0].text, "Office hours at 3:15.");
  const handoff = events.find(([k, d]) => k === "handoff" && d.what === "speech")?.[1];
  assert.deepEqual([handoff?.from, handoff?.to, handoff?.remaining], ["glasses", "watch", 2]);
});

test("a finished reply doesn't move, and progress counts only from the surface playing it", () => {
  const { reg, inbox, events, join, tick } = setup();
  join(glasses);
  join(watch);
  reg.speak("Done. Posted in office hours.", "glasses");
  const [first] = inbox.glasses.filter((m) => m.type === "speak") as Array<{ reply_id: string; seq: number }>;
  reg.progress(first.reply_id, 0, "watch");
  reg.progress(first.reply_id, 0, "glasses");
  tick(2000);
  reg.heartbeat("watch", true);
  reg.sweep();
  assert.equal(events.some(([k, d]) => k === "handoff" && d.what === "speech"), false);
  assert.equal(inbox.watch.some((m) => m.type === "speak"), false);
});

// R12: approval verbs.
test("approval_request carries the tool's verb, and leaves it out when there is none", async () => {
  const { reg, inbox, join, tick } = setup();
  join(watch);
  const post = reg.requestApproval("Post to #office-hours: \"Running 15 late\"", "send", 10_000, "Post");
  const plain = reg.requestApproval("Book a table for two?", "send", 10_000);
  const [withVerb, without] = inbox.watch.filter((m) => m.type === "approval_request") as Array<Record<string, unknown>>;
  assert.equal(withVerb.verb, "Post");
  assert.equal("verb" in without, false, "a v0 surface sees the same message as before");

  // The verb travels with the request when it moves to another surface.
  join(phone);
  tick(4000);
  reg.heartbeat("phone", true);
  reg.sweep();
  const moved = inbox.phone.find((m) => m.type === "approval_request" && m.request_id === withVerb.request_id) as Record<string, unknown>;
  assert.equal(moved?.verb, "Post");
  reg.answer(String(withVerb.request_id), true, "phone");
  reg.answer(String(without.request_id), false, "phone");
  assert.deepEqual([await post, await plain], [true, false]);
});
