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

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), surface: Manifest }),
  z.object({ type: z.literal("heartbeat"), active: z.boolean().default(false) }),
  z.object({ type: z.literal("utterance"), text: z.string().min(1).max(2000) }),
  z.object({ type: z.literal("approval_response"), request_id: z.string(), approved: z.boolean() }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export type Tier = "read" | "write" | "send";

export type EventKind =
  | "utterance" | "ack" | "tool_call" | "receipt" | "approval"
  | "handoff" | "reply" | "error" | "surface";

export interface AurenEvent {
  id: number;
  session: string;
  at: number;
  kind: EventKind;
  data: Record<string, unknown>;
}

export type ServerMessage =
  | { type: "welcome"; session_id: string; surfaces: Manifest[] }
  | { type: "event"; event: AurenEvent }
  | { type: "speak"; text: string }
  | { type: "show_card"; title: string; body: string }
  | { type: "approval_request"; request_id: string; summary: string; tier: Tier }
  | { type: "approval_cancel"; request_id: string; reason: "moved" | "expired" | "answered" };
