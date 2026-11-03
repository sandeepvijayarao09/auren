# Auren Router

A small, fast model that reads a command and the devices around you, and answers in one call:

```json
{"apps":["slack","calendar","gmail"],"risk_tier":"send","reply_surface":"watch","needs_vision":false}
```

Core uses the answer to start sooner and smaller, as hints only:
- **Preload.** The named namespaces' deferred tools go straight into Wonder's inventory instead of behind `tool_search`.
- **Camera.** When `needs_vision` is true and a camera is online, the capture starts at once, so `glasses.look` finds a frame already in flight (used only if it's under 3 s old).
- **Ack.** "On it: Slack, calendar and Gmail." comes from the route, so Spark isn't asked for one.

**The router is advisory.** It never grants, raises or lowers a risk tier; each tool's tier in Core is the only authority, and a router that says `read` for a Slack post still gets you a tap (`core/src/router/wiring.test.ts`). `reply_surface` is recorded and evaluated, but the device picker still chooses where the reply goes.

It's meant to be a QLoRA fine-tune of **Muse Glimmer**, trained and served on Modal. Until that runs, Core routes with Muse Spark (with a key) or with simple rules.

## How Core routes
| Order | Source | When | Budget |
|---|---|---|---|
| 1 | Glimmer LoRA on Modal (OpenAI-compatible `/v1/chat/completions`) | `AUREN_ROUTER_URL` is set | 300 ms (`AUREN_ROUTER_BUDGET_MS`); Wonder's first turn waits at most this long to preload |
| 2 | Muse Spark 1.3 (Responses API) | a Meta key is set | 1 s, and Wonder never waits on it; it shapes the ack and starts the camera |
| 3 | Rules (`rulesRoute` in `core/src/router/router.ts`) | always | instant |

Every answer must pass the same schema (`schema.py` here, zod `Route` in Core); anything off-schema, slow or failed falls to the next source. Each outbound call gets an outbound ledger row, and each attempt gets one `router.route` line in the ops log (source, ms, ok, reason), never the command.

## Files
| Path | What it is | Status |
|---|---|---|
| `auren_router/schema.py` | The output schema, `parse()` and its checks | ✅ |
| `auren_router/system_prompt.txt`, `auren_router/prompt.py` | **The one prompt**, shared by data, training, serving, evaluation and Core (`core/src/router/prompt.ts` reads the same file). Goldens in both test suites pin it. | ✅ |
| `rubric.md` | The fixed labelling rubric Muse Wonder follows | ✅ |
| `seed/seed.jsonl` | 129 hand-written, labelled examples covering the rubric (7 apps, 3 tiers, 4 reply surfaces, vision, 15+ device situations). Always held out: the test anchor. | ✅ |
| `auren_router/data.py` | Builds `data/`: `seed`, `logged` (Core's export), `synthetic` (~3K from `muse-spark-1.3-contributor`, labelled by Wonder), `build` (dedupe, split 85/5/10 by hash, 100 to hand-check) | ✅ code · ⏳ synthetic needs a key |
| `auren_router/train.py` | Modal job: QLoRA, H100, 1–2 epochs, loss on the answer only | ✅ code · ⏳ not run (no Modal credits) |
| `auren_router/serve.py` | vLLM with the LoRA on Modal, one container kept warm | ✅ code · ⏳ not deployed |
| `auren_router/evaluate.py` | Router vs Wonder vs Spark: per-field accuracy, exact match, p50 / p95, cost per 1K from prices you pass | ✅ · `--fake` runs with no network |
| `tests/` | Schema, prompt goldens, Core parity cases (`parity.json`), data, splits, synthetic loop, evaluate scoring, the Modal helpers | ✅ 34 tests |

```bash
uv run python -m unittest discover -s tests -t .   # 34 tests, no dependencies
```

## Build the data
```bash
cd router
uv run python -m auren_router.data seed                                     # check the seed, copy it to data/
curl -s http://127.0.0.1:8787/v1/router/examples > data/logged.raw.jsonl    # on the Mac running Core
uv run python -m auren_router.data logged --file data/logged.raw.jsonl     # or --url http://127.0.0.1:8787/v1/router/examples
MODEL_API_KEY=… uv run --with openai python -m auren_router.data synthetic --n 3000
uv run python -m auren_router.data build                                    # train / val / test + handcheck.jsonl
```
- **Logged examples are free labels.** Core records the devices online on every utterance, then `GET /v1/router/examples` turns each command into an example from what actually happened: the namespaces of the tools it called, the highest tier among them (a declined send still counts), the surface the reply was spoken on, and whether `glasses.look` ran. Overlapping or failed commands are left out.
- **The export holds command text.** It answers only on this Mac (a tunnelled request gets 403), and `router/data/` is in `.gitignore`. Demo data only: fictional people such as Priya Raman and Prof. Lee, never real student data.
- **Synthetic** asks the generator for 10 commands per (apps, tier, device situation) cell of an even grid, has Wonder label each with `rubric.md` word for word, drops anything `parse()` rejects, dedupes, and appends, so a stopped run resumes.
- **Splits** go by a hash of the normalised command, so one command never lands in two splits. The seed, and any command that repeats a seed command, is always test.

## Train, serve, evaluate (when Modal credits land)
```bash
# TODO first: check the Meta model API terms on training with model outputs.
AUREN_ROUTER_BASE=<base model> uv run --with modal modal run auren_router/train.py --i-checked-the-terms
modal secret create auren-router AUREN_ROUTER_KEY=<a long random string>
AUREN_ROUTER_BASE=<base model> uv run --with modal modal deploy auren_router/serve.py
uv run python -m auren_router.evaluate data/test.jsonl \
  --endpoint router "$AUREN_ROUTER_URL" auren-router --key-env router=AUREN_ROUTER_KEY --hourly router=<USD per GPU hour> \
  --endpoint wonder https://api.meta.ai/v1 muse-wonder-1.0 --api wonder=responses --key-env wonder=MODEL_API_KEY --price wonder=<in>,<out> \
  --endpoint spark https://api.meta.ai/v1 muse-spark-1.3 --api spark=responses --key-env spark=MODEL_API_KEY --price spark=<in>,<out>
```
- **The base model is a required setting.** Muse Glimmer's exact model id and Hugging Face repo aren't known yet, so nothing defaults to one. Pass a Hugging Face repo id, or a path inside the `auren-router` Modal volume (`/vol/...`). A gated repo needs `AUREN_ROUTER_HF_SECRET=<modal secret with HF_TOKEN>`.
- **Training** refuses to start without `--i-checked-the-terms`. It writes the adapter and `meta.json` (base, prompt hash, counts, settings) to `/vol/adapters/auren-router`.
- **Serving** runs `vllm serve <base> --enable-lora --lora-modules auren-router=/vol/adapters/auren-router` on an L40S (`AUREN_ROUTER_GPU` to change it), `min_containers=1`, with the API key from the `auren-router` secret. Then set `AUREN_ROUTER_URL=https://<workspace>--auren-router-serve.modal.run/v1` and `AUREN_ROUTER_KEY` in Core's `.env`.
- **Prices are flags.** `--price` is USD per 1M input,output tokens; `--hourly` is USD per GPU hour, spread over the measured latency and `--concurrency`. Without one, cost shows `n/a`.

Training data stays in `router/data/`, which is not committed.
