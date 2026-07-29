export interface ModelPricing {
  /** USD per input token (OpenRouter reports per-token prices). */
  promptUsd: number;
  /** USD per output token. */
  completionUsd: number;
}

/** Crude but conservative token estimate: ~4 chars per token, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CostEstimate {
  calls: number;
  inputTokens: number;
  /** Worst case: every call uses its full max_tokens. */
  maxOutputTokens: number;
  worstCaseUsd: number;
  /**
   * What the run will plausibly cost, from `expectedOutputTokens`. The worst
   * case is a ceiling, not a forecast, and once caps are set high enough not to
   * truncate reasoning models it stops being a useful one: raising the recipe
   * cap to 32k took the worst case for three models from $80 to $343 while the
   * measured spend for those same models was under $1 per question.
   */
  expectedUsd: number;
}

/**
 * Expected output tokens per call, in absolute terms.
 *
 * Measured over run 2026-06-v2: non-recipe answers averaged 531 tokens (p90
 * 1,127), recipe answers 2,592 (p90 5,923). The 2026-07 roster reasons
 * considerably more, so these sit near double the old p90.
 *
 * Absolute rather than a fraction of the cap: the caps exist to stop reasoning
 * models being truncated, so they are set far above what anything typically
 * emits. Scaling the forecast off them just inflates it — 20% of cap put a
 * one-line conversion question at 3,200 tokens against a measured mean of 531.
 *
 * Erring high here only blocks a run that would have fit. Erring low costs
 * nothing: BudgetGuard enforces the real ceiling against actual spend, and the
 * run is resume-aware, so an early abort is re-invoked, not lost.
 */
export const EXPECTED_OUTPUT_TOKENS = { normal: 2000, recipe: 9000 } as const;

export function estimateModelCost(
  prompts: Array<{ text: string; maxTokens: number; expectedTokens?: number }>,
  pricing: ModelPricing,
): CostEstimate {
  let inputTokens = 0;
  let maxOutputTokens = 0;
  let expectedOutputTokens = 0;
  for (const p of prompts) {
    inputTokens += estimateTokens(p.text) + 80; // system prompt + message overhead
    maxOutputTokens += p.maxTokens;
    expectedOutputTokens += Math.min(p.expectedTokens ?? EXPECTED_OUTPUT_TOKENS.normal, p.maxTokens);
  }
  return {
    calls: prompts.length,
    inputTokens,
    maxOutputTokens,
    worstCaseUsd: inputTokens * pricing.promptUsd + maxOutputTokens * pricing.completionUsd,
    expectedUsd: inputTokens * pricing.promptUsd + expectedOutputTokens * pricing.completionUsd,
  };
}
