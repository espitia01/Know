"""Extract structured export content from cached analysis blobs."""

from __future__ import annotations

import re
from typing import Any

from .math_render import _INLINE_RE, _DISPLAY_RE


def plain_text(value: Any, *, max_len: int = 1200) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        s = value
    elif isinstance(value, (int, float, bool)):
        s = str(value)
    elif isinstance(value, dict):
        s = (
            value.get("markdown")
            or value.get("text")
            or value.get("explanation")
            or value.get("answer")
            or value.get("statement")
            or value.get("definition")
            or value.get("description")
            or ""
        )
    else:
        s = str(value)
    s = _DISPLAY_RE.sub(lambda m: m.group(1), s)
    s = _INLINE_RE.sub(lambda m: m.group(1), s)
    s = re.sub(r"\s+", " ", s).strip()
    if max_len and len(s) > max_len:
        s = s[: max_len - 1].rsplit(" ", 1)[0] + "…"
    return s


def _summary_dict(content: dict) -> dict:
    s = content.get("summary") or {}
    return s if isinstance(s, dict) else {}


def summary_sections(content: dict) -> list[tuple[str, list[str]]]:
    s = _summary_dict(content)
    out: list[tuple[str, list[str]]] = []
    if s.get("overview"):
        out.append(("Overview", [plain_text(s["overview"], max_len=2000)]))
    if s.get("motivation"):
        out.append(("Motivation", [plain_text(s["motivation"], max_len=2000)]))
    contribs = [plain_text(c) for c in (s.get("key_contributions") or []) if plain_text(c)]
    if contribs:
        out.append(("Key contributions", contribs))
    if s.get("methodology"):
        out.append(("Methodology", [plain_text(s["methodology"], max_len=2000)]))
    if s.get("main_results"):
        out.append(("Results", [plain_text(s["main_results"], max_len=2000)]))
    if s.get("discussion"):
        out.append(("Discussion", [plain_text(s["discussion"], max_len=2000)]))
    lims = [plain_text(l) for l in (s.get("limitations") or []) if plain_text(l)]
    if lims:
        out.append(("Limitations", lims))
    if s.get("future_work"):
        out.append(("Future work", [plain_text(s["future_work"], max_len=2000)]))
    return out


def prepare_sections(content: dict) -> list[tuple[str, list[str]]]:
    pr = content.get("prepare") or {}
    if not isinstance(pr, dict):
        return []
    out: list[tuple[str, list[str]]] = []
    defs = [
        f"{plain_text(d.get('term'))}: {plain_text(d.get('definition'))}"
        for d in (pr.get("definitions") or [])
        if isinstance(d, dict) and plain_text(d.get("term"))
    ]
    if defs:
        out.append(("Definitions", defs))
    concepts = [
        f"{plain_text(c.get('name') or c.get('term'))}: {plain_text(c.get('description') or c.get('explanation'))}"
        for c in (pr.get("concepts") or [])
        if isinstance(c, dict)
    ]
    concepts = [x for x in concepts if plain_text(x.split(":", 1)[0])]
    if concepts:
        out.append(("Concepts", concepts))
    rqs = [
        plain_text(rq.get("question") if isinstance(rq, dict) else rq)
        for rq in (pr.get("research_questions") or [])
    ]
    rqs = [x for x in rqs if x]
    if rqs:
        out.append(("Research questions", rqs))
    return out


def assumptions_bullets(content: dict) -> list[str]:
    raw = content.get("assumptions")
    items = raw.get("assumptions") if isinstance(raw, dict) else raw
    if not isinstance(items, list):
        return []
    bullets: list[str] = []
    for a in items:
        if not isinstance(a, dict):
            continue
        stmt = plain_text(a.get("statement"))
        if not stmt:
            continue
        kind = plain_text(a.get("type"))
        bullets.append(f"[{kind}] {stmt}" if kind else stmt)
    return bullets


def qa_entries(content: dict) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for session in content.get("qa") or []:
        if not isinstance(session, dict):
            continue
        for item in session.get("items") or session.get("questions") or []:
            if not isinstance(item, dict):
                continue
            q = plain_text(item.get("question"))
            a = plain_text(item.get("answer"))
            if q or a:
                pairs.append((q or "Question", a or ""))
    return pairs


