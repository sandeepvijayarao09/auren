import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { Hono } from "hono";
import { WebSocket, WebSocketServer } from "ws";
import { runCommand, undoReceipt, type AgentDeps } from "./agent/loop.ts";
import { ClientMessage, type ServerMessage } from "./protocol.ts";
// Camera frames for glasses.look.
import { bodyLimit } from "hono/body-limit";
import { framePayload } from "./security/devices.ts";
import { MAX_FRAME_BYTES, type CaptureBroker } from "./vision/capture.ts";
import type { CropStore } from "./vision/crops.ts";
import { isJpeg } from "./vision/jpeg.ts";
import type { GoogleAuth } from "./connectors/google/auth.ts";
import type { KeySource } from "./security/keys.ts";
import type { Ledger } from "./security/ledger.ts";
import { approvalPayload, helloPayload, PairingError, type DeviceRegistry } from "./security/devices.ts";
import type { AsrConnector } from "./voice/asr.ts";
import { handleVoice } from "./voice/gateway.ts";
import { silentOps } from "./obs/opslog.ts";
import type { DriverHub } from "./computer/hub.ts";
// R11: MCP bridge
import type { McpServerStatus } from "./connectors/mcp.ts";
// R12: hold-to-talk clips from the watch.
import { acceptClip, MAX_CLIP_BYTES, ReplayCache } from "./voice/clip.ts";
import { examplesJsonl } from "./router/examples.ts";
import type { SpendGuard } from "./obs/spend.ts"; // R13

export const SESSION = "default"; // v0: one person, one live session

