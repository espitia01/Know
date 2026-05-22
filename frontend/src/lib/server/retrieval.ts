/**
 * Server-side retrieval helper — calls Python /api/internal/retrieve.
 */

import "server-only";

const BASE = () => process.env.INTERNAL_BACKEND_URL || "";
const TOKEN = () => process.env.INTERNAL_BACKEND_TOKEN || "";

export type RetrievalHit = {
  paper_id?: string;
  chunk_index?: number;
  similarity?: number | null;
};

export type RetrievalResult = {
  context: string;
  hits: RetrievalHit[];
  passage_count: number;
};

export async function retrievePaperContext(args: {
  userId: string;
  paperIds: string[];
  query: string;
  maxChars?: number;
  topK?: number;
}): Promise<RetrievalResult> {
  const base = BASE();
  const token = TOKEN();
  if (!base || !token) {
    return { context: "", hits: [], passage_count: 0 };
  }
  try {
    const res = await fetch(`${base}/api/internal/retrieve`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        user_id: args.userId,
        paper_ids: args.paperIds,
        query: args.query,
        max_chars: args.maxChars ?? 8000,
        top_k: args.topK ?? 8,
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      return { context: "", hits: [], passage_count: 0 };
    }
    const data = (await res.json()) as RetrievalResult;
    return {
      context: data.context || "",
      hits: data.hits || [],
      passage_count: data.passage_count ?? (data.hits?.length ?? 0),
    };
  } catch {
    return { context: "", hits: [], passage_count: 0 };
  }
}
