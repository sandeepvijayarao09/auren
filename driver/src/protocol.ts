// What Core sends the driver over /v1/driver, and what the driver sends back.
// Core translates Muse's computer actions into these (core/src/computer/actions.ts);
// the driver parses them again here, because the driver is where the guard lives.
import { z } from "zod";

const Point = z.object({ x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000) });

/** Mirrors DriverAction in core/src/computer/actions.ts. Keys are Playwright key names. */
export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...Point.shape, button: z.enum(["left", "right", "middle"]) }),
  z.object({ type: z.literal("double_click"), ...Point.shape }),
  z.object({ type: z.literal("move"), ...Point.shape }),
  z.object({ type: z.literal("drag"), path: z.array(Point).min(2).max(100) }),
  z.object({ type: z.literal("scroll"), ...Point.shape, dx: z.number(), dy: z.number() }),
  z.object({ type: z.literal("type"), text: z.string().max(2000) }),
  z.object({ type: z.literal("keypress"), keys: z.array(z.string().min(1).max(32)).min(1).max(5) }),
  z.object({ type: z.literal("history"), direction: z.enum(["back", "forward"]) }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(5000) }),
  z.object({ type: z.literal("screenshot") }),
]);
export type Action = z.infer<typeof Action>;

const seq = z.number().int();
export const Command = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome") }),
  z.object({ type: z.literal("start"), seq, url: z.string().max(2048) }),
  z.object({ type: z.literal("actions"), seq, actions: z.array(Action).max(50) }),
  z.object({ type: z.literal("commit"), seq }),
  z.object({ type: z.literal("end"), seq }),
]);
export type Command = z.infer<typeof Command>;

export interface StepResult {
  status: "ok" | "paused" | "stopped" | "error";
  url: string;
  title: string;
  /** The full viewport as a JPEG data URL, for the model. */
  screenshot?: string;
  /** A small JPEG data URL, for the timeline. */
  frame?: string;
  paused?: { reason: string; role: string; name: string };
  stopped?: { reason: "captcha" | "blocked" | "closed"; detail: string };
  error?: string;
}
