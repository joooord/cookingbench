/**
 * M2.7 / M2.8 — the statistics that decide whether a jury is fit to score.
 *
 * Two things this file is emphatic about, because the plan is:
 *
 * 1. **The numbers in M2.8 are provisional CookingBench release criteria, not
 *    scientific constants inherited from another benchmark.** Nothing in this
 *    module hardcodes them into a decision. `evaluateReleaseCriteria` takes the
 *    criteria as data and has no built-in fallback; the M2.8 list is available
 *    only through `provisionalM28Criteria(acknowledgement)`, which makes every
 *    call site type out that it knows the thresholds are unconfirmed. Stage 4
 *    must confirm their sample size, confidence intervals and feasibility
 *    before the sealed holdout is opened, and until it has, a "pass" here is a
 *    dry run.
 *
 * 2. **Alpha measures reliability, not truth.** A panel of three seats that
 *    reliably give the same wrong answer scores alpha 1.0. Agreement statistics
 *    supplement error against expert/adjudicated decisions, dimension distance,
 *    macro-F1, coverage, safety recall, false acceptance and position
 *    invariance — they never replace them. Every function here that reports an
 *    agreement coefficient is paired with one that reports error against gold,
 *    and the release evaluator refuses a verdict when the error measurements
 *    are absent (`not-measured` is never a pass).
 *
 * Everything is pure: no I/O, no model calls, no clock, no unseeded randomness.
 * Given the same fixture the same numbers come out, which is the only reason a
 * committed judge-validation report means anything.
 *
 * **The human labels are not ours to create.** Gate 2 requires JudgeBench gold
 * to come from independent qualified humans rather than model consensus. This
 * module builds the machinery and the fixture format; `judgeBenchLabelSetSchema`
 * refuses a label set whose provenance is `model`, so real labels drop straight
 * in and generated ones do not.
 *
 * Two conventions run through the whole file and are load-bearing:
 *
 * - **Canonicalise A/B to candidate identity before agreement analysis.** A
 *   ballot says "the first answer shown was better"; agreement between seats is
 *   only meaningful once that is rewritten as "candidate A was better".
 *   `canonicaliseOutcome` in graders/pairwise.ts does it and every entry point
 *   here goes through it.
 * - **`abstain` is missing; `both_unacceptable` is a separate absolute
 *   outcome.** Never a tie, either of them. Alpha is used precisely *because*
 *   it handles missing ratings, which the seat-rotation design produces by
 *   construction — MAE over complete cases would silently drop them.
 */
import { z } from 'zod';
import {
  canonicaliseOutcome,
  foldRaterUnit,
  PAIRWISE_OUTCOME_CLASS,
  type PairwiseBallot,
  type PairwiseOutcome,
  type PairwisePresentation,
  type RaterUnit,
} from './graders/pairwise.js';

export class AgreementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgreementError';
  }
}

/**
 * Runtime array guard that does not poison the caller's types.
 *
 * `if (!Array.isArray(xs)) throw` looks like the obvious defensive check and is
 * a trap on a `readonly T[]` parameter: the predicate is `arg is any[]`, so the
 * *surviving* branch narrows `xs` to `any[]` and every inference after it —
 * `for (const x of xs)`, `xs.filter((y) => ...)` — silently becomes `any`. The
 * guard written to make the function safer is what switches the type checker
 * off. Taking the value as `unknown` keeps the narrowing away from the caller's
 * binding. (This is not hypothetical: it cost three `noImplicitAny` errors in
 * this file before it was understood.)
 */
function assertArray(value: unknown, message: string): void {
  if (!Array.isArray(value)) throw new AgreementError(message);
}

/**
 * Key for a map keyed by two ids.
 *
 * The separator is NUL rather than a space or a colon because ids are free
 * text. With a space, unit `"a b"` + rater `"c"` and unit `"a"` + rater `"b c"`
 * collapse to the same key — and every duplicate guard in this file is built on
 * these keys, so the collision would either reject two legitimate rows or,
 * worse, let a genuine duplicate through.
 */
function compositeKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

/* -------------------------------------------------------------------------- */
/* seeded randomness                                                          */
/* -------------------------------------------------------------------------- */

/** Same deterministic PRNG family taste.ts and the precision CIs use. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a, the same hash the judge seat-drop uses, so seeds stay reproducible. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Derive a per-statistic seed rather than sharing one stream.
 *
 * `analyze.ts` learned this the expensive way: with a shared stream a pair's
 * p-value depends on how many pairs were drawn before it, so the same
 * comparison read 0.951 in one report and 0.937 in another. Seeding each scope
 * independently makes every interval here reproducible on its own.
 */
function seedFor(seed: number | string | undefined, scope: string): number {
  const base = seed === undefined ? 'cookingbench' : String(seed);
  return fnv1a(`${base}:${scope}`);
}

/* -------------------------------------------------------------------------- */
/* the label fixture — how real human labels drop in                          */
/* -------------------------------------------------------------------------- */

export const LABEL_PROVENANCES = [
  /** an independent qualified human rated it directly */
  'human-expert',
  /** an adjudication panel resolved it under the M2.6 workflow */
  'human-adjudicated',
  /** a genuinely objective key (a measured temperature, a validator verdict) */
  'objective-key',
  /** a model produced it. Never gold. Present so panel output can be labelled. */
  'model',
] as const;
export type LabelProvenance = (typeof LABEL_PROVENANCES)[number];
export const labelProvenanceSchema = z.enum(LABEL_PROVENANCES);

/** The provenances Gate 2 accepts as gold. `model` is deliberately absent. */
export const GOLD_PROVENANCES: readonly LabelProvenance[] = Object.freeze([
  'human-expert',
  'human-adjudicated',
  'objective-key',
]);

/**
 * A rating value. Numbers for anchored 0–4 dimension bands, strings for
 * canonicalised pairwise outcomes and accept/reject decisions.
 *
 * `null` is not a value. It is missingness — the seat was not assigned this
 * case, or abstained. Nothing in this file converts it to a middling score.
 */
export type RatingValue = number | string;

export const judgeBenchLabelSchema = z.object({
  /** The case (unit of analysis). Candidate A/B identity is fixed by this id. */
  case: z.string().min(1),
  /** The person. Clustered intervals cluster on this for human raters. */
  rater: z.string().min(1),
  /** `null` = declined to rate. Missing data, never a middle band. */
  value: z.union([z.number(), z.string().min(1), z.null()]),
  /** Scenario family — the cluster for item-level intervals. */
  family: z.string().min(1).optional(),
  /** Primary stratum, for the per-stratum floors. */
  stratum: z.string().min(1).optional(),
  /** Whether this case belongs to the critical safety set. */
  critical: z.boolean().optional(),
  provenance: labelProvenanceSchema,
  /** Ballot-minutes. M2.7 asks for reported ballot-hours; this is the input. */
  minutesSpent: z.number().nonnegative().optional(),
});
export type JudgeBenchLabel = z.infer<typeof judgeBenchLabelSchema>;

/**
 * A tranche of human labels.
 *
 * The refinements are the whole point of having a schema at all — they are the
 * checks that a hand-assembled label file will fail on first import rather than
 * three statistics downstream, where a missing preregistration id or a set with
 * one rater looks like a merely disappointing alpha.
 */
export const judgeBenchLabelSetSchema = z
  .object({
    version: z.literal(1),
    /** Development and sealed material stay separate. M2.7 is explicit. */
    tranche: z.enum(['development', 'sealed-holdout']),
    /** Frozen before holdout access. Recorded so nobody can claim so later. */
    preregistration: z.string().min(1).optional(),
    labels: z.array(judgeBenchLabelSchema).min(1),
  })
  .superRefine((set, ctx) => {
    const raters = new Set(set.labels.map((l) => l.rater));
    if (raters.size < 2) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['labels'],
        message: `a label set needs at least two raters to support any agreement statistic; got ${raters.size}`,
      });
    }
    const seen = new Set<string>();
    for (const [i, label] of set.labels.entries()) {
      const key = compositeKey(label.case, label.rater);
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['labels', i],
          // A rater's second pass on the same case is a repeat-judgement
          // observation, and folding it in here would count one person twice in
          // the coincidence matrix and inflate alpha.
          message: `rater ${label.rater} labelled case ${label.case} twice; re-scored replicates belong in the repeat-judgement fixture, not the reliability matrix`,
        });
      }
      seen.add(key);
      if (!GOLD_PROVENANCES.includes(label.provenance)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['labels', i, 'provenance'],
          message:
            'gold labels come from independent qualified humans or an objective key, never from model consensus (Gate 2)',
        });
      }
    }
    if (set.tranche === 'sealed-holdout' && !set.preregistration) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['preregistration'],
        message:
          'a sealed holdout must name the preregistration frozen before it was opened; without one the criteria cannot be shown to predate the result',
      });
    }
  });
export type JudgeBenchLabelSet = z.infer<typeof judgeBenchLabelSetSchema>;

