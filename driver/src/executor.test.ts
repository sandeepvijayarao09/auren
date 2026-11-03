// The executor against real Chromium and a static page served in-process, so the
// "Complete reservation" button really pauses and nothing commits without `commit`.
// Skipped where Chromium isn't installed (`npx playwright install chromium`).
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser } from "playwright";
import { decode, encode } from "jpeg-js";
import { Executor, isAllowed } from "./executor.ts";
import { thumbnail } from "./frame.ts";

const at = (left: number, top: number) => `position:absolute;left:${left}px;top:${top}px;width:200px;height:40px`;
const PAGES: Record<string, string> = {
  "/r/demo-bistro": `<!doctype html><meta charset="utf-8"><title>Demo Bistro</title>
<body style="margin:0;font:16px sans-serif">
<button style="${at(20, 100)}" onclick="document.body.dataset.time='20:00'">8:00 PM</button>
<button style="${at(20, 400)}" onclick="setTimeout(() => document.getElementById('go').textContent = 'Cancel reservation', 1500)">Arm</button>
<form onsubmit="event.preventDefault(); document.body.dataset.done = 'form'">
  <input aria-label="Name" style="${at(20, 200)};height:30px">
  <button id="go" type="submit" style="${at(20, 300)}">Complete reservation</button>
</form>
<div style="${at(300, 100)};cursor:pointer" onclick="document.body.dataset.done = 'div'">Confirm booking</div>
<a href="http://not-allowed.test/elsewhere" style="${at(300, 200)}">Elsewhere</a>
</body>`,
  "/captcha": `<!doctype html><title>Check</title><p>Before you continue, please confirm: I'm not a robot</p>`,
  // A booking widget embedded from another site, the way many restaurant pages do it.
  "/widget": `<!doctype html><body style="margin:0"><button style="${at(10, 10)}" onclick="parent.postMessage('done', '*')">Complete reservation</button>
<button style="${at(10, 60)}">Choose 8:00 PM</button></body>`,
};
const embedding = (src: string) => `<!doctype html><title>Embedded</title><body style="margin:0">
<script>addEventListener("message", (e) => (document.body.dataset.done = e.data))</script>
<iframe src="${src}" style="position:absolute;left:100px;top:100px;width:400px;height:200px;border:2px solid #000"></iframe></body>`;

const executable = chromium.executablePath();
const skip = existsSync(executable) ? false : `Chromium isn't installed at ${executable}`;

