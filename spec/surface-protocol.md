# Auren Surface Protocol (v0)

A **surface** is any device a person talks to Auren through: a watch, glasses, a phone, a browser, a car, a $5 button. A surface joins by describing what it can do. Core decides what to send it.

The protocol is small on purpose. A new surface should take about 20 lines (see [`examples/minimal-surface.html`](examples/minimal-surface.html)).

## Transport
- **WebSocket**, JSON text frames: `wss://<core>/v1/surface`
- **HTTPS fallback** for constrained devices (watchOS restricts long-lived sockets):
  - `POST /v1/command` `{ "text": "...", "surface_id": "..." }`
  - `POST /v1/approvals/:request_id` `{ "approved": true }`
  - `GET /v1/events?since=<id>` to poll the session timeline

## Manifest
Sent once, in `hello`.

```json
{
  "id": "watch-sandeep",
  "kind": "watch",
  "name": "Apple Watch",
  "inputs":  ["voice", "text", "touch"],
  "outputs": ["voice", "haptic", "screen"]
}
```

| Field | Values |
|---|---|
| `kind` | `watch` · `glasses` · `phone` · `web` · `desktop` · `other` |
| `inputs` | `voice` · `text` · `camera` · `touch` |
| `outputs` | `voice` · `screen` · `haptic` |

## Messages: surface → Core
| `type` | Fields | Meaning |
|---|---|---|
| `hello` | `surface` (manifest) | Join the session |
| `heartbeat` | `active` (bool) | Sent every ~1 s. `active` means the person is using this surface right now (wrist raised, glasses on, tab focused). |
| `utterance` | `text` | A command or a reply (audio goes through the voice endpoint, not here) |
| `approval_response` | `request_id`, `approved` | Answer to an `approval_request` |

## Messages: Core → surface
| `type` | Fields | Meaning |
|---|---|---|
| `welcome` | `session_id`, `surfaces[]` | Joined. Lists the other surfaces online. |
| `event` | `event` | A timeline entry: `utterance`, `ack`, `tool_call`, `receipt`, `approval`, `handoff`, `reply`, `error` |
| `speak` | `text` | Say this out loud |
| `show_card` | `title`, `body` | Show this on a screen |
| `approval_request` | `request_id`, `summary`, `tier` | Ask for a yes/no tap |
| `approval_cancel` | `request_id`, `reason` | The request moved to another surface, or expired |

## Trusted devices (v0.1)
A surface on the Mac that runs Core is trusted as it is. **Any other device must pair once, and then prove its key every time it connects.** A connection relayed by a tunnel or proxy (one with `X-Forwarded-For`, `Forwarded`, `CF-Connecting-IP` or `X-Real-IP`) counts as another device.

1. **Pairing code.** On the Mac, `POST /v1/pair/start` returns a six-digit code, valid for five minutes and one use. Five wrong tries cancel it.
2. **Pair.** The device sends `POST /pair/finish` `{ code, device_id, name, kind, public_key, hardware }`. `public_key` is a P-256 public key (SPKI DER, base64) whose private half lives in the device's Secure Enclave. `hardware` is false for a software key, as in the Simulator.
3. **Connect.** Core's first message on every socket is `challenge { nonce }`. A paired device's `hello` adds `auth { device_id, signature }`, where `device_id` must equal `surface.id` and `signature` is ECDSA P-256 / SHA-256 (DER, base64) over:
   ```
   auren-hello\n<nonce>\n<device_id>
   ```
4. **Approve.** A paired device's `approval_response` adds `signature` over the request, the decision and a hash of the summary it showed. A relay that changes what the device displayed can't produce a valid signature:
   ```
   auren-approve\n<request_id>\n<1|0>\n<sha256 hex of summary>
   ```
   An approval without a valid signature is ignored and logged. The resulting `approval` event carries `signed_by`.
5. **Revoke.** On the Mac, `DELETE /v1/devices/:id` revokes a device and closes its socket at once (close code 4001).

The exact bytes are defined in `core/src/security/devices.ts` and `apps/apple/AurenKit/Sources/AurenKit/DeviceIdentity.swift`, and a CryptoKit-made signature is pinned in Core's tests.

## Presence and routing
A surface is **online** while its heartbeats arrive. It goes offline after 3 s of silence. Core routes each output to the best online surface:

| Output | Goes to |
|---|---|
| `speak` | The surface the command came from, if it's online and has `voice` out. Otherwise the most recently active surface with `voice` out. Otherwise it's shown as text on a screen. |
| `approval_request` | The best surface with `touch` in: `haptic` beats `screen` alone, and active beats idle. |
| `show_card` | The best surface with `screen` out. A phone beats web, and active beats idle. |
| capture (later) | A surface with `camera` in. Glasses beat a phone. |

**Handoff:** if a surface goes offline while it holds a pending approval, Core sends `approval_cancel` (reason `moved`) to that surface, re-issues the request to the next best surface, and logs a `handoff` event. The task follows the person, not the device.

## Risk tiers
Each tool declares a tier, and Core enforces it. The model can't skip a tier.

| Tier | Examples | Behaviour |
|---|---|---|
| `read` | List events, search email | Runs automatically |
| `write` | Move an event, create a draft | Runs automatically, writes a receipt with an **undo** |
| `send` | Post to Slack, send email, book, buy | **Needs an approval tap** before it runs |

Tool output that came from outside (email bodies, Slack messages, web pages) is handed to the model as **untrusted data**. It can't raise or lower a tier.

## Receipts
Every `write` and `send` action logs a receipt event:

```json
{ "kind": "receipt", "app": "calendar", "tool": "move_event",
  "summary": "Moved \"Office hours\" 15:00 → 15:15",
  "tier": "write", "undo": { "tool": "move_event", "args": { "event_id": "evt_1", "new_start": "…15:00…" } } }
```
