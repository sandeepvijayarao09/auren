// Live check of Muse Voice Transcribe: node --env-file=../.env src/voice/live-check.ts <pcm16-24k-mono.raw> [burst]
import { readFileSync } from "node:fs";
import { museAsr } from "./asr.ts";
import { stripWake, voiceKeywords } from "./wake.ts";
const pcm = readFileSync(process.argv[2]);
const paced = process.argv[3] !== "burst";
const asr = museAsr({ apiKey: process.env.MODEL_API_KEY!, timeoutMs: 10000 });
const t0 = performance.now();
const s = await asr.open({ keywords: voiceKeywords() });
console.log(`session open in ${(performance.now() - t0).toFixed(0)} ms (${paced ? "real-time" : "burst"})`);
let endedAt = 0; let last = "";
const done = new Promise<void>((res) => {
  s.onTranscript((text, final) => {
    last = text;
    const t = endedAt ? `+${(performance.now() - endedAt).toFixed(0)} ms after end` : "during audio";
    console.log(`${final ? "FINAL  " : "partial"} [${t}] ${text}`);
    if (final && endedAt) res();
  });
  s.onError((m) => { console.log("ERROR", m); res(); });
});
for (let at = 0; at < pcm.length; at += 4800) {
  s.send(pcm.subarray(at, at + 4800));
  if (paced) await new Promise((r) => setTimeout(r, 100));
}
endedAt = performance.now(); s.end();
await Promise.race([done, new Promise((r) => setTimeout(r, 10000))]);
console.log(`latency end-of-audio -> final: ${(performance.now() - endedAt).toFixed(0)} ms`);
console.log(`after stripWake: ${JSON.stringify(stripWake(last))}`);
s.close();
