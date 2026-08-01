// Type-only, so this does not create a runtime cycle with schema.ts, which
// imports CATEGORY_IDS from here as a value.
import type { z } from 'zod';
import type {
  adversarialCaseSchema,
  atomicCriterionSchema,
  behaviouralAnchorSetSchema,
  evidencePackSchema,
  interactiveScriptSchema,
  itemClassificationSchema,
  itemExposureSchema,
  itemProvenanceSchema,
  judgePackSchema,
  kitchenPlanContractSchema,
  kitchenPlanSchema,
  outputContractSchema,
  planEquipmentSchema,
  planIngredientSchema,
  planOperationSchema,
  sensoryDossierSchema,
  workedExampleSchema,
  JUDGE_MODES,
  ATOMIC_CRITERION_KINDS,
  EXPOSURE_STATES,
  ITEM_STRATA,
  PLAN_LIMIT_SOURCES,
} from './schema.js';

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
      /**
       * M2.1's grading route. Absent means the legacy route — v1/v2 items are
       * graded exactly as they were. Never read absence as "any mode".
       */
      judgeMode?: JudgeMode;
      /**
       * judge-v1 criteria; judge-v2 (deduction grading) uses them only as
       * attention hints. v3 items put atomic criteria here instead. The array
       * is homogeneous — the schema refuses a mixture, because legacy weights
       * are shares summing to 1 and atomic weights are per-claim magnitudes.
       */
      rubric?: (RubricCriterion | AtomicCriterion)[];
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

  /* ---- v3 blocks, all optional. See schema.ts for the parsing rules. ----- */

  /** M2.3 behavioural anchors, one set per scored dimension. */
  anchors?: BehaviouralAnchorSet[];
  /** M2.4 judge pack — what replaces a lone reference answer on subjective items. */
  judgePack?: JudgePack;
  outputContract?: OutputContract;
  kitchenPlanContract?: KitchenPlanContract;
  interactiveScript?: InteractiveScript;
  classification?: ItemClassification;
  provenance?: ItemProvenance;
  exposure?: ItemExposure;
  adversarialCases?: AdversarialCase[];
  evidencePack?: EvidencePack;
  validatorVersion?: string;
}

/* -------------------------------------------------------------------------- */
/* v3 domain types                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The v3 types are derived from the zod schemas rather than restated here.
 *
 * The rest of this file mirrors its schemas by hand, which is tolerable for a
 * dozen fields and dishonest for the v3 contract: KitchenPlan alone is fifteen
 * object types, ten packages compile against them, and a hand-mirror that
 * drifts from the parser would hand every one of those packages a type that
 * accepts what the parser rejects. One source of truth, in schema.ts.
 */

/** M2.1: fault-deduction, anchored dimensions, or pairwise comparison. */
export type JudgeMode = (typeof JUDGE_MODES)[number];
export type AtomicCriterionKind = (typeof ATOMIC_CRITERION_KINDS)[number];
/** M3.6 bank exposure — who has seen the item, not whether it scores. */
export type ExposureState = (typeof EXPOSURE_STATES)[number];
/** M3.7 reporting strata, carried as a hypothesis until certified. */
export type ItemStratum = (typeof ITEM_STRATA)[number];
/** Where a limit a validator relies on came from. M1.2. */
export type PlanLimitSource = (typeof PLAN_LIMIT_SOURCES)[number];

export type AtomicCriterion = z.infer<typeof atomicCriterionSchema>;
export type BehaviouralAnchorSet = z.infer<typeof behaviouralAnchorSetSchema>;
export type WorkedExample = z.infer<typeof workedExampleSchema>;
export type JudgePack = z.infer<typeof judgePackSchema>;
export type OutputContract = z.infer<typeof outputContractSchema>;
export type AdversarialCase = z.infer<typeof adversarialCaseSchema>;
export type EvidencePack = z.infer<typeof evidencePackSchema>;

/** M1.2 — the candidate's kitchen representation. */
export type KitchenPlan = z.infer<typeof kitchenPlanSchema>;
export type KitchenPlanContract = z.infer<typeof kitchenPlanContractSchema>;
export type PlanIngredient = z.infer<typeof planIngredientSchema>;
export type PlanEquipment = z.infer<typeof planEquipmentSchema>;
export type PlanOperation = z.infer<typeof planOperationSchema>;

/** M1.4 — the comparable sensory contract the Palate jury judges. */
export type SensoryDossier = z.infer<typeof sensoryDossierSchema>;

/** M1.3 — the deterministic two-turn observation script. */
export type InteractiveScript = z.infer<typeof interactiveScriptSchema>;

export type ItemClassification = z.infer<typeof itemClassificationSchema>;
export type ItemProvenance = z.infer<typeof itemProvenanceSchema>;
export type ItemExposure = z.infer<typeof itemExposureSchema>;

export interface ModelEntry {
  /** OpenRouter slug, e.g. "anthropic/claude-fable-5". */
  id: string;
  displayName: string;
  provider: string;
  /** Model family for same-family version comparisons, e.g. "gemini-pro". */
  family?: string;
  /** Underlying trained-model identity used for judge conflict exclusion. */
  baseModel: string;
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
