// Auren Surface Protocol v0. See spec/surface-protocol.md.
import { z } from "zod";

export const Input = z.enum(["voice", "text", "camera", "touch"]);
export const Output = z.enum(["voice", "screen", "haptic"]);
export const SurfaceKind = z.enum(["watch", "glasses", "phone", "web", "desktop", "other"]);

export const Manifest = z.object({
  id: z.string().min(1).max(64),
  kind: SurfaceKind,
  name: z.string().max(64).default(""),
  inputs: z.array(Input),
  outputs: z.array(Output),
});
export type Manifest = z.infer<typeof Manifest>;

/** A paired device's proof: the server's challenge nonce, signed by its Secure Enclave key. */
export const HelloAuth = z.object({ device_id: z.string().min(1).max(64), signature: z.string().min(1).max(512) });

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), surface: Manifest, auth: HelloAuth.optional() }),
  z.object({ type: z.literal("heartbeat"), active: z.boolean().default(false) }),
  z.object({ type: z.literal("utterance"), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("approval_response"), request_id: z.string(), approved: z.boolean(), signature: z.string().max(512).optional() }),
  // v0.1: a chunk of a reply finished playing, so Core knows where to resume if this surface drops.
  z.object({ type: z.literal("speak_progress"), reply_id: z.string().max(64), seq: z.number().int().min(0) }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type Tier = "read" | "write" | "send";

export type EventKind =
  | "utterance" | "ack" | "tool_call" | "receipt" | "approval"
  | "handoff" | "reply" | "error" | "surface" | "device"
  // R7: a small JPEG of the browser after each computer-use step.
  | "browser_frame"
  // R13: the token alarm or limit was crossed (data: level, tokens, alarm, limit, message).
  | "usage"
  // Muse's decision for a command, before Wonder plans: apps, risk, reply device, whether to look.
  | "decision";

export interface AurenEvent {
  id: number;
  session: string;
  at: number;
  kind: EventKind;
  data: Record<string, unknown>;
}

export type ServerMessage =
  | { type: "challenge"; nonce: string }
  | { type: "welcome"; session_id: string; surfaces: Manifest[]; heartbeat_ms?: number }
  | { type: "event"; event: AurenEvent }
  | { type: "speak"; text: string; reply_id?: string; seq?: number; final?: boolean }
  | { type: "show_card"; title: string; body: string }
  // v0.1 camera: one frame for a "this" command, uploaded to POST /v1/frames/:request_id.
  | { type: "capture_request"; request_id: string; purpose: string }
  // R12: `verb` (optional) is what the approve button says, from the tool's spec.
  // `short` (optional) is a glanceable line of at most SHORT_MAX characters for small screens. Display only, never signed.
  | { type: "approval_request"; request_id: string; summary: string; tier: Tier; verb?: string; short?: string }
  | { type: "approval_cancel"; request_id: string; reason: "moved" | "expired" | "answered" };
