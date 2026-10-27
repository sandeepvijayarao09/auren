// The commit guard. It checks every click the model asks for before the driver
// performs it. It lives in the driver, not in the prompt, so nothing written on a
// page can talk it out of stopping. See ARCHITECTURE.md §14.

/** What the driver reads from the element under the click point. */
export interface ClickTarget {
  /** ARIA role, such as "button" or "link". */
  role: string;
  /** Accessible name. */
  name: string;
  /** Visible text, when it differs from the name. */
  text?: string;
  /** Page URL at the time of the click. */
  url: string;
}

export type Verdict = { stop: false } | { stop: true; reason: string };

const CLICKABLE = new Set(["button", "link", "menuitem", "option", "checkbox", "radio", "switch", "tab"]);

// Whole words only, so "Bookmarks", "Facebook" and "PayPal" don't trip it, but
// "Book now", "Pay $42" and "Complete reservation" do.
const COMMIT_WORDS = [
  /\bconfirm\b/,
  /\breserve\b/,
  /\bbook\b/,
  /\bpay\b/,
  /\bbuy\b/,
  /\bpurchase\b/,
  /\bsubmit\b/,
  /\bsend\b/,
  /\bplace (?:the |my |your )?order\b/,
  /\bcheck ?out\b/,
  /\bcomplete (?:the |my |your )?(?:order|booking|purchase|reservation|checkout)\b/,
];

const CHECKOUT_PATH = /\/(?:checkout|payment|pay|purchase|confirm(?:ation)?)(?:\/|$)/;

export function checkClick(target: ClickTarget): Verdict {
  const role = target.role.toLowerCase();
  if (!CLICKABLE.has(role)) return { stop: false };
  const label = `${target.name} ${target.text ?? ""}`.toLowerCase().replace(/\s+/g, " ").trim();
  const word = COMMIT_WORDS.find((re) => re.test(label));
  if (word) return { stop: true, reason: `"${target.name || target.text}" looks like a commit` };
  let path = "";
  try {
    path = new URL(target.url).pathname.toLowerCase();
  } catch {
    // An unparsable URL is not a reason to stop on its own.
  }
  if (role === "button" && CHECKOUT_PATH.test(path)) return { stop: true, reason: `a button on a checkout page (${path})` };
  return { stop: false };
}

/** What the driver can see of a page without reading pixels. */
export interface PageSignals {
  frameUrls: string[];
  text: string;
}

const CAPTCHA_FRAMES = [/recaptcha/, /hcaptcha\.com/, /challenges\.cloudflare\.com/, /arkoselabs\.com/, /funcaptcha/];
const CAPTCHA_TEXT = [/i'?m not a robot/, /verify (?:that )?you(?:'re| are) (?:a )?human/, /complete the security check/];

/** Auren never solves a CAPTCHA. Seeing one stops the run and hands it to you. */
export function seesCaptcha(page: PageSignals): boolean {
  const text = page.text.toLowerCase();
  return page.frameUrls.some((u) => CAPTCHA_FRAMES.some((re) => re.test(u.toLowerCase()))) || CAPTCHA_TEXT.some((re) => re.test(text));
}
