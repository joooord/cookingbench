/**
 * M2.1 dimension mode — anchored 0–4 scores per criterion, combined **using the
 * declared weights**.
 *
 * The weights are the point. The dataset declares 97 of them and the judge
 * pipeline drops every one: `judge.ts` renders the rubric as attention hints and
 * then scores by deduction from 100, so "Diagnosis accuracy — weight 0.5" and
 * "Clarity & practicality — weight 0.2" carry identical force. Authors have
 * been writing a weighting the instrument never read.
 *
 * The second thing dimension mode buys is a ceiling above "unpunished". A
 * deduction grader can only subtract, so its best possible verdict is *no
 * faults found*, and an answer that is correct, complete and utterly dull is
 * indistinguishable from one that is genuinely excellent. An anchored band
 * reaches 4 for excellence and sits at 2 for adequate, so the instrument can
 * finally say "correct, and dull".
 *
 * Bands map linearly: 0→0, 1→25, 2→50, 3→75, 4→100. Nothing in M2.3 asks for a
 * non-linear map, and a curve would quietly re-weight the anchors that authors
 * wrote against the linear reading.
 */
import type { AtomicCriterion, RubricCriterion } from '../types.js';
import { isAtomicCriterion } from '../schema.js';

/** M2.3 bands. Integer 0–4 only — 3.5 is not an anchor, it is an average. */
export const ANCHOR_BANDS = Object.freeze([0, 1, 2, 3, 4] as const);
export const MAX_ANCHOR_BAND = 4;

/**
 * The band a `critical` criterion must reach to count as satisfied.
 *
 * A fail-closed default, not a measured one: a `critical` criterion asserts
 * something that must hold, and anything short of the top band means it does
 * not fully hold. Items may lower it, but the default refuses rather than
 * guessing that band 3 is close enough. It is deliberately NOT used to compute
 * a score — the whole reason the schema warns against "multiplying a critical
 * criterion by 0.1 and moving on" is that a critical miss is a cap, not a
 * weight. `criticalCriterionBreaches` reports; caps.ts decides.
 */
export const CRITICAL_CRITERION_SATISFIED_BAND = 4;

/**
 * Dimensions treated as presentation. M2.1 makes presentation a separate
 * bounded dimension that cannot compensate for unsafe, incorrect or infeasible
 * content, so the combiner keeps it out of the content score entirely rather
 * than including it at a small weight. A small weight is still compensation.
 */
export const PRESENTATION_DIMENSIONS = Object.freeze(['presentation'] as const);

/** Bucket key for criteria that declare no dimension. Never a real dimension id. */
const UNDIMENSIONED = '';

export class DimensionScoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DimensionScoringError';
  }
}

export type DimensionCriterion = AtomicCriterion | RubricCriterion;

export interface CriterionBand {
  /**
   * The declared criterion this band answers: an atomic criterion's `id` (or,
   * lacking one, its `statement`), or a legacy criterion's `name`.
   */
  criterion: string;
  /**
   * 0–4, or `null` for abstain / not-applicable. `null` is excluded from the
   * denominator; it is missingness, not a middling score.
   */
  band: number | null;
  /** What in the answer put it in this band. Carried through for adjudication. */
  evidence?: string;
}

export interface ScoredCriterion {
  criterion: string;
  kind?: AtomicCriterion['kind'];
  dimension: string | null;
  weight: number;
  band: number | null;
  /** 0–100, or null when abstained. */
  points: number | null;
  evidence?: string;
}

export interface DimensionResult {
  /**
   * 0–100 content score: weighted mean over every scored, non-presentation
   * criterion. Presentation is reported beside it and never added.
   */
  score: number;
  perCriterion: ScoredCriterion[];
  /** Criterion keys excluded from the denominator because the seat abstained. */
  abstained: string[];
  /** Weight actually in the denominator, and the weight lost to abstention. */
  weightUsed: number;
  weightAbstained: number;
  /** Dimension id → 0–100 weighted mean over that dimension's criteria. */
  byDimension: Readonly<Record<string, number>>;
  /** Weight behind each dimension, so a ceiling can be applied and recombined. */
  dimensionWeights: Readonly<Record<string, number>>;
  /**
   * Presentation, scored and bounded but structurally separate. `null` when the
   * item declares no presentation criteria.
   */
  presentation: { score: number; weight: number } | null;
  /** `critical` criteria that did not reach CRITICAL_CRITERION_SATISFIED_BAND. */
  criticalBreaches: string[];
  /** Ceilings that were enforced by capDimensions, for reporting. */
  appliedDimensionCeilings: Readonly<Record<string, number>>;
}

