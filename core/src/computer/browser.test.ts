// GP4 end to end, with no browser: the agent loop calls browser.run_task, the
// runner drives a stand-in driver over a real /v1/driver socket, the commit
// guard's pause becomes one tap on the phone, and only then does the driver click.
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, test } from "node:test";
import { serve } from "@hono/node-server";
import { WebSocket } from "ws";
import { runCommand, type MuseLike } from "../agent/loop.ts";
import { EventLog } from "../eventlog.ts";
import type { ServerMessage } from "../protocol.ts";
import { createServer } from "../server.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { createBrowser } from "./browser.ts";
import { DriverHub } from "./hub.ts";

const SHOT = "data:image/jpeg;base64,U0hPVA==";
const BISTRO = "https://www.opentable.com/r/demo-bistro";
const ARGS = { task: "Find a table for two near Santana Row at 8 PM and hold it.", url: BISTRO, summary: "Hold a table for 2 at 8:00 PM" };

/** One Muse for both loops: requests with the computer tool get the browser script. */
function museFor(main: unknown[][], computer: unknown[][]) {
  const seen = { main: 0, computer: 0 };
  const muse: MuseLike = {
    responses: {
      async create(params) {
        const which = (params.tools as Array<{ type: string }>).some((t) => t.type === "computer") ? "computer" : "main";
        const script = which === "computer" ? computer : main;
        const output = script[Math.min(seen[which], script.length - 1)];
        const i = seen[which]++;
        const text = output.length ? "" : which === "main" ? "Held: a table for two at 8." : "Held the table.";
        return { id: `${which}_${i}`, output, output_text: text };
      },
    },
  };
  return muse;
}
const MAIN = [[{ type: "function_call", call_id: "f1", namespace: "browser", name: "run_task", arguments: JSON.stringify(ARGS) }], []];
const COMPUTER = [[{ type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 120, y: 120 }, { type: "click", x: 120, y: 320 }] }], []];

async function setup(opts: { token?: string } = {}) {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry({ onEvent: (kind, data) => log.append("default", kind, data) });
  const hub = new DriverHub({ timeoutMs: 5000 });
  const muse = museFor(MAIN, COMPUTER);
  const tools = new ToolRegistry().add(createBrowser({ hub, muse, model: "muse-wonder-1.0", log }));
  const deps = { muse, tools, surfaces, log, agentModel: "muse-wonder-1.0" };
  const core = createServer(deps, { token: opts.token ?? "", museReady: true, driver: hub });
  const http = serve({ fetch: core.app.fetch, port: 0, hostname: "127.0.0.1" });
  http.on("upgrade", core.upgrade);
  await new Promise((r) => http.once("listening", r));
  const port = (http.address() as AddressInfo).port;
  after(() => {
    hub.close();
    core.close();
    http.close();
  });
  return { log, surfaces, hub, deps, port };
}

