import type { PromptDepth } from "@/lib/server/promptDepth";
import { depthSuffix } from "@/lib/server/promptDepth";
import { buildPaperExcerpt } from "@/lib/server/paperExcerpt";
import { contextBudget } from "@/lib/server/promptBudgets";

const SHARED = `Output rules:
- Markdown for all fields.
- Math: $...$ inline, $$...$$ display. No bare LaTeX outside delimiters.
- Ground answers in the table markdown and paper context; cite specific rows/columns when possible.`;

export function buildTablePrompt(args: {
  paperContext: string;
  tableMarkdown: string;
  tableLabel?: string;
  question?: string;
  depth?: PromptDepth;
  deepAnalysis?: boolean;
  retrievedContext?: string;
}): { system: string; userText: string } {
  const depthBlock = depthSuffix(args.depth);
  const maxChars = contextBudget("qa", args.deepAnalysis ?? false);
  const paperContext =
    args.retrievedContext?.trim() ||
    buildPaperExcerpt(args.paperContext || "", { maxChars, profile: "summary" });
  const label = (args.tableLabel || "Table").trim();
  const q = (args.question || "").trim();
  const system = [
    "You are an expert science educator helping a reader understand a table from an academic paper.",
    SHARED,
    'Fill "answer" with a thorough markdown response. Include "summary" when a short overview helps.',
    depthBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  const userText = [
    `Paper context:\n"""\n${paperContext}\n"""`,
    `\n${label} (markdown):\n"""\n${args.tableMarkdown}\n"""`,
    q ? `\nUser question: ${q}` : "\nAnalyze this table: what it shows, key comparisons, and how it supports the paper's claims.",
  ].join("");

  return { system, userText };
}
