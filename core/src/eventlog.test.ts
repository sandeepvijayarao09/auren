import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { EventLog } from "./eventlog.ts";

const fresh = () => join(mkdtempSync(join(tmpdir(), "auren-log-")), "auren.db");
const key = randomBytes(32);

function seeded(path = fresh()) {
  const log = new EventLog(path, key);
  log.append("s", "utterance", { text: "Tell office hours I'm running 15 late" });
  log.append("s", "receipt", { summary: 'Moved "Office hours" to 15:15' });
  log.append("s", "reply", { text: "Done. Office hours knows." });
  return { log, path, raw: new DatabaseSync(path) };
}

test("events read back, and the file holds only ciphertext", () => {
  const { log, raw } = seeded();
  assert.deepEqual(log.since("s").map((e) => e.data), [
    { text: "Tell office hours I'm running 15 late" },
    { summary: 'Moved "Office hours" to 15:15' },
    { text: "Done. Office hours knows." },
  ]);
  const blobs = raw.prepare("SELECT data FROM events").all() as Array<{ data: Uint8Array }>;
  for (const b of blobs) assert.ok(!Buffer.from(b.data).toString("latin1").includes("office"));
});

test("an untouched log verifies, and survives a restart", () => {
  const { path } = seeded();
  const reopened = new EventLog(path, key);
  reopened.append("s", "ack", { text: "On it." });
  const v = reopened.verify();
  assert.equal(v.ok, true);
  assert.equal(v.count, 4);
  assert.match(v.head, /^[0-9a-f]{16}$/);
});

test("an edited event breaks the chain at that event", () => {
  const { path, raw } = seeded();
  const row = raw.prepare("SELECT data FROM events WHERE id = 2").get() as { data: Uint8Array };
  const changed = Buffer.from(row.data);
  changed[changed.length - 1] ^= 1;
  raw.prepare("UPDATE events SET data = ? WHERE id = 2").run(changed);
  const v = new EventLog(path, key).verify();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, 2);
  assert.equal(new EventLog(path, key).get(2)?.data.unreadable, true);
});

test("a deleted event is caught as a gap", () => {
  const { path, raw } = seeded();
  raw.prepare("DELETE FROM events WHERE id = 2").run();
  const v = new EventLog(path, key).verify();
  assert.deepEqual([v.ok, v.brokenAt], [false, 2]);
  assert.match(v.reason ?? "", /missing/);
});

test("swapping two events' contents is caught", () => {
  const { path, raw } = seeded();
  const [a, b] = raw.prepare("SELECT data, mac FROM events WHERE id IN (1, 2) ORDER BY id").all() as Array<{ data: Uint8Array; mac: Uint8Array }>;
  raw.prepare("UPDATE events SET data = ?, mac = ? WHERE id = 1").run(b.data, b.mac);
  raw.prepare("UPDATE events SET data = ?, mac = ? WHERE id = 2").run(a.data, a.mac);
  assert.equal(new EventLog(path, key).verify().ok, false);
});

test("the wrong key can't read or vouch for the log", () => {
  const { path } = seeded();
  const other = new EventLog(path, randomBytes(32));
  assert.equal(other.get(1)?.data.unreadable, true);
  assert.equal(other.verify().ok, false);
});

test("a plaintext log from before encryption is migrated in place", () => {
  const path = fresh();
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL)");
  old.prepare("INSERT INTO events (session, at, kind, data) VALUES (?, ?, ?, ?)").run("s", 1, "utterance", JSON.stringify({ text: "Move my 3 PM to 4" }));
  old.close();
  const log = new EventLog(path, key);
  assert.deepEqual(log.get(1)?.data, { text: "Move my 3 PM to 4" });
  assert.equal(log.verify().ok, true);
  const raw = new DatabaseSync(path).prepare("SELECT data FROM events").get() as { data: Uint8Array };
  assert.ok(!Buffer.from(raw.data).toString("latin1").includes("3 PM"));
});