/** A stand-in for driver/: says hello, then answers each command. The second click lands on "Complete reservation". */
function fakeDriver(port: number, headers: Record<string, string> = {}, query = "") {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/driver${query}`, { headers });
  const got: string[] = [];
  const ready = new Promise<void>((resolve, reject) => {
    ws.on("open", () => ws.send(JSON.stringify({ type: "hello", driver: { name: "test", viewport: { width: 1280, height: 800 }, allow: ["opentable.com"] } })));
    ws.on("error", reject);
    ws.on("close", () => reject(new Error("closed")));
    ws.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.type === "welcome") return resolve();
      got.push(m.type);
      const base = { type: "result", seq: m.seq, status: "ok", url: BISTRO, title: "Demo Bistro", screenshot: SHOT, frame: SHOT };
      if (m.type === "actions") {
        ws.send(JSON.stringify({ ...base, status: "paused", paused: { reason: "commit", role: "button", name: "Complete reservation" } }));
      } else if (m.type === "commit") {
        ws.send(JSON.stringify({ ...base, url: "https://www.opentable.com/booking/confirmed" }));
      } else {
        ws.send(JSON.stringify(base));
      }
    });
  });
  return { ws, got, ready };
}

function phone(surfaces: SurfaceRegistry, approve: boolean) {
  const inbox: ServerMessage[] = [];
  surfaces.join({ id: "phone", kind: "phone", name: "iPhone", inputs: ["voice", "touch"], outputs: ["voice", "screen"] }, (m) => {
    inbox.push(m);
    if (m.type === "approval_request") queueMicrotask(() => surfaces.answer(m.request_id, approve, "phone"));
  });
  return inbox;
}

test("GP4: browse without asking, one tap at the confirm button, then the click and a send-tier receipt", async () => {
  const { log, surfaces, hub, deps, port } = await setup();
  const ctx = { session: "default", surfaces };
  assert.equal(deps.tools.toResponsesTools(ctx).some((t: any) => t.name === "browser"), false, "no driver, no browser tools");

  const driver = fakeDriver(port);
  await driver.ready;
  assert.equal(hub.connected(), true);
  const ns = deps.tools.toResponsesTools(ctx).find((t: any) => t.name === "browser") as { description: string };
  assert.match(ns.description, /opentable\.com/, "the model is told which sites are allowed");

  const inbox = phone(surfaces, true);
  const { reply } = await runCommand(deps, { session: "default", text: "Find a table for two near there at 8 and hold it.", originSurfaceId: "phone" });

  assert.equal(reply, "Held: a table for two at 8.");
  const asks = inbox.filter((m) => m.type === "approval_request");
  assert.equal(asks.length, 1, "one tap, at the commit point");
  assert.equal(asks[0].type === "approval_request" && asks[0].summary, 'Hold a table for 2 at 8:00 PM · click "Complete reservation" on www.opentable.com');
  assert.equal(asks[0].type === "approval_request" && asks[0].tier, "send");
  assert.deepEqual(driver.got, ["start", "actions", "commit", "end"]);

  const events = log.since("default");
  const receipt = events.find((e) => e.kind === "receipt");
  assert.equal(receipt?.data.tier, "send");
  assert.equal(receipt?.data.summary, "Confirmed on the web: Hold a table for 2 at 8:00 PM");
  assert.equal(receipt?.data.link, "https://www.opentable.com/booking/confirmed");
  assert.ok(events.filter((e) => e.kind === "browser_frame").length >= 3, "frames reach the timeline");
  assert.ok(events.findIndex((e) => e.kind === "approval") > events.findIndex((e) => e.kind === "browser_frame"), "browsing came before the tap");
  driver.ws.close();
});

test("GP4 declined: no click and no receipt", async () => {
  const { log, surfaces, deps, port } = await setup();
  const driver = fakeDriver(port);
  await driver.ready;
  phone(surfaces, false);
  await runCommand(deps, { session: "default", text: "hold it", originSurfaceId: "phone" });
  assert.deepEqual(driver.got, ["start", "actions", "end"]);
  assert.equal(log.since("default").some((e) => e.kind === "receipt"), false);
  driver.ws.close();
});

test("the driver socket takes this Mac, or the token; a tunnel without it is refused", async () => {
  const open = await setup();
  await assert.rejects(fakeDriver(open.port, { "x-forwarded-for": "203.0.113.7" }).ready, "no token set: remote is refused");
  const local = fakeDriver(open.port);
  await local.ready;
  local.ws.close();

  const locked = await setup({ token: "s3cret" });
  await assert.rejects(fakeDriver(locked.port, { "x-forwarded-for": "203.0.113.7" }).ready, "remote without the token");
  const withToken = fakeDriver(locked.port, { "x-forwarded-for": "203.0.113.7", authorization: "Bearer s3cret" });
  await withToken.ready;
  assert.equal(locked.hub.connected(), true);
  withToken.ws.close();
});

test("one task at a time, and a newer driver replaces the old one", async () => {
  const { hub, port } = await setup();
  const first = fakeDriver(port);
  await first.ready;
  const link = hub.claim();
  assert.throws(() => hub.claim(), /already running a task/);
  await link.end();
  hub.claim();

  const closed = new Promise<number>((r) => first.ws.on("close", (code) => r(code)));
  const second = fakeDriver(port);
  await second.ready;
  assert.equal(await closed, 4000);
  assert.equal(hub.connected(), true);
  second.ws.close();
});
