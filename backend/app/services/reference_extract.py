"""Extract the references / bibliography slice from raw PDF text."""

from __future__ import annotations

import re

_HEADERS = (
    r"\bREFERENCES\b",
    r"\bReferences\b",
    r"\bREFERENCE\b",
    r"\bBibliography\b",
    r"\bBIBLIOGRAPHY\b",
    r"\bLiterature\s+Cited\b",
    r"\bLITERATURE\s+CITED\b",
    r"\bWorks\s+Cited\b",
)


def extract_references_section(text: str, *, max_chars: int = 16000) -> str:
    """Return text from the references heading through the end (capped).

    Prefer the heading that appears latest in the file — the bibliography is
    almost always near the end, while words like ``References'' sometimes
    occur earlier in prose.
    """
    if not isinstance(text, str) or not text.strip():
        return ""

    last_start: int | None = None
    for pat in _HEADERS:
        for m in re.finditer(pat, text):
            idx = m.start()
            # Ignore very early false positives inside the manuscript body.
            if idx <= len(text) * 0.12:
                continue
            last_start = idx if last_start is None else max(last_start, idx)

    if last_start is None:
        for pat in _HEADERS:
            m = re.search(pat, text)
            if m:
                last_start = m.start()
                break

    if last_start is None:
        return text[-max_chars:].strip() if len(text) > max_chars else text.strip()

    return text[last_start : last_start + max_chars].strip()
