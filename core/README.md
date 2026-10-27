# Auren Core

The one place that holds your session. Every surface (watch, glasses, phone, Mac) connects here, every Muse call starts here, and every action is written to one append-only event log.

TypeScript running directly on Node 24+ (type stripping, no build step) · Hono · ws · zod · `node:sqlite` · the OpenAI SDK pointed at `https://api.meta.ai/v1`.

```bash
npm install
npm test          # 17 tests, no API key needed (scripted Muse)
npm run dev       # http://127.0.0.1:8787, reloads on save
npm run typecheck
```

## Modules
| Path | What it does | Status |
|---|---|---|
| `src/index.ts` | Starts the server and wires the pieces together | ✅ |
| `src/config.ts` | Every setting, read from `.env` | ✅ |
| `src/server.ts` | HTTP routes and the `/v1/surface` WebSocket | ✅ |
| `src/protocol.ts` | Surface Protocol v0 schemas (mirrored in `apps/apple/AurenKit`) | ✅ |
| `src/eventlog.ts` | Append-only log in SQLite; every append is broadcast to every surface | ✅ |
| `src/surfaces.ts` | Presence, the device picker (`#pick`) and approval handoff | ✅ |
| `src/agent/loop.ts` | The Muse Wonder loop: tool inventory, tier gate, receipts, undo, fast ack | ✅ |
| `src/tools/` | Apps and devices as Muse tool namespaces, plus the in-memory demo world | ✅ |
| `src/eval/cases.test.ts` | Checks every case in `eval/cases` against the real tools | ✅ |
| `src/connectors/` | Google Calendar, Gmail and Slack, with an encrypted token store | ⏳ Days 1–2 |
| `src/voice/` | `/v1/voice`: microphone audio → Muse Voice Transcribe | ⏳ Day 3 |
| `src/vision/` | `glasses.look`: frames → Muse Spark → SAM 3.1 outline | ⏳ Day 5 |
| `src/computer/` | `browser.run_task`: the nested computer-use runner that drives `driver/` | ⏳ Day 6 |
| `src/memory/` | Auren Memory: recap and recall over receipts on Muse Spark Open | ⏳ Day 7 |

## Routes
| Route | Auth | What it does |
|---|---|---|
| `GET /` | — | The web console (`apps/web/index.html`) |
| `GET /minimal` | — | The 20-line example surface |
| `GET /brand/tokens.css` | — | Brand tokens for the console |
| `GET /health` | — | `{ ok, muse, surfaces }` |
| `GET /v1/events?since=` | token | The event log |
| `POST /v1/command` | token | `{ text, surface_id? }` → runs a command |
| `POST /v1/approvals/:id` | token | `{ approved, surface_id? }` |
| `POST /v1/receipts/:id/undo` | token | Reverses a write |
| `WS /v1/surface` | token | The Surface Protocol ([spec](../spec/surface-protocol.md)) |

"token" means `Authorization: Bearer $AUREN_TOKEN` or `?token=`. Without `AUREN_TOKEN`, Core listens on 127.0.0.1 only and needs no token.

## Add a tool
1. Write a `ToolSpec` in a namespace under `src/tools/` (see `demo-world.ts`). Give it a `tier`:
   - `read` runs on its own;
   - `write` runs on its own, leaves a receipt, and should define `undo`;
   - `send` always waits for a tap.
2. Set `external: true` if its result carries outside text (email, chat, web), so the loop wraps it as untrusted data.
3. Register the namespace in `src/index.ts`.
4. Add a scripted test in `src/agent/loop.test.ts`, and an eval case in `eval/cases/` if it touches a golden path.

The tool's `tier` is the only authority on risk. The model, the router and page content can't change it.
