import type { SelectionAnalysisResult } from "@/lib/api";

export type SelectionActionType =
  | "explain"
  | "derive"
  | "assumptions"
  | "followup";

export const ACTION_LABELS: Record<SelectionActionType, string> = {
  explain: "Explanation",
  derive: "Derivation",
  assumptions: "Assumptions",
  followup: "Follow-up",
};

export function normalizeSelectionAction(action: string | undefined): SelectionActionType {
  // Legacy `question` entries were persisted before Ask was folded into
  // Explain. Normalize at the boundary so labels, colors, and identity keys
  // all agree without mutating the stored cache entry.
  if (action === "derive" || action === "assumptions" || action === "followup") {
    return action;
  }
  return "explain";
}

export function selectionKey(r: SelectionAnalysisResult): string {
  const head = (r.explanation || r.elaboration || r.answer || "").slice(0, 64);
  const identityText =
    normalizeSelectionAction(r.action) === "followup"
      ? (r.question || r.selected_text || "")
      : (r.selected_text || "");
  return `${normalizeSelectionAction(r.action)}::${identityText.trim()}::${head}`;
}
