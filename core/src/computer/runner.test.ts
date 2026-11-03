// The runner with a scripted Muse (as in agent/loop.test.ts) and a fake driver.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { MuseLike } from "../agent/loop.ts";
import { EventLog } from "../eventlog.ts";
import { Ledger } from "../security/ledger.ts";
import type { DriverAction } from "./actions.ts";
import type { DriverLink, DriverResult } from "./hub.ts";
import { runTask, type RunnerDeps } from "./runner.ts";

const SHOT = "data:image/jpeg;base64,U0hPVA==";
const FRAME = "data:image/jpeg;base64,RlJBTUU=";
const TASK = { goal: "Find a table for two near Santana Row at 8 and hold it.", url: "https://www.opentable.com/r/demo-bistro", summary: "Hold a table for 2 at 8:00 PM" };

const cc = (call_id: string, actions: unknown[], pending_safety_checks: unknown[] = []) => ({ type: "computer_call", call_id, actions, pending_safety_checks });
const click = (x: number, y: number) => ({ type: "click", x, y, button: "left" });

function scriptedMuse(turns: Array<{ output: unknown[]; output_text?: string }>) {
  const requests: Array<Record<string, any>> = [];
  let i = 0;
  const muse: MuseLike = {
    responses: {
      async create(params) {
        requests.push(params);
        const turn = turns[Math.min(i, turns.length - 1)];
        return { id: `resp_${i++}`, output: turn.output, output_text: turn.output_text ?? "" };
      },
    },
  };
  return { muse, requests };
}

/** `onAct` decides what each batch returns; by default every batch succeeds. */
function fakeDriver(onAct: (actions: DriverAction[], n: number) => Partial<DriverResult> = () => ({})) {
  const calls: string[] = [];
  let n = 0;
  const ok = (extra: Partial<DriverResult> = {}): DriverResult => ({ type: "result", seq: 0, status: "ok", url: TASK.url, title: "Demo Bistro", screenshot: SHOT, frame: FRAME, ...extra });
  const driver: DriverLink = {
    async start(url) {
      calls.push(`start ${url}`);
      return ok();
    },
    async act(actions) {
      calls.push(`act ${actions.map((a) => a.type).join(",")}`);
      return ok(onAct(actions, ++n));
    },
    async commit() {
      calls.push("commit");
      return ok({ url: "https://www.opentable.com/booking/confirmed", title: "You're all set" });
    },
    async end() {
      calls.push("end");
    },
  };
  return { driver, calls };
}

const PAUSE: Partial<DriverResult> = { status: "paused", paused: { reason: '"Complete reservation" looks like a commit', role: "button", name: "Complete reservation" } };

function deps(muse: MuseLike, driver: DriverLink, extra: Partial<RunnerDeps> = {}): RunnerDeps & { log: EventLog; asked: string[] } {
  const asked: string[] = [];
  return {
    muse,
    model: "muse-wonder-1.0",
    driver,
    log: new EventLog(),
    session: "s",
    approveCheck: async (s) => (asked.push(s), true),
    approveCommit: async (s) => (asked.push(s), true),
    asked,
    ...extra,
  };
}

test("follows computer calls to the end, sending each screenshot back", async () => {
  const { muse, requests } = scriptedMuse([
    { output: [cc("c1", [click(120, 120)])] },
    { output: [cc("c2", [{ type: "type", text: "Santana Row" }, { type: "keypress", keys: ["ENTER"] }])] },
    { output: [], output_text: "Bistro Demo has a table for two at 8:00 PM." },
  ]);
  const { driver, calls } = fakeDriver();
  const d = deps(muse, driver);
  const r = await runTask(d, TASK);

  assert.equal(r.status, "done");
  assert.equal(r.steps, 2);
  assert.equal(r.committed, false);
  assert.equal(r.report, "Bistro Demo has a table for two at 8:00 PM.");
  assert.deepEqual(calls, [`start ${TASK.url}`, "act click", "act type,keypress", "end"]);
  assert.deepEqual(requests[0].tools, [{ type: "computer" }]);
  assert.equal(requests[0].input[0].content[1].image_url, SHOT, "the first turn sees the opening page");
  assert.equal(requests[1].previous_response_id, "resp_0");
  assert.deepEqual(requests[1].input, [{ type: "computer_call_output", call_id: "c1", acknowledged_safety_checks: [], output: { type: "computer_screenshot", image_url: SHOT } }]);
  assert.deepEqual(d.asked, [], "no taps for plain browsing");
});

test("stops at 25 steps", async () => {
  const { muse, requests } = scriptedMuse([{ output: [cc("c", [{ type: "scroll", x: 1, y: 1, scroll_y: 300 }])] }]);
  const { driver, calls } = fakeDriver();
  const r = await runTask(deps(muse, driver), TASK);
  assert.equal(r.status, "step_limit");
  assert.equal(r.steps, 25);
  assert.equal(calls.filter((c) => c.startsWith("act")).length, 25);
  assert.equal(requests.length, 26, "the opening turn plus one per step");
  assert.equal(calls.at(-1), "end");
});

