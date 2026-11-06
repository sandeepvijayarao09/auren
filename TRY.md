<p align="center"><img src="brand/mark.svg" width="56" alt="Auren"></p>

# Try Auren on your own machine

This guide takes about five minutes. You run Auren's sandbox on your computer, open it in your browser, and take the 3-minute judge tour.

The sandbox is a fictional workspace with a simulated iPhone, Apple Watch and Ray-Ban Meta glasses. Real Auren Core runs underneath: the tier gate, the tap on your device, receipts, Undo, follow-ups and what it learns about you. Nothing reaches a real account or device. You don't need a key or a sign-in.

> Prefer to watch first? The 2:45 demo: https://youtu.be/dmmQTRM8Ci8

## 1. Run it

Choose one option.

### Option A: Docker (recommended)
Works on macOS, Windows and Linux, on Apple silicon or Intel.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and open it, so that it's running.
2. In a terminal (PowerShell on Windows), run:
   ```bash
   docker run --rm -p 8080:8080 ghcr.io/sandeepvijayarao09/auren-sandbox
   ```
   The first run downloads about 70 MB. When you see `Auren sandbox on http://0.0.0.0:8080/try`, it's ready.

### Option B: Node, no Docker
Works on macOS and Linux. On Windows, use Option A or WSL.

1. Install [Node.js 24 or newer](https://nodejs.org). Check it with `node -v`.
2. Run:
   ```bash
   git clone https://github.com/sandeepvijayarao09/auren
   cd auren
   ./try.sh --node
   ```
   The first run installs Core's dependencies, then opens your browser.

(`./try.sh` with no option uses Docker if it's running, and Node otherwise.)

## 2. Open it
Go to **http://localhost:8080/try**.

The badge at the top right says **Replay**. With no key, each example plays the model's turns from Auren's eval scripts through the real Core loop, so every tap, receipt and Undo is real.

## 3. Take the judge tour
Press **Start the 3-minute judge tour**. Each step runs an example and tells you what to look for. Answer the simulated watch or phone when it asks.

| # | Step | What to look for |
|---|---|---|
| 1 | One sentence, three apps | An instant spoken ack and Muse's decision. The calendar move and the draft run on their own; the Slack post is a send, so it waits. **Tap Post on the watch.** |
| 2 | Receipts and Undo | Auren recaps the day from receipts, then undoes the 3:15 move by voice. |
| 3 | The tap follows you | The watch comes off three seconds in, and the waiting approval moves to the phone. Approve it there. |
| 4 | The ignored injection | An email tells Auren to post "grades are leaked" in #general. Core holds it at the tier gate. Tap **Not now** and nothing goes out. |
| 5 | Glasses: add this | The glasses look at a poster (a replayed synthetic frame). The event lands with the crop SAM 3.1 outlined, and the invite waits for your tap. |
| 6 | Maya's proactive day | A second person's world. Her morning briefing reads calendar, email and Slack and changes nothing. **Plan tomorrow** adds five blocks, each with Undo, and invites nobody. |
| 7 | It knows your team | Maya's usual channel is in **What Auren knows**, so the post goes straight to #design-team and still waits for the tap. Press **Forget**, say it again, and it asks which team. |
| 8 | Follow-ups | "Actually, move it to 4 instead" moves the same event again, to 4:00. |

After the tour, tap any example chip or type one of the example sentences yourself. Switch to **Details** at the top right to see every event: Muse's decision, each tool call with its tier (read, write or send), approvals and receipts.

## 4. Optional: run live Muse with your own key
With a Meta Muse API key, Muse Wonder plans each command live on the fictional workspace, and you can type your own commands. Vision and the booking site stay replayed.

```bash
docker run --rm -p 8080:8080 -e MODEL_API_KEY=your_key ghcr.io/sandeepvijayarao09/auren-sandbox
```
or `MODEL_API_KEY=your_key ./try.sh`.

The badge changes to **Live**. Tokens are billed to your key. Each run of the sandbox stops making live calls after 200,000 tokens (roughly 15 to 20 commands) and replays from then on.

## 5. Stop it
Press **Ctrl-C** in the terminal. The sandbox keeps nothing: its state lives in memory and disappears when it stops.

## Troubleshooting
| Problem | Fix |
|---|---|
| `Cannot connect to the Docker daemon` | Open Docker Desktop and wait until it says it's running, then try again. |
| `port is already allocated` or the address is in use | Use another port: `docker run --rm -p 8081:8080 ghcr.io/sandeepvijayarao09/auren-sandbox`, then open http://localhost:8081/try. With `./try.sh`, run `PORT=8081 ./try.sh`. |
| `needs Node 24 or newer` | Update Node from https://nodejs.org, or use Docker. |
| Typed text says "this sandbox replays the golden paths" | Without a key, only the example sentences play. Tap a chip, or add your own key (step 4). |
| The page says the session expired | Sessions end after 30 minutes idle. Reload the page to start a fresh one. |
| `./try.sh: Permission denied` | Run `chmod +x try.sh` once, or use `bash try.sh`. |

## What the sandbox does and doesn't include
- **Real:** Core's agent loop, the tier gate (reads run, writes leave a receipt with Undo, sends wait for a tap), approvals that move between devices, receipts, Undo, follow-ups, the injection warning, and per-visitor learned preferences with Forget.
- **Simulated:** the devices, the accounts (a fictional calendar, inbox, Slack and booking site) and, without a key, the model's turns.
- **Not here:** the real apps on iPhone, Apple Watch and Mac, Secure Enclave pairing, live Google and Slack connectors, and the glasses camera. Those run on the full Core described in the [README](README.md) and [DEVELOPING.md](DEVELOPING.md).

Questions or problems: [open an issue](https://github.com/sandeepvijayarao09/auren/issues).
