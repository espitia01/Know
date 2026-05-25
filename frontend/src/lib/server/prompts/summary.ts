/**
 * Two-phase summary prompts (PROMPT_7 Track D).
 *
 * `buildSummaryLitePrompt` returns a small payload (~1.5–2k tokens) for
 * the fast first impression: overview + tl_dr + key contributions + the
 * 2–3 most important equations. Streams in ~10 s on Sonnet.
 *
 * `buildSummaryDeepPrompt` returns the heavy fields (methodology /
 * results / discussion / limitations / future work / figures) and is
 * kicked off only after the lite phase lands and the user is actually
 * viewing the Summary tab — saves the work for papers that nobody
 * opens.
 */

const SHARED_RULES = `Output rules (strict):
- Use markdown for all narrative fields.
- JSON-string LaTeX: every backslash inside a JSON string MUST be doubled. Write "\\\\hat{H}" so JSON parses to "\\hat{H}". A SINGLE backslash before a non-escape char (\\h, \\v, \\m, \\f, \\e, \\b…) is dropped by JSON parsers and the LaTeX command is destroyed. Example correct: "$$\\\\sum_{n\\\\mathbf{k}} \\\\varepsilon_{n\\\\mathbf{k}}$$".
- Math: inline math goes in $...$, display math in $$...$$ on its own line. Each opener has EXACTLY one matching closer of the same length — never $$$ to close a $$ block, never $ inside a $$ block, never $$ inside an inline $...$ span. Example correct closure: $$E = mc^2$$  Example WRONG: $$E = mc^2$$$ (three dollar signs).
- NEVER use \\\\( \\\\) or \\\\[ \\\\] delimiters; only $ and $$.
- NEVER emit Unicode math symbols (σ, μ, ∑, ∫…) outside math delimiters; always write \\\\sigma, \\\\mu, \\\\sum, \\\\int, etc. inside $...$.
- Don't preserve PDF artifacts like one-glyph-per-line or run-on words; reconstruct using paper context.`;

import type { PromptDepth } from "@/lib/server/promptDepth";
import { depthSuffix } from "@/lib/server/promptDepth";
import { buildPaperExcerpt } from "@/lib/server/paperExcerpt";
import { contextBudget } from "@/lib/server/promptBudgets";

function buildContext(
  paperTitle: string,
  paperContext: string,
  deepAnalysis = false,
): string {
  const titleLine = paperTitle ? `Paper title: ${paperTitle}\n\n` : "";
  const maxChars = contextBudget("summary", deepAnalysis);
  const excerpt = buildPaperExcerpt(paperContext || "", {
    maxChars,
    profile: "summary",
  });
  return titleLine + `Paper content (excerpt — section-aware):\n"""\n${excerpt}\n"""`;
}

export function buildSummaryLitePrompt(args: {
  paperTitle: string;
  paperContext: string;
  depth?: PromptDepth;
  deepAnalysis?: boolean;
}): { system: string; paperContextText: string; taskText: string } {
  const depthLine = depthSuffix(args.depth);
  const depthBlock = depthLine ? `\n\n${depthLine}` : "";

  const system = [
    `You are an expert science editor producing a fast, high-signal first impression of an academic paper.`,
    SHARED_RULES,
    `Fill exactly these fields:`,
    `- "overview": 3–5 sentence high-level overview of what the paper does and why it matters.`,
    `- "tl_dr": one-sentence takeaway with the single most important result. Math-aware ($...$ allowed).`,
    `- "key_contributions": array of 3–5 strings, each 1–2 sentences. Order by importance.`,
    `- "key_equations": optional array of up to 3 items {"equation": LaTeX wrapped in $$...$$ on its own line, "meaning": one-paragraph markdown}. NEVER emit bare LaTeX — always wrap the equation field in $$...$$.`,
    `Be precise and concrete. No filler. This pass MUST be short so the reader sees content quickly.`,
    depthBlock,
  ].join("\n\n");

  const paperContextText = buildContext(args.paperTitle, args.paperContext, args.deepAnalysis);
  const taskText = `Return the structured object. Always include a non-empty "overview" and "key_contributions".`;

  return { system, paperContextText, taskText };
}

export function buildSummaryDeepPrompt(args: {
  paperTitle: string;
  paperContext: string;
  depth?: PromptDepth;
  deepAnalysis?: boolean;
}): { system: string; paperContextText: string; taskText: string } {
  const depthLine = depthSuffix(args.depth);
  const depthBlock = depthLine ? `\n\n${depthLine}` : "";

  const system = [
    `You are an expert science editor producing a comprehensive, structured summary of an academic paper. Fill every field below so the reader gets a single, self-contained briefing.`,
    SHARED_RULES,
    `Each field is independent — write each as if the reader will see it in isolation. Skip empty rhetorical filler.`,
    `- "overview": 3–5 sentence high-level overview of what the paper does and why it matters.`,
    `- "tl_dr": one-sentence takeaway with the single most important result.`,
    `- "key_contributions": array of 3–5 strings, each 1–2 sentences, ordered by importance.`,
    `- "motivation": 3–5 sentences on why this work was done and what gap it fills.`,
    `- "methodology": 1–2 paragraph markdown explanation of the methods, models, or theoretical framework. Embed equations where they aid understanding.`,
    `- "main_results": 1–2 paragraph markdown describing the key findings, including quantitative numbers in math delimiters.`,
    `- "discussion": 1–2 paragraph markdown — what the results mean, how they compare to prior work, what they imply.`,
    `- "limitations": array of short markdown strings with caveats the authors mention OR that are evident.`,
    `- "future_work": 2–3 sentences on what follow-up research this enables or suggests.`,
    `- "key_equations": optional array of up to 4 items {"equation", "meaning", "terms"}. "equation" MUST be wrapped in $$...$$ on its own line. "meaning" is a markdown paragraph. "terms" is an array of {"symbol", "meaning"} entries covering EVERY variable and constant in the equation (e.g. for $V(R, z) \\approx \\mathrm{sgn}(z)\\, P(R) / (2\\epsilon_0)$, list $V$, $R$, $z$, $\\mathrm{sgn}$, $P(R)$, and $\\epsilon_0$). Be thorough — readers rely on this glossary.`,
    `- "key_figures_and_tables": array of {"id", "description"}. Pick the most informative figures/tables; use the author's labels (e.g. "Fig. 1").`,
    depthBlock,
  ].join("\n\n");

  const paperContextText = buildContext(args.paperTitle, args.paperContext, args.deepAnalysis);
  const taskText = `Return the structured object. Always include non-empty "overview", "key_contributions", "motivation", "methodology", "main_results", "discussion". Leave arrays empty when a section truly does not apply.`;

  return { system, paperContextText, taskText };
}

/**
 * Back-compat for any direct importer (e.g. tests). Delegates to the
 * deep prompt — equivalent to the pre-split combined prompt.
 */
export const buildSummaryPrompt = buildSummaryDeepPrompt;
