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
_CROSSREF_SEARCH = "https://api.crossref.org/works"
_MAX_CROSSREF_LOOKUPS = 36
_CROSSREF_USER_AGENT = "KnowPaperReader/1.0 (https://github.com/espitia01/Know; mailto:dev@know.app)"


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


def _arxiv_from_blob(blob: str) -> str | None:
    """Extract an arXiv id from a raw reference line or block."""
    s = blob or ""
    m = re.search(r"arxiv\.org/(?:abs|pdf)/(\d{4}\.\d{4,5})(v\d+)?", s, flags=re.I)
    if m:
        return _arxiv_norm(f"{m.group(1)}{m.group(2) or ''}")
    m = re.search(r"(?:arXiv|arxiv)\s*[:\s#]+(\d{4}\.\d{4,5})(v\d+)?", s, flags=re.I)
    if m:
        return _arxiv_norm(f"{m.group(1)}{m.group(2) or ''}")
    return None


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


def _snippet_for_semantic_search(it: dict[str, Any]) -> str:
    raw = ""
    cd = str(it.get("citation_display") or "").strip()
    if cd:
        raw = cd
    else:
        raw = str(it.get("title") or "").strip()
    s = " ".join(raw.split())
    s = re.sub(r"^[\[\d\]\s.)]+\s*", "", s)
    return s[:520].strip()


def normalize_prior_row_hydrated(d: dict[str, Any]) -> dict[str, Any]:
    """Normalise mixed LLM/server rows and hydrate doi / URL fields."""
    return hydrate_identifiers(_prior_row(d))


async def enrich_urls_with_semantic_scholar(items: list[dict[str, Any]]) -> None:
    """Mutate items in place: fill ``url`` when empty using S2 (bounded)."""
    need: list[tuple[int, str]] = []
    for i, it in enumerate(items):
        if (it.get("url") or "").strip():
            continue
        ttl = _snippet_for_semantic_search(it)
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
        "citation_display": str(it.get("citation_display", "")),
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


async def _crossref_bibliographic_doi(query: str) -> str | None:
    q = " ".join((query or "").split()).strip()
    if len(q) < 42:
        return None
    try:
        async with httpx.AsyncClient(timeout=14.0) as client:
            r = await client.get(
                _CROSSREF_SEARCH,
                params={"query.bibliographic": q[:980], "rows": 8},
                headers={"User-Agent": _CROSSREF_USER_AGENT},
            )
            if r.status_code != 200:
                return None
            data = r.json()
    except Exception as e:
        logger.debug("Crossref lookup failed: %s", e)
        return None

    works = (((data.get("message") or {}) if isinstance(data, dict) else {}) or {}).get("items") or []
    works = [w for w in works if isinstance(w, dict)]
    if not works:
        return None
    ql_strip = re.sub(r"^[\[\]\d\s\).]+", "", q.lower()).strip()

    for w in works:
        titles = (w.get("title") or []) if isinstance(w.get("title"), list) else []
        ttl_raw = titles[0] if titles else str(w.get("title") or "")
        ttl_lc = ttl_raw.strip().lower() if ttl_raw else ""
        doi_raw = str(w.get("DOI") or "").strip()
        if not doi_raw or not ttl_lc:
            continue
        if _title_overlap_ok(ql_strip, ttl_lc):
            return doi_raw.lower()

    if len(works) == 1:
        w = works[0]
        titles = (w.get("title") or []) if isinstance(w.get("title"), list) else []
        ttl_raw = titles[0] if titles else str(w.get("title") or "")
        ttl_lc = ttl_raw.strip().lower() if ttl_raw else ""
        doi_raw = str(w.get("DOI") or "").strip()
        if doi_raw and ttl_lc:
            head = ttl_lc[: min(72, len(ttl_lc))]
            if _title_overlap_ok(ql_strip, ttl_lc) or (len(head) > 16 and head in ql_strip):
                return doi_raw.lower()

    return None


async def enrich_dois_via_crossref(items: list[dict[str, Any]]) -> None:
    """Fill missing DOIs via Crossref ``query.bibliographic``."""

    need: list[tuple[int, str]] = []
    for i, it in enumerate(items):
        if (str(it.get("doi") or "")).strip():
            continue
        q = _snippet_for_semantic_search(it)
        if len(q) >= 42:
            need.append((i, q[:980]))

    need = need[:_MAX_CROSSREF_LOOKUPS]
    if not need:
        return

    sem = asyncio.Semaphore(3)

    async def one(idx: int, query: str) -> tuple[int, str | None]:
        async with sem:
            doi = await _crossref_bibliographic_doi(query)
            return idx, doi

    out = await asyncio.gather(*[one(i, q) for i, q in need])
    for idx, doi_raw in out:
        if not doi_raw:
            continue
        it = items[idx]
        if (str(it.get("doi") or "")).strip():
            continue
        it["doi"] = doi_raw
        it.update(hydrate_identifiers(it))


