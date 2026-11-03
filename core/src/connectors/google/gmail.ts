// Gmail as the `gmail` namespace. Same tools and arguments as the demo world.
// Auren reads threads (as untrusted data) and writes drafts; it never sends
// mail on its own. A draft is a write with an Undo, and you send it yourself.
import type { Namespace } from "../../tools/types.ts";
import { params } from "../../tools/types.ts";
import type { GoogleApi } from "./calendar.ts";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const DRAFTS_LINK = "https://mail.google.com/mail/u/0/#drafts";

interface Header { name: string; value: string }
interface GMessage { id: string; payload?: { headers?: Header[] } }
interface GThread { id: string; snippet?: string; messages?: GMessage[] }

const header = (m: GMessage | undefined, name: string) => m?.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";

/** Header values come from other people's mail: strip line breaks so nothing can smuggle in extra headers. */
const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** RFC 2047 for anything that isn't plain ASCII, so subjects in any language survive. */
const encodeWord = (v: string) => (/^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`);

/** The raw reply, as Gmail's drafts API wants it (RFC 2822, base64url). */
export function replyMime(to: string, subject: string, messageId: string, references: string, body: string): string {
  const subj = /^re:/i.test(subject) ? subject : `Re: ${subject}`;
  const lines = [
    `To: ${clean(to)}`,
    `Subject: ${encodeWord(clean(subj))}`,
    ...(messageId ? [`In-Reply-To: ${clean(messageId)}`, `References: ${clean(`${references} ${messageId}`)}`] : []),
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

export function createGmail(google: GoogleApi): Namespace {
  const meta = (id: string, names: string[]) =>
    google.json<GThread>(`${GMAIL}/threads/${encodeURIComponent(id)}?format=metadata&${names.map((n) => `metadataHeaders=${n}`).join("&")}`);

  return {
    name: "gmail",
    app: "Gmail",
    description: "The user's email: search threads and draft replies. Auren never sends mail itself.",
    tools: [
      {
        name: "search_threads",
        description: "Search the user's email threads (Gmail search syntax works, e.g. from:lee newer_than:7d).",
        parameters: params({ query: { type: "string" } }),
        tier: "read",
        external: true,
        async run({ query }: { query: string }) {
          const list = await google.json<{ threads?: GThread[] }>(`${GMAIL}/threads?${new URLSearchParams({ q: query, maxResults: "5" })}`);
          const threads = await Promise.all(
            (list.threads ?? []).map(async (t) => {
              const full = await meta(t.id, ["From", "Subject"]);
              const last = full.messages?.at(-1);
              return { id: t.id, from: header(last, "From"), subject: header(last, "Subject"), snippet: full.snippet ?? t.snippet ?? "" };
            }),
          );
          return { threads };
        },
      },
      {
        name: "create_draft",
        description: "Create a reply draft in an email thread. Does not send.",
        parameters: params({ thread_id: { type: "string" }, body: { type: "string" } }),
        tier: "write",
        deferred: true,
        async run({ thread_id, body }: { thread_id: string; body: string }) {
          const thread = await meta(thread_id, ["From", "Reply-To", "Subject", "Message-ID", "References"]);
          const last = thread.messages?.at(-1);
          const to = header(last, "Reply-To") || header(last, "From");
          if (!to) throw new Error("That thread has no sender to reply to.");
          const raw = replyMime(to, header(last, "Subject"), header(last, "Message-ID"), header(last, "References"), body);
          const draft = await google.json<{ id: string }>(`${GMAIL}/drafts`, { method: "POST", body: JSON.stringify({ message: { raw, threadId: thread_id } }) });
          return { ok: true, draft_id: draft.id, to: clean(to), link: DRAFTS_LINK };
        },
        summarize: (a: { body: string }) => `Drafted: "${a.body.slice(0, 60)}"`,
        undo: (_a, r: { draft_id: string }) => ({ namespace: "gmail", tool: "delete_draft", args: { draft_id: r.draft_id } }),
        proof: (_a, r: { link?: string }) => r?.link,
      },
      {
        name: "delete_draft",
        description: "Delete a draft.",
        parameters: params({ draft_id: { type: "string" } }),
        tier: "write",
        hidden: true,
        async run({ draft_id }: { draft_id: string }) {
          try {
            await google.json(`${GMAIL}/drafts/${encodeURIComponent(draft_id)}`, { method: "DELETE" });
            return { ok: true };
          } catch (err) {
            if ((err as { status?: number }).status === 404) return { ok: false, reason: "already gone" };
            throw err;
          }
        },
        summarize: () => "Deleted the draft",
      },
    ],
  };
}
