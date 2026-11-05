// Spotting instructions aimed at the assistant inside outside content (email,
// chat, web pages, MCP results). This is not the defence: outside results already
// reach the model wrapped as untrusted data, and tiers are enforced in executeCall.
// It only decides when Core tells the user, in one line, that something tried.
// Phrases, not a classifier, so it is cheap and the same on every run.

// Each one is aimed at an assistant, so a professor's "new instructions for HW3" or
// a newsletter about system prompts doesn't set it off.
const PATTERNS: RegExp[] = [
  // "Ignore your previous instructions and …"
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|your|any|other)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|directions|guidelines)\b/i,
  // "ATTENTION AI ASSISTANT:", "Note to the agent:", "Instructions for Auren -"
  /\b(attention|note|message|instructions?|hey)\s*(to|for)?\s*(the\s+|any\s+)?(ai|llm|gpt|chatbot|assistant|agent|auren|muse)\b(\s+(assistant|agent|model))?\s*[:,!-]/i,
  // "New instructions for the assistant", "AI assistants reading this must …"
  /\bnew\s+(system\s+)?instructions\s+(for|to)\s+(the\s+|any\s+)?(ai|assistant|agent|model|bot)\b/i,
  /\b(ai|llm)\s+(assistants?|agents?|models?)\s+(reading|processing|summari[sz]ing)\s+this\b/i,
  /\b(reveal|print|show|repeat|output|leak)\b[^.\n]{0,30}\bsystem\s+prompt\b/i,
  /\byou\s+are\s+now\s+(in\s+)?(developer|god|admin|jailbreak|unrestricted|dan)\b/i,
  // "Do not tell the user"
  /\bdo\s+not\s+(tell|mention|inform|alert|notify)\b[^.\n]{0,30}\b(the|your)\s+(user|owner|human)\b/i,
];

/** Whether `text` reads like orders to an AI assistant. */
export function looksLikeInjection(text: string): boolean {
  return PATTERNS.some((p) => p.test(text));
}

/** Every string inside a tool result, up to a total length: what the model would read. */
export function stringsIn(value: unknown, max = 50_000): string[] {
  const out: string[] = [];
  let total = 0;
  const walk = (v: unknown, depth: number) => {
    if (total >= max || depth > 12) return;
    if (typeof v === "string") {
      out.push(v);
      total += v.length;
    } else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (v && typeof v === "object") for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(value, 0);
  return out;
}

/** Whether any text in a tool result reads like orders to an AI assistant. */
export function resultHasInjection(result: unknown): boolean {
  return stringsIn(result).some(looksLikeInjection);
}

/** Namespaces that read back Auren's own record (receipts, recaps). What they quote was flagged when it was first read. */
export const OWN_RECORDS = new Set(["receipts", "memory"]);

// What the user hears the content was, by namespace.
const SOURCE: Record<string, string> = {
  gmail: "an email",
  slack: "a Slack message",
  browser: "a web page",
  glasses: "something the camera saw",
  calendar: "a calendar entry",
};

/** "Heads up: an email tried to give me instructions; I ignored it." One line for any number of sources. */
export function injectionNotice(namespaces: Iterable<string>, apps: Map<string, string> = new Map()): string {
  const names = [...new Set(namespaces)].map((ns) => SOURCE[ns] ?? `content from ${apps.get(ns) ?? ns}`);
  if (!names.length) return "";
  const what = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `Heads up: ${what} tried to give me instructions; I ignored ${names.length === 1 ? "it" : "them"}.`;
}

/** Whether the model's reply already tells the user it ignored planted instructions, so the notice isn't said twice. */
export function replyMentionsIgnored(reply: string): boolean {
  return /\b(ignor\w*|didn'?t follow|did not follow|won'?t follow|not following)\b/i.test(reply) && /\b(instruction|order|command|told me|asked me)\w*/i.test(reply);
}
