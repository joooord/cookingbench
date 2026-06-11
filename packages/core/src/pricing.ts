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
}

export function estimateModelCost(
  prompts: Array<{ text: string; maxTokens: number }>,
  pricing: ModelPricing,
): CostEstimate {
  let inputTokens = 0;
  let maxOutputTokens = 0;
  for (const p of prompts) {
    inputTokens += estimateTokens(p.text) + 80; // system prompt + message overhead
    maxOutputTokens += p.maxTokens;
  }
  return {
    calls: prompts.length,
    inputTokens,
    maxOutputTokens,
    worstCaseUsd: inputTokens * pricing.promptUsd + maxOutputTokens * pricing.completionUsd,
  };
}
