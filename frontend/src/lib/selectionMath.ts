/**
 * Heuristics for deciding whether a text selection contains math.
 * Used to gate the "Derive" selection action — we only want to show
 * Derive when the user has highlighted an equation or math expression.
 */

const LATEX_HINT_RE = /\$|\\\(|\\\[|\\frac|\\sum|\\int|\\partial|\\nabla|\\alpha|\\beta|\\gamma|\\delta|\\epsilon|\\theta|\\lambda|\\mu|\\sigma|\\omega|\\pi|\\Delta|\\Sigma|\\Phi|\\Psi|\\cdot|\\times|\\approx|\\leq|\\geq|\\to|\\rightarrow|\\infty|\\sqrt/;
const MATH_UNICODE_RE = /[∑∫∂∇√≈≤≥≠≡≅∞∝⊕⊗⋅×·αβγδεζηθικλμνξπρστυφχψω∆ΦΨΩ]/;
const EQUATION_SHAPE_RE = /(?:[A-Za-z_]\s*=\s*[^=]+|\^\s*[\dA-Za-z]|[_^][{(]|\b\d+\s*[+\-*/]\s*[A-Za-z])/;

export function hasMathInText(text: string): boolean {
  if (!text) return false;
  if (LATEX_HINT_RE.test(text)) return true;
  if (MATH_UNICODE_RE.test(text)) return true;
  if (EQUATION_SHAPE_RE.test(text)) return true;
  return false;
}

/** Inspect the DOM range (markdown reader only) for rendered KaTeX. */
export function rangeContainsKatex(range: Range | null | undefined): boolean {
  if (!range || typeof document === "undefined") return false;
  const root = range.commonAncestorContainer;
  const el = root.nodeType === 1 ? (root as Element) : root.parentElement;
  if (el?.closest?.(".katex, .katex-display")) return true;
  try {
    const frag = range.cloneContents();
    if (frag.querySelector && frag.querySelector(".katex, .katex-display")) return true;
  } catch {
    /* cross-realm or detached — fall back to text heuristic */
  }
  return false;
}

export function selectionHasMath(text: string, range?: Range | null): boolean {
  if (rangeContainsKatex(range)) return true;
  return hasMathInText(text);
}
