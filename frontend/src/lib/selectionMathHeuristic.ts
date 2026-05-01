/**
 * Rough heuristic for whether a PDF text selection is likely part of an
 * equation. PDF extraction is lossy — we match fragments of LaTeX, typical
 * math Unicode, sub/sup markers, and simple formula-shaped ASCII.
 */
export function selectionLooksLikeEquationSnippet(raw: string): boolean {
  const t = raw.replace(/\s+/g, " ").trim();
  if (t.length < 2) return false;

  if (/\\[a-zA-Z]+/.test(t)) return true;

  if (/\^(\d|\{|\(|\[)/.test(t) || /_(\d|\{|\(|\[)/.test(t)) return true;

  if (/[∑∫√∂∇∞±×·÷≤≥≠≈≡∼∈∧∨∀∃⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/.test(t)) return true;

  const hasOp = /[+\-*/=^_]/.test(t);
  const hasDigit = /\d/.test(t);
  if (hasOp && hasDigit) return true;

  if (/\(.*\)/.test(t) && /[+\-*/=]/.test(t)) return true;

  return false;
}
