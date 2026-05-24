"""Re-apply OCR markdown cleanup to papers with cached page_markdown."""

from __future__ import annotations

import argparse
import logging

from app.services.db import get_db
from app.services.ocr_cleanup import clean_ocr_markdown
from app.services.pdf_parser import get_paper, mutate_paper

logger = logging.getLogger(__name__)


def _process_paper(paper_id: str, user_id: str, dry_run: bool) -> bool:
    paper = get_paper(paper_id, user_id=user_id)
    if not paper or paper.ocr_status != "ready" or not paper.page_markdown:
        return False

    page_md, joined = clean_ocr_markdown(list(paper.page_markdown), list(paper.ocr_images))

    if dry_run:
        logger.info(
            "Would clean OCR markdown for %s (%s pages, %s chars)",
            paper_id,
            len(page_md),
            len(joined),
        )
        return True

    def _apply(p):
        p.page_markdown = page_md
        p.markdown = joined

    mutate_paper(paper_id, user_id, _apply)
    return True


def main(limit: int, user_id: str | None, dry_run: bool) -> None:
    client = get_db()
    if not client:
        raise SystemExit("Database unavailable")

    query = (
        client.table("papers")
        .select("id,user_id,ocr_status")
        .eq("ocr_status", "ready")
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
            if _process_paper(pid, uid, dry_run):
                ok += 1
                logger.info("OCR cleanup backfill ok: %s", pid)
        except Exception as exc:
            logger.error("OCR cleanup backfill failed for %s: %s", pid, exc)

    logger.info("OCR cleanup backfill complete: %s/%s papers", ok, len(rows))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Re-apply OCR markdown cleanup to cached papers")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--user-id", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    main(args.limit, args.user_id, args.dry_run)
