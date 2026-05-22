#!/usr/bin/env python3
"""Backfill paper_chunks embeddings for existing papers."""

from __future__ import annotations

import argparse
import asyncio
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


async def _embed_one(paper_id: str, user_id: str) -> int:
    from app.services.pdf_parser import get_paper
    from app.services.retrieval import embed_paper
    from app.services.embeddings import EmbeddingProviderError

    paper = get_paper(paper_id, user_id=user_id)
    if not paper or not (paper.raw_text or "").strip():
        return 0
    return await embed_paper(paper_id, user_id, paper.raw_text)


async def main() -> None:
    parser = argparse.ArgumentParser(description="Embed existing papers for RAG")
    parser.add_argument("--user-id", required=True)
    parser.add_argument("--paper-id", action="append", default=[])
    parser.add_argument("--all", action="store_true")
    args = parser.parse_args()

    paper_ids: list[str] = list(args.paper_id or [])
    if args.all:
        from app.services.db import list_papers

        rows = list_papers(args.user_id, limit=500)
        paper_ids = [r["id"] for r in rows if r.get("id")]

    total = 0
    for pid in paper_ids:
        try:
            n = await _embed_one(pid, args.user_id)
            logger.info("Embedded %s: %d chunks", pid, n)
            total += n
        except Exception as exc:
            logger.warning("Failed %s: %s", pid, exc)
    logger.info("Done — %d chunks across %d papers", total, len(paper_ids))


if __name__ == "__main__":
    asyncio.run(main())
