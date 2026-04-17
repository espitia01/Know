"""API routes for search functionality."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from ..models.schemas import SearchResponse, SearchResult
from ..services.pdf_parser import get_paper

router = APIRouter(prefix="/api/papers", tags=["search"])


@router.get("/{paper_id}/search", response_model=SearchResponse)
async def search_paper(paper_id: str, q: str = Query(..., min_length=1)):
    paper = get_paper(paper_id)
    if not paper:
        raise HTTPException(status_code=404, detail="Paper not found")

    query_lower = q.lower()
    results: list[SearchResult] = []

    content_lower = paper.content_markdown.lower()
    start_idx = 0
    while True:
        idx = content_lower.find(query_lower, start_idx)
        if idx == -1:
            break
        start = max(0, idx - 80)
        end = min(len(paper.content_markdown), idx + len(q) + 80)
        snippet = paper.content_markdown[start:end]
        if start > 0:
            snippet = "..." + snippet
        if end < len(paper.content_markdown):
            snippet = snippet + "..."
        results.append(
            SearchResult(section="Paper", snippet=snippet.strip(), match_type="content")
        )
        start_idx = idx + len(q)
        if len(results) >= 20:
            break

    for ref in paper.references:
        if query_lower in ref.text.lower():
            results.append(
                SearchResult(
                    section="References",
                    snippet=ref.text[:150],
                    match_type="reference",
                )
            )

    return SearchResponse(query=q, results=results)
