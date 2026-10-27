# Auren driver

Computer use for apps that have no API. Muse Wonder (with the `{"type":"computer"}` tool) decides what to click; this driver does the clicking in a headed browser on your Mac, sends back screenshots, and **stops before any commit**.

```bash
npm install
npm test         # the commit guard and CAPTCHA checks, no browser needed
npm run typecheck
```

## What's here today
`src/guard.ts` holds the two checks that keep computer use safe. They run in the driver, not in the prompt, so no text on a page can talk them out of stopping:
- **`checkClick(target)`** runs before every click. If the element is clickable and its accessible name matches a commit word, it stops. The words are confirm, reserve, book, pay, buy, purchase, submit, send, place order, checkout and complete reservation. It also stops on any button on a checkout or payment page. The run pauses, and Core turns the pause into a send-tier approval on your watch or phone.
- **`seesCaptcha(page)`** detects reCAPTCHA, hCaptcha, Cloudflare Turnstile and Arkose frames, and "I'm not a robot" wording. Auren never solves a CAPTCHA; it stops and hands the page to you.

## Day 6
- **Connection.** The driver dials out to Core over `/v1/driver`, so Core can run anywhere. It authenticates with `AUREN_TOKEN`.
- **Browser.** Playwright, headed Chromium, a clean profile with no saved passwords or cards, and a domain allowlist for the demo.
- **Actions.** For each `computer_call`, it runs the `actions[]` (click, type, scroll, keypress, wait), checks every click with `checkClick` first, and returns a `computer_call_output` with a screenshot.
- **Limits.** 25 steps or 90 seconds per task. Every frame also goes to the phone timeline as a `browser_frame` event.

See [ARCHITECTURE.md §14](../ARCHITECTURE.md#14-computer-use-gp4) for the full sequence.
