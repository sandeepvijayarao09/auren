// Every Muse computer-use shape Auren depends on lives in this one module. Muse's
// exact action shapes aren't verified yet, so this mirrors OpenAI's computer-use
// schema (the batched `actions[]` of the `computer` tool, plus the older single
// `action`). If Muse differs, this is the only file to change.
import { z } from "zod";

/** The tool definition the runner sends. The GA tool takes no parameters. */
export const COMPUTER_TOOL = { type: "computer" } as const;

// ── Driver wire actions: what Core sends the driver over /v1/driver ─────────

const Point = z.object({ x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000) });

export const DriverAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), ...Point.shape, button: z.enum(["left", "right", "middle"]) }),
  z.object({ type: z.literal("double_click"), ...Point.shape }),
  z.object({ type: z.literal("move"), ...Point.shape }),
  z.object({ type: z.literal("drag"), path: z.array(Point).min(2).max(100) }),
  z.object({ type: z.literal("scroll"), ...Point.shape, dx: z.number(), dy: z.number() }),
  z.object({ type: z.literal("type"), text: z.string().max(2000) }),
  /** Playwright key names, pressed together: ["ControlOrMeta", "a"]. */
  z.object({ type: z.literal("keypress"), keys: z.array(z.string().min(1).max(32)).min(1).max(5) }),
  z.object({ type: z.literal("history"), direction: z.enum(["back", "forward"]) }),
  z.object({ type: z.literal("wait"), ms: z.number().int().min(0).max(5000) }),
  z.object({ type: z.literal("screenshot") }),
]);
export type DriverAction = z.infer<typeof DriverAction>;

// ── Muse (OpenAI-shaped) computer actions ───────────────────────────────────

const num = z.coerce.number();
const MuseAction = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: num, y: num, button: z.string().optional() }),
  z.object({ type: z.literal("double_click"), x: num, y: num }),
  z.object({ type: z.literal("move"), x: num, y: num }),
  z.object({ type: z.literal("drag"), path: z.array(z.object({ x: num, y: num })) }),
  z.object({ type: z.literal("scroll"), x: num, y: num, scroll_x: num.optional(), scroll_y: num.optional() }),
  z.object({ type: z.literal("type"), text: z.string() }),
  z.object({ type: z.literal("keypress"), keys: z.array(z.string()) }),
  z.object({ type: z.literal("wait"), ms: num.optional() }),
  z.object({ type: z.literal("screenshot") }),
]);

/** One model-side safety check, passed back verbatim when the user approves it. */
export const SafetyCheck = z.looseObject({ id: z.string(), code: z.string().nullish(), message: z.string().nullish() });
export type SafetyCheck = z.infer<typeof SafetyCheck>;

export interface ComputerCall {
  callId: string;
  actions: DriverAction[];
  /** Actions Auren couldn't translate, by type, so the run can say what it skipped. */
  skipped: string[];
  safetyChecks: SafetyCheck[];
}

// OpenAI-style key names → Playwright. CTRL means "the shortcut key" to a model
// trained on Linux and Windows, so it becomes ControlOrMeta (⌘ on the Mac).
const KEYS: Record<string, string> = {
  CTRL: "ControlOrMeta", CONTROL: "ControlOrMeta", CMD: "Meta", COMMAND: "Meta", META: "Meta", SUPER: "Meta", WIN: "Meta",
  ALT: "Alt", OPTION: "Alt", SHIFT: "Shift",
  ENTER: "Enter", RETURN: "Enter", ESC: "Escape", ESCAPE: "Escape", TAB: "Tab", SPACE: " ",
  BACKSPACE: "Backspace", DELETE: "Delete", DEL: "Delete", INSERT: "Insert",
  UP: "ArrowUp", DOWN: "ArrowDown", LEFT: "ArrowLeft", RIGHT: "ArrowRight",
  ARROWUP: "ArrowUp", ARROWDOWN: "ArrowDown", ARROWLEFT: "ArrowLeft", ARROWRIGHT: "ArrowRight",
  HOME: "Home", END: "End", PAGEUP: "PageUp", PAGEDOWN: "PageDown", PGUP: "PageUp", PGDN: "PageDown",
};

