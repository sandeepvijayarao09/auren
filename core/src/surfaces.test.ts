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
