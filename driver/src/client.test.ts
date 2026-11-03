// The driver's side of /v1/driver against a stand-in Core: hello first, then
// one result per command with the same seq, and an error for a bad command.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { WebSocketServer, type WebSocket } from "ws";
import { connectToCore } from "./client.ts";
import type { Action, StepResult } from "./protocol.ts";

test("says hello, runs commands in order, and answers each with its seq", async () => {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await new Promise((r) => wss.once("listening", r));
  const port = (wss.address() as AddressInfo).port;
  const ran: string[] = [];
  const ok = (url: string): StepResult => ({ status: "ok", url, title: "" });
  const executor = {
    start: async (url: string) => (ran.push(`start ${url}`), ok(url)),
    run: async (actions: Action[]) => (ran.push(`run ${actions.map((a) => a.type).join(",")}`), ok("")),
    commit: async () => (ran.push("commit"), ok("")),
    end: async () => (ran.push("end"), ok("")),
  };

  const seen: { headers?: Record<string, unknown>; path?: string } = {};
  const conn = new Promise<WebSocket>((resolve) =>
    wss.once("connection", (ws, req) => {
      seen.headers = req.headers;
      seen.path = req.url;
      resolve(ws);
    }),
  );
  const client = connectToCore({ core: `http://127.0.0.1:${port}`, token: "t0k", executor, hello: { name: "test", viewport: { width: 1280, height: 800 }, allow: ["127.0.0.1"] } });
  after(() => {
    client.close();
    wss.close();
  });
  const ws = await conn;
  const inbox: any[] = [];
  const next = () => new Promise<any>((r) => ws.once("message", (raw) => r(JSON.parse(String(raw)))));

  const hello = await next();
  assert.equal(hello.type, "hello");
  assert.deepEqual(hello.driver.allow, ["127.0.0.1"]);
  assert.equal(seen.path, "/v1/driver");
  assert.equal(seen.headers?.authorization, "Bearer t0k");

  ws.on("message", (raw) => inbox.push(JSON.parse(String(raw))));
  ws.send(JSON.stringify({ type: "welcome" }));
  ws.send(JSON.stringify({ type: "start", seq: 1, url: "http://127.0.0.1/r" }));
  ws.send(JSON.stringify({ type: "actions", seq: 2, actions: [{ type: "click", x: 1, y: 2, button: "left" }, { type: "type", text: "hi" }] }));
  ws.send(JSON.stringify({ type: "actions", seq: 3, actions: [{ type: "teleport" }] }));
  ws.send(JSON.stringify({ type: "commit", seq: 4 }));
  while (inbox.length < 4) await new Promise((r) => setTimeout(r, 10));

  assert.deepEqual(inbox.map((m) => [m.seq, m.status]), [[1, "ok"], [2, "ok"], [3, "error"], [4, "ok"]]);
  assert.deepEqual(ran, ["start http://127.0.0.1/r", "run click,type", "commit"], "the bad batch never reached the browser");
});
