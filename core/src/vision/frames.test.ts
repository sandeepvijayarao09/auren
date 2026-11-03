// POST /v1/frames over real HTTP: who may hand Core a camera frame.
// "Remote" requests carry X-Forwarded-For, which is how a tunnel reaches Core.
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import { EventLog } from "../eventlog.ts";
import type { Manifest, ServerMessage } from "../protocol.ts";
import { DeviceRegistry, framePayload } from "../security/devices.ts";
import { fakeDevice } from "../security/devices.test.ts";
import { createServer } from "../server.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { CaptureBroker, MAX_FRAME_BYTES } from "./capture.ts";
import { CropStore } from "./crops.ts";
import { posterJpeg } from "./test-frames.ts";

const log = new EventLog();
const surfaces = new SurfaceRegistry({ onEvent: (kind, data) => log.append("default", kind, data) });
const devices = new DeviceRegistry();
const frames = new CaptureBroker(surfaces, { timeoutMs: 2_000 });
const crops = new CropStore();
const core = createServer(
  { muse: { responses: { create: async () => ({ output: [] }) } }, tools: new ToolRegistry(), surfaces, log, agentModel: "muse-wonder-1.0" },
  { token: "", museReady: false, devices, vision: { frames, crops } },
);
const http = serve({ fetch: core.app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((r) => http.once("listening", r));
const port = (http.address() as AddressInfo).port;
after(() => {
  core.close();
  http.close();
});

const REMOTE = { "x-forwarded-for": "203.0.113.9" };
const cam = (id: string, kind: "glasses" | "phone"): Manifest => ({ id, kind, name: kind, inputs: ["voice", "camera"], outputs: ["voice"] });

/** Puts camera surfaces online, asks for a frame, and returns the request id Core sent. */
function capture(...cams: Manifest[]) {
  const inbox: ServerMessage[] = [];
  for (const m of cams) surfaces.join(m, (msg) => inbox.push(msg));
  const frame = frames.request("the event on this poster");
  frame.catch(() => {});
  const req = inbox.find((m) => m.type === "capture_request") as { request_id: string };
  return { id: req.request_id, frame, done: () => cams.forEach((m) => surfaces.leave(m.id)) };
}

const post = (id: string, body: Uint8Array, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/frames/${id}`, { method: "POST", headers: { "content-type": "image/jpeg", ...headers }, body: new Uint8Array(body) });

function pair(id: string, kind: string) {
  const dev = fakeDevice();
  devices.finishPairing({ code: devices.startPairing().code, id, kind, publicKey: dev.publicKey, hardware: true });
  return dev;
}

test("a paired device's signed frame is taken, from the network", async () => {
  const dev = pair("glasses-a", "glasses");
  const c = capture(cam("glasses-a", "glasses"));
  const jpeg = posterJpeg();
  const res = await post(c.id, jpeg, { ...REMOTE, "x-auren-device": "glasses-a", "x-auren-signature": dev.sign(framePayload(c.id, jpeg)) });
  assert.equal(res.status, 202);
  assert.ok((await c.frame).jpeg.equals(jpeg));
  c.done();
});

test("the frame signature covers the request and a hash of the exact bytes (pinned in AurenKit's tests too)", () => {
  assert.equal(String(framePayload("req-1", Buffer.from("abc"))), "auren-frame\nreq-1\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("a frame for a request Core never made is refused", async () => {
  const res = await post("b5c6f3e0-0000-4000-8000-000000000000", posterJpeg());
  assert.equal(res.status, 404);
});

test("a frame from a device Core didn't ask is refused, and the right one still lands", async () => {
  const glassesDev = pair("glasses-b", "glasses");
  const phoneDev = pair("phone-b", "phone");
  const c = capture(cam("glasses-b", "glasses"), cam("phone-b", "phone"));
  const jpeg = posterJpeg();
  const wrong = await post(c.id, jpeg, { ...REMOTE, "x-auren-device": "phone-b", "x-auren-signature": phoneDev.sign(framePayload(c.id, jpeg)) });
  assert.equal(wrong.status, 403);
  const right = await post(c.id, jpeg, { ...REMOTE, "x-auren-device": "glasses-b", "x-auren-signature": glassesDev.sign(framePayload(c.id, jpeg)) });
  assert.equal(right.status, 202);
  assert.equal((await c.frame).surfaceId, "glasses-b");
  c.done();
});

test("a signature over different bytes, or no signature from the network, is refused", async () => {
  const dev = pair("glasses-c", "glasses");
  const c = capture(cam("glasses-c", "glasses"));
  const swapped = await post(c.id, posterJpeg(96, 64), { ...REMOTE, "x-auren-device": "glasses-c", "x-auren-signature": dev.sign(framePayload(c.id, posterJpeg(48, 32))) });
  assert.equal(swapped.status, 403);
  assert.ok(log.since("default").some((e) => e.kind === "error" && /camera frame arrived without a valid device signature/.test(String(e.data.message))));
  const unsigned = await post(c.id, posterJpeg(), { ...REMOTE, "x-auren-surface": "glasses-c" });
  assert.equal(unsigned.status, 403);
  assert.equal(frames.target(c.id), "glasses-c", "still waiting for a real frame");
  c.done();
});

test("this Mac may hand in a frame unsigned, but only as the surface Core asked", async () => {
  const c = capture(cam("glasses-sim", "glasses"));
  assert.equal((await post(c.id, posterJpeg(), { "x-auren-surface": "phone-sim" })).status, 403);
  assert.equal((await post(c.id, posterJpeg(), { "x-auren-surface": "glasses-sim" })).status, 202);
  assert.equal((await c.frame).surfaceId, "glasses-sim");
  c.done();
});

test("frames over 2 MB, or that aren't JPEGs, are refused", async () => {
  const c = capture(cam("glasses-d", "glasses"));
  const big = Buffer.alloc(MAX_FRAME_BYTES + 1);
  big.set([0xff, 0xd8, 0xff]);
  // Core answers from the declared length, before the body arrives. On its own connection,
  // since the server drops it after refusing.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/v1/frames/${c.id}`, method: "POST", agent: false, headers: { "content-type": "image/jpeg", "content-length": big.length, "x-auren-surface": "glasses-d" } });
    req.on("response", (res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", reject);
    req.write(big.subarray(0, 1024));
  });
  assert.equal(status, 413);
  assert.equal((await post(c.id, Buffer.from("\x89PNG\r\n\x1a\n...."), { "x-auren-surface": "glasses-d" })).status, 415);
  assert.equal(frames.target(c.id), "glasses-d");
  c.done();
});

test("a receipt's crop is served as a JPEG; nothing else is", async () => {
  const id = crops.put(posterJpeg(32, 32));
  const res = await fetch(`http://127.0.0.1:${port}/v1/crops/${id}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(posterJpeg(32, 32)));
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/crops/crop_nope`)).status, 404);
});
