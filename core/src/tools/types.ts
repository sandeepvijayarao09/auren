import type { Tier } from "../protocol.ts";
import type { SurfaceRegistry } from "../surfaces.ts";

export interface ToolContext {
  session: string;
  originSurfaceId?: string;
  surfaces: SurfaceRegistry;
  /** The command's trace id in the ops log. */
  trace?: string;
  /** The crop glasses.look kept earlier in this command, so the receipts that follow show what Auren saw. */
  seen?: { crop_id: string };
  /** Only for `commitPoint` tools: Core's send-tier tap, asked at the commit itself. */
  approveCommit?: (summary: string) => Promise<boolean>;
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
  /** The tool appends its own receipt (receipts.undo does, through undoReceipt), so the loop doesn't add a second. */
  ownReceipt?: boolean;
  /**
   * A send-tier tool whose tap comes at its own commit point instead of before it
   * runs (computer use browses first, then asks before the confirm click). Core
   * hands it `ctx.approveCommit` and writes a receipt only if that tap approved.
   */
  commitPoint?: boolean;
  /**
   * R12: the word on the approval button for a send-tier tool ("Post", "Send", "Invite",
   * "Confirm"). Display only: Core sends it with approval_request, and a device's signature
   * still covers just the request, the decision and the summary. Surfaces fall back to "Approve".
   */
  verb?: string;
  run: (args: A, ctx: ToolContext) => Promise<R>;
  summarize?: (args: A, result?: R) => string;
  /**
   * A glanceable approval line (about 60 characters, such as "Post to #office-hours") for
   * small screens like the watch. Display only: devices still sign the full summary, which
   * they show when expanded. Falls back to a clipped summary.
   */
  shortSummary?: (args: A) => string;
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
/** "Invite priya@example.com", or "Invite priya@example.com +2" for several. */
export function inviteShort(emails: string[]): string {
  return emails.length > 1 ? `Invite ${emails[0]} +${emails.length - 1}` : `Invite ${emails[0] ?? "people"}`;
}

export function params(props: Record<string, { type: string; description?: string; items?: unknown }>, optional: string[] = []) {
  return {
    type: "object",
    properties: props,
    required: Object.keys(props).filter((k) => !optional.includes(k)),
    additionalProperties: false,
  };
}
