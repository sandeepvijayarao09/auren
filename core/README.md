# Auren Core

The one place that holds your session. Every surface (watch, glasses, phone, Mac) connects here, every Muse call starts here, and every action is written to one append-only event log.

TypeScript running directly on Node 24+ (type stripping, no build step) · Hono · ws · zod · `node:sqlite` · the OpenAI SDK pointed at `https://api.meta.ai/v1`.

```bash
npm install
npm test          # 170 tests, no API key or accounts needed (scripted Muse, fake Google and Slack)
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
| `src/eventlog.ts` | Append-only log in SQLite, contents encrypted, every event HMAC-chained to the one before; every append is broadcast to every surface | ✅ |
| `src/security/keys.ts` | The master key (Secure Enclave via `auren-keyd`, `AUREN_SECRET`, or a file, in that order) and per-purpose keys | ✅ |
| `src/security/ledger.ts` | The outbound ledger: every call to Meta, Google and Slack, without contents | ✅ |
| `src/security/devices.ts` | Trusted devices: pairing codes, P-256 keys, signed hellos and approvals, revoke | ✅ |
| `src/obs/opslog.ts` | JSON operational log with trace ids and redaction | ✅ |
| `src/surfaces.ts` | Presence (faster for glasses), the device picker (`#pick`), approval handoff, and replies in sentences that move mid-reply | ✅ |
| `src/agent/loop.ts` | The Muse Wonder loop: tool inventory, tier gate, receipts, undo, fast ack | ✅ |
| `src/tools/` | Apps and devices as Muse tool namespaces, plus the in-memory demo world | ✅ |
| `src/eval/cases.test.ts` | Checks every case in `eval/cases` against the real tools | ✅ |
| `src/eval/run.ts` | `npm run eval`: plays the cases, counts tier violations, writes `eval/results.md` | ✅ |
| `src/connectors/secrets.ts` | Encrypted token store (AES-256-GCM in SQLite) | ✅ |
| `src/connectors/google/` | Google sign-in (Desktop client, PKCE, refresh) and the live `calendar` and `gmail` namespaces | ✅ |
| `src/connectors/slack.ts` | Slack through a bot in the demo workspace | ✅ |
| `src/connectors/tape.ts` | Record real API responses once (tokens scrubbed), replay them offline in tests and evals | ✅ |
| `src/voice/` | `/v1/voice`: microphone audio → Muse Voice Transcribe → a command; wake phrase and keywords | ✅ |
| `src/vision/` | `glasses.look`: a capture request → one blurred frame → Muse Spark reads it, SAM 3.1 outlines it → an encrypted receipt crop | ✅ tested against fake models ([R6](../docs/rounds/R6.md)) |
| `src/computer/` | `browser.run_task`: the nested computer-use runner that drives `driver/`, with the tap at the commit | ✅ tested against a fake driver and scripted Muse ([R7](../docs/rounds/R7.md)) |
| `src/memory/` | Auren Memory: recap and recall over receipts on Muse Spark Open (local fallback), and `receipts.undo` | ✅ |

## Routes
| Route | Auth | What it does |
|---|---|---|
| `GET /` | — | The web console (`apps/web/index.html`) |
| `GET /minimal` | — | The 20-line example surface |
| `GET /brand/tokens.css` | — | Brand tokens for the console |
| `GET /health` | — | `{ ok, muse, google, surfaces }` |
| `GET /connect/google` | this Mac, or token | Starts the Google sign-in ([setup](../docs/google-setup.md)) |
| `GET /connect/google/callback` | — | Where Google sends the browser back |
| `GET /v1/connections` | token | Which accounts are connected |
| `GET /v1/audit/verify` | token | Walks the log's hash chain: `{ ok, count, head, brokenAt? }` |
| `GET /v1/outbound` | token | The outbound ledger |
| `GET /v1/trust` | token | Log integrity, key source, outbound summary, devices online and paired |
| `POST /v1/pair/start` | this Mac only | A one-time six-digit pairing code |
| `POST /pair/finish` | the pairing code | A device registers its Secure Enclave public key |
| `GET /v1/devices` · `DELETE /v1/devices/:id` | token · this Mac only | List and revoke paired devices |
| `GET /v1/events?since=` | token | The event log |
| `POST /v1/command` | token | `{ text, surface_id? }` → runs a command |
| `POST /v1/approvals/:id` | token | `{ approved, surface_id? }` |
| `POST /v1/receipts/:id/undo` | token | Reverses a write |
| `POST /v1/frames/:request_id` | token, plus the surface Core asked (signed off the Mac) | One camera frame for a `capture_request` ([spec](../spec/surface-protocol.md#camera-v01)) |
| `GET /v1/crops/:id` | token | A receipt's crop: what SAM 3.1 outlined |
| `WS /v1/surface` | token or paired device | The Surface Protocol ([spec](../spec/surface-protocol.md)) |
| `WS /v1/voice` | this Mac or paired device | Hold-to-talk audio in, transcripts out ([spec](../spec/surface-protocol.md#voice-v01)) |
| `WS /v1/driver` | this Mac, or token | The Playwright driver dials in and takes one batch of actions at a time ([driver](../driver/README.md)) |

"token" means `Authorization: Bearer $AUREN_TOKEN` or `?token=`. Without `AUREN_TOKEN`, Core listens on 127.0.0.1 only and needs no token.

## Add a tool
1. Write a `ToolSpec` in a namespace under `src/tools/` (see `demo-world.ts`). Give it a `tier`:
   - `read` runs on its own;
   - `write` runs on its own, leaves a receipt, and should define `undo`;
   - `send` always waits for a tap. With `commitPoint: true` the tap comes at the tool's own commit point instead (computer use browses first, then asks before the confirm click) through `ctx.approveCommit`, and the receipt is written only if that tap approved.
2. Set `external: true` if its result carries outside text (email, chat, web), so the loop wraps it as untrusted data.
3. Register the namespace in `src/index.ts`.
4. Add a scripted test in `src/agent/loop.test.ts`, and an eval case in `eval/cases/` if it touches a golden path.

The tool's `tier` is the only authority on risk. The model, the router and page content can't change it.
