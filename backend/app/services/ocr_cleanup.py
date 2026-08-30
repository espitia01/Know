"""Server-side OCR markdown cleanup — ports of MarkdownReader heuristics."""

from __future__ import annotations

import math
import re

from ..models.schemas import OcrImage

_PAGE_BOUNDARY = "\n<!--PAGE_BOUNDARY-->\n"


def strip_running_headers_footers(pages: list[str]) -> list[str]:
    """Drop short lines appearing on >=50% of pages near top/bottom."""
    if len(pages) < 2:
        return list(pages)
    sample = 4
    counts: dict[str, int] = {}
    per_page_sets: list[list[str]] = []
    for page in pages:
        lines = page.split("\n")
        non_blank = [ln for ln in lines if ln.strip()]
        head = non_blank[:sample]
        tail = non_blank[-sample:]
        page_set = list(dict.fromkeys([*head, *tail]))
        per_page_sets.append(page_set)
        for line in page_set:
            t = line.strip()
            if not t or len(t) > 140:
                continue
            if t.startswith("#") or t.startswith("!") or t.startswith("|"):
                continue
            counts[t] = counts.get(t, 0) + 1
    threshold = max(2, math.ceil(len(pages) * 0.5))
    drop = {k for k, n in counts.items() if n >= threshold}
    if not drop:
        return list(pages)
    return [
        "\n".join(ln for ln in page.split("\n") if ln.strip() not in drop)
        for page in pages
    ]


def strip_page_number_footers(text: str) -> str:
    """Drop journal copyright lines and duplicated page-id pairs."""
    out: list[str] = []
    for line in text.split("\n"):
        t = line.strip()
        if not t:
            out.append(line)
            continue
        if re.match(r"^[\d\-]{3,}\s+[\d\-]{3,}$", t) and re.search(r"\d-\d", t):
            continue
        if re.match(
            r"^\S+\s+\d{4}[\-/]\d{4}/\d.*©\s+\d{4}.*Physical Society",
            t,
            re.IGNORECASE,
        ) or re.search(r"©\s*\d{4}.+Physical Society", t, re.IGNORECASE):
            continue
        out.append(line)
    return "\n".join(out)


def strip_ocr_ascii_fallback(text: str) -> str:
    """Drop glyph-per-paragraph OCR fallback stacks (>=3 short lines)."""
    lines = text.split("\n")
    out: list[str] = []
    i = 0

    def is_short_glyph(s: str) -> bool:
        t = s.strip()
        if not t or len(t) > 5:
            return False
        if re.match(r"^[#>|`]", t):
            return False
        if re.match(r"^\d+\.$", t):
            return False
        if t.startswith("!["):
            return False
        if re.match(r"^---+$", t):
            return False
        if re.match(r"^\* ", t):
            return False
        return True

    def drop_cluster_and_join(post_j: int) -> int:
        while out and not out[-1].strip():
            out.pop()
        k = post_j
        while k < len(lines) and not lines[k].strip():
            k += 1
        return k

    while i < len(lines):
        cluster: list[int] = []
        j = i
        while j < len(lines):
            if not lines[j].strip():
                if not cluster:
                    break
                k = j + 1
                while k < len(lines) and not lines[k].strip():
                    k += 1
                if k < len(lines) and is_short_glyph(lines[k]):
                    j = k
                    continue
                break
            if not is_short_glyph(lines[j]):
                break
            cluster.append(j)
            j += 1
        if len(cluster) >= 3:
            i = drop_cluster_and_join(j)
            continue
        if len(cluster) == 2:
            k = j
            while k < len(lines) and not lines[k].strip():
                k += 1
            follow_up = lines[k].strip() if k < len(lines) else ""
            concat = "".join(lines[idx].strip().replace("$", "") for idx in cluster)
            concat_letters = re.sub(r"[^A-Za-z0-9]", "", concat).lower()
            follow_letters = re.sub(
                r"[^A-Za-z0-9]", "", follow_up[:16]
            ).lower()
            if (
                len(concat_letters) >= 2
                and follow_letters.startswith(concat_letters)
            ):
                i = drop_cluster_and_join(j)
                continue
        out.append(lines[i])
        i += 1
    return "\n".join(out)


