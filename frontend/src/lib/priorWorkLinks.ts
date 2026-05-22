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

/** Open Google Scholar with this reference’s text (verbatim bibliography line when present). */
export function scholarSearchHrefFromPriorWork(work: PriorWork): string | null {
  const raw =
    (typeof work.citation_display === "string" && work.citation_display.trim()) ||
    (work.title || "").trim();
  const q = raw.replace(/\s+/g, " ").trim();
  if (q.length < 6) return null;
  return `https://scholar.google.com/scholar?q=${encodeURIComponent(q.slice(0, 520))}`;
}

/** Prefer the bibliography index from extraction; fall back to list position. */
export function referenceIndexLabel(work: PriorWork, sequentialFallback: number): number {
  for (const candidate of [work.bib_label, work.ref_id]) {
    if (candidate == null) continue;
    const raw = String(candidate).trim();
    const digits = raw.match(/^(\d{1,4})$/);
    if (digits) return parseInt(digits[1], 10);
    const bracketed = raw.match(/^\[(\d{1,4})\]$/);
    if (bracketed) return parseInt(bracketed[1], 10);
  }
  return sequentialFallback;
}

/** Direct DOI/arXiv/PubMed link when known; otherwise Scholar search. */
export function priorWorkExternalHref(work: PriorWork): string | null {
  return priorWorkHref(work) ?? scholarSearchHrefFromPriorWork(work);
}
