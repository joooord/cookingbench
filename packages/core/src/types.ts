export const CATEGORY_IDS = [
  'quantities-scaling',
  'conversions',
  'food-safety',
  'substitutions',
  'technique',
  'flavor-pairing',
  'nutrition',
  'recipe-generation',
] as const;

export type CategoryId = (typeof CATEGORY_IDS)[number];

export interface CategoryMeta {
  id: CategoryId;
  name: string;
  description: string;
}

export const CATEGORIES: Record<CategoryId, CategoryMeta> = {
  'quantities-scaling': {
    id: 'quantities-scaling',
    name: 'Quantities & Scaling',
    description:
      'Scaling recipes up and down, yields, pan-size math and baker’s percentages.',
  },
  conversions: {
    id: 'conversions',
    name: 'Conversions',
    description:
      'Volume, weight and temperature conversions across kitchen units and locales.',
  },
  'food-safety': {
    id: 'food-safety',
    name: 'Food Safety',
    description:
      'Safe internal temperatures, the danger zone, storage times and cross-contamination.',
  },
  substitutions: {
    id: 'substitutions',
    name: 'Substitutions',
    description:
      'Ingredient swaps with correct ratios, including allergen-aware alternatives.',
  },
  technique: {
    id: 'technique',
    name: 'Technique',
    description:
      'Troubleshooting failures (split sauces, dense bread) and method advice.',
  },
  'flavor-pairing': {
    id: 'flavor-pairing',
    name: 'Flavour Pairing',
    description:
      'Pairing logic, cuisine coherence and balancing dishes.',
  },
  nutrition: {
    id: 'nutrition',
    name: 'Nutrition',
    description:
      'Calorie and macro math, per-serving calculations and label reasoning.',
  },
  'recipe-generation': {
    id: 'recipe-generation',
    name: 'Recipe Generation',
    description:
      'Generating complete recipes under constraints: servings, allergens, time, equipment.',
  },
};

export interface RubricCriterion {
  /** e.g. "Technique accuracy" */
  name: string;
  /** What a 5 looks like vs a 1, written per-question. */
  description: string;
  /** Weights across a rubric sum to 1. */
  weight: number;
}

export interface NumericTarget {
  label: string;
  expected: number;
  unit?: string;
  tolerancePct?: number;
  toleranceAbs?: number;
}

/**
 * Partial-credit band for numeric graders: the first (tightest) band the
 * answer falls in determines the score. Lets compound-chain questions award
 * 60 for one rounding slip and 25 for right-method-sloppy-arithmetic.
 */
export interface ToleranceBand {
  tolerancePct?: number;
  toleranceAbs?: number;
  /** 0–100 awarded when the answer is within this band. */
  score: number;
}

export type GraderSpec =
  | {
      type: 'numeric';
      expected: number;
      unit?: string;
      tolerancePct?: number;
      toleranceAbs?: number;
      /** Accept answers given in a convertible unit, e.g. 350°F == 177°C. */
      acceptEquivalentUnits?: boolean;
      /** The correct answer legitimately restates a prompt value — skip the echo filter. */
      expectedInPrompt?: boolean;
      /** Graded partial-credit bands (tightest first); falls back to binary tolerance when absent. */
      bands?: ToleranceBand[];
    }
  | {
      type: 'numeric-multi';
      targets: NumericTarget[];
      scoring: 'all-or-nothing' | 'proportional';
    }
  | { type: 'range'; min: number; max: number; unit?: string }
  | {
      type: 'keyword';
      /** Outer array = AND, inner array = OR (synonyms). Optional when only forbidding. */
      required?: string[][];
      /** Any forbidden term present zeroes the question (e.g. unsafe advice). */
      forbidden?: string[];
    }
  | {
      type: 'llm-judge';
      /** judge-v1 criteria; judge-v2 (deduction grading) uses them only as attention hints. */
      rubric?: RubricCriterion[];
      /** Deterministic sub-checks blended into the score (e.g. allergen absence). */
      constraintChecks?: GraderSpec[];
      /** Weight of the judge score when constraintChecks exist. Default 0.7. */
      judgeWeight?: number;
    };

