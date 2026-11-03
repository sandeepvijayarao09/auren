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
const MAX_BYTES = 24_000 * 2 * MAX_SECONDS;
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
    const command = stripWake(latest);
    deps.ops.info("voice.final", { surface: surfaceId, ms_after_end: Math.round(performance.now() - endedAt), seconds: +(bytes / 48_000).toFixed(1), chars: command.length });
    deps.ledger?.record({ service: "Meta Model API", operation: "asr.realtime muse-voice-transcribe-1.0", status: "ok", ms: performance.now() - endedAt, bytesOut: bytes });
    if (command) deps.onCommand(command, surfaceId);
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
