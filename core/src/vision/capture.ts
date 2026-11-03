// Camera frames on request. Core asks the best camera surface (glasses before a
// phone) for one frame, then accepts it only for a request it made, and only from
// the surface it asked. The camera never runs unless a command needs it.
import { randomUUID } from "node:crypto";
import type { SurfaceRegistry } from "../surfaces.ts";

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const CAPTURE_TIMEOUT_MS = 5_000;
/** R9: how long an early frame (started on the Auren Router's hint) stays usable. */
export const PREFETCH_TTL_MS = 3_000;

export interface Frame {
  requestId: string;
  surfaceId: string;
  /** The surface kind, such as glasses or phone. */
  kind: string;
  jpeg: Buffer;
}

export class CaptureError extends Error {}

export type Delivery = "accepted" | "unknown" | "wrong_surface";

interface Pending {
  surfaceId: string;
  kind: string;
  resolve: (frame: Frame) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class CaptureBroker {
  #surfaces: SurfaceRegistry;
  #timeoutMs: number;
  #pending = new Map<string, Pending>();
  #prefetchTtlMs: number;
  #early: { requestId: string; frame: Promise<Frame>; timer: ReturnType<typeof setTimeout> } | undefined;

  constructor(surfaces: SurfaceRegistry, opts: { timeoutMs?: number; prefetchTtlMs?: number } = {}) {
    this.#surfaces = surfaces;
    this.#timeoutMs = opts.timeoutMs ?? CAPTURE_TIMEOUT_MS;
    this.#prefetchTtlMs = opts.prefetchTtlMs ?? PREFETCH_TTL_MS;
  }

  /** Asks the best camera surface for one frame. Rejects if none is online or none arrives in time. */
  request(purpose: string): Promise<Frame> {
    // R9: a capture the router started for this command is already in flight; take it.
    const early = this.#early;
    if (early) {
      this.#early = undefined;
      clearTimeout(early.timer);
      return early.frame;
    }
    return this.#capture(purpose, randomUUID());
  }

  /**
   * R9: starts a capture before glasses.look asks, when the Auren Router says this
   * command needs the camera. The next request() takes it if it's under 3 s old.
   * After that it's dropped, and a frame that arrives late is refused like any
   * unknown one. Nothing else can read it. False when no camera is online.
   */
  prefetch(purpose: string): boolean {
    if (this.#early) return true;
    // A capture already waiting (look asked first) is all this command needs.
    if (this.#pending.size || !this.#surfaces.camera()) return false;
    const requestId = randomUUID();
    const frame = this.#capture(purpose, requestId);
    const timer = setTimeout(() => {
      if (this.#early?.requestId !== requestId) return;
      this.#early = undefined;
      const p = this.#pending.get(requestId);
      if (p) clearTimeout(p.timer);
      this.#pending.delete(requestId);
    }, this.#prefetchTtlMs);
    this.#early = { requestId, frame, timer };
    // A failed early capture leaves request() to ask again.
    frame.catch(() => {
      if (this.#early?.requestId !== requestId) return;
      clearTimeout(timer);
      this.#early = undefined;
    });
    return true;
  }

  #capture(purpose: string, requestId: string): Promise<Frame> {
    const target = this.#surfaces.camera();
    if (!target) return Promise.reject(new CaptureError("No camera is online. Put on the glasses or open Auren on the phone."));
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new CaptureError(`The ${target.kind} didn't send a frame within ${Math.round(this.#timeoutMs / 100) / 10} s.`));
      }, this.#timeoutMs);
      // Registered before sending, so a surface that answers at once still finds it.
      this.#pending.set(requestId, { surfaceId: target.id, kind: target.kind, resolve, timer });
      if (!this.#surfaces.sendTo(target.id, { type: "capture_request", request_id: requestId, purpose })) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(new CaptureError(`The ${target.kind} went offline.`));
      }
    });
  }

  /** The surface a request is waiting on, or undefined when nothing is waiting. */
  target(requestId: string): string | undefined {
    return this.#pending.get(requestId)?.surfaceId;
  }

  /** A frame for an outstanding request. A wrong sender leaves the request waiting for the right one. */
  deliver(requestId: string, fromSurfaceId: string, jpeg: Buffer): Delivery {
    const p = this.#pending.get(requestId);
    if (!p) return "unknown";
    if (p.surfaceId !== fromSurfaceId) return "wrong_surface";
    this.#pending.delete(requestId);
    clearTimeout(p.timer);
    p.resolve({ requestId, surfaceId: p.surfaceId, kind: p.kind, jpeg });
    return "accepted";
  }
}