/** Stable key for a criterion of either shape. */
export function criterionKey(criterion: DimensionCriterion): string {
  if (isAtomicCriterion(criterion)) {
    const id = criterion.id?.trim();
    return id && id.length > 0 ? id : criterion.statement.trim();
  }
  return criterion.name.trim();
}

function bandToPoints(band: number): number {
  return (band / MAX_ANCHOR_BAND) * 100;
}

function assertBand(band: unknown, key: string): number | null {
  if (band === null) return null;
  if (typeof band !== 'number' || !Number.isInteger(band)) {
    // A non-integer band is a seat averaging behind the harness's back. The
    // anchors describe five observable states; the mean of two of them
    // describes none of them, and accepting it hides the disagreement that
    // M2.1 requires be recorded.
    throw new DimensionScoringError(
      `criterion ${JSON.stringify(key)} has band ${String(band)}; anchored bands are integers 0–4 or null for abstain`,
    );
  }
  if (band < 0 || band > MAX_ANCHOR_BAND) {
    throw new DimensionScoringError(
      `criterion ${JSON.stringify(key)} has band ${band}, outside 0–${MAX_ANCHOR_BAND}`,
    );
  }
  return band;
}

function isPresentation(dimension: string | null, presentationDimensions: readonly string[]): boolean {
  return dimension !== null && presentationDimensions.includes(dimension);
}

export interface CombineOptions {
  /** Override the presentation dimension names for an item that renames them. */
  presentationDimensions?: readonly string[];
  /** Override the band a `critical` criterion must reach. */
  criticalSatisfiedBand?: number;
}

/**
 * Combine anchored bands into a 0–100 content score using the declared weights.
 *
 * Refuses, rather than guessing, on every ambiguity:
 *  - a mixed legacy/atomic criterion list (the two weight semantics have no
 *    common normalisation — see rubricSchema);
 *  - duplicate criterion keys (a weight would be applied twice, or once,
 *    depending on Map insertion order);
 *  - a band naming a criterion the item never declared (a seat inventing
 *    criteria must not be averaged in);
 *  - a declared criterion with no band at all. Abstention has to be written
 *    down as `band: null`. Silence is indistinguishable from a seat quietly
 *    dropping the criterion it found hardest, which is the failure this rule
 *    exists to make impossible;
 *  - every criterion abstained, leaving an empty denominator.
 */
