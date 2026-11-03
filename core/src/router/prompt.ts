// The Auren Router's prompt, the same one it was trained on. The system prompt is
// read from router/auren_router/system_prompt.txt, and renderUser mirrors
// router/auren_router/prompt.py line for line. Both test suites pin the result
// with the same golden strings, because a changed prompt is a different model.
import { readFileSync } from "node:fs";
import { z } from "zod";
import { Input, Output, SurfaceKind } from "../protocol.ts";

export const SYSTEM = readFileSync(new URL("../../../router/auren_router/system_prompt.txt", import.meta.url), "utf8").trim();

const KINDS = SurfaceKind.options;
const INPUTS = Input.options;
const OUTPUTS = Output.options;

export const RouteDevice = z.strictObject({ kind: SurfaceKind, inputs: z.array(Input), outputs: z.array(Output), active: z.boolean() });
export type RouteDevice = z.infer<typeof RouteDevice>;

/** What the router sees besides the command: the devices online, and the kind spoken into (null if typed into the API). */
export const RouteContext = z.strictObject({ origin: SurfaceKind.nullable(), devices: z.array(RouteDevice) });
export type RouteContext = z.infer<typeof RouteContext>;

const ordered = <T extends string>(values: readonly T[], order: readonly T[]) => order.filter((v) => values.includes(v));

/** The user turn. Devices sorted by kind, inputs and outputs in protocol order, so one situation always reads the same. */
export function renderUser(text: string, ctx: RouteContext): string {
  const lines = [`Command: ${text.replace(/\s+/g, " ").trim()}`, `Spoken into: ${ctx.origin ?? "none"}`];
  const devices = [...ctx.devices].sort((a, b) => KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind));
  if (!devices.length) lines.push("Devices online: none");
  else {
    lines.push("Devices online:");
    for (const d of devices) {
      const ins = ordered(d.inputs, INPUTS).join(", ") || "none";
      const outs = ordered(d.outputs, OUTPUTS).join(", ") || "none";
      lines.push(`- ${d.kind}${d.active ? " (active)" : ""}: in ${ins}; out ${outs}`);
    }
  }
  return lines.join("\n");
}

export function routerMessages(text: string, ctx: RouteContext): Array<{ role: "system" | "user"; content: string }> {
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: renderUser(text, ctx) },
  ];
}

/** General models sometimes wrap JSON in a code fence. The schema check stays strict either way. */
export function stripFences(text: string): string {
  const t = text.trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return m ? m[1] : t;
}
