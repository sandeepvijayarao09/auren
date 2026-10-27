# Developing Auren

## Prerequisites
| Tool | For | Install |
|---|---|---|
| Node 24+ | Core and the driver (TypeScript runs directly, with no build step) | `brew install node` |
| Xcode 27 + XcodeGen | The iPhone and Apple Watch apps | App Store, `brew install xcodegen` |
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
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SLACK_BOT_TOKEN` | Day 2 | Live connectors, demo workspace only |
| `BASETEN_API_KEY` | Day 7 | Auren Memory on Muse Spark Open |

Keys live only in `.env` on the machine running Core. Surfaces never hold a model key.

## Tests
| Suite | Command | Count |
|---|---|---|
| Core (scripted Muse, surfaces, eval cases) | `cd core && npm test` | 17 |
| Driver (commit guard, CAPTCHA) | `cd driver && npm test` | 6 |
| Router (output schema) | `cd router && uv run python -m unittest discover -s tests -t .` | 5 |
| AurenKit (protocol, client state) | `cd apps/apple/AurenKit && swift test` | 10 |

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