export function combineDimensions(
  criteria: readonly DimensionCriterion[],
  bands: readonly CriterionBand[],
  options: CombineOptions = {},
): DimensionResult {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new DimensionScoringError('dimension mode needs at least one declared criterion');
  }
  if (!Array.isArray(bands)) {
    throw new DimensionScoringError('bands must be an array');
  }

  const atomicCount = criteria.filter(isAtomicCriterion).length;
  if (atomicCount > 0 && atomicCount < criteria.length) {
    throw new DimensionScoringError(
      'criteria must be entirely legacy {name, description, weight} or entirely atomic; ' +
        'legacy weights are shares of a whole and atomic weights are per-claim magnitudes, ' +
        'so a mixture has no defensible normalisation',
    );
  }

  const presentationDimensions = options.presentationDimensions ?? PRESENTATION_DIMENSIONS;
  const criticalSatisfied = options.criticalSatisfiedBand ?? CRITICAL_CRITERION_SATISFIED_BAND;

  const declared = new Map<string, DimensionCriterion>();
  for (const criterion of criteria) {
    const key = criterionKey(criterion);
    if (key.length === 0) {
      throw new DimensionScoringError('a criterion has an empty key');
    }
    if (declared.has(key)) {
      throw new DimensionScoringError(`criterion ${JSON.stringify(key)} is declared twice`);
    }
    const weight = criterion.weight;
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
      // Zero is refused as firmly as NaN. A zero-weight criterion is a
      // criterion the author wrote and the instrument would never read, which
      // is the exact defect this module exists to fix.
      throw new DimensionScoringError(
        `criterion ${JSON.stringify(key)} has weight ${String(weight)}; weights must be positive and finite`,
      );
    }
    declared.set(key, criterion);
  }

  const seen = new Map<string, CriterionBand>();
  for (const entry of bands) {
    if (typeof entry !== 'object' || entry === null) {
      throw new DimensionScoringError('each band entry must be an object');
    }
    if (!declared.has(entry.criterion)) {
      throw new DimensionScoringError(
        `band names criterion ${JSON.stringify(entry.criterion)}, which the item does not declare`,
      );
    }
    if (seen.has(entry.criterion)) {
      throw new DimensionScoringError(`criterion ${JSON.stringify(entry.criterion)} is banded twice`);
    }
    seen.set(entry.criterion, entry);
  }
  for (const key of declared.keys()) {
    if (!seen.has(key)) {
      throw new DimensionScoringError(
        `criterion ${JSON.stringify(key)} has no band; abstention must be written as band: null`,
      );
    }
  }

  const perCriterion: ScoredCriterion[] = [];
  const abstained: string[] = [];
  const criticalBreaches: string[] = [];
  const dimPoints = new Map<string, number>();
  const dimWeights = new Map<string, number>();
  let presentationPoints = 0;
  let presentationWeight = 0;
  let weightUsed = 0;
  let weightAbstained = 0;

  for (const [key, criterion] of declared) {
    const entry = seen.get(key)!;
    const band = assertBand(entry.band, key);
    const atomic = isAtomicCriterion(criterion) ? criterion : null;
    const dimension = atomic?.dimension ?? null;
    const points = band === null ? null : bandToPoints(band);

    perCriterion.push({
      criterion: key,
      kind: atomic?.kind,
      dimension,
      weight: criterion.weight,
      band,
      points,
      evidence: entry.evidence,
    });

    if (atomic?.kind === 'critical' && band !== null && band < criticalSatisfied) {
      criticalBreaches.push(key);
    }

    if (band === null || points === null) {
      abstained.push(key);
      weightAbstained += criterion.weight;
      continue;
    }

    if (isPresentation(dimension, presentationDimensions)) {
      presentationPoints += points * criterion.weight;
      presentationWeight += criterion.weight;
      continue;
    }

    const bucket = dimension ?? UNDIMENSIONED;
    dimPoints.set(bucket, (dimPoints.get(bucket) ?? 0) + points * criterion.weight);
    dimWeights.set(bucket, (dimWeights.get(bucket) ?? 0) + criterion.weight);
    weightUsed += criterion.weight;
  }

  if (weightUsed <= 0) {
    // Not 0, and certainly not 100. No content criterion was scored, so there
    // is no score — the cascade must escalate rather than publish a number
    // nobody produced.
    throw new DimensionScoringError(
      'every content criterion abstained; there is no denominator, so the item must escalate rather than score',
    );
  }

  const byDimension: Record<string, number> = {};
  const dimensionWeights: Record<string, number> = {};
  for (const [bucket, weight] of dimWeights) {
    byDimension[bucket] = dimPoints.get(bucket)! / weight;
    dimensionWeights[bucket] = weight;
  }

  return {
    // Grouping by dimension and then weighting by summed criterion weight is
    // arithmetically identical to a flat weighted mean over criteria. It is
    // written this way so a dimension-scoped cap (M2.2's context cap) has
    // something to bind to; see capDimensions.
    score: sumWeighted(byDimension, dimensionWeights),
    perCriterion,
    abstained,
    weightUsed,
    weightAbstained,
    byDimension: Object.freeze(byDimension),
    dimensionWeights: Object.freeze(dimensionWeights),
    presentation:
      presentationWeight > 0
        ? { score: presentationPoints / presentationWeight, weight: presentationWeight }
        : null,
    criticalBreaches,
    appliedDimensionCeilings: Object.freeze({}),
  };
}

