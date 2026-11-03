"""The one prompt the Auren Router sees, shared by data, training, serving,
evaluation and Core.

The system prompt lives in system_prompt.txt, which Core reads too
(core/src/router/prompt.ts). Changing the file or render_user() changes what a
trained LoRA expects, so both test suites pin them with the same golden strings
(tests/test_prompt.py and core/src/router/router.test.ts).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

SYSTEM = Path(__file__).with_name("system_prompt.txt").read_text(encoding="utf-8").strip()

# Mirrors core/src/protocol.ts (SurfaceKind, Input, Output), in that order.
KINDS = ("watch", "glasses", "phone", "web", "desktop", "other")
INPUTS = ("voice", "text", "camera", "touch")
OUTPUTS = ("voice", "screen", "haptic")


@dataclass(frozen=True)
class Device:
    kind: str
    inputs: tuple[str, ...]
    outputs: tuple[str, ...]
    active: bool


@dataclass(frozen=True)
class Context:
    """The devices online when the command was given, and the kind it came from (None if typed into the API)."""

    origin: str | None
    devices: tuple[Device, ...]

    def to_dict(self) -> dict:
        return {
            "origin": self.origin,
            "devices": [
                {"kind": d.kind, "inputs": list(d.inputs), "outputs": list(d.outputs), "active": d.active}
                for d in self.devices
            ],
        }


def _subset(values: object, allowed: tuple[str, ...], what: str) -> tuple[str, ...]:
    if not isinstance(values, list) or not all(isinstance(v, str) for v in values):
        raise ValueError(f"{what} must be a list of strings")
    unknown = [v for v in values if v not in allowed]
    if unknown:
        raise ValueError(f"unknown {what}: {unknown}")
    return tuple(values)


def parse_context(raw: object) -> Context:
    """Check a context object (the same shape Core exports). Raises ValueError."""
    if not isinstance(raw, dict) or set(raw) != {"origin", "devices"}:
        raise ValueError("context must be {origin, devices}")
    origin = raw["origin"]
    if origin is not None and origin not in KINDS:
        raise ValueError(f"origin must be one of {KINDS} or null")
    if not isinstance(raw["devices"], list):
        raise ValueError("devices must be a list")
    devices = []
    for d in raw["devices"]:
        if not isinstance(d, dict) or set(d) != {"kind", "inputs", "outputs", "active"}:
            raise ValueError("a device must be {kind, inputs, outputs, active}")
        if d["kind"] not in KINDS:
            raise ValueError(f"device kind must be one of {KINDS}")
        if not isinstance(d["active"], bool):
            raise ValueError("active must be true or false")
        devices.append(Device(d["kind"], _subset(d["inputs"], INPUTS, "inputs"), _subset(d["outputs"], OUTPUTS, "outputs"), d["active"]))
    return Context(origin, tuple(devices))


def _ordered(values: tuple[str, ...], order: tuple[str, ...]) -> list[str]:
    return [v for v in order if v in values]


def render_user(text: str, ctx: Context) -> str:
    """The user turn. Devices are sorted by kind and their inputs and outputs put in protocol
    order, so the same situation always reads the same, whatever order surfaces joined in."""
    lines = [f"Command: {' '.join(text.split())}", f"Spoken into: {ctx.origin or 'none'}"]
    devices = sorted(ctx.devices, key=lambda d: KINDS.index(d.kind))
    if not devices:
        lines.append("Devices online: none")
    else:
        lines.append("Devices online:")
        for d in devices:
            ins = ", ".join(_ordered(d.inputs, INPUTS)) or "none"
            outs = ", ".join(_ordered(d.outputs, OUTPUTS)) or "none"
            lines.append(f"- {d.kind}{' (active)' if d.active else ''}: in {ins}; out {outs}")
    return "\n".join(lines)


def messages(text: str, ctx: Context) -> list[dict]:
    """Chat messages for serving and evaluation; Core builds the identical pair."""
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": render_user(text, ctx)}]


def training_row(text: str, ctx: Context, label_json: str) -> dict:
    """A conversational prompt/completion row, so the loss falls on the answer only."""
    return {"prompt": messages(text, ctx), "completion": [{"role": "assistant", "content": label_json}]}


_FENCE = re.compile(r"```(?:json)?\s*(.*?)\s*```", re.S | re.I)


def strip_fences(text: str) -> str:
    """General models sometimes wrap JSON in a code fence. The schema check stays strict either way."""
    t = text.strip()
    m = _FENCE.fullmatch(t)
    return m.group(1) if m else t
