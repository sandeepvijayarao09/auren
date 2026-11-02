import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { EventKind, AurenEvent } from "./protocol.ts";

const GENESIS: Buffer = Buffer.alloc(32);

const sub = (key: Buffer, use: string) => Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), Buffer.from(`auren/eventlog/${use}`), 32));

const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};

interface Row { id: number; session: string; at: number; kind: EventKind; data: Uint8Array; mac: Uint8Array }

export interface Verification {
  ok: boolean;
  count: number;
  /** The first 16 hex characters of the newest link. Devices can compare it to spot a cut-off tail. */
  head: string;
  brokenAt?: number;
  reason?: string;
}

/**
 * Append-only session timeline. Every surface renders from this.
 *
 * Contents are encrypted (AES-256-GCM, with id, session, time and kind bound in as
 * associated data). Every row also carries an HMAC over the previous row's HMAC and
 * its own fields, so an edited, deleted or reordered event fails `verify()`.
 * Id, time and kind stay readable so the log can be ordered and filtered.
 */
export class EventLog {
  #db: DatabaseSync;
  #emitter = new EventEmitter();
  #enc: Buffer;
  #mac: Buffer;
  #lastId = 0;
  #lastMac: Buffer = GENESIS;

  /** `key` is the events key derived from the master key; tests can leave it out. */
  constructor(path = ":memory:", key: Buffer = randomBytes(32)) {
    this.#db = new DatabaseSync(path);
    this.#enc = sub(key, "enc");
    this.#mac = sub(key, "mac");
    const legacy = this.#takeLegacyRows();
    this.#db.exec(`CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      session TEXT NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      data BLOB NOT NULL,
      mac BLOB NOT NULL
    )`);
    const last = this.#db.prepare("SELECT id, mac FROM events ORDER BY id DESC LIMIT 1").get() as { id: number; mac: Uint8Array } | undefined;
    if (last) {
      this.#lastId = last.id;
      this.#lastMac = Buffer.from(last.mac);
    }
    for (const r of legacy) this.#insert(r.session, r.at, r.kind, JSON.parse(r.data));
  }

  append(session: string, kind: EventKind, data: Record<string, unknown>): AurenEvent {
    const event = this.#insert(session, Date.now(), kind, data);
    this.#emitter.emit("event", event);
    return event;
  }

  since(session: string, afterId = 0, limit = 500): AurenEvent[] {
    const rows = this.#db.prepare("SELECT * FROM events WHERE session = ? AND id > ? ORDER BY id LIMIT ?").all(session, afterId, limit) as unknown as Row[];
    return rows.map((r) => this.#read(r));
  }

  get(id: number): AurenEvent | undefined {
    const r = this.#db.prepare("SELECT * FROM events WHERE id = ?").get(id) as unknown as Row | undefined;
    return r && this.#read(r);
  }

  onEvent(fn: (event: AurenEvent) => void): () => void {
    this.#emitter.on("event", fn);
    return () => this.#emitter.off("event", fn);
  }

  /** Walks the whole chain. Ids are assigned one by one, so a gap means a deleted event. */
  verify(): Verification {
    let prev: Buffer = GENESIS;
    let expected = 1;
    let count = 0;
    for (const r of this.#db.prepare("SELECT * FROM events ORDER BY id").iterate() as Iterable<Row>) {
      if (r.id !== expected) return { ok: false, count, head: prev.toString("hex").slice(0, 16), brokenAt: expected, reason: `event ${expected} is missing` };
      const mac = this.#link(prev, r.id, r.session, r.at, r.kind, Buffer.from(r.data));
      const stored = Buffer.from(r.mac);
      if (stored.length !== mac.length || !timingSafeEqual(stored, mac)) {
        return { ok: false, count, head: prev.toString("hex").slice(0, 16), brokenAt: r.id, reason: `event ${r.id} was changed` };
      }
      prev = mac;
      expected++;
      count++;
    }
    return { ok: true, count, head: prev.toString("hex").slice(0, 16) };
  }

  #insert(session: string, at: number, kind: EventKind, data: Record<string, unknown>): AurenEvent {
    const id = this.#lastId + 1;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#enc, iv);
    cipher.setAAD(Buffer.from(`${id}|${session}|${at}|${kind}`));
    const ct = Buffer.concat([cipher.update(JSON.stringify(data), "utf8"), cipher.final()]);
    const sealed = Buffer.concat([iv, cipher.getAuthTag(), ct]);
    const mac = this.#link(this.#lastMac, id, session, at, kind, sealed);
    this.#db.prepare("INSERT INTO events (id, session, at, kind, data, mac) VALUES (?, ?, ?, ?, ?, ?)").run(id, session, at, kind, sealed, mac);
    this.#lastId = id;
    this.#lastMac = mac;
    return { id, session, at, kind, data };
  }

  #link(prev: Buffer, id: number, session: string, at: number, kind: string, sealed: Buffer): Buffer {
    return createHmac("sha256", this.#mac)
      .update(prev)
      .update(u64(id))
      .update(`${session}\0${kind}\0`)
      .update(u64(at))
      .update(sealed)
      .digest();
  }

  #read(r: Row): AurenEvent {
    const sealed = Buffer.from(r.data);
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#enc, sealed.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${r.id}|${r.session}|${r.at}|${r.kind}`));
      decipher.setAuthTag(sealed.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]).toString("utf8");
      return { id: r.id, session: r.session, at: r.at, kind: r.kind, data: JSON.parse(plain) };
    } catch {
      return { id: r.id, session: r.session, at: r.at, kind: r.kind, data: { unreadable: true } };
    }
  }

  /** Logs written before encryption (plaintext `data`, no `mac`) are read once and re-written encrypted. */
  #takeLegacyRows(): Array<{ session: string; at: number; kind: EventKind; data: string }> {
    const cols = this.#db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    if (!cols.length || cols.some((c) => c.name === "mac")) return [];
    const rows = this.#db.prepare("SELECT session, at, kind, data FROM events ORDER BY id").all() as Array<{ session: string; at: number; kind: EventKind; data: string }>;
    this.#db.exec("DROP TABLE events");
    return rows;
  }
}
