"""pgvector retrieval over paper_chunks with excerpt fallback."""

from __future__ import annotations

import logging
import re
from typing import Sequence

from .embeddings import EmbeddingProviderError, embed_query
from .db import get_db, match_paper_chunks

logger = logging.getLogger(__name__)

_CHUNK_SIZE = 1200
_CHUNK_OVERLAP = 200
# Hard ceiling on raw_text fed into chunking. The internal-paper endpoint
# already caps at 200k chars; we keep a parallel ceiling here so a direct
# script-level call (backfill, retry) can't generate an unbounded
# embedding bill on a pathologically large paper.
_MAX_EMBED_CHARS = 300_000


def _chunk_text(raw: str) -> list[str]:
    """Split paper text into overlapping chunks for embedding."""
    text = (raw or "").strip()
    if not text:
        return []
    # Prefer paragraph boundaries
    paras = re.split(r"\n\s*\n", text)
    chunks: list[str] = []
    buf = ""
    for para in paras:
        para = para.strip()
        if not para:
            continue
        candidate = f"{buf}\n\n{para}".strip() if buf else para
        if len(candidate) <= _CHUNK_SIZE:
            buf = candidate
            continue
        if buf:
            chunks.append(buf)
        # Long paragraph: hard-split
        while len(para) > _CHUNK_SIZE:
            chunks.append(para[:_CHUNK_SIZE])
            para = para[_CHUNK_SIZE - _CHUNK_OVERLAP :]
        buf = para
    if buf:
        chunks.append(buf)
    return chunks


async def embed_paper(paper_id: str, user_id: str, raw_text: str) -> int:
    """Chunk and embed a paper. Returns number of chunks stored."""
    from .embeddings import embed_texts
    from .db import delete_paper_chunks, insert_paper_chunks

    capped = (raw_text or "")[:_MAX_EMBED_CHARS]
    chunks = _chunk_text(capped)
    if not chunks:
        return 0
    try:
        vectors = await embed_texts(chunks)
    except EmbeddingProviderError:
        raise
    delete_paper_chunks(paper_id, user_id)
    rows = [
        {"chunk_index": i, "text": c, "embedding": v, "section": None}
        for i, (c, v) in enumerate(zip(chunks, vectors))
    ]
    insert_paper_chunks(paper_id, user_id, rows)
    return len(rows)


async def retrieve_for_paper(
    paper_ids: Sequence[str],
    query: str,
    *,
    user_id: str,
    max_chars: int = 8000,
    top_k: int = 8,
) -> tuple[str, list[dict]]:
    """Return concatenated retrieved context and hit metadata.

    On embedding/pgvector failure, returns ("", []) so callers can fall back.
    """
    q = (query or "").strip()
    if not q or not paper_ids or not user_id:
        return "", []

    try:
        query_vec = await embed_query(q)
    except EmbeddingProviderError as exc:
        logger.info("Retrieval skipped (embed): %s", exc.code)
        return "", []

    hits = match_paper_chunks(
        list(paper_ids), query_vec, user_id=user_id, match_count=top_k,
    )
    if not hits:
        return "", []

    parts: list[str] = []
    meta: list[dict] = []
    total = 0
    for hit in hits:
        content = (hit.get("text") or hit.get("content") or "").strip()
        if not content:
            continue
        snippet = content
        if total + len(snippet) > max_chars:
            remaining = max_chars - total
            if remaining <= 200:
                break
            snippet = snippet[:remaining]
        parts.append(snippet)
        dist = hit.get("distance")
        # Anchored Q&A: keep a short preview of the chunk text alongside the
        # already-stored chunk_index. Frontend uses the preview as the
        # tooltip on the source chip and as the needle when fuzzy-anchoring
        # back into the PDF.
        preview = snippet[:240].strip()
        # If the chunk happens to start with the section heading we stamped
        # on it during embedding, strip the duplicate so the preview reads
        # as body text.
        section = hit.get("section")
        if isinstance(section, str) and section and preview.lower().startswith(section.lower()):
            preview = preview[len(section):].lstrip(" :\n-")
        meta.append({
            "paper_id": hit.get("paper_id"),
            "chunk_index": hit.get("chunk_index"),
            "section": section,
            "snippet": preview,
            "similarity": (1.0 - float(dist)) if dist is not None else None,
        })
        total += len(snippet) + 2
        if total >= max_chars:
            break

    if not parts:
        return "", []
    return "\n\n---\n\n".join(parts), meta
