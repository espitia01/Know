/** Strip a trailing partial $...$ / $$...$$ span so KaTeX never sees dangling delimiters. */
function stripPartialMathTail(s: string): string {
  const lastDollar = s.lastIndexOf("$");
  if (lastDollar < 0) return s;
  const tail = s.slice(lastDollar);
  const isDisplay = tail.startsWith("$$");
  const close = isDisplay ? "$$" : "$";
  if (!tail.includes(close, isDisplay ? 2 : 1)) {
    return s.slice(0, lastDollar).trimEnd();
  }
  return s;
}

/** Extend `cut` to the end of an open inline/display math span. */
function extendThroughMathClose(s: string, cut: number): string {
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "$") {
      i += 1;
      continue;
    }
    const display = s[i + 1] === "$";
    const openLen = display ? 2 : 1;
    const close = display ? "$$" : "$";
    const start = i;
    const closeIdx = s.indexOf(close, i + openLen);
    if (closeIdx < 0) {
      if (cut > start && cut < s.length) {
        return s;
      }
      break;
    }
    const end = closeIdx + close.length;
    if (cut > start && cut < end) {
      return s.slice(0, end);
    }
    i = end;
  }
  return s.slice(0, cut);
}

function truncateWithMathAwareness(first: string, maxLen: number): string {
  if (first.length <= maxLen) return first;
  let cut = first.slice(0, maxLen);
  cut = extendThroughMathClose(first, maxLen);
  if (cut.length > maxLen + 80) {
    cut = stripPartialMathTail(first.slice(0, maxLen));
  }
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim();
}

/** First-sentence takeaway extractor. Sentence-aware, no mid-word cuts; math-safe. */
export function firstSentence(input: string | null | undefined, maxLen = 240): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const m = s.match(/[^.?!]+[.?!](?=\s+[A-Z(]|\s*$)/);
  const first = (m ? m[0] : s).trim();
  if (first.length <= maxLen) return first;
  return truncateWithMathAwareness(first, maxLen);
}

/** Wrap bare LaTeX in $$...$$ for Streamdown/KaTeX (summary key_equations). */
export function ensureDisplayMath(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^\${1,2}[\s\S]+\${1,2}$/.test(s) || s.startsWith("$$")) return s;
  const cleaned = s.replace(/^\s*(?:\(\s*\d+\s*\)|\d+\.|Eq\.?\s*\d+:?)\s*/i, "").trim();
  return `$$${cleaned}$$`;
}