const page = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] as string);
const connectPage = (title: string, body: string) => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<link rel="stylesheet" href="/brand/tokens.css"><body style="margin:0;min-height:100vh;display:grid;place-items:center;background:var(--auren-onyx);color:var(--auren-halo);font:16px/1.5 var(--auren-text)">
<main style="max-width:28rem;padding:24px;text-align:center"><svg width="44" height="44" viewBox="0 0 22 22" aria-hidden="true"><g fill="none" stroke="#D4AB54" stroke-width="1.2"><circle cx="11" cy="11" r="10" opacity=".35"/><circle cx="11" cy="11" r="7" opacity=".6"/><circle cx="11" cy="11" r="4"/></g><circle cx="11" cy="11" r="1.6" fill="#D4AB54"/></svg>
<h1 style="font:400 26px/1.2 var(--auren-display);margin:16px 0 8px">${esc(title)}</h1><p style="color:var(--auren-ash);margin:0">${esc(body)}</p></main></body>`;

export interface ServerOptions {
  token: string;
  museReady: boolean;
  google?: GoogleAuth;
  ledger?: Ledger;
  /** Camera frames for glasses.look, and the receipt crops it keeps. Without it, /v1/frames answers 503. */
  vision?: { frames: CaptureBroker; crops: CropStore };
  keys?: { source: KeySource; note?: string };
  /** Trusted devices. With it, any surface not on this Mac must be paired and sign its approvals. */
  devices?: DeviceRegistry;
  /** Speech to text for /v1/voice. Without it, voice answers with a setup error. */
  voice?: { asr?: AsrConnector; keywords: () => string[] };
  /** R7: the computer-use driver's socket, /v1/driver. */
  driver?: DriverHub;
  /** R11: MCP bridge. The servers from mcp.json, listed in /v1/connections. */
  mcp?: { status(): McpServerStatus[] };
  /** R13: the token alarm and limit. At the limit, new commands are refused; approvals still resolve. */
  spend?: SpendGuard;
}

const LOOPBACK = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];
const FORWARDED = ["x-forwarded-for", "forwarded", "cf-connecting-ip", "x-real-ip"];

/** A request from this Mac itself. Traffic relayed by a tunnel or proxy carries forwarding headers, so it doesn't count. */
export function isLocal(remoteAddress: string | undefined, header: (name: string) => string | string[] | undefined | null): boolean {
  return LOOPBACK.includes(remoteAddress ?? "") && FORWARDED.every((h) => !header(h));
}

export function createServer(deps: AgentDeps, opts: ServerOptions) {
  const { log, surfaces } = deps;
  const app = new Hono();
  const authorized = (header?: string | null, query?: string | null) =>
    !opts.token || header === `Bearer ${opts.token}` || query === opts.token;

  const start = (text: string, surfaceId?: string) => {
    // R13: past AUREN_TOKEN_LIMIT, say so instead of starting. Approvals already waiting are untouched.
    const refused = opts.spend?.refusal();
    if (refused) {
      log.append(SESSION, "utterance", { text, surface_id: surfaceId ?? null });
      log.append(SESSION, "error", { message: refused });
      return;
    }
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
  const fromThisMac = (c: { env: unknown; req: { header: (name: string) => string | undefined } }) =>
    isLocal((c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming?.socket?.remoteAddress, (h) => c.req.header(h));
  // Open sockets by surface id, so revoking a device disconnects it at once.
  const sockets = new Map<string, WebSocket>();
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

  // Outside /v1 because an unpaired device has no token yet: the one-time code shown on the Mac is the gate.
  app.post("/pair/finish", async (c) => {
    if (!opts.devices) return c.json({ error: "Pairing isn't turned on in this Core." }, 503);
    const body = await c.req.json().catch(() => ({}));
    try {
      const d = opts.devices.finishPairing({
        code: String(body.code ?? ""),
        id: String(body.device_id ?? ""),
        name: typeof body.name === "string" ? body.name : undefined,
        kind: String(body.kind ?? "other"),
        publicKey: String(body.public_key ?? ""),
        hardware: body.hardware === true,
      });
      log.append(SESSION, "device", { device_id: d.id, kind: d.kind, status: "paired", hardware: d.hardware });
      return c.json({ paired: true, device: d });
    } catch (err) {
      if (err instanceof PairingError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });

  app.use("/v1/*", async (c, next) => {
    if (!authorized(c.req.header("authorization"), c.req.query("token"))) return c.json({ error: "unauthorized" }, 401);
    await next();
  });
  // Trust: is the log intact, where do the keys live, and what has left this Mac.
  app.get("/v1/audit/verify", (c) => c.json(log.verify()));
  app.get("/v1/outbound", (c) => c.json({ calls: opts.ledger?.list(Math.min(Number(c.req.query("limit") ?? 50), 500)) ?? [] }));
  app.get("/v1/trust", (c) =>
    c.json({
      log: log.verify(),
      keys: opts.keys ?? { source: "memory" },
      outbound: opts.ledger?.summary() ?? [],
      surfaces: surfaces.online().map((s) => ({ id: s.id, kind: s.kind })),
      devices: opts.devices?.list().map((d) => ({ id: d.id, kind: d.kind, hardware: d.hardware, revoked: d.revoked })) ?? [],
      // R13: model tokens, overall and per model, with the alarm and limit.
      usage: opts.spend?.status() ?? opts.ledger?.usage() ?? null,
    }),
  );
  // Pairing starts on the Mac only: you have to be at the Mac to let a new device in.
  app.post("/v1/pair/start", (c) => {
    if (!opts.devices) return c.json({ error: "Pairing isn't turned on in this Core." }, 503);
    if (!fromThisMac(c)) return c.json({ error: "Start pairing on the Mac itself." }, 403);
    return c.json(opts.devices.startPairing());
  });
  // R9: free labels for the Auren Router, as JSON lines. They hold command text, so they never leave this Mac.
  app.get("/v1/router/examples", (c) => {
    if (!fromThisMac(c)) return c.json({ error: "Export router examples on the Mac itself." }, 403);
    return c.body(examplesJsonl(log, SESSION), 200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
  });
  app.get("/v1/devices", (c) => c.json({ devices: opts.devices?.list() ?? [] }));
  app.delete("/v1/devices/:id", (c) => {
    if (!fromThisMac(c)) return c.json({ error: "Revoke devices from the Mac itself." }, 403);
    const id = c.req.param("id");
    const ok = opts.devices?.revoke(id) ?? false;
    if (ok) {
      log.append(SESSION, "device", { device_id: id, status: "revoked" });
      sockets.get(id)?.close(4001, "This device was revoked on the Mac.");
    }
    return c.json({ ok }, ok ? 200 : 404);
  });
  app.get("/v1/connections", (c) =>
    c.json({
      google: opts.google ? { configured: true, ...opts.google.status() } : { configured: false, connected: false },
      // R11: MCP bridge. Name, state, tool counts and trust mode; never commands, URLs, env or headers.
      mcp: opts.mcp?.status() ?? [],
    }),
  );
  app.get("/v1/events", (c) => c.json({ events: log.since(SESSION, Number(c.req.query("since") ?? 0)) }));
  app.post("/v1/command", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.text !== "string" || !body.text.trim()) return c.json({ error: "text required" }, 400);
    // R13: the limit is also an HTTP answer, so a script sees it.
    const refused = opts.spend?.refusal();
    if (refused) {
      start(body.text.trim(), typeof body.surface_id === "string" ? body.surface_id : undefined);
      return c.json({ error: refused }, 429);
    }
    start(body.text.trim(), typeof body.surface_id === "string" ? body.surface_id : undefined);
    return c.json({ accepted: true }, 202);
  });
  app.post("/v1/approvals/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const pending = surfaces.approvalFor(id);
    if (!pending) return c.json({ ok: false }, 404);
    const approved = body.approved === true;
    let signedBy: string | undefined;
    if (opts.devices && typeof body.device_id === "string") {
      if (!opts.devices.verify(body.device_id, approvalPayload(id, approved, pending.summary), body.signature)) {
        return c.json({ error: "That approval's signature didn't verify." }, 403);
      }
      signedBy = body.device_id;
    } else if (opts.devices && !fromThisMac(c)) {
      return c.json({ error: "Approvals from another device must be signed by a paired device." }, 403);
    }
    const ok = surfaces.answer(id, approved, typeof body.surface_id === "string" ? body.surface_id : undefined, signedBy);
    return c.json({ ok }, ok ? 200 : 404);
  });
  app.post("/v1/receipts/:id/undo", async (c) => c.json(await undoReceipt(deps, Number(c.req.param("id")), SESSION)));

  // ── Camera frames ──────────────────────────────────────────────────────
  // A frame is taken only for a capture Core asked for, only from the surface it
  // asked, and from another device only with its signature over the exact bytes.
  app.post(
    "/v1/frames/:request_id",
    bodyLimit({ maxSize: MAX_FRAME_BYTES, onError: (c) => c.json({ error: "A frame can be at most 2 MB." }, 413) }),
    async (c) => {
      if (!opts.vision) return c.json({ error: "The camera isn't turned on in this Core." }, 503);
      const requestId = c.req.param("request_id");
      const target = opts.vision.frames.target(requestId);
      if (!target) return c.json({ error: "No capture is waiting for that request." }, 404);
      const jpeg = Buffer.from(await c.req.arrayBuffer());
      if (!isJpeg(jpeg)) return c.json({ error: "A frame must be a JPEG." }, 415);
      const deviceId = c.req.header("x-auren-device");
      let from: string;
      if (opts.devices && deviceId) {
        if (!opts.devices.verify(deviceId, framePayload(requestId, jpeg), c.req.header("x-auren-signature"))) {
          log.append(SESSION, "error", { message: "A camera frame arrived without a valid device signature, so Auren dropped it.", surface_id: deviceId });
          return c.json({ error: "That frame's signature didn't verify." }, 403);
        }
        from = deviceId;
      } else if (opts.devices && !fromThisMac(c)) {
        return c.json({ error: "Frames from another device must be signed by a paired device." }, 403);
      } else {
        from = c.req.header("x-auren-surface") ?? c.req.query("surface_id") ?? "";
      }
      if (opts.vision.frames.deliver(requestId, from, jpeg) !== "accepted") {
        return c.json({ error: "That capture was sent to a different device." }, 403);
      }
      return c.json({ accepted: true }, 202);
    },
  );
  // The receipt's crop: the outline SAM drew, never the whole frame.
  app.get("/v1/crops/:id", (c) => {
    const jpeg = opts.vision?.crops.get(c.req.param("id"));
    if (!jpeg) return c.json({ error: "not found" }, 404);
    return c.body(new Uint8Array(jpeg), 200, { "content-type": "image/jpeg", "cache-control": "private, max-age=3600" });
  });

  // ── R12: hold-to-talk clips (the watch) ────────────────────────────────
  // The whole clip in one POST, straight from the watch or relayed unchanged by the iPhone.
  // Signed by a paired device over the exact bytes; stale or repeated clips are refused.
  const clipReplay = new ReplayCache();
  app.post(
    "/v1/voice/clip",
    bodyLimit({ maxSize: MAX_CLIP_BYTES, onError: (c) => c.json({ error: "A clip can be at most 30 seconds." }, 413) }),
    async (c) => {
      const reply = await acceptClip(
        { pcm: new Uint8Array(await c.req.arrayBuffer()), local: fromThisMac(c), header: (h) => c.req.header(h) },
        {
          voice: {
            asr: opts.voice?.asr,
            devices: opts.devices,
            keywords: opts.voice?.keywords ?? (() => []),
            onCommand: (text, surfaceId) => start(text, surfaceId),
            ops: deps.ops ?? silentOps,
            ledger: opts.ledger,
          },
          devices: opts.devices,
          replay: clipReplay,
          onRefused: (message, deviceId) => log.append(SESSION, "error", { message, surface_id: deviceId }),
        },
      );
      return c.json(reply.body, reply.status);
    },
  );

  // Surface protocol over WebSocket.
  const wss = new WebSocketServer({ noServer: true });
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    let surfaceId: string | null = null;
    let deviceId: string | null = null;
    const local = isLocal(req.socket.remoteAddress, (h) => req.headers[h]);
    const nonce = randomBytes(18).toString("base64url");
    const send = (msg: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(msg));
    const refuse = (message: string) => {
      send({ type: "event", event: { id: 0, session: SESSION, at: Date.now(), kind: "error", data: { message } } });
      ws.close(1008, message.slice(0, 120));
    };
    // Paired devices answer this with a Secure Enclave signature in their hello.
    send({ type: "challenge", nonce });

    ws.on("message", (raw) => {
      let msg: ClientMessage;
      try {
        msg = ClientMessage.parse(JSON.parse(String(raw)));
      } catch {
        return send({ type: "event", event: { id: 0, session: SESSION, at: Date.now(), kind: "error", data: { message: "bad message" } } });
      }
      if (msg.type === "hello") {
        if (msg.auth && opts.devices) {
          const ok = msg.auth.device_id === msg.surface.id && opts.devices.verify(msg.auth.device_id, helloPayload(nonce, msg.auth.device_id), msg.auth.signature);
          if (!ok) return refuse("This device's signature didn't verify. Pair it again from the Mac.");
          deviceId = msg.auth.device_id;
        } else if (opts.devices && !local) {
          return refuse("Pair this device first: on the Mac, open the console and choose Pair a device.");
        }
        surfaceId = msg.surface.id;
        sockets.set(surfaceId, ws);
        surfaces.join(msg.surface, send);
        return send({ type: "welcome", session_id: SESSION, surfaces: surfaces.online(), heartbeat_ms: surfaces.heartbeatMsFor(msg.surface.kind) });
      }
      if (!surfaceId) return ws.close(1008, "hello first");
      if (msg.type === "heartbeat") surfaces.heartbeat(surfaceId, msg.active);
      else if (msg.type === "utterance") start(msg.text, surfaceId);
      else if (msg.type === "speak_progress") surfaces.progress(msg.reply_id, msg.seq, surfaceId);
      else if (msg.type === "approval_response") {
        const pending = surfaces.approvalFor(msg.request_id);
        if (!pending) return;
        // A paired device must sign what it approves; only this Mac's own console may answer unsigned.
        if (deviceId) {
          if (!opts.devices?.verify(deviceId, approvalPayload(msg.request_id, msg.approved, pending.summary), msg.signature)) {
            log.append(SESSION, "error", { message: "An approval arrived without a valid device signature, so Auren ignored it.", surface_id: surfaceId });
            return;
          }
        } else if (opts.devices && !local) {
          return;
        }
        surfaces.answer(msg.request_id, msg.approved, surfaceId, deviceId ?? undefined);
      }
    });
    ws.on("close", () => {
      if (!surfaceId) return;
      if (sockets.get(surfaceId) === ws) sockets.delete(surfaceId);
      surfaces.leave(surfaceId);
    });
  });

  // Microphone audio → Muse Voice Transcribe → a command from that surface.
  const voiceWss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
  voiceWss.on("connection", (ws: WebSocket, req: IncomingMessage) =>
    handleVoice(ws, isLocal(req.socket.remoteAddress, (h) => req.headers[h]), {
      asr: opts.voice?.asr,
      devices: opts.devices,
      keywords: opts.voice?.keywords ?? (() => []),
      onCommand: (text, surfaceId) => start(text, surfaceId),
      ops: deps.ops ?? silentOps,
      ledger: opts.ledger,
    }),
  );

  log.onEvent((event) => surfaces.broadcast({ type: "event", event }));
  const sweeper = setInterval(() => surfaces.sweep(), 500);

  return {
    app,
    upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      const url = new URL(req.url ?? "/", "http://localhost");
      // R7: the computer-use driver dials in from this Mac, or from anywhere with AUREN_TOKEN.
      if (url.pathname === "/v1/driver") {
        const hub = opts.driver;
        const local = isLocal(req.socket.remoteAddress, (h) => req.headers[h]);
        if (!hub || !(local || (opts.token && authorized(req.headers.authorization, url.searchParams.get("token"))))) return void socket.destroy();
        return hub.wss.handleUpgrade(req, socket, head, (ws) => hub.wss.emit("connection", ws, req));
      }
      // With pairing on, an unpaired device may open the socket; it then has to prove a paired key in hello.
      const allowed = authorized(req.headers.authorization, url.searchParams.get("token")) || Boolean(opts.devices);
      const target = url.pathname === "/v1/surface" ? wss : url.pathname === "/v1/voice" ? voiceWss : null;
      if (!target || !allowed) {
        socket.destroy();
        return;
      }
      target.handleUpgrade(req, socket, head, (ws) => target.emit("connection", ws, req));
    },
    close() {
      clearInterval(sweeper);
      wss.close();
      voiceWss.close();
    },
  };
}
