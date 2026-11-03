import hashlib
import json
import unittest
from pathlib import Path

from auren_router.prompt import SYSTEM, messages, parse_context, render_user, strip_fences, training_row
from auren_router.schema import parse

# The same two goldens are in core/src/router/router.test.ts. A change to the prompt
# changes what a trained LoRA expects, so both suites have to be updated together.
GOLDEN_SYSTEM_SHA256 = "21f6664c5582ef8132a9caa90726d72cd122366b43cebe1fbe17a0a068286de1"
GOLDEN_USER = (
    "Command: I'm running 15 late. Tell office hours, push my 3 PM, and draft a reply to Prof. Lee.\n"
    "Spoken into: watch\n"
    "Devices online:\n"
    "- watch (active): in voice, text, touch; out voice, screen, haptic\n"
    "- phone: in voice, text, camera, touch; out voice, screen\n"
    "- web: in text, touch; out voice, screen"
)
# Surfaces joined in a different order, with inputs and outputs shuffled: the prompt still reads the same.
GP1_CONTEXT = {
    "origin": "watch",
    "devices": [
        {"kind": "web", "inputs": ["touch", "text"], "outputs": ["voice", "screen"], "active": False},
        {"kind": "watch", "inputs": ["voice", "text", "touch"], "outputs": ["voice", "haptic", "screen"], "active": True},
        {"kind": "phone", "inputs": ["voice", "text", "touch", "camera"], "outputs": ["voice", "screen"], "active": False},
    ],
}
GP1_TEXT = "I'm running 15 late.  Tell office hours, push my 3 PM,\n and draft a reply to Prof. Lee."


class PromptTest(unittest.TestCase):
    def test_system_prompt_is_pinned(self):
        self.assertEqual(hashlib.sha256(SYSTEM.encode()).hexdigest(), GOLDEN_SYSTEM_SHA256)

    def test_user_prompt_golden(self):
        self.assertEqual(render_user(GP1_TEXT, parse_context(GP1_CONTEXT)), GOLDEN_USER)

    def test_system_prompt_names_every_app(self):
        from auren_router.schema import APPS, SURFACES

        for name in APPS + SURFACES:
            self.assertIn(name, SYSTEM)

    def test_messages_and_training_row(self):
        ctx = parse_context(GP1_CONTEXT)
        msgs = messages(GP1_TEXT, ctx)
        self.assertEqual([m["role"] for m in msgs], ["system", "user"])
        label = '{"apps":["slack","calendar","gmail"],"risk_tier":"send","reply_surface":"watch","needs_vision":false}'
        row = training_row(GP1_TEXT, ctx, label)
        self.assertEqual(row["prompt"], msgs)
        self.assertEqual(row["completion"], [{"role": "assistant", "content": label}])
        parse(row["completion"][0]["content"])

    def test_no_devices_and_no_origin(self):
        self.assertEqual(render_user("hi", parse_context({"origin": None, "devices": []})), "Command: hi\nSpoken into: none\nDevices online: none")

    def test_context_is_checked(self):
        bad = [
            None,
            {"origin": "watch"},
            {"origin": "tv", "devices": []},
            {"origin": "watch", "devices": [{"kind": "watch", "inputs": ["smell"], "outputs": [], "active": True}]},
            {"origin": "watch", "devices": [{"kind": "watch", "inputs": [], "outputs": [], "active": "yes"}]},
            {"origin": "watch", "devices": [{"kind": "watch", "inputs": [], "outputs": []}]},
        ]
        for raw in bad:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                parse_context(raw)

    def test_strip_fences(self):
        body = '{"apps":[],"risk_tier":"read","reply_surface":"web","needs_vision":false}'
        for text in (body, f"```json\n{body}\n```", f"```{body}```", f"  {body}\n"):
            with self.subTest(text=text):
                self.assertEqual(strip_fences(text), body)
        self.assertEqual(strip_fences(f"Sure! {body}"), f"Sure! {body}")


class ParityTest(unittest.TestCase):
    """The same accept/reject cases Core's zod Route is held to."""

    def test_shared_cases(self):
        cases = json.loads((Path(__file__).parent / "parity.json").read_text())
        for case in cases["valid"]:
            with self.subTest(text=case["text"]):
                self.assertEqual(list(parse(case["text"]).apps), case["apps"])
        for text in cases["invalid"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse(text)


if __name__ == "__main__":
    unittest.main()
