import type { PreReadingAnalysis } from "@/lib/api";

/** True when server / store has a Prepare payload with at least one populated list. */
export function isPreReadingPopulated(pr: unknown): pr is PreReadingAnalysis {
  if (!pr || typeof pr !== "object") return false;
  const p = pr as Partial<PreReadingAnalysis>;
  const n = (xs: unknown): number => (Array.isArray(xs) ? xs.length : 0);
  return (
    n(p.definitions) > 0 ||
    n(p.research_questions) > 0 ||
    n(p.concepts) > 0
  );
}
