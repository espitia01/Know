/** First-sentence takeaway extractor. Sentence-aware, no mid-word cuts. */
export function firstSentence(input: string | null | undefined, maxLen = 240): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const m = s.match(/[^.?!]+[.?!](?=\s+[A-Z(]|\s*$)/);
  const first = (m ? m[0] : s).trim();
  if (first.length <= maxLen) return first;
  const cut = first.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Wrap bare LaTeX in $$...$$ for Streamdown/KaTeX (summary key_equations). */
export function ensureDisplayMath(raw: string | undefined): string {
  const s = (raw ?? "").trim();
  if (!s) return "";
  if (/^\${1,2}[\s\S]+\${1,2}$/.test(s) || s.startsWith("$$")) return s;
  const cleaned = s.replace(/^\s*(?:\(\s*\d+\s*\)|\d+\.|Eq\.?\s*\d+:?)\s*/i, "").trim();
  return `$$${cleaned}$$`;
}
