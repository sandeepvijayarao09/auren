# Auren driver

Computer use for apps that have no API. Muse Wonder (with the `{"type":"computer"}` tool) decides what to click; this driver does the clicking in a headed browser on your Mac, sends back screenshots, and **stops before any commit**.

```bash
npm install
AUREN_DRIVER_ALLOW=opentable.com npm start   # headed Chromium, dials Core's /v1/driver
npm test         # the guard, the executor on real Chromium, the Core connection
npm run typecheck
```

Chromium comes from Playwright's cache (`~/Library/Caches/ms-playwright`). If it's missing, run `npx playwright install chromium`; the executor tests skip until it's there.

## Settings
Read from the repo's `.env`.

| Variable | Needed | What it does |
|---|---|---|
| `AUREN_DRIVER_ALLOW` | Yes | Sites the browser may open, comma-separated. Subdomains count, so `opentable.com` allows `www.opentable.com`. The driver won't start without it. |
| `AUREN_CORE_URL` | No | Where Core is, if not `http://127.0.0.1:8787` |
| `AUREN_TOKEN` | When Core is on another machine | Sent as a bearer token. From this Mac, Core needs none. |
| `AUREN_DRIVER_HEADLESS` | No | `true` hides the window (tests, CI) |
| `AUREN_DRIVER_NAME` | No | How Core's ops log names this driver (default `mac`) |

## How it works
- **`src/guard.ts`** holds the two checks that keep computer use safe. They run in the driver, not in the prompt, so no text on a page can talk them out of stopping.
  - **`checkClick(target)`** runs before every click. If the element is clickable and its accessible name matches a commit word, it stops. The words are confirm, reserve, book, pay, buy, purchase, submit, send, place order, checkout and complete reservation. It also stops on any button on a checkout or payment page.
  - **`seesCaptcha(page)`** detects reCAPTCHA, hCaptcha, Cloudflare Turnstile and Arkose frames, and "I'm not a robot" wording. Auren never solves a CAPTCHA; it stops and hands the page to you.
- **`src/executor.ts`** runs actions in Chromium through Playwright:
  - click, double_click, move, drag, scroll, type, keypress, wait, screenshot, and back or forward.
  - **Before every click** it reads the element at that point from Chromium's accessibility tree (role and accessible name, walking up from the exact node to its control) and calls `checkClick`. An element styled as clickable (`cursor: pointer` or `onclick`) counts as a button, so a bare `<div>` can't slip past.
  - **Enter and Space are checked too:** the focused control, and the submit button of its form, go through `checkClick`. A newline in typed text is an Enter.
  - **A pause holds the action.** The run stops and returns `paused`. Core asks for a send-tier tap and only then sends `commit`, which re-reads the target and clicks only if it's still the same control.
  - **The allowlist** applies to every top-level navigation, including redirects and popups. Leaving it stops the run.
  - **A clean profile:** a fresh browser profile per launch and a fresh context per task, with no saved passwords, cards or cookies, and downloads off.
  - After each batch it returns a JPEG screenshot for the model and a ~400 px JPEG frame for the timeline, and checks for a CAPTCHA.
- **`src/client.ts`** dials Core, says `hello` (viewport and allowlist), runs one command at a time, and reconnects if Core restarts. The messages are in `src/protocol.ts` and `core/src/computer/hub.ts`.

The step limit (25 steps or 90 s) and the approvals live in Core's runner, `core/src/computer/runner.ts`. See [ARCHITECTURE.md §14](../ARCHITECTURE.md#14-computer-use-gp4) for the full sequence and [docs/rounds/R7.md](../docs/rounds/R7.md) for what's verified.