function sumWeighted(
  scores: Readonly<Record<string, number>>,
  weights: Readonly<Record<string, number>>,
): number {
  let total = 0;
  let weight = 0;
  for (const [key, value] of Object.entries(scores)) {
    const w = weights[key] ?? 0;
    total += value * w;
    weight += w;
  }
  return weight > 0 ? total / weight : 0;
}

/**
 * Enforce dimension-scoped ceilings (M2.2's context cap) and recombine.
 *
 * Runs before the task-scope caps, because lowering a dimension changes the
 * weighted total the task caps are then applied to. Ceilings naming a dimension
 * the item does not score are ignored on purpose: a context cap on an item with
 * no context criteria has nothing to bind to, and inventing a bucket for it
 * would let a cap *create* weight that no author declared.
 */
export function capDimensions(
  result: DimensionResult,
  ceilings: Readonly<Record<string, number>>,
): DimensionResult {
  const entries = Object.entries(ceilings ?? {});
  if (entries.length === 0) return result;

  const byDimension: Record<string, number> = { ...result.byDimension };
  const enforced: Record<string, number> = {};
  for (const [dimension, ceiling] of entries) {
    if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling < 0 || ceiling > 100) {
      throw new DimensionScoringError(
        `ceiling for dimension ${JSON.stringify(dimension)} is ${String(ceiling)}; expected 0–100`,
      );
    }
    const current = byDimension[dimension];
    if (current === undefined) continue;
    enforced[dimension] = ceiling;
    if (current > ceiling) byDimension[dimension] = ceiling;
  }

  return {
    ...result,
    score: sumWeighted(byDimension, result.dimensionWeights),
    byDimension: Object.freeze(byDimension),
    appliedDimensionCeilings: Object.freeze({ ...result.appliedDimensionCeilings, ...enforced }),
  };
}

/** `critical` criteria a seat did not put at the satisfied band. */
export function criticalCriterionBreaches(
  criteria: readonly DimensionCriterion[],
  bands: readonly CriterionBand[],
  options: CombineOptions = {},
): string[] {
  return combineDimensions(criteria, bands, options).criticalBreaches;
}

export interface DimensionSeat {
  judge: string;
  bands: readonly CriterionBand[];
  /**
   * The seat's own 0–1 confidence. Optional in the type only so a malformed
   * ballot can reach the router, which fails closed on it; do not read absence
   * as certainty.
   */
  confidence?: number;
}

export interface DimensionPanelResult {
  /** Mean of the seat scores. Unweighted — M2.5 makes majority the primary. */
  score: number;
  seats: { judge: string; score: number; result: DimensionResult; confidence?: number }[];
  /** Largest absolute gap between any two seats, in points. */
  disagreement: number;
  /** Union of every seat's critical breaches. One seat seeing it is enough. */
  criticalBreaches: string[];
}

/** Score each seat independently, then report the spread rather than hiding it. */
export function combineDimensionPanel(
  criteria: readonly DimensionCriterion[],
  seats: readonly DimensionSeat[],
  options: CombineOptions = {},
): DimensionPanelResult {
  if (!Array.isArray(seats) || seats.length === 0) {
    throw new DimensionScoringError('a dimension panel needs at least one seat');
  }
  const scored = seats.map((seat) => {
    const result = combineDimensions(criteria, seat.bands, options);
    return { judge: seat.judge, score: result.score, result, confidence: seat.confidence };
  });
  const values = scored.map((s) => s.score);
  const breaches = new Set<string>();
  for (const seat of scored) for (const key of seat.result.criticalBreaches) breaches.add(key);
  return {
    score: values.reduce((a, b) => a + b, 0) / values.length,
    seats: scored,
    disagreement: Math.max(...values) - Math.min(...values),
    criticalBreaches: [...breaches],
  };
}
