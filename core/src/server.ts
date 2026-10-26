import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { runCommand, undoReceipt, type AgentDeps } from "./agent/loop.ts";
import { ClientMessage, type ServerMessage } from "./protocol.ts";

export const SESSION = "default"; // v0: one person, one live session

const page = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

export function createServer(deps: AgentDeps, opts: { token: string; museReady: boolean }) {
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
  app.get("/minimal", (c) => c.html(page("../../spec/examples/minimal-surface.html")));
  app.get("/health", (c) => c.json({ ok: true, muse: opts.museReady, surfaces: surfaces.online() }));

  app.use("/v1/*", async (c, next) => {
    if (!authorized(c.req.header("authorization"), c.req.query("token"))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
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
