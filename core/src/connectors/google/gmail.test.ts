import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContext } from "../../tools/types.ts";
import type { GoogleApi } from "./calendar.ts";
import { createGmail, replyMime } from "./gmail.ts";

const ctx = {} as ToolContext;
const hdr = (name: string, value: string) => ({ name, value });
const THREAD = {
  id: "thr_9",
  snippet: "Hi, when will HW3 grades be posted?",
  messages: [{ id: "m1", payload: { headers: [hdr("From", "Prof. Lee <lee@example.edu>"), hdr("Subject", "HW3 grades?"), hdr("Message-ID", "<abc@mail.example.edu>")] } }],
};

function fakeGmail(handler: (url: URL, init: RequestInit) => unknown) {
  const calls: Array<{ url: URL; method: string; body?: any }> = [];
  const google: GoogleApi = {
    async json(url: string, init: RequestInit = {}) {
      const u = new URL(url);
      calls.push({ url: u, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : undefined });
      return handler(u, init) as any;
    },
  };
  const ns = createGmail(google);
  return { calls, tool: (n: string) => ns.tools.find((t) => t.name === n)! };
}

test("search returns sender, subject and snippet, as untrusted data", async () => {
  const { tool, calls } = fakeGmail((u) => (u.pathname.endsWith("/threads") ? { threads: [{ id: "thr_9" }] } : THREAD));
  const search = tool("search_threads");
  assert.equal(search.external, true);
  const res = await search.run({ query: "from:lee" }, ctx);
  assert.equal(calls[0].url.searchParams.get("q"), "from:lee");
  assert.deepEqual(res.threads, [{ id: "thr_9", from: "Prof. Lee <lee@example.edu>", subject: "HW3 grades?", snippet: "Hi, when will HW3 grades be posted?" }]);
});

test("a draft replies in the thread, to the sender, and can be undone", async () => {
  const { tool, calls } = fakeGmail((u, init) => (init.method === "POST" ? { id: "r-123" } : THREAD));
  const draft = tool("create_draft");
  assert.equal(draft.tier, "write");
  const args = { thread_id: "thr_9", body: "Grades are in by 5." };
  const res = await draft.run(args, ctx);
  const post = calls.find((c) => c.method === "POST")!;
  assert.equal(post.body.message.threadId, "thr_9");
  const mime = Buffer.from(post.body.message.raw, "base64url").toString("utf8");
  assert.match(mime, /^To: Prof\. Lee <lee@example\.edu>\r\n/);
  assert.match(mime, /\r\nSubject: Re: HW3 grades\?\r\n/);
  assert.match(mime, /\r\nIn-Reply-To: <abc@mail\.example\.edu>\r\n/);
  assert.match(mime, /\r\n\r\nGrades are in by 5\.$/);
  assert.deepEqual(draft.undo!(args, res), { namespace: "gmail", tool: "delete_draft", args: { draft_id: "r-123" } });
  assert.ok(draft.proof!(args, res)?.startsWith("https://mail.google.com/"));
});

test("headers from someone else's mail can't inject new headers", () => {
  const mime = Buffer.from(replyMime("x@evil.test\r\nBcc: all@corp.test", "Hi\r\nBcc: more@corp.test", "", "", "body"), "base64url").toString("utf8");
  const headers = mime.split("\r\n\r\n")[0].split("\r\n");
  assert.equal(headers.filter((h) => /^Bcc:/i.test(h)).length, 0);
  assert.equal(headers[0], "To: x@evil.test Bcc: all@corp.test");
});

test("subjects in any language are encoded", () => {
  const mime = Buffer.from(replyMime("a@b.co", "Notas del curso – ñ", "", "", "ok"), "base64url").toString("utf8");
  assert.match(mime, /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/);
});

test("deleting a draft that's already gone is fine", async () => {
  const { tool } = fakeGmail(() => {
    throw Object.assign(new Error("Google 404"), { status: 404 });
  });
  assert.deepEqual(await tool("delete_draft").run({ draft_id: "r-1" }, ctx), { ok: false, reason: "already gone" });
});
