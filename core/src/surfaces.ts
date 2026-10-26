import { randomUUID } from "node:crypto";
import type { EventKind, Manifest, ServerMessage, Tier } from "./protocol.ts";

interface Surface {
  manifest: Manifest;
  send: (msg: ServerMessage) => void;
  lastSeen: number;
  lastActiveAt: number;
  active: boolean;
  offline: boolean;
}

interface PendingApproval {
  requestId: string;
  summary: string;
  tier: Tier;
  surfaceId: string | null;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

type Purpose = "speak" | "approval" | "card";

export interface SurfaceRegistryOptions {
  now?: () => number;
  presenceTimeoutMs?: number;
  onEvent?: (kind: EventKind, data: Record<string, unknown>) => void;
}

/**
 * Tracks which surfaces are online and routes each output to the best one.
 * When a surface holding a pending approval goes offline, the approval moves
 * to the next best surface (handoff): the task follows the person.
 */
export class SurfaceRegistry {
  #surfaces = new Map<string, Surface>();
  #pending = new Map<string, PendingApproval>();
  #now: () => number;
  #timeoutMs: number;
  #onEvent: (kind: EventKind, data: Record<string, unknown>) => void;

  constructor(opts: SurfaceRegistryOptions = {}) {
    this.#now = opts.now ?? Date.now;
    this.#timeoutMs = opts.presenceTimeoutMs ?? 3000;
    this.#onEvent = opts.onEvent ?? (() => {});
  }

  join(manifest: Manifest, send: (msg: ServerMessage) => void): void {
    const now = this.#now();
    this.#surfaces.set(manifest.id, { manifest, send, lastSeen: now, lastActiveAt: now, active: true, offline: false });
    this.#onEvent("surface", { surface_id: manifest.id, kind: manifest.kind, status: "online" });
    // An approval nobody could answer finds its first surface here.
    for (const p of this.#pending.values()) if (!p.surfaceId) this.#offer(p, null);
  }

  leave(id: string): void {
    if (!this.#surfaces.has(id)) return;
    this.#markOffline(id);
    this.#surfaces.delete(id);
  }

  heartbeat(id: string, active: boolean): void {
    const s = this.#surfaces.get(id);
    if (!s) return;
    const now = this.#now();
    s.lastSeen = now;
    s.active = active;
    if (active) s.lastActiveAt = now;
    if (s.offline) {
      s.offline = false;
      this.#onEvent("surface", { surface_id: id, kind: s.manifest.kind, status: "online" });
    }
  }

  /** The person just used this surface (spoke, tapped). */
  touch(id: string | undefined): void {
    const s = id ? this.#surfaces.get(id) : undefined;
    if (!s) return;
    s.lastSeen = s.lastActiveAt = this.#now();
  }

  online(): Manifest[] {
    return [...this.#surfaces.values()].filter((s) => this.#isOnline(s)).map((s) => s.manifest);
  }

  /** Marks surfaces whose heartbeats stopped as offline. Call on an interval. */
  sweep(): void {
    for (const [id, s] of this.#surfaces) if (!s.offline && !this.#isOnline(s)) this.#markOffline(id);
  }

  broadcast(msg: ServerMessage): void {
    for (const s of this.#surfaces.values()) if (!s.offline) s.send(msg);
  }

  speak(text: string, originId?: string): string | null {
    const s = this.#pick("speak", originId);
    s?.send({ type: "speak", text });
    return s?.manifest.id ?? null;
  }

  showCard(title: string, body: string): string | null {
    const s = this.#pick("card");
    s?.send({ type: "show_card", title, body });
    return s?.manifest.id ?? null;
  }

  requestApproval(summary: string, tier: Tier, timeoutMs = 60_000): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => this.#settle(requestId, false, "expired"), timeoutMs);
      const pending: PendingApproval = { requestId, summary, tier, surfaceId: null, resolve, timer };
      this.#pending.set(requestId, pending);
      this.#offer(pending, null);
    });
  }

  answer(requestId: string, approved: boolean, fromSurfaceId?: string): boolean {
    if (!this.#pending.has(requestId)) return false;
    this.touch(fromSurfaceId);
    this.#settle(requestId, approved, "answered", fromSurfaceId);
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────

  #isOnline(s: Surface): boolean {
    return this.#now() - s.lastSeen <= this.#timeoutMs;
  }

  #markOffline(id: string): void {
    const s = this.#surfaces.get(id);
    if (!s || s.offline) return;
    s.offline = true;
    this.#onEvent("surface", { surface_id: id, kind: s.manifest.kind, status: "offline" });
    for (const p of this.#pending.values()) if (p.surfaceId === id) this.#offer(p, id);
  }

  #offer(p: PendingApproval, fromId: string | null): void {
    if (fromId) this.#surfaces.get(fromId)?.send({ type: "approval_cancel", request_id: p.requestId, reason: "moved" });
    const target = this.#pick("approval", undefined, fromId ?? undefined);
    p.surfaceId = target?.manifest.id ?? null;
    target?.send({ type: "approval_request", request_id: p.requestId, summary: p.summary, tier: p.tier });
    if (fromId) {
      this.#onEvent("handoff", { request_id: p.requestId, from: fromId, to: p.surfaceId });
    } else {
      this.#onEvent("approval", { request_id: p.requestId, status: "requested", summary: p.summary, surface_id: p.surfaceId });
    }
  }

  #settle(requestId: string, approved: boolean, reason: "answered" | "expired", by?: string): void {
    const p = this.#pending.get(requestId);
    if (!p) return;
    this.#pending.delete(requestId);
    clearTimeout(p.timer);
    if (p.surfaceId && p.surfaceId !== by) {
      this.#surfaces.get(p.surfaceId)?.send({ type: "approval_cancel", request_id: requestId, reason });
    }
    this.#onEvent("approval", { request_id: requestId, status: reason === "expired" ? "expired" : approved ? "approved" : "declined", surface_id: by ?? null });
    p.resolve(approved);
  }

  #pick(purpose: Purpose, originId?: string, excludeId?: string): Surface | undefined {
    const live = [...this.#surfaces.values()].filter(
      (s) => !s.offline && this.#isOnline(s) && s.manifest.id !== excludeId,
    );
    const has = (s: Surface, o: "voice" | "screen" | "haptic") => s.manifest.outputs.includes(o);
    const best = (cands: Surface[], bonus: (s: Surface) => number) =>
      cands.sort((a, b) => bonus(b) + (b.active ? 1 : 0) - (bonus(a) + (a.active ? 1 : 0)) || b.lastActiveAt - a.lastActiveAt)[0];

    if (purpose === "speak") {
      const origin = live.find((s) => s.manifest.id === originId);
      if (origin && has(origin, "voice")) return origin;
      return best(live.filter((s) => has(s, "voice")), () => 0) ?? best(live.filter((s) => has(s, "screen")), () => 0);
    }
    if (purpose === "approval") {
      return best(live.filter((s) => s.manifest.inputs.includes("touch")), (s) => (has(s, "haptic") ? 2 : 0));
    }
    return best(live.filter((s) => has(s, "screen")), (s) => (s.manifest.kind === "phone" ? 2 : 0));
  }
}
