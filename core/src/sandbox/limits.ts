// Who a sandbox visitor is, for rate limits, and how much they may do. Every
// visitor is treated as hostile, so forwarding headers are ignored unless the
// operator says a proxy is in front (AUREN_TRUST_PROXY), in the spirit of
// isLocal(): a header never grants anything on its own.
import { isIP } from "node:net";

/**
 * The visitor's address. With `trustedHops` proxies in front, the client is the entry that many from
 * the end of X-Forwarded-For (each proxy appends the address it saw, so earlier entries can be forged).
 * With 0, every forwarding header is ignored and the socket's address is used.
 */
export function clientIp(remote: string | undefined, header: (name: string) => string | undefined | null, trustedHops: number): string {
  const socket = remote || "unknown";
  if (trustedHops <= 0) return socket;
  const hops = (header("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!hops.length) return socket;
  const candidate = hops[Math.max(0, hops.length - trustedHops)];
  return isIP(candidate) ? candidate : socket;
}

/** The key limits are kept under: an IPv4 address, or an IPv6 /64 (one home or phone gets a whole /64). */
export function rateKey(ip: string): string {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  if (isIP(ip) !== 6) return ip;
  const [head, tail = ""] = ip.toLowerCase().split("::");
  const left = head ? head.split(":") : [];
  const right = ip.includes("::") && tail ? tail.split(":") : [];
  const groups = ip.includes("::") ? [...left, ...Array(8 - left.length - right.length).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export type Take = { ok: true } | { ok: false; why: "minute" | "day" | "busy"; retryAfterS: number };

const MINUTE = 60_000;
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

/** A sliding one-minute window and a per-UTC-day count, per key. */
export class Limiter {
  #perMinute: number;
  #perDay: number;
  #maxKeys: number;
  #now: () => number;
  #keys = new Map<string, { stamps: number[]; day: string; count: number }>();

  constructor(opts: { perMinute: number; perDay?: number; maxKeys?: number; now?: () => number }) {
    this.#perMinute = opts.perMinute;
    this.#perDay = opts.perDay ?? Infinity;
    this.#maxKeys = opts.maxKeys ?? 20_000;
    this.#now = opts.now ?? Date.now;
  }

  /** Counts one use, or says how long to wait. */
  take(key: string): Take {
    const now = this.#now();
    let k = this.#keys.get(key);
    if (!k) {
      if (this.#keys.size >= this.#maxKeys) this.sweep();
      if (this.#keys.size >= this.#maxKeys) return { ok: false, why: "busy", retryAfterS: 60 };
      k = { stamps: [], day: utcDay(now), count: 0 };
      this.#keys.set(key, k);
    }
    k.stamps = k.stamps.filter((t) => now - t < MINUTE);
    if (k.day !== utcDay(now)) [k.day, k.count] = [utcDay(now), 0];
    if (k.count >= this.#perDay) {
      const midnight = Date.parse(`${k.day}T00:00:00Z`) + 24 * 60 * MINUTE;
      return { ok: false, why: "day", retryAfterS: Math.max(1, Math.ceil((midnight - now) / 1000)) };
    }
    if (k.stamps.length >= this.#perMinute) return { ok: false, why: "minute", retryAfterS: Math.max(1, Math.ceil((k.stamps[0] + MINUTE - now) / 1000)) };
    k.stamps.push(now);
    k.count++;
    return { ok: true };
  }

  /** Forgets keys with nothing left to remember. */
  sweep(): void {
    const now = this.#now();
    for (const [key, k] of this.#keys) {
      if (k.stamps.every((t) => now - t >= MINUTE) && (k.day !== utcDay(now) || this.#perDay === Infinity)) this.#keys.delete(key);
    }
  }
}
