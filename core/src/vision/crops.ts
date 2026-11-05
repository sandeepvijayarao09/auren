// Receipt crops: the part of a frame SAM 3.1 outlined, encrypted at rest with
// AES-256-GCM under its own derived key. Full frames are never stored.
// The same store, with kind "card" and its own key, keeps Muse Image invite cards.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export class CropStore {
  #db: DatabaseSync;
  #key: Buffer;
  #now: () => number;
  #kind: "crop" | "card";

  /** `key` is the crops key derived from the master key; tests can leave it out. `kind` picks the table and id prefix. */
  constructor(path = ":memory:", key: Buffer = randomBytes(32), now: () => number = Date.now, kind: "crop" | "card" = "crop") {
    this.#db = new DatabaseSync(path);
    this.#key = key;
    this.#now = now;
    this.#kind = kind;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS ${kind}s (
      id TEXT PRIMARY KEY,
      at INTEGER NOT NULL,
      iv BLOB NOT NULL,
      tag BLOB NOT NULL,
      data BLOB NOT NULL
    )`);
  }

  put(jpeg: Buffer): string {
    const id = `${this.#kind}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(id));
    const data = Buffer.concat([cipher.update(jpeg), cipher.final()]);
    this.#db.prepare(`INSERT INTO ${this.#kind}s (id, at, iv, tag, data) VALUES (?, ?, ?, ?, ?)`).run(id, this.#now(), iv, cipher.getAuthTag(), data);
    return id;
  }

  /** Undefined when missing, or when the row can't be decrypted. */
  get(id: string): Buffer | undefined {
    const row = this.#db.prepare(`SELECT iv, tag, data FROM ${this.#kind}s WHERE id = ?`).get(id) as { iv: Uint8Array; tag: Uint8Array; data: Uint8Array } | undefined;
    if (!row) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, row.iv);
      decipher.setAAD(Buffer.from(id));
      decipher.setAuthTag(row.tag);
      return Buffer.concat([decipher.update(row.data), decipher.final()]);
    } catch {
      return undefined;
    }
  }
}
