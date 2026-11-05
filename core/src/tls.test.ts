// Core over TLS: HTTPS /health and a WSS surface hello, with a CA and cert made here by openssl.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";
import { EventLog } from "./eventlog.ts";
import { createServer } from "./server.ts";
import { SurfaceRegistry } from "./surfaces.ts";
import { listen } from "./tls.ts";
import { ToolRegistry } from "./tools/registry.ts";

const dir = mkdtempSync(join(tmpdir(), "auren-tls-"));
execFileSync("sh", [new URL("../scripts/make-cert.sh", import.meta.url).pathname, dir], { env: { ...process.env, AUREN_CERT_HOST: "auren-test.local" }, stdio: "ignore" });
const ca = readFileSync(join(dir, "ca.pem"));

const log = new EventLog();
const surfaces = new SurfaceRegistry({ onEvent: (kind, data) => log.append("default", kind, data) });
const core = createServer(
  { muse: { responses: { create: async () => ({ output: [] }) } }, tools: new ToolRegistry(), surfaces, log, agentModel: "muse-wonder-1.0" },
  { token: "", museReady: false },
);
const server = listen({ fetch: core.app.fetch, port: 0, hostname: "127.0.0.1", tls: { cert: join(dir, "server.pem"), key: join(dir, "server.key") } });
server.on("upgrade", core.upgrade);
await new Promise((r) => server.once("listening", r));
const port = (server.address() as AddressInfo).port;
after(() => {
  core.close();
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

test("/health answers over HTTPS, verified against the local CA", async () => {
  const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path: "/health", ca }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    })
      .on("error", reject)
      .end();
  });
  assert.equal(status, 200);
  assert.equal(typeof JSON.parse(body), "object");
});

test("the cert names localhost, 127.0.0.1 and the .local host", () => {
  const out = execFileSync("openssl", ["x509", "-in", join(dir, "server.pem"), "-noout", "-ext", "subjectAltName"], { encoding: "utf8" });
  assert.match(out, /DNS:localhost/);
  assert.match(out, /IP Address:127\.0\.0\.1/);
  assert.match(out, /DNS:auren-test\.local/);
});

test("a /v1/surface hello works over WSS", async () => {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/v1/surface`, { ca });
  const seen: any[] = [];
  const welcome = new Promise<any>((resolve, reject) => {
    ws.on("error", reject);
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      seen.push(m);
      if (m.type === "challenge")
        ws.send(JSON.stringify({ type: "hello", surface: { id: "tls-watch", kind: "watch", name: "Apple Watch", inputs: ["text"], outputs: ["screen"] } }));
      if (m.type === "welcome") resolve(m);
    });
  });
  const m = await welcome;
  assert.equal(typeof m.session_id, "string");
  ws.close();
});

test("plain HTTP is not served on the TLS port", async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`).then(() => "ok", () => "refused");
  assert.equal(res, "refused");
});
