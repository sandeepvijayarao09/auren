# Security

Auren acts for you across your apps and devices, so it is built to earn that trust. The model is Apple's Advanced Data Protection, adapted to an agent. **There is no Auren cloud.** Your keys stay on your devices, everything Auren stores is encrypted, and every action is in a log that proves it hasn't been edited.

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
- **Trusted devices.** Pairing can only start on the Mac itself. Codes are six digits, last five minutes, work once, and are cancelled after five wrong tries. Core stores each device's P-256 public key. The device signs `auren-hello\n<nonce>\n<id>` on connect and `auren-approve\n<request>\n<1|0>\n<sha256(summary)>` for each answer. Connections relayed by a tunnel or proxy count as remote, so a tunnel can't pass for the Mac. The full flow is in the [Surface Protocol](spec/surface-protocol.md#trusted-devices-v01).
- **Voice.** The microphone streams only while you hold to talk, and a device off the Mac must sign the voice channel's challenge. Core relays the audio to Muse Voice Transcribe and asks for metadata-only logging (`zdrOverride`). Core keeps the resulting text in the encrypted log and never stores the audio.
- **Forget everything.** `auren-keyd forget` deletes the sealed key. Without it, the log and the tokens can't be decrypted; this is crypto-shredding.

## Logging
| Log | Contents | Never contains |
|---|---|---|
| Audit log (`auren.db`) | Every utterance, tool call, approval, receipt and reply: encrypted and chained | — |
| Operational log (stdout, plus `AUREN_LOG_FILE`) | Trace id, latency, model, token counts, tool name, tier, outcome | Tokens, keys or message bodies. Anything shaped like a secret is scrubbed, and long strings are cut. |
| Outbound ledger (`/v1/outbound`) | Service, operation (ids removed from paths; for MCP, the tool and `stdio` or the host), bytes sent, time, status | Contents |

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
| Model provider retention | Out of Auren's control. The ledger shows exactly what was sent and when. |

Found a problem? Open a private security advisory on the repository.
