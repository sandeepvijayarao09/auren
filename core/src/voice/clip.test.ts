// R12: POST /v1/voice/clip over real HTTP, with a scripted transcriber.
// "Remote" requests carry X-Forwarded-For, which is how a tunnel reaches Core.
import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import { EventLog } from "../eventlog.ts";
import { silentOps } from "../obs/opslog.ts";
import { clipPayload, DeviceRegistry } from "../security/devices.ts";
import { fakeDevice } from "../security/devices.test.ts";
import { createServer } from "../server.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { AsrConnector } from "./asr.ts";
import { acceptClip, CLIP_FRESH_MS, MAX_CLIP_BYTES, ReplayCache } from "./clip.ts";

/** Hears whatever the test says it heard, once the clip ends. */
let said = "Hey Muse, I'm running 15 late. Tell office hours on Slack.";
let frames: number[] = [];
const asr: AsrConnector = {
  async open() {
    let text: (t: string, f: boolean) => void = () => {};
    return {
      send: (pcm) => {
        frames.push(pcm.length);
        text("hey muse i'm running", false);
      },
      end: () => setTimeout(() => text(said, true), 10),
      close: () => {},
      onTranscript: (fn) => (text = fn),
      onError: () => {},
    };
  },
};

const log = new EventLog();
const surfaces = new SurfaceRegistry({ onEvent: (kind, data) => log.append("default", kind, data) });
const devices = new DeviceRegistry();
const core = createServer(
  { muse: { responses: { create: async () => ({ output: [] }) } }, tools: new ToolRegistry(), surfaces, log, agentModel: "muse-wonder-1.0" },
  { token: "", museReady: false, devices, voice: { asr, keywords: () => ["Muse"] } },
);
const http = serve({ fetch: core.app.fetch, port: 0, hostname: "127.0.0.1" });
await new Promise((r) => http.once("listening", r));
const port = (http.address() as AddressInfo).port;
after(() => {
  core.close();
  http.close();
});

const REMOTE = { "x-forwarded-for": "198.51.100.12" };
/** 1.2 s of quiet PCM16 at 24 kHz. */
const clip = (seconds = 1.2) => Buffer.alloc(Math.round(seconds * 48_000));

function pair(id: string) {
  const dev = fakeDevice();
  devices.finishPairing({ code: devices.startPairing().code, id, kind: "watch", publicKey: dev.publicKey, hardware: true });
  return dev;
}

/** The headers a watch sends: its id, when it recorded, and its signature over both and the bytes. */
const signed = (dev: ReturnType<typeof fakeDevice>, id: string, pcm: Buffer, at = Date.now()) => ({
  "x-auren-device": id,
  "x-auren-timestamp": String(at),
  "x-auren-signature": dev.sign(clipPayload(id, at, pcm)),
});