def dedupe_inline_math_duplicates(text: str) -> str:
    """Remove ASCII duplicates that follow inline `$...$` spans."""

    def strip_latex(s: str) -> str:
        s = re.sub(r"\\mathrm\{([^}]*)\}", r"\1", s)
        s = re.sub(r"\\text\{([^}]*)\}", r"\1", s)
        s = re.sub(r"\\[a-zA-Z]+", "", s)
        s = re.sub(r"[\\\s{}^_]", "", s)
        return s.lower()

    def strip_plain(s: str) -> str:
        return re.sub(r"[\s,]", "", s).lower()

    def repl(match: re.Match[str]) -> str:
        math_part = match.group(1)
        gap = match.group(2)
        tail = match.group(3)
        m = strip_latex(math_part)
        t = strip_plain(tail)
        if len(m) < 2 or len(t) < 2:
            return match.group(0)
        if (
            m == t
            or m == t.replace("%", "").replace("$", "")
            or m.replace("%", "").replace("$", "") == t
        ):
            normalized_gap = re.sub(r"[ \u00a0]+", " ", gap).rstrip()
            return f"${math_part}${normalized_gap}"
        return match.group(0)

    return re.sub(
        r"\$([^$\n]{1,80})\$([\s\u00a0]+)([^\s$<][^\s$<]{0,40})",
        repl,
        text,
    )


def collapse_fragmented_math_paragraphs(text: str) -> str:
    """Merge consecutive `$x$`-only paragraphs into one line."""
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not re.match(r"^\$[^$]{1,3}\$$", line.strip()):
            out.append(line)
            i += 1
            continue
        collected = [line.strip()]
        j = i + 1
        while j < len(lines) and (
            lines[j].strip() == ""
            or re.match(r"^\$[^$]{1,3}\$$", lines[j].strip())
        ):
            if lines[j].strip():
                collected.append(lines[j].strip())
            j += 1
        if len(collected) > 1:
            out.append(" ".join(collected))
        else:
            out.append(line)
        i = j
    return "\n".join(out)


def collapse_author_byline(text: str) -> str:
    """Collapse stacked affiliation marker lines into `<sup>` tags."""
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    byline_budget = 24

    def is_marker_line(s: str) -> bool:
        return bool(re.match(r"^[\s\d,.;:*†‡§¶∗∥]+$", s)) and len(s) <= 8

    while i < len(lines):
        line = lines[i]
        if byline_budget <= 0:
            out.append(line)
            i += 1
            continue
        if not line.strip():
            out.append(line)
            i += 1
            continue
        if re.match(r"^#{2,}\s", line) or re.match(
            r"^\s*(Abstract|ABSTRACT|INTRODUCTION)\b", line, re.IGNORECASE
        ):
            byline_budget = 0
            out.append(line)
            i += 1
            continue
        cluster: list[str] = []
        j = i + 1
        while j < len(lines):
            if not lines[j].strip():
                k = j + 1
                while k < len(lines) and not lines[k].strip():
                    k += 1
                if k < len(lines) and is_marker_line(lines[k].strip()):
                    j = k
                    continue
                break
            if not is_marker_line(lines[j].strip()):
                break
            cluster.append(lines[j].strip())
            j += 1
        has_digit = any(re.search(r"\d", c) for c in cluster)
        if len(cluster) >= 2 and has_digit:
            compact = re.sub(r"[^\d,]", "", ",".join(cluster)).split(",")
            unique = list(dict.fromkeys(x for x in compact if x))
            marker = ",".join(unique)
            out.append(f"{line}<sup>{marker}</sup>")
            i = j
            byline_budget -= 1
            continue
        out.append(line)
        i += 1
        byline_budget -= 1
    return "\n".join(out)


