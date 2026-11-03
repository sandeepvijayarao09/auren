// Runs Core's computer actions in a real Chromium page, with the commit guard in
// front of every click. Before a click (or an Enter or Space that could submit),
// it reads the element there, its role and accessible name, and asks checkClick.
// A commit-like target pauses the run until Core sends `commit` after a tap.
// A CAPTCHA, or a page off the allowlist, stops the run.
import type { Browser, BrowserContext, CDPSession, Frame, Page } from "playwright";
import { thumbnail } from "./frame.ts";
import { checkClick, seesCaptcha, type ClickTarget } from "./guard.ts";
import type { Action, StepResult } from "./protocol.ts";

export interface ExecutorOptions {
  /** Hosts the browser may open. Subdomains count: "opentable.com" allows www.opentable.com. */
  allow: string[];
  viewport?: { width: number; height: number };
  /** How long the page settles after actions, before the screenshot. */
  settleMs?: number;
}

/** True when the URL is http(s) and its host is on the allowlist. */
export function isAllowed(url: string, allow: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => {
    const e = entry.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^\*\./, "").replace(/[:/].*$/, "");
    return Boolean(e) && (host === e || host.endsWith(`.${e}`));
  });
}

const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

// Roles worth stopping at while walking up from the exact node under the pointer.
const INTERACTIVE = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "checkbox", "radio", "switch", "tab", "combobox", "textbox", "searchbox", "listbox", "slider", "spinbutton"]);
const FRAME_WIDTH = 400;

/** What `inspect` saw. `frame` means the hit was an iframe, whose content starts `inset` px inside its box. */
type Seen = { role: string; name: string; text: string; pointer?: boolean; frame?: { x: number; y: number } };
type Gate = { stop: false } | { stop: true; reason: string; target: ClickTarget };
/** `opaque`: the point is inside an iframe the driver couldn't see into. */
type Target = ClickTarget & { opaque?: boolean };

/**
 * Runs inside the page. With a point: the element there (or its nearest control).
 * Without: the focused element, plus its form's submit button, since Enter submits.
 * An iframe in either place is reported as such, so the caller looks inside it.
 * One self-contained function, because Playwright sends it to the page as source.
 */
function inspect(at: { x: number; y: number } | null): Seen[] {
  const CONTROL = "button, a[href], input, select, textarea, summary, option, [role=button], [role=link], [role=menuitem], [role=option], [role=checkbox], [role=radio], [role=switch], [role=tab]";
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const roleOf = (n: Element): string => {
    const explicit = n.getAttribute("role");
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = n.tagName;
    if (tag === "A") return n.hasAttribute("href") ? "link" : "generic";
    if (tag === "INPUT") {
      const t = ((n as HTMLInputElement).type || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(t)) return "button";
      return t === "checkbox" || t === "radio" ? t : "textbox";
    }
    return ({ BUTTON: "button", SUMMARY: "button", SELECT: "combobox", TEXTAREA: "textbox", OPTION: "option" } as Record<string, string>)[tag] ?? "generic";
  };
  const nameOf = (n: Element): string => {
    const by = n.getAttribute("aria-labelledby");
    const labelled = by ? by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "").join(" ") : "";
    const input = n.tagName === "INPUT" ? (n as HTMLInputElement).value || n.getAttribute("alt") : "";
    return clean(n.getAttribute("aria-label") || labelled || input || (n as HTMLElement).innerText || n.getAttribute("title"));
  };
  const describe = (n: Element): Seen => ({ role: roleOf(n), name: nameOf(n), text: clean((n as HTMLElement).innerText) });

  if (at) {
    const el = document.elementFromPoint(at.x, at.y);
    if (!el) return [];
    if (el.tagName === "IFRAME" || el.tagName === "FRAME") return [{ ...describe(el), frame: { x: el.clientLeft, y: el.clientTop } }];
    let pointer = false;
    for (let n: Element | null = el, i = 0; n && i < 5; n = n.parentElement, i++) {
      if (n.hasAttribute("onclick") || getComputedStyle(n).cursor === "pointer") {
        pointer = true;
        break;
      }
    }
    return [{ ...describe(el.closest(CONTROL) ?? el), pointer }];
  }
  const el = document.activeElement;
  if (!el || el === document.body) return [];
  if (el.tagName === "IFRAME" || el.tagName === "FRAME") return [{ ...describe(el), frame: { x: 0, y: 0 } }];
  const out = [describe(el)];
  const form = (el as HTMLInputElement).form ?? el.closest("form");
  if (form && roleOf(el) !== "button") {
    const submit = form.querySelector('button[type="submit"], button:not([type]), input[type="submit"], input[type="image"]');
    if (submit) out.push(describe(submit));
  }
  return out;
}

