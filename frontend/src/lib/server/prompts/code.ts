import type { PromptDepth } from "@/lib/server/promptDepth";
import { depthSuffix } from "@/lib/server/promptDepth";
import { buildPaperExcerpt } from "@/lib/server/paperExcerpt";
import { contextBudget } from "@/lib/server/promptBudgets";

const SHARED = `Output rules:
- "algorithm_explanation": markdown walkthrough of the algorithm/procedure.
- "implementation": a single fenced code block (\`\`\`language ... \`\`\`) — runnable when feasible, else precise pseudocode.
- If the paper is too vague or domain-specific for faithful code, leave implementation as a sketch inside the fence and put caveats in "sketch_note".
- Math in prose: $...$ / $$...$$ only.`;

export function buildCodePrompt(args: {
  paperContext: string;
  code: string;
  language?: string;
  contextLine?: string;
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
  const lang = (args.language || "text").trim() || "text";
  const q = (args.question || "").trim();
  const system = [
    "You are an expert science educator explaining code or pseudocode from an academic paper.",
    SHARED,
    depthBlock,
  ]
    .filter(Boolean)
    .join("\n\n");

  const userText = [
    `Paper context:\n"""\n${paperContext}\n"""`,
    args.contextLine ? `\nContext: ${args.contextLine}` : "",
    `\nExcerpt (${lang}):\n\`\`\`${lang}\n${args.code}\n\`\`\``,
    q
      ? `\nUser question: ${q}`
      : "\nExplain the algorithm, then provide the best implementation or pseudocode sketch you can.",
  ].join("");

  return { system, userText };
}
