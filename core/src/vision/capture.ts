// Camera frames on request. Core asks the best camera surface (glasses before a
// phone) for one frame, then accepts it only for a request it made, and only from
// the surface it asked. The camera never runs unless a command needs it.
import { randomUUID } from "node:crypto";
import type { SurfaceRegistry } from "../surfaces.ts";

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;
export const CAPTURE_TIMEOUT_MS = 5_000;

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

  constructor(surfaces: SurfaceRegistry, opts: { timeoutMs?: number } = {}) {
    this.#surfaces = surfaces;
    this.#timeoutMs = opts.timeoutMs ?? CAPTURE_TIMEOUT_MS;
  }

  /** Asks the best camera surface for one frame. Rejects if none is online or none arrives in time. */
  request(purpose: string): Promise<Frame> {
    const target = this.#surfaces.camera();
    if (!target) return Promise.reject(new CaptureError("No camera is online. Put on the glasses or open Auren on the phone."));
    const requestId = randomUUID();
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
