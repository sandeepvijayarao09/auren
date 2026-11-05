// The Auren Router: one fast call that names the apps a command needs, its likely
// tier, where the reply should go and whether it needs the camera. It's advisory.
// Core uses it to preload tools, start the camera early and shape the ack; each
// tool's tier stays the only authority (ARCHITECTURE.md §16).
//
// Order: the Glimmer LoRA on Modal when AUREN_ROUTER_URL is set (300 ms budget),
// else Muse Spark when a key is configured (a tight budget too), else rules. Every
// outbound call lands in the ledger; the ops log gets the source, ms and ok, never
// the command.
import { z } from "zod";
import type { MuseLike } from "../agent/loop.ts";
import { silentOps, type OpsLog } from "../obs/opslog.ts";
import type { OutboundCall } from "../security/ledger.ts";
import type { SurfaceRegistry } from "../surfaces.ts";
import { RouteContext, renderUser, routerMessages, stripFences, SYSTEM, type RouteDevice } from "./prompt.ts";

export { RouteContext } from "./prompt.ts";

// Mirrors router/auren_router/schema.py exactly; router.test.ts reads schema.py to check.
export const APPS = ["calendar", "slack", "gmail", "browser", "glasses", "memory", "receipts"] as const;
export const TIERS = ["read", "write", "send"] as const;
export const SURFACES = ["watch", "glasses", "phone", "web"] as const;
export type App = (typeof APPS)[number];
export type RouteSurface = (typeof SURFACES)[number];

export const Route = z.strictObject({
  // Order-preserving dedupe, as parse() does.
  apps: z.array(z.enum(APPS)).transform((apps) => [...new Set(apps)]),
  risk_tier: z.enum(TIERS),
  reply_surface: z.enum(SURFACES),
  needs_vision: z.boolean(),
});
export type Route = z.output<typeof Route>;

/** One completion → a Route. Throws on anything off-schema, and the router falls back. */
export function parseRoute(text: string): Route {
  return Route.parse(JSON.parse(stripFences(text)));
}

export type RouteSource = "glimmer" | "spark" | "rules";
export interface Routed {
  route: Route;
  source: RouteSource;
  ms: number;
}

export interface RouterLike {
  /** Never rejects for a valid context: the rules always answer. */
  route(text: string, context: RouteContext, trace?: string): Promise<Routed>;
  /** How long Wonder's first turn may wait for a route to preload from. Spark is too slow to hold the agent for, so it's 0 without Glimmer. */
  holdMs: number;
}

export interface RouterDeps {
  /** The Glimmer LoRA's OpenAI-compatible base URL (…/v1), or its full /chat/completions URL. */
  url?: string;
  key?: string;
  model?: string;
  budgetMs?: number;
  /** Muse Spark through Core's ledger-wrapped client. Pass it only when a key is configured. */
  muse?: MuseLike;
  sparkModel?: string;
  sparkBudgetMs?: number;
  /** The namespaces registered in Core; the rules name only these. */
  namespaces: () => string[];
  ledger?: { record(call: OutboundCall): void };
  ops?: OpsLog;
  fetch?: typeof fetch;
}

export const ROUTER_BUDGET_MS = 300;
export const SPARK_BUDGET_MS = 1_000;

class RouteFailure extends Error {}

const ChatCompletion = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1) });

/** Runs `work` with a deadline; on timeout it aborts the work and rejects. */
function within<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new RouteFailure("timeout"));
    }, ms);
  });
  return Promise.race([work(ac.signal), deadline]).finally(() => clearTimeout(timer));
}

function reasonOf(err: unknown): string {
  if (err instanceof RouteFailure) return err.message;
  if (err instanceof z.ZodError || err instanceof SyntaxError) return "bad_output";
  return "network";
}

function outputText(resp: any): string {
  if (typeof resp?.output_text === "string" && resp.output_text) return resp.output_text;
  const parts: string[] = [];
  for (const item of resp?.output ?? []) {
    if (item.type !== "message") continue;
    for (const c of item.content ?? []) if (c.type === "output_text" && c.text) parts.push(c.text);
  }
  return parts.join("");
}

