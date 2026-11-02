import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { derive, keyFolder, masterKey } from "./keys.ts";

const dbIn = () => join(mkdtempSync(join(tmpdir(), "auren-keys-")), "auren.db");

test("each purpose gets its own key, the same every time", () => {
  const master = Buffer.alloc(32, 7);
  assert.deepEqual(derive(master, "events"), derive(master, "events"));
  assert.notDeepEqual(derive(master, "events"), derive(master, "tokens"));
  assert.notDeepEqual(derive(master, "events"), master);
  assert.equal(derive(master, "devices").length, 32);
});

test("AUREN_SECRET wins, and an in-memory database gets an in-memory key", () => {
  assert.equal(masterKey({ secret: "ab".repeat(32), dbPath: dbIn() }).source, "env");
  assert.equal(masterKey({ dbPath: ":memory:" }).source, "memory");
});

test("without a Secure Enclave it falls back to a key file, and says why", () => {
  const db = dbIn();
  const k = masterKey({ dbPath: db, platform: "linux" });
  assert.equal(k.source, "file");
  assert.match(k.note ?? "", /no Secure Enclave/);
  assert.equal(statSync(`${db}.key`).mode & 0o777, 0o600);
  assert.equal(masterKey({ dbPath: db, platform: "darwin", keydPath: "/nonexistent/auren-keyd" }).source, "file");
});

const keyd = fileURLToPath(new URL("../../../keyd/.build/release/auren-keyd", import.meta.url));
const enclave = process.platform === "darwin" && existsSync(keyd) && execFileSync(keyd, ["status", "--dir", tmpdir()], { encoding: "utf8" }).includes('"secure_enclave":true');

test("on this Mac the key is sealed to the Secure Enclave and stable", { skip: !enclave && "no Secure Enclave or auren-keyd not built" }, () => {
  const db = dbIn();
  const a = masterKey({ dbPath: db, keydPath: keyd });
  const b = masterKey({ dbPath: db, keydPath: keyd });
  try {
    assert.equal(a.source, "secure-enclave");
    assert.deepEqual(a.key, b.key);
    assert.equal(existsSync(`${db}.key`), false);
    assert.equal(statSync(keyFolder(db)).mode & 0o777, 0o700);
  } finally {
    execFileSync(keyd, ["forget", "--dir", keyFolder(db)]);
  }
});
