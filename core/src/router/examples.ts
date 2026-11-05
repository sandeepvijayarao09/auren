// Free labels for the Auren Router, from the event log. Each command's text and
// the devices online at the time become the input; what actually happened becomes
// the label: the namespaces of the tools it called, the highest tier among them,
// the surface the reply was spoken on, and whether glasses.look ran.
//
// The export holds command text, so GET /v1/router/examples answers only on this
// Mac (like /v1/pair/start), and `router/data/`, where it's saved, isn't committed.
import { z } from "zod";
import type { EventLog } from "../eventlog.ts";
import type { AurenEvent } from "../protocol.ts";
import { RouteDevice, type RouteContext } from "./prompt.ts";
import { APPS, Route, SURFACES, TIERS, type App, type RouteSurface } from "./router.ts";

export interface RouterExample {
  text: string;
  context: RouteContext;
  label: Route;
  source: "logged";
  at: number;
  event_id: number;
}

/** The devices the loop records on each utterance (agent/loop.ts). */
const LoggedDevices = z.array(RouteDevice.extend({ id: z.string() }));
type Tier = (typeof TIERS)[number];

interface Open {
  event: AurenEvent;
  text: string;
  devices: z.infer<typeof LoggedDevices>;
  apps: App[];
  tiers: Tier[];
  looked: boolean;
}

const surfaceOf = (kind: string): RouteSurface | undefined => (kind === "desktop" ? "web" : (SURFACES as readonly string[]).includes(kind) ? (kind as RouteSurface) : undefined);

/**
 * Walks the log in order. A command runs from its utterance to its reply. One
 * that overlaps another (a second utterance before the first reply) is dropped,
 * since the log can't say whose tool calls were whose; so is one that failed,
 * had no device context, or whose reply went to a surface the router can't name.
 * A tool call counts even if you declined it: the command still needed it.
 */
export function examplesFrom(events: Iterable<AurenEvent>): RouterExample[] {
  const out: RouterExample[] = [];
  let open: Open | null = null;
  let tainted = false;
  for (const e of events) {
    if (e.kind === "utterance") {
      // A second command before the first one's reply: neither can be labelled.
      tainted = open !== null;
      const devices = LoggedDevices.safeParse(e.data.devices);
      open = typeof e.data.text === "string" && devices.success ? { event: e, text: e.data.text, devices: devices.data, apps: [], tiers: [], looked: false } : null;
      if (!open) tainted = false;
      continue;
    }
    if (!open) continue;
    if (e.kind === "tool_call") {
      // A contact lookup Core started from the words (agent/preload.ts) isn't a choice the command made.
      if (e.data.preload === true) continue;
      const ns = String(e.data.namespace ?? "");
      if ((APPS as readonly string[]).includes(ns) && !open.apps.includes(ns as App)) open.apps.push(ns as App);
      if ((TIERS as readonly string[]).includes(String(e.data.tier))) open.tiers.push(e.data.tier as Tier);
      if (ns === "glasses" && e.data.tool === "look") open.looked = true;
    } else if (e.kind === "error" && !e.data.tool) {
      // The command itself failed (a tool's own error carries `tool` and doesn't end it).
      open = null;
      tainted = false;
    } else if (e.kind === "reply") {
      const spokenOn = open.devices.find((d) => d.id === e.data.spoken_on);
      const surface = spokenOn && surfaceOf(spokenOn.kind);
      const origin = open.devices.find((d) => d.id === open!.event.data.surface_id)?.kind ?? null;
      const label = surface
        ? Route.safeParse({
            apps: open.apps,
            risk_tier: open.tiers.reduce<Tier>((hi, t) => (TIERS.indexOf(t) > TIERS.indexOf(hi) ? t : hi), "read"),
            reply_surface: surface,
            needs_vision: open.looked,
          })
        : null;
      if (!tainted && label?.success) {
        out.push({
          text: open.text.replace(/\s+/g, " ").trim(),
          context: { origin, devices: open.devices.map(({ kind, inputs, outputs, active }) => ({ kind, inputs, outputs, active })) },
          label: label.data,
          source: "logged",
          at: open.event.at,
          event_id: open.event.id,
        });
      }
      open = null;
      tainted = false;
    }
  }
  return out;
}

/** Every event in a session, page by page (since() returns at most 500 at a time). */
export function* allEvents(log: Pick<EventLog, "since">, session: string): Generator<AurenEvent> {
  let after = 0;
  for (;;) {
    const page = log.since(session, after, 500);
    if (!page.length) return;
    yield* page;
    after = page[page.length - 1].id;
  }
}

/** The export as JSON lines, which `router/auren_router/data.py logged` reads. */
export function examplesJsonl(log: Pick<EventLog, "since">, session: string): string {
  return examplesFrom(allEvents(log, session)).map((x) => `${JSON.stringify(x)}\n`).join("");
}