def wrap_byline_paragraph(text: str) -> str:
    """Wrap the post-title paragraph in `<p class=\"reader-byline\">`."""
    lines = text.split("\n")
    title_idx = next((idx for idx, ln in enumerate(lines) if re.match(r"^#\s+\S", ln)), -1)
    if title_idx < 0:
        return text
    byline_start = title_idx + 1
    while byline_start < len(lines) and not lines[byline_start].strip():
        byline_start += 1
    if byline_start >= len(lines):
        return text
    byline_end = byline_start
    while (
        byline_end < len(lines)
        and lines[byline_end].strip()
        and not lines[byline_end].startswith("#")
    ):
        byline_end += 1
    if byline_end == byline_start:
        return text
    byline_text = " ".join(lines[byline_start:byline_end])
    if not re.search(r"[,*†‡§¶∗^]", byline_text):
        return text
    wrapped = [
        *lines[:byline_start],
        f'<p class="reader-byline">{byline_text}</p>',
        *lines[byline_end:],
    ]
    return "\n".join(wrapped)


def drop_orphan_figure_refs(text: str) -> str:
    """Drop figure refs without a nearby Fig. N. caption."""
    lines = text.split("\n")
    caption_re = re.compile(r"^(Fig\.?|Figure)\s+\d+[.:]", re.IGNORECASE)
    img_re = re.compile(r"^\s*!\[[^\]]*\]\([^)]+\.png\)\s*$")
    composite_re = re.compile(r"\(fig-\d+\.png\)")
    out: list[str] = []
    for i, line in enumerate(lines):
        if not img_re.match(line):
            out.append(line)
            continue
        if composite_re.search(line):
            out.append(line)
            continue
        has_caption = False
        seen = 0
        for j in range(i + 1, len(lines)):
            t = lines[j].strip()
            if not t:
                continue
            if img_re.match(lines[j]):
                break
            seen += 1
            if seen > 6:
                break
            if caption_re.match(t):
                has_caption = True
                break
        if not has_caption:
            if out and not out[-1].strip():
                out.pop()
            continue
        out.append(line)
    return "\n".join(out)


def drop_panel_refs_when_composites_exist(text: str) -> str:
    """Drop panel refs when composite fig-N.png images exist on the same page."""
    if _PAGE_BOUNDARY in text:
        return _PAGE_BOUNDARY.join(
            drop_panel_refs_when_composites_exist(part)
            for part in text.split(_PAGE_BOUNDARY)
        )
    has_composite = bool(re.search(r"(?:^|[^A-Za-z0-9])fig-\d+\.png", text))
    if not has_composite:
        return text
    panel_re = re.compile(r"(?:^|[^A-Za-z0-9])p\d+-img-\d+\.png")
    out: list[str] = []
    for line in text.split("\n"):
        if panel_re.search(line):
            if out and not out[-1].strip():
                out.pop()
            continue
        out.append(line)
    return "\n".join(out)


def _apply_text_cleanup(text: str) -> str:
    text = strip_page_number_footers(text)
    # Collapse author byline before ASCII-fallback stripping — affiliation
    # markers are short digit/punctuation lines that look like glyph stacks.
    text = collapse_author_byline(text)
    text = wrap_byline_paragraph(text)
    text = strip_ocr_ascii_fallback(text)
    text = strip_ocr_ascii_fallback(text)
    text = drop_panel_refs_when_composites_exist(text)
    text = drop_orphan_figure_refs(text)
    text = dedupe_inline_math_duplicates(text)
    text = collapse_fragmented_math_paragraphs(text)
    return text


def clean_ocr_markdown(
    raw_pages: list[str],
    ocr_images: list[OcrImage],
) -> tuple[list[str], str]:
    """Apply all cleanup heuristics; return (cleaned_page_markdown, joined_markdown)."""
    _ = ocr_images  # reserved for future image-aware cleanup
    pages = strip_running_headers_footers(list(raw_pages))
    if not pages:
        return [], ""
    marked = _PAGE_BOUNDARY.join(pages)
    cleaned = _apply_text_cleanup(marked)
    cleaned_pages = cleaned.split(_PAGE_BOUNDARY)
    joined = "\n\n---\n\n".join(cleaned_pages)
    return cleaned_pages, joined
