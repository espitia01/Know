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