async def finalize_pre_reading_urls(raw: dict) -> None:
    items = raw.get("prior_work")
    if isinstance(items, list) and items:
        await enrich_dois_via_crossref(items)
        await enrich_urls_with_semantic_scholar(items)


def _canonical_bib_index(label: str) -> str | None:
    """First integer in bib label / ref_id, canonicalised ('07' → '7')."""
    m = re.search(r"\d+", str(label or ""))
    return str(int(m.group(0))) if m else None


_MAX_INLINE_BIB_RANGE = 42


def expand_bib_label_to_canonical_keys(fragment: Any) -> list[str]:
    """Turn ``12``, ``[1–3]``, ``1-5``, ``1—7`` … into discrete canonical bibliography keys."""

    raw = str(fragment if fragment is not None else "").strip()
    if not raw:
        return []
    raw_norm = raw.replace("—", "-").replace("–", "-")

    rng = re.match(
        r"^\s*\[?\s*(\d{1,4})\s*-\s*(\d{1,4})\s*\]?\s*$",
        raw_norm,
    )
    if rng:
        a, b = int(rng.group(1)), int(rng.group(2))
        lo, hi = (a, b) if a <= b else (b, a)
        if hi - lo > _MAX_INLINE_BIB_RANGE:
            hi = lo + _MAX_INLINE_BIB_RANGE
        return [str(i) for i in range(lo, hi + 1)]

    solo = _canonical_bib_index(raw_norm)
    return [solo] if solo else []


def split_bibliography_chunks(bib: str) -> dict[str, str]:
    """Map bibliography index strings → contiguous text per entry (heuristic).

    Handles ``[17]``, ``17. Title``, ``(17) Title`` line starts commonly seen
    in PDF text dumps.
    """
    bib = (bib or "").replace("\r\n", "\n")
    bstrip = bib.strip()
    if not bstrip:
        return {}

    markers: list[tuple[int, str]] = []

    for m in re.finditer(r"(?:^|\n)\s*\[\s*(\d{1,4})\s*\]", bib):
        markers.append((m.start(0), str(int(m.group(1)))))

    for m in re.finditer(r"(?:^|\n)\s*(\d{1,4})\.\s*(?=[A-Za-z\"“„(\[{0-9≤≥])", bib):
        markers.append((m.start(0), str(int(m.group(1)))))

    for m in re.finditer(r"(?:^|\n)\s*\((\d{1,4})\)\s+(?=[A-Za-z\"“„])", bib):
        markers.append((m.start(0), str(int(m.group(1)))))

    for m in re.finditer(r"(?:^|\n)\s*(\d{1,4})\)\s+(?=[A-Za-z\"“„(\[{])", bib):
        markers.append((m.start(0), str(int(m.group(1)))))

    if not markers:
        for m in re.finditer(
            r"(?<=[\s\.\)])(\d{1,4})\.\s+(?=[A-Z\"“„][A-Za-z\.])",
            bib,
        ):
            ctx = bib[max(0, m.start() - 24) : m.start()]
            if re.search(
                r"(?:doi:|10\.\d{4,9}/|arxiv\.org|arxiv:\s*\d{3,4}\.)\s*$",
                ctx,
                re.I,
            ):
                continue
            markers.append((m.start(0), str(int(m.group(1)))))

        if markers:
            nums = [int(n) for _, n in markers]
            good = sum(1 for i in range(1, len(nums)) if nums[i] >= nums[i - 1] - 1)
            if good / max(1, len(nums) - 1) < 0.75:
                markers = []

    markers.sort(key=lambda item: item[0])
    merged: list[tuple[int, str]] = []
    for pos, n in markers:
        if merged and pos == merged[-1][0]:
            continue
        merged.append((pos, n))

    if len(merged) <= 1 and len(bstrip) >= 80:
        inline_found: list[tuple[int, str]] = []
        for m in re.finditer(
            r"(?:^|(?<=[\s\.\)]))(\d{1,4})\.\s+(?=[A-Z\"“„][A-Za-z\.])",
            bib,
        ):
            ctx = bib[max(0, m.start() - 24) : m.start()]
            if re.search(
                r"(?:doi:|10\.\d{4,9}/|arxiv\.org|arxiv:\s*\d{3,4}\.)\s*$",
                ctx,
                re.I,
            ):
                continue
            inline_found.append((m.start(0), str(int(m.group(1)))))
        if len(inline_found) >= 2:
            nums = [int(n) for _, n in inline_found]
            good = sum(1 for i in range(1, len(nums)) if nums[i] >= nums[i - 1] - 1)
            if good / max(1, len(nums) - 1) >= 0.75:
                merged = inline_found

    chunks: dict[str, str] = {}
    for i, (start, num) in enumerate(merged):
        end = merged[i + 1][0] if i + 1 < len(merged) else len(bib)
        blob = bib[start:end].strip()
        if blob:
            chunks[num] = blob

    if not chunks and len(bstrip) >= 80:
        parts = re.split(r"(?<=[.\]])\s+(?=[A-Z][a-z]?[.,]\s+[A-Z])", bstrip)
        parts = [p.strip() for p in parts if len(p.strip()) >= 30]
        if len(parts) >= 2:
            return {str(i + 1): p[:4000] for i, p in enumerate(parts[:120])}
        if re.search(
            r"\b(?:doi:\s*|10\.\d{4,9}/|arXiv:\s*|arxiv\.org/|https?://|"
            r"Vol\.?\s*\d|pp\.\s*\d+|\d{4}\.\d{4,5}(?:v\d+)?|"
            r"Springer|IEEE|ACM|Press|University|Journal)\b",
            bstrip,
            re.I,
        ):
            return {"1": bstrip[:1200]}

    if not chunks and len(bstrip) >= 30:
        return {"1": bstrip[:1200]}

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


