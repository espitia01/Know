"""Markdown → HTML for PDF export."""

from __future__ import annotations

import bleach

from .math_render import render_math_html

_ALLOWED_TAGS = [
    "p", "br", "strong", "em", "code", "pre", "blockquote",
    "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
    "a", "span", "div", "table", "thead", "tbody", "tr", "th", "td",
    "math", "mrow", "mi", "mo", "mn", "msup", "msub", "mfrac", "msqrt",
]
_ALLOWED_ATTRS = {"a": ["href"], "span": ["class"], "div": ["class"]}


def markdown_to_html(md: str) -> str:
    if not md:
        return ""
    with_math = render_math_html(md)
    try:
        from markdown_it import MarkdownIt

        html = MarkdownIt("commonmark", {"breaks": True}).render(with_math)
    except ImportError:
        html = f"<p>{with_math}</p>"
    return bleach.clean(html, tags=_ALLOWED_TAGS, attributes=_ALLOWED_ATTRS, strip=True)
