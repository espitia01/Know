"""Resolve missing outbound URLs from DOI/arXiv and Semantic Scholar search."""

from __future__ import annotations

import asyncio
import logging
import re
from typing import Any

import httpx

logger = logging.getLogger(__name__)

_S2_SEARCH = "https://api.semanticscholar.org/graph/v1/paper/search"
_S2_TIMEOUT = 12.0
_MAX_S2_LOOKUPS = 40


def _arxiv_norm(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    m = re.match(r"^arxiv:\s*(.+)$", s, flags=re.I)
    if m:
        s = m.group(1).strip()
    m = re.match(r"^(\d{4}\.\d{4,5})(v\d+)?$", s)
    if m:
        return f"{m.group(1)}{m.group(2) or ''}"
    return None


def _doi_norm(s: str) -> str | None:
    s = (s or "").strip()
    if not s:
        return None
    m = re.search(r"(10\.\d{4,9}/[^\s\]\),;]+)", s)
    return m.group(1).rstrip(",.;)") if m else None


def hydrate_identifiers(entry: dict[str, Any]) -> dict[str, Any]:
    """Fill doi / arxiv / url columns from whichever fields are populated."""
    out = dict(entry)

    doi = (out.get("doi") or "").strip()
    arx_raw = (out.get("arxiv") or "").strip()
    url = (out.get("url") or "").strip()

    if not doi:
        doi = _doi_norm(out.get("ref_id") or "") or ""
    if doi:
        out["doi"] = doi

    arx = arx_raw
    if not arx:
        arx_c = _arxiv_norm(out.get("ref_id") or "") or _arxiv_norm(out.get("bib_label") or "")
        if arx_c:
            arx = arx_c
    if arx:
        out["arxiv"] = _arxiv_norm(arx) or arx

    if not url:
        if out.get("doi"):
            out["url"] = f"https://doi.org/{out['doi']}"
        elif out.get("arxiv"):
            ac = _arxiv_norm(out["arxiv"]) or out["arxiv"]
            out["url"] = f"https://arxiv.org/abs/{ac}"
    elif url.startswith("doi.org/"):
        out["url"] = f"https://{url}"
    elif url.startswith("http://arxiv.org/"):
        out["url"] = url.replace("http://", "https://")

    return out


async def _s2_resolve_title(title: str) -> str | None:
    """Return Semantic Scholar canonical URL or open-access PDF URL if found."""
    t = (title or "").strip()
    if len(t) < 12:
        return None
    params = {
        "query": t[:350],
        "limit": 1,
        "fields": "url,externalIds,title,openAccessPdf",
    }
    try:
        async with httpx.AsyncClient(timeout=_S2_TIMEOUT) as client:
            r = await client.get(
                _S2_SEARCH,
                params=params,
                headers={"User-Agent": "KnowPaperReader/1.0 (+https://github.com/espitia01/Know)"},
            )
            if r.status_code == 429:
                await asyncio.sleep(2.2)
                r = await client.get(
                    _S2_SEARCH,
                    params=params,
                    headers={"User-Agent": "KnowPaperReader/1.0 (+https://github.com/espitia01/Know)"},
                )
            if r.status_code != 200:
                return None
            data = r.json()
    except Exception as e:
        logger.debug("Semantic Scholar search failed: %s", e)
        return None

    rows = data.get("data") or []
    if not rows:
        return None
    paper = rows[0]
    if not isinstance(paper, dict):
        return None
    cand = (paper.get("title") or "").lower()
    tl = t.lower()
    if cand:
        overlap = cand in tl or tl in cand or _title_overlap_ok(tl, cand)
        if not overlap:
            return None
    oa = paper.get("openAccessPdf")
    if isinstance(oa, dict) and oa.get("url"):
        return str(oa["url"])
    u = paper.get("url")
    if isinstance(u, str) and u.startswith("http"):
        return u
    return None


def _title_overlap_ok(a: str, b: str) -> bool:
    wa = set(re.findall(r"[a-z0-9]{4,}", a))
    wb = set(re.findall(r"[a-z0-9]{4,}", b))
    if not wa or not wb:
        return False
    return len(wa & wb) >= min(3, max(2, len(wa) // 3))


async def enrich_urls_with_semantic_scholar(items: list[dict[str, Any]]) -> None:
    """Mutate items in place: fill ``url`` when empty using S2 (bounded)."""
    need: list[tuple[int, str]] = []
    for i, it in enumerate(items):
        if (it.get("url") or "").strip():
            continue
        ttl = (it.get("title") or "").strip()
        if ttl:
            need.append((i, ttl))
    if not need:
        return

    need = need[:_MAX_S2_LOOKUPS]
    sem = asyncio.Semaphore(4)

    async def one(idx: int, title: str) -> tuple[int, str | None]:
        async with sem:
            u = await _s2_resolve_title(title)
            return idx, u

    results = await asyncio.gather(*[one(i, t) for i, t in need])
    for idx, u in results:
        if u and not (items[idx].get("url") or "").strip():
            items[idx]["url"] = u


def _prior_row(it: dict, *, theme: str = "") -> dict[str, Any]:
    bib = str(it.get("bib_label") or "").strip()
    rid = str(it.get("ref_id") or "").strip()
    return {
        "title": str(it.get("title", "")),
        "relevance": str(it.get("relevance", "")),
        "ref_id": rid if rid else bib,
        "bib_label": bib if bib else rid,
        "doi": str(it.get("doi", "")),
        "arxiv": str(it.get("arxiv", "")),
        "url": str(it.get("url", "")),
        "theme": theme or str(it.get("theme", "")),
    }


def normalize_pre_reading_prior_work(raw: dict) -> None:
    """Merge thematic groups + hydrate identifiers; mutate ``raw``."""
    topics_in = raw.get("prior_work_topics")
    out_topics: list[dict[str, Any]] = []
    flat: list[dict[str, Any]] = []

    if isinstance(topics_in, list):
        for t in topics_in:
            if not isinstance(t, dict):
                continue
            theme = str(t.get("theme", "")).strip() or "Related work"
            summary = str(t.get("summary", "")).strip()
            items_out: list[dict[str, Any]] = []
            for it in t.get("items") or []:
                if isinstance(it, dict):
                    hydrated = hydrate_identifiers(_prior_row(it, theme=theme))
                    items_out.append(hydrated)
                    flat.append(hydrated)
            if items_out:
                out_topics.append({"theme": theme, "summary": summary, "items": items_out})

    if flat:
        raw["prior_work_topics"] = out_topics
        raw["prior_work"] = flat
        return

    rows = raw.get("prior_work") or []
    norm_old: list[dict[str, Any]] = []
    for r in rows:
        if isinstance(r, dict):
            row = _prior_row(r)
            norm_old.append(hydrate_identifiers(row))
    raw["prior_work"] = norm_old
    raw["prior_work_topics"] = []


async def finalize_pre_reading_urls(raw: dict) -> None:
    items = raw.get("prior_work")
    if isinstance(items, list) and items:
        await enrich_urls_with_semantic_scholar(items)


def _canonical_bib_index(label: str) -> str | None:
    """First integer in bib label / ref_id, canonicalised ('07' → '7')."""
    m = re.search(r"\d+", str(label or ""))
    return str(int(m.group(0))) if m else None


def _arxiv_from_blob(blob: str) -> str | None:
    m = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5}(?:v\d+)?)", blob, flags=re.I)
    if m:
        return m.group(1)
    m = re.search(r"(?:arXiv|arxiv)\s*[:\s]+(\d{4}\.\d{4,5}(?:v\d+)?)", blob)
    return m.group(1) if m else None


def split_bibliography_chunks(bib: str) -> dict[str, str]:
    """Map bibliography index strings → contiguous text per entry (heuristic).

    Handles ``[17]``, ``17. Title``, ``(17) Title`` line starts commonly seen
    in PDF text dumps.
    """
    bib = (bib or "").replace("\r\n", "\n")
    if not bib.strip():
        return {}

    markers: list[tuple[int, str]] = []

    for m in re.finditer(r"(?:^|\n)\s*\[(\d{1,4})\]", bib):
        markers.append((m.start(0), str(int(m.group(1)))))

    for m in re.finditer(r"(?:^|\n)\s*(\d{1,4})\.\s+(?=[A-Za-z\"“„(\[{])", bib):
        num = str(int(m.group(1)))
        markers.append((m.start(0), num))

    for m in re.finditer(r"(?:^|\n)\s*\((\d{1,4})\)\s+(?=[A-Za-z\"“„])", bib):
        markers.append((m.start(0), str(int(m.group(1)))))

    markers.sort(key=lambda item: item[0])
    merged: list[tuple[int, str]] = []
    for pos, n in markers:
        if merged and pos == merged[-1][0]:
            continue
        merged.append((pos, n))

    chunks: dict[str, str] = {}
    for i, (start, num) in enumerate(merged):
        end = merged[i + 1][0] if i + 1 < len(merged) else len(bib)
        blob = bib[start:end].strip()
        if blob:
            chunks[num] = blob
    return chunks


_JUNK_HTTP = ("github.com", "creativecommons", "linkedin.com")


def _publisher_url_from_blob(blob: str) -> str | None:
    """First plausible journal / publisher HTTP(S) URL in a bibliography line."""
    for m in re.finditer(r"https?://[^\s\]\)>\"]+(?:\([\w./-]+\))?[^\s\]\)>\"]?", blob):
        u = m.group(0).rstrip(".,;)]\"\'")
        low = u.lower()
        if "doi.org" in low or "arxiv.org" in low:
            continue
        if len(u) < 18:
            continue
        if any(j in low for j in _JUNK_HTTP):
            continue
        return u
    return None


def enrich_prior_work_from_bibliography(items: list[dict[str, Any]], bib_text: str) -> None:
    """Fill doi / arxiv / url when the reference list excerpt contains them."""

    chunks = split_bibliography_chunks(bib_text)
    if not chunks or not items:
        return

    for it in items:
        if not isinstance(it, dict):
            continue
        key = _canonical_bib_index(it.get("bib_label") or it.get("ref_id") or "")
        if not key:
            continue
        blob = chunks.get(key)
        if not blob:
            continue

        doi = _doi_norm(blob)
        arx = _arxiv_from_blob(blob)

        pub = None
        if not doi and not arx:
            pub = _publisher_url_from_blob(blob)

        touched = False
        if doi and not (str(it.get("doi") or "")).strip():
            it["doi"] = doi
            touched = True
        if arx and not (str(it.get("arxiv") or "")).strip():
            it["arxiv"] = arx
            touched = True
        if pub and not (str(it.get("url") or "")).strip():
            it["url"] = pub
            touched = True

        if touched:
            it.update(hydrate_identifiers(it))
