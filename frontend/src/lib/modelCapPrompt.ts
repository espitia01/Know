// Global prompt registry for per-model daily-cap 429s.
//
// `ModelCapModal` registers a function here on mount. `api.ts`'s `request`
// calls it whenever the backend returns a 429 whose `detail` matches
// `Daily limit reached for <model>`. The prompter resolves to:
//   - `{ fallback: string }` → the caller should switch to this model and retry
//   - `null`               → the user dismissed; caller should surface the error
//
// Keeping this in a plain module (not a React context) means the api layer
// can call it without being mounted under a provider, which matters because
// `request` is called from many non-React places too.

export type ModelCapPromptInput = {
  cappedModel: string;
  limit: number;
  tier: string;
};

export type ModelCapPromptResult = { fallback: string } | null;

type Prompter = (input: ModelCapPromptInput) => Promise<ModelCapPromptResult>;

let prompter: Prompter | null = null;

// If many requests land simultaneously after a cap is hit (e.g. Q&A + summary
// fire in parallel), they would each try to open their own modal. Dedupe by
// `cappedModel` so they all share a single prompt/resolution.
const inflight: Map<string, Promise<ModelCapPromptResult>> = new Map();

export function registerModelCapPrompter(fn: Prompter | null) {
  prompter = fn;
  if (!fn) inflight.clear();
}

export async function promptModelCap(
  input: ModelCapPromptInput
): Promise<ModelCapPromptResult> {
  if (!prompter) return null;
  const cached = inflight.get(input.cappedModel);
  if (cached) return cached;
  const p = (async () => {
    try {
      return await prompter!(input);
    } catch {
      return null;
    } finally {
      inflight.delete(input.cappedModel);
    }
  })();
  inflight.set(input.cappedModel, p);
  return p;
}

// Ordered smallest → largest. The "fallback" for a capped model is the
// largest entry strictly smaller than it that the user's tier still allows.
export const MODEL_ORDER = [
  "claude-haiku-4-5",
  "claude-sonnet-4-6",
  "claude-opus-4-7",
] as const;

export function pickFallback(
  cappedModel: string,
  allowedModels: string[]
): string | null {
  const idx = MODEL_ORDER.indexOf(cappedModel as (typeof MODEL_ORDER)[number]);
  if (idx <= 0) return null;
  for (let i = idx - 1; i >= 0; i--) {
    if (allowedModels.includes(MODEL_ORDER[i])) return MODEL_ORDER[i];
  }
  return null;
}
