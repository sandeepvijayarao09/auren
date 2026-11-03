import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContext } from "../tools/types.ts";
import { createSlack } from "./slack.ts";

const ctx = {} as ToolContext;

function fakeSlack(answer: (method: string, args: Record<string, string>) => unknown) {
  const calls: Array<{ method: string; args: Record<string, string>; auth: string; verb: string }> = [];
  const fetch = (async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    const method = url.pathname.replace("/api/", "");
    const args = init.body ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams);
    calls.push({ method, args, auth: (init.headers as Record<string, string>).authorization, verb: init.method ?? "GET" });
    return new Response(JSON.stringify(answer(method, args)));
  }) as typeof globalThis.fetch;
  const ledger: string[] = [];
  const slack = createSlack({ token: "xoxb-test", fetch, onCall: (c) => ledger.push(`${c.operation} ${c.status}`) });
  const tool = (name: string) => slack.tools.find((t) => t.name === name)!;
  return { calls, tool, ledger, slack };
}

test("lists channels, says where Auren can post, and learns their names", async () => {
  const { tool, calls } = fakeSlack(() => ({ ok: true, channels: [{ id: "C01", name: "office-hours", is_member: true }, { id: "C02", name: "random" }] }));
  const res = await tool("list_channels").run({}, ctx);
  assert.deepEqual(res.channels, [{ id: "C01", name: "office-hours", member: true }, { id: "C02", name: "random", member: false }]);
  assert.equal(calls[0].verb, "GET");
  assert.equal(calls[0].auth, "Bearer xoxb-test");
  assert.equal(tool("post_message").summarize!({ channel_id: "C01", text: "Running 15 late" }), 'Post to #office-hours: "Running 15 late"');
});

test("posting is send-tier, posts once, and links to the message", async () => {
  const { tool, calls, ledger } = fakeSlack((method) =>
    method === "chat.postMessage" ? { ok: true, channel: "C01", ts: "1730.42" } : { ok: true, permalink: "https://demo.slack.com/archives/C01/p173042" },
  );
  const post = tool("post_message");
  assert.equal(post.tier, "send");
  assert.equal(post.undo, undefined);
  const args = { channel_id: "C01", text: "Running 15 late, there by 3:15." };
  const res = await post.run(args, ctx);
  assert.deepEqual(calls[0], { method: "chat.postMessage", args: { channel: "C01", text: args.text }, auth: "Bearer xoxb-test", verb: "POST" });
  assert.equal(post.proof!(args, res), "https://demo.slack.com/archives/C01/p173042");
  assert.equal(post.summarize!(args, res), "Posted in #C01");
  assert.deepEqual(ledger, ["POST chat.postMessage ok", "GET chat.getPermalink ok"]);
});

test("Slack's error codes become instructions", async () => {
  const { tool } = fakeSlack(() => ({ ok: false, error: "not_in_channel" }));
  await assert.rejects(tool("post_message").run({ channel_id: "C09", text: "hi" }, ctx), /type \/invite @Auren/);
  const other = fakeSlack(() => ({ ok: false, error: "something_new" }));
  await assert.rejects(other.tool("list_channels").run({}, ctx), /Slack said "something_new"/);
});

test("a missing permalink doesn't undo a post that went through", async () => {
  const { tool } = fakeSlack((method) => (method === "chat.postMessage" ? { ok: true, ts: "1.0" } : { ok: false, error: "message_not_found" }));
  const res = await tool("post_message").run({ channel_id: "C01", text: "hi" }, ctx);
  assert.deepEqual(res, { ok: true, ts: "1.0", link: undefined });
});
