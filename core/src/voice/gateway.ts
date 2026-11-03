// /v1/voice: a surface streams its microphone here, Core relays it to Muse
// Voice Transcribe, sends live partials back, and turns the final transcript
// into a command from that surface. Model keys never leave Core.
//
//   Core → surface   challenge { nonce }
//   surface → Core   start { surface_id, auth? }      auth signs "auren-voice\n<nonce>\n<id>"
//   Core → surface   ready
//   surface → Core   binary PCM16 mono 24 kHz frames, then end
//   Core → surface   transcript { text, final } …, then done { text }
import { randomBytes } from "node:crypto";
import { WebSocket } from "ws";
import { z } from "zod";
import type { OpsLog } from "../obs/opslog.ts";
import { voicePayload, type DeviceRegistry } from "../security/devices.ts";
import type { Ledger } from "../security/ledger.ts";
import type { AsrConnector, AsrSession } from "./asr.ts";
import { stripWake } from "./wake.ts";

const MAX_SECONDS = 30;
/** PCM16 mono at 24 kHz: 48,000 bytes a second. One turn, streamed or uploaded, is at most 30 s. */
export const MAX_TURN_BYTES = 24_000 * 2 * MAX_SECONDS;
const MAX_BYTES = MAX_TURN_BYTES;
/** 100 ms of audio, the frame size surfaces stream in. */
const FRAME_BYTES = 4_800;
const START_TIMEOUT_MS = 15_000;
const FINAL_GRACE_MS = 5_000;

const Start = z.object({
  type: z.literal("start"),
  surface_id: z.string().min(1).max(64),
  auth: z.object({ device_id: z.string(), signature: z.string().max(512) }).optional(),
});
const End = z.object({ type: z.literal("end") });

export interface VoiceDeps {
  asr?: AsrConnector;
  devices?: DeviceRegistry;
  keywords: () => string[];
  onCommand: (text: string, surfaceId: string) => void;
  ops: OpsLog;
  ledger?: Ledger;
}

export function handleVoice(ws: WebSocket, local: boolean, deps: VoiceDeps): void {
  const nonce = randomBytes(18).toString("base64url");
  let surfaceId: string | null = null;
  let session: AsrSession | null = null;
  let bytes = 0;
  let ended = false;
  let completed = false;
  let latest = "";
  let endedAt = 0;
  let grace: ReturnType<typeof setTimeout> | undefined;
  const send = (m: Record<string, unknown>) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m));
  const fail = (message: string) => {
    send({ type: "error", message });
    ws.close(1008, message.slice(0, 120));
  };
  const idle = setTimeout(() => !session && fail("Voice didn't start in time."), START_TIMEOUT_MS);

  const complete = () => {
    if (completed || !surfaceId) return;
    completed = true;
    clearTimeout(grace);
    const command = settleTurn(deps, { surfaceId, heard: latest, bytes, endedAt, via: "stream" });
    send({ type: "done", text: command });
    session?.close();
    ws.close(1000);
  };

  const finish = () => {
    if (ended || !session) return;
    ended = true;
    endedAt = performance.now();
    session.end();
    // If no final arrives, act on the last partial rather than drop what was said.
    grace = setTimeout(complete, FINAL_GRACE_MS);
  };

  send({ type: "challenge", nonce });

  ws.on("message", async (raw, isBinary) => {
    if (isBinary) {
      if (!session || ended) return;
      const chunk = raw as Buffer;
      bytes += chunk.length;
      session.send(chunk);
      if (bytes >= MAX_BYTES) finish();
      return;
    }
    let data: unknown;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return fail("bad message");
    }
    if (End.safeParse(data).success) return finish();
    const start = Start.safeParse(data);
    if (!start.success || session || surfaceId) return;
    const { surface_id, auth } = start.data;
    if (auth) {
      if (auth.device_id !== surface_id || !deps.devices?.verify(auth.device_id, voicePayload(nonce, auth.device_id), auth.signature)) {
        return fail("This device's signature didn't verify. Pair it again from the Mac.");
      }
    } else if (deps.devices && !local) {
      return fail("Pair this device first: on the Mac, open the console and choose Pair a device.");
    }
    if (!deps.asr) return fail("Voice needs MODEL_API_KEY in .env.");
    surfaceId = surface_id;
    try {
      session = await deps.asr.open({ keywords: deps.keywords() });
    } catch (err) {
      deps.ops.error("voice.open", { surface: surfaceId, message: err instanceof Error ? err.message : String(err) });
      return fail(`Muse Voice Transcribe didn't start: ${err instanceof Error ? err.message : String(err)}`);
    }
    clearTimeout(idle);
    session.onTranscript((text, final) => {
      latest = text;
      send({ type: "transcript", text, final });
      if (final && ended) complete();
    });
    session.onError((message) => fail(`Transcription failed: ${message}`));
    deps.ops.info("voice.start", { surface: surfaceId });
    send({ type: "ready" });
  });

  ws.on("close", () => {
    clearTimeout(idle);
    clearTimeout(grace);
    session?.close();
  });
}

