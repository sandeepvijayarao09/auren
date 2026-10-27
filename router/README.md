# Auren Router

A small, fast model that reads a command and the devices around you, and answers in one call:

```json
{"apps":["slack","calendar","gmail"],"risk_tier":"send","reply_surface":"watch","needs_vision":false}
```

Core uses the answer to start sooner and smaller. It preloads only those tool namespaces, starts a camera capture in parallel when `needs_vision` is true, shapes the spoken ack, and hints which device should reply. **The router is advisory.** It never grants or lowers a risk tier; each tool's tier in Core is the only authority. If the router is slow (budget 300 ms) or its output fails `parse()`, Core asks Muse Spark instead.

It is a QLoRA fine-tune of **Muse Glimmer**, trained and served on Modal. This is a P1 item, gated on Sun Nov 1, 12 PM PT (gate G2).

```bash
uv run python -m unittest discover -s tests -t .   # 5 tests, no dependencies
```

## Files
| Path | What it is | Status |
|---|---|---|
| `auren_router/schema.py` | The output schema, `parse()` and its checks | ✅ |
| `tests/test_schema.py` | Schema tests | ✅ |
| `rubric.md` | The fixed labelling rubric Muse Wonder follows | ✅ |
| `auren_router/data.py` | Logged commands plus ~3K synthetic ones from `muse-spark-1.3-contributor`, labelled by Wonder | ⏳ Day 6 |
| `auren_router/train.py` | Modal job: QLoRA on Muse Glimmer, H100, 1–2 epochs | ⏳ Day 6 |
| `auren_router/serve.py` | vLLM with the LoRA on Modal, kept warm | ⏳ Day 6 |
| `auren_router/evaluate.py` | 300 held-out examples: Router vs Wonder vs Spark (accuracy, p50, cost per 1K) | ⏳ Day 7 |

Training data stays in `router/data/`, which is not committed. We'll check the Meta model API terms on training with model outputs before the first training run.
