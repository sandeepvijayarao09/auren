import { randomUUID } from "node:crypto";
import type { EventKind, Manifest, ServerMessage, Tier } from "./protocol.ts";

/** The most a short approval line runs, in characters. */
export const SHORT_MAX = 60;

/** A glanceable approval line: whitespace collapsed, clipped at a word to SHORT_MAX with an ellipsis. */
export function shortFor(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= SHORT_MAX) return t;
  const cut = t.slice(0, SHORT_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= SHORT_MAX * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,:;.-]+$/, "")}…`;
}

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
  /** R12: the approve button's word, such as "Post". Display only, never signed. */
  verb?: string;
  /** A glanceable line for small screens such as the watch. Display only, never signed. */
  short: string;
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** A spoken reply, sent sentence by sentence so the rest can move if its surface drops mid-reply. */
interface Reply {
  id: string;
  chunks: string[];
  surfaceId: string | null;
  /** The last chunk the surface said it finished playing. */
  acked: number;
  startedAt: number;
}

type Purpose = "speak" | "approval" | "card" | "camera";

/** Glasses come off without warning, so they report more often and drop sooner (GP3: the reply moves within 2 s). */
const KIND_TIMEOUT_MS: Partial<Record<string, number>> = { glasses: 1500 };
const KIND_HEARTBEAT_MS: Partial<Record<string, number>> = { glasses: 500 };
const REPLY_TTL_MS = 120_000;

/** Splits a reply into sentences (merging very short ones, wrapping very long ones) so it can resume mid-way. */
export function splitSpeech(text: string, max = 180): string[] {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?…])\s+(?=["“(]?[A-Z0-9])/);
  const out: string[] = [];
  for (const sentence of sentences) {
    if (!sentence) continue;
    const pieces: string[] = [];
    let line = "";
    for (const word of sentence.split(" ")) {
      if (line && line.length + word.length + 1 > max) {
        pieces.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
    }
    if (line) pieces.push(line);
    for (const piece of pieces) {
      const last = out.at(-1);
      if (last && last.length + piece.length + 1 <= 40) out[out.length - 1] = `${last} ${piece}`;
      else out.push(piece);
    }
  }
  return out;
}

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
  #replies = new Map<string, Reply>();
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

  /** R9: whether the surface's last heartbeat said it's in use (part of the Auren Router's device context). */
  isActive(id: string): boolean {
    return this.#surfaces.get(id)?.active ?? false;
  }

  /** Marks surfaces whose heartbeats stopped as offline. Call on an interval. */
  sweep(): void {
    for (const [id, s] of this.#surfaces) if (!s.offline && !this.#isOnline(s)) this.#markOffline(id);
    for (const [id, r] of this.#replies) if (this.#now() - r.startedAt > REPLY_TTL_MS) this.#replies.delete(id);
  }

  /** How often a surface of this kind should send heartbeats; sent to it in welcome. */
  heartbeatMsFor(kind: string): number {
    return KIND_HEARTBEAT_MS[kind] ?? 1000;
  }

  broadcast(msg: ServerMessage): void {
    for (const s of this.#surfaces.values()) if (!s.offline) s.send(msg);
  }

  speak(text: string, originId?: string): string | null {
    const s = this.#pick("speak", originId);
    const chunks = splitSpeech(text);
    if (!s || !chunks.length) return s?.manifest.id ?? null;
    const reply: Reply = { id: randomUUID(), chunks, surfaceId: s.manifest.id, acked: -1, startedAt: this.#now() };
    this.#replies.set(reply.id, reply);
    this.#sendSpeech(s, reply, 0);
    return s.manifest.id;
  }

  /** A surface finished playing chunk `seq` of a reply. */
  progress(replyId: string, seq: number, fromSurfaceId: string): void {
    const r = this.#replies.get(replyId);
    if (!r || r.surfaceId !== fromSurfaceId) return;
    r.acked = Math.max(r.acked, seq);
    if (r.acked >= r.chunks.length - 1) this.#replies.delete(replyId);
  }

  showCard(title: string, body: string, action?: { label: string; command: string }): string | null {
    const s = this.#pick("card");
    s?.send({ type: "show_card", title, body, ...(action ? { action } : {}) });
    return s?.manifest.id ?? null;
  }

  /** R12: `verb` labels the approve button ("Post", "Invite", "Confirm"); surfaces fall back to "Approve". */
  /** `short` is the glanceable line for small screens; it defaults to the summary, clipped. */
  requestApproval(summary: string, tier: Tier, timeoutMs = 60_000, verb?: string, short?: string): Promise<boolean> {
    return new Promise((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => this.#settle(requestId, false, "expired"), timeoutMs);
      const pending: PendingApproval = { requestId, summary, tier, surfaceId: null, resolve, timer, short: shortFor(short || summary), ...(verb ? { verb } : {}) };
      this.#pending.set(requestId, pending);
      this.#offer(pending, null);
    });
  }

  /** The pending approval's summary and where it was sent, so its signature can be checked. */
  approvalFor(requestId: string): { summary: string; surfaceId: string | null } | undefined {
    const p = this.#pending.get(requestId);
    return p && { summary: p.summary, surfaceId: p.surfaceId };
  }

  // ── camera ─────────────────────────────────────────────────────────────

  /** The best online surface with a camera: glasses beat a phone, and active beats idle. */
  camera(): Manifest | undefined {
    return this.#pick("camera")?.manifest;
  }

  /** Sends one message to one surface. False when it isn't online. */
  sendTo(id: string, msg: ServerMessage): boolean {
    const s = this.#surfaces.get(id);
    if (!s || s.offline || !this.#isOnline(s)) return false;
    s.send(msg);
    return true;
  }

  /** `signedBy` is the paired device whose Secure Enclave signed this answer, if one did. */
  answer(requestId: string, approved: boolean, fromSurfaceId?: string, signedBy?: string): boolean {
    if (!this.#pending.has(requestId)) return false;
    this.touch(fromSurfaceId);
    this.#settle(requestId, approved, "answered", fromSurfaceId, signedBy);
    return true;
  }

  // ── internals ──────────────────────────────────────────────────────────

  #isOnline(s: Surface): boolean {
    return this.#now() - s.lastSeen <= (KIND_TIMEOUT_MS[s.manifest.kind] ?? this.#timeoutMs);
  }

  #markOffline(id: string): void {
    const s = this.#surfaces.get(id);
    if (!s || s.offline) return;
    s.offline = true;
    this.#onEvent("surface", { surface_id: id, kind: s.manifest.kind, status: "offline" });
    for (const p of this.#pending.values()) if (p.surfaceId === id) this.#offer(p, id);
    // The unspoken rest of a reply moves to the next voice surface, so the task follows you.
    for (const r of this.#replies.values()) {
      if (r.surfaceId !== id) continue;
      const target = this.#pick("speak", undefined, id);
      if (!target) {
        this.#replies.delete(r.id);
        continue;
      }
      r.surfaceId = target.manifest.id;
      this.#onEvent("handoff", { reply_id: r.id, what: "speech", from: id, to: target.manifest.id, remaining: r.chunks.length - 1 - r.acked });
      this.#sendSpeech(target, r, r.acked + 1);
    }
  }

  #sendSpeech(s: Surface, r: Reply, from: number): void {
    for (let seq = from; seq < r.chunks.length; seq++) {
      s.send({ type: "speak", text: r.chunks[seq], reply_id: r.id, seq, final: seq === r.chunks.length - 1 });
    }
  }

  #offer(p: PendingApproval, fromId: string | null): void {
    if (fromId) this.#surfaces.get(fromId)?.send({ type: "approval_cancel", request_id: p.requestId, reason: "moved" });
    const target = this.#pick("approval", undefined, fromId ?? undefined);
    p.surfaceId = target?.manifest.id ?? null;
    target?.send({ type: "approval_request", request_id: p.requestId, summary: p.summary, short: p.short, tier: p.tier, ...(p.verb ? { verb: p.verb } : {}) });
    if (fromId) {
      this.#onEvent("handoff", { request_id: p.requestId, what: "approval", from: fromId, to: p.surfaceId });
    } else {
      this.#onEvent("approval", { request_id: p.requestId, status: "requested", summary: p.summary, surface_id: p.surfaceId });
    }
  }

  #settle(requestId: string, approved: boolean, reason: "answered" | "expired", by?: string, signedBy?: string): void {
    const p = this.#pending.get(requestId);
    if (!p) return;
    this.#pending.delete(requestId);
    clearTimeout(p.timer);
    if (p.surfaceId && p.surfaceId !== by) {
      this.#surfaces.get(p.surfaceId)?.send({ type: "approval_cancel", request_id: requestId, reason });
    }
    this.#onEvent("approval", {
      request_id: requestId,
      status: reason === "expired" ? "expired" : approved ? "approved" : "declined",
      surface_id: by ?? null,
      signed_by: signedBy ?? null,
    });
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
    if (purpose === "camera") {
      return best(live.filter((s) => s.manifest.inputs.includes("camera")), (s) => (s.manifest.kind === "glasses" ? 2 : 0));
    }
    return best(live.filter((s) => has(s, "screen")), (s) => (s.manifest.kind === "phone" ? 2 : 0));
  }
}