export function createRouter(deps: RouterDeps): RouterLike {
  const ops = deps.ops ?? silentOps;
  const budgetMs = deps.budgetMs ?? ROUTER_BUDGET_MS;
  const doFetch = deps.fetch ?? fetch;
  const url = deps.url?.replace(/\/+$/, "");
  const endpoint = url && (/\/chat\/completions$/.test(url) ? url : `${url}/chat/completions`);

  async function glimmer(text: string, ctx: RouteContext): Promise<Route> {
    const body = JSON.stringify({ model: deps.model ?? "auren-router", messages: routerMessages(text, ctx), temperature: 0, max_tokens: 64 });
    const t0 = performance.now();
    let status: "ok" | "error" = "error";
    try {
      const content = await within(budgetMs, async (signal) => {
        const res = await doFetch(endpoint!, {
          method: "POST",
          headers: { "content-type": "application/json", ...(deps.key ? { authorization: `Bearer ${deps.key}` } : {}) },
          body,
          signal,
        });
        if (!res.ok) throw new RouteFailure(`http ${res.status}`);
        status = "ok";
        return ChatCompletion.parse(await res.json()).choices[0].message.content ?? "";
      });
      return parseRoute(content);
    } finally {
      // The host only: the Modal URL names a workspace, which is fine; never the body.
      deps.ledger?.record({ service: "Auren Router", operation: `chat.completions ${new URL(endpoint!).host}`, status, ms: performance.now() - t0, bytesOut: Buffer.byteLength(body) });
    }
  }

  async function spark(text: string, ctx: RouteContext): Promise<Route> {
    const resp = await within(deps.sparkBudgetMs ?? SPARK_BUDGET_MS, () =>
      deps.muse!.responses.create({ model: deps.sparkModel, instructions: SYSTEM, input: renderUser(text, ctx), reasoning: { effort: "minimal" }, max_output_tokens: 400 }), // reasoning tokens count against the cap
    );
    return parseRoute(outputText(resp));
  }

  return {
    holdMs: endpoint ? budgetMs : 0,
    async route(text, context, trace) {
      const ctx = RouteContext.parse(context);
      const started = performance.now();
      const attempt = async (source: RouteSource, run: () => Promise<Route>): Promise<Routed | null> => {
        const t0 = performance.now();
        try {
          const route = await run();
          const ms = Math.round(performance.now() - t0);
          ops.info("router.route", { trace, source, ms, ok: true, apps: route.apps, tier: route.risk_tier, surface: route.reply_surface, vision: route.needs_vision });
          return { route, source, ms: Math.round(performance.now() - started) };
        } catch (err) {
          ops.warn("router.route", { trace, source, ms: Math.round(performance.now() - t0), ok: false, reason: reasonOf(err) });
          return null;
        }
      };
      if (endpoint) {
        const r = await attempt("glimmer", () => glimmer(text, ctx));
        if (r) return r;
      }
      if (deps.muse && deps.sparkModel) {
        const r = await attempt("spark", () => spark(text, ctx));
        if (r) return r;
      }
      return (await attempt("rules", async () => rulesRoute(text, ctx, deps.namespaces())))!;
    },
  };
}

// ── rules ──────────────────────────────────────────────────────────────────
// The deterministic fallback, and the baseline the LoRA has to beat. It reads
// clause by clause, so "Undo the calendar move" is about receipts, not calendar.

