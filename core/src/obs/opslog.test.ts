import assert from "node:assert/strict";
import { test } from "node:test";
import { OpsLog, redact } from "./opslog.ts";

test("secrets are scrubbed by name and by shape", () => {
  const out = redact({
    trace: "ab12cd34",
    access_token: "ya29.a0AfB",
    headers: { Authorization: "Bearer abc.def" },
    note: "refresh with 1//0gLongRefreshTokenValue123 or xoxb-123-456-abc",
    hex: "a".repeat(64),
    nested: { apiKey: "k", ok: 3 },
  }) as Record<string, any>;
  assert.equal(out.access_token, "[redacted]");
  assert.equal(out.headers.Authorization, "[redacted]");
  assert.equal(out.note, "refresh with [redacted] or [redacted]");
  assert.equal(out.hex, "[redacted]");
  assert.deepEqual(out.nested, { apiKey: "[redacted]", ok: 3 });
  assert.equal(out.trace, "ab12cd34");
});

test("long strings are cut so message bodies can't spill into the log", () => {
  const out = redact({ message: "x".repeat(500) }) as { message: string };
  assert.match(out.message, /… \(500 chars\)$/);
  assert.ok(out.message.length < 230);
});

test("each line is one JSON object with time, level and event", () => {
  const lines: string[] = [];
  const ops = new OpsLog({ write: (l) => lines.push(l) });
  ops.info("model.call", { trace: "t1", ms: 812, input_tokens: 1200 });
  ops.error("command.error", { trace: "t1", message: "Bearer sk-live-should-not-appear" });
  const [a, b] = lines.map((l) => JSON.parse(l));
  assert.deepEqual([a.level, a.event, a.trace, a.ms], ["info", "model.call", "t1", 812]);
  assert.match(a.t, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(b.message, "[redacted]");
});
