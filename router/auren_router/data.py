"""The Auren Router's dataset, built into router/data/ (not committed).

  uv run python -m auren_router.data seed                  check seed/seed.jsonl, copy it to data/
  uv run python -m auren_router.data logged --file F       labelled commands exported by Core
  uv run python -m auren_router.data logged --url http://127.0.0.1:8787/v1/router/examples
  uv run --with openai python -m auren_router.data synthetic --n 3000   (needs MODEL_API_KEY)
  uv run python -m auren_router.data build                 dedupe, split, write train/val/test

Every example is one JSON line: {"text", "context": {origin, devices}, "label", "source"}.
Labels pass schema.parse(), contexts pass prompt.parse_context(). The split is
by a hash of the normalised command, so a command never lands in two splits,
and the hand-written seed is always held out as the test anchor.

TODO before any training run: check the Meta model API terms on training with
model outputs. The synthetic set is generated and labelled by Muse models.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

from .prompt import Context, Device, parse_context, render_user, strip_fences
from .schema import APPS, TIERS, RouterOutput, parse

ROOT = Path(__file__).resolve().parents[1]
SEED = ROOT / "seed" / "seed.jsonl"
DATA = ROOT / "data"
RUBRIC = ROOT / "rubric.md"

META_BASE_URL = "https://api.meta.ai/v1"
GENERATOR = "muse-spark-1.3-contributor"
LABELER = "muse-wonder-1.0"
SOURCES = ("seed", "logged", "synthetic")
SPLITS = ("train", "val", "test")


@dataclass(frozen=True)
class Example:
    text: str
    context: Context
    label: RouterOutput
    source: str

    def to_dict(self) -> dict:
        return {"text": self.text, "context": self.context.to_dict(), "label": json.loads(self.label.to_json()), "source": self.source}


def parse_example(raw: object, source: str | None = None) -> Example:
    """Check one example. Raises ValueError, so a bad line never reaches training."""
    if not isinstance(raw, dict):
        raise ValueError("an example must be a JSON object")
    text = raw.get("text")
    if not isinstance(text, str) or not text.strip() or len(text) > 2000:
        raise ValueError("text must be a non-empty string (at most 2000 characters)")
    label = parse(json.dumps(raw.get("label")))
    src = source or raw.get("source")
    if src not in SOURCES:
        raise ValueError(f"source must be one of {SOURCES}")
    return Example(" ".join(text.split()), parse_context(raw.get("context")), label, src)


def read_jsonl(path: Path, source: str | None = None) -> tuple[list[Example], list[str]]:
    """Examples plus one error line per bad row (row number and reason)."""
    good, bad = [], []
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            good.append(parse_example(json.loads(line), source))
        except (ValueError, json.JSONDecodeError) as e:
            bad.append(f"{path.name}:{n}: {e}")
    return good, bad


def write_jsonl(path: Path, examples: list[Example]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for ex in examples:
            f.write(json.dumps(ex.to_dict(), separators=(",", ":")) + "\n")


# ── dedupe and split ──────────────────────────────────────────────────────


def normalise(text: str) -> str:
    """Lower case, no punctuation, single spaces: "Push my 3 PM!" and "push my 3 pm" are one command."""
    return " ".join(re.sub(r"[^\w\s#:]", " ", text.lower()).split())


def split_for(text: str, val: int = 5, test: int = 10) -> str:
    """Deterministic, by hash of the normalised command: about 85 / 5 / 10."""
    bucket = int(hashlib.sha256(normalise(text).encode()).hexdigest()[:8], 16) % 100
    return "test" if bucket < test else "val" if bucket < test + val else "train"


def dedupe(examples: list[Example]) -> list[Example]:
    """One example per (command, situation). Earlier sources win, so pass seed first, then logged."""
    seen: set[str] = set()
    out = []
    for ex in examples:
        key = json.dumps([normalise(ex.text), render_user("", ex.context)])
        if key not in seen:
            seen.add(key)
            out.append(ex)
    return out


def build(examples: list[Example]) -> dict[str, list[Example]]:
    """The seed is always test. A command seen in the seed is kept out of train and val too."""
    examples = dedupe(examples)
    seed_texts = {normalise(e.text) for e in examples if e.source == "seed"}
    out: dict[str, list[Example]] = {s: [] for s in SPLITS}
    for ex in examples:
        held = ex.source == "seed" or normalise(ex.text) in seed_texts
        out["test" if held else split_for(ex.text)].append(ex)
    return out


def coverage(examples: list[Example]) -> dict[str, Counter]:
    return {
        "apps": Counter(a for e in examples for a in e.label.apps),
        "risk_tier": Counter(e.label.risk_tier for e in examples),
        "reply_surface": Counter(e.label.reply_surface for e in examples),
        "needs_vision": Counter(str(e.label.needs_vision).lower() for e in examples),
        "origin": Counter(e.context.origin or "none" for e in examples),
    }


# ── synthetic ─────────────────────────────────────────────────────────────

# The device mixes the generator writes for. Manifests match the console's presets (apps/web/index.html).
_PRESET = {
    "watch": (["voice", "text", "touch"], ["voice", "haptic", "screen"]),
    "glasses": (["voice", "camera"], ["voice"]),
    "phone": (["voice", "text", "touch", "camera"], ["voice", "screen"]),
    "web": (["text", "touch"], ["screen", "voice"]),
}
MIXES = (
    ("watch", "phone", "web"),
    ("watch", "phone"),
    ("glasses", "watch"),
    ("glasses", "phone"),
    ("glasses", "watch", "phone"),
    ("phone", "web"),
    ("phone",),
    ("web",),
    ("watch",),
)


@dataclass(frozen=True)
class Spec:
    """What one generator call is asked to write: commands for these apps, at this tier, in this situation."""

    apps: tuple[str, ...]
    tier: str
    context: Context


def _context(mix: tuple[str, ...], origin: str) -> Context:
    return Context(origin, tuple(Device(k, tuple(_PRESET[k][0]), tuple(_PRESET[k][1]), k == origin) for k in mix))


def plan(n_specs: int, seed: int = 7) -> list[Spec]:
    """An even grid of app sets x tiers x situations, shuffled with a fixed seed. Vision specs only
    go to mixes with a camera, so a "this" command always has something to look through."""
    rng = random.Random(seed)
    singles = [(a,) for a in APPS if a != "glasses"]
    pairs = [(a, b) for a in APPS for b in APPS if a != b and "glasses" not in (a, b) and "receipts" not in (a, b)]
    vision = [("glasses",)] + [("glasses", a) for a in ("calendar", "slack", "gmail", "browser")]
    specs = []
    for i in range(n_specs):
        pool = (singles, pairs, vision)[i % 3]
        apps = pool[rng.randrange(len(pool))]
        mixes = [m for m in MIXES if "glasses" not in apps or {"glasses", "phone"} & set(m)]
        mix = mixes[rng.randrange(len(mixes))]
        origin = mix[rng.randrange(len(mix))]
        specs.append(Spec(apps, TIERS[i % len(TIERS)], _context(mix, origin)))
    rng.shuffle(specs)
    return specs


GEN_INSTRUCTIONS = """You write realistic voice commands a university student or TA might say to Auren, a voice agent that acts across their apps and devices. Use fictional people and channels only (Priya Raman, Prof. Lee, Jordan, #office-hours, #cs5800-tas, #general). Vary length, phrasing and tone; include casual speech. Answer with one JSON object and no other text: {"commands": ["...", ...]}"""


def gen_input(spec: Spec, k: int) -> str:
    tier = {"read": "only look things up", "write": "change something that can be undone (move an event, make a draft)", "send": "reach another person or spend money (post, invite, email, book, pay)"}[spec.tier]
    apps = ", ".join(spec.apps)
    # Without the last sentence, v0 wrote "with my glasses" in 58 of 300 commands where only a phone had a camera.
    camera = " They point at something in view, like a poster or sign, so the command says \"this\" or \"that\". Only mention a device that is online below." if "glasses" in spec.apps else ""
    return f"Write {k} different commands that need these apps: {apps}. At most, they {tier}.{camera}\nThe situation:\n{render_user('(the command)', spec.context)}"


def _meta_client():
    key = os.environ.get("MODEL_API_KEY", "")
    if not key:
        sys.exit("MODEL_API_KEY is not set. Synthetic data needs the Meta Model API.")
    from openai import OpenAI  # lazy: only this subcommand needs the SDK

    return OpenAI(base_url=os.environ.get("MUSE_BASE_URL", META_BASE_URL), api_key=key, max_retries=2)


@dataclass
class Usage:
    """Tokens per model and why things were dropped, so a run can report its own cost. Thread-safe."""

    tokens: dict[str, list[int]] = field(default_factory=dict)  # model -> [calls, input, output]
    drops: Counter = field(default_factory=Counter)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def add(self, model: str, resp) -> None:
        u = getattr(resp, "usage", None)
        with self._lock:
            t = self.tokens.setdefault(model, [0, 0, 0])
            t[0] += 1
            t[1] += getattr(u, "input_tokens", 0) or 0
            t[2] += getattr(u, "output_tokens", 0) or 0

    def drop(self, reason: str, n: int = 1) -> None:
        with self._lock:
            self.drops[reason] += n


def label_with(client, model: str, text: str, ctx: Context, usage: Usage | None = None) -> RouterOutput:
    """Muse Wonder labels one command with the rubric, word for word. Off-schema answers raise."""
    resp = client.responses.create(model=model, instructions=RUBRIC.read_text(encoding="utf-8"), input=render_user(text, ctx), reasoning={"effort": "low"})
    if usage:
        usage.add(model, resp)
    return parse(strip_fences(resp.output_text or ""))


def generate_with(client, model: str, spec: Spec, k: int, usage: Usage | None = None) -> list[str]:
    resp = client.responses.create(model=model, instructions=GEN_INSTRUCTIONS, input=gen_input(spec, k), reasoning={"effort": "minimal"})
    if usage:
        usage.add(model, resp)
    raw = json.loads(strip_fences(resp.output_text or ""))
    return [c.strip() for c in raw.get("commands", []) if isinstance(c, str) and 3 <= len(c.strip()) <= 300]


def synthetic(client, n: int, out: Path, generator: str, labeler: str, per_call: int = 10, workers: int = 4, seed: int = 7, usage: Usage | None = None) -> tuple[int, int]:
    """Appends to `out`, skipping commands already there, so a stopped run resumes. Returns (kept, dropped)."""
    have = set()
    if out.exists():
        have = {normalise(e.text) for e in read_jsonl(out, "synthetic")[0]}
    if len(have) >= n:
        return 0, 0
    out.parent.mkdir(parents=True, exist_ok=True)
    # Twice the calls n needs, in waves of `workers`, stopping once n is reached (repeats and
    # off-schema labels eat some of each batch).
    specs = plan(2 * -(-(n - len(have)) // per_call), seed)
    kept = dropped = 0
    usage = usage if usage is not None else Usage()

    def one(spec: Spec) -> tuple[list[Example], int]:
        try:
            texts = generate_with(client, generator, spec, per_call, usage)
        except Exception as e:
            usage.drop(f"generate: {type(e).__name__}", per_call)
            return [], per_call
        got, lost = [], 0
        for text in texts:
            try:
                got.append(Example(" ".join(text.split()), spec.context, label_with(client, labeler, text, spec.context, usage), "synthetic"))
            except ValueError as e:
                usage.drop(f"label off-schema: {str(e)[:40]}")
                lost += 1
            except Exception as e:
                usage.drop(f"label: {type(e).__name__}")
                lost += 1
        return got, lost

    with ThreadPoolExecutor(max_workers=workers) as pool, out.open("a", encoding="utf-8") as f:
        for i in range(0, len(specs), workers):
            if len(have) >= n:
                break
            for got, lost in pool.map(one, specs[i : i + workers]):
                dropped += lost
                for ex in got:
                    if len(have) >= n:
                        usage.drop("over n (last wave)")
                        continue
                    if normalise(ex.text) in have:
                        usage.drop("duplicate")
                        continue
                    have.add(normalise(ex.text))
                    f.write(json.dumps(ex.to_dict(), separators=(",", ":")) + "\n")
                    kept += 1
    return kept, dropped


# ── CLI ───────────────────────────────────────────────────────────────────


def _print_coverage(examples: list[Example]) -> None:
    for field, counts in coverage(examples).items():
        print(f"  {field}: " + ", ".join(f"{k} {v}" for k, v in sorted(counts.items())))


def _load(path: Path, source: str) -> list[Example]:
    if not path.exists():
        return []
    good, bad = read_jsonl(path, source)
    for b in bad:
        print(f"  skipped {b}", file=sys.stderr)
    return good


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="auren_router.data", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("seed", help="check seed/seed.jsonl and copy it to data/")
    lg = sub.add_parser("logged", help="labelled commands exported by Core (GET /v1/router/examples)")
    src = lg.add_mutually_exclusive_group(required=True)
    src.add_argument("--file", type=Path)
    src.add_argument("--url", help="Core's export URL on this Mac, e.g. http://127.0.0.1:8787/v1/router/examples")
    sy = sub.add_parser("synthetic", help="generate with Muse Spark, label with Muse Wonder (needs MODEL_API_KEY)")
    sy.add_argument("--n", type=int, default=3000)
    sy.add_argument("--generator", default=GENERATOR)
    sy.add_argument("--labeler", default=LABELER)
    sy.add_argument("--workers", type=int, default=4)
    sy.add_argument("--seed", type=int, default=7)
    bd = sub.add_parser("build", help="dedupe and split data/*.jsonl into train, val and test")
    bd.add_argument("--handcheck", type=int, default=100, help="also write this many train examples to data/handcheck.jsonl")
    args = ap.parse_args(argv)

    if args.cmd == "seed":
        good, bad = read_jsonl(SEED, "seed")
        for b in bad:
            print(b, file=sys.stderr)
        if bad:
            return 1
        write_jsonl(DATA / "seed.jsonl", good)
        print(f"seed: {len(good)} examples")
        _print_coverage(good)
    elif args.cmd == "logged":
        if args.url:
            host = urllib.parse.urlparse(args.url).hostname
            if host not in ("127.0.0.1", "localhost", "::1"):
                sys.exit("The export holds command text, so read it from Core on this Mac only.")
            body = urllib.request.urlopen(args.url, timeout=10).read().decode("utf-8")
            tmp = DATA / "logged.raw.jsonl"
            tmp.parent.mkdir(parents=True, exist_ok=True)
            tmp.write_text(body, encoding="utf-8")
            path = tmp
        else:
            path = args.file
        good, bad = read_jsonl(path, "logged")
        for b in bad:
            print(f"  skipped {b}", file=sys.stderr)
        write_jsonl(DATA / "logged.jsonl", good)
        print(f"logged: {len(good)} examples ({len(bad)} skipped)")
        _print_coverage(good)
    elif args.cmd == "synthetic":
        print("TODO before training: check the Meta model API terms on training with model outputs.", file=sys.stderr)
        usage = Usage()
        t0 = time.monotonic()
        kept, dropped = synthetic(_meta_client(), args.n, DATA / "synthetic.jsonl", args.generator, args.labeler, workers=args.workers, seed=args.seed, usage=usage)
        print(f"synthetic: {kept} new examples, {dropped} dropped (off-schema or failed calls) in {time.monotonic() - t0:.0f} s")
        for model, (calls, tin, tout) in usage.tokens.items():
            print(f"  {model}: {calls} calls, {tin} input tokens, {tout} output tokens")
        for reason, count in usage.drops.most_common():
            print(f"  dropped {count}: {reason}")
    elif args.cmd == "build":
        seed = _load(SEED, "seed")
        rows = seed + _load(DATA / "logged.jsonl", "logged") + _load(DATA / "synthetic.jsonl", "synthetic")
        splits = build(rows)
        for name, examples in splits.items():
            write_jsonl(DATA / f"{name}.jsonl", examples)
            print(f"{name}: {len(examples)}")
        _print_coverage(splits["train"])
        if args.handcheck and splits["train"]:
            sample = random.Random(1).sample(splits["train"], min(args.handcheck, len(splits["train"])))
            write_jsonl(DATA / "handcheck.jsonl", sample)
            print(f"handcheck: {len(sample)} train examples to read by hand before training")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