/**
 * active = counts toward Overall; basics = still run, separate Basics column
 * (saturated items demoted by `bench analyze`); retired = never run again.
 */
export type QuestionStatus = 'active' | 'basics' | 'retired';

export interface Question {
  /** e.g. "conv-007" */
  id: string;
  category: CategoryId;
  /** 1 (trivial) – 5 (frontier-separating). v1 items used 1–3. */
  difficulty: number;
  status: QuestionStatus;
  /** Methodology version that introduced the item. */
  addedIn: string;
  /** The prompt embeds a false or dangerous premise the model must catch. */
  trap: boolean;
  /** Exact text sent to the model. */
  prompt: string;
  /** Optional output-format instruction appended to the system prompt. */
  systemHint?: string;
  grader: GraderSpec;
  /** judge-v2 attention hints: the decisive checks for this question. */
  judgingNotes?: string;
  /** Canonical answer — shown to the judge and published on the site. */
  referenceAnswer: string;
  /**
   * A deliberately wrong answer, never shown to models. With referenceAnswer it
   * proves the grader can separate right from wrong before a single paid call.
   */
  failingAnswer?: string;
  /** Citation: USDA, McGee, etc. */
  source?: string;
  /** Kept for artifact compatibility — the whole dataset is public (see methodology). */
  public: boolean;
}

export interface ModelEntry {
  /** OpenRouter slug, e.g. "anthropic/claude-fable-5". */
  id: string;
  displayName: string;
  provider: string;
  /** Model family for same-family version comparisons, e.g. "gemini-pro". */
  family?: string;
  releaseDate?: string;
  active: boolean;
}

export interface RunConfig {
  runId: string;
  models: string[];
  temperature: number;
  maxTokens: number;
  maxTokensRecipe: number;
  budgetUsdTotal: number;
  budgetUsdPerModel: number;
  concurrency: number;
  /** Label/back-compat single judge; panel runs list the seats in judgePanel. */
  judgeModel: string;
  /** v2 panel: distinct judge models; two non-conflicted seats score each answer. */
  judgePanel?: string[];
  judgePromptVersion: string;
  /**
   * Cumulative judging spend for this run. Candidate calls are recorded per
   * response; judging used to record nothing at all, which left about half of
   * the project's real OpenRouter spend invisible to the tooling.
   */
  judgeCostUsd?: number;
  methodologyVersion: string;
  mock?: boolean;
  /**
   * One entry per `bench run` invocation against this run id.
   *
   * Batching per model is the documented way to run this benchmark (RUNBOOK,
   * CLAUDE.md: "batch per model with a budget just above that batch's worst
   * case"), but `writeRunConfig` overwrote the whole file each time, so the
   * published config described only the final batch. `2026-06-v2` records one
   * model and a leaderboard of thirteen; `2026-07-v2.1` recorded seven of
   * fourteen. `models` is now the union across batches and this is the audit
   * trail behind it — including any batch that ran at different token caps,
   * which would otherwise be invisible.
   */
  batches?: RunBatch[];
}

export interface RunBatch {
  startedAt: string;
  models: string[];
  maxTokens: number;
  maxTokensRecipe: number;
  budgetUsdTotal: number;
}

export interface StoredResponse {
  runId: string;
  modelId: string;
  questionId: string;
  answerText: string;
  raw: unknown;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  finishReason?: string;
  /** Empty/filtered even after retries — scores 0 but is surfaced as an incident, not skill. */
  transportFailure?: boolean;
}

export interface GradeDetail {
  [key: string]: unknown;
}

export interface Score {
  runId: string;
  modelId: string;
  questionId: string;
  /** 0–100 */
  score: number;
  graderType: GraderSpec['type'];
  detail: GradeDetail;
  judgeModel?: string;
}

export interface GradeResult {
  /** 0–100 */
  score: number;
  detail: GradeDetail;
}