describe("executor", { skip }, () => {
  let browser: Browser;
  let ex: Executor;
  let base = "";
  const http = createServer((req, res) => {
    const port = (http.address() as AddressInfo).port;
    const body = req.url === "/embed/same" ? embedding("/widget") : req.url === "/embed/cross" ? embedding(`http://localhost:${port}/widget`) : PAGES[req.url ?? ""];
    res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" });
    res.end(body ?? "not found");
  });
  // A screenshot-only batch: no input reaches the page.
  const state = async () => {
    const r = await ex.run([{ type: "screenshot" }]);
    assert.equal(r.status, "ok");
    return r;
  };

  before(async () => {
    await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
    browser = await chromium.launch({ headless: true });
    ex = new Executor(browser, { allow: ["127.0.0.1"], settleMs: 50 });
  });
  after(async () => {
    await ex?.close();
    await browser?.close();
    http.close();
  });

  const datasetOf = async (key: string, b: Browser) => {
    // The page is the executor's; peek at it through Playwright's context list.
    const page = b.contexts()[0].pages().at(-1)!;
    return page.evaluate((k) => document.body.dataset[k] ?? null, key);
  };
  const dataset = (key: string) => datasetOf(key, browser);

  test("opens an allowed page with a screenshot for the model and a small frame for the timeline", async () => {
    const r = await ex.start(`${base}/r/demo-bistro`);
    assert.equal(r.status, "ok");
    assert.equal(r.title, "Demo Bistro");
    assert.match(r.screenshot ?? "", /^data:image\/jpeg;base64,/);
    assert.match(r.frame ?? "", /^data:image\/jpeg;base64,/);
    assert.ok((r.frame ?? "").length < 200_000, `frame is ${r.frame?.length} chars`);
    assert.ok((r.frame ?? "").length < (r.screenshot ?? "").length, "the frame is smaller than the screenshot");
  });

  test("an ordinary click goes straight through", async () => {
    await ex.start(`${base}/r/demo-bistro`);
    const r = await ex.run([{ type: "click", x: 120, y: 120, button: "left" }]);
    assert.equal(r.status, "ok");
    assert.equal(await dataset("time"), "20:00");
  });

  test("Complete reservation pauses, and only commit clicks it", async () => {
    await ex.start(`${base}/r/demo-bistro`);
    const r = await ex.run([{ type: "click", x: 120, y: 120, button: "left" }, { type: "click", x: 120, y: 320, button: "left" }]);
    assert.equal(r.status, "paused");
    assert.deepEqual([r.paused?.role, r.paused?.name], ["button", "Complete reservation"]);
    assert.match(r.screenshot ?? "", /^data:image\/jpeg/, "a paused step still shows the page");
    assert.equal(await dataset("time"), "20:00", "actions before the commit ran");
    assert.equal(await dataset("done"), null, "nothing submitted yet");
    const done = await ex.commit();
    assert.equal(done.status, "ok");
    assert.equal(await dataset("done"), "form");
  });

  test("Enter in a form whose submit button commits pauses too, including a newline in typed text", async () => {
    await ex.start(`${base}/r/demo-bistro`);
    const enter = await ex.run([{ type: "click", x: 120, y: 215, button: "left" }, { type: "type", text: "Ada" }, { type: "keypress", keys: ["Enter"] }]);
    assert.equal(enter.status, "paused");
    assert.equal(enter.paused?.name, "Complete reservation");
    await ex.end();
    assert.equal((await ex.commit()).status, "error", "ending the task drops the paused key");
    const typed = await ex.run([{ type: "click", x: 120, y: 215, button: "left" }, { type: "type", text: "Lovelace\n" }]);
    assert.equal(typed.status, "paused");
    assert.equal(await dataset("done"), null);
  });

  test("a bare div styled as clickable still counts as a button", async () => {
    await ex.start(`${base}/r/demo-bistro`);
    const r = await ex.run([{ type: "click", x: 400, y: 120, button: "left" }]);
    assert.equal(r.status, "paused");
    assert.equal(r.paused?.name, "Confirm booking");
    assert.equal(await dataset("done"), null);
  });

  test("if the button changes while waiting for the tap, commit refuses to click", async () => {
    await ex.start(`${base}/r/demo-bistro`);
    const r = await ex.run([{ type: "click", x: 120, y: 420, button: "left" }, { type: "click", x: 120, y: 320, button: "left" }]);
    assert.equal(r.status, "paused");
    await new Promise((res) => setTimeout(res, 1600));
    const c = await ex.commit();
    assert.equal(c.status, "error");
    assert.match(c.error ?? "", /page changed/);
    assert.equal(await dataset("done"), null);
  });

  test("a commit button inside an iframe pauses, same-site or embedded from another site", async () => {
    // Site isolation puts the cross-site widget in its own process, where the page's
    // accessibility tree only shows "Iframe", the way real cross-site embeds behave.
    const isolated = await chromium.launch({ headless: true, args: ["--site-per-process"] });
    const ex = new Executor(isolated, { allow: ["127.0.0.1"], settleMs: 50 });
    after(() => isolated.close());
    const dataset = (key: string) => datasetOf(key, isolated);
    for (const path of ["/embed/same", "/embed/cross"]) {
      await ex.start(`${base}${path}`);
      // The widget's top-left is at (102, 102) inside the 2 px border; its first button is 10 px further in.
      const fine = await ex.run([{ type: "click", x: 210, y: 182, button: "left" }]);
      assert.equal(fine.status, "ok", `${path}: an ordinary button in the frame`);
      const r = await ex.run([{ type: "click", x: 210, y: 132, button: "left" }]);
      assert.equal(r.status, "paused", path);
      assert.equal(r.paused?.name, "Complete reservation", path);
      assert.equal(await dataset("done"), null, `${path}: nothing submitted`);
      assert.equal((await ex.commit()).status, "ok");
      for (let i = 0; i < 40 && (await dataset("done")) === null; i++) await new Promise((res) => setTimeout(res, 50));
      assert.equal(await dataset("done"), "done", `${path}: the approved click went through`);
    }
  });

  test("a link off the allowlist stops the run", async () => {
    await ex.start(`${base}/r/demo-bistro`);
    const r = await ex.run([{ type: "click", x: 320, y: 205, button: "left" }]);
    assert.equal(r.status, "stopped");
    assert.equal(r.stopped?.reason, "blocked");
    assert.match(r.stopped?.detail ?? "", /not-allowed\.test/);
  });

  test("a start URL off the allowlist never opens", async () => {
    const r = await ex.start("https://example.com/");
    assert.equal(r.status, "stopped");
    assert.equal(r.stopped?.reason, "blocked");
    assert.equal(r.screenshot, undefined);
  });

  test("a CAPTCHA stops the run", async () => {
    const r = await ex.start(`${base}/captcha`);
    assert.equal(r.status, "stopped");
    assert.equal(r.stopped?.reason, "captcha");
    assert.match(r.frame ?? "", /^data:image\/jpeg/, "the timeline still shows what stopped it");
  });

  test("screenshot-only batches change nothing", async () => {
    await ex.start(`${base}/r/demo-bistro`);
    const r = await state();
    assert.equal(r.title, "Demo Bistro");
  });
});

test("timeline frames are the screenshot shrunk to 400 px wide", () => {
  const w = 1280;
  const h = 800;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([i % w < w / 2 ? 200 : 20, 120, 60, 255], i * 4);
  const shot = encode({ data, width: w, height: h }, 75).data;
  const small = decode(thumbnail(shot), { useTArray: true });
  assert.deepEqual([small.width, small.height], [400, 250]);
  assert.ok(Math.abs(small.data[0] - 200) < 12 && Math.abs(small.data[(399 + 0) * 4] - 20) < 12, "colours survive the shrink");
});

test("the allowlist matches hosts and their subdomains, over http(s) only", () => {
  const allow = ["opentable.com", "https://resy.com/", "127.0.0.1"];
  assert.equal(isAllowed("https://www.opentable.com/r/x", allow), true);
  assert.equal(isAllowed("https://opentable.com", allow), true);
  assert.equal(isAllowed("https://resy.com/cities/sf", allow), true);
  assert.equal(isAllowed("http://127.0.0.1:5173/", allow), true);
  assert.equal(isAllowed("https://opentable.com.evil.example/", allow), false);
  assert.equal(isAllowed("https://notopentable.com/", allow), false);
  assert.equal(isAllowed("file:///etc/passwd", allow), false);
  assert.equal(isAllowed("javascript:alert(1)", allow), false);
  assert.equal(isAllowed("not a url", allow), false);
});
