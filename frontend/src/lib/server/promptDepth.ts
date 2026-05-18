export type PromptDepth = "concise" | "standard" | "deep";

export function depthSuffix(depth: PromptDepth = "standard"): string {
  if (depth === "concise") return "Be terse and direct. Avoid restating context.";
  if (depth === "deep") {
    return "Be thorough. When the answer benefits from depth, include worked steps, edge cases, and cite which paragraph each claim came from.";
  }
  return "";
}
