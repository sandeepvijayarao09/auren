# Auren

**The layer between you and everything digital.** *Say it once. On anything.*

> *"Hey Muse, I'm running 15 late. Tell office hours, push my 3 PM, and draft the reply to Prof. Lee."*

Auren is one Muse-powered agent and one live session across your **watch, Meta glasses, phone and computer**. You just say **"Hey Muse."** One sentence gets done across all your apps, and the task follows you from device to device.

**Why "Auren".** From *aura*, the field around a person, and *aurum*, gold. Auren is the golden layer around you: the one layer every app and device speaks through, so Muse can reach you wherever you are.

> Built for the **Meta Global AI Developer Hackathon** (Oct 26 to Nov 4, 2026) · Indie track · Theme: *Build for Your World*
> Built on **Muse Wonder · Muse Spark · Muse Spark Open · Muse Glimmer · Muse Voice Transcribe · SAM 3.1**

## The idea
Meta's Muse agent lives on Meta's devices. Auren takes Muse models to **every device you already own**:
1. **Any device.** A device joins with a one-message manifest ([Surface Protocol](spec/surface-protocol.md)). A new surface is [about 20 lines](spec/examples/minimal-surface.html).
2. **The task follows you.** Look through the glasses, approve on the watch, read the receipt on the phone. If a device drops, its pending approval moves to the next best one.
3. **Every app.** APIs where they exist, and Muse Wonder computer use where they don't.

Core enforces safety, not the model. Reads run automatically. Writes run automatically with a receipt and an **undo**. Sends need a **tap**. Email, chat and web content is passed to the model as untrusted data.

## Status
| Piece | State |
|---|---|
| Core: event log, surface protocol, presence, output router, handoff | ✅ working, tested |
| Agent loop: Muse Wonder, parallel tool calls, namespaces + `tool_search`, risk gate, receipts, undo | ✅ working against scripted turns; live Muse run pending an API key |
| Demo world: Calendar, Slack, Gmail (in-memory, fictional people) | ✅ |
| Web console surface (simulates phone, watch or glasses per tab) | ✅ |
| Live Google, Slack connectors | ⏳ Day 2 |
| Voice (Muse Voice Transcribe), iPhone, watch, glasses apps | ⏳ Days 3–5 |
| Computer use, Memory Hub (Spark Open), Auren Router (Glimmer) | ⏳ Days 6–7 |

## Run it
Requires Node 24+.

```bash
cp .env.example .env                  # add MODEL_API_KEY from dev.meta.ai
git config core.hooksPath .githooks   # secret scan before every commit (needs gitleaks)
cd core && npm install && npm test && npm run dev
```

- Open **http://127.0.0.1:8787/** for the console.
- Open a second tab at **/?kind=watch** to get a "watch".
- Send a command from one tab and approve on the watch.
- Tick **go offline** on the watch to see the approval hand off.

Set `AUREN_TOKEN` in `.env` to let your phone and watch reach Core on your network.

## Repo
```
core/        Auren Core: TypeScript, Hono, ws, node:sqlite, OpenAI SDK → api.meta.ai/v1
apps/web/    console surface
spec/        Surface Protocol v0 + the 20-line example
MUSE.md      every Meta capability used, and where in the code
```

## Built during the hackathon
Everything in this repository was written during the event, starting after the kickoff on Oct 26, 2026. The commit history is the record. No code was carried over from earlier projects. Third-party libraries are listed in `core/package.json`.

| Date | Built |
|---|---|
| Oct 26 | Surface Protocol v0 · Core (event log, presence, router, handoff, risk gate, receipts, undo) · Muse agent loop with namespaces + `tool_search` + parallel calls · demo world · web console · tests |

## License
MIT
