"""Router vs Wonder vs Spark on held-out examples: per-field accuracy, exact match,
p50 / p95 latency and an estimated cost per 1K commands.

  uv run python -m auren_router.evaluate data/test.jsonl \\
    --endpoint router "$AUREN_ROUTER_URL" auren-router --key-env router=AUREN_ROUTER_KEY --hourly router=<USD per GPU hour> \\
    --endpoint wonder https://api.meta.ai/v1 muse-wonder-1.0 --api wonder=responses --key-env wonder=MODEL_API_KEY --price wonder=<in>,<out> \\
    --endpoint spark https://api.meta.ai/v1 muse-spark-1.3 --api spark=responses --key-env spark=MODEL_API_KEY --price spark=<in>,<out>

  uv run python -m auren_router.evaluate router/seed/seed.jsonl --fake     no network: checks the pipeline itself

  (cd core && node src/router/rules-answers.ts < ../router/data/test.jsonl > ../router/data/rules.answers.jsonl)
  uv run python -m auren_router.evaluate data/test.jsonl --answers rules=data/rules.answers.jsonl   Core's rules as the baseline

Every endpoint gets the same prompt Core sends (prompt.messages). Prices are
flags, never built in: --price is USD per 1M input,output tokens; --hourly is
USD per GPU hour for a self-hosted endpoint, spread over the measured latency
and --concurrency. An answer that fails schema.parse() counts as wrong on every
field. Uses only the standard library.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Protocol

from .data import Example, read_jsonl
from .prompt import messages, strip_fences
from .schema import TIERS, parse

FIELDS = ("apps", "risk_tier", "reply_surface", "needs_vision")


@dataclass
class Completion:
    text: str
    input_tokens: int = 0
    output_tokens: int = 0


class Client(Protocol):
    def complete(self, msgs: list[dict]) -> Completion: ...


class HttpClient:
    """An OpenAI-compatible endpoint: chat completions (vLLM, the Router) or the Responses API (Meta)."""

    def __init__(self, base_url: str, model: str, api: str = "chat", key: str = "", effort: str = "minimal", timeout: float = 30.0):
        self.base_url, self.model, self.api, self.key, self.effort, self.timeout = base_url.rstrip("/"), model, api, key, effort, timeout

    def complete(self, msgs: list[dict]) -> Completion:
        if self.api == "responses":
            body = {"model": self.model, "instructions": msgs[0]["content"], "input": msgs[1]["content"], "reasoning": {"effort": self.effort}, "max_output_tokens": 80}
            path = "/responses"
        else:
            body = {"model": self.model, "messages": msgs, "temperature": 0, "max_tokens": 64}
            path = "/chat/completions"
        req = urllib.request.Request(self.base_url + path, data=json.dumps(body).encode(), method="POST", headers={"content-type": "application/json", **({"authorization": f"Bearer {self.key}"} if self.key else {})})
        with urllib.request.urlopen(req, timeout=self.timeout) as res:
            out = json.loads(res.read())
        usage = out.get("usage") or {}
        if self.api == "responses":
            text = out.get("output_text") or " ".join(c.get("text", "") for o in out.get("output", []) if o.get("type") == "message" for c in o.get("content", []) if c.get("type") == "output_text")
            return Completion(text, usage.get("input_tokens", 0), usage.get("output_tokens", 0))
        return Completion(out["choices"][0]["message"]["content"] or "", usage.get("prompt_tokens", 0), usage.get("completion_tokens", 0))


class FakeClient:
    """For --fake and the tests: answers each user prompt from a table (gold labels by default).
    `wrong_every` corrupts every n-th answer's tier, so the scoring has something to catch."""

    def __init__(self, answers: dict[str, str], wrong_every: int = 0, tokens: tuple[int, int] = (400, 30)):
        self.answers, self.wrong_every, self.tokens, self.calls = answers, wrong_every, tokens, 0

    def complete(self, msgs: list[dict]) -> Completion:
        self.calls += 1
        text = self.answers.get(msgs[1]["content"], "")
        if self.wrong_every and self.calls % self.wrong_every == 0 and text:
            raw = json.loads(text)
            raw["risk_tier"] = TIERS[(TIERS.index(raw["risk_tier"]) + 1) % len(TIERS)]
            text = json.dumps(raw)
        return Completion(text, *self.tokens)


