// Contact preload: "Add this, and invite Priya" needs Priya's email, and the model
// often asks for it a turn late (GP2 live: look → create → find_contact → invite).
// When the words name who to invite, Core starts calendar.find_contact itself as the
// command begins. It is a read, through executeCall like any call, so nothing about
// tiers changes: the invite still waits for its tap.

// "invite Priya", "invite Priya Shah and Lee", "invite Sam, Lena and Jo". Names are capitalized, as ASR writes them.
const NAME = String.raw`[A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+)?`;
const INVITE = new RegExp(String.raw`\b[Ii]nvite\s+(${NAME}(?:\s*(?:,|\band\b|&)\s*${NAME})*)`, "g");
// Capitalized words that aren't people.
const NOT_NAMES = new Set(["Me", "Everyone", "Everybody", "Them", "Him", "Her", "The", "My", "All", "People", "Auren", "Muse"]);

/** The people a command asks to invite, by name, at most three. */
export function inviteeNames(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(INVITE)) {
    for (const part of m[1].split(/\s*(?:,|\band\b|&)\s*/)) {
      const name = part.trim();
      if (!name || NOT_NAMES.has(name.split(/\s+/)[0])) continue;
      if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
    }
  }
  return out.slice(0, 3);
}
