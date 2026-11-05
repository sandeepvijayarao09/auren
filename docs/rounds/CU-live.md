# CU-live: the first live computer-use run

Nov 4, 2026. Real Muse, a real headless Chromium (`driver/`, `AUREN_DRIVER_HEADLESS=true`, `AUREN_DRIVER_ALLOW=127.0.0.1`) and a fictional booking page, `demo/bistro/index.html`, served with `python3 -m http.server 8790 --bind 127.0.0.1`.

Command: `POST /v1/command` "Hold a table for two at 8 PM on Saturday at Demo Bistro. Its booking page is http://127.0.0.1:8790/". Taps were approved as this Mac through `POST /v1/approvals/:id`, with request ids read from `/v1/events`.

## What we found
- **Muse Wonder 1.0 doesn't take the computer tool.** It returns `400 Unsupported tool type: 'computer'` (with or without display fields). `computer_use_preview` is "not supported on this endpoint"; `computer_use` and `computer_20250124` are unknown values. **Muse Spark 1.3 accepts `{"type":"computer"}`.** Fix: `config.computerModel` (`AUREN_COMPUTER_MODEL`, default `muse-spark-1.3`), which `core/src/index.ts` now passes to `createBrowser`. The main agent stays on Wonder.
- The rest of R7's OpenAI-shaped guesses held up. `actions.ts` and `runner.ts` needed no change: `computer_call.actions[]`, `pending_safety_checks`, `computer_call_output` with `computer_screenshot`, and `previous_response_id`. The output also has a `reasoning` item and a `message` with `phase: "commentary"` before the call. A test in `actions.test.ts` now covers that shape.
- **Muse adds a safety check to every step**, with the code `computer_action_requires_confirmation`. The runner turns each one into a tap. So this run took 3 taps, not 1. On the first try nobody answered the step-1 check, so it expired after 60 s and the run ended `declined`, as designed. Open question: should Auren auto-acknowledge this generic code, given the driver's commit guard already gates the real commit?

## The run (trace 8bb70ac4)
| Time (UTC) | What |
|---|---|
| 01:15:54 | Command accepted; Wonder calls `browser.run_task` (summary "Hold a table for 2 at 8:00 PM") |
| 01:16:00 | Step 1: safety check tap approved |
| 01:16:01 | Step 1: 3 actions (Saturday, 8:00 PM, 2 guests), ok, 526 ms |
| 01:16:09 | Step 2: safety check tap approved |
| 01:16:10 | **Driver PAUSED** before the click (frame `step 2, status paused`). **Tap asked:** `Hold a table for 2 at 8:00 PM · click "Complete reservation" on 127.0.0.1:8790`. Approved; `tool.approval … at: "commit"` |
| 01:16:10 | `commit` clicked; the page title became "Demo Bistro · Reservation held" |
| 01:16:19 | `browser.done` status **committed**, **2 steps** (the cap is 25), 25.7 s of browsing (26.5 s for the tool) |

**Receipt:** `Browser · run_task · send · "Confirmed on the web: Hold a table for 2 at 8:00 PM"` (no proof link; the page is http). Reply: "Held a table for two Saturday at 8 PM at Demo Bistro, confirmation DB-0042."

Speed: about 8 s per model turn on Spark 1.3. The driver steps took about 0.5 s each.

## Checks
Core `npm test` 256 pass; driver `npm test` 20 pass; `npm run typecheck` is clean in both; `npm run eval -- --scripted` 11/11.

## Not verified
The headed window, and real booking sites.
