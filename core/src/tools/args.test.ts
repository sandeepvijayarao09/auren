import assert from "node:assert/strict";
import { test } from "node:test";
import { toParameters } from "../connectors/mcp.ts";
import { nearKey, validateArgs } from "./args.ts";
import { params } from "./types.ts";

const post = params({ channel_id: { type: "string" }, text: { type: "string" } });

test("valid arguments pass through unchanged", () => {
  const r = validateArgs(post, { channel_id: "C01", text: "hi" });
  assert.deepEqual(r, { ok: true, args: { channel_id: "C01", text: "hi" }, mapped: [] });
});

test("`channel` maps to `channel_id`, and the mapping is reported", () => {
  const r = validateArgs(post, { channel: "C01", text: "hi" });
  assert.ok(r.ok);
  assert.deepEqual(r.args, { channel_id: "C01", text: "hi" });
  assert.deepEqual(r.mapped, [{ from: "channel", to: "channel_id" }]);
  assert.equal(nearKey("channelId", ["channel_id", "text"]), "channel_id");
  assert.equal(nearKey("evnt_id", ["event_id", "new_start"]), "event_id", "a near typo");
  assert.equal(nearKey("txt", ["text"]), undefined, "too short to guess");
  assert.equal(nearKey("query", ["channel_id", "text"]), undefined);
});

test("a key that isn't declared and isn't a near match is rejected, naming the expected keys", () => {
  const r = validateArgs(post, { channel_id: "C01", text: "hi", urgent: true });
  assert.equal(r.ok, false);
  assert.ok(!r.ok);
  assert.equal(r.error.error, "invalid_arguments");
  assert.deepEqual(r.error.expected, { required: ["channel_id", "text"], optional: [] });
  assert.match(r.error.message, /unknown key "urgent"/);
  assert.match(r.error.message, /Expected keys: channel_id, text\./);
});

test("missing required keys and wrong types are rejected", () => {
  const missing = validateArgs(post, { text: "hi" });
  assert.ok(!missing.ok);
  assert.match(missing.error.message, /missing required key "channel_id"/);
  const typed = validateArgs(params({ emails: { type: "array", items: { type: "string" } }, n: { type: "integer" } }), { emails: "a@b.co", n: 1.5 });
  assert.ok(!typed.ok);
  assert.deepEqual(typed.error.problems, ['"emails" should be array, got string', '"n" should be integer, got number']);
  assert.ok(!validateArgs(post, ["C01"]).ok, "not an object");
});

test("a null optional key counts as not given; enums are checked", () => {
  const schema = { type: "object", properties: { q: { type: "string" }, order: { type: "string", enum: ["asc", "desc"] } }, required: ["q"] };
  const r = validateArgs(schema, { q: "x", order: null });
  assert.deepEqual(r, { ok: true, args: { q: "x" }, mapped: [] });
  assert.ok(!validateArgs(schema, { q: "x", order: "up" }).ok);
});

test("an MCP schema that allows extra keys keeps them, and an empty schema accepts {}", () => {
  const open = { type: "object", properties: { id: { type: "string" } }, additionalProperties: true };
  assert.deepEqual(validateArgs(open, { id: "1", extra: 2 }), { ok: true, args: { id: "1", extra: 2 }, mapped: [] });
  const mcp = toParameters({ type: "object", properties: { project: { type: "string" } }, required: ["project"] });
  assert.ok(validateArgs(mcp, { project: "auren" }).ok);
  assert.ok(!validateArgs(mcp, {}).ok);
  assert.ok(validateArgs(params({}), {}).ok);
});
