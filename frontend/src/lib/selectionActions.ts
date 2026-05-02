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

/** Max chars folded into fallback keys — avoids multi‑MB payloads in React keys/maps. */
const MAX_FALLBACK_ID = 4_096;

export function selectionKey(r: SelectionAnalysisResult): string {
  if (typeof r.clientKey === "string" && r.clientKey.length > 0) return r.clientKey;
  const norm = normalizeSelectionAction(r.action);
  const identityText =
    norm === "followup"
      ? `${r.question ?? ""}\n${r.selected_text ?? ""}`
      : (r.selected_text ?? "");
  // IMPORTANT: Never mix in explanation/elaboration/answer — those mutate on every streamed
  // SSE chunk without clientKey, which would churn React keys and re-run accordion effects on
  // every token (freezing the page when Selection tab mounts or a highlight opens the pane).
  return `${norm}::${identityText.trim().slice(0, MAX_FALLBACK_ID)}`;
}
