// The wake phrase and the words Muse should listen hardest for.

// "Hey Muse", with the ways speech recognition tends to hear it, and the
// fallback "Hey Auren" (often heard as "Hey Lauren").
const WAKE = /^\s*(?:hey|hi|hay|ok(?:ay)?|a)[\s,]+(?:muse|mews|muze|meuse|auren|oren|lauren)\b[\s,.!:;-]*/i;

/** Drops a leading wake phrase and capitalises what's left: "hey muse, move my 3 PM" → "Move my 3 PM". */
export function stripWake(text: string): string {
  const rest = text.replace(WAKE, "").trim();
  return rest ? rest[0].toUpperCase() + rest.slice(1) : "";
}

/** Names that general-purpose recognition gets wrong: the wake word, people, channels. */
export function voiceKeywords(extra: string[] = []): string[] {
  const base = ["Muse", "Hey Muse", "Auren", "Slack", "Gmail", "office hours", "Prof. Lee", "Priya"];
  return [...new Set([...base, ...extra.map((w) => w.trim()).filter(Boolean)])];
}
