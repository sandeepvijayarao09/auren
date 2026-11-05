Build for Your World. Auren is one agent on Muse, one live session across your Apple Watch, Ray-Ban Meta glasses, iPhone and Mac, that turns one sentence into a finished task across your apps.
Uses Muse models from Meta: Muse Wonder (`muse-wonder-1.0`) and Muse Spark (`muse-spark-1.3`) run live; Muse Voice Transcribe, SAM 3.1 and Muse Spark Open (Baseten) are integrated and tested against fakes, not yet run live; the Muse Glimmer decision model is code ready, not trained.

# Auren: submission

Meta Global AI Developer Hackathon · Indie track · Theme: *Build for Your World* · Oct 26 to Nov 4, 2026

## What it is
Muse is the future Meta is building. For it to arrive, Muse has to be a natural extension of everyday life, not one more app you open. Auren is that extension: a layer between you and the digital world.

- **Any app.** Native Calendar, Gmail and Slack connectors, any MCP server you already use, and Muse Wonder computer use for apps with no API.
- **Any device.** The iPhone and the Mac run Auren's own apps (timeline, receipts, approvals). The glasses, the Apple Watch and AirPods are Muse's eyes, ears and voice.
- **More personal with every message.** Every action becomes a receipt in your encrypted log, and Auren Memory recaps and recalls from it. That learning stays on your Mac.
- **One command or one tap, end to end.** Say it once; the task runs across apps and follows you between devices. Nothing is sent without your tap.
- **iCloud-level security.** Modelled on Apple's Advanced Data Protection (our comparison, not Apple's). There is no Auren cloud.

## How it uses Muse
| Model | What it does in Auren | Verified live |
|---|---|---|
| **Muse Wonder** (`muse-wonder-1.0`), Responses API | Plans and acts: one command fans out into parallel tool calls across namespaces, with `tool_search` over the devices and apps online | **Yes.** Live eval (11 cases) and the day demo |
| **Muse Spark** (`muse-spark-1.3`) | Muse decisions per command (apps, risk tier, reply device, look first) within 2.5 s, advisory only; the fast spoken ack | **Yes**, for decisions and acks. In the day demo Spark answered inside the budget on 3 of 7 commands; rules decided the other 4 |
| **Muse Spark**, vision | Reads the poster in a glasses or phone frame | **No.** The eval and the day use a fixture poster reader (`core/src/eval/world.ts`) |
| **SAM 3.1** (point prompt) | Outlines "this" in the frame for the receipt crop | **No.** Fixture segmenter in the eval and the day |
| **Muse Wonder computer use** | Drives Chromium on the Mac; the commit guard pauses before any confirm click | **No.** The eval and the day use a scripted computer-use model and a fake driver; the guard itself is tested on real Chromium |
| **Muse Voice Transcribe** (realtime, keyword biasing) | Ears on every surface: iPhone hold-to-talk, signed watch clips | **No.** Built and tested against a fake transcriber |
| **Muse Spark Open** (Baseten, `meta-models/muse-spark-open-1026`) | Auren Memory: recap and recall over receipts | **No.** `BASETEN_API_KEY` was not set, so the local fallback answered in the eval and the day |
| **Muse Glimmer** (LoRA distillation) | A smaller decision model to replace Spark at the fast lane | **No.** Code in `router/`, not trained (no training credits) |

Full map of every capability and where it lives in the code: [MUSE.md](MUSE.md).

## Results, failures included
**Live eval** ([eval/results.md](eval/results.md), Nov 4, `muse-wonder-1.0` + `muse-spark-1.3`, budgets enforced)
- **8 of 11 pass. 0 tier violations.** 0 outside content passed to the model unwrapped.
- End-to-end latency, excluding time waiting on a tap: **p50 9,736 ms · p95 31,427 ms.** Ack: p50 1,003 ms · p95 1,014 ms. Handoff: p50 1 ms.
- Tokens: 163,287 in · 11,361 out · 13,434 per command.
- Misses:
  - `gp1-watch-fan-out`: 31,427 ms against a 15,000 ms budget (16.4 s over). All 3 receipts, the watch tap and the actions were right.
  - `gp2-glasses-poster`: 28,699 ms against 10,000 ms (18.7 s over), and a correctness miss: the "Demo night" event in Room 214 was not on the calendar.
  - `platform-mcp-journal`: 15,950 ms against 15,000 ms (950 ms over).
- Passes include the approval moving when the watch drops, the reply continuing when the glasses come off, the CAPTCHA stop, recap then undo, and a planted email that asks Auren to post (Core held it).

**Scripted eval:** 11 of 11 in CI (`npm run eval`), no key needed.

**Tests:** 370 across five suites: Core 256, AurenKit 54, router 34, driver 20, keyd 6.

**A day with Auren** ([docs/day-with-auren.md](docs/day-with-auren.md)): one fictional person's day, 7 moments from 8:05 AM to 10:47 PM, played through the real Core on live Muse Wonder and Muse Spark with synthetic data. 88,394 model tokens (81,589 in, 6,805 out). Every send waited for a watch tap; every write left an undoable receipt; the planted instruction in an email was summarized, not obeyed. The poster reader, segmenter, browser and memory backend were the same fixtures and fallback as the eval.

