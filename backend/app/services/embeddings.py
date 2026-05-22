"""OpenAI text embeddings for paper-chunk RAG."""

from __future__ import annotations

import logging
from typing import Sequence

import httpx

from ..config import settings

logger = logging.getLogger(__name__)

EMBEDDING_DIM = 1536


class EmbeddingProviderError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        self.message = message
        super().__init__(message)


async def embed_texts(texts: Sequence[str]) -> list[list[float]]:
    """Embed a batch of strings via OpenAI. Raises EmbeddingProviderError on failure."""
    if not texts:
        return []
    api_key = (settings.openai_api_key or "").strip()
    if not api_key:
        raise EmbeddingProviderError("embedding_unconfigured", "OpenAI API key not configured")

    model = settings.embedding_model or "text-embedding-3-small"
    payload = {"model": model, "input": list(texts)}

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            resp = await client.post(
                "https://api.openai.com/v1/embeddings",
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json=payload,
            )
    except httpx.HTTPError as exc:
        logger.warning("OpenAI embeddings request failed: %s", exc.__class__.__name__)
        raise EmbeddingProviderError("embedding_network", "Embedding request failed") from exc

    if resp.status_code != 200:
        logger.warning("OpenAI embeddings HTTP %s", resp.status_code)
        raise EmbeddingProviderError("embedding_api", f"Embedding API returned {resp.status_code}")

    data = resp.json()
    items = data.get("data") or []
    if len(items) != len(texts):
        raise EmbeddingProviderError("embedding_mismatch", "Unexpected embedding response size")

    # OpenAI returns items with index; sort for safety
    sorted_items = sorted(items, key=lambda x: x.get("index", 0))
    out: list[list[float]] = []
    for item in sorted_items:
        vec = item.get("embedding")
        if not isinstance(vec, list) or len(vec) != EMBEDDING_DIM:
            raise EmbeddingProviderError("embedding_dim", "Invalid embedding dimensions")
        out.append(vec)
    return out


async def embed_query(text: str) -> list[float]:
    vecs = await embed_texts([text])
    return vecs[0]
