import assert from "node:assert/strict";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { loadKey, SecretStore } from "./secrets.ts";

const dir = () => mkdtempSync(join(tmpdir(), "auren-secrets-"));

test("round-trips a value and stores only ciphertext", () => {
  const path = join(dir(), "a.db");
  const store = new SecretStore(path, loadKey({ keyPath: `${path}.key` }));
  store.set("google", { access_token: "ya29.secret-token", refresh_token: "1//refresh" });
  assert.deepEqual(store.get("google"), { access_token: "ya29.secret-token", refresh_token: "1//refresh" });
  const raw = new DatabaseSync(path).prepare("SELECT data FROM secrets").get() as { data: Uint8Array };
  assert.ok(!Buffer.from(raw.data).toString("utf8").includes("secret-token"));
});

test("the generated key file is owner-only and reused", () => {
  const keyPath = join(dir(), "k.key");
  const a = loadKey({ keyPath });
  assert.equal(statSync(keyPath).mode & 0o777, 0o600);
  assert.deepEqual(loadKey({ keyPath }), a);
});

test("a different key reads nothing instead of throwing", () => {
  const path = join(dir(), "b.db");
  new SecretStore(path, loadKey({ secret: "11".repeat(32) })).set("google", { access_token: "x" });
  assert.equal(new SecretStore(path, loadKey({ secret: "22".repeat(32) })).get("google"), undefined);
});

test("AUREN_SECRET must be 32 bytes of hex", () => {
  assert.throws(() => loadKey({ secret: "abc" }), /64 hex characters/);
});
