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

export type GraderSpec =
  | {
      type: 'numeric';
      expected: number;
      unit?: string;
      tolerancePct?: number;
      toleranceAbs?: number;
      /** Accept answers given in a convertible unit, e.g. 350°F == 177°C. */
      acceptEquivalentUnits?: boolean;
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
      rubric: RubricCriterion[];
      /** Deterministic sub-checks blended into the score (e.g. allergen absence). */
      constraintChecks?: GraderSpec[];
      /** Weight of the judge score when constraintChecks exist. Default 0.7. */
      judgeWeight?: number;
    };

export interface Question {
  /** e.g. "conv-007" */
  id: string;
  category: CategoryId;
  difficulty: 1 | 2 | 3;
  /** Exact text sent to the model. */
  prompt: string;
  /** Optional output-format instruction appended to the system prompt. */
  systemHint?: string;
  grader: GraderSpec;
  /** Canonical answer — shown to the judge and published on the site. */
  referenceAnswer: string;
  /** Citation: USDA, McGee, etc. */
  source?: string;
  /** false = held-out; never shown in the public explorer. */
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
  judgeModel: string;
  judgePromptVersion: string;
  methodologyVersion: string;
  mock?: boolean;
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
