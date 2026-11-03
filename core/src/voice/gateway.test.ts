// /v1/voice end to end over a real socket, with a scripted transcriber.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { EventLog } from "../eventlog.ts";
import { DeviceRegistry, helloPayload, voicePayload } from "../security/devices.ts";
import { fakeDevice } from "../security/devices.test.ts";
import { createServer } from "../server.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { ToolRegistry } from "../tools/registry.ts";
import type { AsrConnector } from "./asr.ts";

/** Hears whatever the test says it heard, once the client ends the turn. */
let said = "Hey Muse, push my 3 PM to 4.";
let audioBytes = 0;
const asr: AsrConnector = {
  async open() {
    let text: (t: string, f: boolean) => void = () => {};
    return {
      send: (pcm) => {
        audioBytes += pcm.length;
        text("hey muse push", false);
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
http.on("upgrade", core.upgrade);
await new Promise((r) => http.once("listening", r));
const port = (http.address() as AddressInfo).port;
after(() => {
  core.close();
  http.close();
});
const REMOTE = { "x-forwarded-for": "198.51.100.4" };

async function talk(id: string, opts: { remote?: boolean; sign?: (nonce: string) => string; frames?: number } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/voice`, { headers: opts.remote ? REMOTE : {} });
  const got: any[] = [];
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  ws.on("message", (raw) => got.push(JSON.parse(String(raw))));
  const until = (type: string) =>
    new Promise<any>((resolve) => {
      const tick = () => {
        const m = got.find((x) => x.type === type || x.type === "error");
        m ? resolve(m) : setTimeout(tick, 5);
      };
      tick();
    });
  const { nonce } = await until("challenge");
  ws.send(JSON.stringify({ type: "start", surface_id: id, ...(opts.sign ? { auth: { device_id: id, signature: opts.sign(nonce) } } : {}) }));
  const ready = await until("ready");
  if (ready.type === "error") return { got, closed, error: ready.message as string };
  for (let i = 0; i < (opts.frames ?? 3); i++) ws.send(Buffer.alloc(3_840));
  ws.send(JSON.stringify({ type: "end" }));
  const done = await until("done");
  return { got, closed, done: done.text as string };
}

test("this Mac's console can talk, and the command lands with the wake phrase removed", async () => {
  const r = await talk("web-1");
  assert.equal(r.done, "Push my 3 PM to 4.");
  assert.ok(r.got.some((m) => m.type === "transcript" && m.final === false));
  assert.equal(await r.closed, 1000);
  const utterance = log.since("default").filter((e) => e.kind === "utterance").at(-1);
  assert.deepEqual([utterance?.data.text, utterance?.data.surface_id], ["Push my 3 PM to 4.", "web-1"]);
});

test("a paired phone talks with a voice signature", async () => {
  const dev = fakeDevice();
  devices.finishPairing({ code: devices.startPairing().code, id: "phone-v", kind: "phone", publicKey: dev.publicKey, hardware: true });
  const r = await talk("phone-v", { remote: true, sign: (n) => dev.sign(voicePayload(n, "phone-v")) });
  assert.equal(r.done, "Push my 3 PM to 4.");
});

test("unpaired devices and replayed hello signatures are refused", async () => {
  assert.match((await talk("stranger", { remote: true })).error ?? "", /Pair this device first/);
  const dev = fakeDevice();
  devices.finishPairing({ code: devices.startPairing().code, id: "phone-x", kind: "phone", publicKey: dev.publicKey, hardware: true });
  const replay = await talk("phone-x", { remote: true, sign: (n) => dev.sign(helloPayload(n, "phone-x")) });
  assert.match(replay.error ?? "", /didn't verify/);
});

test("only a wake phrase means no command", async () => {
  said = "Hey Muse.";
  const before = log.since("default").filter((e) => e.kind === "utterance").length;
  const r = await talk("web-2");
  assert.equal(r.done, "");
  assert.equal(log.since("default").filter((e) => e.kind === "utterance").length, before);
  said = "Hey Muse, push my 3 PM to 4.";
});

test("audio reaches the transcriber frame by frame", async () => {
  audioBytes = 0;
  await talk("web-3", { frames: 5 });
  assert.equal(audioBytes, 5 * 3_840);
});
