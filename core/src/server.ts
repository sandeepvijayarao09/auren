import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { runCommand, undoReceipt, type AgentDeps } from "./agent/loop.ts";
import { ClientMessage, type ServerMessage } from "./protocol.ts";
import type { GoogleAuth } from "./connectors/google/auth.ts";

export const SESSION = "default"; // v0: one person, one live session

const page = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
const connectPage = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="/brand/tokens.css"><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:var(--auren-onyx);color:var(--auren-halo);font:16px/1.5 var(--auren-text)">
<main style="max-width:28rem;padding:24px;text-align:center"><svg width="44" height="44" viewBox="0 0 22 22" aria-hidden="true"><g fill="none" stroke="#D4AB54" stroke-width="1.2"><circle cx="11" cy="11" r="10" opacity=".35"/><circle cx="11" cy="11" r="7" opacity=".6"/><circle cx="11" cy="11" r="4"/></g><circle cx="11" cy="11" r="1.6" fill="#D4AB54"/></svg>
<h1 style="font:400 26px/1.2 var(--auren-display);margin:16px 0 8px">${esc(title)}</h1><p style="color:var(--auren-ash);margin:0">${esc(body)}</p></main></body>`;

export function createServer(deps: AgentDeps, opts: { token: string; museReady: boolean; google?: GoogleAuth }) {
  const { log, surfaces } = deps;
  const app = new Hono();
  const authorized = (header?: string | null, query?: string | null) =>
    !opts.token || header === `Bearer ${opts.token}` || query === opts.token;

  const start = (text: string, surfaceId?: string) => {
    if (!opts.museReady) {
      log.append(SESSION, "utterance", { text, surface_id: surfaceId ?? null });
      log.append(SESSION, "error", { message: "MODEL_API_KEY is not set. Add it to .env and restart Core." });
      return;
    }
    void runCommand(deps, { session: SESSION, text, originSurfaceId: surfaceId });
  };

  app.get("/", (c) => c.html(page("../../apps/web/index.html")));
  app.get("/brand/tokens.css", (c) => c.body(page("../../brand/tokens.css"), 200, { "content-type": "text/css; charset=utf-8" }));
  app.get("/minimal", (c) => c.html(page("../../spec/examples/minimal-surface.html")));
  app.get("/health", (c) => c.json({ ok: true, muse: opts.museReady, google: opts.google?.status().connected ?? null, surfaces: surfaces.online() }));

  // Connecting an account happens in a browser on this Mac (or with the token). Google
  // redirects back to a loopback address, so this needs a "Desktop app" OAuth client.
  const fromThisMac = (c: { env: unknown }) => {
    const addr = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress ?? "";
    return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(addr);
  };
  app.get("/connect/google", (c) => {
    if (!opts.google) return c.html(connectPage("Google isn't set up yet", "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart Core. The steps are in docs/google-setup.md."), 503);
    if (!fromThisMac(c) && !authorized(c.req.header("authorization"), c.req.query("token"))) return c.text("unauthorized", 401);
    return c.redirect(opts.google.authUrl());
  });
  app.get("/connect/google/callback", async (c) => {
    if (!opts.google) return c.html(connectPage("Google isn't set up yet", "Add the client ID and secret to .env first."), 503);
    const denied = c.req.query("error");
    if (denied) return c.html(connectPage("Google sign-in was cancelled", `Google said "${denied}". Start again from /connect/google.`), 400);
    try {
      const { email } = await opts.google.finish(c.req.query("code") ?? "", c.req.query("state") ?? "");
      return c.html(connectPage("Google is connected", `Auren can use the calendar${email ? ` for ${email}` : ""}. You can close this tab.`));
    } catch (err) {
      return c.html(connectPage("Couldn't connect Google", err instanceof Error ? err.message : String(err)), 400);
    }
  });

  app.use("/v1/*", async (c, next) => {
    if (!authorized(c.req.header("authorization"), c.req.query("token"))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  app.get("/v1/connections", (c) => c.json({ google: opts.google ? { configured: true, ...opts.google.status() } : { configured: false, connected: false } }));
  app.get("/v1/events", (c) => c.json({ events: log.since(SESSION, Number(c.req.query("since") ?? 0)) }));
  app.post("/v1/command", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.text !== "string" || !body.text.trim()) return c.json({ error: "text required" }, 400);
    start(body.text.trim(), typeof body.surface_id === "string" ? body.surface_id : undefined);
    return c.json({ accepted: true }, 202);
  });
  app.post("/v1/approvals/:id", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const ok = surfaces.answer(c.req.param("id"), body.approved === true, body.surface_id);
    return c.json({ ok }, ok ? 200 : 404);
  });
  app.post("/v1/receipts/:id/undo", async (c) => c.json(await undoReceipt(deps, Number(c.req.param("id")), SESSION)));

  // Surface protocol over WebSocket.
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws: WebSocket) => {
    let surfaceId: string | null = null;
    const send = (msg: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = ClientMessage.parse(JSON.parse(String(raw)));
      } catch {
        return send({ type: "event", event: { id: 0, session: SESSION, at: Date.now(), kind: "error", data: { message: "bad message" } } });
      }
      if (msg.type === "hello") {
        surfaceId = msg.surface.id;
        surfaces.join(msg.surface, send);
        return send({ type: "welcome", session_id: SESSION, surfaces: surfaces.online() });
      }
      if (!surfaceId) return ws.close(1008, "hello first");
      if (msg.type === "heartbeat") surfaces.heartbeat(surfaceId, msg.active);
      else if (msg.type === "utterance") start(msg.text, surfaceId);
      else if (msg.type === "approval_response") surfaces.answer(msg.request_id, msg.approved, surfaceId);
    });
    ws.on("close", () => surfaceId && surfaces.leave(surfaceId));
  });

  log.onEvent((event) => surfaces.broadcast({ type: "event", event }));
  const sweeper = setInterval(() => surfaces.sweep(), 500);

  return {
    app,
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/v1/surface" || !authorized(req.headers.authorization, url.searchParams.get("token"))) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    },
    close() {
      clearInterval(sweeper);
      wss.close();
    },
  };
}
