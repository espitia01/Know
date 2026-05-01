import type { SelectionAnalysisResult } from "@/lib/api";

export type SelectionActionType =
  | "explain"
  | "derive"
  | "assumptions"
  | "followup"
  | "note";

export const ACTION_LABELS: Record<SelectionActionType, string> = {
  explain: "Explanation",
  derive: "Derivation",
  assumptions: "Assumptions",
  followup: "Follow-up",
  note: "Note",
};

export function normalizeSelectionAction(action: string | undefined): SelectionActionType {
  const raw = typeof action === "string" ? action.trim().toLowerCase() : "";
  if (raw === "derive") return "derive";
  if (raw === "assumptions") return "assumptions";
  if (raw === "followup" || raw === "question") return "followup";
  if (raw === "note") return "note";
  return "explain";
}

export function selectionKey(r: SelectionAnalysisResult): string {
  if (r.clientKey) return r.clientKey;
  const head = (r.explanation || r.elaboration || r.answer || "").slice(0, 64);
  const norm = normalizeSelectionAction(r.action);
  const identityText =
    norm === "followup"
      ? (r.question || r.selected_text || "")
      : (r.selected_text || "");
  return `${norm}::${identityText.trim()}::${head}`;
}
