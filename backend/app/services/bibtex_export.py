"""BibTeX export: cite keys and metadata from paper text."""

from __future__ import annotations

import re
from typing import Iterable

from .citation_resolve import _arxiv_from_blob, _doi_norm
from .exports.export_formatters import _extract_publication_year

_SKIP_TITLE_WORDS = frozenset({"a", "an", "the", "on", "in", "of", "for", "and", "to"})

_JOURNAL_RE = re.compile(
    r"(?:"
    r"Phys\.\s*Rev\.\s*(?:Lett\.|B|A|E|X)?|Physical Review(?: Letters| B| A)?|"
    r"Rev\.\s*Mod\.\s*Phys\.|Reviews of Modern Physics|"
    r"J\.\s*Chem\.\s*Phys\.|Journal of Chemical Physics|"
    r"Chem\.\s*Phys\.\s*Lett\.|Chemical Physics Letters|"
    r"Appl\.\s*Phys\.\s*Lett\.|Applied Physics Letters|"
    r"Nature(?: Communications| Physics)?|Science|"
    r"Proc\.\s*Natl\.\s*Acad\.\s*Sci\.|PNAS|"
    r"Nano Lett\.|ACS Nano|Angew\.\s*Chem\.|J\.\s*Phys\.\s*Chem\.|"
    r"Comput\.\s*Phys\.\s*Commun\.|Computer Physics Communications|"
    r"New Journal of Physics|Nucl\.\s*Phys\.|Optics Express|"
    r"IEEE|ACM|Springer|Elsevier"
    r")[^,\n]{0,60}",
    re.I,
)

_VOLUME_RE = re.compile(r"\b(?:Vol(?:ume)?\.?\s*)(\d+)\b", re.I)
_PAGES_RE = re.compile(r"\b(\d{1,4})\s*[–\-]\s*(\d{1,4})\b")
_ARXIV_PREPRINT_RE = re.compile(r"\b(?:19|20)\d{2}\b")


def _escape_bibtex(text: str) -> str:
    text = text.replace("\\", "\\textbackslash{}")
    for ch in ("&", "%", "#", "_", "~", "^", "$"):
        text = text.replace(ch, f"\\{ch}")
    text = text.replace("{", "\\{").replace("}", "\\}")
    return text


def _title_first_word(title: str) -> str:
    cleaned = re.sub(r"[^\w\s-]", " ", title or "")
    for word in re.split(r"[\s-]+", cleaned):
        token = re.sub(r"[^a-z0-9]", "", word.lower())
        if token and token not in _SKIP_TITLE_WORDS:
            return token
    return "paper"


def _first_author_last(authors: Iterable[str]) -> str:
    first = next(iter(authors or []), "").strip()
    if not first:
        return "unknown"
    if "," in first:
        last = first.split(",", 1)[0].strip()
    else:
        parts = first.split()
        last = parts[-1] if parts else first
    slug = re.sub(r"[^a-zA-Z-]", "", last).lower()
    return slug or "unknown"


def generate_bibtex_key(
    title: str,
    authors: list[str],
    year: str | None,
    *,
    used_keys: set[str],
) -> str:
    """``firstwordYYYYlastname`` — e.g. ``excited2003ismail-beigi``."""
    word = _title_first_word(title)
    yr = year or "0000"
    last = _first_author_last(authors)
    base = f"{word}{yr}{last}"
    base = re.sub(r"[^a-z0-9-]", "", base.lower()) or "paper0000unknown"
    key = base
    suffix = ord("a")
    while key in used_keys:
        key = f"{base}{chr(suffix)}"
        suffix += 1
    used_keys.add(key)
    return key


def _extract_journal(head: str) -> str | None:
    m = _JOURNAL_RE.search(head)
    if not m:
        return None
    journal = re.sub(r"\s+", " ", m.group(0)).strip(" ,.;")
    journal = re.sub(r"\s+\d{1,4}$", "", journal)
    return journal[:120] if journal else None


def _extract_volume_pages(head: str) -> tuple[str | None, str | None]:
    vol_m = _VOLUME_RE.search(head)
    volume = vol_m.group(1) if vol_m else None
    pages_m = _PAGES_RE.search(head)
    pages = f"{pages_m.group(1)}-{pages_m.group(2)}" if pages_m else None
    return volume, pages


def extract_bibtex_metadata(
    *,
    title: str,
    authors: list[str],
    raw_text: str,
) -> dict[str, str]:
    """Best-effort bibliographic fields from the title block / first pages."""
    head = (raw_text or "")[:6000]
    meta: dict[str, str] = {}

    year = _extract_publication_year(head[:3500])
    if year:
        meta["year"] = year

    doi = _doi_norm(head)
    if doi:
        meta["doi"] = doi

    arxiv = _arxiv_from_blob(head)
    if arxiv:
        meta["arxiv"] = arxiv

    journal = _extract_journal(head)
    if journal:
        meta["journal"] = journal

    volume, pages = _extract_volume_pages(head)
    if volume:
        meta["volume"] = volume
    if pages:
        meta["pages"] = pages

    if meta.get("doi"):
        meta["url"] = f"https://doi.org/{meta['doi']}"
    elif meta.get("arxiv"):
        meta["url"] = f"https://arxiv.org/abs/{meta['arxiv']}"

    # arXiv-only preprints often lack a journal line in the header.
    if meta.get("arxiv") and not meta.get("journal") and _ARXIV_PREPRINT_RE.search(head[:2500]):
        pass  # keep @article; eprint field covers preprints

    return meta


def paper_to_bibtex(
    *,
    title: str,
    authors: list[str],
    raw_text: str = "",
    used_keys: set[str] | None = None,
) -> str:
    """Render one BibTeX entry."""
    keys = used_keys if used_keys is not None else set()
    fields = extract_bibtex_metadata(title=title, authors=authors, raw_text=raw_text)
    cite_key = generate_bibtex_key(title, authors, fields.get("year"), used_keys=keys)

    author_str = _escape_bibtex(" and ".join(authors) if authors else "Unknown")
    lines = [
        f"@article{{{cite_key},",
        f"  title = {{{_escape_bibtex(title or 'Untitled')}}},",
        f"  author = {{{author_str}}},",
    ]

    for key in ("year", "journal", "volume", "pages", "doi", "url"):
        val = fields.get(key)
        if val:
            lines.append(f"  {key} = {{{_escape_bibtex(val)}}},")

    if fields.get("arxiv"):
        lines.append(f"  eprint = {{{_escape_bibtex(fields['arxiv'])}}},")
        lines.append("  archivePrefix = {arXiv},")

    if lines[-1].endswith(","):
        lines[-1] = lines[-1][:-1]
    lines.append("}")
    return "\n".join(lines)
