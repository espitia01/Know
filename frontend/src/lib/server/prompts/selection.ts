/**
 * Prompts for the migrated selection-stream route.
 */

const SHARED_RULES = `Output rules (strict):
- Math: use $...$ for inline math, $$...$$ for display math. Place display math on its own line. NEVER bare LaTeX commands, Unicode math symbols, or HTML outside of math delimiters.
- Prose: clean English with normal spacing. Never preserve "one-glyph-per-line" salad or run-on sentences from the PDF; reconstruct using context.
- Honesty: if the passage is not mathematical, write prose. Do not invent equations.`;

const SHARED_TASK_NOTE = `The selected text comes from a PDF text layer and may be garbled (split lines, missing spaces, wrong Unicode). Use the paper context to infer correct spelling, equations, and symbol names.`;

export type SelectionAction = "explain" | "derive" | "followup";

import type { PromptDepth } from "@/lib/server/promptDepth";
import { depthSuffix } from "@/lib/server/promptDepth";
import { buildPaperExcerpt } from "@/lib/server/paperExcerpt";
import { contextBudget, selectionTextBudget } from "@/lib/server/promptBudgets";

export type SelectionPromptInput = {
  action: SelectionAction;
  selectedText: string;
  paperTitle: string;
  paperContext: string;
  question?: string;
  depth?: PromptDepth;
  deepAnalysis?: boolean;
};

function trim(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max);
}

export function buildSelectionPrompt(input: SelectionPromptInput): {
  system: string;
  paperContextText: string;
  taskText: string;
} {
  const depthLine = depthSuffix(input.depth);
  const depthBlock = depthLine ? `\n\n${depthLine}` : "";
  const action = input.action;
  const selBudget = selectionTextBudget(input.deepAnalysis ?? false);
  const ctxBudget = contextBudget("selection", input.deepAnalysis ?? false);
  const selectedText = trim(input.selectedText, selBudget);
  const paperContext = buildPaperExcerpt(input.paperContext || "", {
    maxChars: ctxBudget,
    profile: "selection",
  });
  const paperTitleLine = input.paperTitle ? `Paper: ${input.paperTitle}\n\n` : "";
  const paperContextText =
    paperTitleLine + `Paper context (section-aware excerpt):\n"""\n${paperContext}\n"""`;

  if (action === "explain") {
    return {
      system: [
        `You are an expert science educator helping a careful reader interpret an academic paper.`,
        SHARED_RULES,
        SHARED_TASK_NOTE,
        `Fill the structured response:`,
        `- "action" = "explain"`,
        `- "body": a thorough markdown explanation. If the selection ends like a question, ANSWER it directly using the paper as context. If it is a statement, EXPLAIN it: break down jargon, clarify the logic, give context and implications. Use math delimiters where helpful.`,
        `- "assumptions": ONLY premises THIS excerpt explicitly states or unmistakably depends on. Stay narrow — do not survey assumptions of unrelated sections. Empty array is the right answer when nothing fits. Each entry has a "type" ("explicit"|"implicit"), a "statement", and an optional "significance" describing what shifts if relaxed.`,
        `- "steps", "starting_point", "final_result": leave empty.`,
        depthBlock,
      ].join("\n\n"),
      paperContextText,
      taskText: `Selected passage:\n"""\n${selectedText}\n"""`,
    };
  }

  if (action === "derive") {
    return {
      system: [
        `You are an expert science educator reconstructing a derivation step-by-step.`,
        SHARED_RULES,
        SHARED_TASK_NOTE,
        `Decision: if the passage contains an equation or quantitative result, derive it mathematically (each step has a LaTeX answer). If the paper is non-mathematical (humanities, philosophy, history, qualitative social science, etc.), derive the ARGUMENT instead: each step is a premise or inference in plain English. Do NOT fabricate equations.`,
        `Fill the structured response:`,
        `- "action" = "derive"`,
        `- "body": one short markdown paragraph framing what you are deriving and why.`,
        `- "starting_point": the initial expression OR initial premise (markdown).`,
        `- "final_result": the target expression OR conclusion (markdown).`,
        `- "steps": 6–12 atomic steps. Each step has step_number (1-indexed), prompt (instruction), answer (resulting expression or stated inference, markdown with math delimiters), explanation (why this step follows; 1–3 sentences), and an optional hint.`,
        `- "assumptions": empty array.`,
        depthBlock,
      ].join("\n\n"),
      paperContextText,
      taskText: `Selected passage:\n"""\n${selectedText}\n"""`,
    };
  }

  const question = trim(input.question || "", 2000);
  return {
    system: [
      `You are continuing a conversation about an academic paper passage. The user is asking a follow-up question about an earlier exchange.`,
      SHARED_RULES,
      SHARED_TASK_NOTE,
      `Fill the structured response:`,
      `- "action" = "followup"`,
      `- "body": a clear, concrete answer to the follow-up. Cite the passage where useful. Use math delimiters when the answer involves math.`,
      `- "assumptions", "steps", "starting_point", "final_result": leave empty/[].`,
      depthBlock,
    ].join("\n\n"),
    paperContextText,
    taskText: [
      `Earlier passage and what was already said about it:\n"""\n${selectedText}\n"""`,
      `Follow-up question:\n"""\n${question}\n"""`,
    ].join("\n\n"),
  };
}
