// End to end over a real socket: what a device on the network can and can't do.
// "Remote" connections carry X-Forwarded-For, which is how a tunnel reaches Core.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { EventLog } from "./eventlog.ts";
import { approvalPayload, DeviceRegistry, helloPayload } from "./security/devices.ts";
import { fakeDevice } from "./security/devices.test.ts";
import { createServer } from "./server.ts";
import { SurfaceRegistry } from "./surfaces.ts";
import { ToolRegistry } from "./tools/registry.ts";

const log = new EventLog();
const surfaces = new SurfaceRegistry({ onEvent: (kind, data) => log.append("default", kind, data) });
const devices = new DeviceRegistry();
const core = createServer(
  { muse: { responses: { create: async () => ({ output: [] }) } }, tools: new ToolRegistry(), surfaces, log, agentModel: "muse-wonder-1.0" },
  { token: "", museReady: false, devices },
);
const http = serve({ fetch: core.app.fetch, port: 0, hostname: "127.0.0.1" });
http.on("upgrade", core.upgrade);
await new Promise((r) => http.once("listening", r));
const port = (http.address() as AddressInfo).port;
after(() => {
  core.close();
  http.close();
});

const REMOTE = { "x-forwarded-for": "203.0.113.7" };
const watch = (id: string) => ({ id, kind: "watch", name: "Apple Watch", inputs: ["voice", "text", "touch"], outputs: ["voice", "haptic", "screen"] });

/** Opens a surface socket, answers the challenge, and collects what Core sends. */
async function connect(id: string, opts: { remote?: boolean; dev?: ReturnType<typeof fakeDevice> } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/surface`, { headers: opts.remote ? REMOTE : {} });
  const inbox: any[] = [];
  const closed = new Promise<{ code: number }>((r) => ws.on("close", (code) => r({ code })));
  const next = (type: string) =>
    new Promise<any>((resolve) => {
      const found = inbox.find((m) => m.type === type);
      if (found) return resolve(found);
      const onMsg = (raw: Buffer) => {
        const m = JSON.parse(String(raw));
        if (m.type === type) {
          ws.off("message", onMsg);
          resolve(m);
        }
      };
      ws.on("message", onMsg);
    });
  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  const { nonce } = await next("challenge");
  const auth = opts.dev ? { device_id: id, signature: opts.dev.sign(helloPayload(nonce, id)) } : undefined;
  ws.send(JSON.stringify({ type: "hello", surface: watch(id), ...(auth ? { auth } : {}) }));
  return { ws, inbox, next, closed };
}

function pairDevice(id: string) {
  const dev = fakeDevice();
  devices.finishPairing({ code: devices.startPairing().code, id, kind: "watch", publicKey: dev.publicKey, hardware: true });
  return dev;
}

test("an unpaired device on the network is turned away", async () => {
  const { closed, inbox } = await connect("stranger-1", { remote: true });
  assert.equal((await closed).code, 1008);
  assert.match(inbox.find((m) => m.type === "event")?.event.data.message, /Pair this device first/);
});

test("a paired device's signed tap approves, and the log says who signed", async () => {
  const dev = pairDevice("watch-a");
  const c = await connect("watch-a", { remote: true, dev });
  await c.next("welcome");
  const decided = surfaces.requestApproval("Post in #office-hours", "send");
  const req = await c.next("approval_request");
  c.ws.send(JSON.stringify({ type: "approval_response", request_id: req.request_id, approved: true, signature: dev.sign(approvalPayload(req.request_id, true, req.summary)) }));
  assert.equal(await decided, true);
  const ev = log.since("default").filter((e) => e.kind === "approval").at(-1);
  assert.deepEqual([ev?.data.status, ev?.data.signed_by], ["approved", "watch-a"]);
  c.ws.close();
});

test("a forged or unsigned answer from a paired device is ignored", async () => {
  const dev = pairDevice("watch-b");
  const c = await connect("watch-b", { remote: true, dev });
  await c.next("welcome");
  void surfaces.requestApproval("Post in #general", "send", 2_000);
  const req = await c.next("approval_request");
  // Signed over a different summary, as a tampering relay would produce.
  c.ws.send(JSON.stringify({ type: "approval_response", request_id: req.request_id, approved: true, signature: dev.sign(approvalPayload(req.request_id, true, "Post in #office-hours")) }));
  c.ws.send(JSON.stringify({ type: "approval_response", request_id: req.request_id, approved: true }));
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(surfaces.approvalFor(req.request_id), "still waiting for a real tap");
  assert.ok(log.since("default").some((e) => e.kind === "error" && /valid device signature/.test(String(e.data.message))));
  c.ws.close();
});

test("a device can't claim another device's id", async () => {
  const dev = pairDevice("watch-c");
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/surface`, { headers: REMOTE });
  const nonce = await new Promise<string>((r) => ws.once("message", (raw) => r(JSON.parse(String(raw)).nonce)));
  ws.send(JSON.stringify({ type: "hello", surface: watch("phone-somebody"), auth: { device_id: "watch-c", signature: dev.sign(helloPayload(nonce, "watch-c")) } }));
  const code = await new Promise<number>((r) => ws.on("close", (c) => r(c)));
  assert.equal(code, 1008);
});

test("revoking a device on the Mac disconnects it", async () => {
  const dev = pairDevice("watch-d");
  const c = await connect("watch-d", { remote: true, dev });
  await c.next("welcome");
  const res = await fetch(`http://127.0.0.1:${port}/v1/devices/watch-d`, { method: "DELETE" });
  assert.equal(res.status, 200);
  assert.equal((await c.closed).code, 4001);
});

test("over HTTP, only this Mac may approve unsigned, and pairing starts only on the Mac", async () => {
  const pending = surfaces.requestApproval("Book a table for two", "send", 2_000);
  const id = [...log.since("default")].reverse().find((e) => e.kind === "approval" && e.data.status === "requested")?.data.request_id as string;
  const remote = await fetch(`http://127.0.0.1:${port}/v1/approvals/${id}`, { method: "POST", headers: { ...REMOTE, "content-type": "application/json" }, body: '{"approved":true}' });
  assert.equal(remote.status, 403);
  const local = await fetch(`http://127.0.0.1:${port}/v1/approvals/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: '{"approved":false}' });
  assert.equal(local.status, 200);
  assert.equal(await pending, false);

  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/pair/start`, { method: "POST", headers: REMOTE })).status, 403);
  const start = await fetch(`http://127.0.0.1:${port}/v1/pair/start`, { method: "POST" });
  assert.match((await start.json()).code, /^\d{6}$/);
});