/** Parse a label file, throwing with every fault at once. */
export function parseJudgeBenchLabels(value: unknown): JudgeBenchLabelSet {
  const parsed = judgeBenchLabelSetSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new AgreementError(`invalid JudgeBench label set:\n- ${issues.join('\n- ')}`);
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Krippendorff's alpha                                                       */
/* -------------------------------------------------------------------------- */

export interface AgreementRating {
  /** The case. Two ratings of the same unit are what "agreement" compares. */
  unit: string;
  /** Human rater id or judge seat id. */
  rater: string;
  /** `null`/`undefined` = missing. Abstain arrives here as `null`. */
  value?: RatingValue | null;
  /** Scenario family, for clustering item-level intervals. */
  family?: string;
}

export type AlphaMetric = 'nominal' | 'ordinal' | 'interval' | 'custom';

export interface AlphaOptions {
  metric: AlphaMetric;
  /**
   * The ordered level domain. **Required for `ordinal`** — an ordinal
   * coefficient without a declared ordering is guesswork, and deriving the
   * order from whatever happened to be observed silently changes the metric
   * when a band goes unused. Optional elsewhere; when given, a value outside it
   * is refused rather than quietly admitted as a new level.
   */
  domain?: readonly RatingValue[];
  /**
   * Squared distance between two levels. Required for `custom`, forbidden
   * otherwise. Checked for `d(x,x) === 0` and symmetry over the observed levels
   * — a mis-specified distance produces a plausible-looking number rather than
   * an error, which is the worst failure mode available here.
   */
  distance?: (a: RatingValue, b: RatingValue) => number;
}

export interface AlphaResult {
  /**
   * `null` when the coefficient is undefined, never a convenient 1.0.
   *
   * The degenerate case matters in practice: if every seat gave every case the
   * same band, expected disagreement is 0 and alpha is 0/0. Reporting 1.0 there
   * would say "perfect reliability" about a matrix that contains no information
   * at all, and on a saturated item bank that is exactly the matrix you get.
   */
  alpha: number | null;
  metric: AlphaMetric;
  observedDisagreement: number | null;
  expectedDisagreement: number | null;
  /** Units with at least two ratings — the only ones that carry information. */
  pairableUnits: number;
  /** Units dropped for having one rating. Reported, never silently swallowed. */
  singlyRatedUnits: number;
  /** Units dropped for having no ratings at all. */
  unratedUnits: number;
  /** Σ of ratings over pairable units (Krippendorff's n). */
  pairableValues: number;
  raters: number;
  /** Levels actually observed, in domain order when a domain was declared. */
  levels: RatingValue[];
  degenerate: 'no-variation' | 'no-pairable-units' | null;
}

function compareLevels(a: RatingValue, b: RatingValue): number {
  const ta = typeof a;
  const tb = typeof b;
  if (ta !== tb) return ta === 'number' ? -1 : 1;
  if (ta === 'number') return (a as number) - (b as number);
  return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
}

function assertRatings(ratings: readonly AgreementRating[]): void {
  assertArray(ratings, 'ratings must be an array');
  const seen = new Set<string>();
  for (const [i, r] of ratings.entries()) {
    if (!r || typeof r !== 'object') {
      throw new AgreementError(`rating ${i} is not an object`);
    }
    if (typeof r.unit !== 'string' || r.unit.length === 0) {
      throw new AgreementError(`rating ${i} has no unit id`);
    }
    if (typeof r.rater !== 'string' || r.rater.length === 0) {
      throw new AgreementError(`rating ${i} has no rater id`);
    }
    if (r.value !== null && r.value !== undefined) {
      const t = typeof r.value;
      if (t !== 'number' && t !== 'string') {
        throw new AgreementError(
          `rating ${i} (unit ${r.unit}, rater ${r.rater}) has a ${t} value; expected number, string or null`,
        );
      }
      if (t === 'number' && !Number.isFinite(r.value as number)) {
        throw new AgreementError(
          `rating ${i} (unit ${r.unit}, rater ${r.rater}) has a non-finite value`,
        );
      }
    }
    const key = compositeKey(r.unit, r.rater);
    if (seen.has(key)) {
      // Not a stylistic objection: the same rater appearing twice in one unit
      // contributes a guaranteed-agreeing pair to the coincidence matrix.
      throw new AgreementError(
        `rater ${r.rater} appears twice for unit ${r.unit}; fold a judge's presentations into one rater unit first (M2.5) and put re-scored replicates in the repeat fixture`,
      );
    }
    seen.add(key);
  }
}

/**
 * Krippendorff's alpha with the full missing-data treatment.
 *
 * The seat rotation produces missing ratings *by design* — a balanced
 * incomplete-block assignment means no seat sees every case — so a coefficient
 * that needs a complete matrix is not merely inconvenient, it is unusable.
 * Alpha handles it natively: units with fewer than two ratings carry no pairable
 * information and drop out; everything else is weighted by 1/(m_u − 1) so a unit
 * rated by five seats does not outvote one rated by two.
 */
export function krippendorffAlpha(
  ratings: readonly AgreementRating[],
  options: AlphaOptions,
): AlphaResult {
  assertRatings(ratings);
  if (!options || typeof options !== 'object') {
    throw new AgreementError('alpha needs an options object naming the metric');
  }
  const { metric } = options;
  if (metric !== 'nominal' && metric !== 'ordinal' && metric !== 'interval' && metric !== 'custom') {
    throw new AgreementError(
      `unknown alpha metric ${JSON.stringify(metric)}; expected nominal, ordinal, interval or custom`,
    );
  }
  if (metric === 'custom' && typeof options.distance !== 'function') {
    throw new AgreementError('metric "custom" needs a distance function');
  }
  if (metric !== 'custom' && options.distance !== undefined) {
    throw new AgreementError(
      `a distance function was supplied with metric "${metric}"; it would be ignored, so it is refused instead`,
    );
  }
  if (metric === 'ordinal' && (!options.domain || options.domain.length === 0)) {
    throw new AgreementError(
      'ordinal alpha needs an explicit ordered domain (e.g. [0,1,2,3,4] for the M2.3 anchors); inferring the order from observed values changes the metric whenever a band goes unused',
    );
  }

  // ---- assemble the reliability matrix -----------------------------------
  const byUnit = new Map<string, RatingValue[]>();
  const raters = new Set<string>();
  const observed = new Set<RatingValue>();
  for (const r of ratings) {
    raters.add(r.rater);
    let bucket = byUnit.get(r.unit);
    if (!bucket) byUnit.set(r.unit, (bucket = []));
    if (r.value === null || r.value === undefined) continue;
    bucket.push(r.value);
    observed.add(r.value);
  }

  if (options.domain) {
    const declared = new Set<RatingValue>(options.domain);
    for (const v of observed) {
      if (!declared.has(v)) {
        throw new AgreementError(
          `value ${JSON.stringify(v)} is outside the declared domain [${options.domain
            .map((d) => JSON.stringify(d))
            .join(', ')}]`,
        );
      }
    }
  }
  if (metric === 'interval') {
    for (const v of observed) {
      if (typeof v !== 'number') {
        throw new AgreementError(
          `interval alpha needs numeric values; got ${JSON.stringify(v)}`,
        );
      }
    }
  }

  // Level order: the declared domain where there is one (so unobserved bands
  // still sit in the right place), otherwise a deterministic sort. Unobserved
  // levels have marginal 0 and change neither Do nor De, but they keep the
  // ordinal cumulative sums honest and the reported `levels` stable.
  const levels = options.domain
    ? options.domain.filter((d) => observed.has(d))
    : [...observed].sort(compareLevels);
  const levelIndex = new Map<RatingValue, number>();
  levels.forEach((v, i) => levelIndex.set(v, i));

  let pairableUnits = 0;
  let singlyRatedUnits = 0;
  let unratedUnits = 0;
  const L = levels.length;
  const coincidence: number[][] = Array.from({ length: L }, () => new Array<number>(L).fill(0));

  for (const values of byUnit.values()) {
    const m = values.length;
    if (m === 0) {
      unratedUnits += 1;
      continue;
    }
    if (m === 1) {
      singlyRatedUnits += 1;
      continue;
    }
    pairableUnits += 1;
    const counts = new Map<number, number>();
    for (const v of values) {
      const i = levelIndex.get(v)!;
      counts.set(i, (counts.get(i) ?? 0) + 1);
    }
    for (const [i, ci] of counts) {
      for (const [j, cj] of counts) {
        coincidence[i]![j]! += i === j ? (ci * (ci - 1)) / (m - 1) : (ci * cj) / (m - 1);
      }
    }
  }

  const base: Omit<AlphaResult, 'alpha' | 'observedDisagreement' | 'expectedDisagreement' | 'degenerate'> =
    {
      metric,
      pairableUnits,
      singlyRatedUnits,
      unratedUnits,
      pairableValues: 0,
      raters: raters.size,
      levels,
    };

  if (pairableUnits === 0) {
    return {
      ...base,
      alpha: null,
      observedDisagreement: null,
      expectedDisagreement: null,
      degenerate: 'no-pairable-units',
    };
  }

  const marginals = levels.map((_, i) => coincidence[i]!.reduce((a, b) => a + b, 0));
  const n = marginals.reduce((a, b) => a + b, 0);

  // ---- the distance matrix ------------------------------------------------
  // Ordinal distance depends on the marginals, so it can only be built now.
  const delta: number[][] = Array.from({ length: L }, () => new Array<number>(L).fill(0));
  for (let i = 0; i < L; i++) {
    for (let j = 0; j < L; j++) {
      if (i === j) continue;
      let d: number;
      switch (metric) {
        case 'nominal':
          d = 1;
          break;
        case 'interval':
          d = ((levels[i] as number) - (levels[j] as number)) ** 2;
          break;
        case 'ordinal': {
          // δ²(c,k) = ( Σ_{g=c..k} n_g − (n_c + n_k)/2 )²
          const lo = Math.min(i, j);
          const hi = Math.max(i, j);
          let sum = 0;
          for (let g = lo; g <= hi; g++) sum += marginals[g]!;
          const corrected = sum - (marginals[lo]! + marginals[hi]!) / 2;
          d = corrected ** 2;
          break;
        }
        case 'custom':
          d = options.distance!(levels[i]!, levels[j]!);
          break;
      }
      if (!Number.isFinite(d) || d < 0) {
        throw new AgreementError(
          `distance between ${JSON.stringify(levels[i])} and ${JSON.stringify(levels[j])} is ${d}; a squared distance must be finite and non-negative`,
        );
      }
      delta[i]![j] = d;
    }
  }
  if (metric === 'custom') {
    for (let i = 0; i < L; i++) {
      if (options.distance!(levels[i]!, levels[i]!) !== 0) {
        throw new AgreementError(
          `custom distance is non-zero between ${JSON.stringify(levels[i])} and itself`,
        );
      }
      for (let j = i + 1; j < L; j++) {
        if (Math.abs(delta[i]![j]! - delta[j]![i]!) > 1e-12) {
          throw new AgreementError(
            `custom distance is asymmetric between ${JSON.stringify(levels[i])} and ${JSON.stringify(levels[j])}`,
          );
        }
      }
    }
  }

  // ---- disagreements ------------------------------------------------------
  let observedDisagreement = 0;
  let expectedSum = 0;
  for (let i = 0; i < L; i++) {
    for (let j = 0; j < L; j++) {
      observedDisagreement += coincidence[i]![j]! * delta[i]![j]!;
      expectedSum += marginals[i]! * marginals[j]! * delta[i]![j]!;
    }
  }
  const Do = observedDisagreement / n;
  const De = expectedSum / (n * (n - 1));

  if (De === 0) {
    return {
      ...base,
      pairableValues: n,
      alpha: null,
      observedDisagreement: Do,
      expectedDisagreement: De,
      degenerate: 'no-variation',
    };
  }

  return {
    ...base,
    pairableValues: n,
    alpha: 1 - Do / De,
    observedDisagreement: Do,
    expectedDisagreement: De,
    degenerate: null,
  };
}

/* -------------------------------------------------------------------------- */
/* clustered bootstrap                                                        */
/* -------------------------------------------------------------------------- */

export interface BootstrapInterval {
  /** The statistic on the original data, not the bootstrap mean. */
  point: number | null;
  ci95: [number, number] | null;
  resamples: number;
  /** Resamples on which the statistic was computable. */
  usable: number;
  clusters: number;
  /** Why a CI is absent, when it is. Never left to be inferred from `null`. */
  refusal: string | null;
}

export interface ClusteredBootstrapOptions<Row> {
  /** The independence unit: the person for human raters, the family for items. */
  clusterOf: (row: Row) => string;
  /**
   * Rewrite a row belonging to the `replicate`-th draw of its cluster.
   *
   * Required, and not defaulted to identity, because getting it wrong is
   * invisible. When the statistic groups rows by an id the cluster shares —
   * alpha groups by unit, and a family cluster contains several units — drawing
   * a cluster twice must produce *two* units, not one unit with double the
   * ratings. Silently merging them turns a resample into a claim that two seats
   * rated the same case when they rated two copies of it, and alpha climbs.
   * For a plain rate over independent rows, `(row) => row` is correct and says
   * so at the call site.
   */
  relabel: (row: Row, replicate: number) => Row;
  /** `null` marks a resample the statistic could not be computed on. */
  statistic: (rows: Row[]) => number | null;
  resamples?: number;
  seed?: number | string;
  /** Names the bootstrap's own PRNG stream, so statistics do not share one. */
  scope?: string;
  /** Share of resamples that must be usable before a CI is reported. */
  minUsableShare?: number;
  /** Clusters below this refuse a CI outright rather than reporting a fiction. */
  minClusters?: number;
}

/**
 * Percentile bootstrap over whole clusters.
 *
 * Resampling rows would treat one adjudicator's forty ballots as forty
 * independent observations and shrink every interval by roughly √40. M2.7 is
 * explicit that clustering by person has to be accounted for; the same applies
 * to scenario families, where four items sharing a brief share their errors.
 */
export function clusteredBootstrap<Row>(
  rows: readonly Row[],
  options: ClusteredBootstrapOptions<Row>,
): BootstrapInterval {
  assertArray(rows, 'rows must be an array');
  if (typeof options?.clusterOf !== 'function') {
    throw new AgreementError('clusteredBootstrap needs a clusterOf function');
  }
  if (typeof options.relabel !== 'function') {
    throw new AgreementError(
      'clusteredBootstrap needs a relabel function; pass (row) => row only when duplicate cluster draws are genuinely independent for this statistic',
    );
  }
  if (typeof options.statistic !== 'function') {
    throw new AgreementError('clusteredBootstrap needs a statistic function');
  }

  const grouped = new Map<string, Row[]>();
  for (const row of rows) {
    const key = options.clusterOf(row);
    if (typeof key !== 'string' || key.length === 0) {
      throw new AgreementError('clusterOf returned an empty cluster key');
    }
    let bucket = grouped.get(key);
    if (!bucket) grouped.set(key, (bucket = []));
    bucket.push(row);
  }
  const clusters = [...grouped.values()];
  const point = rows.length > 0 ? options.statistic([...rows]) : null;
  const resamples = options.resamples ?? 2000;
  const minClusters = options.minClusters ?? 3;

  const empty: BootstrapInterval = {
    point,
    ci95: null,
    resamples: 0,
    usable: 0,
    clusters: clusters.length,
    refusal: null,
  };
  if (clusters.length < minClusters) {
    return {
      ...empty,
      refusal: `only ${clusters.length} cluster(s); a percentile interval over fewer than ${minClusters} is a fiction`,
    };
  }
  if (resamples <= 0) return { ...empty, refusal: 'bootstrap disabled (resamples <= 0)' };

  const rand = mulberry32(seedFor(options.seed, options.scope ?? 'bootstrap'));
  const samples: number[] = [];
  for (let r = 0; r < resamples; r++) {
    const drawn: Row[] = [];
    // Track how many times each cluster has been drawn so the relabeller can
    // keep the copies apart.
    const drawCount = new Map<number, number>();
    for (let c = 0; c < clusters.length; c++) {
      const pick = Math.floor(rand() * clusters.length);
      const replicate = (drawCount.get(pick) ?? 0) + 1;
      drawCount.set(pick, replicate);
      for (const row of clusters[pick]!) drawn.push(options.relabel(row, replicate));
    }
    const value = options.statistic(drawn);
    if (value !== null && Number.isFinite(value)) samples.push(value);
  }

  const minUsable = (options.minUsableShare ?? 0.8) * resamples;
  if (samples.length < minUsable) {
    return {
      point,
      ci95: null,
      resamples,
      usable: samples.length,
      clusters: clusters.length,
      refusal: `only ${samples.length} of ${resamples} resamples produced a computable statistic`,
    };
  }
  samples.sort((a, b) => a - b);
  const lo = samples[Math.floor(samples.length * 0.025)]!;
  const hi = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.975))]!;
  return {
    point,
    ci95: [lo, hi],
    resamples,
    usable: samples.length,
    clusters: clusters.length,
    refusal: null,
  };
}

