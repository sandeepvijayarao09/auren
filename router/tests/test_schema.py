import unittest

from auren_router.schema import RouterOutput, highest_tier, parse

GP1 = '{"apps":["slack","calendar","gmail"],"risk_tier":"send","reply_surface":"watch","needs_vision":false}'


class ParseTest(unittest.TestCase):
    def test_golden_path_one(self):
        out = parse(GP1)
        self.assertEqual(out, RouterOutput(("slack", "calendar", "gmail"), "send", "watch", False))

    def test_round_trip(self):
        self.assertEqual(parse(parse(GP1).to_json()), parse(GP1))

    def test_dedupes_apps_in_order(self):
        out = parse('{"apps":["calendar","calendar","gmail"],"risk_tier":"write","reply_surface":"phone","needs_vision":false}')
        self.assertEqual(out.apps, ("calendar", "gmail"))

    def test_rejects_off_schema_output(self):
        bad = [
            "not json",
            "[]",
            '{"apps":["calendar"],"risk_tier":"write","reply_surface":"phone"}',
            '{"apps":["venmo"],"risk_tier":"send","reply_surface":"phone","needs_vision":false}',
            '{"apps":["slack"],"risk_tier":"urgent","reply_surface":"watch","needs_vision":false}',
            '{"apps":["slack"],"risk_tier":"send","reply_surface":"tv","needs_vision":false}',
            '{"apps":["slack"],"risk_tier":"send","reply_surface":"watch","needs_vision":"no"}',
            '{"apps":["slack"],"risk_tier":"send","reply_surface":"watch","needs_vision":false,"grant":"send"}',
        ]
        for text in bad:
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse(text)


class TierTest(unittest.TestCase):
    def test_highest_tier_wins(self):
        self.assertEqual(highest_tier(["read", "send", "write"]), "send")
        self.assertEqual(highest_tier(["read", "write"]), "write")
        self.assertEqual(highest_tier([]), "read")


if __name__ == "__main__":
    unittest.main()
