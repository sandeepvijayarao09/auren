// Slack as the `slack` namespace, through a bot in the demo workspace. Same
// tools and arguments as the demo world. Posting is send-tier: it waits for a
// signed tap, and it has no undo, because people may already have read it.
import type { Namespace } from "../tools/types.ts";
import { params } from "../tools/types.ts";

export interface SlackOptions {
  /** The bot token (xoxb-…) from the Slack app's install page. */
  token: string;
  fetch?: typeof fetch;
  /** Called after every request to Slack, for the outbound ledger. */
  onCall?: (call: { operation: string; status: "ok" | "error"; ms: number; bytesOut: number }) => void;
}

const API = "https://slack.com/api";

// Slack answers HTTP 200 with { ok: false, error }. These say what to do about it.
const HELP: Record<string, string> = {
  not_in_channel: "The Auren bot isn't in that channel. In Slack, open the channel and type /invite @Auren.",
  channel_not_found: "Slack can't find that channel. List the channels and use its id.",
  is_archived: "That channel is archived.",
  msg_too_long: "That message is too long for Slack.",
  no_text: "There's no message text to post.",
  invalid_auth: "Slack rejected the bot token. Check SLACK_BOT_TOKEN in .env.",
  not_authed: "Slack didn't get a token. Set SLACK_BOT_TOKEN in .env.",
  token_revoked: "The Slack bot token was revoked. Reinstall the app and update SLACK_BOT_TOKEN.",
  missing_scope: "The Slack app is missing a scope. Add channels:read, groups:read and chat:write, then reinstall it (docs/slack-setup.md).",
  ratelimited: "Slack is rate-limiting Auren. Try again in a minute.",
};

export function createSlack(opts: SlackOptions): Namespace {
  const send = opts.fetch ?? fetch;
  const names = new Map<string, string>();

  async function call(method: string, args: Record<string, string>, post = false): Promise<any> {
    const t0 = performance.now();
    const body = post ? JSON.stringify(args) : "";
    const url = post ? `${API}/${method}` : `${API}/${method}?${new URLSearchParams(args)}`;
    const res = await send(url, {
      method: post ? "POST" : "GET",
      headers: { authorization: `Bearer ${opts.token}`, ...(post ? { "content-type": "application/json; charset=utf-8" } : {}) },
      ...(post ? { body } : {}),
    });
    const json = (await res.json().catch(() => ({ ok: false, error: `http_${res.status}` }))) as any;
    opts.onCall?.({ operation: `${post ? "POST" : "GET"} ${method}`, status: json.ok ? "ok" : "error", ms: performance.now() - t0, bytesOut: Buffer.byteLength(body) });
    if (!json.ok) throw new Error(HELP[json.error] ?? `Slack said "${json.error}".`);
    return json;
  }

  const label = (id: string) => `#${names.get(id) ?? id}`;

  return {
    name: "slack",
    app: "Slack",
    description: "Team chat: find channels and post messages.",
    tools: [
      {
        name: "list_channels",
        description: "List the Slack channels. Auren can post where `member` is true.",
        parameters: params({}),
        tier: "read",
        async run() {
          const res = await call("conversations.list", { types: "public_channel,private_channel", exclude_archived: "true", limit: "200" });
          const channels = (res.channels ?? []).map((c: { id: string; name: string; is_member?: boolean }) => {
            names.set(c.id, c.name);
            return { id: c.id, name: c.name, member: Boolean(c.is_member) };
          });
          return { channels };
        },
      },
      {
        name: "post_message",
        description: "Post a message to a Slack channel, as the Auren bot.",
        parameters: params({ channel_id: { type: "string" }, text: { type: "string" } }),
        tier: "send",
        deferred: true,
        async run({ channel_id, text }: { channel_id: string; text: string }) {
          const res = await call("chat.postMessage", { channel: channel_id, text }, true);
          // The permalink is proof; posting already succeeded if it can't be fetched.
          const link = await call("chat.getPermalink", { channel: res.channel ?? channel_id, message_ts: res.ts })
            .then((p) => p.permalink as string)
            .catch(() => undefined);
          return { ok: true, ts: res.ts, link };
        },
        summarize: (a: { channel_id: string; text: string }, r?: unknown) => (r ? `Posted in ${label(a.channel_id)}` : `Post to ${label(a.channel_id)}: "${a.text}"`),
        proof: (_a, r: { link?: string }) => r?.link,
      },
    ],
  };
}
