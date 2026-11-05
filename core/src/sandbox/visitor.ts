// One sandbox visitor: their own demo worlds (scenes.ts), in-memory event log and
// simulated phone, watch and glasses. Nothing is shared between visitors, and
// nothing here can reach a live connector, a paired device, the camera, the
// driver, or the Mac's log and keys: those objects are never created in sandbox mode.
import { randomBytes } from "node:crypto";
import { EventLog } from "../eventlog.ts";
import type { BaseWorld } from "../eval/world.ts";
import type { Preferences } from "../memory/preferences.ts";
import type { Manifest, ServerMessage, Tier } from "../protocol.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { buildScene, SCENES, type Scene, type SceneId } from "./scenes.ts";

/** The demo scene's session name. Every visitor's log is its own in-memory database; Maya's scene has its own session in it. */
export const SESSION = SCENES.demo.session;

export type DeviceId = "phone" | "watch" | "glasses";

/** The same presets as the console and AurenKit. */
export const DEVICES: Array<Manifest & { id: DeviceId }> = [
  { id: "phone", kind: "phone", name: "iPhone", inputs: ["voice", "text", "touch", "camera"], outputs: ["voice", "screen"] },
  { id: "watch", kind: "watch", name: "Apple Watch", inputs: ["voice", "text", "touch"], outputs: ["voice", "haptic", "screen"] },
  { id: "glasses", kind: "glasses", name: "Ray-Ban Meta glasses", inputs: ["voice", "camera"], outputs: ["voice"] },
];

/** Something a simulated device said or showed. */
export interface Output {
  id: number;
  at: number;
  surface: DeviceId;
  type: "speak" | "card";
  text?: string;
  title?: string;
  body?: string;
}

/** A tap waiting on one of the visitor's devices. */
export interface PendingTap {
  request_id: string;
  summary: string;
  tier: Tier;
  surface: DeviceId;
  /** The button's word from the tool (R12), such as Post or Confirm. */
  verb?: string;
}

const MAX_OUTPUTS = 200;

export class Visitor {
  /** A 128-bit bearer secret: the only thing that names this visitor. */
  readonly id = randomBytes(16).toString("base64url");
  readonly ip: string;
  readonly createdAt: number;
  lastActive: number;
  readonly log = new EventLog();
  readonly surfaces: SurfaceRegistry;
  readonly outputs: Output[] = [];
  readonly taps = new Map<string, PendingTap>();
  /** The worlds built so far. Maya's is built the first time one of her examples plays. */
  readonly scenes = new Map<SceneId, Scene>();
  /** The world commands run in now. It changes only between commands. */
  scene: Scene;
  /** Cases and examples played to the end, so GP5 can ask for GP1 first. */
  readonly played = new Set<string>();
  /** Cases whose fixtures are seeded (the planted email goes in once). */
  readonly seeded = new Set<string>();
  busy = false;
  /** A tap in the current command was declined or expired. */
  declined = false;
  closed = false;
  #up = new Set<DeviceId>();
  #timers = new Set<ReturnType<typeof setTimeout>>();
  #outSeq = 0;

  constructor(ip: string, now: number) {
    this.ip = ip;
    this.createdAt = this.lastActive = now;
    this.surfaces = new SurfaceRegistry({
      onEvent: (kind, data) => {
        // Taps and handoffs belong to the command that's running, so to the current scene.
        this.log.append(this.session, kind, data);
        if (kind === "approval" && data.status !== "requested") {
          this.taps.delete(String(data.request_id));
          if (data.status === "declined" || data.status === "expired") this.declined = true;
        }
      },
    });
    this.scene = this.enter("demo");
    for (const d of DEVICES) this.up(d.id);
  }

  get session(): string {
    return this.scene.session;
  }

  get world(): BaseWorld {
    return this.scene.world;
  }

  get tools(): ToolRegistry {
    return this.scene.tools;
  }

  get prefs(): Preferences {
    return this.scene.prefs;
  }

  /** Switches to a scene, building it the first time. Only between commands: the sandbox never calls it mid-command. */
  enter(id: SceneId): Scene {
    let s = this.scenes.get(id);
    if (!s) {
      s = buildScene(id, this.log);
      s.world.camera.attach(this.surfaces);
      this.scenes.set(id, s);
    }
    this.scene = s;
    return s;
  }

  /** The scene a session belongs to. */
  sceneOf(session: string): Scene | undefined {
    return [...this.scenes.values()].find((s) => s.session === session);
  }

  /** A timer the visitor owns, cleared when it expires. Scripted model time and script actions use it. */
  later(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const t = setTimeout(() => {
      this.#timers.delete(t);
      if (!this.closed) fn();
    }, ms);
    this.#timers.add(t);
    return t;
  }

  cancel(t: ReturnType<typeof setTimeout>): void {
    clearTimeout(t);
    this.#timers.delete(t);
  }

  isUp(id: DeviceId): boolean {
    return this.#up.has(id);
  }

  /** Puts a simulated device on (it joins, and presence keeps it online). */
  up(id: DeviceId): void {
    const d = DEVICES.find((x) => x.id === id);
    if (!d || this.#up.has(id) || this.closed) return;
    this.#up.add(id);
    this.surfaces.join(d, (msg) => this.#receive(id, msg));
    this.surfaces.heartbeat(id, true);
  }

  /** Takes a simulated device off, as a script's "drop" does: what it held moves on. */
  down(id: DeviceId): void {
    if (!this.#up.delete(id)) return;
    this.surfaces.leave(id);
  }

  /** Every device back on, after a command that took one off. */
  restore(): void {
    for (const d of DEVICES) this.up(d.id);
  }

  /** Presence: worn and carried devices report themselves active. Called on a shared ticker. */
  beat(): void {
    for (const id of this.#up) this.surfaces.heartbeat(id, true);
  }

  close(): void {
    this.closed = true;
    for (const s of this.scenes.values()) s.prefs.close();
    for (const t of this.#timers) clearTimeout(t);
    this.#timers.clear();
  }

  #receive(id: DeviceId, msg: ServerMessage): void {
    if (this.closed) return;
    if (msg.type === "approval_request") {
      this.taps.set(msg.request_id, { request_id: msg.request_id, summary: msg.summary, tier: msg.tier, surface: id, ...(msg.verb ? { verb: msg.verb } : {}) });
    } else if (msg.type === "approval_cancel") {
      if (this.taps.get(msg.request_id)?.surface === id) this.taps.delete(msg.request_id);
    } else if (msg.type === "speak") {
      this.#push({ surface: id, type: "speak", text: msg.text });
      // A simulated device "plays" a sentence at once, so a finished reply never follows a device that drops later.
      if (msg.reply_id) {
        const reply = msg.reply_id;
        this.later(0, () => this.surfaces.progress(reply, msg.seq ?? 0, id));
      }
    } else if (msg.type === "show_card") {
      this.#push({ surface: id, type: "card", title: msg.title, body: msg.body });
    } else if (msg.type === "capture_request") {
      // The glasses (or the phone) answer with the eval's synthetic poster, never a real camera.
      this.later(0, () => this.world.camera.shoot(msg.request_id, id));
    }
  }

  #push(o: Omit<Output, "id" | "at">): void {
    this.outputs.push({ id: ++this.#outSeq, at: Date.now(), ...o });
    if (this.outputs.length > MAX_OUTPUTS) this.outputs.splice(0, this.outputs.length - MAX_OUTPUTS);
  }
}
