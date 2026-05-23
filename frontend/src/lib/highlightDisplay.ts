/**
 * PDF.js text layers often garble equations into token soup
 * (e.g. "X c0v0 HBSE cv;c0v0 AS c0v0 S AS cv"). Detect that
 * pattern and show a readable label in the Highlights panel.
 */

export type HighlightDisplay = {
  /** Primary line shown in the panel */
  label: string;
  /** Secondary hint (page number, extraction note) */
  detail: string | null;
  /** Whether the raw extracted text is worth showing on expand */
  showRaw: boolean;
  raw: string;
};

function tokenize(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/** Heuristic: PDF math / symbol fonts decoded as spaced fragments. */
export function isGarbledPdfHighlightText(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length < 4) return true;

  const tokens = tokenize(s);

  if (tokens.length >= 5) {
    const short = tokens.filter((t) => t.length <= 3).length;
    if (short / tokens.length > 0.5) return true;
  }

  if (/(?:\b[a-zA-Z]{1,2}\s+){6,}/.test(s)) return true;

  if (/\b[a-z]\d+[a-z]\d+\b/i.test(s) && tokens.length >= 3) return true;

  const longWords = tokens.filter((t) => t.length >= 4 && /[a-zA-Z]{3,}/.test(t));
  if (tokens.length >= 6 && longWords.length <= 1) return true;

  const punct = (s.match(/[;:,]/g) || []).length;
  if (punct >= 3 && tokens.length >= 4 && s.length < 220) return true;

  const alpha = (s.match(/[a-zA-Z]/g) || []).length;
  const digit = (s.match(/\d/g) || []).length;
  if (s.length >= 12 && alpha > 0 && digit / (alpha + digit) > 0.45 && longWords.length === 0) {
    return true;
  }

  return false;
}

function formatPageHint(pageNums: number[]): string | null {
  if (!pageNums.length) return null;
  const sorted = [...pageNums].sort((a, b) => a - b);
  if (sorted.length === 1) return `Page ${sorted[0]}`;
  if (sorted[0] === sorted[sorted.length - 1]) return `Page ${sorted[0]}`;
  return `Pages ${sorted[0]}–${sorted[sorted.length - 1]}`;
}

export function formatHighlightDisplay(
  raw: string,
  pageNums?: number[],
): HighlightDisplay {
  const trimmed = raw.trim();
  const pageHint = formatPageHint(pageNums ?? []);

  if (!isGarbledPdfHighlightText(trimmed)) {
    return {
      label: trimmed,
      detail: pageHint,
      showRaw: false,
      raw: trimmed,
    };
  }

  return {
    label: "Mathematical expression",
    detail:
      pageHint ??
      "Equations in PDFs often extract as garbled text — the highlight is still saved on the page.",
    showRaw: trimmed.length >= 4,
    raw: trimmed,
  };
}
