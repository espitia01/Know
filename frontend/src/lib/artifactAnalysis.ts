import type { CodeAnalysis, TableAnalysis } from "@/lib/api";

export function formatTableAnalysisText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as TableAnalysis;
    const answer = (parsed.answer || "").trim();
    const summary = (parsed.summary || "").trim();
    if (answer && summary && !answer.includes(summary)) {
      return `${answer}\n\n${summary}`;
    }
    return answer || summary || raw;
  } catch {
    return raw;
  }
}

export function formatCodeAnalysisText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as CodeAnalysis;
    const parts: string[] = [];
    const expl = (parsed.algorithm_explanation || "").trim();
    const impl = (parsed.implementation || "").trim();
    const note = (parsed.sketch_note || "").trim();
    if (expl) parts.push(`## Algorithm\n\n${expl}`);
    if (impl) parts.push(`## Implementation\n\n${impl}`);
    if (note) parts.push(`## Note\n\n${note}`);
    return parts.join("\n\n") || raw;
  } catch {
    return raw;
  }
}
