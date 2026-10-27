# The Golden Path

Five commands are the whole product. Everything is built to make these pass on camera, on real accounts, every time. Each one has an eval case in [`eval/cases`](../eval/cases).

| # | Where | Command | Passes when | Case |
|---|---|---|---|---|
| **GP1** | Apple Watch, walking | "I'm running 15 late. Tell office hours on Slack, push my 3 PM block, and draft a reply to Prof. Lee saying grades are in by 5." | Spoken ack in ≤ 1.2 s. The Slack post waits for a watch tap, then sends. The calendar block moves. A Gmail draft exists. Three receipts on the phone in ≤ 15 s. | `gp1-watch-fan-out` |
| **GP2** | Ray-Ban Meta glasses, then a watch tap | Looking at an event poster: "Add this, and invite Priya." | A bystander in frame is blurred on the device. The receipt shows the SAM 3.1 outline of the poster. Title, date and place are right. The invite sends after the tap. ≤ 10 s. | `gp2-glasses-poster` |
| **GP3** | The task follows you | Take the glasses off while Auren is answering. | The reply continues on the watch within 2 s. A pending approval moves when the device holding it drops. | `gp3-glasses-off-mid-reply`, `gp3-approval-moves` |
| **GP4** | iPhone and the Mac's browser | "Find a table for two near there at 8 and hold it." | A headed browser on the Mac, with live frames on the phone. Auren stops before confirming, a tap confirms, and it takes ≤ 25 steps and ≤ 90 s. | `gp4-hold-a-table`, `gp4-captcha-stops` |
| **GP5** | The Mac | "What did I get done today?" then "Undo the calendar move." | Auren Memory (Muse Spark Open) recaps the day from receipts. The calendar move is reverted, with its own receipt. | `gp5-recap-then-undo` |

## What each one proves
| | Proves | Meta tooling |
|---|---|---|
| GP1 | One sentence fans out across apps in parallel; sends wait for a tap | Muse Wonder, parallel tool calls, namespaces + `tool_search`, Muse Spark fast ack, Muse Voice Transcribe |
| GP2 | Auren sees what you see, and privacy happens before anything leaves the device | Wearables Device Access Toolkit, Muse Spark vision, SAM 3.1 |
| GP3 | One session across devices; devices are tools that come and go | Client-executed `tool_search` over the live device inventory |
| GP4 | Every app, even without an API, and Auren never commits for you | Muse Wonder computer use |
| GP5 | Everything is a receipt you can ask about or undo | Muse Spark Open on Baseten |

## Where the code is
| Path | Code | Status |
|---|---|---|
| GP1 | `core/src/agent/loop.ts`, `core/src/tools/`, `apps/apple/Watch/` | Loop ✅, live connectors ⏳ Day 2, watch voice ⏳ Day 4 |
| GP2 | `core/src/vision/`, `apps/apple/iOS/` (glasses surface) | ⏳ Day 5 |
| GP3 | `core/src/surfaces.ts` (`#pick`, `sweep`, approval handoff) | Approval handoff ✅, chunked speech ⏳ Day 4 |
| GP4 | `core/src/computer/`, `driver/` | Commit guard ✅, runner ⏳ Day 6 |
| GP5 | `core/src/memory/`, `undoReceipt` in `core/src/agent/loop.ts` | Undo ✅, Auren Memory ⏳ Day 7 |
