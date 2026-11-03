// Muse Voice Transcribe over its realtime WebSocket. The handshake matches
// Meta's documented fields (as used by the open-source Pipecat client): the key
// travels in the first frame, a reply with `sessionId` means accepted, audio is
// PCM16 mono at 24 kHz, and `endStream` closes the turn.
import { randomUUID } from "node:crypto";
import { WebSocket } from "ws";

export interface AsrSession {
  send(pcm: Buffer): void;
  end(): void;
  close(): void;
  onTranscript(fn: (text: string, final: boolean) => void): void;
  onError(fn: (message: string) => void): void;
}

export interface AsrConnector {
  open(opts: { keywords: string[] }): Promise<AsrSession>;
}

export interface MuseAsrOptions {
  apiKey: string;
  url?: string;
  model?: string;
  /** Ask Meta to keep metadata only, not the audio or text. On by default. */
  metadataOnlyLogging?: boolean;
  timeoutMs?: number;
}

/** The first frame. Push-to-talk: the client marks the end of the turn. */
export function asrHandshake(o: MuseAsrOptions, keywords: string[]): Record<string, unknown> {
  return {
    authorization: { accessToken: `Bearer ${o.apiKey}` },
    audioEncoding: "PCM_24KHZ",
    model: o.model ?? "muse-voice-transcribe-1.0",
    mode: "PUSH_TO_TALK",
    // Every partial carries the whole hypothesis so far.
    partialMode: "CUMULATIVE",
    emitAudioProgress: false,
    languageBias: ["English"],
    ...(keywords.length ? { keywords: keywords.slice(0, 100) } : {}),
    ...(o.metadataOnlyLogging === false ? {} : { zdrOverride: true }),
  };
}

export function museAsr(o: MuseAsrOptions): AsrConnector {
  const url = o.url ?? "wss://api.meta.ai/v1/asr/realtime";
  return {
    open: ({ keywords }) =>
      new Promise<AsrSession>((resolve, reject) => {
        const ws = new WebSocket(`${url}?sessionId=stream-${randomUUID()}`);
        const onText: Array<(text: string, final: boolean) => void> = [];
        const onError: Array<(message: string) => void> = [];
        let ready = false;
        const timer = setTimeout(() => {
          ws.terminate();
          reject(new Error("Muse Voice Transcribe didn't answer in time."));
        }, o.timeoutMs ?? 5000);

        const session: AsrSession = {
          send: (pcm) => ws.readyState === WebSocket.OPEN && ws.send(pcm),
          end: () => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: "endStream" })),
          close: () => ws.close(),
          onTranscript: (fn) => onText.push(fn),
          onError: (fn) => onError.push(fn),
        };

        ws.on("open", () => ws.send(JSON.stringify(asrHandshake(o, keywords))));
        ws.on("message", (raw, isBinary) => {
          if (isBinary) return;
          let m: Record<string, unknown>;
          try {
            m = JSON.parse(String(raw));
          } catch {
            return;
          }
          if (!ready) {
            clearTimeout(timer);
            if (typeof m.sessionId !== "string") {
              ws.close();
              return reject(new Error(String(m.message ?? "the session was rejected")));
            }
            ready = true;
            return resolve(session);
          }
          if (m.type === "transcript") onText.forEach((fn) => fn(String(m.transcript ?? ""), m.final === true));
          else if (m.type === "speechComplete") onText.forEach((fn) => fn(String(m.transcript ?? ""), true));
          else if (m.type === "error") onError.forEach((fn) => fn(String(m.message ?? "transcription failed")));
        });
        ws.on("error", (err) => {
          if (!ready) {
            clearTimeout(timer);
            reject(err);
          } else onError.forEach((fn) => fn(err.message));
        });
      }),
  };
}
