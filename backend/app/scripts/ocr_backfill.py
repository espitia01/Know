"""Backfill Mistral OCR for papers missing markdown."""

from __future__ import annotations

import argparse
import asyncio
import logging

from app.config import settings
from app.services import storage as cloud_storage
from app.services.db import get_db
from app.services.ocr_mistral import run_mistral_ocr
from app.services.pdf_parser import get_paper, mutate_paper

logger = logging.getLogger(__name__)


async def _process_paper(paper_id: str, user_id: str) -> bool:
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        return False
    if paper.ocr_status == "ready" and paper.markdown.strip():
        return True

    pdf_path = settings.papers_dir / f"{paper_id}.pdf"
    content = pdf_path.read_bytes() if pdf_path.exists() else cloud_storage.download_file(user_id, f"{paper_id}.pdf")
    if not content:
        logger.warning("No PDF bytes for %s", paper_id)
        return False

    ocr = await run_mistral_ocr(content, paper_id, user_id)

    def _apply(p):
        p.markdown = ocr.markdown
        p.page_markdown = ocr.page_markdown
        p.ocr_images = ocr.images
        p.ocr_status = "ready"
        p.ocr_model = ocr.model

    mutate_paper(paper_id, user_id, _apply)
    return True


async def main(limit: int, user_id: str | None) -> None:
    client = get_db()
    if not client:
        raise SystemExit("Database unavailable")

    query = (
        client.table("papers")
        .select("id,user_id,ocr_status")
        .neq("ocr_status", "ready")
        .limit(limit)
    )
    if user_id:
        query = query.eq("user_id", user_id)
    rows = query.execute().data or []

    ok = 0
    for row in rows:
        pid = row["id"]
        uid = row["user_id"]
        try:
            if await _process_paper(pid, uid):
                ok += 1
                logger.info("OCR backfill ok: %s", pid)
        except Exception as exc:
            logger.error("OCR backfill failed for %s: %s", pid, exc)

    logger.info("Backfill complete: %s/%s papers", ok, len(rows))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Run Mistral OCR on papers missing markdown")
    parser.add_argument("--limit", type=int, default=20)
    parser.add_argument("--user-id", default=None)
    args = parser.parse_args()
    asyncio.run(main(args.limit, args.user_id))