## Privacy and safety
Backed by [SECURITY.md](SECURITY.md).
- **Keys on your hardware.** Core's master key is sealed to the Mac's Secure Enclave by `auren-keyd`; each job gets an HKDF-derived key.
- **Encrypted, tamper-evident log.** Every event is AES-256-GCM encrypted and HMAC hash-chained; an edit, deletion or reorder fails `/v1/audit/verify`. Connector tokens are encrypted in their own table.
- **Paired devices sign.** iPhone and Apple Watch pair with a one-time code and sign every approval, camera frame and voice clip with their own Secure Enclave keys. A spoken yes, a stolen token or an injected instruction can't produce that signature.
- **Tiers enforced by Core, not the model.** Reads run; writes leave a receipt and an Undo; sends wait for a signed tap. Computer use stops before any commit and never solves a CAPTCHA. MCP tools ask for a tap unless you trust that server.
- **Outside content is data.** Email, chat, calendar, web and MCP results reach the model wrapped as untrusted data; MCP names and descriptions are cleaned and capped.
- **Every crossing on the record.** The outbound ledger lists each call that leaves the Mac (service, bytes, time, tokens, never contents). The ops log is redacted. Token alarm and hard limit guard the credits. The public sandbox creates no log, keys, connectors or devices.

The limit, plainly: commands go to Meta's Model API, and on free hackathon credits Meta's terms say content may be used for product improvement. Memory and personalization stay on the Mac.

## Built during the hackathon
Everything was written after the Oct 26 kickoff; the commit history is the record.

- **Oct 26:** Auren Core, Surface Protocol v0 and the web console.
- **Oct 27:** Base template: iPhone and Apple Watch apps, commit guard, router schema, eval cases, brand, docs.
- **Oct 31:** Google Calendar connector; the user's clock in the prompt.
- **Nov 2:**
  - Master key sealed to the Secure Enclave; tamper-evident log.
  - Device pairing; every approval signed by the device's Secure Enclave.
  - Round 3: live Slack and Gmail connectors, record and replay.
  - Round 4: voice through Muse Voice Transcribe, hold-to-talk on iPhone.
  - Round 5: continuity, replies and approvals follow you between devices.
  - Round 6: vision, "add this" reads the poster through the glasses.
  - Round 7: computer use, one tap at the commit.
  - Round 8: Auren Memory on Muse Spark Open, undo by voice.
  - Round 10: eval runner and results.
- **Nov 3:**
  - Vision and computer use in the eval: 10 of 10 scripted cases pass.
  - Round 11: MCP bridge, every tool asks unless trusted.
  - Round 12: watch voice clips, timeline media, approval verbs.
  - Round 9: Auren Router, Muse decisions as advisory hints (Glimmer code, untrained).
  - Round 13: judges' sandbox, token usage, spend limit.
  - Status update: 370 tests, 11 of 11 scripted eval cases.
- **Nov 4:**
  - First live Muse runs: 8 of 11 eval cases pass, 0 tier violations.
  - Muse's decision on the timeline; a day with Auren played on live Muse.
  - README leads with privacy and Muse's decisions; the day replays with its taps.

## Links
- Repo: https://github.com/sandeepvijayarao09/auren
- A day with Auren (Apple edition): https://claude.ai/artifact/65ycJFhiE1tidNqk12fzP6 (share publicly before submitting)
- Video: TODO
- X post: TODO
- Sandbox try-it: TODO (not hosted yet; runs locally with `make sandbox`)

## Not verified yet
- No run on a real Apple Watch or iPhone. Both apps build for the Simulator only.
- The Ray-Ban Meta glasses toolkit isn't available here, so the glasses camera is a stub; the iPhone camera stands in.
- Live vision (Muse Spark reading the frame, SAM 3.1 outlining it) has not run; the eval and the day use fixtures.
- Live Muse Voice Transcribe has not run.
- Live Muse computer use has not run; the eval uses a scripted model and a fake driver.
- Auren Memory has not run on Spark Open; the local fallback answered.
- The sandbox isn't hosted.
- Glimmer isn't trained.
- Live latency misses the golden-path budgets on GP1 and GP2.

## Bonus prize angles
| Prize | What exists |
|---|---|
| **Open-weight** | Auren Memory is wired to Muse Spark Open with a local fallback, but has not run live. Glimmer distillation code is ready, untrained. No numbers yet. |
| **Agentic** | One sentence → parallel actions across Slack, Calendar and Gmail, live on Muse Wonder (GP1, 6 tool calls, 3 receipts). Computer use behind a commit guard is built and tested on real Chromium, not yet driven by live Muse. |
| **Viral on X** | TODO: the 40 s cut, tagging Meta AI and Cerebral Valley. |
| **Community vote** | The sandbox `/try` is built and hardened for public visitors; it needs hosting for Nov 9 to 16. |
| **Creative** | TODO: the ad-style film. |

All people, messages, events and sites in the demos are fictional.
