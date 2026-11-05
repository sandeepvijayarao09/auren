import assert from "node:assert/strict";
import { test } from "node:test";
import { runCommand, type MuseLike } from "../agent/loop.ts";
import { EventLog } from "../eventlog.ts";
import { createServer } from "../server.ts";
import { SurfaceRegistry } from "../surfaces.ts";
import { createDemoWorld } from "../tools/demo-world.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { cardPrompt, createInviteCards, type ImageClient } from "./cards.ts";
import { CropStore } from "./crops.ts";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const call = (call_id: string, namespace: string, name: string, args: object) => ({ type: "function_call", call_id, namespace, name, arguments: JSON.stringify(args) });

/** A fake Muse Image: answers with JPEG bytes, fails, or hangs, and records every prompt. */
function fakeImages(mode: "ok" | "fail" | "hang" = "ok") {
  const prompts: Array<Record<string, unknown>> = [];
  const client: ImageClient = {
    images: {
      async generate(params) {
        prompts.push(params);
        if (mode === "fail") throw Object.assign(new Error("503 upstream"), { status: 503 });
        if (mode === "hang") return new Promise(() => {});
        return { data: [{ b64_json: JPEG.toString("base64") }] };
      },
    },
  };
  return { client, prompts };
}

function setup(mode: "ok" | "fail" | "hang", approve = true, waitMs = 200) {
  const log = new EventLog();
  const surfaces = new SurfaceRegistry();
  const world = createDemoWorld();
  const tools = new ToolRegistry().add(...world.namespaces);
  const turns = [
    { output: [call("c1", "calendar", "invite", { event_id: "evt_1", emails: ["sam@example.com"] })] },
    { output: [], output_text: "Invited Sam." },
  ];
  let i = 0;
  const muse: MuseLike = { responses: { create: async () => ({ id: `r${i}`, output: turns[Math.min(i++, 1)].output, output_text: turns[Math.min(i - 1, 1)].output_text ?? "" }) } };
  const approvals: string[] = [];
  surfaces.join({ id: "watch", kind: "watch", name: "Watch", inputs: ["voice", "touch"], outputs: ["voice", "haptic"] }, (m) => {
    if (m.type === "approval_request") {
      approvals.push(m.summary);
      queueMicrotask(() => surfaces.answer(m.request_id, approve, "watch"));
    }
  });
  const store = new CropStore(":memory:", undefined, undefined, "card");
  const images = fakeImages(mode);
  const cards = createInviteCards({ client: images.client, store, waitMs, describe: async () => ({ title: "Demo night", location: "Room 214", start: "2026-11-04T18:00" }) });
  const deps = { muse, tools, surfaces, log, agentModel: "muse-wonder-1.0", cards };
  return { deps, log, world, store, images, approvals };
}

const inviteReceipt = (log: EventLog) => log.since("s").find((e) => e.kind === "receipt" && e.data.tool === "invite");

test("an approved invite gets a Muse Image card, stored encrypted, its id on the receipt", async () => {
  const { deps, log, world, store, images, approvals } = setup("ok");
  await runCommand(deps, { session: "s", text: "invite sam to office hours" });
  assert.equal(approvals.length, 1, "the send tap is unchanged");
  assert.deepEqual(world.state.events.get("evt_1")!.invitees, ["sam@example.com"]);
  const card_id = inviteReceipt(log)!.data.card_id as string;
  assert.match(card_id, /^card_[0-9a-f]{16}$/);
  assert.deepEqual(store.get(card_id), JPEG);
  assert.equal(images.prompts[0].model, "muse-image-1.0");
  assert.equal(images.prompts[0].output_format, "jpeg");
  assert.match(String(images.prompts[0].prompt), /'Demo night'.*'Room 214 · 6 PM'/);
  assert.doesNotMatch(String(images.prompts[0].prompt), /sam@example\.com/, "invitees never go to the image model");
});

test("a failed card never stops the invite; the receipt just has no card", async () => {
  const { deps, log, world } = setup("fail");
  await runCommand(deps, { session: "s", text: "invite sam" });
  assert.deepEqual(world.state.events.get("evt_1")!.invitees, ["sam@example.com"]);
  const r = inviteReceipt(log)!;
  assert.equal(r.data.card_id, undefined);
  assert.equal(log.since("s").some((e) => e.kind === "error"), false);
});

test("a slow card is dropped after waitMs; the invite and receipt still land", async () => {
  const { deps, log, world } = setup("hang", true, 30);
  const t0 = performance.now();
  await runCommand(deps, { session: "s", text: "invite sam" });
  assert.ok(performance.now() - t0 < 1000);
  assert.deepEqual(world.state.events.get("evt_1")!.invitees, ["sam@example.com"]);
  assert.equal(inviteReceipt(log)!.data.card_id, undefined);
});

test("a declined invite never calls Muse Image", async () => {
  const { deps, images, world } = setup("ok", false);
  await runCommand(deps, { session: "s", text: "invite sam" });
  assert.equal(images.prompts.length, 0, "the card starts only after the tier gate");
  assert.deepEqual(world.state.events.get("evt_1")!.invitees, []);
});

test("only calendar.invite gets a card", () => {
  const { client } = fakeImages();
  const cards = createInviteCards({ client, store: new CropStore(":memory:", undefined, undefined, "card") });
  assert.equal(cards.start("calendar", "create_event", {}), undefined);
  assert.equal(cards.start("slack", "post_message", {}), undefined);
  assert.ok(cards.start("calendar", "invite", { event_id: "evt_1" }));
});

test("card prompts strip quotes and fall back to a generic card", () => {
  assert.match(cardPrompt({ title: `Demo' night"\nX`, start: "2026-11-04T18:30" }), /'Demo night X'.*'6:30 PM'/);
  assert.match(cardPrompt(undefined), /'You're invited'/);
});

test("cards keep their own table and key, apart from crops", () => {
  const path = ":memory:";
  const cards = new CropStore(path, Buffer.alloc(32, 1), Date.now, "card");
  const id = cards.put(JPEG);
  assert.deepEqual(cards.get(id), JPEG);
  const wrongKey = new CropStore(path, Buffer.alloc(32, 2), Date.now, "card");
  assert.equal(wrongKey.get(id), undefined);
});

test("GET /v1/cards/:id serves the card like a crop, and 404s otherwise", async () => {
  const store = new CropStore(":memory:", undefined, undefined, "card");
  const id = store.put(JPEG);
  const core = createServer(
    { muse: { responses: { create: async () => ({}) } }, tools: new ToolRegistry(), surfaces: new SurfaceRegistry(), log: new EventLog(), agentModel: "m" },
    { token: "", museReady: false, vision: { frames: {} as never, crops: new CropStore(), cards: store } },
  );
  const ok = await core.app.request(`/v1/cards/${id}`);
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), JPEG);
  assert.equal((await core.app.request("/v1/cards/card_nope")).status, 404);
  core.close();
});
