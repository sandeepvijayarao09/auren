# Muse decisions bake-off (Nov 4 2026)

Core's exact router request (`SYSTEM` instructions, `renderUser` input, `max_output_tokens: 400`) against
`https://api.meta.ai/v1/responses`, 129 seed examples, 4 concurrent requests per model, models run one after
another. Script: `core/src/router/bakeoff.ts`; raw per-example rows in `raw/`. Apps must match in order, as in
`evaluate.py`. "<2.5 s" = answered, parsed and inside `SPARK_BUDGET_MS`. `reasoning: {effort: "none"}` is rejected
(HTTP 400) by every model; "omitted" sends no `reasoning` field (default effort), run on the 30-example subset.

| Model | Reasoning | n | apps | tier | surface | vision | exact | parse fail | p50 ms | p95 ms | <2.5 s | out tok (reasoning) | in tok |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| muse-wonder-1.0 | minimal | 30 | 83.3 | 96.7 | 96.7 | 100.0 | **80.0** | 0.0 | 2066 | 2781 | 90.0 | 138 (103) | 299 |
| muse-spark-1.3 | minimal | 129 | 68.2 | 82.9 | 79.8 | 82.9 | **65.1** | 17.1 | 3156 | 4877 | 25.6 | 283 (255) | 299 |
| muse-spark-1.3-contributor | minimal | 129 | 62.8 | 78.3 | 76.0 | 78.3 | **60.5** | 21.7 | 3369 | 5624 | 27.9 | 284 (258) | 299 |
| muse-spark-1.2 | minimal | 129 | 62.0 | 70.5 | 65.9 | 70.5 | **58.1** | 29.5 | 1679 | 3028 | 67.4 | 275 (251) | 299 |
| muse-spark-1.2-contributor | minimal | 129 | 58.9 | 71.3 | 67.4 | 71.3 | **55.8** | 28.7 | 1801 | 3408 | 62.0 | 272 (248) | 299 |
| muse-spark-1.1 | minimal | 129 | 16.3 | 16.3 | 16.3 | 16.3 | **16.3** | 34.4 | 1271 | 2247 | 15.5 | 277 (255) | 299 | http_err 97
| muse-spark-1.2-contributor | omitted | 30 | 3.3 | 3.3 | 3.3 | 3.3 | **3.3** | 96.7 | 2076 | 2787 | 3.3 | 396 (393) | 299 |
| muse-wonder-1.0 | omitted | 30 | 0.0 | 0.0 | 0.0 | 0.0 | **0.0** | 100.0 | 2419 | 3340 | 0.0 | 400 (398) | 299 |
| muse-spark-1.3 | omitted | 30 | 0.0 | 0.0 | 0.0 | 0.0 | **0.0** | 100.0 | 3738 | 5080 | 0.0 | 400 (398) | 299 |
| muse-spark-1.2 | omitted | 30 | 0.0 | 0.0 | 0.0 | 0.0 | **0.0** | 100.0 | 2077 | 2889 | 0.0 | 400 (398) | 299 |
| muse-spark-1.1 | omitted | 30 | 0.0 | 0.0 | 0.0 | 0.0 | **0.0** | 100.0 | 1860 | 2704 | 0.0 | 400 (398) | 299 |
| muse-spark-1.3-contributor | omitted | 30 | 0.0 | 0.0 | 0.0 | 0.0 | **0.0** | 100.0 | 3731 | 4985 | 0.0 | 400 (398) | 299 |

**Same 30 examples as Wonder (exact / <2.5 s):** Wonder 1.0 80.0 / 90.0; Spark 1.3 70.0 / 20.0; Spark 1.2 66.7 / 73.3;
Spark 1.3-contributor 60.0 / 36.7; Spark 1.2-contributor 50.0 / 60.0.

## Findings

- Every Spark parse failure is a 400-token cap hit: Spark reasons about 250 tokens even at minimal effort, and
  sometimes past the cap. Among parsed answers, Spark 1.3 is 78.5% exact; the misses are mostly empty outputs.
- Omitting `reasoning` is unusable: default effort spends the whole cap on reasoning (~100% parse failure).
- Wonder 1.0 at minimal reasons ~100 tokens, never failed to parse, and is both the most accurate and the fastest.
- Spark 1.1 is unmeasured: 97 of 129 requests got HTTP 429 (twice), so its row reflects the rate limit, not the model.
- Spark 1.2 is the fastest Spark (p50 1.7 s) but loses 7 points of exact match to Spark 1.3.

## Recommendation

Default decision model: **`muse-wonder-1.0`, `reasoning: {effort: "minimal"}`, budget 2,500 ms** (keep
`SPARK_BUDGET_MS`). It beats Spark 1.3 by 10 points on the shared 30 and lands 90% of answers in budget vs 20%.
Now `config.decisionModel` (`AUREN_DECISION_MODEL`); `fastModel` (acks, glasses reader) stays Spark 1.3.
Caveats: Wonder measured on 30 examples only, and it shares quota with the agent turn; rerun on all 129 before the
demo, and fall back to `AUREN_DECISION_MODEL=muse-spark-1.2` if Wonder's quota is tight.