/**
 * How every turn ends, streamed or uploaded: drop the wake phrase, log metadata only
 * (never the words), and run what's left as a command from that surface. Returns the command,
 * or "" when only the wake phrase was heard.
 */
function settleTurn(deps: VoiceDeps, t: { surfaceId: string; heard: string; bytes: number; endedAt: number; via: "stream" | "clip" }): string {
  const command = stripWake(t.heard);
  const ms = performance.now() - t.endedAt;
  deps.ops.info("voice.final", { surface: t.surfaceId, via: t.via, ms_after_end: Math.round(ms), seconds: +(t.bytes / 48_000).toFixed(1), chars: command.length });
  deps.ledger?.record({ service: "Meta Model API", operation: "asr.realtime muse-voice-transcribe-1.0", status: "ok", ms, bytesOut: t.bytes });
  if (command) deps.onCommand(command, t.surfaceId);
  return command;
}

/** A clip that couldn't be transcribed: 503 when voice isn't set up, 502 when the transcriber failed. */
export class VoiceError extends Error {
  status: 502 | 503;
  constructor(status: 502 | 503, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * R12: one whole hold-to-talk clip (the watch can't keep the voice socket open). It goes to
 * the same transcriber in 100 ms frames, then ends exactly like a streamed turn: a final
 * transcript, or the last partial after the same grace period.
 */
export async function transcribeClip(pcm: Uint8Array, surfaceId: string, deps: VoiceDeps): Promise<string> {
  if (!deps.asr) throw new VoiceError(503, "Voice needs MODEL_API_KEY in .env.");
  let session: AsrSession;
  try {
    session = await deps.asr.open({ keywords: deps.keywords() });
  } catch (err) {
    deps.ops.error("voice.open", { surface: surfaceId, via: "clip", message: err instanceof Error ? err.message : String(err) });
    throw new VoiceError(502, `Muse Voice Transcribe didn't start: ${err instanceof Error ? err.message : String(err)}`);
  }
  let latest = "";
  let ended = false;
  let grace: ReturnType<typeof setTimeout> | undefined;
  try {
    const final = new Promise<void>((resolve, reject) => {
      session.onTranscript((text, isFinal) => {
        latest = text;
        if (isFinal && ended) resolve();
      });
      session.onError((message) => reject(new VoiceError(502, `Transcription failed: ${message}`)));
    });
    final.catch(() => {});
    deps.ops.info("voice.start", { surface: surfaceId, via: "clip" });
    for (let at = 0; at < pcm.length; at += FRAME_BYTES) session.send(Buffer.from(pcm.subarray(at, at + FRAME_BYTES)));
    ended = true;
    const endedAt = performance.now();
    session.end();
    // If no final arrives, act on the last partial, exactly as the socket does.
    await Promise.race([final, new Promise<void>((resolve) => (grace = setTimeout(resolve, FINAL_GRACE_MS)))]);
    return settleTurn(deps, { surfaceId, heard: latest, bytes: pcm.length, endedAt, via: "clip" });
  } finally {
    clearTimeout(grace);
    session.close();
  }
}
