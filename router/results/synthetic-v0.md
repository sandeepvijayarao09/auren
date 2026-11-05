# Synthetic v0: the first live synthetic set (Nov 4, 2026)

`muse-spark-1.3-contributor` wrote the commands (minimal effort). `muse-wonder-1.0` labelled each one with `rubric.md` word for word (low effort). Everything ran on the Meta Model API (`https://api.meta.ai/v1`, Responses API). The data is in `router/data/`, which is gitignored and not committed.

```bash
cd router
MODEL_API_KEY=… uv run --with openai python -m auren_router.data synthetic --n 300 --workers 8
uv run python -m auren_router.data build
cat data/test.jsonl data/synthetic.jsonl | (cd ../core && node src/router/rules-answers.ts) > data/rules.answers.jsonl
uv run python -m auren_router.evaluate data/test.jsonl --answers rules=data/rules.answers.jsonl
```

## The run
| | |
|---|---|
| Generator calls | 32 (10 commands each) |
| Commands labelled | 320 |
| Kept | **300** (all of them parsed: 0 off-schema, 0 failed calls) |
| Dropped | 20, counted as "duplicate or over n". The last wave of 8 calls produced 80 for the 20 slots left, so these are most likely past `--n`. The counter now reports the two reasons separately. |
| Wall time | 236 s with 8 workers (about 0.8 s per kept example) |
| Spark tokens | 6,145 in, 17,250 out |
| Wonder tokens | 198,523 in, 157,796 out (about 620 in and 490 out per label; most of the output is reasoning) |
| Cost | ~380K tokens in total. Muse prices aren't published, so this doc reports tokens, not dollars. The full 3K run would use about 3.8M tokens. |

**What the live API needed.** Nothing broke. The model ids, `responses.create(instructions=, input=, reasoning={"effort"})` and `output_text` all worked as written, and 8 workers hit no rate limits. Two changes:
- **Accounting.** `synthetic` used to swallow every failure silently. It now counts tokens per model and the reason for each drop (`Usage`), and prints both along with the wall time.
- **Generator prompt.** In 58 of 300 commands the text says "my glasses" when no glasses are online (only a phone camera is). The labels still follow the rubric: `glasses` is the camera namespace, and `needs_vision` is true only when a camera is online. But the text is unrealistic. `gen_input` now adds "Only mention a device that is online below." for vision cells. v0 was generated before this change.

## Label distribution (300)
| Field | Counts |
|---|---|
| apps (per app) | glasses 121, slack 111, calendar 83, memory 64, gmail 58, browser 55, **receipts 0** |
| apps per command | 1: 121 · 2: 166 · 3: 13 |
| risk_tier | read 167, send 71, write 62 |
| reply_surface | phone 120, web 72, glasses 60, watch 48 |
| needs_vision | true 121 (always with `glasses`, always with a camera online), false 179 |
| origin | phone 112, web 78, glasses 60, watch 50 |

- **Receipts is missing.** `plan()` draws each cell's app set at random. In the 32 cells a 300 run uses, it never drew `("receipts",)`, so there are no undo commands. This is a gap from the small batch; the 3K run should fill it, so check its coverage.
- **Tiers lean to read.** The grid asks for an even read/write/send split, but "at most send" lets the generator write lower-tier commands, and Wonder labels what the text says. So 56% are read, against 33% planned.
- **The surface is almost always the origin** (292/300). Only 8 went to the phone for long or visual answers (6 typed on the web, 2 spoken into the watch). The rubric rarely sends an answer away from the origin, so the data has few such cases.

