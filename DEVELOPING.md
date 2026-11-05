# Developing Auren

## Prerequisites
| Tool | For | Install |
|---|---|---|
| Node 24+ | Core and the driver (TypeScript runs directly, with no build step) | `brew install node` |
| Xcode 27 + XcodeGen | The iPhone and Apple Watch apps, and `auren-keyd` | App Store, `brew install xcodegen` |
| uv | The router (Python 3.12+) | `brew install uv` |
| gitleaks | The pre-commit secret scan | `brew install gitleaks` |

## First run
```bash
make setup      # installs everything, turns on the secret scan, creates .env
# add MODEL_API_KEY from dev.meta.ai to .env
make dev        # Core on http://127.0.0.1:8787
make test       # every suite that needs no API key or device
```

Open http://127.0.0.1:8787 for the console. Open a second tab at `/?kind=watch` to get a watch, then send a command from the first tab and approve it on the "watch". Tick **go offline** on the watch to see the approval move.

## Environment
| Variable | Needed | What it does |
|---|---|---|
| `MODEL_API_KEY` | Yes | Meta Model API key. Without it, Core still runs but answers every command with a setup error. |
| `AUREN_TOKEN` | For devices | Lets phones, watches and the driver connect over the network. Without it, Core binds to 127.0.0.1 only. |
| `AUREN_AGENT_MODEL`, `AUREN_FAST_MODEL` | No | Override `muse-wonder-1.0` and `muse-spark-1.3` |
| `AUREN_DB` | No | SQLite path for the event log (default `auren.db`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | For real Google | A Desktop OAuth client; swaps the demo calendar for the real one. Setup: [docs/google-setup.md](docs/google-setup.md) |
| `SLACK_BOT_TOKEN` | For real Slack | The demo workspace's bot token; swaps the demo Slack for the real one. Setup: [docs/slack-setup.md](docs/slack-setup.md) |
| `AUREN_SECRET` | No | A 64-hex-character master key. On a Mac, leave it empty and `auren-keyd` seals one to the Secure Enclave. Elsewhere, set it, or Core falls back to a key file and warns you. |
| `AUREN_KEYD` | No | Path to the `auren-keyd` binary, if not `keyd/.build/release/auren-keyd` |
| `AUREN_LOG_FILE` | No | Also append the JSON operational log to this file |
| `AUREN_TZ` | No | Your time zone, if this Mac's is wrong |
| `AUREN_ASR_KEYWORDS` | No | Extra names for speech recognition to favour, comma-separated (people, channels) |
| `AUREN_ASR_METADATA_ONLY` | No | Set to `false` if your Meta account rejects metadata-only logging for voice |
| `BASETEN_API_KEY` | For Spark Open | Auren Memory on Muse Spark Open. Without it, recaps are built locally. |
| `AUREN_DRIVER_ALLOW` | For computer use | Sites the browser driver may open, comma-separated. More settings in [driver/README.md](driver/README.md#settings). |
| `AUREN_MCP_CONFIG` | No | The MCP servers to connect; default `mcp.json` at the repo root. Setup: [docs/mcp-setup.md](docs/mcp-setup.md) |
| `AUREN_ROUTER_URL`, `AUREN_ROUTER_KEY`, `AUREN_ROUTER_MODEL`, `AUREN_ROUTER_BUDGET_MS` | No | The Glimmer router on Modal (OpenAI-compatible). Without it, Muse Spark routes when there's a key, else rules. Default budget 300 ms. [router/README.md](router/README.md) |
| `AUREN_TOKEN_ALARM`, `AUREN_TOKEN_LIMIT` | No | Spend limits in model tokens: a one-time warning, and a hard stop for new commands |
| `AUREN_SANDBOX` and `AUREN_SANDBOX_*`, `AUREN_TRUST_PROXY` | For `make sandbox` | The public `/try` sandbox: token budget, commands per minute and day, visitors at once, and how many proxies to trust. See [docs/runbook.md](docs/runbook.md) |
| `BASETEN_BASE_URL`, `AUREN_MEMORY_MODEL` | No | Override `https://inference.baseten.co/v1` and `meta-models/muse-spark-open-1026` |

Keys live only in `.env` on the machine running Core. Surfaces never hold a model key.

## Tests
| Suite | Command | Count |
|---|---|---|
| Core (scripted Muse, surfaces, eval cases and runner, memory, vision, computer use, router, MCP bridge, sandbox, spend limits, Google, Slack, Gmail, tape, voice and watch clips, encrypted log, keys, ledger, redaction, pairing, signed sockets) | `cd core && npm test` | 299 |
| keyd (sealing, recovery codes) | `cd keyd && swift test` | 6 |
| Driver (commit guard, CAPTCHA, the executor on real Chromium, the Core connection) | `cd driver && npm test` | 20 |
| Router (schema, prompt, data, evaluate) | `cd router && uv run python -m unittest discover -s tests -t .` | 34 |
| AurenKit (protocol, client state, device identity, voice, relay, speech, camera capture, bystander blur, watch clips, timeline media, approval verbs) | `cd apps/apple/AurenKit && swift test` | 55 |

`cd core && npm run eval` plays the eval cases (scripted without a key, live with one) and rewrites `eval/results.md`.

`make check` runs all of them, both type checks and the secret scan, which is the same as CI minus the Swift suite.

## Conventions
- **TypeScript.** Use only erasable syntax (no enums or namespaces), since Node strips types and doesn't compile them. Parse everything that crosses a boundary with zod. Relative imports end in `.ts`.
- **Swift.** Swift 6 with strict concurrency. Code that touches UI or `SurfaceClient` runs on the main actor. Use system colors for states.
- **One log.** Every action is an event appended to the log. Don't keep side state a surface can't rebuild from `/v1/events`.
- **Tiers are law.** Only a tool's `tier` decides whether it asks. Nothing the model, router or a web page says can change that.
- **Untrusted text.** Any tool result that carries outside content sets `external: true`.
- **Names.** Follow [brand/README.md](brand/README.md#naming). In particular: device picker, not output router; Auren Memory, not Memory Hub; "Uses Muse models from Meta", never "Powered by".
- **Commits.** Small and present tense, such as "Add Slack connector". The history is the record that every line was written during the event.

## Add a surface
Any device that can open a WebSocket can join. See [spec/surface-protocol.md](spec/surface-protocol.md) and the [20-line example](spec/examples/minimal-surface.html). Send `hello` with a manifest, then a heartbeat every second, and handle the messages your outputs support.

## Add a tool or app
See [core/README.md](core/README.md#add-a-tool).