export class Executor {
  #browser: Browser;
  #allow: string[];
  #viewport: { width: number; height: number };
  #settleMs: number;
  #context: BrowserContext | null = null;
  #page: Page | null = null;
  #cdp = new WeakMap<Page, CDPSession>();
  /** The click or key the guard stopped, waiting for Core's `commit`. */
  #pending: { action: Action; target: ClickTarget } | null = null;
  /** A main-frame navigation the allowlist refused during this task. */
  #blocked: string | null = null;

  constructor(browser: Browser, opts: ExecutorOptions) {
    this.#browser = browser;
    this.#allow = opts.allow;
    this.#viewport = opts.viewport ?? { width: 1280, height: 800 };
    this.#settleMs = opts.settleMs ?? 400;
  }

  /** A new task: a fresh context (no cookies, passwords or cards), opened at `url`. */
  async start(url: string): Promise<StepResult> {
    this.#pending = null;
    this.#blocked = null;
    if (!isAllowed(url, this.#allow)) {
      return { status: "stopped", url, title: "", stopped: { reason: "blocked", detail: `${hostOf(url) || url} isn't on the driver's allowlist.` } };
    }
    await this.#context?.close().catch(() => {});
    const context = await this.#browser.newContext({ viewport: this.#viewport, deviceScaleFactor: 1, acceptDownloads: false, serviceWorkers: "block" });
    this.#context = context;
    // Only top-level navigations are held to the allowlist; a page's own images,
    // scripts and frames load as usual (which is also how a CAPTCHA frame shows up).
    await context.route("**/*", (route) => {
      const req = route.request();
      let topLevel = false;
      try {
        topLevel = req.isNavigationRequest() && req.frame().parentFrame() === null;
      } catch {
        // Service-worker requests have no frame; they're blocked for the context anyway.
      }
      if (topLevel && !isAllowed(req.url(), this.#allow)) {
        this.#blocked = hostOf(req.url()) || req.url().slice(0, 80);
        return route.abort("blockedbyclient");
      }
      return route.continue();
    });
    context.on("page", (p) => this.#adopt(p));
    const page = await context.newPage();
    this.#adopt(page);
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch (err) {
      if (!this.#blocked) return this.#snapshot({ status: "error", error: `Couldn't open ${hostOf(url)}: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` });
    }
    return this.#snapshot();
  }

  /** Runs one batch. Stops early at the guard, a blocked navigation or a closed window. */
  async run(actions: Action[]): Promise<StepResult> {
    if (!this.#page) return this.#error("No task is open.");
    this.#pending = null;
    for (const a of expand(actions)) {
      const gate = await this.#guard(a);
      if (gate.stop) {
        this.#pending = { action: a, target: gate.target };
        return this.#snapshot({ status: "paused", paused: { reason: gate.reason, role: gate.target.role, name: gate.target.name || gate.target.text || "" } });
      }
      await this.#perform(a);
      if (this.#blocked || !this.#page || this.#page.isClosed()) break;
    }
    return this.#snapshot();
  }

  /** The user tapped Approve: perform exactly the paused click or key, if it's still there. */
  async commit(): Promise<StepResult> {
    const held = this.#pending;
    this.#pending = null;
    if (!held) return this.#error("Nothing is waiting for approval.");
    const now = await this.#guard(held.action);
    if (!now.stop || now.target.role !== held.target.role || now.target.name !== held.target.name) {
      return this.#snapshot({ status: "error", error: "The page changed while waiting for your tap, so Auren didn't click." });
    }
    await this.#perform(held.action);
    return this.#snapshot();
  }

  /** The task is over. The window stays open so you can see where it ended. */
  async end(): Promise<StepResult> {
    this.#pending = null;
    const page = this.#page;
    return { status: "ok", url: page && !page.isClosed() ? page.url() : "", title: page && !page.isClosed() ? await page.title().catch(() => "") : "" };
  }

  async close(): Promise<void> {
    await this.#context?.close().catch(() => {});
    this.#context = null;
    this.#page = null;
  }

  // ── internals ──────────────────────────────────────────────────────────

  #adopt(p: Page): void {
    // A popup becomes the page Auren sees; when it closes, the last open page does.
    this.#page = p;
    p.on("close", () => {
      if (this.#page === p) this.#page = this.#context?.pages().at(-1) ?? null;
    });
  }

  async #guard(a: Action): Promise<Gate> {
    if (a.type === "click" || a.type === "double_click") return this.#check(await this.#targetAt(a.x, a.y));
    if (a.type === "drag") {
      const end = a.path[a.path.length - 1];
      return this.#check(await this.#targetAt(end.x, end.y));
    }
    if (a.type === "keypress" && a.keys.some((k) => k === "Enter" || k === " " || k === "Space")) {
      for (const target of await this.#focusTargets()) {
        const gate = this.#check(target);
        if (gate.stop) return gate;
      }
    }
    return { stop: false };
  }

  #check(target: Target): Gate {
    // Fail closed: a click Auren can't see the target of waits for a tap like a commit.
    if (target.opaque) return { stop: true, reason: "a click inside an embedded frame Auren can't read", target };
    const verdict = checkClick(target);
    return verdict.stop ? { stop: true, reason: verdict.reason, target } : { stop: false };
  }

  /** The element under the pointer: role and accessible name from Chromium's accessibility tree, with the DOM as a fallback. */
  async #targetAt(x: number, y: number): Promise<Target> {
    const page = this.#active();
    // Walk into iframes under the point, so an embedded widget from another site gets the same check.
    let frame: Frame = page.mainFrame();
    let local = { x, y };
    let dom: Seen | undefined;
    let opaque = false;
    for (let depth = 0; depth < 5; depth++) {
      const read = await frame.evaluate(inspect, local).catch(() => null);
      // A frame Auren went into but can't read is opaque, not empty.
      if (!read) {
        opaque = frame !== page.mainFrame();
        break;
      }
      dom = read[0];
      if (!dom?.frame) break;
      const child = await childFrameAt(frame, x, y);
      if (!child) break;
      frame = child.frame;
      local = { x: Math.round(x - child.box.x - dom.frame.x), y: Math.round(y - child.box.y - dom.frame.y) };
    }
    const ax = frame === page.mainFrame() ? await this.#axAt(page, x, y).catch(() => null) : null;
    let role = ax?.role || dom?.role || "generic";
    // Something styled as clickable counts as a button, so a bare <div onclick> can't slip past.
    if (!INTERACTIVE.has(role) && dom?.pointer) role = "button";
    return { role, name: ax?.name || dom?.name || "", text: dom?.text || undefined, url: frame.url() || page.url(), opaque: opaque || Boolean(dom?.frame) };
  }

  async #axAt(page: Page, x: number, y: number): Promise<{ role: string; name: string } | null> {
    const cdp = await this.#cdpFor(page);
    const { backendNodeId } = await cdp.send("DOM.getNodeForLocation", { x, y, ignorePointerEventsNone: true });
    const { nodes } = await cdp.send("Accessibility.getPartialAXTree", { backendNodeId, fetchRelatives: true });
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    let node = nodes.find((n) => n.backendDOMNodeId === backendNodeId);
    for (let i = 0; node && i < 12; i++) {
      const role = String(node.role?.value ?? "");
      if (INTERACTIVE.has(role)) return { role, name: String(node.name?.value ?? "") };
      node = node.parentId ? byId.get(node.parentId) : undefined;
    }
    return null;
  }

  async #focusTargets(): Promise<Target[]> {
    const page = this.#active();
    let frame: Frame = page.mainFrame();
    let seen: Seen[] = [];
    for (let depth = 0; depth < 5; depth++) {
      seen = await frame.evaluate(inspect, null).catch(() => [] as Seen[]);
      if (!seen[0]?.frame) break;
      // Focus is inside an iframe: follow it to the frame that has it.
      let next: Frame | undefined;
      for (const child of frame.childFrames()) if (await child.evaluate(() => document.hasFocus()).catch(() => false)) next = child;
      if (!next) break;
      frame = next;
    }
    return seen.map((s) => ({ role: s.role, name: s.name, text: s.text || undefined, url: frame.url() || page.url(), opaque: Boolean(s.frame) }));
  }

  async #perform(a: Action): Promise<void> {
    const page = this.#active();
    switch (a.type) {
      case "click":
        await page.mouse.click(a.x, a.y, { button: a.button });
        break;
      case "double_click":
        await page.mouse.dblclick(a.x, a.y);
        break;
      case "move":
        await page.mouse.move(a.x, a.y);
        break;
      case "drag":
        await page.mouse.move(a.path[0].x, a.path[0].y);
        await page.mouse.down();
        for (const p of a.path.slice(1)) await page.mouse.move(p.x, p.y, { steps: 4 });
        await page.mouse.up();
        break;
      case "scroll":
        await page.mouse.move(a.x, a.y);
        await page.mouse.wheel(a.dx, a.dy);
        break;
      case "type":
        await page.keyboard.type(a.text);
        break;
      case "keypress":
        await page.keyboard.press(a.keys.join("+"));
        break;
      case "history":
        await (a.direction === "back" ? page.goBack({ timeout: 10_000 }) : page.goForward({ timeout: 10_000 })).catch(() => null);
        break;
      case "wait":
        await page.waitForTimeout(a.ms);
        break;
      case "screenshot":
        break;
    }
    if (a.type === "click" || a.type === "double_click" || a.type === "keypress") {
      await this.#active().waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    }
  }

  #active(): Page {
    if (!this.#page || this.#page.isClosed()) throw new Error("The browser window was closed.");
    return this.#page;
  }

  async #cdpFor(page: Page): Promise<CDPSession> {
    let s = this.#cdp.get(page);
    if (!s) {
      s = await page.context().newCDPSession(page);
      this.#cdp.set(page, s);
    }
    return s;
  }

