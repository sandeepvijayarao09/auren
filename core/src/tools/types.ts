import type { Tier } from "../protocol.ts";
import type { SurfaceRegistry } from "../surfaces.ts";

export interface ToolContext {
  session: string;
  originSurfaceId?: string;
  surfaces: SurfaceRegistry;
}

export interface UndoStep {
  tool: string;
  namespace: string;
  args: Record<string, unknown>;
}

export interface ToolSpec<A = any, R = any> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  tier: Tier;
  /** Hidden from the model until tool_search loads it. */
  deferred?: boolean;
  /** The result carries outside content (email, chat, web) and is passed back as untrusted data. */
  external?: boolean;
  /** Not offered to the model (used by undo). */
  hidden?: boolean;
  run: (args: A, ctx: ToolContext) => Promise<R>;
  summarize?: (args: A, result?: R) => string;
  undo?: (args: A, result: R) => UndoStep | undefined;
  /** A link to the change in the app itself (the event, the message), shown as Proof on the receipt. */
  proof?: (args: A, result: R) => string | undefined;
}

export interface Namespace {
  name: string;
  app: string;
  description: string | ((ctx: ToolContext) => string);
  tools: ToolSpec[];
  /** Offer this namespace only when it can work right now (e.g. a device is online). */
  available?: (ctx: ToolContext) => boolean;
}

/** JSON-schema helper for flat object parameters. */
export function params(props: Record<string, { type: string; description?: string; items?: unknown }>, optional: string[] = []) {
  return {
    type: "object",
    properties: props,
    required: Object.keys(props).filter((k) => !optional.includes(k)),
    additionalProperties: false,
  };
}
