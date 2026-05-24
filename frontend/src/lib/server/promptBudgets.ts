/**
 * Per-feature prompt char budgets (Track B).
 * Standard budgets match post-Track-A behavior; deep is exactly 2×.
 */

export const DEEP_MULTIPLIER = 2;

export const STD_BUDGETS = {
  summary: { context: 18000 },
  selection: { context: 4500, selection: 3000 },
  figure: { context: 6000 },
} as const;

export function scaleBudget<T extends Record<string, number>>(
  budget: T,
  factor: number,
): T {
  const out = { ...budget } as Record<string, number>;
  for (const k of Object.keys(out)) {
    if (out[k] > 0) out[k] = out[k] * factor;
  }
  return out as T;
}

export function contextBudget(
  kind: keyof typeof STD_BUDGETS,
  deepAnalysis: boolean,
): number {
  const base = STD_BUDGETS[kind].context;
  return deepAnalysis ? base * DEEP_MULTIPLIER : base;
}

export function selectionTextBudget(deepAnalysis: boolean): number {
  const base = STD_BUDGETS.selection.selection;
  return deepAnalysis ? base * DEEP_MULTIPLIER : base;
}
