/**
 * Zod schemas for the structured outputs of migrated streaming routes.
 *
 * Streamdown handles math via KaTeX inside markdown strings (with
 * `$...$` / `$$...$$` delimiters). That means we don't need a custom
 * `ContentBlock[]` discriminated union — narrative fields are just
 * markdown strings, and the schema's job is to:
 *
 *   1. Keep the `action` discriminator + structured side-channels
 *      (assumptions, derivation steps) typed.
 *   2. Stream cleanly: `streamObject` emits partial-JSON updates as
 *      each markdown field grows, and Streamdown's parseIncomplete
 *      handling renders mid-stream `$$` blocks safely.
 *
 * Anything inside a `markdown` field follows the rule baked into the
 * system prompt: math goes inside `$...$` (inline) or `$$...$$`
 * (display); never bare LaTeX, never Unicode math symbols, never raw
 * HTML. KaTeX renders strict=false so half-typed expressions degrade
 * gracefully during streaming.
 */

import { z } from "zod";

const Assumption = z.object({
  type: z.enum(["explicit", "implicit"]),
  statement: z.string(),
  significance: z.string().optional(),
});

const Step = z.object({
  step_number: z.number(),
  prompt: z.string(),
  answer: z.string(),
  explanation: z.string(),
  hint: z.string().optional(),
});

/**
 * Result for the migrated `selection-stream` route. One schema across
 * all three actions so `experimental_useObject` only needs one schema
 * subscription. Fields not relevant to a given action stay empty/`[]`.
 */
export const SelectionResultSchema = z.object({
  action: z.enum(["explain", "derive", "followup"]),
  body: z
    .string()
    .optional()
    .describe(
      "Primary markdown narrative. Use $...$ for inline math and $$...$$ for display math. NEVER bare LaTeX commands, Unicode math symbols, or raw HTML."
    ),
  assumptions: z.array(Assumption).optional(),
  starting_point: z.string().optional(),
  final_result: z.string().optional(),
  steps: z.array(Step).optional(),
});

export type SelectionResult = z.infer<typeof SelectionResultSchema>;

/**
 * Schema for the migrated `summary-stream` route.
 *
 * Mirrors the existing `PaperSummary` shape on the Python side so the
 * cached_analysis row layout stays compatible across migrated and
 * unmigrated reads. Markdown strings, not ContentBlock[]; Streamdown
 * renders math via $...$ / $$...$$.
 *
 * All fields are `.optional()`. Structured-output validation runs on
 * the final assembled JSON in `onFinish`; if the model truncates or
 * skips a field (Sonnet sometimes drops `key_figures_and_tables` for
 * papers without a figure list), strict validation would fail the
 * entire stream and the user would see a blank panel. Optional fields
 * let `streamObject` still hand us a usable object — sections we
 * didn't get just don't render. The corresponding text fields default
 * to "" / [] in the panel renderer so the UI is unaffected.
 */
/**
 * Two-phase summary schemas (PROMPT_7 Track D).
 *
 * Lite returns in ~10 s with overview + tl_dr + key contributions + the
 * 2–3 most important equations. Deep streams in afterward (60–90 s) with
 * methodology / results / discussion / limitations / future work /
 * figures. Both write into the same `cached_analysis.summary` slot via a
 * shallow merge so a single `PaperSummary` consumer keeps rendering.
 */

const KeyEquationTerm = z.object({
  symbol: z
    .string()
    .describe("The variable or symbol from the equation, wrapped in $...$ (e.g. \"$\\\\alpha$\" or \"$F_x$\")."),
  meaning: z
    .string()
    .describe("Plain-English description of what this symbol denotes, including units when relevant."),
});

const KeyEquation = z.object({
  equation: z
    .string()
    .describe(
      "Display-math LaTeX for one of the paper's most important equations. MUST be wrapped in $$...$$ delimiters. Example: \"$$E = mc^2$$\". Never emit bare LaTeX commands.",
    ),
  meaning: z
    .string()
    .describe("Markdown one-paragraph explanation of what this equation says and why it matters in the paper."),
  terms: z
    .array(KeyEquationTerm)
    .optional()
    .describe(
      "Per-variable glossary: every distinct symbol appearing in the equation, with its meaning. Include constants like $\\\\epsilon_0$ as well as variables. Aim for completeness."
    ),
});

