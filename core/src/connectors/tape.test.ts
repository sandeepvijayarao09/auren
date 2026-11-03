import assert from "node:assert/strict";
import { test } from "node:test";
import { createSlack } from "./slack.ts";
import { player, recorder, type Tape } from "./tape.ts";

test("record once, replay offline, and tokens never reach the tape", async () => {
  let realCalls = 0;
  const real = (async (input: string) => {
    realCalls++;
    const body = String(input).includes("oauth") ? { access_token: "ya29.secret", expires_in: 3600 } : { ok: true, channels: [{ id: "C01", name: "office-hours" }] };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

  const tape: Tape = { entries: [] };
  const rec = recorder(real, tape);
  const live = await createSlack({ token: "xoxb-1", fetch: rec }).tools[0].run({}, {} as never);
  await rec("https://oauth2.googleapis.com/token", { method: "POST" });
  assert.equal(realCalls, 2);
  assert.ok(!JSON.stringify(tape).includes("ya29.secret"));

  const replayed = await createSlack({ token: "xoxb-1", fetch: player(tape) }).tools[0].run({}, {} as never);
  assert.deepEqual(replayed, live);
  assert.equal(realCalls, 2);
});

test("a call that isn't on the tape fails loudly", async () => {
  const play = player({ entries: [] });
  await assert.rejects(play("https://slack.com/api/chat.postMessage", { method: "POST" }), /Not on the tape: POST https:\/\/slack\.com/);
});