  async #snapshot(extra: Partial<StepResult> = {}): Promise<StepResult> {
    const page = this.#page;
    if (!page || page.isClosed()) return { status: "stopped", url: "", title: "", stopped: { reason: "closed", detail: "The browser window was closed." } };
    await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(this.#settleMs);
    const shot = await page.screenshot({ type: "jpeg", quality: 75, timeout: 10_000 });
    let frame: string | undefined;
    try {
      frame = `data:image/jpeg;base64,${thumbnail(shot, FRAME_WIDTH).toString("base64")}`;
    } catch {
      // A missing frame only costs the timeline a picture.
    }
    const base = { url: page.url(), title: await page.title().catch(() => ""), screenshot: `data:image/jpeg;base64,${shot.toString("base64")}`, frame };
    if (this.#blocked) return { ...base, status: "stopped", stopped: { reason: "blocked", detail: `${this.#blocked} isn't on the driver's allowlist.` } };
    const text = await page.evaluate(() => document.body?.innerText.slice(0, 50_000) ?? "").catch(() => "");
    if (seesCaptcha({ frameUrls: page.frames().map((f) => f.url()), text })) {
      return { ...base, status: "stopped", stopped: { reason: "captcha", detail: "A CAPTCHA is on the page. Auren never solves one." } };
    }
    return { status: "ok", ...base, ...extra };
  }

  #error(message: string): StepResult {
    const page = this.#page && !this.#page.isClosed() ? this.#page : null;
    return { status: "error", url: page?.url() ?? "", title: "", error: message };
  }
}

/** The child frame whose box (in main-viewport coordinates) holds the point. */
async function childFrameAt(frame: Frame, x: number, y: number): Promise<{ frame: Frame; box: { x: number; y: number } } | null> {
  for (const child of frame.childFrames()) {
    const box = await (await child.frameElement().catch(() => null))?.boundingBox().catch(() => null);
    if (box && x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height) return { frame: child, box };
  }
  return null;
}

/** A newline in typed text is an Enter, which can submit, so it goes through the keypress guard. */
function expand(actions: Action[]): Action[] {
  return actions.flatMap((a): Action[] => {
    if (a.type !== "type" || !/[\r\n]/.test(a.text)) return [a];
    const out: Action[] = [];
    a.text.split(/\r?\n/).forEach((line, i) => {
      if (i > 0) out.push({ type: "keypress", keys: ["Enter"] });
      if (line) out.push({ type: "type", text: line });
    });
    return out;
  });
}
