"""Backfill composite OCR figures for papers that already have Mistral markdown."""

from __future__ import annotations

import argparse
import logging

from app.config import settings
from app.services import storage as cloud_storage
from app.services.db import get_db
from app.services.ocr_mistral import recomposite_figures_for_paper
from app.services.pdf_parser import get_paper, mutate_paper

logger = logging.getLogger(__name__)


def _process_paper(paper_id: str, user_id: str, dry_run: bool) -> bool:
    paper = get_paper(paper_id, user_id=user_id)
    if not paper or paper.ocr_status != "ready" or not paper.page_markdown:
        return False

    pdf_path = settings.papers_dir / f"{paper_id}.pdf"
    content = pdf_path.read_bytes() if pdf_path.exists() else cloud_storage.download_file(user_id, f"{paper_id}.pdf")
    if not content:
        logger.warning("No PDF bytes for %s", paper_id)
        return False

    if dry_run:
        logger.info("Would recomposite figures for %s (%s pages)", paper_id, len(paper.page_markdown))
        return True

    page_md, images = recomposite_figures_for_paper(
        content,
        paper_id,
        user_id,
        list(paper.page_markdown),
        list(paper.ocr_images),
    )
    joined = "\n\n---\n\n".join(page_md)

    def _apply(p):
        p.page_markdown = page_md
        p.markdown = joined
        p.ocr_images = images

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
                logger.info("Composite backfill ok: %s", pid)
        except Exception as exc:
            logger.error("Composite backfill failed for %s: %s", pid, exc)

    logger.info("Composite backfill complete: %s/%s papers", ok, len(rows))


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    parser = argparse.ArgumentParser(description="Build composite OCR figures from cached markdown + PDF")
    parser.add_argument("--limit", type=int, default=50)
    parser.add_argument("--user-id", default=None)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    main(args.limit, args.user_id, args.dry_run)
