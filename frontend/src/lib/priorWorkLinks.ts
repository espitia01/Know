import type { PriorWork } from "@/lib/api";

/** Allowed external navigation targets from extracted metadata. */
export function sanitizePriorWorkHref(raw: string): string | null {
  const t = raw.trim();
  if (!t || !/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

/**
 * Prefer model-supplied URLs; otherwise infer arXiv/doi.org links from ``ref_id``
 * when the pattern is unambiguous.
 */
export function priorWorkHref(work: PriorWork): string | null {
  const fromUrl = work.url ? sanitizePriorWorkHref(work.url) : null;
  if (fromUrl) return fromUrl;

  const ref = (work.ref_id || "").trim();
  if (!ref) return null;

  if (/^https?:\/\//i.test(ref)) return sanitizePriorWorkHref(ref);

  let m = ref.match(/^arXiv:\s*(.+)$/i);
  let id = m?.[1]?.trim();
  if (!id) {
    m = ref.match(/^arxiv:\s*(\S+)/i);
    id = m?.[1]?.trim();
  }
  if (!id) {
    m = ref.match(/^(\d{4}\.\d{4,5})(v\d+)?$/i);
    if (m) id = `${m[1]}${m[2] ?? ""}`;
  }
  if (id) {
    id = id.replace(/^abs\//i, "").trim();
    if (/^\d{4}\.\d{4,5}(v\d+)?$/i.test(id)) return `https://arxiv.org/abs/${id}`;
  }

  const doiTail = ref.match(/(10\.\d{4,9}\/[^\s\]]+)/i)?.[1];
  if (doiTail) return `https://doi.org/${encodeURIComponent(doiTail)}`;

  const pmid = ref.match(/^PMID:?\s*(\d+)/i)?.[1] || ref.match(/^pubmed:?(\d+)$/i)?.[1];
  if (pmid) return `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`;

  return null;
}