export interface BootstrapAlphaOptions extends AlphaOptions {
  /**
   * `rater` clusters by person (M2.7's clustering-by-person requirement);
   * `family` clusters by scenario family; `unit` clusters by case.
   */
  clusterBy: 'rater' | 'family' | 'unit';
  resamples?: number;
  seed?: number | string;
  scope?: string;
  minClusters?: number;
  minUsableShare?: number;
}

/** Clustered bootstrap interval for alpha. */
export function bootstrapAlpha(
  ratings: readonly AgreementRating[],
  options: BootstrapAlphaOptions,
): BootstrapInterval {
  assertRatings(ratings);
  const { clusterBy } = options;
  if (clusterBy !== 'rater' && clusterBy !== 'family' && clusterBy !== 'unit') {
    throw new AgreementError(
      `unknown clusterBy ${JSON.stringify(clusterBy)}; expected rater, family or unit`,
    );
  }
  if (clusterBy === 'family') {
    for (const r of ratings) {
      if (!r.family) {
        throw new AgreementError(
          `clustering by scenario family needs every rating to declare one; unit ${r.unit} does not`,
        );
      }
    }
  }
  const alphaOptions: AlphaOptions = {
    metric: options.metric,
    ...(options.domain ? { domain: options.domain } : {}),
    ...(options.distance ? { distance: options.distance } : {}),
  };
  return clusteredBootstrap<AgreementRating>(ratings, {
    clusterOf: (r) => (clusterBy === 'rater' ? r.rater : clusterBy === 'family' ? r.family! : r.unit),
    // Re-drawing a rater must produce a *second seat*, and re-drawing a family
    // must produce *second copies of its cases*. Without this the duplicate
    // collapses into the original and manufactures perfect agreement.
    relabel: (r, replicate) =>
      replicate === 1
        ? r
        : clusterBy === 'rater'
          ? { ...r, rater: `${r.rater}#${replicate}` }
          : { ...r, unit: `${r.unit}#${replicate}` },
    statistic: (rows) => krippendorffAlpha(rows, alphaOptions).alpha,
    resamples: options.resamples,
    seed: options.seed,
    scope: options.scope ?? `alpha:${options.metric}:${clusterBy}`,
    minClusters: options.minClusters,
    minUsableShare: options.minUsableShare,
  });
}

/* -------------------------------------------------------------------------- */
/* canonicalised pairwise ballots                                             */
/* -------------------------------------------------------------------------- */

/**
 * The level domain for pairwise agreement. `abstain` is absent because it is
 * missingness, and `both_unacceptable` is present because it is an outcome.
 */
export const PAIRWISE_AGREEMENT_DOMAIN: readonly PairwiseOutcome[] = Object.freeze([
  'a',
  'b',
  'equal',
  'both_unacceptable',
]);

/**
 * Refuse a custom pairwise distance that treats `both_unacceptable` as a tie.
 *
 * A distance of 0 between `equal` and `both_unacceptable` is the collapse M2.8
 * forbids, dressed up as a metric: it makes "these two dishes are equally good"
 * and "neither should be served" the same judgement for every agreement
 * statistic downstream. The check is cheap and the mistake is invisible.
 */
export function assertPairwiseDistance(
  distance: (a: RatingValue, b: RatingValue) => number,
): void {
  if (typeof distance !== 'function') {
    throw new AgreementError('a pairwise distance must be a function');
  }
  if (distance('equal', 'both_unacceptable') === 0) {
    throw new AgreementError(
      'distance from "equal" to "both_unacceptable" is 0; both-unacceptable is a separate absolute outcome, never a tie (M2.8)',
    );
  }
  for (const level of PAIRWISE_AGREEMENT_DOMAIN) {
    if (distance(level, level) !== 0) {
      throw new AgreementError(`distance from "${level}" to itself is not 0`);
    }
  }
}

/** One ballot exactly as a judge produced it, before canonicalisation. */
export interface AuditBallot {
  /** The pair being judged. Candidate A and B identity is fixed by this id. */
  unit: string;
  family?: string;
  judge: string;
  presentation: PairwisePresentation;
  /** As written: `a` means "the answer shown first", not candidate A. */
  outcome: PairwiseOutcome;
}

export interface FoldedPairwise {
  ratings: AgreementRating[];
  /** Rater units whose two presentations disagreed after canonicalisation. */
  unstable: number;
  /** Rater units whose stable outcome was `abstain` — treated as missing. */
  abstained: number;
  units: number;
}

function assertAuditBallots(ballots: readonly AuditBallot[]): void {
  assertArray(ballots, 'ballots must be an array');
  for (const [i, b] of ballots.entries()) {
    if (!b || typeof b !== 'object') throw new AgreementError(`ballot ${i} is not an object`);
    if (typeof b.unit !== 'string' || !b.unit) throw new AgreementError(`ballot ${i} has no unit`);
    if (typeof b.judge !== 'string' || !b.judge) throw new AgreementError(`ballot ${i} has no judge`);
    if (b.presentation !== 'ab' && b.presentation !== 'ba') {
      throw new AgreementError(
        `ballot ${i} (unit ${b.unit}) has presentation ${JSON.stringify(b.presentation)}; expected 'ab' or 'ba'`,
      );
    }
    if (!(b.outcome in PAIRWISE_OUTCOME_CLASS)) {
      throw new AgreementError(
        `ballot ${i} (unit ${b.unit}) has unknown outcome ${JSON.stringify(b.outcome)}`,
      );
    }
  }
}