def merge_reference_summaries(entries: list[dict[str, Any]], summaries: Any) -> None:
    """Attach model-written one-line notes keyed by bibliography index."""

    if not isinstance(summaries, list) or not entries:
        return
    by_label: dict[str, str] = {}
    for s in summaries:
        if not isinstance(s, dict):
            continue
        rel = str(s.get("relevance", "") or "").strip()
        if not rel:
            continue
        for k in expand_bib_label_to_canonical_keys(str(s.get("bib_label") or "")):
            by_label[k] = rel
    for e in entries:
        k = _canonical_bib_index(str(e.get("bib_label") or e.get("ref_id") or ""))
        if k and k in by_label:
            e["relevance"] = by_label[k]


def bibliography_to_prior_work_entries(bib_text: str, *, max_items: int = 120) -> list[dict[str, Any]]:
    """Build flat prior-work rows from raw bibliography text — order-preserving."""

    chunks = split_bibliography_chunks(bib_text or "")
    if not chunks:
        return []

    def num_key(idx: str) -> int:
        try:
            return int(idx)
        except ValueError:
            return 10**9

    keys = sorted(chunks.keys(), key=num_key)[:max_items]
    out: list[dict[str, Any]] = []
    for key in keys:
        blob = (chunks.get(key) or "").strip()
        if not blob:
            continue
        raw_lines = [ln.strip() for ln in blob.replace("\r\n", "\n").split("\n") if ln.strip()]
        citation_display = "\n".join(raw_lines) if raw_lines else blob
        condensed = " ".join(raw_lines) if raw_lines else " ".join(blob.split())
        out.append(
            {
                "bib_label": key,
                "ref_id": key,
                "title": condensed[:480],
                "citation_display": citation_display,
                "relevance": "",
                "doi": "",
                "arxiv": "",
                "url": "",
                "theme": "",
            }
        )
    return out


def build_prior_work_topics_from_clusters(rows: list[dict[str, Any]], clusters_in: Any) -> list[dict[str, Any]]:
    """Turn optional model clusters into ``prior_work_topics`` (shared row dict refs)."""

    if not isinstance(rows, list) or not rows:
        return []
    if not isinstance(clusters_in, list) or not clusters_in:
        return []

    by_bib: dict[str, dict[str, Any]] = {}
    for r in rows:
        if not isinstance(r, dict):
            continue
        k = _canonical_bib_index(str(r.get("bib_label") or r.get("ref_id") or ""))
        if k:
            by_bib[k] = r

    used: set[str] = set()
    out_topics: list[dict[str, Any]] = []

    for c in clusters_in:
        if not isinstance(c, dict):
            continue
        theme = str(c.get("theme", "")).strip() or "References"
        summary = str(c.get("summary", "") or "").strip()
        labels_raw = c.get("bib_labels") if isinstance(c.get("bib_labels"), list) else []
        items: list[dict[str, Any]] = []
        for lab in labels_raw:
            for k in expand_bib_label_to_canonical_keys(str(lab)):
                if not k or k in used or k not in by_bib:
                    continue
                items.append(by_bib[k])
                used.add(k)

        items.sort(
            key=lambda row: (
                int(_canonical_bib_index(str(row.get("bib_label") or row.get("ref_id") or "")) or "99999")
            ),
        )
        if items:
            out_topics.append({"theme": theme, "summary": summary, "items": items})

    if not out_topics:
        return []

    other_keys = [k for k in by_bib if k not in used]
    if other_keys:
        other_items = [by_bib[k] for k in sorted(other_keys, key=lambda x: int(x) if str(x).isdigit() else 10**9)]
        out_topics.append({"theme": "Other references", "summary": "", "items": other_items})

    return out_topics