## 10 random examples, checked by hand (seed 42)
| Situation (origin · online, * active) | Command | Label | Verdict |
|---|---|---|---|
| phone · phone* | Search for Priya Raman's study guide post and save a note that I already reviewed it. | slack, memory · write · phone | ✅ |
| phone · glasses, phone* | Pull up what I've got saved about Jordan's office-hours swap? | memory · read · phone | ✅ |
| web · watch, phone, web* | Look through my glasses at this poster and put the date on my calendar. | glasses, calendar · write · web · vision | ⚠️ label fine, text names glasses that aren't online (the prompt fix above) |
| watch · watch* | Show my calendar for Monday and open Jordan's shared project doc link in the browser? | calendar, browser · read · watch | ⚠️ "show" is visual, but with no phone online the watch is right |
| glasses · glasses*, phone | Jot this down in memory: Priya's group meets Tuesdays at four. | memory · write · glasses | ✅ ("this" here isn't something in view) |
| watch · watch* | Any new messages in #office-hours since this morning? | slack · read · watch | ✅ |
| phone · phone* | Google the campus tutoring signup page and remember I prefer evening slots. | browser, memory · write · phone | ✅ |
| web · web* | Check my calendar and tell me what I've got on Friday afternoon? | calendar · read · web | ✅ |
| watch · watch*, phone, web | Check my Gmail for Prof. Lee's feedback and cross-check with the #cs5800-tas thread. | gmail, slack · read · phone | ✅ (long answer goes to the phone) |
| web · watch, phone, web* | Read that lab safety sign with my glasses and pull up the full policy in my browser. | glasses, browser · read · phone · vision | ⚠️ glasses not online again; phone for a visual answer is fine |

**10 of 10 labels are defensible under the rubric.** Two have unrealistic command text (fixed in the prompt for the next run) and one is a judgement call on the surface. The 100 examples in `data/handcheck.jsonl` still need reading before any training run.

## Splits (`data.py build`)
| Split | n | From |
|---|---|---|
| train | 258 | synthetic |
| val | 13 | synthetic |
| test | 158 | the 129-example seed + 29 synthetic |

## Baseline: Core's rules router (`rulesRoute`)
Core's own `rulesRoute` scores the examples through the new `core/src/router/rules-answers.ts`, read in with `evaluate.py --answers`. This is the real TypeScript fallback, not a Python port.

| Set | n | Apps | Tier | Surface | Vision | Exact | Send missed |
|---|---|---|---|---|---|---|---|
| test (all) | 158 | 86.1% | 98.1% | 99.4% | 98.1% | 84.8% | 2 |
| test, seed part | 129 | 95.3% | 99.2% | 99.2% | 100.0% | 94.6% | 1 |
| test, synthetic part | 29 | 44.8% | 93.1% | 100.0% | 89.7% | **41.4%** | 1 |
| all 300 synthetic | 300 | 51.7% | 83.7% | 97.0% | 91.7% | **45.3%** | 14 |

**The rules were tuned on the seed (94.6%), and they get under half of the synthetic commands right (45.3%).** The data covers a lot of phrasing that the hand-written seed doesn't. On the 300 synthetic, the rules' apps misses are mostly real gaps in the rules, not noisy labels:
- Vision commands that name the glasses but use no deictic word the rules know ("Read that lab safety sign through glasses and find the full policy online" gives `[]`): 19 missed `needs_vision`, and 16 missed `glasses`.
- Words for memory ("remember", "what you remember about", "jot this down in memory"): 17 missed `memory`.
- "online", "google", "open the registration link" for the browser: 18 missed `browser`.
- Tier: 30 commands the rules call read are write or send by the label (for example "save a note", "remember I prefer").

Some misses are judgement calls, where the label is debatable: "Look up Prof. Lee's office hours for this week" gave Wonder `calendar` and the rules `browser`. An eval that only has the seed overstates how good the rules are.

## Before training
- **TODO: check the Meta model API terms on training with model outputs.** Both the commands and the labels come from Muse models. `train.py` still refuses to start without `--i-checked-the-terms`, and that guard stays.
- Run the full 3K with the fixed generator prompt, then check that receipts and write/send coverage are there.
- Read `data/handcheck.jsonl` (100 train examples).
