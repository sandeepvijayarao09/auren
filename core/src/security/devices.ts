// Trusted devices. A device pairs once with a one-time code shown on the Mac
// and registers a P-256 public key whose private half lives in its Secure
// Enclave. From then on it proves that key on every connection and signs every
// approval, so a spoken yes, a stolen token or an injected instruction can't
// stand in for a tap on your own device.
import { createHash, createPublicKey, randomInt, timingSafeEqual, verify, type KeyObject } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const CODE_TTL_MS = 5 * 60_000;
const MAX_TRIES = 5;

export interface Device {
  id: string;
  name: string;
  kind: string;
  /** True when the key lives in a Secure Enclave; false for the Simulator's software key. */
  hardware: boolean;
  pairedAt: number;
  lastSeen: number | null;
  revoked: boolean;
}

export class PairingError extends Error {}

/** What a device signs when it connects: the server's one-time nonce, bound to its id. */
export const helloPayload = (nonce: string, deviceId: string) => Buffer.from(`auren-hello\n${nonce}\n${deviceId}`);

/** What a device signs to open the microphone stream. A different prefix, so a hello signature can't be replayed here. */
export const voicePayload = (nonce: string, deviceId: string) => Buffer.from(`auren-voice\n${nonce}\n${deviceId}`);

/** What a device signs to upload a camera frame: the capture request and a hash of the exact bytes sent. */
export const framePayload = (requestId: string, jpeg: Uint8Array) =>
  Buffer.from(`auren-frame\n${requestId}\n${createHash("sha256").update(jpeg).digest("hex")}`);

/**
 * R12: what a device signs to upload a hold-to-talk clip (the watch): its id, when it
 * recorded (milliseconds since 1970), and a hash of the exact PCM bytes. There's no
 * server nonce, because the clip may travel through the iPhone; Core refuses stale and
 * repeated uploads instead.
 */
export const clipPayload = (deviceId: string, timestamp: number, pcm: Uint8Array) =>
  Buffer.from(`auren-clip\n${deviceId}\n${timestamp}\n${createHash("sha256").update(pcm).digest("hex")}`);

/** What a device signs to approve or decline: the request, the decision, and a hash of the summary it showed. */
export const approvalPayload = (requestId: string, approved: boolean, summary: string) =>
  Buffer.from(`auren-approve\n${requestId}\n${approved ? 1 : 0}\n${createHash("sha256").update(summary).digest("hex")}`);

export class DeviceRegistry {
  #db: DatabaseSync;
  #now: () => number;
  #code: { value: string; expires: number; tries: number } | null = null;
  #keys = new Map<string, KeyObject>();

  constructor(path = ":memory:", now: () => number = Date.now) {
    this.#db = new DatabaseSync(path);
    this.#now = now;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      public_key BLOB NOT NULL,
      hardware INTEGER NOT NULL,
      paired_at INTEGER NOT NULL,
      last_seen INTEGER,
      revoked_at INTEGER
    )`);
  }

  /** A new six-digit code, valid for five minutes and one use. Starting again replaces the old one. */
  startPairing(): { code: string; expiresAt: number } {
    const value = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.#code = { value, expires: this.#now() + CODE_TTL_MS, tries: 0 };
    return { code: value, expiresAt: this.#code.expires };
  }

  finishPairing(req: { code: string; id: string; name?: string; kind: string; publicKey: string; hardware?: boolean }): Device {
    const code = this.#code;
    if (!code || this.#now() > code.expires) throw new PairingError("No pairing code is active. Choose Pair a device on the Mac to get one.");
    if (++code.tries > MAX_TRIES) {
      this.#code = null;
      throw new PairingError("Too many wrong codes. Start a new one on the Mac.");
    }
    const given = Buffer.from(String(req.code).replace(/\D/g, ""));
    const want = Buffer.from(code.value);
    if (given.length !== want.length || !timingSafeEqual(given, want)) throw new PairingError("That code doesn't match. Check the Mac and try again.");
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(req.id)) throw new PairingError("That device id isn't valid.");

    let der: Buffer;
    try {
      der = Buffer.from(req.publicKey, "base64");
      const key = createPublicKey({ key: der, format: "der", type: "spki" });
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    } catch {
      throw new PairingError("The device's key must be a P-256 public key (SPKI, base64).");
    }
    this.#code = null;
    const now = this.#now();
    this.#db
      .prepare(`INSERT INTO devices (id, name, kind, public_key, hardware, paired_at, last_seen, revoked_at) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, public_key = excluded.public_key,
          hardware = excluded.hardware, paired_at = excluded.paired_at, last_seen = NULL, revoked_at = NULL`)
      .run(req.id, (req.name ?? req.kind).slice(0, 64), req.kind, der, req.hardware ? 1 : 0, now);
    this.#keys.delete(req.id);
    return this.get(req.id)!;
  }

  get(id: string): Device | undefined {
    const r = this.#db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as Record<string, any> | undefined;
    return r && toDevice(r);
  }

  list(): Device[] {
    return (this.#db.prepare("SELECT * FROM devices ORDER BY paired_at").all() as Array<Record<string, any>>).map(toDevice);
  }

  revoke(id: string): boolean {
    this.#keys.delete(id);
    return Number(this.#db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(this.#now(), id).changes) > 0;
  }

  /** True only for a paired, unrevoked device whose key signed exactly `payload`. */
  verify(id: string, payload: Buffer, signatureB64: string | undefined): boolean {
    if (!signatureB64) return false;
    const key = this.#key(id);
    if (!key) return false;
    let ok = false;
    try {
      ok = verify("sha256", payload, { key, dsaEncoding: "der" }, Buffer.from(signatureB64, "base64"));
    } catch {
      ok = false;
    }
    if (ok) this.#db.prepare("UPDATE devices SET last_seen = ? WHERE id = ?").run(this.#now(), id);
    return ok;
  }

  #key(id: string): KeyObject | undefined {
    const cached = this.#keys.get(id);
    if (cached) return cached;
    const r = this.#db.prepare("SELECT public_key FROM devices WHERE id = ? AND revoked_at IS NULL").get(id) as { public_key: Uint8Array } | undefined;
    if (!r) return undefined;
    const key = createPublicKey({ key: Buffer.from(r.public_key), format: "der", type: "spki" });
    this.#keys.set(id, key);
    return key;
  }
}

function toDevice(r: Record<string, any>): Device {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    hardware: Boolean(r.hardware),
    pairedAt: Number(r.paired_at),
    lastSeen: r.last_seen == null ? null : Number(r.last_seen),
    revoked: r.revoked_at != null,
  };
}
