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


_EQ_QUERY_RE = re.compile(
    r"(?:eq(?:uation|n)?s?|eqs)\s*\.?\s*\(?\s*(\d+[a-z]?)\s*\)?",
    re.I,
)
_FIG_QUERY_RE = re.compile(
    r"(?:figures?|figs?)\s*\.?\s*\(?\s*(\d+[a-z]?)\s*\)?",
    re.I,
)
_TBL_QUERY_RE = re.compile(
    r"(?:tables?|tbls?)\s*\.?\s*\(?\s*(\d+[a-z]?)\s*\)?",
    re.I,
)


def extract_query_anchors(query: str) -> dict[str, list[str]]:
    """Pull equation / figure / table numbers mentioned in a user query."""
    q = query or ""
    eqs = [m.group(1) for m in _EQ_QUERY_RE.finditer(q)]
    figs = [m.group(1) for m in _FIG_QUERY_RE.finditer(q)]
    tables = [m.group(1) for m in _TBL_QUERY_RE.finditer(q)]
    # de-dupe, preserve order
    def _uniq(items: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for x in items:
            key = x.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(x)
        return out

    return {"eq": _uniq(eqs), "fig": _uniq(figs), "table": _uniq(tables)}


def _window_around(text: str, start: int, end: int, *, radius: int = 1600) -> str:
    lo = max(0, start - radius)
    hi = min(len(text), end + radius)
    while lo > 0 and text[lo] not in "\n":
        lo -= 1
    while hi < len(text) and text[hi] not in "\n":
        hi += 1
    return text[lo:hi].strip()


def _find_numbered_windows(text: str, number: str, *, kind: str) -> list[str]:
    """Locate manuscript windows that mention a numbered eq/fig/table."""
    n = re.escape(number)
    patterns: list[re.Pattern[str]] = []
    if kind == "eq":
        patterns = [
            re.compile(rf"\\tag\s*\{{\s*{n}\s*\}}"),
            re.compile(rf"\\label\s*\{{\s*(?:eq:|eqn:|equation:)?{n}\s*\}}", re.I),
            re.compile(rf"(?:eq(?:uation|n)?s?)\s*\.?\s*\(?\s*{n}\s*\)?", re.I),
            re.compile(rf"\$\$.*?\$\$\s*\(\s*{n}\s*\)", re.S),
            re.compile(rf"\\begin\{{equation\}}.*?\\end\{{equation\}}", re.S),
        ]
    elif kind == "fig":
        patterns = [
            re.compile(rf"(?:figures?|figs?)\s*\.?\s*\(?\s*{n}\s*\)?", re.I),
        ]
    else:
        patterns = [
            re.compile(rf"(?:tables?|tbls?)\s*\.?\s*\(?\s*{n}\s*\)?", re.I),
        ]

    windows: list[str] = []
    seen: set[int] = set()
    for pat in patterns:
        for m in pat.finditer(text):
            # For generic equation environments, only keep if the number is nearby.
            if kind == "eq" and "equation" in pat.pattern and "tag" not in pat.pattern:
                blob = text[max(0, m.start() - 80) : min(len(text), m.end() + 80)]
                if not re.search(rf"\b{n}\b", blob):
                    continue
            key = m.start() // 200
            if key in seen:
                continue
            seen.add(key)
            windows.append(_window_around(text, m.start(), m.end()))
            if len(windows) >= 3:
                return windows
    return windows


def extract_numbered_context(text: str, query: str, *, max_chars: int = 12000) -> str:
    """Pull the manuscript windows a numbered query actually refers to."""
    body = (text or "").strip()
    if not body or not (query or "").strip():
        return ""
    anchors = extract_query_anchors(query)
    chunks: list[str] = []
    used = 0
    for kind, label in (("eq", "Equation"), ("fig", "Figure"), ("table", "Table")):
        for num in anchors[kind]:
            windows = _find_numbered_windows(body, num, kind=kind)
            if not windows:
                continue
            block = f"### {label} {num} (from manuscript)\n\n" + "\n\n".join(windows)
            if used + len(block) + 4 > max_chars:
                remaining = max_chars - used
                if remaining > 200:
                    chunks.append(block[:remaining])
                return "\n\n".join(chunks)
            chunks.append(block)
            used += len(block) + 4
    return "\n\n".join(chunks)


_FULL_SECTIONS = (
    "abstract",
    "introduction",
    "method",
    "methods",
    "approach",
    "model",
    "theory",
    "theoretical",
    "experiment",
    "experiments",
    "result",
    "results",
    "evaluation",
    "discussion",
    "conclusion",
    "conclusions",
)


def build_analysis_excerpt(
    raw_text: str,
    *,
    max_chars: int = 40000,
    query: str | None = None,
    profile: str = "summary",
) -> str:
    """Section-aware excerpt, with numbered eq/fig/table windows prepended.

    If the paper already fits ``max_chars``, the full manuscript is returned
    so later equations are not silently dropped.
    """
    text = (raw_text or "").strip()
    if not text:
        return ""

    numbered = ""
    if query:
        numbered_budget = min(14000, max(4000, max_chars // 3))
        numbered = extract_numbered_context(text, query, max_chars=numbered_budget)

    if len(text) <= max_chars and not numbered:
        return text

    # Prefer methods/theory/results in full once the budget is large enough.
    rest_budget = max_chars - (len(numbered) + 8 if numbered else 0)
    if rest_budget < 2000:
        rest_budget = max_chars

    if len(text) <= rest_budget:
        body = text
    else:
        # Reuse prepare's heading parser but keep high-signal sections full.
        body = _section_excerpt(text, max_chars=rest_budget, profile=profile)

    if numbered:
        return f"## Numbered items referenced in the question\n\n{numbered}\n\n---\n\n{body}"[:max_chars]
    return body[:max_chars]


def _section_excerpt(text: str, *, max_chars: int, profile: str) -> str:
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

    def _full(name_l: str) -> bool:
        if any(p in name_l or name_l.startswith(p) for p in _FULL_SECTIONS):
            return True
        if profile == "prepare":
            return "future work" in name_l
        return False

    for name, body, _prio in sections:
        name_l = name.lower()
        piece = body if _full(name_l) else _first_paragraphs(body, 2, max_chars=1800)
        block = f"## {name}\n{piece}".strip()
        if used + len(block) + 4 > max_chars:
            remaining = max_chars - used - 8
            if remaining > 240:
                chunks.append(f"## {name}\n{piece[:remaining]}")
            break
        chunks.append(block)
        used += len(block) + 4
        if used >= max_chars - 200:
            break

    if not chunks:
        return text[:max_chars]
    combined = f"{head}\n\n" + "\n\n".join(chunks)
    return combined[:max_chars]
