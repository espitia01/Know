/**
 * Prompt for the migrated summary-stream route.
 */

const SHARED_RULES = `Output rules (strict):
- Use markdown for all narrative fields.
- Math: inline math goes in $...$, display math in $$...$$ on its own line. NEVER bare LaTeX commands or Unicode math symbols outside math delimiters.
- Don't preserve PDF artifacts like one-glyph-per-line or run-on words; reconstruct using paper context.`;

import type { PromptDepth } from "@/lib/server/promptDepth";
import { depthSuffix } from "@/lib/server/promptDepth";

const PAPER_CHAR_BUDGET = 8000;

export function buildSummaryPrompt(args: {
  paperTitle: string;
  paperContext: string;
  depth?: PromptDepth;
}): { system: string; paperContextText: string; taskText: string } {
  const depthLine = depthSuffix(args.depth);
  const depthBlock = depthLine ? `\n\n${depthLine}` : "";
  const paperContext = (args.paperContext || "").slice(0, PAPER_CHAR_BUDGET);
  const titleLine = args.paperTitle ? `Paper title: ${args.paperTitle}\n\n` : "";

  const system = [
    `You are an expert science editor producing an extremely detailed structured summary of an academic paper.`,
    SHARED_RULES,
    `Fill the structured response. Each field is independent — write each as if the reader will see it in isolation. Skip empty rhetorical filler.`,
    `- "overview": 3–5 sentence high-level overview of what the paper does and why it matters.`,
    `- "motivation": 3–5 sentences on why this work was done and what gap it fills.`,
    `- "key_contributions": array of 1–2 sentence strings, one per contribution.`,
    `- "methodology": multi-paragraph markdown explanation of the methods, models, or theoretical framework. Embed equations where they aid understanding.`,
    `- "main_results": multi-paragraph markdown describing the key findings, including quantitative numbers in math delimiters.`,
    `- "discussion": multi-paragraph markdown — what the results mean, how they compare to prior work, what they imply.`,
    `- "limitations": array of short markdown strings with caveats the authors mention OR that are evident.`,
    `- "future_work": 2–3 sentences on what follow-up research this enables or suggests.`,
    `- "key_equations": array of {"equation": LaTeX wrapped in $$...$$ on its own line (display math, no surrounding prose), "meaning": one-paragraph markdown}. Pick the 3–6 most important equations of the paper. NEVER emit bare LaTeX — always wrap the equation field in $$...$$.`,
    `- "key_figures_and_tables": array of {"id": author label (e.g. "Fig. 1"), "description": one-paragraph markdown}. Pick the most informative figures/tables.`,
    depthBlock,
  ].join("\n\n");

  const paperContextText =
    titleLine + `Paper content (truncated):\n"""\n${paperContext}\n"""`;
  const taskText =
    `Return the structured object. Always include a non-empty "overview". Leave arrays empty when a section does not apply.`;

  return { system, paperContextText, taskText };
}
