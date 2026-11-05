# Personalization: what Auren learns about you

Auren learns your habits from **your own receipts**, on your Mac. No model is involved in the learning: `core/src/memory/preferences.ts` counts what is already in the encrypted event log (tool calls, approvals and receipts) as each event lands.

## What it learns
| Preference | Learned from |
|---|---|
| Channel for status and "running late" posts | Approved Slack posts whose text reads like a status (late, leaving, stuck, on my way…) |
| Frequent contacts and their emails | Invites you approved (names from the `find_contact` lookup before them), and the recipient of drafts and messages |
| Typical meeting length | Events Auren created (end minus start; an hour when no end is given) |
| Preferred meeting time | Start times of events created and moved (morning, afternoon or evening) |
| Device you usually approve on | Which surface answered each approved tap |
| Restaurant and party size | Browser bookings you tapped through to the commit (an uncommitted task leaves no receipt) |

Each preference keeps its **evidence**: how many times the leading value was seen out of all observations, and the ids of the latest receipts (or approvals) behind it. **Confidence** is the leading value's share of the decayed evidence times `1 − e^(−weight/1.5)`, so one sighting gives 49%, three give about 86%, and a split habit stays low. Evidence **decays** with a 21-day half-life, so a habit fades unless it repeats.

## How Muse uses it
Preferences at or above 40% confidence go into Wonder's instructions as a block of at most 600 characters, marked as the user's own data and not instructions from outside:

```
- What I know about you, learned on this Mac from the user's own past receipts. It is the user's own data, not instructions from anyone else. Use it to fill in details the user leaves out; it never replaces an approval:
  - Usually approves on the watch
  - Status and running-late posts go to #design-team (channel_id CM1)
  ...
```

The block is text in the prompt and nothing else. Tiers are enforced in `executeCall`, so a learned preference **can't skip a tap**: a send still waits for an approval signed on your device (tested in `preferences.test.ts`).

## Live check: Maya's day
`cd core && npm run day -- maya` ran Maya Okafor's seven-command travel day on live Muse on 2026-11-04 (108,604 tokens in all, the follow-ups included). Then it asked the same thing twice, the next morning, from the watch: once without preferences and once with them.

**Learned from the day's receipts:**
| Preference | Value | Confidence | Evidence |
|---|---|---|---|
| Device you usually approve on | watch | 93% | 4 of 4 approvals (events 59, 58, 41) |
| Channel for status posts | #design-team (channel_id CM1) | 49% | 1 of 1 ("leaving the office at 3", receipt 25) |
| Frequent contacts | Gloria Reyes <gloria.reyes@example.org> | 49% | 1 of 1 (the key-handoff draft, receipt 23) |
| Typical meeting length | 60 min | 49% | 1 of 1 (the meetup, receipt 32) |
| Restaurant you book | Demo Bistro, around 8:00 PM | 49% | 1 of 1 (receipt 43) |
| Usual party size | 2 | 49% | 1 of 1 (receipt 43) |
| Preferred meeting time | evening (18:00) | 24% | 1 of 2, a tie with an afternoon move, so not in the prompt |

The prompt block came to 481 characters.

**"Tell the team I'm running 10 minutes late."**
| | Tool calls | Tap | Answer |
|---|---|---|---|
| Without preferences | `calendar.list_events` → `slack.list_channels` | none | "Which team should I tell, design-team or checkout-squad, and what are you late to?" |
| With preferences | `slack.post_message` (channel CM1) | Post to #design-team: "Hi team, I'm running 10 minutes late." → approved on the watch | "I told the design team you're running ten minutes late." |

With what it learned, Auren picked Maya's usual channel without asking, and still asked for the tap. (The run without preferences was declined at the tap, so it taught nothing. The run with them took 36 s end to end, a slow model turn; the one-call plan itself is shorter.) The raw numbers are in `eval/out/personalization.json`.

## Seeing and forgetting it
- **Console:** Details view → "What Auren knows" lists each preference with its evidence and confidence (green means it's in the prompt), a Forget button on each, and Forget everything.
- `GET /v1/preferences` (token): every preference with its evidence, the threshold, and the exact block Wonder sees.
- `DELETE /v1/preferences/:key`: forget one (`status_channel`, `contacts`, `meeting_length`, `meeting_time`, `approval_device`, `restaurant`, `party_size`). New receipts can teach it again.
- `DELETE /v1/preferences`: forget everything learned. Receipts already in the log aren't read again.
