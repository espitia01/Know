/**
 * Prompts for the migrated figure-qa-stream route.
 */

const SHARED_RULES = `Output rules (strict):
- Markdown for all narrative fields.
- Math: inline math in $...$, display math in $$...$$ on its own line. NEVER bare LaTeX commands or Unicode math symbols outside math delimiters.`;

import type { PromptDepth } from "@/lib/server/promptDepth";
import { depthSuffix } from "@/lib/server/promptDepth";
import { buildPaperExcerpt } from "@/lib/server/paperExcerpt";
import { contextBudget } from "@/lib/server/promptBudgets";

export function buildFigurePrompt(args: {
  paperContext: string;
  question?: string;
  depth?: PromptDepth;
  deepAnalysis?: boolean;
  /** When set (RAG), use retrieved passages instead of excerpting raw text. */
  retrievedContext?: string;
}): { system: string; paperContextText: string; taskText: string } {
  const depthLine = depthSuffix(args.depth);
  const depthBlock = depthLine ? `\n\n${depthLine}` : "";
  const maxChars = contextBudget("figure", args.deepAnalysis ?? false);
  const paperContext =
    args.retrievedContext?.trim() ||
    buildPaperExcerpt(args.paperContext || "", {
      maxChars,
      profile: "summary",
    });
  const q = (args.question || "").trim();
  const paperContextText = `Paper context (for reference):\n"""\n${paperContext}\n"""`;

  if (q) {
    return {
      system: [
        `You are an expert science educator analyzing a figure from an academic paper to answer a reader's question.`,
        SHARED_RULES,
        `Fill the structured response:`,
        `- "answer": thorough markdown answer to the user's question, referencing specific elements of the figure.`,
        `- "description": one-paragraph markdown describing what the figure shows.`,
        `- "key_observations": 2–4 short markdown strings noting the most important observations.`,
        `- "relation_to_paper": one paragraph on how this figure supports the paper's argument.`,
        `- "methodology_shown" / "takeaway": optional; include if a method or single-sentence takeaway is appropriate.`,
        depthBlock,
      ].join("\n\n"),
      paperContextText,
      taskText: `User question: ${q}`,
    };
  }

  return {
    system: [
      `You are an expert science educator analyzing a figure from an academic paper for a careful reader.`,
      SHARED_RULES,
      `Fill the structured response:`,
      `- "description": detailed markdown describing what the figure shows, what the axes/labels mean.`,
      `- "key_observations": 2–4 short markdown strings noting the most important observations.`,
      `- "methodology_shown": short markdown noting which method this figure illustrates, when applicable.`,
      `- "relation_to_paper": one paragraph on how this figure supports the paper's arguments.`,
      `- "takeaway": one-sentence markdown takeaway.`,
      `- Leave "answer" empty — there is no question.`,
      depthBlock,
    ].join("\n\n"),
    paperContextText,
    taskText: "Analyze the attached figure using the paper context above.",
  };
}