_S2_PAPER = "https://api.semanticscholar.org/graph/v1/paper"
_S2_CITATIONS = "https://api.semanticscholar.org/graph/v1/paper/{paper_id}/citations"
_CITATION_FIELDS = "title,year,authors,url,externalIds,citationCount,paperId"


async def resolve_paper_s2_id(
    title: str,
    doi: str | None = None,
    arxiv: str | None = None,
) -> str | None:
    """Return the Semantic Scholar paperId for this manuscript."""
    headers = {"User-Agent": "KnowPaperReader/1.0 (+https://github.com/espitia01/Know)"}
    try:
        async with httpx.AsyncClient(timeout=_S2_TIMEOUT) as client:
            if doi:
                d = _doi_norm(doi)
                if d:
                    r = await client.get(
                        f"{_S2_PAPER}/DOI:{d}",
                        params={"fields": "paperId,title"},
                        headers=headers,
                    )
                    if r.status_code == 200:
                        data = r.json()
                        if isinstance(data, dict) and data.get("paperId"):
                            return str(data["paperId"])
            if arxiv:
                a = _arxiv_norm(arxiv)
                if a:
                    r = await client.get(
                        f"{_S2_PAPER}/arXiv:{a}",
                        params={"fields": "paperId,title"},
                        headers=headers,
                    )
                    if r.status_code == 200:
                        data = r.json()
                        if isinstance(data, dict) and data.get("paperId"):
                            return str(data["paperId"])
            t = (title or "").strip()
            if len(t) >= 12:
                r = await client.get(
                    _S2_SEARCH,
                    params={"query": t[:350], "limit": 1, "fields": "paperId,title"},
                    headers=headers,
                )
                if r.status_code == 200:
                    rows = (r.json().get("data") or [])
                    if rows and isinstance(rows[0], dict) and rows[0].get("paperId"):
                        return str(rows[0]["paperId"])
    except Exception as e:
        logger.debug("resolve_paper_s2_id failed: %s", e)
    return None


async def fetch_cited_by(s2_id: str, limit: int = 50) -> list[dict]:
    """Hit /paper/{paperId}/citations and return normalized rows."""
    if not s2_id:
        return []
    headers = {"User-Agent": "KnowPaperReader/1.0 (+https://github.com/espitia01/Know)"}
    url = _S2_CITATIONS.format(paper_id=s2_id)
    params = {
        "fields": _CITATION_FIELDS,
        "limit": min(max(1, limit), 50),
    }
    try:
        async with httpx.AsyncClient(timeout=_S2_TIMEOUT) as client:
            r = await client.get(url, params=params, headers=headers)
            if r.status_code == 429:
                await asyncio.sleep(2.2)
                r = await client.get(url, params=params, headers=headers)
            if r.status_code != 200:
                logger.warning("S2 cited-by HTTP %s for %s", r.status_code, s2_id)
                return []
            data = r.json()
    except Exception as e:
        logger.warning("fetch_cited_by failed: %s", e)
        return []

    out: list[dict] = []
    for row in (data.get("data") or [])[:limit]:
        citing = row.get("citingPaper") if isinstance(row, dict) else None
        if not isinstance(citing, dict):
            continue
        authors_raw = citing.get("authors") or []
        authors = [
            (a.get("name") or "").strip()
            for a in authors_raw
            if isinstance(a, dict) and a.get("name")
        ]
        ext = citing.get("externalIds") if isinstance(citing.get("externalIds"), dict) else {}
        doi = ext.get("DOI") or ""
        arx = ext.get("ArXiv") or ""
        url_out = citing.get("url") or ""
        if not url_out and doi:
            url_out = f"https://doi.org/{doi}"
        elif not url_out and arx:
            url_out = f"https://arxiv.org/abs/{arx}"
        out.append({
            "title": (citing.get("title") or "").strip(),
            "year": citing.get("year"),
            "authors": authors,
            "url": url_out,
            "doi": doi,
            "arxiv": arx,
            "s2_id": citing.get("paperId") or "",
            "citation_count": citing.get("citationCount"),
        })
    return out
