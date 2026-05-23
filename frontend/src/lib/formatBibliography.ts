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

/** Max characters for a single bibliography line in the UI (PDF glue often pastes the whole tail of the paper). */
const MAX_CITATION_DISPLAY_CHARS = 360;

/**
 * Cut off paper body / figure-caption junk that was concatenated into a bib line
 * (common when raw_text paragraphs run together).
 */
function truncateAfterBibliographyBleed(s: string): string {
  if (s.length >= 140) {
    const probe = s.slice(120);
    const sec = /\s(?=Introduction\b|Discussion\b|Abstract\b|METHODS\b|Results\b|Fig\.\s*\d)/i.exec(
      probe,
    );
    if (sec && sec.index !== undefined) {
      const cut = 120 + sec.index;
      return s.slice(0, cut).trim();
    }
  }
  /** Table / figure rows glued into bibliography (common in physics PDFs). */
  const tableRow =
    /\s\d{1,3}\.\d{1,2}\s+(?:Excited|Ground|State|Figure|Table)\b/i.exec(s) ||
    /\bRe\s*\([^)]{0,12}\)\s*!?\s*e\s*\(\s*cm/i.exec(s) ||
    /\bTe\s*\([^)]{0,12}\)\s*(?:CLDA|eV)\b/i.exec(s);
  if (tableRow && tableRow.index !== undefined && tableRow.index > 40) {
    return s.slice(0, tableRow.index).trim();
  }
  /** Numbered line immediately followed by another paper title starting with "Attention …" (transformer-artifact glue) */
  const att = /(?:^|[\s.])(?:\d{1,3}\s+Attention\s+is\b)/i.exec(s);
  if (att && att.index !== undefined && att.index > 50) return s.slice(0, att.index).trim();

  const fig = /(?:^|[\s.])(Figure\s+\d+\s*[:\.])/i.exec(s);
  if (fig && fig.index !== undefined && fig.index > 80) return s.slice(0, fig.index).trim();

  return s;
}

function clipCitationLineLength(s: string, max = MAX_CITATION_DISPLAY_CHARS): string {
  const t = s.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const lastBreak = Math.max(cut.lastIndexOf(", "), cut.lastIndexOf(". "), cut.lastIndexOf(" "));
  const base = lastBreak > Math.floor(max * 0.55) ? cut.slice(0, lastBreak) : cut;
  return `${base.trimEnd()}…`;
}

/** Remove standalone footnote-counter / year tokens (e.g. lines that contain
 *  only "21" or "2006." or pairs like "21\n2006.") that PDF bibliographies
 *  leak into LLM output. Safe to apply to any analysis markdown — only matches
 *  standalone tokens, never inline numbers in prose. */
