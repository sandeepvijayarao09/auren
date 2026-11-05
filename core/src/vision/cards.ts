// Invite cards: when calendar.invite runs, Muse Image (muse-image-1.0) can draw a
// small card for the event while the invite itself goes out. The card is kept
// encrypted in a CropStore of kind "card" under its own derived key, and its id
// rides on the invite's receipt. Optional (AUREN_INVITE_CARDS=true), never part
// of the tier gate, and a failed or slow card never stops or changes the invite.
import type { OpsLog } from "../obs/opslog.ts";
import type { CropStore } from "./crops.ts";

/** The slice of the OpenAI SDK's images API that Muse Image answers (see docs/models/muse-image.md). */
export interface ImageClient {
  images: {
    generate(params: { model: string; prompt: string; size?: "1024x1024" | "1536x1024" | "1024x1536"; output_format?: "jpeg" | "png" | "webp" }): Promise<{ data?: Array<{ b64_json?: string }> }>;
  };
}

export interface InviteEvent {
  title?: string;
  start?: string;
  location?: string;
}

export interface CardMaker {
  /** Starts a card for this tool call, or returns undefined when the call doesn't get one. Never rejects. */
  start(namespace: string, tool: string, args: Record<string, unknown>): Promise<string | null> | undefined;
  /** How long the receipt waits for a card that has already started. */
  waitMs: number;
}

/** Plain words for the card. Only the event's own fields go in; never the invitees. */
export function cardPrompt(e: InviteEvent | undefined): string {
  const title = clean(e?.title) || "You're invited";
  const when = e?.start ? wallClock(e.start) : "";
  const line = [clean(e?.location), when].filter(Boolean).join(" · ");
  return [
    "A minimal, Apple-like event invitation card. Off-white background, generous whitespace, one soft blurred gradient orb.",
    `Clean sans-serif typography reading exactly: '${title}' (large)${line ? `, '${line}' (small, below)` : ""}.`,
    "No logos, no people, no other text.",
  ].join(" ");
}

export function createInviteCards(deps: {
  client: ImageClient;
  store: CropStore;
  model?: string;
  /** Looks the event up so the card can name it. Optional; without it the card is generic. */
  describe?: (eventId: string) => Promise<InviteEvent | undefined>;
  ops?: OpsLog;
  waitMs?: number;
}): CardMaker {
  const model = deps.model ?? "muse-image-1.0";
  return {
    waitMs: deps.waitMs ?? 9000,
    start(namespace, tool, args) {
      if (namespace !== "calendar" || tool !== "invite") return undefined;
      const t0 = performance.now();
      return (async () => {
        const event = typeof args.event_id === "string" ? await deps.describe?.(args.event_id).catch(() => undefined) : undefined;
        const res = await deps.client.images.generate({ model, prompt: cardPrompt(event), size: "1024x1024", output_format: "jpeg" });
        const b64 = res.data?.[0]?.b64_json;
        if (!b64) throw new Error("Muse Image returned no image");
        const id = deps.store.put(Buffer.from(b64, "base64"));
        deps.ops?.info("vision.card", { ms: Math.round(performance.now() - t0), ok: true });
        return id;
      })().catch((err: unknown) => {
        deps.ops?.warn("vision.card", { ms: Math.round(performance.now() - t0), ok: false, message: err instanceof Error ? err.message : String(err) });
        return null;
      });
    },
  };
}

/** The card's id if it is ready within `ms`, else null. The card keeps going in the background and is simply not attached. */
export function within(card: Promise<string | null>, ms: number): Promise<string | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), ms)));
  return Promise.race([card, late]).finally(() => clearTimeout(timer));
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/['"\n\r]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) : "");

/** "2026-11-04T18:00" → "6 PM", "2026-11-04T18:30" → "6:30 PM". */
function wallClock(iso: string): string {
  const m = /T(\d{2}):(\d{2})/.exec(iso);
  if (!m) return "";
  const h = Number(m[1]);
  const suffix = h < 12 ? "AM" : "PM";
  const h12 = h % 12 || 12;
  return m[2] === "00" ? `${h12} ${suffix}` : `${h12}:${m[2]} ${suffix}`;
}