def cross_qa_entries(content: dict) -> list[tuple[str, str]]:
    pairs: list[tuple[str, str]] = []
    for block in content.get("cross") or []:
        if not isinstance(block, dict):
            continue
        if block.get("items"):
            for item in block.get("items") or []:
                if not isinstance(item, dict):
                    continue
                pairs.append((plain_text(item.get("question")), plain_text(item.get("answer"))))
        else:
            pairs.append((plain_text(block.get("question")), plain_text(block.get("answer"))))
    return [(q, a) for q, a in pairs if q or a]


def selection_entries(content: dict) -> list[tuple[str, str, str]]:
    """Return (action, selected_text, body) per selection."""
    rows: list[tuple[str, str, str]] = []
    for item in content.get("selection") or []:
        if not isinstance(item, dict):
            continue
        action = plain_text(item.get("action") or "explain")
        sel = plain_text(item.get("selected_text") or item.get("selection"), max_len=400)
        body = plain_text(
            item.get("explanation")
            or item.get("elaboration")
            or item.get("answer")
            or item.get("body")
            or item.get("result"),
            max_len=2000,
        )
        if item.get("steps") and isinstance(item["steps"], list):
            step_lines = []
            for i, st in enumerate(item["steps"][:12], 1):
                if isinstance(st, dict):
                    step_lines.append(
                        f"Step {i}: {plain_text(st.get('description') or st.get('step'))} → {plain_text(st.get('result') or st.get('math'))}"
                    )
            if step_lines:
                body = (body + " " + " ".join(step_lines)).strip()
        if sel or body:
            rows.append((action, sel, body))
    return rows


def notes_bullets(content: dict) -> list[str]:
    return [
        plain_text(n.get("text") or n.get("content"))
        for n in (content.get("notes") or [])
        if isinstance(n, dict) and plain_text(n.get("text") or n.get("content"))
    ]


def related_bibliography(content: dict) -> list[str]:
    rel = content.get("related") or {}
    lines: list[str] = []
    pw = rel.get("prior_work") or []
    if isinstance(pw, list):
        for i, entry in enumerate(pw, 1):
            if isinstance(entry, dict):
                cite = plain_text(entry.get("citation_display") or entry.get("title"), max_len=2000)
                if cite:
                    lines.append(f"{i}. {cite}")
            elif plain_text(entry):
                lines.append(f"{i}. {plain_text(entry, max_len=2000)}")
    topics = rel.get("prior_work_topics") or []
    if isinstance(topics, list) and not lines:
        idx = 1
        for topic in topics:
            if not isinstance(topic, dict):
                continue
            for entry in topic.get("items") or []:
                if isinstance(entry, dict):
                    cite = plain_text(entry.get("citation_display") or entry.get("title"), max_len=2000)
                    if cite:
                        lines.append(f"{idx}. {cite}")
                        idx += 1
    cited = rel.get("cited_by") or []
    if isinstance(cited, list):
        for i, c in enumerate(cited, 1):
            if not isinstance(c, dict):
                continue
            authors = ", ".join((c.get("authors") or [])[:3])
            title = plain_text(c.get("title"))
            year = c.get("year") or "n.d."
            if title:
                lines.append(f"Cited by {i}. {authors} ({year}) — {title}")
    return lines


def figure_slides(content: dict, paper) -> list[tuple[str, str, str | None]]:
    """Return (caption, analysis_text, local_path) per figure."""
    fig = content.get("figures") or {}
    metas = fig.get("meta") or getattr(paper, "figures", None) or []
    analyses = {a.get("figure_id"): a for a in (fig.get("analyses") or []) if isinstance(a, dict)}
    slides: list[tuple[str, str, str | None]] = []
    for f in metas:
        fid = f.get("id") if isinstance(f, dict) else getattr(f, "id", None)
        cap = plain_text(f.get("caption") if isinstance(f, dict) else getattr(f, "caption", ""))
        analysis = analyses.get(fid) or {}
        body = plain_text(analysis.get("description") or analysis.get("answer"))
        slides.append((cap or "Figure", body, fid))
    return slides
