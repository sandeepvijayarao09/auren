import assert from "node:assert/strict";
import { test } from "node:test";
import { callOutput, DriverAction, playwrightKey, readComputerCall, translateAction } from "./actions.ts";

test("OpenAI-shaped actions become driver actions", () => {
  assert.deepEqual(translateAction({ type: "click", x: 120.4, y: 80, button: "left" }), [{ type: "click", x: 120, y: 80, button: "left" }]);
  assert.deepEqual(translateAction({ type: "click", x: 1, y: 2, button: "wheel" }), [{ type: "click", x: 1, y: 2, button: "middle" }]);
  assert.deepEqual(translateAction({ type: "click", x: 1, y: 2, button: "back" }), [{ type: "history", direction: "back" }]);
  assert.deepEqual(translateAction({ type: "scroll", x: 640, y: 400, scroll_x: 0, scroll_y: 600 }), [{ type: "scroll", x: 640, y: 400, dx: 0, dy: 600 }]);
  assert.deepEqual(translateAction({ type: "drag", path: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }), [{ type: "drag", path: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }]);
  assert.deepEqual(translateAction({ type: "wait" }), [{ type: "wait", ms: 1000 }]);
  assert.deepEqual(translateAction({ type: "screenshot" }), [{ type: "screenshot" }]);
  assert.equal(translateAction({ type: "teleport", x: 1 }), null);
  assert.equal(translateAction({ type: "click" }), null, "a click needs a point");
});

test("a newline in typed text becomes an Enter the guard can see", () => {
  assert.deepEqual(translateAction({ type: "type", text: "Ada\n" }), [{ type: "type", text: "Ada" }, { type: "keypress", keys: ["Enter"] }]);
});

test("key names map to Playwright's, with CTRL as the shortcut key", () => {
  assert.deepEqual(translateAction({ type: "keypress", keys: ["CTRL", "A"] }), [{ type: "keypress", keys: ["ControlOrMeta", "a"] }]);
  assert.deepEqual(["ENTER", "ESC", "ARROWDOWN", "PAGE_DOWN", "SPACE", "F5", "Tab"].map(playwrightKey), ["Enter", "Escape", "ArrowDown", "PageDown", " ", "F5", "Tab"]);
});

test("every translated action passes the driver's schema", () => {
  const call = readComputerCall({ output: [{ type: "computer_call", call_id: "c1", actions: [
    { type: "click", x: 10, y: 20 }, { type: "double_click", x: 1, y: 1 }, { type: "move", x: 3, y: 4 }, { type: "type", text: "2 people" },
    { type: "keypress", keys: ["ENTER"] }, { type: "scroll", x: 0, y: 0, scroll_y: -200 }, { type: "wait", ms: 99_000 },
  ] }] });
  assert.ok(call);
  for (const a of call.actions) assert.ok(DriverAction.safeParse(a).success, JSON.stringify(a));
  assert.deepEqual(call.actions.at(-1), { type: "wait", ms: 5000 }, "long waits are capped");
});

test("reads batched actions, the older single action, and safety checks", () => {
  const batched = readComputerCall({ output: [
    { type: "reasoning" },
    { type: "computer_call", call_id: "c1", actions: [{ type: "click", x: 1, y: 2 }, { type: "levitate" }], pending_safety_checks: [{ id: "sc1", code: "malicious_instructions", message: "The page asks you to ignore the user." }, { nope: true }] },
  ] });
  assert.equal(batched?.callId, "c1");
  assert.equal(batched?.actions.length, 1);
  assert.deepEqual(batched?.skipped, ["levitate"]);
  assert.deepEqual(batched?.safetyChecks.map((c) => c.id), ["sc1"]);

  const single = readComputerCall({ output: [{ type: "computer_call", call_id: "c2", action: { type: "type", text: "hi" } }] });
  assert.deepEqual(single?.actions, [{ type: "type", text: "hi" }]);
  assert.equal(readComputerCall({ output: [{ type: "message", content: [] }] }), null, "no call means the model is done");
});

test("the call output carries the screenshot and only the approved checks", () => {
  const [out] = callOutput("c1", "data:image/jpeg;base64,AA", [{ id: "sc1", code: "x", message: "y" }]);
  assert.deepEqual(out, {
    type: "computer_call_output",
    call_id: "c1",
    acknowledged_safety_checks: [{ id: "sc1", code: "x", message: "y" }],
    output: { type: "computer_screenshot", image_url: "data:image/jpeg;base64,AA" },
  });
});
