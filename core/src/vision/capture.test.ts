// Capture routing: which camera Core asks, and which frames it takes.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Manifest, ServerMessage } from "../protocol.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { CaptureBroker, CaptureError } from "./capture.ts";
import { posterJpeg } from "./test-frames.ts";

const glasses: Manifest = { id: "glasses", kind: "glasses", name: "Ray-Ban Meta", inputs: ["voice", "camera"], outputs: ["voice"] };
const phone: Manifest = { id: "phone", kind: "phone", name: "iPhone", inputs: ["voice", "text", "touch", "camera"], outputs: ["voice", "screen"] };
const watch: Manifest = { id: "watch", kind: "watch", name: "Apple Watch", inputs: ["voice", "text", "touch"], outputs: ["voice", "haptic", "screen"] };

function setup(timeoutMs = 1_000) {
  let t = 0;
  const surfaces = new SurfaceRegistry({ now: () => t });
  const broker = new CaptureBroker(surfaces, { timeoutMs });
  const inbox: Record<string, ServerMessage[]> = {};
  const join = (m: Manifest) => {
    inbox[m.id] = [];
    surfaces.join(m, (msg) => inbox[m.id].push(msg));
  };
  const asked = (id: string) => inbox[id].filter((m) => m.type === "capture_request") as Array<{ request_id: string; purpose: string }>;
  return { surfaces, broker, join, asked, tick: (ms: number) => (t += ms) };
}

test("the glasses are asked before the phone, even when the phone is in your hand", () => {
  const { surfaces, broker, join, asked } = setup();
  join(phone);
  join(glasses);
  join(watch);
  surfaces.heartbeat("phone", true);
  surfaces.heartbeat("glasses", false);
  void broker.request("the event on this poster").catch(() => {});
  assert.equal(asked("glasses").length, 1);
  assert.equal(asked("glasses")[0].purpose, "the event on this poster");
  assert.equal(asked("phone").length, 0);
});

test("with the glasses off, the phone camera is asked (plan B), and never a surface without one", async () => {
  const { surfaces, broker, join, asked, tick } = setup();
  join(glasses);
  join(phone);
  join(watch);
  tick(2_000);
  surfaces.heartbeat("phone", true);
  surfaces.heartbeat("watch", true);
  tick(2_000); // the glasses went quiet 4 s ago
  const pending = broker.request("look");
  const [req] = asked("phone");
  assert.ok(req, "the phone was asked");
  assert.equal(asked("glasses").length, 0);
  assert.equal(broker.deliver(req.request_id, "phone", posterJpeg()), "accepted");
  assert.equal((await pending).kind, "phone");
});

test("no camera online: the request fails at once", async () => {
  const { broker, join } = setup();
  join(watch);
  await assert.rejects(broker.request("look"), (err: Error) => err instanceof CaptureError && /No camera is online/.test(err.message));
});

test("a frame is taken only for a request Core made, and only from the surface it asked", async () => {
  const { broker, join, asked } = setup();
  join(glasses);
  join(phone);
  const pending = broker.request("look");
  const id = asked("glasses")[0].request_id;
  const frame = posterJpeg();

  assert.equal(broker.deliver("not-a-request", "glasses", frame), "unknown");
  assert.equal(broker.deliver(id, "phone", frame), "wrong_surface");
  assert.equal(broker.target(id), "glasses", "a wrong sender doesn't cancel the request");
  assert.equal(broker.deliver(id, "glasses", frame), "accepted");
  assert.equal(broker.deliver(id, "glasses", frame), "unknown", "a request takes one frame");
  const got = await pending;
  assert.deepEqual([got.surfaceId, got.kind, got.jpeg.equals(frame)], ["glasses", "glasses", true]);
});

test("a camera that never answers times out, and a late frame is refused", async () => {
  const { broker, join, asked } = setup(40);
  join(glasses);
  const pending = broker.request("look");
  const id = asked("glasses")[0].request_id;
  await assert.rejects(pending, /glasses didn't send a frame within 0\.?\d* s/);
  assert.equal(broker.target(id), undefined);
  assert.equal(broker.deliver(id, "glasses", posterJpeg()), "unknown");
});
