/**
 * Rough heuristic for whether a PDF text selection is likely math.
 * PDF extraction is lossy — match LaTeX fragments, math Unicode,
 * sub/sup markers, matrix-shaped multi-line text, bracketed tuples,
 * and operator+digit/Greek combinations.
 *
 * False positives are cheap (Derive still asks the model and degrades
 * gracefully on prose). False negatives are expensive (the user has
 * no way to ask for a step-by-step).
 */
export function selectionLooksLikeEquationSnippet(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 2) return false;

  if (/\\[a-zA-Z]+/.test(t)) return true;
  if (/\\begin\{(?:p|b|v|V|small)?matrix\}/i.test(t)) return true;

  if (/\^(\d|\{|\(|\[)/.test(t) || /_(\d|\{|\(|\[)/.test(t)) return true;

  if (
    /[∑∫√∂∇∞±×·÷≤≥≠≈≡≅∝∼∈∉⊂⊆⊃⊇⊕⊗⊙∧∨∀∃⇒⇔→↦⟨⟩‖⊢⊨⊥∥∠⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]/.test(
      t,
    )
  )
    return true;

  const greekCount = (t.match(/[\u0370-\u03FF]/g) || []).length;
  if (greekCount >= 1 && t.length < 40) return true;
  if (greekCount >= 2) return true;

  const hasOp = /[+\-*/=^_<>]/.test(t);
  const hasDigit = /\d/.test(t);
  if (hasOp && hasDigit) return true;

  if (/\(.*\)/.test(t) && (/[+\-*/=]/.test(t) || /\([a-zA-Z][\s,;]/.test(t)))
    return true;

  if (
    /[\[\{|]\s*[A-Za-z\u0370-\u03FF\d]+(?:[,;\s]+[A-Za-z\u0370-\u03FF\d]+){1,}\s*[\]\}|]/.test(
      t,
    )
  )
    return true;
  if (/[\[\{|][^\]\}\n|]{0,40}(?:;|\\\\)\s*[^\]\}\n|]{0,40}[\]\}|]/.test(t))
    return true;

  const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2 && lines.length <= 8) {
    const matrixy = lines.every((l) => {
      if (l.length > 40) return false;
      const tokens = l.split(/[\s,;]+/).filter(Boolean);
      if (tokens.length < 2 || tokens.length > 8) return false;
      return tokens.every((tok) => /^[\-+]?[A-Za-z\u0370-\u03FF\d_.]{1,6}$/.test(tok));
    });
    if (matrixy) return true;
  }

  if (/\b(?:d|D|∂)\s*[a-zA-Z]\s*\/\s*(?:d|D|∂)\s*[a-zA-Z]\b/.test(t)) return true;

  return false;
}