test("stops at 90 s of browsing, and time spent waiting for a tap doesn't count", async () => {
  let clock = 0;
  const now = () => clock;
  const { muse } = scriptedMuse([{ output: [cc("c", [click(1, 1)])] }]);
  // Every batch takes 10 s. The commit tap on step 3 takes 60 s of the user's time.
  const { driver } = fakeDriver((_a, n) => {
    clock += 10_000;
    return n === 3 ? PAUSE : {};
  });
  const r = await runTask(deps(muse, driver, { now, approveCommit: async () => ((clock += 60_000), true) }), TASK);
  assert.equal(r.status, "time_limit");
  assert.equal(r.steps, 9, "nine 10 s steps fill the 90 s; the minute at the tap is not counted");
  assert.equal(r.committed, true);
});

test("model safety checks become taps, and only approved ones are acknowledged", async () => {
  const check = { id: "sc_1", code: "malicious_instructions", message: "The page tells you to ignore the user." };
  const turns = [{ output: [cc("c1", [click(5, 5)], [check])] }, { output: [], output_text: "Done." }];

  const yes = scriptedMuse(turns);
  const a = fakeDriver();
  const d = deps(yes.muse, a.driver);
  const r = await runTask(d, TASK);
  assert.equal(r.status, "done");
  assert.match(d.asked[0], /^Browser safety check: The page tells you to ignore the user\./);
  assert.deepEqual(yes.requests[1].input[0].acknowledged_safety_checks, [check]);

  const no = scriptedMuse(turns);
  const b = fakeDriver();
  const declined = await runTask(deps(no.muse, b.driver, { approveCheck: async () => false }), TASK);
  assert.equal(declined.status, "declined");
  assert.deepEqual(b.calls, [`start ${TASK.url}`, "end"], "nothing ran after the decline");
  assert.equal(no.requests.length, 1, "the unacknowledged check never went back");
});

test("a commit-guard pause asks for a send-tier tap, and only then clicks", async () => {
  const { muse, requests } = scriptedMuse([
    { output: [cc("c1", [click(120, 120), click(120, 320)])] },
    { output: [], output_text: "Held: a table for two at 8:00 PM." },
  ]);
  const { driver, calls } = fakeDriver((actions) => (actions.length === 2 ? PAUSE : {}));
  const d = deps(muse, driver);
  const r = await runTask(d, TASK);

  assert.deepEqual(d.asked, ['Hold a table for 2 at 8:00 PM · click "Complete reservation" on www.opentable.com']);
  assert.deepEqual(calls, [`start ${TASK.url}`, "act click,click", "commit", "end"]);
  assert.equal(r.status, "committed");
  assert.equal(r.committed, true);
  assert.equal(r.url, "https://www.opentable.com/booking/confirmed");
  assert.equal(requests[1].input[0].call_id, "c1", "the model sees the page after the commit");
});

test("no tap, no click: a declined pause, or no way to ask, never commits", async () => {
  for (const approveCommit of [async () => false, undefined]) {
    const { muse } = scriptedMuse([{ output: [cc("c1", [click(120, 320)])] }]);
    const { driver, calls } = fakeDriver(() => PAUSE);
    const r = await runTask(deps(muse, driver, { approveCommit }), TASK);
    assert.equal(r.status, "declined");
    assert.equal(r.committed, false);
    assert.equal(calls.includes("commit"), false);
    assert.equal(calls.at(-1), "end");
  }
});

test("frames go to the timeline: the opening page, the pause, and every step", async () => {
  const { muse } = scriptedMuse([
    { output: [cc("c1", [click(120, 120)])] },
    { output: [cc("c2", [click(120, 320)])] },
    { output: [], output_text: "Held." },
  ]);
  const { driver } = fakeDriver((_a, n) => (n === 2 ? PAUSE : {}));
  const d = deps(muse, driver);
  await runTask(d, TASK);
  const frames = d.log.since("s").filter((e) => e.kind === "browser_frame");
  assert.deepEqual(frames.map((f) => [f.data.step, f.data.status]), [[0, "ok"], [1, "ok"], [2, "paused"], [2, "ok"]]);
  assert.equal(frames[0].data.frame, FRAME);
  assert.equal(frames[0].data.host, "www.opentable.com");
  assert.equal(frames[0].data.screenshot, undefined, "the full screenshot stays out of the log");
});

test("a CAPTCHA ends the run and says so", async () => {
  const { muse } = scriptedMuse([{ output: [cc("c1", [click(1, 1)])] }]);
  const { driver, calls } = fakeDriver(() => ({ status: "stopped", stopped: { reason: "captcha", detail: "A CAPTCHA is on the page." } }));
  const r = await runTask(deps(muse, driver), TASK);
  assert.equal(r.status, "stopped");
  assert.match(r.reason ?? "", /CAPTCHA.*never solves one/);
  assert.equal(calls.at(-1), "end");
});

test("each browser step lands in the outbound ledger, with typed bytes but no contents", async () => {
  const ledger = new Ledger();
  const { muse } = scriptedMuse([{ output: [cc("c1", [{ type: "type", text: "Santana Row" }])] }, { output: [], output_text: "ok" }]);
  const { driver } = fakeDriver();
  await runTask(deps(muse, driver, { ledger }), TASK);
  const rows = ledger.list().reverse();
  assert.deepEqual(rows.map((r) => [r.service, r.operation, r.bytesOut]), [
    ["Web (browser)", "open www.opentable.com", 0],
    ["Web (browser)", "type www.opentable.com", 11],
  ]);
});