export function playwrightKey(key: string): string {
  const k = key.trim();
  const mapped = KEYS[k.toUpperCase().replace(/[\s_-]/g, "")];
  if (mapped) return mapped;
  if (/^F([1-9]|1[0-2])$/i.test(k)) return k.toUpperCase();
  return k.length === 1 ? k.toLowerCase() : k;
}

const px = (n: number) => Math.max(0, Math.round(n));

/** Translates one Muse action into driver actions. Returns null for shapes Auren doesn't know. */
export function translateAction(raw: unknown): DriverAction[] | null {
  const parsed = MuseAction.safeParse(raw);
  if (!parsed.success) return null;
  const a = parsed.data;
  switch (a.type) {
    case "click": {
      const button = (a.button ?? "left").toLowerCase();
      if (button === "back" || button === "forward") return [{ type: "history", direction: button }];
      const b = button === "right" ? "right" : button === "wheel" || button === "middle" ? "middle" : "left";
      return [{ type: "click", x: px(a.x), y: px(a.y), button: b }];
    }
    case "double_click":
      return [{ type: "double_click", x: px(a.x), y: px(a.y) }];
    case "move":
      return [{ type: "move", x: px(a.x), y: px(a.y) }];
    case "drag":
      return a.path.length >= 2 ? [{ type: "drag", path: a.path.map((p) => ({ x: px(p.x), y: px(p.y) })) }] : null;
    case "scroll":
      return [{ type: "scroll", x: px(a.x), y: px(a.y), dx: a.scroll_x ?? 0, dy: a.scroll_y ?? 0 }];
    case "type": {
      // A newline is an Enter key, which can submit a form, so it goes through the
      // keypress guard instead of hiding inside typed text. (The driver splits too.)
      const out: DriverAction[] = [];
      a.text.split(/\r?\n/).forEach((line, i) => {
        if (i > 0) out.push({ type: "keypress", keys: ["Enter"] });
        if (line) out.push({ type: "type", text: line });
      });
      return out;
    }
    case "keypress":
      return a.keys.length ? [{ type: "keypress", keys: a.keys.map(playwrightKey) }] : null;
    case "wait":
      return [{ type: "wait", ms: Math.min(5000, px(a.ms ?? 1000)) }];
    case "screenshot":
      return [{ type: "screenshot" }];
  }
}

/** The first `computer_call` in a response, translated, or null when the model is done. */
export function readComputerCall(resp: { output?: unknown[] } | undefined): ComputerCall | null {
  const item = (resp?.output ?? []).find((o) => (o as { type?: string })?.type === "computer_call") as
    | { call_id?: string; id?: string; actions?: unknown[]; action?: unknown; pending_safety_checks?: unknown[] }
    | undefined;
  if (!item) return null;
  const raw = Array.isArray(item.actions) ? item.actions : item.action ? [item.action] : [];
  const actions: DriverAction[] = [];
  const skipped: string[] = [];
  for (const r of raw) {
    const t = translateAction(r);
    if (t) actions.push(...t);
    else skipped.push(String((r as { type?: unknown })?.type ?? "unknown"));
  }
  const safetyChecks = (item.pending_safety_checks ?? []).flatMap((c) => {
    const p = SafetyCheck.safeParse(c);
    return p.success ? [p.data] : [];
  });
  return { callId: String(item.call_id ?? item.id ?? ""), actions, skipped, safetyChecks };
}

/** The first turn: the goal and the opening screenshot. */
export function firstInput(goal: string, screenshot: string) {
  return [{ role: "user", content: [{ type: "input_text", text: goal }, { type: "input_image", image_url: screenshot }] }];
}

/** What goes back after each computer_call: the new screenshot, plus the checks the user approved. */
export function callOutput(callId: string, screenshot: string, acknowledged: SafetyCheck[]) {
  return [{ type: "computer_call_output", call_id: callId, acknowledged_safety_checks: acknowledged, output: { type: "computer_screenshot", image_url: screenshot } }];
}
