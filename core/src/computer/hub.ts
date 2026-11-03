// /v1/driver: the Playwright driver on the Mac dials in here, so Core can run
// anywhere. Core sends it one batch of translated actions at a time and gets back
// a screenshot for the model, a small frame for the timeline, and whether the
// commit guard paused or a CAPTCHA stopped the run.
//
//   driver → Core   hello { driver: { name, viewport, allow } }
//   Core → driver   welcome
//   Core → driver   start { seq, url } · actions { seq, actions } · commit { seq } · end { seq }
//   driver → Core   result { seq, status, url, title, screenshot, frame, paused?, stopped?, error? }
import { WebSocket, WebSocketServer } from "ws";
import { z } from "zod";
import { silentOps, type OpsLog } from "../obs/opslog.ts";
import type { DriverAction } from "./actions.ts";

const image = (max: number) => z.string().max(max).regex(/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/=]+$/);

export const DriverHello = z.object({
  type: z.literal("hello"),
  driver: z.object({
    name: z.string().max(64).default("driver"),
    viewport: z.object({ width: z.number().int().positive().max(4000), height: z.number().int().positive().max(4000) }),
    allow: z.array(z.string().max(253)).max(50),
  }),
});
export type DriverInfo = z.infer<typeof DriverHello>["driver"];

export const DriverResult = z.object({
  type: z.literal("result"),
  seq: z.number().int(),
  status: z.enum(["ok", "paused", "stopped", "error"]),
  url: z.string().max(4096).default(""),
  title: z.string().max(300).default(""),
  /** For the model: the full viewport. */
  screenshot: image(12_000_000).optional(),
  /** For the timeline: a small JPEG. */
  frame: image(200_000).optional(),
  /** The commit guard stopped before this click or key. */
  paused: z.object({ reason: z.string().max(300), role: z.string().max(40), name: z.string().max(300) }).optional(),
  /** The run can't go on: a CAPTCHA, a site off the allowlist, or the window was closed. */
  stopped: z.object({ reason: z.enum(["captcha", "blocked", "closed"]), detail: z.string().max(300) }).optional(),
  error: z.string().max(500).optional(),
});
export type DriverResult = z.infer<typeof DriverResult>;

/** One task's hold on the browser. The runner only ever sees this. */
export interface DriverLink {
  start(url: string): Promise<DriverResult>;
  act(actions: DriverAction[]): Promise<DriverResult>;
  /** Perform the click or key the commit guard paused on. Only after an approved tap. */
  commit(): Promise<DriverResult>;
  /** The task is over; the window stays open for the user. */
  end(): Promise<void>;
}

type Command = { type: "start"; url: string } | { type: "actions"; actions: DriverAction[] } | { type: "commit" } | { type: "end" };

interface Pending {
  resolve: (r: DriverResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class DriverHub {
  /** Core's server routes authenticated /v1/driver upgrades here. */
  readonly wss = new WebSocketServer({ noServer: true, maxPayload: 16 << 20 });
  #ws: WebSocket | null = null;
  #info: DriverInfo | null = null;
  #seq = 0;
  #pending = new Map<number, Pending>();
  #busy = false;
  #ops: OpsLog;
  #timeoutMs: number;

  constructor(opts: { ops?: OpsLog; timeoutMs?: number } = {}) {
    this.#ops = opts.ops ?? silentOps;
    this.#timeoutMs = opts.timeoutMs ?? 30_000;
    this.wss.on("connection", (ws: WebSocket) => this.#attach(ws));
  }

  connected(): boolean {
    return this.#ws?.readyState === WebSocket.OPEN && this.#info !== null;
  }

  info(): DriverInfo | null {
    return this.connected() ? this.#info : null;
  }

  /** The browser is shared, so one task holds it at a time. */
  claim(): DriverLink {
    if (!this.connected()) throw new Error("No browser driver is connected. Start it on the Mac with `cd driver && npm start`.");
    if (this.#busy) throw new Error("The browser is already running a task.");
    this.#busy = true;
    let released = false;
    return {
      start: (url) => this.#request({ type: "start", url }),
      act: (actions) => this.#request({ type: "actions", actions }),
      commit: () => this.#request({ type: "commit" }),
      end: async () => {
        if (released) return;
        released = true;
        try {
          if (this.connected()) await this.#request({ type: "end" }, 5000);
        } catch {
          // The window stays as it is; nothing else to undo.
        } finally {
          this.#busy = false;
        }
      },
    };
  }

  close(): void {
    this.#ws?.close(1001, "Core is shutting down");
    this.wss.close();
  }

  #request(cmd: Command, timeoutMs = this.#timeoutMs): Promise<DriverResult> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("The browser driver disconnected."));
    const seq = ++this.#seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(seq);
        reject(new Error(`The browser driver didn't answer "${cmd.type}" in time.`));
      }, timeoutMs);
      this.#pending.set(seq, { resolve, reject, timer });
      ws.send(JSON.stringify({ ...cmd, seq }));
    });
  }

  #failAll(message: string): void {
    for (const [seq, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
      this.#pending.delete(seq);
    }
  }

  #attach(ws: WebSocket): void {
    const helloTimer = setTimeout(() => ws.close(1008, "hello first"), 10_000);
    ws.on("message", (raw) => {
      let data: unknown;
      try {
        data = JSON.parse(String(raw));
      } catch {
        return ws.close(1008, "bad message");
      }
      const hello = DriverHello.safeParse(data);
      if (hello.success) {
        clearTimeout(helloTimer);
        if (this.#ws && this.#ws !== ws) {
          this.#failAll("The browser driver was replaced by a newer one.");
          this.#ws.close(4000, "Replaced by a newer driver.");
        }
        this.#ws = ws;
        this.#info = hello.data.driver;
        this.#ops.info("driver.online", { name: this.#info.name, allow: this.#info.allow.length });
        ws.send(JSON.stringify({ type: "welcome" }));
        return;
      }
      if (this.#ws !== ws) return ws.close(1008, "hello first");
      const result = DriverResult.safeParse(data);
      const seq = result.success ? result.data.seq : Number((data as { seq?: unknown })?.seq);
      const p = this.#pending.get(seq);
      if (!p) return;
      this.#pending.delete(seq);
      clearTimeout(p.timer);
      if (result.success) p.resolve(result.data);
      else p.reject(new Error("The browser driver sent a result Core couldn't read."));
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#info = null;
      this.#failAll("The browser driver disconnected.");
      this.#ops.info("driver.offline", {});
    });
  }
}
