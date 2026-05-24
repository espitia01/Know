/**
 * Heuristics for deciding whether a text selection contains math.
 * Used to gate the "Derive" selection action — we only want to show
 * Derive when the user has highlighted an equation or math expression.
 */

const LATEX_HINT_RE = /\$|\\\(|\\\[|\\frac|\\sum|\\int|\\partial|\\nabla|\\alpha|\\beta|\\gamma|\\delta|\\epsilon|\\theta|\\lambda|\\mu|\\sigma|\\omega|\\pi|\\Delta|\\Sigma|\\Phi|\\Psi|\\cdot|\\times|\\approx|\\leq|\\geq|\\to|\\rightarrow|\\infty|\\sqrt/;
const MATH_UNICODE_RE = /[∑∫∂∇√≈≤≥≠≡≅∞∝⊕⊗⋅×·αβγδεζηθικλμνξπρστυφχψω∆ΦΨΩ]/;
const EQUATION_SHAPE_RE = /(?:[A-Za-z_]\s*=\s*[^=]+|\^\s*[\dA-Za-z]|[_^][{(]|\b\d+\s*[+\-*/]\s*[A-Za-z])/;

/**
 * PDF text extraction routinely renders equations as space-separated alphabet
 * soup ("K cv;c0v0 Z c1 v21234c0") — none of which trips the regexes above.
 * Detect that shape so Derive remains available for math the LLM extracted
 * from the page.
 */
function looksLikePdfGarbledMath(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 400) return false;

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length === 0 || tokens.length > 80) return false;

  let wordy = 0;
  let mathy = 0;
  for (const tok of tokens) {
    if (/^[A-Za-z]{3,}$/.test(tok) && /[aeiouAEIOU]/.test(tok)) {
      wordy += 1;
    } else if (tok.length <= 2 || /\d/.test(tok) || /[;:^_(){}<>=+\-*/\\|]/.test(tok)) {
      mathy += 1;
    }
  }
  const counted = wordy + mathy;
  if (counted === 0) return false;
  return mathy >= 3 && wordy / counted < 0.4;
}

export function hasMathInText(text: string): boolean {
  if (!text) return false;
  if (LATEX_HINT_RE.test(text)) return true;
  if (MATH_UNICODE_RE.test(text)) return true;
  if (EQUATION_SHAPE_RE.test(text)) return true;
  if (looksLikePdfGarbledMath(text)) return true;
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
