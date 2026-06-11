export class BudgetExceededError extends Error {
  constructor(
    public readonly scope: 'total' | `model:${string}`,
    public readonly spentUsd: number,
    public readonly capUsd: number,
  ) {
    super(
      `Budget cap reached for ${scope}: spent $${spentUsd.toFixed(4)} of $${capUsd.toFixed(2)} — aborting gracefully (completed work is saved).`,
    );
  }
}

/**
 * Tracks actual spend (as reported by OpenRouter per-request usage) and aborts
 * BEFORE a request that could exceed a cap, using a worst-case estimate for
 * the next call.
 */
export class BudgetGuard {
  private totalSpent = 0;
  private perModelSpent = new Map<string, number>();

  constructor(
    private readonly totalCapUsd: number,
    private readonly perModelCapUsd: number,
  ) {}

  /** Throws if a request with this worst-case cost could exceed a cap. */
  assertCanSpend(modelId: string, worstCaseUsd: number): void {
    if (this.totalSpent + worstCaseUsd > this.totalCapUsd) {
      throw new BudgetExceededError('total', this.totalSpent, this.totalCapUsd);
    }
    const modelSpent = this.perModelSpent.get(modelId) ?? 0;
    if (modelSpent + worstCaseUsd > this.perModelCapUsd) {
      throw new BudgetExceededError(`model:${modelId}`, modelSpent, this.perModelCapUsd);
    }
  }

  record(modelId: string, actualUsd: number): void {
    this.totalSpent += actualUsd;
    this.perModelSpent.set(modelId, (this.perModelSpent.get(modelId) ?? 0) + actualUsd);
  }

  get spentTotalUsd(): number {
    return this.totalSpent;
  }

  spentByModel(): Record<string, number> {
    return Object.fromEntries(this.perModelSpent);
  }
}
