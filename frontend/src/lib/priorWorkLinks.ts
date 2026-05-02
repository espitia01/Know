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
 * Prefer model-supplied URLs; otherwise infer arXiv/doi.org links from identifiers
 * and ``ref_id`` when unambiguous.
 */
function parseArxivId(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  let m = s.match(/^arxiv:\s*(\S+)$/i);
  if (m) s = m[1].trim();
  m = s.match(/^(\d{4}\.\d{4,5})(v\d+)?$/i);
  if (m) return `${m[1]}${m[2] ?? ""}`;
  return null;
}

export function priorWorkHref(work: PriorWork): string | null {
  const fromUrl = work.url ? sanitizePriorWorkHref(work.url) : null;
  if (fromUrl) return fromUrl;

  const doiRaw = (work.doi || "").trim();
  if (doiRaw) {
    const tail = doiRaw.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").trim();
    if (/^10\.\d{4,9}\//i.test(tail)) {
      return `https://doi.org/${encodeURIComponent(tail)}`;
    }
  }

  const ax = parseArxivId((work.arxiv || "").trim());
  if (ax) return `https://arxiv.org/abs/${ax}`;

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

/** Fallback when no canonical DOI / arXiv / publisher URL exists. */
export function scholarSearchHref(title: string): string | null {
  const t = title.trim();
  if (t.length < 6) return null;
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(t.slice(0, 400))}`;
}
