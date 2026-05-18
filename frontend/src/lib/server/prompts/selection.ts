/**
 * Prompts for the migrated selection-stream route.
 *
 * Replaces the ~60-line LATEX_FORMAT_INSTRUCTIONS blob the Python
 * service used to send. With Streamdown + KaTeX rendering on the
 * client we only need three short rules:
 *
 *   1. Math goes inside $...$ (inline) or $$...$$ (display).
 *   2. Never bare LaTeX commands or Unicode math symbols outside of
 *      math delimiters.
 *   3. Selected PDF text may be mangled (one-glyph-per-line, missing
 *      spaces, broken sub/superscripts) — reconstruct it using the
 *      paper context, don't echo the artifacts.
 *
 * Output goes through `streamObject` so prompts ask for *fields*, not
 * raw markdown — the schema is the contract.
 */

const SHARED_RULES = `Output rules (strict):
- Math: use $...$ for inline math, $$...$$ for display math. Place display math on its own line. NEVER bare LaTeX commands, Unicode math symbols, or HTML outside of math delimiters.
- Prose: clean English with normal spacing. Never preserve "one-glyph-per-line" salad or run-on sentences from the PDF; reconstruct using context.
- Honesty: if the passage is not mathematical, write prose. Do not invent equations.`;

const SHARED_TASK_NOTE = `The selected text comes from a PDF text layer and may be garbled (split lines, missing spaces, wrong Unicode). Use the paper context to infer correct spelling, equations, and symbol names.`;

export type SelectionAction = "explain" | "derive" | "followup";

import type { PromptDepth } from "@/lib/server/promptDepth";
import { depthSuffix } from "@/lib/server/promptDepth";

export type SelectionPromptInput = {
  action: SelectionAction;
  selectedText: string;
  paperTitle: string;
  paperContext: string;
  /** Free-form follow-up question. Only used when action = "followup". */
  question?: string;
  depth?: PromptDepth;
};

const PAPER_CONTEXT_CHAR_BUDGET = 6000;
const SELECTION_CHAR_BUDGET = 4000;

function trim(text: string, max: number): string {
  if (!text) return "";
  if (text.length <= max) return text;
  return text.slice(0, max);
}

export function buildSelectionPrompt(input: SelectionPromptInput): {
  system: string;
  prompt: string;
} {
  const depthLine = depthSuffix(input.depth);
  const depthBlock = depthLine ? `\n\n${depthLine}` : "";
  const action = input.action;
  const selectedText = trim(input.selectedText, SELECTION_CHAR_BUDGET);
  const paperContext = trim(input.paperContext, PAPER_CONTEXT_CHAR_BUDGET);
  const paperTitleLine = input.paperTitle ? `Paper: ${input.paperTitle}\n\n` : "";

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
      prompt: [
        paperTitleLine + `Selected passage:\n"""\n${selectedText}\n"""`,
        `Paper context (truncated):\n"""\n${paperContext}\n"""`,
      ].join("\n\n"),
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
      prompt: [
        paperTitleLine + `Selected passage:\n"""\n${selectedText}\n"""`,
        `Paper context (truncated):\n"""\n${paperContext}\n"""`,
      ].join("\n\n"),
    };
  }

  // followup — `selectedText` is the user's earlier passage + analysis
  // pasted together by the client; `question` is the new prompt.
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
    prompt: [
      paperTitleLine + `Earlier passage and what was already said about it:\n"""\n${selectedText}\n"""`,
      `Follow-up question:\n"""\n${question}\n"""`,
      `Paper context (truncated):\n"""\n${paperContext}\n"""`,
    ].join("\n\n"),
  };
}
