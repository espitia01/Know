/**
 * Normalize bibliography excerpts for on-screen listing (collapse PDF line wraps,
 * drop duplicate numbering when our UI already shows index chips).
 */

/** Transformer / seq2seq dump tokens that leak into extracted references */
const MODEL_ANGLE_TAGS =
  /<\/?(?:eos|pad|unk|sep|cls|s|\/s|mask|bos)\b[^>]*>|<EOS>|<PAD>|<UNK>|<SEP>|<s>|<\/s>/gi;

export function normalizeBibliographyCitationLine(raw: string): string {
  let s = raw.replace(/\r\n/g, "\n").trim();
  if (!s) return "";

  /** Leading “13.” / “13 )” matching the numbered list badge beside the excerpt */
  s = s.replace(/^\s*\d{1,3}\s*[.)]\s+/u, "");
  /** Rare: “13 - Author” preamble */
  s = s.replace(/^\s*\d{1,3}\s*[—–\-]\s+/u, "");

  s = s.replace(/[\t\v\f]+/g, " ");
  /** Treat internal newlines as soft wraps (PDF column reflow artefacts) */
  s = s.replace(/\n+/g, " ");

  /** Soft hyphen artefacts from PDF extraction (e.g. “single­photon”) */
  s = s.replace(/\u00ad/g, "");
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}

/** Remove repeated duplicate sentence runs (model / PDF junk). */
function collapseDuplicateSentenceRuns(s: string): string {
  let t = s;
  for (let i = 0; i < 8; i++) {
    const next = t.replace(
      /(\b[\s\S]{24,360}?[.!?])\s+(?:\1\s*)+/giu,
      "$1 ",
    );
    if (next === t) break;
    t = next;
  }
  return t;
}

/**
 * Cut off paper body / figure-caption junk that was concatenated into a bib line
 * (common when raw_text paragraphs run together).
 */
function truncateAfterBibliographyBleed(s: string): string {
  /** Section headers / methods text glued after the bib paragraph (Attention is enough). */
  const att = /(?:^|[\s.])(\d{1,2})\s+Attention\b/i.exec(s);
  if (att && att.index !== undefined && att.index > 50) return s.slice(0, att.index).trim();

  const fig = /(?:^|[\s.])(Figure\s+\d+\s*[:\.])/i.exec(s);
  if (fig && fig.index !== undefined && fig.index > 80) return s.slice(0, fig.index).trim();

  return s;
}

/** e.g. "… 15 15 2006.", " … 15 2006." hangers after garbled merges */
function stripTrailingOrphanIndexTail(s: string): string {
  const tailPairWithYear =
    /\s+(?:\d{1,3}[.)]?\s+){2,}(?:19|20)\d{2}\.\s*$|\s+\d{1,3}[.)]\s+(?:19|20)\d{2}\.\s*$/u;
  let t = s;
  for (let i = 0; i < 6; i++) {
    const next = t.replace(tailPairWithYear, "").trim();
    if (next === t) break;
    if (next.length < 72) break;
    t = next;
  }
  return t;
}

/**
 * Themed cluster summaries in Related sometimes echo bare index/year lines.
 * Trim those before rendering as markdown.
 */
export function sanitizeRelatedClusterSummaryMarkdown(raw: string): string {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (/^(?:\d{1,4}[.)]?|(?:19|20)\d{2}\.)$/u.test(t)) return false;
    if (/^\d{1,3}\s+(?:19|20)\d{2}\.$/u.test(t)) return false;
    return true;
  });
  let body = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  body = body.replace(MODEL_ANGLE_TAGS, " ").replace(/\s{2,}/g, " ").trim();
  return body;
}

/**
 * Full pipeline for showing a single reference line in the UI (Related tab,
 * reader references list, etc.).
 */
export function sanitizeCitationForDisplay(raw: string): string {
  let s = normalizeBibliographyCitationLine(raw);
  s = s.replace(MODEL_ANGLE_TAGS, " ");
  s = collapseDuplicateSentenceRuns(s);
  s = truncateAfterBibliographyBleed(s);
  s = collapseDuplicateSentenceRuns(s);
  s = stripTrailingOrphanIndexTail(s);
  s = s.replace(/\s{2,}/g, " ").trim();
  return s;
}