const post = (pcm: Uint8Array, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${port}/v1/voice/clip`, { method: "POST", headers: { "content-type": "application/octet-stream", ...headers }, body: new Uint8Array(pcm) });

const utterances = () => log.since("default").filter((e) => e.kind === "utterance");

test("a paired watch's signed clip runs as a command from the watch, with the wake phrase removed", async () => {
  const dev = pair("watch-clip");
  const pcm = clip();
  frames = [];
  const res = await post(pcm, { ...REMOTE, ...signed(dev, "watch-clip", pcm) });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "I'm running 15 late. Tell office hours on Slack." });
  const last = utterances().at(-1);
  assert.deepEqual([last?.data.text, last?.data.surface_id], ["I'm running 15 late. Tell office hours on Slack.", "watch-clip"]);
  // The transcriber gets the clip as a stream of 100 ms frames, like the socket's.
  assert.equal(frames.reduce((a, b) => a + b, 0), pcm.length);
  assert.ok(frames.length === 12 && frames.every((n) => n === 4_800));
});

test("a signature over other bytes, or by another key, is refused and logged", async () => {
  const dev = pair("watch-forged");
  const pcm = clip();
  const swapped = await post(clip(0.8), { ...REMOTE, ...signed(dev, "watch-forged", pcm) });
  assert.equal(swapped.status, 403);
  const stranger = await post(pcm, { ...REMOTE, ...signed(fakeDevice(), "watch-forged", pcm) });
  assert.equal(stranger.status, 403);
  assert.ok(log.since("default").some((e) => e.kind === "error" && /voice clip arrived without a valid device signature/.test(String(e.data.message))));
});

test("the same signed clip is taken once; a replay is refused", async () => {
  const dev = pair("watch-replay");
  const pcm = clip();
  const headers = { ...REMOTE, ...signed(dev, "watch-replay", pcm) };
  assert.equal((await post(pcm, headers)).status, 200);
  const before = utterances().length;
  const again = await post(pcm, headers);
  assert.equal(again.status, 403);
  assert.match((await again.json()).error, /already took that clip/);
  assert.equal(utterances().length, before, "no second command");
});

test("a stale clip, or one from the future, is refused even when signed", async () => {
  const dev = pair("watch-stale");
  const pcm = clip();
  const old = await post(pcm, { ...REMOTE, ...signed(dev, "watch-stale", pcm, Date.now() - CLIP_FRESH_MS - 5_000) });
  assert.equal(old.status, 403);
  assert.match((await old.json()).error, /too old/);
  const ahead = await post(pcm, { ...REMOTE, ...signed(dev, "watch-stale", pcm, Date.now() + CLIP_FRESH_MS + 5_000) });
  assert.equal(ahead.status, 403);
  // A relayed clip has nobody waiting for the answer, so the timeline says why it didn't run.
  assert.ok(log.since("default").some((e) => e.kind === "error" && e.data.surface_id === "watch-stale" && /more than a minute/.test(String(e.data.message))));
});

test("a clip over 30 s is refused with 413 before it's read", async () => {
  const big = MAX_CLIP_BYTES + 2;
  // Core answers from the declared length. On its own connection, since the server drops it after refusing.
  const status = await new Promise<number>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/v1/voice/clip", method: "POST", agent: false, headers: { "content-type": "application/octet-stream", "content-length": big, "x-auren-surface": "web-1" } });
    req.on("response", (res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    req.on("error", reject);
    req.write(Buffer.alloc(64 * 1024));
  });
  assert.equal(status, 413);
});

test("a device that isn't paired, or isn't signing, is refused from the network", async () => {
  const pcm = clip();
  const unpaired = await post(pcm, { ...REMOTE, ...signed(fakeDevice(), "watch-nobody", pcm) });
  assert.equal(unpaired.status, 403);
  assert.match((await unpaired.json()).error, /isn't paired/);
  const unsigned = await post(pcm, { ...REMOTE, "x-auren-surface": "watch-clip" });
  assert.equal(unsigned.status, 403);
  const revoked = pair("watch-revoked");
  devices.revoke("watch-revoked");
  assert.equal((await post(pcm, { ...REMOTE, ...signed(revoked, "watch-revoked", pcm) })).status, 403);
});

test("only the wake phrase means no command", async () => {
  said = "Hey Muse.";
  const before = utterances().length;
  const res = await post(clip(), { "x-auren-surface": "web-clip" });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { text: "" });
  assert.equal(utterances().length, before);
  said = "Hey Muse, I'm running 15 late. Tell office hours on Slack.";
});

test("this Mac may post unsigned, as a named surface; empty or odd-length audio is refused", async () => {
  const res = await post(clip(), { "x-auren-surface": "web-clip" });
  assert.equal(res.status, 200);
  assert.equal(utterances().at(-1)?.data.surface_id, "web-clip");
  assert.equal((await post(clip(), {})).status, 400);
  assert.equal((await post(Buffer.alloc(0), { "x-auren-surface": "web-clip" })).status, 400);
  assert.equal((await post(Buffer.alloc(4_801), { "x-auren-surface": "web-clip" })).status, 400);
});

test("the clip signature covers the device, the time and a hash of the exact bytes (pinned in AurenKit's tests too)", () => {
  assert.equal(
    String(clipPayload("watch-7f3a", 1762200000000, Buffer.from("abc"))),
    "auren-clip\nwatch-7f3a\n1762200000000\nba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

// Made once with CryptoKit (P256.Signing, DER), as DeviceIdentity.signClip does on the watch,
// over clipPayload("watch-interop", 1762200000000, "abc").
const CRYPTOKIT = {
  publicKey: "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEXFXg2mT6QIJEZUPcPI0KdopcfTws5wmIzsLTj0RHl8gnIQ0Ng8GmjGhf1ULdslakK/3jKE9ePU9mWBEGUxZQQw==",
  clip: "MEYCIQDQ2+RbfSHiWPNS9eDQ9rmauNT7t9GPQNJvZUOFV2cJ7gIhAP625fWqt5TLwERFPCWYTrLDD7bHqrq96p8+hsSlM33L",
};

test("a clip signature made by CryptoKit verifies here", () => {
  const reg = new DeviceRegistry();
  reg.finishPairing({ code: reg.startPairing().code, id: "watch-interop", kind: "watch", publicKey: CRYPTOKIT.publicKey, hardware: true });
  assert.equal(reg.verify("watch-interop", clipPayload("watch-interop", 1762200000000, Buffer.from("abc")), CRYPTOKIT.clip), true);
  assert.equal(reg.verify("watch-interop", clipPayload("watch-interop", 1762200000001, Buffer.from("abc")), CRYPTOKIT.clip), false);
});

test("without a transcriber the clip is refused with a setup error, and the replay cache forgets stale clips", async () => {
  const voice = { keywords: () => [], onCommand: () => assert.fail("no command"), ops: silentOps };
  const r = await acceptClip({ pcm: clip(), local: true, header: (h) => (h === "x-auren-surface" ? "web-1" : undefined) }, { voice, replay: new ReplayCache() });
  assert.deepEqual([r.status, "error" in r.body && /MODEL_API_KEY/.test(r.body.error)], [503, true]);

  let now = 1_000_000;
  const cache = new ReplayCache(() => now);
  assert.equal(cache.claim("a", now), true);
  assert.equal(cache.claim("a", now), false);
  now += CLIP_FRESH_MS + 1;
  assert.equal(cache.claim("b", now), true, "a new clip is fine");
  // "a" is stale by now, so the freshness check refuses it before the cache is asked; the cache has let it go.
  assert.equal(cache.claim("a", now), true);
});
