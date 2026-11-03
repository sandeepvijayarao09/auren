import io
import json
import unittest
from contextlib import redirect_stdout

from auren_router.data import SEED, read_jsonl
from auren_router.evaluate import Completion, Cost, FakeClient, Report, evaluate, main, score, table
from auren_router.prompt import messages


def _seed(n=None):
    return read_jsonl(SEED)[0][:n]


class Scripted:
    """Answers in order and takes `ms` of fake time per call."""

    def __init__(self, answers, ms, clock):
        self.answers, self.ms, self.clock = list(answers), list(ms), clock

    def complete(self, msgs):
        self.clock.t += self.ms.pop(0) / 1000
        a = self.answers.pop(0)
        if isinstance(a, Exception):
            raise a
        return Completion(a, 100, 10)


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


class ScoreTest(unittest.TestCase):
    def test_fields_exact_and_invalid(self):
        gp1 = next(e for e in _seed() if e.text.startswith("I'm running 15 late"))
        r = Report("x")
        score(r, gp1, gp1.label.to_json())
        score(r, gp1, '{"apps":["calendar","slack","gmail"],"risk_tier":"send","reply_surface":"watch","needs_vision":false}')  # wrong order
        score(r, gp1, '{"apps":["slack","calendar","gmail"],"risk_tier":"write","reply_surface":"phone","needs_vision":false}')
        score(r, gp1, "not json")
        score(r, gp1, None)
        self.assertEqual((r.n, r.parsed, r.exact, r.errors), (5, 3, 1, 1))
        self.assertEqual(r.correct, {"apps": 2, "risk_tier": 2, "reply_surface": 2, "needs_vision": 3})
        self.assertEqual(r.send_missed, 3, "the write answer, the bad JSON and the error all missed the send")

    def test_fenced_answer_counts(self):
        ex = _seed(1)[0]
        r = Report("x")
        score(r, ex, f"```json\n{ex.label.to_json()}\n```")
        self.assertEqual(r.exact, 1)


class EvaluateTest(unittest.TestCase):
    def test_latency_percentiles_tokens_and_cost(self):
        examples = _seed(4)
        clock = Clock()
        gold = [e.label.to_json() for e in examples]
        router = Scripted(gold, [40, 60, 80, 500], clock)
        spark = Scripted([gold[0], "nope", RuntimeError("timeout"), gold[3]], [300, 400, 0, 500], clock)
        reports = evaluate(examples, {"router": router, "spark": spark}, clock=clock)

        r, s = reports["router"], reports["spark"]
        self.assertEqual((r.n, r.exact), (4, 4))
        self.assertAlmostEqual(r.percentile(50), 60.0)
        self.assertAlmostEqual(r.percentile(95), 500.0)
        self.assertEqual((s.n, s.parsed, s.exact, s.errors), (4, 2, 2, 1))
        self.assertEqual(len(s.latencies_ms), 3, "a failed call has no latency")
        self.assertEqual((r.input_tokens, r.output_tokens), (400, 40))
        # 100 in + 10 out per call at $1 / $4 per 1M tokens = $0.14 per 1K calls.
        self.assertAlmostEqual(r.cost_per_1k(Cost(per_m_in=1.0, per_m_out=4.0)), 0.14)
        # $3.60 an hour, mean 170 ms, one at a time: 1000 calls = 170 s = $0.17.
        self.assertAlmostEqual(r.cost_per_1k(Cost(hourly=3.6)), 0.17)
        self.assertAlmostEqual(r.cost_per_1k(Cost(hourly=3.6, concurrency=10)), 0.017)
        self.assertIsNone(r.cost_per_1k(Cost()), "no price given, no cost invented")
        out = table(reports, {"router": Cost(hourly=3.6)})
        self.assertIn("| router | 4 | 100.0% |", out)
        self.assertIn("n/a |", out.splitlines()[-1])

    def test_every_endpoint_gets_cores_prompt(self):
        examples = _seed(3)
        seen = []

        class Spy:
            def complete(self, msgs):
                seen.append(msgs)
                return Completion("{}")

        evaluate(examples, {"spy": Spy()})
        self.assertEqual(seen, [messages(e.text, e.context) for e in examples])

    def test_fake_mode_runs_end_to_end(self):
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.assertEqual(main([str(SEED), "--fake"]), 0)
        line = next(l for l in buf.getvalue().splitlines() if l.startswith("| fake |"))
        n = len(_seed())
        self.assertIn(f"| fake | {n} | 100.0% |", line)
        exact = float(line.split("|")[8].strip().rstrip("%"))
        self.assertAlmostEqual(exact, 100 * (n - n // 7) / n, places=1)

    def test_fake_client_corrupts_every_nth(self):
        ex = _seed(1)[0]
        prompt = messages(ex.text, ex.context)
        fake = FakeClient({prompt[1]["content"]: ex.label.to_json()}, wrong_every=2)
        a, b = fake.complete(prompt).text, fake.complete(prompt).text
        self.assertEqual(json.loads(a), json.loads(ex.label.to_json()))
        self.assertNotEqual(json.loads(b)["risk_tier"], ex.label.risk_tier)


class ModalFilesTest(unittest.TestCase):
    """train.py and serve.py import without Modal, and refuse to run without their required settings."""

    def test_train_settings(self):
        from auren_router import train

        with self.assertRaisesRegex(SystemExit, "terms"):
            train.check_settings("some/base", 2, terms_checked=False)
        with self.assertRaisesRegex(SystemExit, "AUREN_ROUTER_BASE"):
            train.check_settings("", 2, terms_checked=True)
        with self.assertRaises(SystemExit):
            train.check_settings("some/base", 3, terms_checked=True)
        train.check_settings("some/base", 1, terms_checked=True)
        self.assertEqual(len(train.prompt_sha()), 64)

    def test_train_rows_are_chat_formatted(self):
        from auren_router import train

        rows = train.chat_rows(SEED)
        self.assertEqual(len(rows), len(_seed()))
        self.assertEqual([m["role"] for m in rows[0]["prompt"]], ["system", "user"])
        self.assertEqual(rows[0]["completion"][0]["role"], "assistant")

    def test_vllm_command(self):
        from auren_router import serve

        cmd = serve.vllm_command("some/base", "auren-router")
        self.assertEqual(cmd[:3], ["vllm", "serve", "some/base"])
        self.assertIn("--enable-lora", cmd)
        self.assertIn("auren-router=/vol/adapters/auren-router", cmd)
        self.assertNotIn("--api-key", cmd, "the key goes in the environment, never argv")
        with self.assertRaises(ValueError):
            serve.vllm_command("")


if __name__ == "__main__":
    unittest.main()
