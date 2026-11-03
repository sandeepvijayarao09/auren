import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { WebSocketServer } from "ws";
import { asrHandshake, museAsr } from "./asr.ts";
import { stripWake, voiceKeywords } from "./wake.ts";

// A stand-in for wss://api.meta.ai/v1/asr/realtime that speaks the same frames.
const seen: { handshake?: any; audio: number; ended: boolean; query?: string } = { audio: 0, ended: false };
const fake = new WebSocketServer({ port: 0, host: "127.0.0.1" });
fake.on("connection", (ws, req) => {
  seen.query = req.url;
  ws.on("message", (raw, isBinary) => {
    if (isBinary) {
      seen.audio += (raw as Buffer).length;
      if (seen.audio >= 3_840) ws.send(JSON.stringify({ type: "transcript", transcript: "hey muse move my", final: false }));
      return;
    }
    const m = JSON.parse(String(raw));
    if (!seen.handshake) {
      seen.handshake = m;
      return ws.send(JSON.stringify(m.authorization?.accessToken === "Bearer good" ? { sessionId: "s-1" } : { type: "error", message: "invalid key" }));
    }
    if (m.type === "endStream") {
      seen.ended = true;
      ws.send(JSON.stringify({ type: "transcript", transcript: "Hey Muse, move my 3 PM to 4.", final: true }));
    }
  });
});
await new Promise((r) => fake.once("listening", r));
const url = `ws://127.0.0.1:${(fake.address() as AddressInfo).port}`;
after(() => fake.close());

test("the handshake carries the documented fields, with metadata-only logging on", () => {
  const h = asrHandshake({ apiKey: "k" }, ["Muse", "Priya"]);
  assert.deepEqual(h, {
    authorization: { accessToken: "Bearer k" },
    audioEncoding: "PCM_24KHZ",
    model: "muse-voice-transcribe-1.0",
    mode: "PUSH_TO_TALK",
    partialMode: "CUMULATIVE",
    emitAudioProgress: false,
    languageBias: ["English"],
    keywords: ["Muse", "Priya"],
    zdrOverride: true,
  });
  assert.equal("zdrOverride" in asrHandshake({ apiKey: "k", metadataOnlyLogging: false }, []), false);
  assert.equal("keywords" in asrHandshake({ apiKey: "k" }, []), false);
});

test("streams audio, relays partials, and returns the final after endStream", async () => {
  const session = await museAsr({ apiKey: "good", url }).open({ keywords: ["Muse"] });
  assert.match(seen.query ?? "", /^\/\?sessionId=stream-[0-9a-f-]{36}$/);
  const heard: Array<[string, boolean]> = [];
  const final = new Promise<string>((resolve) => session.onTranscript((text, isFinal) => (heard.push([text, isFinal]), isFinal && resolve(text))));
  session.send(Buffer.alloc(3_840));
  await new Promise((r) => setTimeout(r, 50));
  session.end();
  assert.equal(await final, "Hey Muse, move my 3 PM to 4.");
  assert.deepEqual(heard[0], ["hey muse move my", false]);
  assert.equal(seen.ended, true);
  session.close();
});

test("a rejected key surfaces as an error, not a silent socket", async () => {
  seen.handshake = undefined;
  await assert.rejects(museAsr({ apiKey: "bad", url }).open({ keywords: [] }), /invalid key/);
});

test("the wake phrase comes off, however it was heard", () => {
  assert.equal(stripWake("Hey Muse, move my 3 PM to 4."), "Move my 3 PM to 4.");
  assert.equal(stripWake("hey mews tell office hours I'm late"), "Tell office hours I'm late");
  assert.equal(stripWake("Okay Muse: undo that"), "Undo that");
  assert.equal(stripWake("Hey Lauren, what did I get done today"), "What did I get done today");
  assert.equal(stripWake("move my 3 PM"), "Move my 3 PM");
  assert.equal(stripWake("Hey Muse."), "");
  assert.equal(stripWake("Hey, museum tickets for Saturday"), "Hey, museum tickets for Saturday");
});

test("keywords add your own names without repeats", () => {
  const k = voiceKeywords(["Priya", " Dana ", ""]);
  assert.ok(k.includes("Hey Muse") && k.includes("Dana"));
  assert.equal(k.filter((w) => w === "Priya").length, 1);
});
