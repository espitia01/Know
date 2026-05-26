import type { PaperSummary, ParsedPaper } from "@/lib/api";

const PLACEHOLDER_RE =
  /^(n\/a|none|not applicable|no figures?|no tables?|not available)$/i;

/** Heuristic: does the paper body likely contain display math? */
export function paperLikelyHasEquations(paper: ParsedPaper | null | undefined): boolean {
  if (!paper) return false;
  const md = paper.markdown ?? "";
  const raw = paper.raw_text ?? "";
  const sample = `${md}\n${raw}`.slice(0, 120_000);
  if (/\$\$[\s\S]+?\$\$/.test(sample)) return true;
  if (/\\begin\{(equation|align|gather|multline|eqnarray)\}/.test(sample)) return true;
  // Require at least two inline-math spans — avoids false positives from "$5" or "p < 0.05".
  const inlineMath = sample.match(/(?<!\$)\$(?!\$)[^$\n]{1,200}\$(?!\$)/g);
  return (inlineMath?.length ?? 0) >= 2;
}

/** Figures/tables extracted or referenced in the paper artifact. */
export function paperHasFiguresOrTables(paper: ParsedPaper | null | undefined): boolean {
  if (!paper) return false;
  if ((paper.figures?.length ?? 0) > 0) return true;
  const cachedTables = paper.cached_analysis?.table_analyses?.length ?? 0;
  if (cachedTables > 0) return true;
  const sample = `${paper.markdown ?? ""}\n${paper.raw_text ?? ""}`.slice(0, 120_000);
  return /\b(Fig\.|Figure|Table)\s+\d/i.test(sample);
}

function isPlaceholderFigureEntry(
  fig: { id?: string | null; description?: string | null } | null | undefined,
): boolean {
  if (!fig) return true;
  const id = (fig.id ?? "").trim();
  const desc = (fig.description ?? "").trim();
  if (!id && !desc) return true;
  if (id && PLACEHOLDER_RE.test(id)) return true;
  if (!id && desc && PLACEHOLDER_RE.test(desc)) return true;
  return false;
}

export function summaryKeyEquations(
  summary: Partial<PaperSummary> | null | undefined,
): NonNullable<PaperSummary["key_equations"]> {
  const items = summary?.key_equations;
  if (!Array.isArray(items)) return [];
  return items.filter((eq) => {
    if (!eq) return false;
    const tex = (eq.equation ?? "").trim();
    const meaning = (eq.meaning ?? "").trim();
    if (!tex && !meaning) return false;
    if (PLACEHOLDER_RE.test(tex) || PLACEHOLDER_RE.test(meaning)) return false;
    return true;
  });
}

export function summaryKeyFiguresAndTables(
  summary: Partial<PaperSummary> | null | undefined,
): NonNullable<PaperSummary["key_figures_and_tables"]> {
  const items = summary?.key_figures_and_tables;
  if (!Array.isArray(items)) return [];
  return items.filter((fig) => !isPlaceholderFigureEntry(fig));
}
