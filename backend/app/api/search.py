"""API routes for search functionality."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Depends

from ..models.schemas import SearchResponse, SearchResult
from ..services.pdf_parser import get_paper
from ..auth import require_auth
from .papers import _validate_id, _verify_paper_owner

router = APIRouter(prefix="/api/papers", tags=["search"])


MAX_SEARCH_QUERY = 500


@router.get("/{paper_id}/search", response_model=SearchResponse)
async def search_paper(
    paper_id: str,
    q: str = Query(..., min_length=1, max_length=MAX_SEARCH_QUERY),
    user_id: str = Depends(require_auth),
):
    """Search the raw text of a paper for a literal substring.

    M2: the query string is now bounded both by FastAPI (``max_length``)
    and by a defensive slice below. An unbounded query passed through
    ``str.lower().find`` on a 500-page raw text could be turned into a
    CPU-heavy loop by adversarial pathological inputs.
    """
    _validate_id(paper_id, "paper_id")
    _verify_paper_owner(paper_id, user_id)
    paper = get_paper(paper_id, user_id=user_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    q = q[:MAX_SEARCH_QUERY]
    query_lower = q.lower()
    results: list[SearchResult] = []

    content = paper.raw_text or ""
    content_lower = content.lower()
    start_idx = 0
    while True:
        idx = content_lower.find(query_lower, start_idx)
        if idx == -1:
            break
        start = max(0, idx - 80)
        end = min(len(content), idx + len(q) + 80)
        snippet = content[start:end]
        if start > 0:
            snippet = "..." + snippet
        if end < len(content):
            snippet = snippet + "..."
        results.append(
            SearchResult(section="Paper", snippet=snippet.strip(), match_type="content")
        )
        start_idx = idx + len(q)
        if len(results) >= 20:
            break

    return SearchResponse(query=q, results=results)
