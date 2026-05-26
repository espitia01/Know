import { repairJsonEscapedLatex } from "@/lib/streamdownMath";

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

/**
 * Mask out `$...$` / `$$...$$` spans with placeholder characters so the
 * sentence-detection regex doesn't trip on periods inside math (e.g.
 * `$0.5\,\mathrm{eV}$`). The mask preserves indices so we can re-extract
 * the original text by offset.
 */
function maskMathSpans(s: string): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "$") {
      const display = s[i + 1] === "$";
      const open = display ? 2 : 1;
      const close = display ? "$$" : "$";
      const end = s.indexOf(close, i + open);
      if (end < 0) {
        // Unclosed math span — bail and keep the rest as-is.
        out += s.slice(i);
        break;
      }
      const span = s.slice(i, end + close.length);
      out += span.replace(/[.?!]/g, "·");
      i = end + close.length;
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/** First-sentence takeaway extractor. Sentence-aware, no mid-word cuts; math-safe. */
export function firstSentence(input: string | null | undefined, maxLen = 240): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const masked = maskMathSpans(s);
  const m = masked.match(/[^.?!]+[.?!](?=\s+[A-Z(]|\s*$)/);
  // Use the matched length on the masked string to slice the original.
  const sliceLen = m ? m[0].length : s.length;
  const first = s.slice(0, sliceLen).trim();
  if (first.length <= maxLen) return first;
  return truncateWithMathAwareness(first, maxLen);
}

/** Wrap bare LaTeX in $$...$$ for Streamdown/KaTeX (summary key_equations). */
export function ensureDisplayMath(raw: string | undefined): string {
  let s = repairJsonEscapedLatex((raw ?? "").trim());
  if (!s) return "";
  if (/^\${1,2}[\s\S]+\${1,2}$/.test(s) || s.startsWith("$$")) return s;
  const cleaned = s.replace(/^\s*(?:\(\s*\d+\s*\)|\d+\.|Eq\.?\s*\d+:?)\s*/i, "").trim();
  return `$$${cleaned}$$`;
}
