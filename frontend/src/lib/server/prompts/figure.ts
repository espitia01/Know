/**
 * Prompts for the migrated figure-qa-stream route.
 *
 * Two shapes share the same schema: open-ended figure analysis when
 * `question` is empty, direct Q&A when it isn't. The model fills
 * `answer` only in the Q&A case.
 */

const SHARED_RULES = `Output rules (strict):
- Markdown for all narrative fields.
- Math: inline math in $...$, display math in $$...$$ on its own line. NEVER bare LaTeX commands or Unicode math symbols outside math delimiters.`;

const PAPER_CHAR_BUDGET = 4000;

export function buildFigurePrompt(args: {
  paperContext: string;
  question?: string;
}): { system: string; userText: string } {
  const paperContext = (args.paperContext || "").slice(0, PAPER_CHAR_BUDGET);
  const q = (args.question || "").trim();

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
      ].join("\n\n"),
      userText: [
        `User question: ${q}`,
        `Paper context (for reference):\n"""\n${paperContext}\n"""`,
      ].join("\n\n"),
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
    ].join("\n\n"),
    userText: `Paper context (for reference):\n"""\n${paperContext}\n"""`,
  };
}
