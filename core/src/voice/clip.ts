// R12: POST /v1/voice/clip. A real Apple Watch can't keep the /v1/voice socket open
// (TN3135), so it records while you hold, then uploads the whole clip (PCM16 mono at
// 24 kHz, at most 30 s) in one request: straight to Core, or through the iPhone, which
// passes the bytes on unchanged. The clip goes through the same transcriber and the same
// turn ending as the socket (gateway.ts), and runs as a command from that device.
//
// A paired device signs  auren-clip\n<device id>\n<timestamp>\n<sha256 hex of the body>
// with its Secure Enclave key. There's no server nonce (a relayed clip can't fetch one),
// so Core refuses a clip whose timestamp is more than a minute off and any clip it has
// already taken. Only this Mac may post unsigned.
import { clipPayload, type DeviceRegistry } from "../security/devices.ts";
import { MAX_TURN_BYTES, transcribeClip, VoiceError, type VoiceDeps } from "./gateway.ts";

/** 30 s of PCM16 mono at 24 kHz, the same cap as a streamed turn. */
export const MAX_CLIP_BYTES = MAX_TURN_BYTES;
/** How far a clip's timestamp may be from Core's clock, either way. */
export const CLIP_FRESH_MS = 60_000;
const MAX_REMEMBERED = 10_000;

/** The signed clips Core has taken, each kept until it would be stale anyway, so none runs twice. */
export class ReplayCache {
  #seen = new Map<string, number>();
  #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** True the first time Core sees `key`; false for a repeat (or, failing closed, when the cache is full). */
  claim(key: string, timestamp: number): boolean {
    const now = this.#now();
    for (const [k, until] of this.#seen) if (until < now) this.#seen.delete(k);
    if (this.#seen.has(key) || this.#seen.size >= MAX_REMEMBERED) return false;
    this.#seen.set(key, timestamp + CLIP_FRESH_MS);
    return true;
  }
}

export interface ClipRequest {
  pcm: Uint8Array;
  /** From this Mac itself (isLocal), so it may post unsigned. */
  local: boolean;
  header: (name: string) => string | undefined;
}

export interface ClipDeps {
  voice: VoiceDeps;
  devices?: DeviceRegistry;
  replay: ReplayCache;
  now?: () => number;
  /** A refused signature, or a late or repeated clip, is logged on the timeline. */
  onRefused?: (message: string, deviceId: string) => void;
}

export type ClipReply = { status: 200; body: { text: string } } | { status: 400 | 403 | 413 | 502 | 503; body: { error: string } };

const ID = /^[A-Za-z0-9._-]{1,64}$/;
const refuse = (status: 400 | 403 | 413 | 502 | 503, error: string): ClipReply => ({ status, body: { error } });

/** Checks who sent the clip, then transcribes it and runs the command. `text` is "" when only the wake phrase was heard. */
export async function acceptClip(req: ClipRequest, deps: ClipDeps): Promise<ClipReply> {
  const { pcm } = req;
  if (pcm.length > MAX_CLIP_BYTES) return refuse(413, "A clip can be at most 30 seconds.");
  if (!pcm.length || pcm.length % 2) return refuse(400, "A clip must be PCM16 mono audio at 24 kHz.");

  let surfaceId: string;
  const deviceId = req.header("x-auren-device");
  if (deps.devices && deviceId) {
    const device = deps.devices.get(deviceId);
    if (!device || device.revoked) return refuse(403, "This device isn't paired. Pair it from the Mac.");
    const stamp = req.header("x-auren-timestamp") ?? "";
    if (!/^\d{1,15}$/.test(stamp)) return refuse(400, "x-auren-timestamp must be milliseconds since 1970.");
    const timestamp = Number(stamp);
    const payload = clipPayload(deviceId, timestamp, pcm);
    if (!deps.devices.verify(deviceId, payload, req.header("x-auren-signature"))) {
      deps.onRefused?.("A voice clip arrived without a valid device signature, so Auren dropped it.", deviceId);
      return refuse(403, "That clip's signature didn't verify.");
    }
    // Checked after the signature, so only a paired device's own clips can fill the replay cache.
    // A late clip is said on the timeline, since one relayed by the iPhone has nobody waiting for the answer.
    if (Math.abs((deps.now ?? Date.now)() - timestamp) > CLIP_FRESH_MS) {
      deps.onRefused?.("A voice clip arrived more than a minute after it was recorded, so Auren didn't run it.", deviceId);
      return refuse(403, "That clip is too old, or this device's clock is off.");
    }
    if (!deps.replay.claim(String(payload), timestamp)) {
      deps.onRefused?.("A voice clip arrived a second time, so Auren didn't run it again.", deviceId);
      return refuse(403, "Core already took that clip.");
    }
    surfaceId = deviceId;
  } else if (deps.devices && !req.local) {
    return refuse(403, "Clips from another device must be signed by a paired device.");
  } else {
    surfaceId = req.header("x-auren-surface") ?? deviceId ?? "";
    if (!ID.test(surfaceId)) return refuse(400, "Say which surface the clip is from in x-auren-surface.");
  }

  try {
    return { status: 200, body: { text: await transcribeClip(pcm, surfaceId, deps.voice) } };
  } catch (err) {
    if (err instanceof VoiceError) return refuse(err.status, err.message);
    throw err;
  }
}
