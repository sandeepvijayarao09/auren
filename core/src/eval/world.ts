// The tools the eval plays against: the demo world plus devices, with a case's
// fixtures seeded in. Every namespace in the build plan is here now: glasses (R6),
// browser (R7), memory and receipts (R8), and journal, an MCP server (R11). A round
// that adds another puts it in PLANNED until it lands, and the cases that need it
// are skipped until then.
import type { MuseLike } from "../agent/loop.ts";
import { createBrowser } from "../computer/browser.ts";
import { McpBridge, memoryServer } from "../connectors/mcp.ts";
import { journalInMemory } from "../connectors/mcp-journal.ts";
import type { DriverInfo, DriverLink, DriverResult } from "../computer/hub.ts";
import type { EventLog } from "../eventlog.ts";
import { createMemory } from "../memory/memory.ts";
import { createReceipts } from "../memory/receipts.ts";
import type { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { surfacesNamespace } from "../tools/surfaces.ts";
import type { Namespace } from "../tools/types.ts";
import { CaptureBroker, type Frame } from "../vision/capture.ts";
import { CropStore } from "../vision/crops.ts";
import { createGlasses } from "../vision/look.ts";
import type { PosterFields, PosterReader, Segmenter } from "../vision/models.ts";
import { posterJpeg } from "../vision/test-frames.ts";

/** Namespaces the build plan adds later, and the round that adds each one. */
export const PLANNED = new Map<string, string>();

export interface WorldDeps {
  log: EventLog;
  session: string;
}

/**
 * GP2's camera: Core's real CaptureBroker, asked through the case's surfaces. The
 * glasses answer with a synthetic poster frame (on a real device, bystanders are
 * blurred before it leaves), and fixtures stand in for Spark and SAM 3.1, whose
 * parsing R6's own tests cover. So this checks the capture round trip, the receipt
 * crop and what the agent does with the fields, not how well Spark reads.
 */
export class EvalCamera {
  #broker: CaptureBroker | null = null;
  /** What the poster says. The case's `poster` fixture sets it; the date defaults to today. */
  poster: Partial<PosterFields> = {};
  frames = 0;

  attach(surfaces: SurfaceRegistry) {
    this.#broker = new CaptureBroker(surfaces);
  }

  request(purpose: string): Promise<Frame> {
    if (!this.#broker) return Promise.reject(new Error("the eval camera has no surfaces yet"));
    return this.#broker.request(purpose);
  }

  /** What the glasses do with a capture_request: send one frame back. */
  shoot(requestId: string, surfaceId: string) {
    if (this.#broker?.deliver(requestId, surfaceId, posterJpeg()) === "accepted") this.frames++;
  }

  readonly reader: PosterReader = {
    read: async (_jpeg, { today }) => ({ title: null, date: today, start: null, place: null, ...this.poster }),
  };

  // The synthetic poster fills the middle third of the frame, so that's what SAM "outlines".
  readonly segmenter: Segmenter = {
    segment: async (_jpeg, { x, y }) => ({ x1: Math.round(x * (2 / 3)), y1: Math.round(y / 2), x2: Math.round(x * (4 / 3)), y2: Math.round(y * 1.5) }),
  };
}

const SITE = "https://www.opentable.com/r/demo-bistro";
const SHOT = `data:image/jpeg;base64,${posterJpeg(32, 20).toString("base64")}`;

/**
 * GP4's website: a demo booking page behind a fake driver, and a scripted
 * computer-use model that clicks the reserve button and then reports. The fake
 * driver pauses before that click the way the real commit guard does (R7's driver
 * tests cover the guard on real Chromium). So this checks the commit-point tap, the
 * receipt only after an approved commit, and the CAPTCHA stop, not Muse's clicking.
 */
export class EvalSite {
  /** `captcha` puts a reCAPTCHA in front of the booking page. The case's `page` fixture sets it. */
  page: "reservation" | "captcha" = "reservation";
  #busy = false;

  connected() {
    return true;
  }

  info(): DriverInfo {
    return { name: "eval", viewport: { width: 1280, height: 800 }, allow: ["opentable.com"] };
  }

  claim(): DriverLink {
    if (this.#busy) throw new Error("The browser is already running a task.");
    this.#busy = true;
    const ok = (extra: Partial<DriverResult> = {}): DriverResult => ({ type: "result", seq: 0, status: "ok", url: SITE, title: "Demo Bistro", screenshot: SHOT, frame: SHOT, ...extra });
    return {
      start: async () => ok(),
      act: async (actions) => {
        if (this.page === "captcha") return ok({ status: "stopped", stopped: { reason: "captcha", detail: "reCAPTCHA on the booking page" } });
        if (actions.some((a) => a.type === "click")) {
          return ok({ status: "paused", paused: { reason: '"Complete reservation" looks like a commit', role: "button", name: "Complete reservation" } });
        }
        return ok();
      },
      commit: async () => ok({ url: "https://www.opentable.com/booking/confirmed", title: "You're all set" }),
      end: async () => {
        this.#busy = false;
      },
    };
  }

  /** First turn: click Complete reservation. After that: say what happened. */
  readonly model: MuseLike = {
    responses: {
      create: async (params: Record<string, unknown>) =>
        params.previous_response_id
          ? { id: "cu_2", output: [], output_text: "Demo Bistro is holding a table for two at 8:00 PM." }
          : { id: "cu_1", output: [{ type: "computer_call", call_id: "cc_1", actions: [{ type: "click", x: 640, y: 560, button: "left" }], pending_safety_checks: [] }] },
    },
  };
}

/**
 * Everything but MCP: the demo world, devices, vision, computer use and memory. The
 * public sandbox (R13) builds each visitor's world from this, so it never gets MCP.
 */
export function baseWorld(deps: WorldDeps) {
  const world = createDemoWorld();
  const camera = new EvalCamera();
  const site = new EvalSite();
  const crops = new CropStore();
  const base: Namespace[] = [
    ...world.namespaces,
    surfacesNamespace,
    createGlasses({ broker: camera, reader: camera.reader, segmenter: camera.segmenter, crops }),
    createBrowser({ hub: site, muse: site.model, model: "scripted-computer-use", log: deps.log }),
  ];
  // R8: Auren Memory answers from its local fallback here (no Baseten in the eval), and
  // receipts.undo resolves undo steps against the same tools the case runs.
  const registry = new ToolRegistry().add(...base);
  const memory = [createMemory({ log: deps.log }), createReceipts({ log: deps.log, tools: registry })];
  registry.add(...memory);
  return { state: world.state, camera, site, crops, namespaces: [...base, ...memory] };
}

export type BaseWorld = ReturnType<typeof baseWorld>;

/** Async because MCP servers connect before a case starts (R11). Call `close()` when the case ends. */
export async function evalWorld(deps: WorldDeps) {
  const world = baseWorld(deps);
  // R11: MCP bridge. The fictional Journal server over an in-memory transport, trusted as
  // in mcp.example.json: list_entries (read-only) runs on its own, add_entry asks for a tap.
  const journal = journalInMemory();
  const mcp = new McpBridge({ servers: [memoryServer("journal", () => journal.connect(), { trust: true })] });
  mcp.start();
  await mcp.ready();
  return { ...world, journal, namespaces: [...world.namespaces, ...mcp.namespaces], close: () => mcp.close() };
}

export type EvalWorld = Awaited<ReturnType<typeof evalWorld>>;

/** Seeds a case's fixtures. Returns the keys it doesn't know, so the runner can fail loudly. */
export function applyFixtures(world: BaseWorld, fixtures: Record<string, unknown>): string[] {
  const unknown: string[] = [];
  for (const [key, value] of Object.entries(fixtures)) {
    if (key === "after" || key === "expect_event") continue; // the runner plays that case first, or checks this event after
    if (key === "gmail.threads" && Array.isArray(value)) {
      // Newest first, so "the latest email" is the planted one.
      const planted = value.map((t, i) => ({ id: `thr_fx${i + 1}`, ...(t as { from: string; subject: string; snippet: string }) }));
      world.state.threads.unshift(...planted);
      continue;
    }
    if (key === "poster" && value && typeof value === "object") {
      world.camera.poster = value as Partial<PosterFields>;
      continue;
    }
    if (key === "page" && (value === "reservation" || value === "captcha")) {
      world.site.page = value;
      continue;
    }
    unknown.push(key);
  }
  return unknown;
}