@dataclass
class Cost:
    """Inputs for the cost estimate. Nothing here is a real price until you pass one."""

    per_m_in: float | None = None
    per_m_out: float | None = None
    hourly: float | None = None
    concurrency: int = 1


@dataclass
class Report:
    name: str
    n: int = 0
    parsed: int = 0
    correct: dict[str, int] = field(default_factory=lambda: {f: 0 for f in FIELDS})
    exact: int = 0
    # Gold send commands the endpoint called read or write. The tier gate doesn't care, but the ack would undersell.
    send_missed: int = 0
    latencies_ms: list[float] = field(default_factory=list)
    input_tokens: int = 0
    output_tokens: int = 0
    errors: int = 0

    def accuracy(self, f: str) -> float:
        return self.correct[f] / self.n if self.n else 0.0

    def percentile(self, p: float) -> float | None:
        """Nearest-rank percentile of the latencies."""
        if not self.latencies_ms:
            return None
        xs = sorted(self.latencies_ms)
        return xs[max(0, math.ceil(p / 100 * len(xs)) - 1)]

    def cost_per_1k(self, cost: Cost) -> float | None:
        if not self.n:
            return None
        if cost.per_m_in is not None and cost.per_m_out is not None:
            return 1000 * (self.input_tokens / self.n * cost.per_m_in + self.output_tokens / self.n * cost.per_m_out) / 1e6
        if cost.hourly is not None and self.latencies_ms:
            mean_s = sum(self.latencies_ms) / len(self.latencies_ms) / 1000
            return cost.hourly * 1000 * mean_s / 3600 / max(1, cost.concurrency)
        return None


def score(report: Report, gold: Example, answer: str | None) -> None:
    report.n += 1
    if answer is None:
        report.errors += 1
        if gold.label.risk_tier == "send":
            report.send_missed += 1
        return
    try:
        pred = parse(strip_fences(answer))
    except ValueError:
        if gold.label.risk_tier == "send":
            report.send_missed += 1
        return
    report.parsed += 1
    hits = {
        "apps": pred.apps == gold.label.apps,
        "risk_tier": pred.risk_tier == gold.label.risk_tier,
        "reply_surface": pred.reply_surface == gold.label.reply_surface,
        "needs_vision": pred.needs_vision == gold.label.needs_vision,
    }
    for f, ok in hits.items():
        report.correct[f] += ok
    report.exact += all(hits.values())
    if gold.label.risk_tier == "send" and pred.risk_tier != "send":
        report.send_missed += 1


def evaluate(examples: list[Example], clients: dict[str, Client], clock: Callable[[], float] = time.perf_counter) -> dict[str, Report]:
    reports = {name: Report(name) for name in clients}
    for ex in examples:
        msgs = messages(ex.text, ex.context)
        for name, client in clients.items():
            t0 = clock()
            try:
                c = client.complete(msgs)
            except Exception:
                score(reports[name], ex, None)
                continue
            reports[name].latencies_ms.append((clock() - t0) * 1000)
            reports[name].input_tokens += c.input_tokens
            reports[name].output_tokens += c.output_tokens
            score(reports[name], ex, c.text)
    return reports


def _fmt(x: float | None, spec: str) -> str:
    return "n/a" if x is None else format(x, spec)


def table(reports: dict[str, Report], costs: dict[str, Cost]) -> str:
    head = "| Endpoint | n | Valid | Apps | Tier | Surface | Vision | Exact | Send missed | p50 ms | p95 ms | $ per 1K |"
    rows = [head, "|" + "---|" * 12]
    for name, r in reports.items():
        rows.append(
            f"| {name} | {r.n} | {r.parsed / r.n if r.n else 0:.1%} | "
            + " | ".join(f"{r.accuracy(f):.1%}" for f in FIELDS)
            + f" | {r.exact / r.n if r.n else 0:.1%} | {r.send_missed} | {_fmt(r.percentile(50), '.0f')} | {_fmt(r.percentile(95), '.0f')} | {_fmt(r.cost_per_1k(costs.get(name, Cost())), '.4f')} |"
        )
    return "\n".join(rows)


