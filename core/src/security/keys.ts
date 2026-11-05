// Where Core's master key comes from, and the keys derived from it.
//
// On a Mac the master key is sealed to the Secure Enclave by auren-keyd (keyd/),
// so it never sits on disk in the clear. AUREN_SECRET overrides that (CI, Linux),
// and a key file next to the database is the last resort, reported as such.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { hkdfSync } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadKey } from "../connectors/secrets.ts";

export type KeySource = "secure-enclave" | "env" | "file" | "memory";

/** Every derived key, one per job. Learning one tells you nothing about the others. */
export type Purpose = "tokens" | "events" | "devices" | "crops" | "cards" | "preferences";

const DEFAULT_KEYD = fileURLToPath(new URL("../../../keyd/.build/release/auren-keyd", import.meta.url));

export interface MasterKey {
  key: Buffer;
  source: KeySource;
  /** Why a weaker source was used, when it was. */
  note?: string;
}

export function masterKey(opts: { secret?: string; dbPath: string; keydPath?: string; platform?: string }): MasterKey {
  if (opts.secret) return { key: loadKey({ secret: opts.secret }), source: "env" };
  if (opts.dbPath === ":memory:") return { key: loadKey({}), source: "memory" };
  const keyd = opts.keydPath ?? process.env.AUREN_KEYD ?? DEFAULT_KEYD;
  const platform = opts.platform ?? process.platform;
  let note: string | undefined;
  if (platform === "darwin" && existsSync(keyd)) {
    try {
      const hex = execFileSync(keyd, ["unwrap", "--dir", keyFolder(opts.dbPath)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
      if (/^[0-9a-f]{64}$/.test(hex)) return { key: Buffer.from(hex, "hex"), source: "secure-enclave" };
      note = "auren-keyd returned an unexpected value";
    } catch (err) {
      note = `auren-keyd failed: ${(err as { stderr?: string }).stderr?.trim() || (err as Error).message}`;
    }
  } else {
    note = platform === "darwin" ? "auren-keyd isn't built yet (make keyd)" : "no Secure Enclave on this platform";
  }
  return { key: loadKey({ keyPath: `${opts.dbPath}.key` }), source: "file", note };
}

/** The folder auren-keyd keeps its two files in, next to the database. */
export const keyFolder = (dbPath: string) => join(dirname(dbPath), ".auren-keys");

export function derive(master: Buffer, purpose: Purpose): Buffer {
  return Buffer.from(hkdfSync("sha256", master, Buffer.from("auren"), Buffer.from(`auren/${purpose}/v1`), 32));
}
