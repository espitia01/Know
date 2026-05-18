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
  step_number: z.number().int().positive(),
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
    .describe(
      "Primary markdown narrative. Use $...$ for inline math and $$...$$ for display math. NEVER bare LaTeX commands, Unicode math symbols, or raw HTML."
    ),
  assumptions: z.array(Assumption).default([]),
  starting_point: z.string().optional(),
  final_result: z.string().optional(),
  steps: z.array(Step).default([]),
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
 * Every field gets a default so `useObject`'s DeepPartial views render
 * cleanly while the stream is still filling the structure in field
 * order — the visible UX is "Overview appears, then Motivation, then
 * Methodology…" rather than a single end-of-stream paint.
 */
export const PaperSummarySchema = z.object({
  overview: z.string().default(""),
  motivation: z.string().default(""),
  key_contributions: z.array(z.string()).default([]),
  methodology: z.string().default(""),
  main_results: z.string().default(""),
  discussion: z.string().default(""),
  limitations: z.array(z.string()).default([]),
  future_work: z.string().default(""),
  key_equations: z
    .array(
      z.object({
        equation: z
          .string()
          .describe(
            "LaTeX expression for one of the paper's most important equations. Wrap in $$...$$ for display math.",
          ),
        meaning: z.string().describe("Markdown one-paragraph explanation."),
      }),
    )
    .default([]),
  key_figures_and_tables: z
    .array(
      z.object({
        id: z.string().describe("Author label, e.g. 'Fig. 1' or 'Table 2'."),
        description: z.string().describe("Markdown description of what the figure/table shows and why it matters."),
      }),
    )
    .default([]),
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
  key_observations: z.array(z.string()).default([]),
  methodology_shown: z.string().optional(),
  relation_to_paper: z.string().default(""),
  takeaway: z.string().optional(),
  answer: z
    .string()
    .optional()
    .describe("If a user question was asked, the direct markdown answer goes here."),
});

export type FigureAnalysis = z.infer<typeof FigureAnalysisSchema>;
