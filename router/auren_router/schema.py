"""The Auren Router's output, and the checks Core relies on.

The router is advisory. Core uses it to preload tool namespaces, start a camera
capture early and pick the reply surface. It never grants or lowers a risk tier;
the tool spec stays the authority (ARCHITECTURE.md §16).
"""

from __future__ import annotations

import json
from dataclasses import dataclass

# Namespaces in core/src/tools, plus the ones planned for Days 5 to 7.
APPS = ("calendar", "slack", "gmail", "browser", "glasses", "memory", "receipts")
TIERS = ("read", "write", "send")
SURFACES = ("watch", "glasses", "phone", "web")


@dataclass(frozen=True)
class RouterOutput:
    apps: tuple[str, ...]
    risk_tier: str
    reply_surface: str
    needs_vision: bool

    def to_json(self) -> str:
        return json.dumps(
            {
                "apps": list(self.apps),
                "risk_tier": self.risk_tier,
                "reply_surface": self.reply_surface,
                "needs_vision": self.needs_vision,
            },
            separators=(",", ":"),
        )


def parse(text: str) -> RouterOutput:
    """Parse and check one completion. Raises ValueError on anything off-schema,
    and Core then falls back to Muse Spark for this command."""
    try:
        raw = json.loads(text)
    except json.JSONDecodeError as e:
        raise ValueError(f"not JSON: {e.msg}") from e
    if not isinstance(raw, dict):
        raise ValueError("expected a JSON object")
    extra = set(raw) - {"apps", "risk_tier", "reply_surface", "needs_vision"}
    if extra:
        raise ValueError(f"unexpected fields: {sorted(extra)}")

    apps = raw.get("apps")
    if not isinstance(apps, list) or not all(isinstance(a, str) for a in apps):
        raise ValueError("apps must be a list of strings")
    unknown = [a for a in apps if a not in APPS]
    if unknown:
        raise ValueError(f"unknown apps: {unknown}")

    tier = raw.get("risk_tier")
    if tier not in TIERS:
        raise ValueError(f"risk_tier must be one of {TIERS}")
    surface = raw.get("reply_surface")
    if surface not in SURFACES:
        raise ValueError(f"reply_surface must be one of {SURFACES}")
    vision = raw.get("needs_vision")
    if not isinstance(vision, bool):
        raise ValueError("needs_vision must be true or false")

    # Order-preserving dedupe, so "apps" reads in the order the model named them.
    return RouterOutput(tuple(dict.fromkeys(apps)), tier, surface, vision)


def highest_tier(tiers: list[str]) -> str:
    """The tier of a command is the highest tier of any step in it."""
    return max(tiers, key=TIERS.index, default="read")
