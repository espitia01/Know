import type { PaperSummary } from "@/lib/api";

export function hasSummaryOverview(
  value: Partial<PaperSummary> | null | undefined,
): boolean {
  return typeof value?.overview === "string" && value.overview.trim().length > 0;
}

export function hasSummaryDeepBody(
  value: Partial<PaperSummary> | null | undefined,
): boolean {
  return (
    typeof value?.methodology === "string" && value.methodology.trim().length > 0
  );
}

/** True when methodology / results / discussion are present (not just lite preview). */
export function summaryIsComplete(
  value: Partial<PaperSummary> | null | undefined,
): boolean {
  return hasSummaryDeepBody(value);
}

export function mergeCachedSummary(
  legacy?: Partial<PaperSummary> | null,
  deep?: Partial<PaperSummary> | null,
  lite?: Partial<PaperSummary> | null,
  live?: Partial<PaperSummary> | null,
): Partial<PaperSummary> | null {
  if (!legacy && !deep && !lite && !live) return null;
  return {
    ...(legacy ?? {}),
    ...(deep ?? {}),
    ...(lite ?? {}),
    ...(live ?? {}),
  } as Partial<PaperSummary>;
}
