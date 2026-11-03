import json
import tempfile
import unittest
from collections import Counter
from pathlib import Path

from auren_router.data import SEED, build, coverage, dedupe, normalise, parse_example, plan, read_jsonl, split_for, synthetic, write_jsonl
from auren_router.prompt import render_user
from auren_router.schema import APPS, SURFACES, TIERS

# Two lines in the shape GET /v1/router/examples exports (core/src/router/examples.ts).
CORE_EXPORT = [
    '{"text":"Tell office hours I\'m running 15 late.","context":{"origin":"watch","devices":[{"kind":"watch","inputs":["voice","touch"],"outputs":["voice","haptic"],"active":true}]},"label":{"apps":["slack"],"risk_tier":"send","reply_surface":"watch","needs_vision":false},"source":"logged","at":1762200000000,"event_id":12}',
    '{"text":"Add this.","context":{"origin":"glasses","devices":[{"kind":"glasses","inputs":["voice","camera"],"outputs":["voice"],"active":true}]},"label":{"apps":["glasses","calendar"],"risk_tier":"write","reply_surface":"glasses","needs_vision":true},"source":"logged","at":1762200001000,"event_id":20}',
]


def _ex(text, source="synthetic", origin="watch"):
    return parse_example(
        {
            "text": text,
            "context": {"origin": origin, "devices": [{"kind": origin, "inputs": ["voice"], "outputs": ["voice"], "active": True}]},
            "label": {"apps": ["calendar"], "risk_tier": "read", "reply_surface": origin if origin in SURFACES else "web", "needs_vision": False},
        },
        source,
    )


class SeedTest(unittest.TestCase):
    """The hand-written seed is the test anchor: every line valid, and the rubric covered evenly."""

    def test_every_seed_line_is_valid(self):
        good, bad = read_jsonl(SEED)
        self.assertEqual(bad, [])
        self.assertGreaterEqual(len(good), 120)
        self.assertTrue(all(e.source == "seed" for e in good))
        self.assertEqual(len({normalise(e.text) for e in good}), len(good), "no duplicate commands")

    def test_seed_covers_the_rubric(self):
        good, _ = read_jsonl(SEED)
        cov = coverage(good)
        for app in APPS:
            self.assertGreaterEqual(cov["apps"][app], 10, app)
        for tier in TIERS:
            self.assertGreaterEqual(cov["risk_tier"][tier], 30, tier)
        for surface in SURFACES:
            self.assertGreaterEqual(cov["reply_surface"][surface], 20, surface)
        self.assertGreaterEqual(cov["needs_vision"]["true"], 20)
        self.assertGreaterEqual(len({render_user("", e.context) for e in good}), 15, "many device situations")
        # The rubric's own examples are in the seed with the rubric's labels.
        by_text = {e.text: e.label.to_json() for e in good}
        self.assertEqual(by_text["Add this, and invite Priya."], '{"apps":["glasses","calendar"],"risk_tier":"send","reply_surface":"glasses","needs_vision":true}')
        self.assertEqual(by_text["What did I get done today?"], '{"apps":["memory"],"risk_tier":"read","reply_surface":"web","needs_vision":false}')

    def test_vision_only_with_glasses(self):
        good, _ = read_jsonl(SEED)
        for e in good:
            self.assertEqual(e.label.needs_vision, "glasses" in e.label.apps, e.text)


class ExampleTest(unittest.TestCase):
    def test_reads_core_export(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, "logged.jsonl")
            p.write_text("\n".join(CORE_EXPORT + ["{not json", '{"text":"x","context":{"origin":null,"devices":[]},"label":{"apps":["venmo"],"risk_tier":"send","reply_surface":"web","needs_vision":false}}']) + "\n")
            good, bad = read_jsonl(p, "logged")
        self.assertEqual([e.text for e in good], ["Tell office hours I'm running 15 late.", "Add this."])
        self.assertEqual(len(bad), 2)
        self.assertIn("unknown apps", bad[1])

    def test_rejects_bad_examples(self):
        ok = json.loads(CORE_EXPORT[0])
        for broken in ({**ok, "text": ""}, {**ok, "label": {**ok["label"], "risk_tier": "urgent"}}, {**ok, "context": {"origin": "watch"}}, {**ok, "source": "scraped"}, [ok]):
            with self.subTest(broken=broken), self.assertRaises(ValueError):
                parse_example(broken)

    def test_round_trip(self):
        ex = parse_example(json.loads(CORE_EXPORT[1]))
        with tempfile.TemporaryDirectory() as d:
            p = Path(d, "x.jsonl")
            write_jsonl(p, [ex])
            self.assertEqual(read_jsonl(p)[0], [ex])