const KeyFigure = z.object({
  id: z.string().describe("Author label, e.g. 'Fig. 1' or 'Table 2'."),
  description: z
    .string()
    .describe("Markdown description of what the figure/table shows and why it matters."),
});

export const PaperSummaryLiteSchema = z.object({
  model: z.string().optional(),
  created_at: z.number().optional(),
  overview: z.string().describe("3–5 sentence high-level overview of what the paper does and why it matters."),
  tl_dr: z
    .string()
    .optional()
    .describe("One-sentence takeaway. Math-aware ($...$ allowed)."),
  key_contributions: z
    .array(z.string())
    .describe("1–2 sentence bullets, 3–5 items, ordered by importance."),
  key_equations: z
    .array(KeyEquation)
    .optional()
    .describe("Up to 3 most important equations."),
});

export type PaperSummaryLite = z.infer<typeof PaperSummaryLiteSchema>;

export const PaperSummaryDeepSchema = z.object({
  model: z.string().optional(),
  created_at: z.number().optional(),
  overview: z.string().describe("3–5 sentence high-level overview of what the paper does and why it matters."),
  tl_dr: z
    .string()
    .optional()
    .describe("One-sentence takeaway with the single most important result. Math-aware ($...$ allowed)."),
  key_contributions: z
    .array(z.string())
    .describe("1–2 sentence bullets, 3–5 items, ordered by importance."),
  motivation: z.string().describe("3–5 sentences on why this work was done and what gap it fills."),
  methodology: z
    .string()
    .describe("1–2 paragraph markdown explanation of the methods, models, or theoretical framework."),
  main_results: z
    .string()
    .describe("1–2 paragraph markdown describing the key findings; quantitative numbers in $...$ delimiters."),
  discussion: z
    .string()
    .describe("1–2 paragraph markdown — what the results mean, how they compare to prior work."),
  limitations: z.array(z.string()).optional(),
  future_work: z.string().optional().describe("2–3 sentences on follow-up research this enables."),
  key_equations: z.array(KeyEquation).optional().describe("Up to 4 of the paper's most important equations, each with a per-variable glossary."),
  key_figures_and_tables: z.array(KeyFigure).optional(),
});

export type PaperSummaryDeep = z.infer<typeof PaperSummaryDeepSchema>;

/**
 * Combined `PaperSummary` is the union of lite + deep — what the panel
 * actually renders. Slots that the lite phase didn't populate fall to
 * the deep phase's values, and vice versa.
 */
export const PaperSummarySchema = z.object({
  model: z.string().optional(),
  created_at: z.number().optional(),
  overview: z.string().optional(),
  tl_dr: z.string().optional(),
  motivation: z.string().optional(),
  key_contributions: z.array(z.string()).optional(),
  methodology: z.string().optional(),
  main_results: z.string().optional(),
  discussion: z.string().optional(),
  limitations: z.array(z.string()).optional(),
  future_work: z.string().optional(),
  key_equations: z.array(KeyEquation).optional(),
  key_figures_and_tables: z.array(KeyFigure).optional(),
});

export type PaperSummary = z.infer<typeof PaperSummarySchema>;

/**
 * Schema for the migrated `figure-qa-stream` route.
 *
 * Two shapes share one schema: free-form analysis (no question) and
 * direct Q&A (with `answer`). Optional fields keep the JSON small for
 * the case the model didn't fill them.
 */
export const FigureAnalysisSchema = z.object({
  description: z.string().describe("Markdown description of the figure."),
  key_observations: z.array(z.string()).optional(),
  methodology_shown: z.string().optional(),
  relation_to_paper: z.string().optional(),
  takeaway: z.string().optional(),
  answer: z
    .string()
    .optional()
    .describe("If a user question was asked, the direct markdown answer goes here."),
});

export type FigureAnalysis = z.infer<typeof FigureAnalysisSchema>;
