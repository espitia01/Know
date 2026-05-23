"""Section-aware excerpts for Prepare (analyze_paper) prompts."""

from __future__ import annotations

import re

_HEADING_RE = re.compile(
    r"^\s*(?:#+\s*)?(?:\d+(?:\.\d+)*\s+)?"
    r"(abstract|introduction|background|related work|method[s]?|approach|model|"
    r"theor(?:y|etical)|experiment[s]?|result[s]?|evaluation|discussion|"
    r"conclusion[s]?|future work|limitations)\b",
    re.I | re.MULTILINE,
)

_PRIORITY = (
    "abstract",
    "introduction",
    "conclusion",
    "conclusions",
    "discussion",
    "result",
    "results",
    "evaluation",
    "experiment",
    "experiments",
    "method",
    "methods",
    "approach",
    "model",
    "theory",
    "theoretical",
    "background",
    "related work",
    "future work",
    "limitations",
)


def _section_priority(name: str) -> int:
    key = name.lower().strip()
    for i, p in enumerate(_PRIORITY):
        if key.startswith(p) or p in key:
            return i
    return len(_PRIORITY)


def _first_paragraphs(text: str, n: int = 2, max_chars: int = 1200) -> str:
    parts = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    out: list[str] = []
    total = 0
    for p in parts[:n]:
        if total + len(p) > max_chars:
            remaining = max_chars - total
            if remaining > 80:
                out.append(p[:remaining])
            break
        out.append(p)
        total += len(p) + 2
    return "\n\n".join(out)


def build_prepare_excerpt(raw_text: str, *, max_chars: int = 15000) -> str:
    """Prefer abstract/intro/conclusion over a blind head truncation."""
    text = (raw_text or "").strip()
    if not text:
        return ""
    if len(text) <= max_chars:
        return text

    head = text[: min(1000, len(text))]
    matches = list(_HEADING_RE.finditer(text))
    if len(matches) < 2:
        return text[:max_chars]

    sections: list[tuple[str, str, int]] = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        name = m.group(1) or ""
        body = text[start:end].strip()
        sections.append((name, body, _section_priority(name)))

    sections.sort(key=lambda x: x[2])

    chunks: list[str] = []
    used = len(head) + 2

    def add_chunk(label: str, body: str, *, full: bool) -> None:
        nonlocal used
        name_l = label.lower()
        if "abstract" in name_l or "introduction" in name_l or name_l.startswith("conclusion"):
            piece = body
        elif full:
            piece = body
        else:
            piece = _first_paragraphs(body, 2, max_chars=1400)
        block = f"## {label}\n{piece}".strip()
        if used + len(block) + 4 > max_chars:
            return
        chunks.append(block)
        used += len(block) + 4

    for name, body, _prio in sections:
        name_l = name.lower()
        full = (
            "abstract" in name_l
            or "introduction" in name_l
            or name_l.startswith("conclusion")
            or "future work" in name_l
        )
        add_chunk(name, body, full=full)
        if used >= max_chars - 200:
            break

    if not chunks:
        return text[:max_chars]

    combined = f"{head}\n\n" + "\n\n".join(chunks)
    if len(combined) <= max_chars:
        return combined
    return combined[:max_chars]