const KEYWORDS: Array<[App, RegExp]> = [
  ["calendar", /\b(calendar|meetings?|events?|invite\w*|resched\w*|appointments?|standup|1:1|free at|am i free|schedule (a|an|my|the|coffee|time)|my schedule|block (an? )?(hour|time)|clear my|my \d{1,2}(:\d\d)?\s*(am|pm)|my (morning|afternoon|evening|week|day)\b|(coffee|lunch|dinner) with|grading session|ta sync)\b/i],
  ["slack", /\bslack\b|#[a-z0-9-]+|\b(tell|message|ping|post\w*|let|in|to|about)\s+(the\s+)?#?office[- ]hours\b|\b(tell|let|ping|message)\s+the\s+tas\b|\bchannel\b/i],
  ["gmail", /\b(e-?mail\w*|gmail|inbox|drafts?|drafted|mail)\b/i],
  ["browser", /\b(book|reserve|reservation|table for|order|buy|cart|website|site|portal|look up|open now|closes?|closing|menu|shuttle|tickets?|flights?|pay for|study room)\b|\bopen\?|\.com\b/i],
  ["memory", /\b(what did i|did i (already )?(tell|say|ask|send|do)|get done|recap|summar(y|ize)|remind me what|what was the last thing|what have i|when did i|what i did|promised)\b/i],
  ["receipts", /\b(undo|revert|take back|roll back|receipts?|what (did|have) you changed?|you changed)\b/i],
];
const UNDO = /\b(undo|revert|take back|roll back)\b/i;
// "What did I tell office hours?" asks Auren Memory; the app it names is the subject, not a tool to use.
const RECALL = /^\s*(what did i|did i|when did i|what have i|remind me what|what was the last thing)\b/i;
const QUESTION = /^\s*(what|what's|whats|when|did|does|do|is|am|are|any|how|who|where|which|show|read me|catch me|check|find|look up|pull up|remind me)\b/i;
const SEND = /\b(send|post|tell|let \w+( \w+)? know|message|ping|invite\w*|book|reserve|order|buy|pay|hold (it|a|the)|share)\b|^\s*(e-?mail|reply)\b/i;
const WRITE = /\b(move|push|resched\w*|cancel|clear|add|create|block|rename|draft\w*|make a draft|delete|remove|undo|revert|take back|save|put|change|update|snap)\b/i;
const TIME_WORDS = "morning|afternoon|evening|week|weekend|month|year|semester|time|monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DEICTIC = new RegExp(
  `\\b(this|these)\\b(?!\\s+(${TIME_WORDS})\\b)` +
    "|\\b(that|those)\\s+(poster|flyer|sign|menu|board|screen|slide|card|book|building|place|room|event|talk|one|thing|page|label)s?\\b" +
    "|(?<!\\b(near|around|from|over|of|be|i'm|am|is|are|get|stay|wait)\\s)\\bhere\\b",
  "i",
);
const VISUAL = /\b(show me|pull up|summary|summarize|list)\b/i;

const surfaceOf = (kind: string): RouteSurface | undefined => (kind === "desktop" ? "web" : (SURFACES as readonly string[]).includes(kind) ? (kind as RouteSurface) : undefined);

/** Presence rules, as the rubric states them: the device spoken into, unless it can't talk; long or visual answers go to the phone. */
function replySurface(text: string, ctx: RouteContext): RouteSurface {
  const speaks = (d: RouteDevice) => d.outputs.includes("voice") && Boolean(surfaceOf(d.kind));
  const origin = ctx.devices.find((d) => d.kind === ctx.origin);
  const phone = ctx.devices.find((d) => d.kind === "phone");
  if (phone && VISUAL.test(text) && ctx.origin !== "web" && ctx.origin !== "desktop") return "phone";
  if (origin && speaks(origin)) return surfaceOf(origin.kind)!;
  const voice = ctx.devices.find((d) => d.active && speaks(d)) ?? ctx.devices.find(speaks);
  if (voice) return surfaceOf(voice.kind)!;
  if (phone) return "phone";
  return (ctx.origin && surfaceOf(ctx.origin)) || "web";
}

export function rulesRoute(text: string, ctx: RouteContext, namespaces: string[]): Route {
  const found = new Map<App, number>();
  const tiers: Array<(typeof TIERS)[number]> = [];
  const camera = ctx.devices.some((d) => d.inputs.includes("camera"));
  let vision = false;
  let offset = 0;
  // Clauses split at commas, "and", "then" and full stops (but not the one in "Prof. Lee").
  for (const clause of text.split(/(,|;|(?<!\b(?:prof|dr|mr|mrs|ms|st))\.\s|\band\b|\bthen\b)/i)) {
    const at = offset;
    offset += clause.length;
    if (!clause.trim() || /^(,|;|\.\s|and|then)$/i.test(clause)) continue;
    if (UNDO.test(clause)) {
      // An undo clause is about the receipt, whatever app it names.
      if (!found.has("receipts")) found.set("receipts", at);
      tiers.push("write");
      continue;
    }
    if (RECALL.test(clause)) {
      if (!found.has("memory")) found.set("memory", at);
      tiers.push("read");
      continue;
    }
    for (const [app, re] of KEYWORDS) {
      const m = clause.match(re);
      if (m && !found.has(app)) found.set(app, at + (m.index ?? 0));
    }
    const d = camera ? clause.match(DEICTIC) : null;
    if (d) {
      vision = true;
      // Looking comes first: the frame is what the other apps act on.
      found.set("glasses", -1);
    }
    tiers.push(QUESTION.test(clause) ? "read" : SEND.test(clause) ? "send" : WRITE.test(clause) ? "write" : "read");
  }
  const apps = [...found].sort((a, b) => a[1] - b[1]).map(([app]) => app).filter((app) => namespaces.includes(app));
  return Route.parse({
    apps,
    risk_tier: tiers.reduce((hi, t) => (TIERS.indexOf(t) > TIERS.indexOf(hi) ? t : hi), "read"),
    reply_surface: replySurface(text, ctx),
    needs_vision: vision && apps.includes("glasses"),
  });
}

// ── what Core does with a route ─────────────────────────────────────────────

const SPOKEN: Record<App, string> = { calendar: "calendar", slack: "Slack", gmail: "Gmail", browser: "the browser", glasses: "", memory: "Auren Memory", receipts: "your receipts" };

/** The spoken ack a route implies ("On it: Slack, calendar and Gmail."), or null when it names no apps. */
export function ackFor(route: Route, cameraOnline: boolean): string | null {
  const names = route.apps.filter((a) => a !== "glasses").map((a) => SPOKEN[a]);
  const looking = cameraOnline && route.needs_vision;
  if (!names.length) return looking ? "Looking now." : null;
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  if (looking) return `Looking now, then ${list}.`;
  return route.risk_tier === "read" ? `Checking ${list}.` : `On it: ${list}.`;
}

/** The devices online right now, with ids so the event log can say which one the reply went to. */
export interface LiveDevice extends RouteDevice {
  id: string;
}

export function liveDevices(surfaces: SurfaceRegistry): LiveDevice[] {
  return surfaces.online().map((m) => ({ id: m.id, kind: m.kind, inputs: m.inputs, outputs: m.outputs, active: surfaces.isActive(m.id) }));
}

export function contextOf(devices: LiveDevice[], originId?: string | null): RouteContext {
  return {
    origin: devices.find((d) => d.id === originId)?.kind ?? null,
    devices: devices.map(({ kind, inputs, outputs, active }) => ({ kind, inputs, outputs, active })),
  };
}

export interface RouteHints {
  /** The ack the route implies, once it arrives (null if none). */
  ack: Promise<string | null>;
  /** The namespaces to preload, if the route came back within the router's hold. */
  preload: Promise<string[] | undefined>;
}

/**
 * Starts routing a command at the fast lane. Hints only: a route can preload
 * namespaces, start a camera capture early and shape the ack. It never reaches
 * the tier gate. `late()` turns true once Wonder's first turn is back, when an
 * early frame could no longer help, so the camera isn't started for nothing.
 */
export function startHints(
  deps: { router: RouterLike; surfaces: SurfaceRegistry; prefetchFrame?: (purpose: string) => void; ops?: OpsLog },
  text: string,
  context: RouteContext,
  opts: { trace?: string; late: () => boolean },
): RouteHints {
  const routed = deps.router.route(text, context, opts.trace).catch(() => null);
  void routed.then((r) => {
    // The camera runs only for a command the route says needs it, and only while the frame can still be used.
    if (!r?.route.needs_vision || !deps.prefetchFrame || opts.late() || !deps.surfaces.camera()) return;
    try {
      deps.prefetchFrame(text.slice(0, 120));
      (deps.ops ?? silentOps).info("router.prefetch", { trace: opts.trace, source: r.source });
    } catch {
      // An early frame is a nicety; glasses.look still asks for its own.
    }
  });
  const ack = routed.then((r) => (r ? ackFor(r.route, Boolean(deps.surfaces.camera())) : null));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const preload = Promise.race([
    routed.then((r) => r?.route.apps),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), deps.router.holdMs);
    }),
  ]).finally(() => clearTimeout(timer));
  return { ack, preload };
}