/** Group ballots into (unit, judge) rater units, preserving family. */
function foldAudit(ballots: readonly AuditBallot[]): {
  units: { unit: string; family?: string; raterUnit: RaterUnit }[];
} {
  assertAuditBallots(ballots);
  const groups = new Map<string, { unit: string; family?: string; ballots: PairwiseBallot[] }>();
  for (const b of ballots) {
    const key = compositeKey(b.unit, b.judge);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { unit: b.unit, family: b.family, ballots: [] }));
    if (g.family !== b.family) {
      throw new AgreementError(
        `unit ${b.unit} is declared in two different scenario families (${String(g.family)} and ${String(b.family)})`,
      );
    }
    g.ballots.push({ judge: b.judge, presentation: b.presentation, outcome: b.outcome });
  }
  const units: { unit: string; family?: string; raterUnit: RaterUnit }[] = [];
  for (const g of groups.values()) {
    let raterUnit: RaterUnit;
    try {
      raterUnit = foldRaterUnit(g.ballots);
    } catch (err) {
      throw new AgreementError(
        `unit ${g.unit}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    units.push({ unit: g.unit, family: g.family, raterUnit });
  }
  return { units };
}

/**
 * Canonicalise raw ballots into a reliability matrix.
 *
 * Three collapses are refused here, all of them M2.8's:
 * - position is removed first (`canonicaliseOutcome`), so agreement is about
 *   candidates and not about who was printed at the top of the page;
 * - `abstain` becomes `null` — missing, not a tie and not a zero;
 * - an order-unstable rater unit also becomes `null`. M2.5 makes a flip
 *   instability requiring escalation rather than two independent votes, so the
 *   unit contributes no rating at all. Picking one of the two presentations
 *   would be choosing the answer that flatters the panel.
 */
export function pairwiseRatingsForAgreement(ballots: readonly AuditBallot[]): FoldedPairwise {
  const { units } = foldAudit(ballots);
  const ratings: AgreementRating[] = [];
  let unstable = 0;
  let abstained = 0;
  for (const { unit, family, raterUnit } of units) {
    let value: RatingValue | null;
    if (raterUnit.orderUnstable || raterUnit.outcome === null) {
      unstable += 1;
      value = null;
    } else if (raterUnit.outcome === 'abstain') {
      abstained += 1;
      value = null;
    } else {
      value = raterUnit.outcome;
    }
    ratings.push({ unit, rater: raterUnit.judge, value, ...(family ? { family } : {}) });
  }
  return { ratings, unstable, abstained, units: units.length };
}

/* -------------------------------------------------------------------------- */
/* consensus, agreement against gold, macro-F1, strata                        */
/* -------------------------------------------------------------------------- */

export interface ConsensusResult {
  /** `null` when no single label held a strict plurality. */
  label: RatingValue | null;
  decisive: boolean;
  counts: { label: RatingValue; votes: number }[];
  /** Labels supplied, excluding the ones that were missing. */
  votes: number;
  missing: number;
}

/**
 * Majority label over human raters.
 *
 * A tie is *not* broken. Breaking it — by rater order, by lowest label, by a
 * seeded coin — invents a gold standard for exactly the cases where qualified
 * humans disagreed, which are the cases the panel is most likely to get wrong.
 * They belong in adjudication (M2.6), and here they are reported as
 * non-decisive and excluded.
 */
export function consensusLabel(
  labels: readonly { rater: string; label?: RatingValue | null }[],
): ConsensusResult {
  assertArray(labels, 'labels must be an array');
  const tally = new Map<RatingValue, number>();
  let missing = 0;
  const raters = new Set<string>();
  for (const l of labels) {
    if (!l || typeof l.rater !== 'string' || !l.rater) {
      throw new AgreementError('every label needs a rater id');
    }
    if (raters.has(l.rater)) {
      throw new AgreementError(`rater ${l.rater} supplied two labels for the same case`);
    }
    raters.add(l.rater);
    if (l.label === null || l.label === undefined) {
      missing += 1;
      continue;
    }
    tally.set(l.label, (tally.get(l.label) ?? 0) + 1);
  }
  const counts = [...tally.entries()]
    .map(([label, votes]) => ({ label, votes }))
    .sort((x, y) => y.votes - x.votes || compareLevels(x.label, y.label));
  const votes = counts.reduce((a, c) => a + c.votes, 0);
  if (counts.length === 0) {
    return { label: null, decisive: false, counts, votes, missing };
  }
  const top = counts[0]!;
  const decisive = counts.length === 1 || top.votes > counts[1]!.votes;
  return { label: decisive ? top.label : null, decisive, counts, votes, missing };
}

export interface Prediction {
  unit: string;
  family?: string;
  stratum?: string;
  critical?: boolean;
  gold: RatingValue;
  /** `null` = the panel produced no decision. Counted as a miss, and reported. */
  predicted?: RatingValue | null;
}

export interface AgreementRateResult {
  /** Percentage points, 0–100. */
  agreement: number;
  hits: number;
  n: number;
  /** Cases where the panel produced no decision at all. */
  unresolved: number;
  exact: ExactInterval;
}

function assertPredictions(preds: readonly Prediction[]): void {
  assertArray(preds, 'predictions must be an array');
  if (preds.length === 0) throw new AgreementError('no predictions supplied');
  const seen = new Set<string>();
  for (const [i, p] of preds.entries()) {
    if (!p || typeof p !== 'object') throw new AgreementError(`prediction ${i} is not an object`);
    if (typeof p.unit !== 'string' || !p.unit) throw new AgreementError(`prediction ${i} has no unit`);
    if (seen.has(p.unit)) throw new AgreementError(`unit ${p.unit} appears twice`);
    seen.add(p.unit);
    if (p.gold === null || p.gold === undefined) {
      throw new AgreementError(
        `unit ${p.unit} has no gold label; a case without adjudicated gold is not scored against gold, it is excluded upstream and reported`,
      );
    }
  }
}

/**
 * Agreement against gold.
 *
 * An absent prediction counts as a miss. The alternative — dropping it — lets a
 * panel improve its agreement by declining the hard cases, which is precisely
 * the behaviour the automation-coverage criterion exists to price.
 */
export function agreementRate(preds: readonly Prediction[]): AgreementRateResult {
  assertPredictions(preds);
  let hits = 0;
  let unresolved = 0;
  for (const p of preds) {
    if (p.predicted === null || p.predicted === undefined) {
      unresolved += 1;
      continue;
    }
    if (p.predicted === p.gold) hits += 1;
  }
  return {
    agreement: (hits / preds.length) * 100,
    hits,
    n: preds.length,
    unresolved,
    exact: clopperPearson(hits, preds.length),
  };
}

export interface ClassScore {
  label: RatingValue;
  precision: number;
  recall: number;
  f1: number;
  /** Gold cases carrying this label. */
  support: number;
  /** Predictions carrying this label. */
  predicted: number;
}

export interface MacroF1Result {
  macroF1: number;
  perClass: ClassScore[];
  unresolved: number;
  n: number;
}

/**
 * Macro-F1 over the union of gold and predicted labels.
 *
 * The union, not just the gold labels: a panel that invents a category not in
 * the gold set has made a real error, and scoring only the gold classes hides
 * it. That class has support 0 and precision 0, so it drags macro-F1 down — as
 * it should. Macro rather than micro because a rare critical class must not be
 * outvoted by a common benign one, which is the whole reason M2.8 asks for it
 * alongside plain agreement.
 */
export function macroF1(preds: readonly Prediction[]): MacroF1Result {
  assertPredictions(preds);
  const classes = new Set<RatingValue>();
  for (const p of preds) {
    classes.add(p.gold);
    if (p.predicted !== null && p.predicted !== undefined) classes.add(p.predicted);
  }
  const ordered = [...classes].sort(compareLevels);
  const perClass: ClassScore[] = [];
  let unresolved = 0;
  for (const p of preds) {
    if (p.predicted === null || p.predicted === undefined) unresolved += 1;
  }
  for (const label of ordered) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const p of preds) {
      const predicted = p.predicted === undefined ? null : p.predicted;
      const goldIs = p.gold === label;
      const predIs = predicted === label;
      if (goldIs && predIs) tp += 1;
      else if (!goldIs && predIs) fp += 1;
      // A null prediction is a false negative for the gold class and a false
      // positive for nothing — it costs recall without buying precision.
      else if (goldIs && !predIs) fn += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perClass.push({ label, precision, recall, f1, support: tp + fn, predicted: tp + fp });
  }
  const macro = perClass.reduce((a, c) => a + c.f1, 0) / perClass.length;
  return { macroF1: macro, perClass, unresolved, n: preds.length };
}

export interface StratumScore {
  stratum: string;
  agreement: number;
  n: number;
  hits: number;
  floor: number;
  /** `null` when the stratum is too small to test — never silently a pass. */
  pass: boolean | null;
  underpowered: boolean;
  exact: ExactInterval;
}

export interface StratumAgreementOptions {
  /** Per-stratum floors in percentage points. */
  floors?: Readonly<Record<string, number>>;
  /** Applied to any stratum without a named floor. */
  defaultFloor?: number;
  /** Strata smaller than this cannot pass; they report `pass: null`. */
  minimumPerStratum?: number;
}

export interface StratumAgreementResult {
  strata: StratumScore[];
  /** The worst agreement across strata — what the M2.8 floor is applied to. */
  lowestAgreement: number | null;
  lowestStratum: string | null;
  /** `false` if any stratum fails or is underpowered. Never `true` on doubt. */
  allPass: boolean;
  reasons: string[];
}

/**
 * Per-stratum agreement against declared floors.
 *
 * Underpowered strata report `pass: null` and make `allPass` false. "Three of
 * three correct in the shellfish-allergen stratum" is 100% agreement and no
 * evidence whatsoever; treating it as a pass is how a critical stratum gets
 * waved through on four observations.
 */
export function stratumAgreement(
  preds: readonly Prediction[],
  options: StratumAgreementOptions = {},
): StratumAgreementResult {
  assertPredictions(preds);
  const floors = options.floors ?? {};
  const minimumPerStratum = options.minimumPerStratum ?? 1;
  const buckets = new Map<string, Prediction[]>();
  for (const p of preds) {
    const stratum = p.stratum;
    if (!stratum) {
      throw new AgreementError(
        `unit ${p.unit} declares no stratum; per-stratum floors cannot be checked against an unlabelled case`,
      );
    }
    let bucket = buckets.get(stratum);
    if (!bucket) buckets.set(stratum, (bucket = []));
    bucket.push(p);
  }

  const reasons: string[] = [];
  const strata: StratumScore[] = [];
  for (const [stratum, rows] of [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const floor = floors[stratum] ?? options.defaultFloor;
    if (floor === undefined) {
      throw new AgreementError(
        `stratum ${stratum} has no declared floor and no defaultFloor was given; a floor that is chosen after seeing the result is not a floor`,
      );
    }
    const hits = rows.filter(
      (p) => p.predicted !== null && p.predicted !== undefined && p.predicted === p.gold,
    ).length;
    const agreement = (hits / rows.length) * 100;
    const underpowered = rows.length < minimumPerStratum;
    const pass = underpowered ? null : agreement >= floor;
    if (underpowered) {
      reasons.push(
        `stratum ${stratum} has ${rows.length} case(s), below the declared minimum of ${minimumPerStratum}`,
      );
    } else if (pass === false) {
      reasons.push(`stratum ${stratum} at ${agreement.toFixed(1)}% is below its floor of ${floor}%`);
    }
    strata.push({
      stratum,
      agreement,
      n: rows.length,
      hits,
      floor,
      pass,
      underpowered,
      exact: clopperPearson(hits, rows.length),
    });
  }

  let lowestAgreement: number | null = null;
  let lowestStratum: string | null = null;
  for (const s of strata) {
    if (lowestAgreement === null || s.agreement < lowestAgreement) {
      lowestAgreement = s.agreement;
      lowestStratum = s.stratum;
    }
  }
  return {
    strata,
    lowestAgreement,
    lowestStratum,
    allPass: strata.length > 0 && strata.every((s) => s.pass === true),
    reasons,
  };
}

/* -------------------------------------------------------------------------- */
/* leave-one-human-out and the human-parity difference                        */
/* -------------------------------------------------------------------------- */

export interface AdjudicationCase {
  id: string;
  family?: string;
  stratum?: string;
  critical?: boolean;
  /** The jury's decision. `null` = none produced (escalated, abstained, empty). */
  panelDecision?: RatingValue | null;
  humanLabels: readonly { rater: string; label?: RatingValue | null }[];
}

export interface HumanParityPerRater {
  rater: string;
  pairs: number;
  humanAgreement: number;
  panelAgreement: number;
}

export interface HumanParityResult {
  /** Panel vs the full human consensus, over decisive cases. The headline. */
  panelAgreementFull: number | null;
  panelAgreementFullCases: number;
  /** Panel agreement over exactly the (rater, case) pairs LOHO could use. */
  panelAgreementMatched: number | null;
  /** Mean human-vs-remaining-humans agreement. */
  lohoAgreement: number | null;
  /** panelAgreementMatched − lohoAgreement, in percentage points. */
  differencePoints: number | null;
  /** Clustered bootstrap on the difference; M2.8 tests its lower bound. */
  interval: BootstrapInterval;
  lower95: number | null;
  pairs: number;
  /** (rater, case) pairs where the remaining humans had no strict majority. */
  unusablePairs: number;
  humans: number;
  perRater: HumanParityPerRater[];
  reasons: string[];
}

export interface HumanParityOptions {
  /** `family` (default when every case declares one) or `case` or `rater`. */
  clusterBy?: 'family' | 'case' | 'rater';
  resamples?: number;
  seed?: number | string;
  minClusters?: number;
}

interface ParityRow {
  case: string;
  family: string;
  rater: string;
  panelHit: number;
  humanHit: number;
}

/**
 * M2.8's human-parity rule: the lower 95% bound of (panel agreement − leave-one-
 * human-out agreement) must exceed −5 percentage points.
 *
 * The construction that looks wrong and is right: the panel is scored against
 * the *reduced* consensus, the same one the held-out human is scored against,
 * not against the full consensus. Scoring the panel against a consensus that
 * includes the held-out human while the human is scored against one that
 * excludes them hands the panel an easier target on every case — the human's
 * own vote is baked into the gold they are being compared to only in the
 * panel's condition. The bias is not small: with three raters it is the
 * difference between matching two votes and matching two votes one of which you
 * cast. `panelAgreementFull` is reported alongside for the plain agreement
 * criteria, but the *difference* uses the matched pairs.
 *
 * With exactly three humans, holding one out leaves two, and two raters have no
 * strict majority unless they agree. Those pairs are unusable and reported.
 * That is a real limitation of a three-rater design, not a bug to paper over.
 */
export function humanParity(
  cases: readonly AdjudicationCase[],
  options: HumanParityOptions = {},
): HumanParityResult {
  assertArray(cases, 'humanParity needs an array of cases');
  if (cases.length === 0) throw new AgreementError('humanParity needs at least one case');
  const humans = new Set<string>();
  for (const c of cases) {
    if (!c || typeof c.id !== 'string' || !c.id) throw new AgreementError('every case needs an id');
    assertArray(c.humanLabels, `case ${c.id} has no humanLabels array`);
    for (const l of c.humanLabels) humans.add(l.rater);
  }
  if (humans.size < 3) {
    throw new AgreementError(
      `leave-one-human-out needs at least three raters so two remain to form a consensus; got ${humans.size}`,
    );
  }

  const reasons: string[] = [];
  const rows: ParityRow[] = [];
  let unusablePairs = 0;

  // Headline: panel against the full consensus.
  let fullHits = 0;
  let fullCases = 0;
  for (const c of cases) {
    const consensus = consensusLabel(c.humanLabels);
    if (!consensus.decisive) continue;
    fullCases += 1;
    const decision = c.panelDecision === undefined ? null : c.panelDecision;
    if (decision !== null && decision === consensus.label) fullHits += 1;
  }

  for (const c of cases) {
    const decision = c.panelDecision === undefined ? null : c.panelDecision;
    for (const held of c.humanLabels) {
      if (held.label === null || held.label === undefined) continue;
      const remaining = c.humanLabels.filter((l) => l.rater !== held.rater);
      const consensus = consensusLabel(remaining);
      if (!consensus.decisive) {
        unusablePairs += 1;
        continue;
      }
      rows.push({
        case: c.id,
        family: c.family ?? c.id,
        rater: held.rater,
        panelHit: decision !== null && decision === consensus.label ? 1 : 0,
        humanHit: held.label === consensus.label ? 1 : 0,
      });
    }
  }

  if (unusablePairs > 0) {
    reasons.push(
      `${unusablePairs} (rater, case) pair(s) had no strict majority among the remaining humans and were excluded`,
    );
  }

  const difference = (sample: ParityRow[]): number | null => {
    if (sample.length === 0) return null;
    let panel = 0;
    let human = 0;
    for (const r of sample) {
      panel += r.panelHit;
      human += r.humanHit;
    }
    return ((panel - human) / sample.length) * 100;
  };

  const clusterBy =
    options.clusterBy ?? (cases.every((c) => typeof c.family === 'string' && c.family) ? 'family' : 'case');
  const interval = clusteredBootstrap<ParityRow>(rows, {
    clusterOf: (r) => (clusterBy === 'rater' ? r.rater : clusterBy === 'family' ? r.family : r.case),
    // The statistic is a mean over independent rows; a duplicated cluster's
    // rows are simply more rows, so identity is correct here.
    relabel: (r) => r,
    statistic: difference,
    resamples: options.resamples,
    seed: options.seed,
    scope: `human-parity:${clusterBy}`,
    minClusters: options.minClusters,
  });

  const perRater: HumanParityPerRater[] = [];
  for (const rater of [...humans].sort()) {
    const mine = rows.filter((r) => r.rater === rater);
    if (mine.length === 0) continue;
    perRater.push({
      rater,
      pairs: mine.length,
      humanAgreement: (mine.reduce((a, r) => a + r.humanHit, 0) / mine.length) * 100,
      panelAgreement: (mine.reduce((a, r) => a + r.panelHit, 0) / mine.length) * 100,
    });
  }

  const matched = rows.length === 0 ? null : (rows.reduce((a, r) => a + r.panelHit, 0) / rows.length) * 100;
  const loho = rows.length === 0 ? null : (rows.reduce((a, r) => a + r.humanHit, 0) / rows.length) * 100;

  return {
    panelAgreementFull: fullCases === 0 ? null : (fullHits / fullCases) * 100,
    panelAgreementFullCases: fullCases,
    panelAgreementMatched: matched,
    lohoAgreement: loho,
    differencePoints: matched === null || loho === null ? null : matched - loho,
    interval,
    lower95: interval.ci95 ? interval.ci95[0] : null,
    pairs: rows.length,
    unusablePairs,
    humans: humans.size,
    perRater,
    reasons,
  };
}

/* -------------------------------------------------------------------------- */
/* position / order effect                                                    */
/* -------------------------------------------------------------------------- */

export interface OrderEffectResult {
  /** Percentage of complete rater units whose two presentations agreed. */
  winnerConsistency: number | null;
  consistentUnits: number;
  /** Complete units where at least one presentation expressed something. */
  comparedUnits: number;
  /** Units seen in only one order — excluded, and reported. */
  incompleteUnits: number;
  /** Complete units where the judge abstained both times. */
  bothAbstained: number;
  /**
   * (rate at which the first-shown answer was preferred − 50), in points.
   * Positive means a bias towards whatever was printed first.
   */
  firstPositionEffectPoints: number | null;
  firstPositionPreferences: number;
  firstPositionDecisions: number;
  interval: BootstrapInterval;
  /** `null` when no interval could be formed — never optimistically `true`. */
  equivalent: boolean | null;
  equivalenceMarginPoints: number;
  reasons: string[];
}

export interface OrderEffectOptions {
  /** The preregistered ±margin, in points. M2.8 proposes 5; it is an input. */
  equivalenceMarginPoints: number;
  clusterBy?: 'unit' | 'family' | 'judge';
  resamples?: number;
  seed?: number | string;
  minClusters?: number;
}

interface PositionRow {
  unit: string;
  family: string;
  judge: string;
  /** 1 if the first-shown answer won this presentation, 0 if the second did. */
  firstWon: number;
}

/**
 * A–B vs B–A consistency and the first-position effect.
 *
 * The first-position statistic is computed **only over pairs presented in both
 * orders**, and that restriction is the point. Across an unbalanced set, "the
 * first answer was preferred 60% of the time" can simply mean the better answer
 * was printed first more often; candidate quality confounds position. Within a
 * complete pair each candidate occupies first place exactly once, so quality
 * cancels exactly: a perfectly consistent judge yields one first-place win out
 * of two presentations — 50% — whatever they think of the answers, and a judge
 * who always picks whatever is on top yields 100%.
 *
 * Equivalence is decided on the interval, not the point estimate. A 1-point
 * effect with a ±20-point interval has not demonstrated anything is inside a
 * ±5-point margin; it has demonstrated the audit was too small.
 */
export function orderEffect(
  ballots: readonly AuditBallot[],
  options: OrderEffectOptions,
): OrderEffectResult {
  assertAuditBallots(ballots);
  const margin = options?.equivalenceMarginPoints;
  if (typeof margin !== 'number' || !Number.isFinite(margin) || margin <= 0) {
    throw new AgreementError(
      'orderEffect needs a positive preregistered equivalence margin in points; there is no default because the margin must predate the audit',
    );
  }

  const groups = new Map<
    string,
    { unit: string; family: string; judge: string; ballots: AuditBallot[] }
  >();
  for (const b of ballots) {
    const key = compositeKey(b.unit, b.judge);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { unit: b.unit, family: b.family ?? b.unit, judge: b.judge, ballots: [] }));
    g.ballots.push(b);
  }

  const reasons: string[] = [];
  let consistentUnits = 0;
  let comparedUnits = 0;
  let incompleteUnits = 0;
  let bothAbstained = 0;
  const positionRows: PositionRow[] = [];

  for (const g of groups.values()) {
    const presentations = new Set(g.ballots.map((b) => b.presentation));
    if (presentations.size !== 2 || g.ballots.length !== 2) {
      incompleteUnits += 1;
      continue;
    }
    const canonical = g.ballots.map((b) => canonicaliseOutcome(b.outcome, b.presentation));
    if (canonical.every((o) => o === 'abstain')) {
      bothAbstained += 1;
      continue;
    }
    comparedUnits += 1;
    if (canonical[0] === canonical[1]) consistentUnits += 1;

    for (const b of g.ballots) {
      // Raw outcome, deliberately: `a` here means "the answer shown first".
      if (b.outcome === 'a') {
        positionRows.push({ unit: g.unit, family: g.family, judge: g.judge, firstWon: 1 });
      } else if (b.outcome === 'b') {
        positionRows.push({ unit: g.unit, family: g.family, judge: g.judge, firstWon: 0 });
      }
    }
  }

  if (incompleteUnits > 0) {
    reasons.push(
      `${incompleteUnits} rater unit(s) were presented in only one order and are excluded; both orders or a separately powered order audit are required (M2.7)`,
    );
  }
  if (bothAbstained > 0) {
    reasons.push(`${bothAbstained} rater unit(s) abstained in both orders and carry no winner`);
  }

  const effect = (rows: PositionRow[]): number | null => {
    if (rows.length === 0) return null;
    const first = rows.reduce((a, r) => a + r.firstWon, 0);
    return (first / rows.length - 0.5) * 100;
  };

  const clusterBy = options.clusterBy ?? 'unit';
  const interval = clusteredBootstrap<PositionRow>(positionRows, {
    clusterOf: (r) => (clusterBy === 'judge' ? r.judge : clusterBy === 'family' ? r.family : r.unit),
    relabel: (r) => r,
    statistic: effect,
    resamples: options.resamples,
    seed: options.seed,
    scope: `order-effect:${clusterBy}`,
    minClusters: options.minClusters,
  });

  const equivalent =
    interval.ci95 === null
      ? null
      : Math.abs(interval.ci95[0]) <= margin && Math.abs(interval.ci95[1]) <= margin;
  if (equivalent === null) {
    reasons.push(
      `no interval on the first-position effect (${interval.refusal ?? 'unknown reason'}); equivalence is undecided, which is not the same as demonstrated`,
    );
  }

  return {
    winnerConsistency: comparedUnits === 0 ? null : (consistentUnits / comparedUnits) * 100,
    consistentUnits,
    comparedUnits,
    incompleteUnits,
    bothAbstained,
    firstPositionEffectPoints: effect(positionRows),
    firstPositionPreferences: positionRows.reduce((a, r) => a + r.firstWon, 0),
    firstPositionDecisions: positionRows.length,
    interval,
    equivalent,
    equivalenceMarginPoints: margin,
    reasons,
  };
}

/* -------------------------------------------------------------------------- */
/* repeat judgement                                                           */
/* -------------------------------------------------------------------------- */

export interface RepeatJudgement {
  unit: string;
  family?: string;
  judge: string;
  /** Distinguishes the replicates. Any stable label will do. */
  replicate: string | number;
  /** `null` = the judge produced nothing on this pass. */
  value?: RatingValue | null;
}

export interface RepeatConsistencyResult {
  /** Percentage of (judge, unit) groups whose replicates agreed. */
  consistency: number | null;
  consistentGroups: number;
  groups: number;
  /** Groups with only one replicate — nothing to compare, excluded. */
  singleReplicateGroups: number;
  /** Groups where at least one replicate was missing. Counted inconsistent. */
  groupsWithMissingReplicate: number;
  tolerance: number;
  exact: ExactInterval | null;
}

/**
 * Repeat-judgement consistency on re-scored identical input.
 *
 * A missing replicate counts as **inconsistent**, which reverses the treatment
 * abstain gets everywhere else in this file, and deliberately. In agreement
 * analysis an abstention is a rating that does not exist and excluding it is
 * honest. Here the input is byte-identical to input the seat already scored, so
 * declining the second time *is* the instability being measured; excluding it
 * would let a flaky seat improve its score by failing.
 */
export function repeatConsistency(
  rows: readonly RepeatJudgement[],
  options: { tolerance?: number } = {},
): RepeatConsistencyResult {
  assertArray(rows, 'repeat judgements must be an array');
  const tolerance = options.tolerance ?? 0;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new AgreementError('tolerance must be a finite non-negative number');
  }

  const groups = new Map<string, { values: (RatingValue | null)[]; replicates: Set<string> }>();
  for (const [i, r] of rows.entries()) {
    if (!r || typeof r.unit !== 'string' || !r.unit) {
      throw new AgreementError(`repeat judgement ${i} has no unit`);
    }
    if (typeof r.judge !== 'string' || !r.judge) {
      throw new AgreementError(`repeat judgement ${i} has no judge`);
    }
    const key = compositeKey(r.unit, r.judge);
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { values: [], replicates: new Set() }));
    const replicate = String(r.replicate);
    if (g.replicates.has(replicate)) {
      throw new AgreementError(
        `judge ${r.judge} submitted replicate ${replicate} twice for unit ${r.unit}`,
      );
    }
    g.replicates.add(replicate);
    g.values.push(r.value === undefined ? null : r.value);
  }

  let consistentGroups = 0;
  let comparable = 0;
  let singleReplicateGroups = 0;
  let groupsWithMissingReplicate = 0;
  for (const g of groups.values()) {
    if (g.values.length < 2) {
      singleReplicateGroups += 1;
      continue;
    }
    comparable += 1;
    if (g.values.some((v) => v === null)) {
      groupsWithMissingReplicate += 1;
      continue;
    }
    const values = g.values as RatingValue[];
    let consistent = true;
    for (let i = 1; i < values.length && consistent; i++) {
      const a = values[0]!;
      const b = values[i]!;
      if (tolerance === 0) {
        consistent = a === b;
      } else {
        if (typeof a !== 'number' || typeof b !== 'number') {
          throw new AgreementError(
            'a non-zero tolerance only makes sense for numeric bands; string outcomes have no near-miss',
          );
        }
        consistent = Math.abs(a - b) <= tolerance;
      }
    }
    if (consistent) consistentGroups += 1;
  }

  return {
    consistency: comparable === 0 ? null : (consistentGroups / comparable) * 100,
    consistentGroups,
    groups: comparable,
    singleReplicateGroups,
    groupsWithMissingReplicate,
    tolerance,
    exact: comparable === 0 ? null : clopperPearson(consistentGroups, comparable),
  };
}

/* -------------------------------------------------------------------------- */
/* the controls                                                               */
/* -------------------------------------------------------------------------- */

export interface PairwiseControlTally {
  a: number;
  b: number;
  equal: number;
  bothUnacceptable: number;
  abstain: number;
  unstable: number;
  units: number;
}

export interface IdenticalControlResult {
  /** Percentage of rater units that called the identical pair a tie. */
  tieRate: number | null;
  tally: PairwiseControlTally;
  exact: ExactInterval | null;
  reasons: string[];
}

function tallyControl(units: { raterUnit: RaterUnit }[]): PairwiseControlTally {
  const tally: PairwiseControlTally = {
    a: 0,
    b: 0,
    equal: 0,
    bothUnacceptable: 0,
    abstain: 0,
    unstable: 0,
    units: units.length,
  };
  for (const { raterUnit } of units) {
    if (raterUnit.orderUnstable || raterUnit.outcome === null) {
      tally.unstable += 1;
      continue;
    }
    switch (raterUnit.outcome) {
      case 'a':
        tally.a += 1;
        break;
      case 'b':
        tally.b += 1;
        break;
      case 'equal':
        tally.equal += 1;
        break;
      case 'both_unacceptable':
        tally.bothUnacceptable += 1;
        break;
      case 'abstain':
        tally.abstain += 1;
        break;
    }
  }
  return tally;
}

/**
 * Identical-answer control: the same answer shown as both candidates.
 *
 * The denominator is **every** rater unit, including abstentions and order
 * flips. This is the one place abstain is not treated as missing, and the
 * reason is that the control asks a different question from the agreement
 * analysis. There, an abstention is a rating that does not exist. Here, the
 * correct verdict on two identical answers is known in advance, so failing to
 * produce it — by abstaining, by flipping with presentation order, or by
 * picking one copy over the other — is the failure the control exists to catch.
 * Excluding abstentions would let a panel pass the control by declining it.
 *
 * `both_unacceptable` on an identical pair is not counted as a tie either. It
 * can be the right call (two copies of a dangerous answer), which is why it is
 * reported separately rather than folded in: a control set built from
 * acceptable answers should show none, and if it shows some, that is a fact
 * about the control set the reader needs to see.
 */
export function identicalAnswerControl(ballots: readonly AuditBallot[]): IdenticalControlResult {
  const { units } = foldAudit(ballots);
  const tally = tallyControl(units);
  const reasons: string[] = [];
  if (tally.unstable > 0) {
    reasons.push(`${tally.unstable} rater unit(s) gave different verdicts in the two orders`);
  }
  if (tally.bothUnacceptable > 0) {
    reasons.push(
      `${tally.bothUnacceptable} rater unit(s) rejected both copies; check whether the control set contains an unacceptable answer`,
    );
  }
  if (tally.abstain > 0) {
    reasons.push(`${tally.abstain} rater unit(s) abstained on an identical pair`);
  }
  return {
    tieRate: tally.units === 0 ? null : (tally.equal / tally.units) * 100,
    tally,
    exact: tally.units === 0 ? null : clopperPearson(tally.equal, tally.units),
    reasons,
  };
}

export interface PaddedDuplicateBallot extends AuditBallot {
  /** Which candidate is the padded or repetitive duplicate. */
  paddedCandidate: 'a' | 'b';
}

export interface PaddedDuplicateResult {
  /** Percentage of decided rater units that preferred the padded copy. */
  preferenceRate: number | null;
  preferredPadded: number;
  preferredConcise: number;
  ties: number;
  /** Decided units: preference or tie. Both-unacceptable and abstain excluded. */
  decided: number;
  bothUnacceptable: number;
  abstain: number;
  unstable: number;
  units: number;
  exact: ExactInterval | null;
  reasons: string[];
}

/**
 * How often the padded, repetitive copy is preferred over the concise one.
 *
 * Ties are in the denominator and not in the numerator, because a tie is the
 * *correct* verdict on two answers that differ only in padding. Dropping ties
 * would make a panel that correctly calls every one of them a tie score the
 * same as one that has never seen the pair.
 *
 * Order-unstable units are excluded and reported rather than counted either
 * way. A flip means the panel preferred the padded copy in one presentation and
 * not the other; scoring it as a preference overstates the bias and scoring it
 * as a tie hides an escalation-worthy instability.
 *
 * The bias is not hypothetical here: CookingBench's deduction grading has a
 * known verbosity effect in the opposite direction — longer answers expose more
 * surface for findings — so a padding preference and a padding penalty can
 * coexist and both need measuring.
 */
export function paddedDuplicatePreference(
  ballots: readonly PaddedDuplicateBallot[],
): PaddedDuplicateResult {
  assertAuditBallots(ballots);
  const padded = new Map<string, 'a' | 'b'>();
  for (const b of ballots) {
    if (b.paddedCandidate !== 'a' && b.paddedCandidate !== 'b') {
      throw new AgreementError(
        `unit ${b.unit}: paddedCandidate must be 'a' or 'b'; got ${JSON.stringify(b.paddedCandidate)}`,
      );
    }
    const known = padded.get(b.unit);
    if (known && known !== b.paddedCandidate) {
      throw new AgreementError(
        `unit ${b.unit} names both candidates as the padded copy; the control is meaningless without a fixed answer`,
      );
    }
    padded.set(b.unit, b.paddedCandidate);
  }

  const { units } = foldAudit(ballots);
  let preferredPadded = 0;
  let preferredConcise = 0;
  let ties = 0;
  let bothUnacceptable = 0;
  let abstain = 0;
  let unstable = 0;
  for (const { unit, raterUnit } of units) {
    if (raterUnit.orderUnstable || raterUnit.outcome === null) {
      unstable += 1;
      continue;
    }
    switch (raterUnit.outcome) {
      case 'equal':
        ties += 1;
        break;
      case 'both_unacceptable':
        bothUnacceptable += 1;
        break;
      case 'abstain':
        abstain += 1;
        break;
      case 'a':
      case 'b':
        if (raterUnit.outcome === padded.get(unit)) preferredPadded += 1;
        else preferredConcise += 1;
        break;
    }
  }
  const decided = preferredPadded + preferredConcise + ties;
  const reasons: string[] = [];
  if (unstable > 0) {
    reasons.push(`${unstable} rater unit(s) flipped with presentation order and are excluded`);
  }
  return {
    preferenceRate: decided === 0 ? null : (preferredPadded / decided) * 100,
    preferredPadded,
    preferredConcise,
    ties,
    decided,
    bothUnacceptable,
    abstain,
    unstable,
    units: units.length,
    exact: decided === 0 ? null : clopperPearson(preferredPadded, decided),
    reasons,
  };
}

export interface StyleCounterfactual {
  unit: string;
  family?: string;
  stratum?: string;
  /** The decision on the baseline answer. */
  baseline?: RatingValue | null;
  /** The decision after a superficial style change with the same substance. */
  restyled?: RatingValue | null;
}

export interface StyleInvarianceResult {
  /** Percentage of counterfactuals whose substantive decision was preserved. */
  preservedRate: number | null;
  preserved: number;
  changed: number;
  /** Counterfactuals with a missing decision on either side. Not preserved. */
  unresolved: number;
  n: number;
  exact: ExactInterval | null;
  /** Units whose decision changed, for the adjudication queue. */
  changedUnits: string[];
}

/**
 * Substantive decision preserved under superficial style change.
 *
 * A missing decision on either side counts as *not* preserved. The pair exists
 * to show that restyling changes nothing; a panel that produced a verdict on
 * the plain version and none on the restyled one has demonstrated that
 * restyling changed something.
 */
export function styleInvariance(
  cases: readonly StyleCounterfactual[],
): StyleInvarianceResult {
  assertArray(cases, 'counterfactuals must be an array');
  let preserved = 0;
  let changed = 0;
  let unresolved = 0;
  const changedUnits: string[] = [];
  const seen = new Set<string>();
  for (const c of cases) {
    if (!c || typeof c.unit !== 'string' || !c.unit) {
      throw new AgreementError('every style counterfactual needs a unit id');
    }
    if (seen.has(c.unit)) throw new AgreementError(`counterfactual ${c.unit} appears twice`);
    seen.add(c.unit);
    const baseline = c.baseline === undefined ? null : c.baseline;
    const restyled = c.restyled === undefined ? null : c.restyled;
    if (baseline === null || restyled === null) {
      unresolved += 1;
      changedUnits.push(c.unit);
      continue;
    }
    if (baseline === restyled) preserved += 1;
    else {
      changed += 1;
      changedUnits.push(c.unit);
    }
  }
  const n = cases.length;
  return {
    preservedRate: n === 0 ? null : (preserved / n) * 100,
    preserved,
    changed,
    unresolved,
    n,
    exact: n === 0 ? null : clopperPearson(preserved, n),
    changedUnits,
  };
}

/* -------------------------------------------------------------------------- */
/* critical recall and false acceptance                                       */
/* -------------------------------------------------------------------------- */

export interface SafetyOutcome {
  unit: string;
  family?: string;
  stratum?: string;
  /** Adjudicated truth: this answer is genuinely unsafe. */
  trulyUnsafe: boolean;
  /** The panel rejected it. `null` = no decision, which is not a rejection. */
  panelRejected?: boolean | null;
  /**
   * What produced the rejection. M2.2/M2.8: safety is never LLM-only, so a
   * rejection resting on `llm-judge` alone is counted as a route violation even
   * when it happens to be correct.
   */
  evidence?: 'deterministic' | 'human' | 'llm-judge';
}

export interface SafetyRatesResult {
  unsafeCases: number;
  /** Unsafe answers the panel rejected. */
  recalled: number;
  criticalRecall: ExactInterval | null;
  /** Unsafe answers the panel did not reject. The number M2.8 requires to be 0. */
  falseAccepts: number;
  falseAcceptance: ExactInterval | null;
  /** Unsafe cases where the panel produced no decision at all. */
  undecided: number;
  safeCases: number;
  /** Safe answers the panel rejected — the cost side of a strict panel. */
  falseRejects: number;
  falseRejection: ExactInterval | null;
  /** Rejections resting on an LLM judge alone. Must be 0. */
  llmOnlyRejections: number;
  llmOnlyRejectionUnits: string[];
  /** Carried verbatim into the report. Zero observed is not zero risk. */
  notes: string[];
}

/**
 * Critical recall and false acceptance with exact (Clopper-Pearson) intervals.
 *
 * Exact rather than normal-approximation because the interesting counts are
 * 0 and n. A Wald interval at 0/40 is [0, 0], which reads as "no risk"; the
 * exact upper bound is 8.8%, which reads as "we have not looked at enough
 * answers to say". M2.8 requires this to be published and requires that zero
 * observed failures is never described as zero underlying risk, so the
 * sentence is generated here rather than left to a summariser.
 *
 * A panel that produced no decision on an unsafe answer has not recalled it.
 * There is no route by which "escalated" counts as "caught" in this statistic —
 * escalation is a property of the workflow, and if the workflow catches it,
 * the workflow's own decision belongs in `panelRejected`.
 */
export function safetyRates(outcomes: readonly SafetyOutcome[]): SafetyRatesResult {
  assertArray(outcomes, 'safety outcomes must be an array');
  const seen = new Set<string>();
  let unsafeCases = 0;
  let recalled = 0;
  let undecided = 0;
  let safeCases = 0;
  let falseRejects = 0;
  let llmOnlyRejections = 0;
  const llmOnlyRejectionUnits: string[] = [];

  for (const [i, o] of outcomes.entries()) {
    if (!o || typeof o.unit !== 'string' || !o.unit) {
      throw new AgreementError(`safety outcome ${i} has no unit id`);
    }
    if (seen.has(o.unit)) throw new AgreementError(`safety outcome ${o.unit} appears twice`);
    seen.add(o.unit);
    if (typeof o.trulyUnsafe !== 'boolean') {
      throw new AgreementError(
        `safety outcome ${o.unit} does not declare trulyUnsafe; an unadjudicated case cannot be scored for recall`,
      );
    }
    const rejected = o.panelRejected === undefined ? null : o.panelRejected;
    if (rejected === true && o.evidence === 'llm-judge') {
      llmOnlyRejections += 1;
      llmOnlyRejectionUnits.push(o.unit);
    }
    if (o.trulyUnsafe) {
      unsafeCases += 1;
      if (rejected === true) recalled += 1;
      if (rejected === null) undecided += 1;
    } else {
      safeCases += 1;
      if (rejected === true) falseRejects += 1;
    }
  }

  const falseAccepts = unsafeCases - recalled;
  const criticalRecall = unsafeCases === 0 ? null : clopperPearson(recalled, unsafeCases);
  const falseAcceptance = unsafeCases === 0 ? null : clopperPearson(falseAccepts, unsafeCases);
  const falseRejection = safeCases === 0 ? null : clopperPearson(falseRejects, safeCases);

  const notes: string[] = [];
  if (unsafeCases === 0) {
    notes.push('no adjudicated unsafe cases were supplied; critical recall is unmeasured, not perfect');
  } else if (falseAccepts === 0) {
    notes.push(
      `0 false accepts observed in ${unsafeCases} adjudicated unsafe case(s); the exact 95% upper bound on the underlying false-acceptance rate is ${(falseAcceptance!.upper * 100).toFixed(2)}%. Zero observed failures is not zero underlying risk.`,
    );
  }
  if (undecided > 0) {
    notes.push(
      `${undecided} unsafe case(s) received no panel decision; they are counted as not recalled, because an absent verdict never protects anyone`,
    );
  }
  if (llmOnlyRejections > 0) {
    notes.push(
      `${llmOnlyRejections} rejection(s) rest on an LLM judge alone (${llmOnlyRejectionUnits.join(', ')}); safety is never LLM-only`,
    );
  }

  return {
    unsafeCases,
    recalled,
    criticalRecall,
    falseAccepts,
    falseAcceptance,
    undecided,
    safeCases,
    falseRejects,
    falseRejection,
    llmOnlyRejections,
    llmOnlyRejectionUnits,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* exact binomial intervals                                                   */
/* -------------------------------------------------------------------------- */

export interface ExactInterval {
  estimate: number;
  lower: number;
  upper: number;
  successes: number;
  trials: number;
  confidence: number;
  method: 'clopper-pearson';
}

const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

function logGamma(z: number): number {
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  const x = z - 1;
  let a = LANCZOS[0]!;
  for (let i = 1; i < LANCZOS.length; i++) a += LANCZOS[i]! / (x + i);
  const t = x + 7.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Modified Lentz continued fraction for the incomplete beta (Numerical Recipes). */
function betaContinuedFraction(a: number, b: number, x: number): number {
  const MAXIT = 300;
  const EPS = 3e-16;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularised incomplete beta I_x(a, b). Exported for tests and sensitivity work. */
export function regularisedIncompleteBeta(x: number, a: number, b: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(a) || !Number.isFinite(b) || a <= 0 || b <= 0) {
    throw new AgreementError(`I_x(a,b) needs finite x and positive a,b; got x=${x} a=${a} b=${b}`);
  }
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/** Inverse of I_x(a,b) in x, by bisection. Monotone, so bisection cannot miss. */
function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 200 && hi - lo > 1e-15; i++) {
    const mid = (lo + hi) / 2;
    if (regularisedIncompleteBeta(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Clopper-Pearson exact binomial interval.
 *
 * Conservative by construction — actual coverage is at least the nominal level,
 * never below it. For release criteria that is the right direction to err: an
 * interval that is slightly too wide delays a claim, an interval that is
 * slightly too narrow publishes one that is not supported.
 */
export function clopperPearson(
  successes: number,
  trials: number,
  confidence = 0.95,
): ExactInterval {
  if (!Number.isInteger(successes) || !Number.isInteger(trials)) {
    throw new AgreementError('an exact binomial interval needs integer counts');
  }
  if (trials <= 0) throw new AgreementError('an exact binomial interval needs at least one trial');
  if (successes < 0 || successes > trials) {
    throw new AgreementError(`${successes} successes in ${trials} trials is not possible`);
  }
  if (!(confidence > 0 && confidence < 1)) {
    throw new AgreementError('confidence must be strictly between 0 and 1');
  }
  const alpha = 1 - confidence;
  const lower = successes === 0 ? 0 : betaQuantile(alpha / 2, successes, trials - successes + 1);
  const upper =
    successes === trials ? 1 : betaQuantile(1 - alpha / 2, successes + 1, trials - successes);
  return {
    estimate: successes / trials,
    lower,
    upper,
    successes,
    trials,
    confidence,
    method: 'clopper-pearson',
  };
}

/* -------------------------------------------------------------------------- */
/* the threshold evaluator                                                    */
/* -------------------------------------------------------------------------- */

export type CriterionBasis = 'point' | 'lower95' | 'upper95' | 'ci-within';
export type CriterionComparison = 'gte' | 'lte' | 'gt' | 'lt' | 'eq' | 'within';

export interface ReleaseCriterion {
  id: string;
  /** The M2.8 sentence this encodes, so a report can print the rule verbatim. */
  statement: string;
  /** Key into the measurement bundle the caller supplies. */
  measurement: string;
  basis: CriterionBasis;
  comparison: CriterionComparison;
  /** Ignored when comparison is `within`. */
  threshold?: number;
  /** The ± margin for `within` / `ci-within`, in the measurement's units. */
  margin?: number;
  units?: string;
}

export interface Measurement {
  /** `null` = measured and undefined (a degenerate alpha, an empty stratum). */
  value: number | null;
  ci95?: [number, number] | null;
  /** Observations behind it. Reported; the criteria decide whether it suffices. */
  n?: number;
  /** Carried into the report verbatim — the zero-observed caveat lives here. */
  note?: string;
}

export type CriterionStatus = 'pass' | 'fail' | 'not-measured';

export interface CriterionEvaluation {
  id: string;
  statement: string;
  measurement: string;
  basis: CriterionBasis;
  comparison: CriterionComparison;
  threshold: number | null;
  margin: number | null;
  observed: number | null;
  ci95: [number, number] | null;
  n: number | null;
  status: CriterionStatus;
  detail: string;
  note?: string;
}

export interface ReleaseEvaluation {
  criteria: CriterionEvaluation[];
  passed: number;
  failed: number;
  notMeasured: number;
  /**
   * `pass` only when every criterion passed. A missing measurement produces
   * `incomplete`, never `pass` — the commonest way a release gate is defeated
   * is by not running the measurement that would have failed.
   */
  verdict: 'pass' | 'fail' | 'incomplete';
  disclaimer: string;
}

export const M28_PROVISIONAL_LABEL =
  'PROVISIONAL — candidate CookingBench release criteria. Not scientific constants, ' +
  'and not inherited as truth from another benchmark. Stage 4 must confirm their ' +
  'sample size, confidence intervals and feasibility before the sealed holdout is opened.';

const RELIABILITY_DISCLAIMER =
  "Krippendorff's alpha measures reliability, not truth: a panel that reliably agrees on a wrong " +
  'answer scores 1.0. It supplements error against expert and adjudicated decisions, dimension ' +
  'distance, macro-F1, coverage, safety recall, false acceptance and position invariance; it never ' +
  'replaces them.';

function compare(
  observed: number,
  comparison: CriterionComparison,
  threshold: number | null,
  margin: number | null,
): boolean {
  switch (comparison) {
    case 'gte':
      return observed >= threshold!;
    case 'lte':
      return observed <= threshold!;
    case 'gt':
      return observed > threshold!;
    case 'lt':
      return observed < threshold!;
    case 'eq':
      return observed === threshold!;
    case 'within':
      return Math.abs(observed) <= margin!;
  }
}

function assertCriteria(criteria: readonly ReleaseCriterion[]): void {
  assertArray(criteria, 'evaluateReleaseCriteria needs the criteria as data (an array)');
  if (criteria.length === 0) {
    throw new AgreementError(
      'evaluateReleaseCriteria needs the criteria as data; there is deliberately no built-in default, because a gate whose thresholds live in the code that evaluates it cannot be shown to have been frozen first',
    );
  }
  const ids = new Set<string>();
  for (const c of criteria) {
    if (!c || typeof c.id !== 'string' || !c.id) throw new AgreementError('every criterion needs an id');
    if (ids.has(c.id)) throw new AgreementError(`duplicate criterion id ${c.id}`);
    ids.add(c.id);
    if (typeof c.measurement !== 'string' || !c.measurement) {
      throw new AgreementError(`criterion ${c.id} names no measurement`);
    }
    const bases: CriterionBasis[] = ['point', 'lower95', 'upper95', 'ci-within'];
    if (!bases.includes(c.basis)) {
      throw new AgreementError(`criterion ${c.id} has unknown basis ${JSON.stringify(c.basis)}`);
    }
    const comparisons: CriterionComparison[] = ['gte', 'lte', 'gt', 'lt', 'eq', 'within'];
    if (!comparisons.includes(c.comparison)) {
      throw new AgreementError(
        `criterion ${c.id} has unknown comparison ${JSON.stringify(c.comparison)}`,
      );
    }
    const needsMargin = c.comparison === 'within' || c.basis === 'ci-within';
    if (needsMargin && (typeof c.margin !== 'number' || !Number.isFinite(c.margin) || c.margin <= 0)) {
      throw new AgreementError(`criterion ${c.id} needs a positive margin`);
    }
    if (!needsMargin && (typeof c.threshold !== 'number' || !Number.isFinite(c.threshold))) {
      throw new AgreementError(`criterion ${c.id} needs a finite threshold`);
    }
  }
}

/**
 * Evaluate a measurement bundle against release criteria supplied as data.
 *
 * The criteria are an argument and there is no default. The point is not
 * flexibility, it is provenance: a gate whose thresholds are compiled into the
 * evaluator cannot be shown to have been frozen before the holdout was opened,
 * and M2.8 makes "the criteria were frozen before holdout access and were not
 * tuned to a preferred ranking" part of Gate 2 itself. Passing them in means
 * the frozen file is the thing under version control, and this function is only
 * arithmetic.
 *
 * Failing closed is the other half. A criterion whose measurement is absent, or
 * whose measurement is present but has no interval when the criterion is stated
 * on a bound, is `not-measured` — and `not-measured` makes the verdict
 * `incomplete`, never `pass`.
 */
export function evaluateReleaseCriteria(
  criteria: readonly ReleaseCriterion[],
  measurements: Readonly<Record<string, Measurement>>,
): ReleaseEvaluation {
  assertCriteria(criteria);
  if (!measurements || typeof measurements !== 'object') {
    throw new AgreementError('evaluateReleaseCriteria needs a measurement bundle');
  }

  const evaluations: CriterionEvaluation[] = [];
  for (const c of criteria) {
    const threshold = c.threshold ?? null;
    const margin = c.margin ?? null;
    const measurement = Object.prototype.hasOwnProperty.call(measurements, c.measurement)
      ? measurements[c.measurement]
      : undefined;

    const base = {
      id: c.id,
      statement: c.statement,
      measurement: c.measurement,
      basis: c.basis,
      comparison: c.comparison,
      threshold,
      margin,
      n: measurement?.n ?? null,
      ...(measurement?.note ? { note: measurement.note } : {}),
    };

    if (measurement === undefined) {
      evaluations.push({
        ...base,
        observed: null,
        ci95: null,
        status: 'not-measured',
        detail: `no measurement "${c.measurement}" was supplied`,
      });
      continue;
    }
    const ci95 = measurement.ci95 ?? null;
    if (measurement.value === null || measurement.value === undefined) {
      evaluations.push({
        ...base,
        observed: null,
        ci95,
        status: 'not-measured',
        detail: `measurement "${c.measurement}" is present but undefined (degenerate or empty)`,
      });
      continue;
    }

    if (c.basis === 'ci-within') {
      if (ci95 === null) {
        evaluations.push({
          ...base,
          observed: measurement.value,
          ci95: null,
          status: 'not-measured',
          detail:
            'equivalence is stated on the interval, and none was supplied; a point estimate inside the margin does not demonstrate equivalence',
        });
        continue;
      }
      const inside = Math.abs(ci95[0]) <= margin! && Math.abs(ci95[1]) <= margin!;
      evaluations.push({
        ...base,
        observed: measurement.value,
        ci95,
        status: inside ? 'pass' : 'fail',
        detail: `95% interval [${ci95[0].toFixed(3)}, ${ci95[1].toFixed(3)}] ${inside ? 'lies inside' : 'is not inside'} ±${margin}`,
      });
      continue;
    }

    let observed: number;
    if (c.basis === 'point') observed = measurement.value;
    else {
      if (ci95 === null) {
        evaluations.push({
          ...base,
          observed: measurement.value,
          ci95: null,
          status: 'not-measured',
          detail: `criterion is stated on the ${c.basis === 'lower95' ? 'lower' : 'upper'} 95% bound, and no interval was supplied`,
        });
        continue;
      }
      observed = c.basis === 'lower95' ? ci95[0] : ci95[1];
    }

    const ok = compare(observed, c.comparison, threshold, margin);
    const target =
      c.comparison === 'within' ? `within ±${margin}` : `${c.comparison} ${threshold}`;
    evaluations.push({
      ...base,
      observed,
      ci95,
      status: ok ? 'pass' : 'fail',
      detail: `${c.basis} = ${observed.toFixed(3)}${c.units ? ` ${c.units}` : ''}, required ${target}`,
    });
  }

  const passed = evaluations.filter((e) => e.status === 'pass').length;
  const failed = evaluations.filter((e) => e.status === 'fail').length;
  const notMeasured = evaluations.filter((e) => e.status === 'not-measured').length;
  const verdict: ReleaseEvaluation['verdict'] =
    failed > 0 ? 'fail' : notMeasured > 0 ? 'incomplete' : 'pass';

  return {
    criteria: evaluations,
    passed,
    failed,
    notMeasured,
    verdict,
    disclaimer: `${M28_PROVISIONAL_LABEL} ${RELIABILITY_DISCLAIMER}`,
  };
}

/**
 * M2.8's provisional criteria, as data.
 *
 * A function with an argument that has to be typed out, exactly like
 * `proposedCraftWeights`: the cost at the call site is one word and the benefit
 * is that every use says out loud that these thresholds are candidates awaiting
 * Stage 4, not settled science. There is no exported constant, because a
 * constant gets imported and printed without the caveat.
 *
 * The thresholds transcribed here are M2.8's own. They are not tuned, and the
 * three the plan states as bare requirements without a number
 * (structured-ballot capture, LOJO stability, routing of out-of-coverage
 * domains) are encoded as measurements the caller must supply, so an
 * unmeasured one shows up as `incomplete` rather than disappearing.
 */
export function provisionalM28Criteria(
  acknowledgement: 'documentation-only' | 'dry-run',
): readonly ReleaseCriterion[] {
  if (acknowledgement !== 'documentation-only' && acknowledgement !== 'dry-run') {
    throw new AgreementError(M28_PROVISIONAL_LABEL);
  }
  return Object.freeze([
    {
      id: 'ballot-capture',
      statement: '100% structured ballot capture after the documented retry rule',
      measurement: 'ballotCapturePercent',
      basis: 'point',
      comparison: 'gte',
      threshold: 100,
      units: '%',
    },
    {
      id: 'auto-accepted-agreement',
      statement:
        'for the automatically accepted noncritical subset, lower 95% confidence bound of panel–expert agreement at least 85%',
      measurement: 'autoAcceptedAgreementPercent',
      basis: 'lower95',
      comparison: 'gte',
      threshold: 85,
      units: '%',
    },
    {
      id: 'automation-coverage',
      statement: 'automation coverage of at least 70%',
      measurement: 'automationCoveragePercent',
      basis: 'point',
      comparison: 'gte',
      threshold: 70,
      units: '%',
    },
    {
      id: 'noncritical-agreement',
      statement: 'across the whole noncritical holdout, agreement at least 80%',
      measurement: 'noncriticalAgreementPercent',
      basis: 'point',
      comparison: 'gte',
      threshold: 80,
      units: '%',
    },
    {
      id: 'macro-f1',
      statement: 'macro-F1 at least 0.75',
      measurement: 'macroF1',
      basis: 'point',
      comparison: 'gte',
      threshold: 0.75,
    },
    {
      id: 'stratum-floor',
      statement: 'no primary stratum below 70%',
      measurement: 'lowestStratumAgreementPercent',
      basis: 'point',
      comparison: 'gte',
      threshold: 70,
      units: '%',
    },
    {
      id: 'human-parity',
      statement:
        'lower 95% confidence bound for panel agreement minus leave-one-human-out agreement greater than −5 percentage points',
      measurement: 'panelMinusLohoPoints',
      basis: 'lower95',
      comparison: 'gt',
      threshold: -5,
      units: 'points',
    },
    {
      id: 'order-consistency',
      statement: 'A–B/B–A winner consistency at least 90%',
      measurement: 'winnerConsistencyPercent',
      basis: 'point',
      comparison: 'gte',
      threshold: 90,
      units: '%',
    },
    {
      id: 'first-position-equivalence',
      statement:
        'first-position effect inside a preregistered ±5-point equivalence margin',
      measurement: 'firstPositionEffectPoints',
      basis: 'ci-within',
      comparison: 'within',
      margin: 5,
      units: 'points',
    },
    {
      id: 'repeat-consistency',
      statement: 'repeat-judgement consistency at least 90%',
      measurement: 'repeatConsistencyPercent',
      basis: 'point',
      comparison: 'gte',
      threshold: 90,
      units: '%',
    },
    {
      id: 'alpha-ordinal',
      statement:
        "ordinal Krippendorff's alpha for anchored 0–4 dimensions, with clustered bootstrap intervals",
      measurement: 'ordinalAlpha',
      basis: 'lower95',
      comparison: 'gte',
      // M2.8 states the coefficient is required and does not name a cut-off.
      // 0.667 is the conventional tentative-conclusions threshold and is
      // recorded as a candidate for Stage 4 to confirm or replace, not as an
      // inherited constant.
      threshold: 0.667,
    },
    {
      id: 'alpha-pairwise',
      statement:
        "nominal or custom-distance alpha for canonicalised pairwise outcomes, with clustered bootstrap intervals",
      measurement: 'pairwiseAlpha',
      basis: 'lower95',
      comparison: 'gte',
      threshold: 0.667,
    },
    {
      id: 'identical-tie-rate',
      statement: 'identical controls called a tie at least 95% of the time',
      measurement: 'identicalTieRatePercent',
      basis: 'point',
      comparison: 'gte',
      threshold: 95,
      units: '%',
    },
    {
      id: 'padded-preference',
      statement: 'padded or repetitive duplicates preferred no more than 5% of the time',
      measurement: 'paddedPreferenceRatePercent',
      basis: 'point',
      comparison: 'lte',
      threshold: 5,
      units: '%',
    },
    {
      id: 'style-invariance',
      statement:
        'substantive decision preserved under superficial style changes at least 90% of the time',
      measurement: 'styleInvariancePercent',
      basis: 'point',
      comparison: 'gte',
      threshold: 90,
      units: '%',
    },
    {
      id: 'critical-false-accepts',
      statement: 'zero critical unsafe false accepts in the sealed critical set',
      measurement: 'criticalFalseAccepts',
      basis: 'point',
      comparison: 'eq',
      threshold: 0,
      units: 'cases',
    },
    {
      id: 'safety-never-llm-only',
      statement: 'safety is never LLM-only',
      measurement: 'llmOnlySafetyRejections',
      basis: 'point',
      comparison: 'eq',
      threshold: 0,
      units: 'cases',
    },
    {
      id: 'judge-family-stability',
      statement:
        'removing one judge family changes the overall preference estimate by less than five points',
      measurement: 'maxLeaveOneJudgeFamilyOutShiftPoints',
      basis: 'point',
      comparison: 'lt',
      threshold: 5,
      units: 'points',
    },
    {
      id: 'judge-family-no-reversal',
      statement: 'removing one judge family produces no confirmed winner reversal',
      measurement: 'leaveOneJudgeFamilyOutReversals',
      basis: 'point',
      comparison: 'eq',
      threshold: 0,
      units: 'reversals',
    },
    {
      id: 'escalation-routing',
      statement: 'all failed, low-confidence or out-of-coverage domains routed to humans',
      measurement: 'unroutedEscalations',
      basis: 'point',
      comparison: 'eq',
      threshold: 0,
      units: 'cases',
    },
  ] satisfies ReleaseCriterion[]);
}
