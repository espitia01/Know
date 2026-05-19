"""Dashboard background preset validation (mirrors frontend allow-list)."""

from __future__ import annotations

ALLOWED_BACKGROUND_PRESETS = frozenset(
    {
        "none",
        "mint",
        "sky",
        "rose",
        "lavender",
        "dots",
        "grid",
        "waves",
        "custom",
    }
)


def normalize_background_preset(value: str | None) -> str | None:
    if value is None:
        return None
    v = value.strip()
    if v in ALLOWED_BACKGROUND_PRESETS:
        return v
    return None


def clamp_background_opacity(value: float | None) -> float | None:
    if value is None:
        return None
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return max(0.0, min(1.0, n))
