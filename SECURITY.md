# Security

Auren acts for you across your apps and devices, so it is built to earn that trust. It is modeled on one principle of Apple's Advanced Data Protection: the keys stay on your devices. **There is no Auren cloud.** Everything Auren stores is encrypted, and every action is in a log that proves it hasn't been edited. What Auren sends to Meta's Model API is a different matter; see [Limits](#limits).

## How it compares to iCloud
Apple describes Advanced Data Protection like this: your trusted devices "retain sole access to the encryption keys"; recovery needs a recovery contact or key; and Mail, Contacts, Calendars and metadata stay outside end-to-end encryption because they have to interoperate ([Apple](https://support.apple.com/en-us/102651)).

| iCloud with Advanced Data Protection | Auren | Status |
|---|---|---|
| Keys held only by your trusted devices | Core runs on your Mac. Its master key is sealed to the **Mac's Secure Enclave** by [`auren-keyd`](keyd/). | ✅ |
| Data encrypted at rest | Event contents and connector tokens are **AES-256-GCM**. Each job gets its own key, derived with HKDF-SHA256. | ✅ |
| (no user-facing audit log) | **A tamper-evident log.** Each event carries an HMAC over the one before it, so an edited, deleted or reordered event fails `GET /v1/audit/verify`. | ✅ |
| Metadata stays standard | Event id, time and kind stay readable so the log can be ordered; the contents don't. | ✅ |
| Mail and Calendar can't be end-to-end (interop) | **What leaves is stated plainly:** model requests go to Meta's Model API, and app calls go to Google and Slack. Each crossing is recorded in the outbound ledger, with contents never stored. | ✅ |
| Recovery key | `auren-keyd recovery` prints a 52-character recovery code once; `restore` seals it to a new Mac. | ✅ CLI · ⏳ in the app |
| Trusted devices | **Pairing** with a one-time code shown on the Mac. Each iPhone and Apple Watch holds a **Secure Enclave key** and signs a fresh challenge on every connection. Revoke any device from the Mac. | ✅ |
| Approve on a trusted device | **Every send is signed by the device's Secure Enclave**, over the decision and the summary it showed. A spoken yes, a stolen token or an injected instruction can't make that signature. | ✅ |

## What's protected, and how
- **Master key.** `auren-keyd` creates a P-256 key inside the Secure Enclave and seals a random 256-bit master key to it with ECIES: ECDH with a one-time key, HKDF-SHA256, then AES-256-GCM. The two files in `.auren-keys/` (mode 0700) are useless on any other Mac. Core reads the key into memory at start-up and never writes it out.
  - Without a Secure Enclave (Linux, CI), set `AUREN_SECRET`.
  - As a last resort Core keeps a key file next to the database and prints a warning saying so.
- **Event log.** Every event's contents are encrypted, with id, session, time and kind bound in as associated data. A chain of HMAC-SHA256 links covers every field. Ids are assigned one by one, so a gap means a deleted event.
  - **Limit:** the newest events could be cut off without breaking the chain. Every device sees the chain's head (`head`), so a shorter chain than the one a device already saw stands out.
- **Connector tokens.** Google and Slack tokens are encrypted in their own table under their own derived key. They never reach a surface, a log line or the model.
- **Trusted devices.** Pairing can only start on the Mac itself. Codes are six digits, last five minutes, work once, and are cancelled after five wrong tries. Core stores each device's P-256 public key. The device signs `auren-hello\n<nonce>\n<id>` on connect and `auren-approve\n<request>\n<1|0>\n<sha256(summary)>` for each answer. It also signs what it uploads: camera frames (`auren-frame\n<request>\n<sha256(jpeg)>`) and the watch's hold-to-talk clips (`auren-clip\n<id>\n<timestamp>\n<sha256(pcm)>`). Core refuses a clip more than 60 s old and any repeat, so a clip relayed through the iPhone can't be changed or replayed. The button's verb (Post, Invite, Confirm) isn't signed and doesn't need to be: the summary it sits under is. Connections relayed by a tunnel or proxy count as remote, so a tunnel can't pass for the Mac. The full flow is in the [Surface Protocol](spec/surface-protocol.md#trusted-devices-v01).
- **Voice.** The microphone streams only while you hold to talk, and a device off the Mac must sign the voice channel's challenge. Core relays the audio to Muse Voice Transcribe and asks for metadata-only logging (`zdrOverride`). Core keeps the resulting text in the encrypted log and never stores the audio.
- **Forget everything.** `auren-keyd forget` deletes the sealed key. Without it, the log and the tokens can't be decrypted; this is crypto-shredding.

## Logging
| Log | Contents | Never contains |
|---|---|---|
| Audit log (`auren.db`) | Every utterance, tool call, approval, receipt and reply: encrypted and chained | — |
| Operational log (stdout, plus `AUREN_LOG_FILE`) | Trace id, latency, model, token counts (one `usage` line per model call), tool name, tier, outcome | Tokens, keys or message bodies. Anything shaped like a secret is scrubbed, and long strings are cut. |
| Outbound ledger (`/v1/outbound`) | Service, operation (ids removed from paths; for MCP, the tool and `stdio` or the host), bytes sent, time, status, and for model calls the model and its input and output token counts | Contents |

## Spend limits
Every model call goes through one wrapper (`ledgerMuse`), so the agent loop, the fast ack, vision, computer use and Auren Memory's Spark Open calls all land in the outbound ledger with their token counts. `/v1/trust` shows the totals, per model. Muse prices aren't published, so the limits are in tokens, not money:
- `AUREN_TOKEN_ALARM`: once the total passes it, Core logs one warning event and the console shows a banner.
- `AUREN_TOKEN_LIMIT`: once the total reaches it, Core refuses new commands with a clear error (HTTP 429 on `/v1/command`). Approvals already waiting still resolve, so nothing is left half-asked.

## The public sandbox
`make sandbox` (`AUREN_SANDBOX=true`) serves `/try` for people who can't connect their own accounts, such as judges. It treats every visitor as hostile.
- **Nothing real exists in it.** Sandbox mode starts before Core opens `auren.db`, the master key, the connector tokens, paired devices, the camera or the driver, and never creates them, whatever `.env` says. Only `/try`, `/try/api/*`, `/health` and the brand assets answer; every other route, `/v1/*` included, is a 404, and every WebSocket upgrade is dropped. A test enumerates the real Core's routes and checks each one.
- **Each visitor is isolated.** A visitor is a 128-bit random id held in the page's session storage. Each gets their own fictional demo world, in-memory event log and simulated phone, watch and glasses. A tap or an undo only reaches that visitor's own world. Worlds expire after 30 minutes without a command, tap or undo.
- **Limits.** Per address: commands a minute and a day, requests a minute and three sessions. Overall: visitors at once and commands at once. Commands are at most 280 characters. The live engine spends at most `AUREN_SANDBOX_TOKEN_BUDGET` tokens, then replays.
- **Addresses.** `X-Forwarded-For` is ignored unless `AUREN_TRUST_PROXY` says how many proxies are in front, and then only the entry those proxies added is believed. IPv6 addresses are limited per /64.
- **The page** is served with a strict Content-Security-Policy (a per-response script nonce, no outside origins, no framing), and it escapes everything it shows.
- **The tier gate is unchanged.** A send still waits for a tap, now on the simulated watch, and the planted-email case shows Core holding the post.

## Safety in the agent
- **Tiers are enforced by Core, not the model.** Reads run on their own. Writes leave a receipt and an Undo. Sends wait for a tap ([ARCHITECTURE.md §10](ARCHITECTURE.md#10-safety-model)).
- **Untrusted content.** Email, chat, calendar and web content reaches the model wrapped as data, never as instructions.
- **Computer use** stops before any commit and never solves a CAPTCHA ([driver/src/guard.ts](driver/src/guard.ts)).
- **Secrets in git.** A gitleaks pre-commit hook and CI scan block commits that contain keys.

## MCP servers
You can connect MCP servers you already use ([docs/mcp-setup.md](docs/mcp-setup.md)). Auren treats each one as a stranger with good intentions: what a server says about its tools is **a claim, not a fact**. The MCP spec says the same thing: clients shouldn't trust tool annotations from servers they don't trust.
- **Every MCP tool asks for a tap by default.** All of a server's tools are send tier unless you set `"trust_annotations": true` for that server in `mcp.json`. Then, and only then, a tool the server marks `readOnlyHint: true` runs on its own (read). A hint that isn't exactly `true` doesn't count.
- **Nothing from MCP is ever write.** Write means "runs on its own, with an Undo", and Auren can't undo a call on someone else's server. So it's read or send, never write.
- **Results are untrusted data.** Every MCP result reaches the model wrapped as data, never as instructions, like email and web content. Error text from a server is labelled as the server's words. Images and files are described, not passed on, and results are capped at 16,000 characters.
- **Names and descriptions are untrusted too** (tool poisoning). Before the model sees them, Auren removes control, zero-width, bidi and tag characters, caps descriptions at 400 characters, and maps names to the Responses function-name charset with a stable hash. It drops schema defaults, examples and `$ref`s, which are free text the model would otherwise read. The namespace description says which server the tools came from. A server can't take the name of one of Auren's own apps (`slack`, `calendar`, …).
- **The tap shows what you're approving.** It names the server, the tool and up to four of its arguments, each cut to 60 characters: `Run add_entry in Journal (MCP) · text "Moved office hours to 3:15…" · date "2026-11-03"`. Your device signs that exact text, as for any send.
- **Secrets stay out of logs.** `mcp.json` can hold tokens (in `env` or `headers`), so it's gitignored, and `mcp.example.json` is the committed template. Env values, header values and URL credentials are scrubbed from anything Auren logs or shows. `/v1/connections` lists names, states, tool counts and trust mode, never commands, URLs, env or headers.
- **A stdio server gets a minimal environment** (PATH, HOME, USER, SHELL, TERM, LOGNAME) plus its own `env`, so Core's keys never reach it. Plain `http://` is allowed only for a server on this Mac, and redirects are refused, so headers can't follow a redirect to another host.
- **Every MCP request is one row in the outbound ledger**: the server, `tools/list` or `tools/call <tool>`, where it went (`stdio` or the host), bytes sent and time. Never the arguments or the result.
- **Auren offers servers nothing back.** No sampling, roots or elicitation, so a server can't ask Muse anything or read your files through Auren. Server `instructions` are never shown to the model.
- **`mcp.json` is as sensitive as `.env`.** Anything in it runs on your Mac with your user's rights. Only add servers you'd run yourself.

## Threat model
| Threat | What stops it |
|---|---|
| Someone copies `auren.db` | Contents and tokens are ciphertext; the key is sealed to this Mac's Secure Enclave |
| Someone edits or deletes a log entry | `verify` fails at that event |
| A web page or email tells Auren to send something | It arrives as untrusted data. Sends need a tap signed by a paired device's Secure Enclave. |
| A stolen device token, or someone else's phone | Not enough: a device has to prove a paired hardware key, and you can revoke it from the Mac |
| A compromised relay (such as the iPhone relaying the watch) changes what the watch shows | The watch signs a hash of the summary it displayed, so Core rejects the mismatch |
| Someone tunnels into Core and claims to be the Mac | Forwarded traffic is treated as remote and must pair |
| A secret leaks into logs | Redaction by name and by shape; long strings are cut |
| A connected MCP server lies about its tools, or hides instructions in them | Its read-only hints count only if you trusted that server; anything else asks for a tap. Names, descriptions and schemas are cleaned and capped, and results arrive as untrusted data |
| Model provider retention | Out of Auren's control: content sent to Meta isn't end-to-end encrypted. The ledger shows what was sent and when. |
| A runaway loop or a leaked key burns the credits | Token counts in the ledger; `AUREN_TOKEN_ALARM` warns and `AUREN_TOKEN_LIMIT` stops new commands |
| A sandbox visitor tries to reach the real Core | Sandbox mode never creates it: no log, keys, connectors, devices, camera or driver, and every other route is a 404 |
| One visitor sees or changes another's world | A world per visitor, named only by a 128-bit secret; taps and undo resolve within it |
| A visitor floods the sandbox or forges their address | Per-address and global limits; `X-Forwarded-For` trusted only through `AUREN_TRUST_PROXY` hops; a visitor cap that one address can't fill |

## Limits
- **Meta sees what it processes.** Commands, and the email, chat, calendar and web content Auren works on, are processed by Meta's Model API. They are not end-to-end encrypted to Meta. While Auren runs on free hackathon credits, that content may be used for product improvement; check Meta's terms.
- **Plain HTTP on the LAN.** On your network Core speaks plain HTTP, protected by a bearer token (`AUREN_TOKEN`) and device signatures. Off the LAN, reach it only through a TLS tunnel.
- **API keys in `.env`.** `MODEL_API_KEY` and other API keys sit unencrypted in `.env` on the Mac (gitignored, and blocked from commits by the secret scan).
- **Rotate exposed keys.** Rotate any key that was ever pasted anywhere: a chat, an issue, a screenshot or a log.
- **Core lives on your Mac.** Auren works only while the Mac is awake and reachable; there is no hosted Core.

Found a problem? Open a private security advisory on the repository.
