// The sandbox's HTTP surface. It serves /try (the page), /try/api/*, /health and
// the brand assets, and refuses everything else: none of Core's real routes
// (the console, /v1/*, pairing, Google sign-in, frames, the driver and voice
// sockets) exist here at all. Every visitor is treated as hostile.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Duplex } from "node:stream";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { clientIp, rateKey } from "./limits.ts";
import type { Answer, Sandbox } from "./sandbox.ts";
import type { Visitor } from "./visitor.ts";

const file = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

export const REFUSED = "This Core is a public sandbox: only /try is open here. Nothing in it reaches a real account or device.";
const VISITOR = "x-auren-visitor";

const CommandBody = z.object({ text: z.string().max(4000) });
const TapBody = z.object({ approved: z.boolean(), surface: z.enum(["watch", "phone"]) });
const Since = z.coerce.number().int().min(0).catch(0);

export interface SandboxServerOptions {
  /** Proxies in front whose X-Forwarded-For is trusted (AUREN_TRUST_PROXY). */
  trustProxy: number;
  /** Told once when forwarded requests arrive but AUREN_TRUST_PROXY isn't set. */
  onUntrustedProxy?: () => void;
}

export function createSandboxServer(sandbox: Sandbox, opts: SandboxServerOptions) {
  const app = new Hono();
  let warned = false;

  const ipOf = (c: Context) => {
    const header = (h: string) => c.req.header(h);
    if (!opts.trustProxy && !warned && header("x-forwarded-for")) {
      warned = true;
      opts.onUntrustedProxy?.();
    }
    return clientIp((c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress, header, opts.trustProxy);
  };
  const reply = (c: Context, a: Answer) => {
    if (a.retryAfterS) c.header("retry-after", String(a.retryAfterS));
    return c.json(a.body, a.status);
  };
  const visitorOf = (c: Context): Visitor | undefined => {
    const id = c.req.header(VISITOR);
    return id ? sandbox.get(id) : undefined;
  };
  const gone = (c: Context) => c.json({ error: "No sandbox session. It may have expired after 30 minutes idle; the page starts a fresh one.", expired: true }, 401);

  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
  });

  // ── the page ───────────────────────────────────────────────────────────
  /**
   * The page's own origin, for the absolute URLs link previews need (og:url, og:image). The Host header is
   * the visitor's to set, so only a plain host[:port] is used (anything else becomes localhost), and
   * X-Forwarded-Proto counts only behind a trusted proxy. It's only ever echoed back to the same visitor.
   */
  const originOf = (c: Context) => {
    const host = c.req.header("host") ?? "";
    const forwarded = opts.trustProxy ? c.req.header("x-forwarded-proto")?.split(",").at(-1)?.trim() : undefined;
    const proto = forwarded === "https" || forwarded === "http" ? forwarded : new URL(c.req.url).protocol.replace(":", "");
    return `${proto === "https" ? "https" : "http"}://${/^[a-z0-9.-]{1,253}(:\d{1,5})?$/i.test(host) ? host : "localhost"}`;
  };
  const page = (c: Context) => {
    const nonce = randomBytes(16).toString("base64");
    c.header("content-security-policy", `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`);
    c.header("cache-control", "no-store");
    return c.html(file("../../../apps/web/try.html").replace("<script>", `<script nonce="${nonce}">`).replaceAll("{{origin}}", originOf(c)));
  };
  app.get("/", (c) => c.redirect("/try", 302));
  app.get("/try", page);
  app.get("/try/", page);
  app.get("/brand/tokens.css", (c) => c.body(file("../../../brand/tokens.css"), 200, { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=3600" }));
  app.get("/brand/og.png", (c) => c.body(new Uint8Array(readFileSync(new URL("../../../brand/og.png", import.meta.url))), 200, { "content-type": "image/png", "cache-control": "public, max-age=3600" }));
  app.get("/brand/mark.svg", (c) => c.body(file("../../../brand/mark.svg"), 200, { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" }));
  app.get("/health", (c) => c.json({ ok: true, sandbox: true, engine: sandbox.engine().mode, visitors: sandbox.visitors.size }));

  // ── the API ────────────────────────────────────────────────────────────
  app.use("/try/api/*", async (c, next) => {
    c.header("cache-control", "no-store");
    const r = sandbox.requests.take(rateKey(ipOf(c)));
    if (!r.ok) {
      c.header("retry-after", String(r.retryAfterS));
      return c.json({ error: "Slow down a little: too many requests from your network." }, 429);
    }
    await next();
  });
  app.use("/try/api/*", bodyLimit({ maxSize: 4096, onError: (c) => c.json({ error: "That request is too large." }, 413) }));

  app.post("/try/api/session", (c) => {
    const opened = sandbox.open(ipOf(c), c.req.header(VISITOR));
    if (!opened.ok) return c.json({ error: opened.error }, opened.status);
    return c.json({ visitor: opened.visitor.id, engine: sandbox.engine(), examples: sandbox.examples(), limits: sandbox.limits });
  });
  app.get("/try/api/state", (c) => {
    const v = visitorOf(c);
    if (!v) return gone(c);
    return c.json(sandbox.state(v, Since.parse(c.req.query("since")), Since.parse(c.req.query("outputs"))));
  });
  app.post("/try/api/command", async (c) => {
    const v = visitorOf(c);
    if (!v) return gone(c);
    const body = CommandBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Send a command as {\"text\": \"…\"}." }, 400);
    return reply(c, sandbox.command(v, body.data.text, ipOf(c)));
  });
  app.post("/try/api/taps/:id", async (c) => {
    const v = visitorOf(c);
    if (!v) return gone(c);
    const body = TapBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: "Send {\"approved\": true|false, \"surface\": \"watch\"|\"phone\"}." }, 400);
    return reply(c, sandbox.answer(v, c.req.param("id"), body.data.approved, body.data.surface));
  });
  app.post("/try/api/receipts/:id/undo", async (c) => {
    const v = visitorOf(c);
    if (!v) return gone(c);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, message: "No such receipt." }, 404);
    return reply(c, await sandbox.undo(v, id));
  });
  // "What Auren knows": Forget one learned preference in the visitor's current world. The list itself comes with /state.
  app.post("/try/api/preferences/:key/forget", (c) => {
    const v = visitorOf(c);
    if (!v) return gone(c);
    return reply(c, sandbox.forget(v, c.req.param("key")));
  });

  // Everything else, on every method: the real Core's routes are not here.
  app.all("*", (c) => c.json({ error: REFUSED }, 404));

  return {
    app,
    /** No sockets in the sandbox: the surface, voice and driver sockets are refused before any handshake. */
    upgrade(_req: unknown, socket: Duplex) {
      socket.destroy();
    },
  };
}