class SplitTest(unittest.TestCase):
    def test_split_is_deterministic_and_ignores_case_and_punctuation(self):
        self.assertEqual(split_for("Push my 3 PM to 4!"), split_for("push my 3 pm to 4"))
        self.assertEqual(split_for("Push my 3 PM to 4"), split_for("Push my 3 PM to 4"))

    def test_split_ratios(self):
        counts = Counter(split_for(f"command number {i}") for i in range(4000))
        self.assertAlmostEqual(counts["train"] / 4000, 0.85, delta=0.03)
        self.assertAlmostEqual(counts["val"] / 4000, 0.05, delta=0.02)
        self.assertAlmostEqual(counts["test"] / 4000, 0.10, delta=0.02)

    def test_dedupe_keeps_first_source_and_distinct_situations(self):
        rows = [_ex("Push my 3 PM", "seed"), _ex("push my 3 pm.", "synthetic"), _ex("Push my 3 PM", "synthetic", origin="phone")]
        kept = dedupe(rows)
        self.assertEqual([(e.source, e.context.origin) for e in kept], [("seed", "watch"), ("synthetic", "phone")])

    def test_build_holds_out_the_seed_and_its_commands(self):
        rows = [_ex("Push my 3 PM", "seed")] + [_ex(f"Command {i}") for i in range(300)] + [_ex("push my 3 pm", "synthetic", origin="phone")]
        splits = build(rows)
        self.assertEqual(sum(len(v) for v in splits.values()), 302)
        test_texts = [normalise(e.text) for e in splits["test"]]
        self.assertEqual(test_texts.count("push my 3 pm"), 2, "the seed and its twin are both test")
        for name in ("train", "val"):
            self.assertNotIn("push my 3 pm", [normalise(e.text) for e in splits[name]])
            self.assertTrue(all(split_for(e.text) == name for e in splits[name]))


class SyntheticTest(unittest.TestCase):
    def test_plan_is_even_and_vision_has_a_camera(self):
        specs = plan(900)
        self.assertEqual(plan(900), specs, "fixed seed")
        tiers = Counter(s.tier for s in specs)
        self.assertEqual(set(tiers.values()), {300})
        apps = Counter(a for s in specs for a in s.apps)
        for app in APPS:
            self.assertGreater(apps[app], 30, app)
        for s in specs:
            if "glasses" in s.apps:
                self.assertTrue(any("camera" in d.inputs for d in s.context.devices))
            self.assertIn(s.context.origin, [d.kind for d in s.context.devices])

    def test_generates_labels_validates_and_dedupes(self):
        class Resp:
            def __init__(self, text):
                self.output_text = text

        class FakeMeta:
            """Spark writes commands (with a repeat); Wonder labels them, once off-schema."""

            def __init__(self):
                self.calls = []
                self.responses = self

            def create(self, model, instructions, input, reasoning):
                self.calls.append(model)
                if model == "gen":
                    k = len([c for c in self.calls if c == "gen"])
                    return Resp(json.dumps({"commands": [f"Move my {2 * k - 1} PM", f"Move my {2 * k} PM", "Move my 1 PM", ""]}))
                if "Move my 2 PM" in input:
                    return Resp('{"apps":["venmo"],"risk_tier":"send","reply_surface":"watch","needs_vision":false}')
                return Resp('```json\n{"apps":["calendar"],"risk_tier":"write","reply_surface":"watch","needs_vision":false}\n```')

        meta = FakeMeta()
        with tempfile.TemporaryDirectory() as d:
            out = Path(d, "synthetic.jsonl")
            kept, dropped = synthetic(meta, n=3, out=out, generator="gen", labeler="wonder", per_call=2, workers=1)
            good, bad = read_jsonl(out)
            self.assertEqual(bad, [])
            self.assertEqual(sorted(e.text for e in good), ["Move my 1 PM", "Move my 3 PM", "Move my 4 PM"])
            self.assertEqual((kept, dropped), (3, 1), "the repeat is skipped, the off-schema label dropped")
            self.assertEqual(meta.calls.count("gen"), 2, "stops once n is reached")
            # Resumes: nothing new is needed once n is reached.
            self.assertEqual(synthetic(meta, n=2, out=out, generator="gen", labeler="wonder"), (0, 0))


if __name__ == "__main__":
    unittest.main()