def _pairs(values: list[str], what: str) -> dict[str, str]:
    out = {}
    for v in values:
        name, sep, rest = v.partition("=")
        if not sep:
            sys.exit(f"--{what} takes NAME=VALUE, got {v!r}")
        out[name] = rest
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="auren_router.evaluate", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("examples", type=Path, help="a JSONL of labelled examples, such as data/test.jsonl")
    ap.add_argument("--endpoint", nargs=3, action="append", default=[], metavar=("NAME", "BASE_URL", "MODEL"))
    ap.add_argument("--api", action="append", default=[], metavar="NAME=chat|responses")
    ap.add_argument("--key-env", action="append", default=[], metavar="NAME=ENV_VAR")
    ap.add_argument("--effort", action="append", default=[], metavar="NAME=EFFORT", help="reasoning effort for a responses endpoint (default minimal, as Core's Spark calls)")
    ap.add_argument("--price", action="append", default=[], metavar="NAME=IN,OUT", help="USD per 1M input and output tokens")
    ap.add_argument("--hourly", action="append", default=[], metavar="NAME=USD", help="USD per GPU hour, for a self-hosted endpoint")
    ap.add_argument("--concurrency", action="append", default=[], metavar="NAME=N", help="requests one GPU serves at once (default 1)")
    ap.add_argument("--answers", action="append", default=[], metavar="NAME=FILE", help='precomputed answers, one {"prompt", "answer"} JSON line each (Core\'s rules: core/src/router/rules-answers.ts)')
    ap.add_argument("--fake", action="store_true", help="no network: a fake endpoint that answers with the gold label, wrong every 7th")
    ap.add_argument("--out", type=Path, help="also write the numbers as JSON")
    args = ap.parse_args(argv)

    examples, bad = read_jsonl(args.examples)
    for b in bad:
        print(f"skipped {b}", file=sys.stderr)
    if not examples:
        sys.exit("no examples to evaluate")

    apis, keys, efforts = _pairs(args.api, "api"), _pairs(args.key_env, "key-env"), _pairs(args.effort, "effort")
    clients: dict[str, Client] = {}
    if args.fake:
        gold = {messages(e.text, e.context)[1]["content"]: e.label.to_json() for e in examples}
        clients["fake"] = FakeClient(gold, wrong_every=7)
    for name, path in _pairs(args.answers, "answers").items():
        rows = [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]
        clients[name] = FakeClient({r["prompt"]: r["answer"] for r in rows}, tokens=(0, 0))
    for name, url, model in args.endpoint:
        clients[name] = HttpClient(url, model, apis.get(name, "chat"), os.environ.get(keys.get(name, ""), ""), efforts.get(name, "minimal"))
    if not clients:
        sys.exit("give at least one --endpoint or --answers, or --fake")

    costs: dict[str, Cost] = {}
    for name, v in _pairs(args.price, "price").items():
        i, _, o = v.partition(",")
        costs[name] = Cost(per_m_in=float(i), per_m_out=float(o))
    conc = {k: int(v) for k, v in _pairs(args.concurrency, "concurrency").items()}
    for name, v in _pairs(args.hourly, "hourly").items():
        costs[name] = Cost(hourly=float(v), concurrency=conc.get(name, 1))

    reports = evaluate(examples, clients)
    print(table(reports, costs))
    if args.out:
        args.out.write_text(json.dumps({n: {"n": r.n, "valid": r.parsed, "correct": r.correct, "exact": r.exact, "send_missed": r.send_missed, "p50_ms": r.percentile(50), "p95_ms": r.percentile(95), "cost_per_1k": r.cost_per_1k(costs.get(n, Cost()))} for n, r in reports.items()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
