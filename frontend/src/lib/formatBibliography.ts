/**
 * Normalize bibliography excerpts for on-screen listing (collapse PDF line wraps,
 * drop duplicate numbering when our UI already shows index chips).
 */

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
