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

/** e.g. "… 15 15 2006." hangers after garbled merges */
function stripTrailingOrphanIndexTail(s: string): string {
  const re = /\s+(?:\d{1,3}[.)]?\s+){2,}(?:19|20)\d{2}\.\s*$/;
  let t = s;
  for (let i = 0; i < 4; i++) {
    const next = t.replace(re, "").trim();
    if (next === t) break;
    if (next.length < 72) break;
    t = next;
  }
  return t;
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
