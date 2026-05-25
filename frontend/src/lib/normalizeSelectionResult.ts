import type { SelectionAnalysisResult } from "@/lib/api";

/** Coerce LLM / cache payloads to plain strings (Mistral sometimes nests markdown). */
export function coerceMarkdownField(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((v) => coerceMarkdownField(v)).filter(Boolean).join("\n\n");
  }
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    for (const key of ["text", "content", "markdown", "body", "explanation", "answer"]) {
      if (key in o) return coerceMarkdownField(o[key]);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function normalizeSelectionResult(
  raw: SelectionAnalysisResult,
  fallback?: Partial<SelectionAnalysisResult>,
): SelectionAnalysisResult {
  const assumptions = Array.isArray(raw.assumptions)
    ? raw.assumptions.map((a) => ({
        statement: coerceMarkdownField(a?.statement),
        type: coerceMarkdownField(a?.type) || "implicit",
        significance: coerceMarkdownField(a?.significance),
      }))
    : undefined;

  const steps = Array.isArray(raw.steps)
    ? raw.steps.map((s) => ({
        step_number: typeof s?.step_number === "number" ? s.step_number : 0,
        prompt: coerceMarkdownField(s?.prompt),
        answer: coerceMarkdownField(s?.answer),
        expression: coerceMarkdownField(s?.expression ?? s?.answer),
        explanation: coerceMarkdownField(s?.explanation),
        hint: coerceMarkdownField(s?.hint),
      }))
    : undefined;

  return {
    ...fallback,
    ...raw,
    action: coerceMarkdownField(raw.action) || fallback?.action || "explain",
    selected_text: coerceMarkdownField(raw.selected_text) || fallback?.selected_text || "",
    question: raw.question != null ? coerceMarkdownField(raw.question) : fallback?.question,
    explanation: coerceMarkdownField(
      raw.explanation ?? raw.elaboration ?? raw.answer,
    ),
    elaboration: raw.elaboration != null ? coerceMarkdownField(raw.elaboration) : undefined,
    answer: raw.answer != null ? coerceMarkdownField(raw.answer) : undefined,
    title: raw.title != null ? coerceMarkdownField(raw.title) : undefined,
    starting_point:
      raw.starting_point != null ? coerceMarkdownField(raw.starting_point) : undefined,
    final_result: raw.final_result != null ? coerceMarkdownField(raw.final_result) : undefined,
    assumptions,
    steps,
    model: raw.model != null ? coerceMarkdownField(raw.model) : fallback?.model,
    regions: raw.regions ?? fallback?.regions,
    streaming: raw.streaming ?? false,
    clientKey: raw.clientKey ?? fallback?.clientKey,
    created_at: raw.created_at ?? fallback?.created_at,
  };
}