export function stripOrphanCitationCounters(raw: string): string {
  let pre = raw.replace(/\r\n/g, "\n");

  for (let pass = 0; pass < 10; pass++) {
    const next = pre.replace(
      /(^|\n)\s*\d{1,3}\.{0,2}\s*\n\s*(?:19|20)\d{2}\.+/g,
      "$1",
    );
    if (next === pre) break;
    pre = next;
  }

  const lines = pre.split("\n");
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (/^\d{1,4}(?:\.(?!\d))?$/u.test(t)) return false;
    if (/^(?:19|20)\d{2}\.+\.?$/u.test(t)) return false;
    if (/^\[(?:19|20)\d{2}\]$/u.test(t)) return false;
    if (/^(?:\d{1,3}[.)]?|(?:19|20)\d{2}\.)$/u.test(t)) return false;
    if (/^\d{1,3}\s+(?:19|20)\d{2}\.$/u.test(t)) return false;
    if (/^(?:19|20)\d{2}\.{2,4}$/.test(t)) return false;
    return true;
  });
  let body = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  body = body.replace(
    /\n\s*(?:(?:\d{1,4}\.(?:\s+\d{1,4}\.)*|(?:19|20)\d{2}\.(?:\.?))+\s*\n)+\s*/g,
    "\n\n",
  );
  body = body.replace(/\.\s+(?:\d{1,3}\.{0,2}\s+){1,3}(?=\s*\[)/g, ". ");
  return body;
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
  let pre = raw.replace(/\r\n/g, "\n").trim();
  /** Citation footnote counters between “…year.” blocks and next “[\d+]” excerpt */
  pre = pre.replace(/\.\s*\n+\s*\d{1,3}\.{0,2}\s*\n+(?=\s*\[)/gu, ".\n\n");
  pre = stripOrphanCitationCounters(pre).trim();
  pre = pre.replace(MODEL_ANGLE_TAGS, " ").replace(/\s{2,}/g, " ").trim();
  return pre;
}

/**
 * Full pipeline for showing a single reference line in the UI (Related tab,
 * reader references list, etc.).
 */
/** Footnote bleed: ". 18 2006. 19 2017." after a real concluding year clause. */
function stripCitationIndexYearBleed(input: string): string {
  if (input.length < 92) return input;
  let t = input.trimEnd();
  for (let i = 0; i < 10; i++) {
    const next = t.replace(/(?:\.(?:\s+\d{1,3})+\s+(?:19|20)\d{2}\.)+$/u, ".");
    if (next === t) break;
    t = next.trimEnd();
  }
  return t;
}

export function sanitizeCitationForDisplay(raw: string): string {
  let s = normalizeBibliographyCitationLine(raw);
  s = s.replace(MODEL_ANGLE_TAGS, " ");
  s = collapseDuplicateSentenceRuns(s);
  s = truncateAfterBibliographyBleed(s);
  s = collapseDuplicateSentenceRuns(s);
  s = stripTrailingOrphanIndexTail(s);
  s = stripCitationIndexYearBleed(s);
  /** Collapsed-line footnote junk: “…2016. 16 [37]” */
  s = s.replace(/\.\s+(?:\d{1,3}\.{0,2}\s+){1,3}(?=\s*\[)/g, ". ");
  s = collapseDuplicateSentenceRuns(s);
  s = s.replace(/\s{2,}/g, " ").trim();
  if (s.length > 480) {
    s = `${s.slice(0, 480).replace(/\s+\S*$/, "")}…`;
  }
  s = clipCitationLineLength(s);
  return s;
}

/** True when a line is table junk, a bare index, or otherwise not a bibliography entry. */
export function isGarbledBibliographyLine(raw: string): boolean {
  const s = normalizeBibliographyCitationLine(raw);
  if (!s || s.length < 10) return true;
  if (/^[\d.\s()[\]{}]+$/.test(s)) return true;
  if (/^\d{1,3}\.\d{1,2}\s+[A-Za-z(~]/.test(s) && !/\b(?:doi|arxiv|vol\.|pp\.|press|journal|rev\.|lett\.|phys\.|chem\.)/i.test(s)) {
    return true;
  }
  if (/\bRe\s*\([^)]*\)\s*!?\s*e\s*\(\s*cm/i.test(s)) return true;
  if (/\bTe\s*\([^)]*\)\s*(?:CLDA|eV)\b/i.test(s)) return true;
  if (/~A1|!e\s*\(|\uFFFD/.test(s)) return true;
  const digits = (s.match(/\d/g) || []).length;
  if (digits / s.length > 0.38 && s.length < 100) return true;
  const alpha = (s.match(/[a-zA-Z]/g) || []).length;
  if (alpha < 8) return true;
  return false;
}

/** Cluster headings from the model should read like prose, not PDF table fragments. */
export function isUsableClusterTheme(theme: string): boolean {
  const t = (theme || "").trim();
  if (!t || /^other\s+references?$/i.test(t)) return false;
  if (t.length < 8 || t.length > 110) return false;
  if (isGarbledBibliographyLine(t)) return false;
  if (/^references$/i.test(t)) return false;
  return true;
}

/** Compact author + year label for graphs and chips. */
export function extractCitationShortLabel(raw: string): string {
  let s = normalizeBibliographyCitationLine(raw);
  s = s.replace(/^\[\d{1,4}\]\s*/, "").trim();
  if (!s) return "Reference";

  const yearMatch = s.match(/\((19|20)\d{2}\)/) || s.match(/,\s*(19|20)\d{2}\./);
  const year = yearMatch
    ? (yearMatch[0].match(/(19|20)\d{2}/)?.[0] ?? null)
    : null;

  const splitRe = /,\s*(?:Phys\.|Rev\.|J\.|Nature|Proc\.|Appl\.|Chem\.|Lett\.|Mag\.|Acta|Trans\.|arXiv|doi:|http)/i;
  let authors = s.split(splitRe)[0]?.trim() || s.split(",")[0]?.trim() || s;
  authors = authors.replace(/\s{2,}/g, " ").trim();
  if (authors.length > 52) authors = `${authors.slice(0, 51)}…`;

  return year ? `${authors} (${year})` : authors.slice(0, 58);
}

export function filterUsablePriorWork<T extends { citation_display?: string; title?: string }>(
  items: T[],
): T[] {
  return items.filter((w) => {
    const raw =
      (typeof w.citation_display === "string" && w.citation_display.trim()) ||
      (w.title || "").trim();
    if (!raw) return false;
    if (isGarbledBibliographyLine(raw)) return false;
    return sanitizeCitationForDisplay(raw).length >= 12;
  });
}
