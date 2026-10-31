// Encrypted storage for connector tokens (AES-256-GCM, one row per connector).
// The key comes from AUREN_SECRET, or is generated once into <db>.key with
// owner-only permissions. Surfaces never see these tokens.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export function loadKey(opts: { secret?: string; keyPath?: string }): Buffer {
  if (opts.secret) {
    const key = Buffer.from(opts.secret, "hex");
    if (key.length !== 32) throw new Error("AUREN_SECRET must be 64 hex characters (32 bytes): openssl rand -hex 32");
    return key;
  }
  // No path (an in-memory database): tokens last until Core restarts.
  if (!opts.keyPath) return randomBytes(32);
  if (existsSync(opts.keyPath)) return Buffer.from(readFileSync(opts.keyPath, "utf8").trim(), "hex");
  const key = randomBytes(32);
  writeFileSync(opts.keyPath, key.toString("hex"), { mode: 0o600 });
  return key;
}

export class SecretStore {
  #db: DatabaseSync;
  #key: Buffer;

  constructor(path: string, key: Buffer) {
    this.#db = new DatabaseSync(path);
    this.#key = key;
    this.#db.exec(`CREATE TABLE IF NOT EXISTS secrets (
      name TEXT PRIMARY KEY,
      iv BLOB NOT NULL,
      tag BLOB NOT NULL,
      data BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  set(name: string, value: unknown): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv);
    cipher.setAAD(Buffer.from(name));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    this.#db
      .prepare(`INSERT INTO secrets (name, iv, tag, data, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET iv = excluded.iv, tag = excluded.tag, data = excluded.data, updated_at = excluded.updated_at`)
      .run(name, iv, cipher.getAuthTag(), data, Date.now());
  }

  /** Undefined when missing, or when the row can't be decrypted (the key changed); reconnecting fixes both. */
  get<T>(name: string): T | undefined {
    const row = this.#db.prepare("SELECT iv, tag, data FROM secrets WHERE name = ?").get(name) as
      | { iv: Uint8Array; tag: Uint8Array; data: Uint8Array }
      | undefined;
    if (!row) return undefined;
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.#key, row.iv);
      decipher.setAAD(Buffer.from(name));
      decipher.setAuthTag(row.tag);
      return JSON.parse(Buffer.concat([decipher.update(row.data), decipher.final()]).toString("utf8")) as T;
    } catch {
      return undefined;
    }
  }

  delete(name: string): void {
    this.#db.prepare("DELETE FROM secrets WHERE name = ?").run(name);
  }
}
