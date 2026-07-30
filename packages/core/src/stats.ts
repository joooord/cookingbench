/**
 * M4.4 — supported tiers, multiplicity control, tie-aware pairwise
 * summarisation and influence diagnostics.
 *
 * Pure statistics: no I/O, no model calls, no knowledge of run artifacts. The
 * run-shaped orchestration lives in packages/runner/src/analyze.ts; everything
 * here takes numbers and returns numbers so that a published figure can be
 * recomputed from the committed matrix alone.
 *
 * The module exists because of one defect in what is currently live. Run
 * 2026-07-v2.1 reports "48 of 91 pairs separate" at an unadjusted 95% level.
 * Ninety-one tests at α=0.05 expect roughly four or five false discoveries even
 * if every model were identical, and the board's headline ordering is drawn
 * from exactly that family. Every claim-bearing comparison in here is therefore
 * corrected across its declared family before anything is allowed to call it an
 * ordering, and the word "proven" is unavailable to an uncorrected result (see
 * `separationClaim` / `assertClaimLanguage`).
 *
 * Three further rules the plan states and this module enforces mechanically:
 *
 *  1. Resampling is by SCENARIO FAMILY, not by item. Variants of one scenario
 *     are not independent evidence, and neither are an item's repeats or the
 *     ballots cast on it; drawing them apart manufactures precision the bank
 *     does not have. `effectiveItems` already measured 102 nominal items
 *     behaving like 24.
 *  2. `both_unacceptable` is never a tie. It is an absolute failure, reported
 *     per model as a release-gating signal, excluded from the Davidson fit, and
 *     its exclusion probed by a declared sensitivity analysis because it is
 *     very unlikely to be missing at random.
 *  3. A phantom opponent may shrink estimates but may never connect them. The
 *     real comparison graph is checked for connectivity BEFORE the phantom
 *     exists, because a phantom edge to every model makes any vote set look
 *     connected and invents evidence between clusters that were never compared.
 */

import { classifyPairwise, type PairwiseOutcome } from './graders/pairwise.js';

export class StatsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatsError';
  }
}

/* -------------------------------------------------------------------------- */
/* Determinism primitives                                                     */
/* -------------------------------------------------------------------------- */

/**
 * FNV-1a, the same hash the judge seat rotation and the existing pair seeding
 * use. Exported so every seeded procedure in the project derives its seed the
 * same way and a seed can be recomputed by hand from its label.
 */
export function fnv1a32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/**
 * Deterministic LCG in [0, 1).
 *
 * Bit-for-bit the generator `analyze.ts` has used since 2026-07, kept identical
 * on purpose: moving it here must not move a single published p-value. The
 * multiplier keeps `state * 1664525` below 2^53, so the product is exact.
 */
export function seededUniform(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/* -------------------------------------------------------------------------- */
/* M4.4 — Holm adjustment for named confirmatory comparisons                  */
/* -------------------------------------------------------------------------- */

export interface PValueTest {
  /** Stable identifier for the comparison, e.g. "active:a>b". */
  key: string;
  /** One-sided p-value for the declared direction. */
  p: number;
}

export interface HolmDecision {
  key: string;
  p: number;
  /**
   * Holm step-down adjusted p-value: max over the tests at least as extreme of
   * (m − i)·p_(i), clamped to 1. Comparing this against α is equivalent to the
   * sequential procedure and is what a report should print — an unadjusted p
   * next to a "separated" flag is the thing that produced the current defect.
   */
  pAdjusted: number;
  rejected: boolean;
  /** 1-based position in the ascending p ordering. */
  step: number;
}

/**
 * Holm–Bonferroni over a declared family.
 *
 * Holm is used rather than Bonferroni because it is uniformly more powerful at
 * the same family-wise error rate, and rather than Benjamini–Hochberg because
 * the claim being made is "this ordering is real", not "most of this list is
 * real": a leaderboard that tolerates a 5% false-discovery *rate* is a
 * leaderboard with four wrong rows.
 *
 * The running maximum is not decoration. Without it the adjusted values are
 * non-monotone — a larger raw p can produce a smaller (m−i)·p — and a report
 * that sorted on the adjusted column would show a weaker result above a
 * stronger one. The step-down procedure itself also depends on it: once a test
 * fails, everything above it must fail regardless of its own multiplier.
 */
export function holmAdjust(tests: readonly PValueTest[], alpha = 0.05): HolmDecision[] {
  if (!Array.isArray(tests)) throw new StatsError('holmAdjust: tests must be an array');
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new StatsError(`holmAdjust: alpha must lie in (0, 1), got ${alpha}`);
  }
  if (tests.length === 0) return [];

  const seen = new Set<string>();
  for (const t of tests) {
    if (typeof t.key !== 'string' || t.key.length === 0) {
      throw new StatsError('holmAdjust: every test needs a non-empty key');
    }
    if (seen.has(t.key)) {
      // Two rows with one key means the family size is wrong and the caller
      // cannot tell which decision belongs to which comparison. Refuse rather
      // than silently correcting over a miscounted family.
      throw new StatsError(`holmAdjust: duplicate test key ${JSON.stringify(t.key)}`);
    }
    seen.add(t.key);
    if (!Number.isFinite(t.p) || t.p < 0 || t.p > 1) {
      throw new StatsError(`holmAdjust: p for ${t.key} must lie in [0, 1], got ${t.p}`);
    }
  }

  const m = tests.length;
  // Key as the tie-break so the ordering — and therefore every multiplier — is
  // reproducible when two comparisons return the same p, which is common once
  // a bootstrap p-value hits its 1/(reps+1) floor.
  const ordered = [...tests].sort((x, y) => x.p - y.p || x.key.localeCompare(y.key));
  const out: HolmDecision[] = [];
  let running = 0;
  ordered.forEach((t, i) => {
    running = Math.max(running, Math.min(1, (m - i) * t.p));
    out.push({ key: t.key, p: t.p, pAdjusted: running, rejected: running <= alpha, step: i + 1 });
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* M4.3 — the preregistered minimum practically meaningful difference         */
/* -------------------------------------------------------------------------- */

/**
 * Status of the practical margin, as data rather than prose so a report can
 * print it beside any number derived from one. There is deliberately no
 * default margin constant: a default would be adopted as a decision within a
 * week, exactly as `CRAFT_WEIGHTS` would have been.
 */
export const PRACTICAL_MARGIN_STATUS = 'requires-preregistration' as const;

export interface PracticalMargin {
  /** Points on the 0–100 score scale. Must be strictly positive. */
  points: number;
  /** The frozen document or run id in which the margin was preregistered. */
  preregisteredIn: string;
  /** Who approved it. A margin chosen after seeing the board is not a margin. */
  approvedBy: string;
  /** Why this size — what difference a reader would act on. */
  rationale: string;
}

export function practicalMarginIssues(margin: PracticalMargin | null | undefined): string[] {
  if (margin === null || margin === undefined) {
    return ['no practical margin was supplied; M4.3 requires one to be frozen before the run'];
  }
  const issues: string[] = [];
  if (!Number.isFinite(margin.points) || margin.points <= 0) {
    // Zero is refused as well as negative. A margin of zero collapses the
    // practical-significance requirement into the statistical one and lets a
    // 0.01-point lead be published again, which is the failure M4.4 exists for.
    issues.push(`points must be a finite number greater than zero, got ${margin.points}`);
  }
  for (const field of ['preregisteredIn', 'approvedBy', 'rationale'] as const) {
    const value = margin[field];
    if (typeof value !== 'string' || value.trim().length === 0) {
      issues.push(`${field} must be a non-empty string`);
    }
  }
  return issues;
}

/** Refuses everything short of a real preregistration record. */
export function resolvePracticalMargin(margin: PracticalMargin | null | undefined): number {
  const issues = practicalMarginIssues(margin);
  if (issues.length > 0) {
    throw new StatsError(`Practical margin is not preregistered:\n- ${issues.join('\n- ')}`);
  }
  return margin!.points;
}

/* -------------------------------------------------------------------------- */
/* M4.4 — cluster bootstrap by scenario family                                */
/* -------------------------------------------------------------------------- */

export interface ClusterUnit {
  /**
   * Scenario-family id. Every unit sharing it is drawn or dropped together —
   * item variants, an item's repeated candidate generations and the ballots
   * cast on them. Splitting a family across a resample treats correlated
   * evidence as independent and narrows every interval that follows.
   */
  cluster: string;
  /** Item/response/ballot id, carried through so influence sets are auditable. */
  id: string;
  /** This unit's contribution, e.g. the per-item score difference a − b. */
  value: number;
}

export interface ClusterBootstrapOptions {
  reps?: number;
  /** Seeded per comparison, never from one shared stream — see analyze.ts. */
  seed: string;
  /** Per-comparison two-sided error rate for the reported interval. */
  alpha?: number;
  /**
   * Refuse an interval whose quantile index is resolved by fewer than this many
   * resamples. A Bonferroni-adjusted bound at α/91 from 4,000 draws sits at
   * order statistic 2; printing it as a confidence limit is fiction.
   */
  minOrderStatistics?: number;
}

export interface ClusterBootstrapResult {
  mean: number;
  clusters: number;
  units: number;
  /** Share of resamples in which the mean stayed positive. Descriptive only. */
  pAhead: number;
  /**
   * One-sided bootstrap p-value for H0: mean ≤ 0, with the (1 + k)/(B + 1)
   * correction. Never exactly zero: a p of 0 makes any multiplicity adjustment
   * trivially reject and hides the resolution limit of the resample count.
   */
  pValue: number;
  /** Percentile interval at the requested alpha. */
  lower: number;
  upper: number;
  alpha: number;
  reps: number;
}

function percentile(sorted: readonly number[], q: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[idx]!;
}

/**
 * Bootstrap the mean of `units`, resampling whole clusters with replacement.
 *
 * Refuses a single-cluster input. One cluster resampled with replacement
 * reproduces itself every time, so the interval comes out as a point and the
 * caller is handed zero uncertainty for a comparison that has none of the
 * independent replication an interval assumes.
 */
export function clusterBootstrapMean(
  units: readonly ClusterUnit[],
  opts: ClusterBootstrapOptions,
): ClusterBootstrapResult {
  if (!Array.isArray(units) || units.length === 0) {
    throw new StatsError('clusterBootstrapMean: no units supplied');
  }
  const reps = opts.reps ?? 4000;
  const alpha = opts.alpha ?? 0.05;
  const minOrder = opts.minOrderStatistics ?? 10;
  if (!Number.isInteger(reps) || reps < 100) {
    throw new StatsError(`clusterBootstrapMean: reps must be an integer >= 100, got ${reps}`);
  }
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new StatsError(`clusterBootstrapMean: alpha must lie in (0, 1), got ${alpha}`);
  }
  if (typeof opts.seed !== 'string' || opts.seed.length === 0) {
    throw new StatsError('clusterBootstrapMean: a non-empty seed label is required');
  }

  const byCluster = new Map<string, number[]>();
  for (const u of units) {
    if (typeof u.cluster !== 'string' || u.cluster.length === 0) {
      throw new StatsError(`clusterBootstrapMean: unit ${u.id} has no cluster id`);
    }
    if (!Number.isFinite(u.value)) {
      throw new StatsError(`clusterBootstrapMean: unit ${u.id} has a non-finite value`);
    }
    let bucket = byCluster.get(u.cluster);
    if (!bucket) byCluster.set(u.cluster, (bucket = []));
    bucket.push(u.value);
  }
  if (byCluster.size < 2) {
    throw new StatsError(
      `clusterBootstrapMean: ${byCluster.size} scenario family/families in this comparison; ` +
        'a cluster bootstrap over one cluster reports certainty it has not measured',
    );
  }
  // The reported interval is two-sided, so the binding quantile is alpha/2 and
  // it needs alpha/2·reps order statistics beneath it. This is the guard that
  // stops a Bonferroni bound at 0.05/91 being read off the 2nd of 4,000 draws.
  if ((alpha / 2) * reps < minOrder) {
    throw new StatsError(
      `clusterBootstrapMean: ${reps} resamples resolve the ${alpha / 2} quantile with only ` +
        `${((alpha / 2) * reps).toFixed(1)} order statistics (minimum ${minOrder}); raise reps or widen alpha`,
    );
  }

  const clusters = [...byCluster.keys()].sort();
  const values = clusters.map((c) => byCluster.get(c)!);
  const total = units.reduce((a, u) => a + u.value, 0);
  const mean = total / units.length;

  const rnd = seededUniform(fnv1a32(opts.seed));
  const means: number[] = [];
  let ahead = 0;
  let notAhead = 0;
  for (let rep = 0; rep < reps; rep++) {
    let sum = 0;
    let count = 0;
    for (let k = 0; k < clusters.length; k++) {
      const drawn = values[(rnd() * clusters.length) | 0]!;
      for (const v of drawn) {
        sum += v;
        count += 1;
      }
    }
    // `count` varies between resamples because families differ in size; the
    // statistic is the mean over the drawn units, matching the point estimate.
    const m = count > 0 ? sum / count : 0;
    means.push(m);
    if (m > 0) ahead += 1;
    else notAhead += 1;
  }
  means.sort((a, b) => a - b);

  return {
    mean,
    clusters: clusters.length,
    units: units.length,
    pAhead: ahead / reps,
    pValue: (1 + notAhead) / (reps + 1),
    lower: percentile(means, alpha / 2),
    upper: percentile(means, 1 - alpha / 2),
    alpha,
    reps,
  };
}

/* -------------------------------------------------------------------------- */
/* M4.4 — supported tiers over the FULL pair matrix                           */
/* -------------------------------------------------------------------------- */

export interface OrderedPair {
  /** The model claimed above. */
  a: string;
  b: string;
  /**
   * True only when the declared, multiplicity-adjusted rule ordered the pair.
   * Callers must not pass an unadjusted 95% verdict in here — see
   * `separationClaim` for the vocabulary that keeps the two apart.
   */
  ordered: boolean;
}

export interface SupportedTier {
  /** 1-based tier index, dense and contiguous. */
  tier: number;
  /** Competition place: 1 + the number of models ordered above every member. */
  place: number;
  models: string[];
  /** Set when non-transitivity forced this tier out of a shared place group. */
  splitFrom?: number;
}

export interface SupportedTiersResult {
  tiers: SupportedTier[];
  /** 1 + the number of models ordered above this one, over the full matrix. */
  places: Map<string, number>;
  /** Human-readable notes about any tier that had to be split. */
  splits: string[];
}

/**
 * Statistically indistinguishable groups, built from the full pair matrix.
 *
 * The trap this function exists to avoid is documented in CLAUDE.md and cost a
 * published board: statistical ties DO NOT CHAIN. Walking the adjacent
 * verdicts in 2026-07-v2.1 — each pair tied with the next — merged twelve of
 * fourteen models into one tier and gave Qwen 3.7 Max, 5.3 points off the lead,
 * a share of first place while the direct test had GPT-5.6 Sol Pro beating it
 * at P=1.000. A place is therefore `1 + |{x : x is ordered above m}|` over
 * every pair, and a tier is a group of models with the same place.
 *
 * Places are not monotonic in score and that is correct, not a bug: a model
 * with a wider spread is harder to order, so it can hold a better place than a
 * model above it on points.
 *
 * The second, subtler trap: "ordered" is not transitive either, so two models
 * can arrive at the same place count while one is directly ordered above the
 * other. That group is internally inconsistent as a tier and is split, in
 * `rankOrder`, with the reason recorded. Silently publishing it would put a
 * pair we ordered inside a group labelled indistinguishable.
 */
export function supportedTiers(
  rankOrder: readonly string[],
  pairs: readonly OrderedPair[],
): SupportedTiersResult {
  if (!Array.isArray(rankOrder) || rankOrder.length === 0) {
    throw new StatsError('supportedTiers: rankOrder must list at least one model');
  }
  const models = new Set(rankOrder);
  if (models.size !== rankOrder.length) {
    throw new StatsError('supportedTiers: rankOrder contains a duplicate model');
  }
  const above = new Map<string, Set<string>>(rankOrder.map((m) => [m, new Set<string>()]));
  for (const p of pairs) {
    if (!models.has(p.a) || !models.has(p.b)) {
      throw new StatsError(
        `supportedTiers: pair ${p.a} > ${p.b} names a model absent from rankOrder`,
      );
    }
    if (p.a === p.b) throw new StatsError(`supportedTiers: pair compares ${p.a} with itself`);
    if (p.ordered) above.get(p.b)!.add(p.a);
  }
  for (const m of rankOrder) {
    for (const x of above.get(m)!) {
      if (above.get(x)!.has(m)) {
        // A > B and B > A. Something upstream tested the same pair twice in
        // opposite directions, or an adjusted verdict was mixed with an
        // unadjusted one. No tiering of a cyclic order is defensible.
        throw new StatsError(`supportedTiers: contradictory ordering between ${m} and ${x}`);
      }
    }
  }

  const places = new Map<string, number>();
  for (const m of rankOrder) places.set(m, above.get(m)!.size + 1);

  // Group by place, walking rankOrder so the within-tier order is the board's.
  const groups = new Map<number, string[]>();
  for (const m of rankOrder) {
    const place = places.get(m)!;
    let bucket = groups.get(place);
    if (!bucket) groups.set(place, (bucket = []));
    bucket.push(m);
  }

  const splits: string[] = [];
  const tiers: SupportedTier[] = [];
  for (const place of [...groups.keys()].sort((x, y) => x - y)) {
    const members = groups.get(place)!;
    // Buckets are collected first so that every tier born of a split — the
    // first one included — can be marked. A split group where only the tail
    // carried the marker would read as though the leader had been unaffected.
    const buckets: string[][] = [];
    let current: string[] = [];
    for (const m of members) {
      const conflict = current.find((c) => above.get(m)!.has(c) || above.get(c)!.has(m));
      if (conflict !== undefined) {
        splits.push(
          `place ${place} split: ${m} and ${conflict} share a place count but are directly ordered, ` +
            'so they cannot sit in one indistinguishable group',
        );
        buckets.push(current);
        current = [];
      }
      current.push(m);
    }
    buckets.push(current);
    for (const bucket of buckets) {
      tiers.push({
        tier: tiers.length + 1,
        place,
        models: bucket,
        ...(buckets.length > 1 ? { splitFrom: place } : {}),
      });
    }
  }
  return { tiers, places, splits };
}

/* -------------------------------------------------------------------------- */
/* M4.4 — claim vocabulary                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Phrases an automated report may not produce. "Proven" is the specific word
 * the plan bans for an unadjusted 95% result, and it is currently in this
 * project's own comments and CLI output.
 */
export const FORBIDDEN_CLAIM_PHRASES = Object.freeze([
  'proven better',
  'proven worse',
  'proves better',
  'proved better',
]);

export type EvidenceStrength =
  /** One pair at an uncorrected 95% level. Screening. Not a result. */
  | 'unadjusted-screening'
  /** Holm-adjusted across the declared family, but no practical margin cleared. */
  | 'multiplicity-adjusted'
  /** Holm-adjusted AND the adjusted interval clears zero and the margin. */
  | 'adjusted-and-practical';

const CLAIM_TEXT: Readonly<Record<EvidenceStrength, string>> = Object.freeze({
  'unadjusted-screening':
    'ahead at an uncorrected 95% level — screening only, not a confirmatory ordering',
  'multiplicity-adjusted':
    'ordered after Holm adjustment across the declared family; the practical margin was not cleared',
  'adjusted-and-practical':
    'ordered after Holm adjustment, with the multiplicity-adjusted interval clearing both zero and the preregistered practical margin',
});

/** The only sanctioned wording for a separation verdict. */
export function separationClaim(strength: EvidenceStrength): string {
  const text = CLAIM_TEXT[strength];
  if (text === undefined) throw new StatsError(`separationClaim: unknown strength ${strength}`);
  return text;
}

/** Throws if a report string smuggles a banned phrase back in. */
export function assertClaimLanguage(text: string): void {
  const lower = text.toLowerCase();
  for (const phrase of FORBIDDEN_CLAIM_PHRASES) {
    if (lower.includes(phrase)) {
      throw new StatsError(
        `claim language: "${phrase}" is not available to this project's separation output (M4.4)`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* M4.4 — comparison-graph connectivity                                       */
/* -------------------------------------------------------------------------- */

export interface PairwiseObservation {
  /** Candidate identities, already rewritten out of presentation order. */
  a: string;
  b: string;
  outcome: PairwiseOutcome;
  /** Scenario family, for the clustered resample of a rating. */
  cluster?: string;
}

export interface ComparisonGraph {
  models: string[];
  /** Connected components of the REAL graph, largest first then alphabetical. */
  components: string[][];
  connected: boolean;
  /** Distinct model pairs joined by at least one valid comparison. */
  edges: number;
  /** Models with no valid comparison at all. */
  isolated: string[];
}

/**
 * Components of the real comparison graph.
 *
 * Only a preference or a substantive tie is an edge. `both_unacceptable` says
 * neither answer should be served and carries no information about which is
 * better; `abstain` is missingness. Counting either as an edge would let a
 * cluster of models be "connected" entirely by comparisons that expressed no
 * comparison, and the resulting ratings would order models against each other
 * on no evidence whatsoever.
 *
 * `models` may name roster members with no observations so that they surface as
 * isolated rather than vanishing from the report.
 */
export function comparisonGraph(
  observations: readonly PairwiseObservation[],
  models?: readonly string[],
): ComparisonGraph {
  const nodes = new Set<string>(models ?? []);
  const edgeKeys = new Set<string>();
  const adjacency = new Map<string, Set<string>>();
  const touch = (m: string) => {
    nodes.add(m);
    if (!adjacency.has(m)) adjacency.set(m, new Set());
    return adjacency.get(m)!;
  };
  for (const m of nodes) touch(m);

  for (const o of observations) {
    if (typeof o.a !== 'string' || typeof o.b !== 'string' || !o.a || !o.b) {
      throw new StatsError('comparisonGraph: observation is missing a model id');
    }
    if (o.a === o.b) throw new StatsError(`comparisonGraph: ${o.a} compared with itself`);
    const kind = classifyPairwise(o.outcome); // throws on an unknown outcome
    touch(o.a);
    touch(o.b);
    if (kind !== 'preference' && kind !== 'tie') continue;
    adjacency.get(o.a)!.add(o.b);
    adjacency.get(o.b)!.add(o.a);
    edgeKeys.add([o.a, o.b].sort().join(' '));
  }

  const all = [...nodes].sort();
  const seen = new Set<string>();
  const components: string[][] = [];
  for (const start of all) {
    if (seen.has(start)) continue;
    const stack = [start];
    const comp: string[] = [];
    seen.add(start);
    while (stack.length > 0) {
      const m = stack.pop()!;
      comp.push(m);
      for (const n of adjacency.get(m) ?? []) {
        if (!seen.has(n)) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    comp.sort();
    components.push(comp);
  }
  components.sort((x, y) => y.length - x.length || x[0]!.localeCompare(y[0]!));

  return {
    models: all,
    components,
    connected: all.length > 0 && components.length === 1,
    edges: edgeKeys.size,
    isolated: components.filter((c) => c.length === 1).map((c) => c[0]!),
  };
}

/* -------------------------------------------------------------------------- */
/* M4.4 — Davidson tie-aware Bradley-Terry                                    */
/* -------------------------------------------------------------------------- */

/**
 * Elo-like display scale, identical to the private `toRating` in taste.ts
 * (1500 at strength 1, 400 points per decade). Exported here so the two
 * surfaces cannot drift; taste.ts should import this rather than keep its own
 * copy the next time that file is opened.
 */
export function ratingFromStrength(strength: number): number {
  return 1500 + 400 * Math.log10(strength);
}

export interface DavidsonRating {
  modelId: string;
  strength: number;
  rating: number;
  wins: number;
  losses: number;
  /** SUBSTANTIVE ties only — `equal`. Never a both-unacceptable. */
  ties: number;
  /**
   * Comparisons where the panel rejected both answers. An absolute failure and
   * a release-gating signal, reported per model and excluded from the fit.
   */
  bothUnacceptable: number;
  /** Missingness and coverage, never a tie. */
  abstain: number;
  /** wins + losses + ties: the comparisons that actually entered the fit. */
  valid: number;
}

export interface DavidsonOptions {
  /**
   * Virtual win and loss against an average opponent at strength 1, per model.
   * Regularises the undefeated and the winless, whose MLE strengths are
   * infinite and zero. Applied only AFTER the real graph is proven connected —
   * the phantom shrinks, it never joins.
   */
  phantom?: number;
  maxIterations?: number;
  tolerance?: number;
  /** Roster members to include even with no observations (they are refused). */
  models?: readonly string[];
}

export interface DavidsonFit {
  ratings: DavidsonRating[];
  /**
   * Davidson's tie propensity ν in
   * P(tie) = ν√(π_i π_j) / (π_i + π_j + ν√(π_i π_j)).
   * Exactly 0 when no substantive tie was observed, where the model collapses
   * to ordinary Bradley-Terry.
   */
  nu: number;
  iterations: number;
  graph: ComparisonGraph;
  /** Observations kept out of the likelihood, by reason. */
  excluded: { bothUnacceptable: number; abstain: number };
}

interface Cell {
  /** Wins of the lexicographically first model over the second. */
  wFirst: number;
  wSecond: number;
  ties: number;
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a} ${b}` : `${b} ${a}`;
}

/**
 * Fit Davidson's tie-aware extension of Bradley-Terry by minorization-
 * maximization, the same family of update as taste.ts's fitter.
 *
 * taste.ts cannot simply be called: its model is Bradley-Terry with ties
 * credited half a win each, which is an approximation that treats a tie as
 * evidence of exactly equal strength. Davidson gives ties their own parameter,
 * so a domain where judges tie constantly does not have every strength dragged
 * toward the middle by the tie rate itself. The scaffolding around the
 * likelihood — MM loop, geometric-mean-1 normalisation, phantom prior — is
 * deliberately the same shape so the two fitters stay comparable.
 *
 *   π_i ← W_i / Σ_j n_ij (1 + (ν/2)√(π_j/π_i)) / (π_i + π_j + ν√(π_i π_j))
 *   ν   ← T   / Σ_i<j n_ij √(π_i π_j)          / (π_i + π_j + ν√(π_i π_j))
 *
 * with W_i = Σ_j (w_ij + t_ij/2) and T the total substantive ties. The phantom
 * comparisons are excluded from the ν equation: they contain no ties by
 * construction, so including them would bias the tie propensity downwards in
 * proportion to how much shrinkage was applied.
 */
export function fitDavidson(
  observations: readonly PairwiseObservation[],
  opts: DavidsonOptions = {},
): DavidsonFit {
  const graph = comparisonGraph(observations, opts.models);
  if (graph.models.length < 2) {
    throw new StatsError('fitDavidson: at least two models are required');
  }
  if (!graph.connected) {
    const summary = graph.components.map((c) => `{${c.join(', ')}}`).join(' | ');
    throw new StatsError(
      `fitDavidson: the real comparison graph has ${graph.components.length} disconnected components ${summary}. ` +
        'Ratings across components would be manufactured by the phantom opponent, not measured; ' +
        'compare the components directly or report them separately.',
    );
  }

  const tallies = new Map<string, DavidsonRating>();
  const blank = (modelId: string): DavidsonRating => ({
    modelId,
    strength: 1,
    rating: ratingFromStrength(1),
    wins: 0,
    losses: 0,
    ties: 0,
    bothUnacceptable: 0,
    abstain: 0,
    valid: 0,
  });
  for (const m of graph.models) tallies.set(m, blank(m));

  const cells = new Map<string, Cell>();
  let excludedBoth = 0;
  let excludedAbstain = 0;
  let totalTies = 0;
  for (const o of observations) {
    const ta = tallies.get(o.a)!;
    const tb = tallies.get(o.b)!;
    const kind = classifyPairwise(o.outcome);
    if (kind === 'no-contest') {
      ta.bothUnacceptable += 1;
      tb.bothUnacceptable += 1;
      excludedBoth += 1;
      continue;
    }
    if (kind === 'missing') {
      ta.abstain += 1;
      tb.abstain += 1;
      excludedAbstain += 1;
      continue;
    }
    const key = pairKey(o.a, o.b);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { wFirst: 0, wSecond: 0, ties: 0 }));
    const aIsFirst = o.a < o.b;
    if (kind === 'tie') {
      cell.ties += 1;
      ta.ties += 1;
      tb.ties += 1;
      totalTies += 1;
    } else if (o.outcome === 'a') {
      if (aIsFirst) cell.wFirst += 1;
      else cell.wSecond += 1;
      ta.wins += 1;
      tb.losses += 1;
    } else {
      if (aIsFirst) cell.wSecond += 1;
      else cell.wFirst += 1;
      tb.wins += 1;
      ta.losses += 1;
    }
    ta.valid += 1;
    tb.valid += 1;
  }

  const phantom = opts.phantom ?? 1;
  if (!Number.isFinite(phantom) || phantom < 0) {
    throw new StatsError(`fitDavidson: phantom must be a non-negative number, got ${phantom}`);
  }
  // Real neighbours per model, plus the phantom's fixed contribution.
  interface Edge {
    other: string;
    n: number;
    /** i's wins plus half its ties against `other`. */
    credit: number;
  }
  const edges = new Map<string, Edge[]>(graph.models.map((m) => [m, []]));
  const pairList: Array<{ i: string; j: string; n: number }> = [];
  for (const [key, cell] of [...cells.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const [first, second] = key.split(' ') as [string, string];
    const n = cell.wFirst + cell.wSecond + cell.ties;
    edges.get(first)!.push({ other: second, n, credit: cell.wFirst + cell.ties / 2 });
    edges.get(second)!.push({ other: first, n, credit: cell.wSecond + cell.ties / 2 });
    pairList.push({ i: first, j: second, n });
  }

  const PHANTOM_STRENGTH = 1;
  const strength = new Map<string, number>(graph.models.map((m) => [m, 1]));
  const credit = new Map<string, number>();
  for (const m of graph.models) {
    const own = edges.get(m)!.reduce((a, e) => a + e.credit, 0) + phantom;
    if (own <= 0) {
      // Only reachable with phantom: 0 and a winless, tieless model.
      throw new StatsError(
        `fitDavidson: ${m} has no wins and no ties; its maximum-likelihood strength is zero. ` +
          'Enable the phantom prior (opts.phantom > 0) or exclude the model.',
      );
    }
    credit.set(m, own);
  }

  let nu = totalTies > 0 ? 1 : 0;
  // 10,000, not taste.ts's 500. Alternating the strength sweep with the ν
  // update converges linearly at a rate near 0.97 on tie-heavy data — a
  // three-model fixture needs about 750 sweeps to reach 1e-10, and a 500-cap
  // would refuse a perfectly well-behaved fit. The loop is a few arithmetic
  // operations per pair, so the ceiling costs nothing and only ever bites a
  // genuine divergence.
  const maxIterations = opts.maxIterations ?? 10_000;
  const tolerance = opts.tolerance ?? 1e-10;
  let iterations = 0;
  let converged = false;
  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1;
    let maxDelta = 0;
    for (const i of graph.models) {
      const pi = strength.get(i)!;
      let denom = 0;
      for (const e of edges.get(i)!) {
        const pj = strength.get(e.other)!;
        const g = Math.sqrt(pi * pj);
        denom += (e.n * (1 + (nu / 2) * Math.sqrt(pj / pi))) / (pi + pj + nu * g);
      }
      if (phantom > 0) {
        // Two phantom comparisons (one win, one loss) at strength 1, no ties.
        denom += (2 * phantom * (1 + (nu / 2) * Math.sqrt(PHANTOM_STRENGTH / pi))) /
          (pi + PHANTOM_STRENGTH + nu * Math.sqrt(pi * PHANTOM_STRENGTH));
      }
      if (!(denom > 0) || !Number.isFinite(denom)) {
        throw new StatsError(`fitDavidson: update for ${i} diverged (denominator ${denom})`);
      }
      const next = credit.get(i)! / denom;
      maxDelta = Math.max(maxDelta, Math.abs(Math.log(next) - Math.log(pi)));
      strength.set(i, next);
    }
    // Deliberately NOT renormalised inside the loop, which cost an afternoon.
    // The likelihood is invariant to a common rescaling of every strength, so
    // renormalising looks free — but the phantom is held at strength 1 and is
    // never updated, which already pins the scale. Imposing geometric mean 1 on
    // the real models on top of that is a second, incompatible constraint: the
    // normalised values settle happily while the update keeps returning them
    // multiplied by a constant c ≠ 1, so the step size never reaches zero and
    // the fit refuses itself after 50,000 iterations. Normalisation happens
    // once, at the end, exactly as taste.ts does it.

    if (totalTies > 0) {
      let nuDenom = 0;
      for (const { i, j, n } of pairList) {
        const pi = strength.get(i)!;
        const pj = strength.get(j)!;
        const g = Math.sqrt(pi * pj);
        nuDenom += (n * g) / (pi + pj + nu * g);
      }
      if (nuDenom > 0) {
        const nextNu = totalTies / nuDenom;
        maxDelta = Math.max(maxDelta, Math.abs(nextNu - nu));
        nu = nextNu;
      }
    }
    if (maxDelta < tolerance) {
      converged = true;
      break;
    }
  }
  if (!converged) {
    throw new StatsError(
      `fitDavidson: no convergence in ${maxIterations} iterations; the fit is not reportable`,
    );
  }

  // Normalise the real models to geometric mean 1 for reporting, matching
  // taste.ts so a Davidson rating and a Bradley-Terry rating sit on one scale.
  let logSum = 0;
  for (const m of graph.models) logSum += Math.log(strength.get(m)!);
  const scale = Math.exp(logSum / graph.models.length);

  const ratings: DavidsonRating[] = [];
  for (const m of graph.models) {
    const t = tallies.get(m)!;
    t.strength = strength.get(m)! / scale;
    t.rating = ratingFromStrength(t.strength);
    ratings.push(t);
  }
  ratings.sort((x, y) => y.rating - x.rating || x.modelId.localeCompare(y.modelId));

  return {
    ratings,
    nu,
    iterations,
    graph,
    excluded: { bothUnacceptable: excludedBoth, abstain: excludedAbstain },
  };
}

/* -------------------------------------------------------------------------- */
/* M4.4 — the declared both_unacceptable sensitivity analysis                 */
/* -------------------------------------------------------------------------- */

export const DAVIDSON_SENSITIVITY_SCENARIOS = Object.freeze([
  /** The primary fit: both-unacceptable observations dropped, pairs retained. */
  'primary',
  /**
   * The forbidden collapse, computed as an upper bound on the damage. If a
   * reader ever folds both-unacceptable into `equal`, this is how far the
   * ratings move — a model nobody would serve gains half a win per rejection.
   */
  'both-unacceptable-as-tie',
  /**
   * Drop every observation on any pair that ever produced a both-unacceptable.
   * The MNAR probe: if the exclusion were ignorable the remaining evidence
   * would give the same ordering, so a large shift here is direct evidence
   * that the missingness is informative.
   */
  'drop-affected-pairs',
] as const);
export type DavidsonScenario = (typeof DAVIDSON_SENSITIVITY_SCENARIOS)[number];

export interface DavidsonScenarioResult {
  scenario: DavidsonScenario;
  /** Null when the scenario was refused; `refusal` says why. */
  fit: DavidsonFit | null;
  refusal?: string;
  /** Largest absolute rating movement against the primary fit, in points. */
  maxRatingShift?: number;
  /** Whether the scenario changes which model sits top. */
  leaderChanged?: boolean;
}

export interface DavidsonSummary {
  primary: DavidsonFit;
  scenarios: DavidsonScenarioResult[];
  /** Release gating: rejections per model, never folded into any rating. */
  bothUnacceptableByModel: Array<{ modelId: string; bothUnacceptable: number; rate: number }>;
  /** True when any declared scenario moves the leader. */
  sensitiveToExclusion: boolean;
}

/**
 * Fit the primary Davidson model and the declared sensitivity scenarios.
 *
 * M4.4 requires the sensitivity analysis because both-unacceptable exclusion
 * "may be non-random" — and it plainly is: a model that produces unsafe answers
 * accumulates rejections precisely on the pairs where its weakness shows, so
 * dropping them is dropping its worst evidence. A scenario that cannot be
 * fitted (its graph falls apart, or a model is left winless) is REFUSED and
 * reported as such; substituting the primary fit for it would report the
 * sensitivity analysis as having passed when it never ran.
 */
export function davidsonSummary(
  observations: readonly PairwiseObservation[],
  opts: DavidsonOptions = {},
): DavidsonSummary {
  const primary = fitDavidson(observations, opts);
  const primaryLeader = primary.ratings[0]!.modelId;
  const primaryById = new Map(primary.ratings.map((r) => [r.modelId, r.rating]));

  const affected = new Set<string>();
  for (const o of observations) {
    if (classifyPairwise(o.outcome) === 'no-contest') affected.add(pairKey(o.a, o.b));
  }

  const scenarios: DavidsonScenarioResult[] = [
    { scenario: 'primary', fit: primary, maxRatingShift: 0, leaderChanged: false },
  ];

  const variants: Array<{ scenario: DavidsonScenario; obs: PairwiseObservation[] }> = [
    {
      scenario: 'both-unacceptable-as-tie',
      obs: observations.map((o) =>
        classifyPairwise(o.outcome) === 'no-contest' ? { ...o, outcome: 'equal' as const } : o,
      ),
    },
    {
      scenario: 'drop-affected-pairs',
      obs: observations.filter((o) => !affected.has(pairKey(o.a, o.b))),
    },
  ];

  for (const { scenario, obs } of variants) {
    try {
      const fit = fitDavidson(obs, opts);
      let maxRatingShift = 0;
      for (const r of fit.ratings) {
        const before = primaryById.get(r.modelId);
        if (before === undefined) continue;
        maxRatingShift = Math.max(maxRatingShift, Math.abs(r.rating - before));
      }
      scenarios.push({
        scenario,
        fit,
        maxRatingShift,
        leaderChanged: fit.ratings[0]!.modelId !== primaryLeader,
      });
    } catch (err) {
      scenarios.push({
        scenario,
        fit: null,
        refusal: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const bothUnacceptableByModel = primary.ratings
    .map((r) => ({
      modelId: r.modelId,
      bothUnacceptable: r.bothUnacceptable,
      rate:
        r.valid + r.bothUnacceptable + r.abstain > 0
          ? r.bothUnacceptable / (r.valid + r.bothUnacceptable + r.abstain)
          : 0,
    }))
    .sort((x, y) => y.rate - x.rate || x.modelId.localeCompare(y.modelId));

  return {
    primary,
    scenarios,
    bothUnacceptableByModel,
    // A refused scenario counts as sensitive: we could not show it was safe.
    sensitiveToExclusion: scenarios.some((s) => s.leaderChanged === true || s.fit === null),
  };
}

/* -------------------------------------------------------------------------- */
/* M4.4 — influence: the smallest audited deletion that flips the leader      */
/* -------------------------------------------------------------------------- */

export interface AuditUnitScores {
  /** The auditable unit: an item id, or a scenario-family id when clustered. */
  unit: string;
  /**
   * One ADDITIVE contribution per model — a total, not a mean. Units may hold
   * different numbers of items (scenario families are not the same size), and
   * totals are what keep the arithmetic below exact: both models cover the same
   * items, so deleting a unit changes both denominators identically and the
   * comparison reduces to the sign of the summed difference.
   */
  scores: Readonly<Record<string, number>>;
}

export interface FlipSet {
  leader: string;
  challenger: string;
  /** Units whose deletion flips the leader, largest contribution first. */
  units: string[];
  size: number;
  /** Leader's lead over the challenger, in summed per-unit points, before. */
  marginBefore: number;
  /** …and after the deletion. Negative means the challenger is now ahead. */
  marginAfter: number;
  /** size / total units — the fraction of the evidence the result rests on. */
  share: number;
}

/**
 * The smallest set of audit units whose deletion changes who leads.
 *
 * The greedy-by-largest-difference set really is the minimum, not a heuristic:
 * deleting a unit removes it from both models' means and the denominators stay
 * equal, so "the challenger leads after deleting S" is exactly
 * Σ_{u∉S}(L_u − C_u) < 0. For a given |S| the largest achievable reduction is
 * the sum of the |S| biggest per-unit differences, so the first prefix that
 * clears the margin is the smallest set that can.
 *
 * A unit is a whole scenario family wherever families are declared. Deleting
 * half a family is not an audited deletion: the remaining variants carry the
 * same scenario, and a reviewer asked to check "these three items" cannot check
 * three quarters of a correlated group.
 *
 * Returns null when no proper subset flips the leader — every unit would have
 * to go, which is not a deletion set, it is abandoning the run.
 */
export function smallestFlipSet(units: readonly AuditUnitScores[]): FlipSet | null {
  if (!Array.isArray(units) || units.length === 0) {
    throw new StatsError('smallestFlipSet: no audit units supplied');
  }
  const models = Object.keys(units[0]!.scores).sort();
  if (models.length < 2) throw new StatsError('smallestFlipSet: at least two models are required');
  const seenUnits = new Set<string>();
  for (const u of units) {
    if (seenUnits.has(u.unit)) throw new StatsError(`smallestFlipSet: duplicate unit ${u.unit}`);
    seenUnits.add(u.unit);
    for (const m of models) {
      const v = u.scores[m];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        // The same coverage rule pairwiseSeparation enforces: a mean taken over
        // a different unit set for each model is not a comparison.
        throw new StatsError(`smallestFlipSet: unit ${u.unit} has no finite score for ${m}`);
      }
    }
    if (Object.keys(u.scores).length !== models.length) {
      throw new StatsError(`smallestFlipSet: unit ${u.unit} carries a different model set`);
    }
  }

  const totals = new Map<string, number>(
    models.map((m) => [m, units.reduce((a, u) => a + u.scores[m]!, 0)]),
  );
  const ranked = [...models].sort(
    (x, y) => totals.get(y)! - totals.get(x)! || x.localeCompare(y),
  );
  const leader = ranked[0]!;

  let best: FlipSet | null = null;
  for (const challenger of ranked.slice(1)) {
    const margin = totals.get(leader)! - totals.get(challenger)!;
    const diffs = units
      .map((u) => ({ unit: u.unit, d: u.scores[leader]! - u.scores[challenger]! }))
      .sort((x, y) => y.d - x.d || x.unit.localeCompare(y.unit));
    let removed = 0;
    const taken: string[] = [];
    for (const { unit, d } of diffs) {
      // Never delete the whole run: a "flip" with nothing left is not a result.
      if (taken.length >= units.length - 1) break;
      removed += d;
      taken.push(unit);
      if (margin - removed < 0) {
        const candidate: FlipSet = {
          leader,
          challenger,
          units: [...taken],
          size: taken.length,
          marginBefore: margin,
          marginAfter: margin - removed,
          share: taken.length / units.length,
        };
        if (
          best === null ||
          candidate.size < best.size ||
          (candidate.size === best.size && candidate.challenger < best.challenger)
        ) {
          best = candidate;
        }
        break;
      }
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* M4.4 / M4.5 — rank fragility                                               */
/* -------------------------------------------------------------------------- */

export interface RankFragility {
  modelId: string;
  /** Place in the point estimate, dense competition rank on mean score. */
  publishedPlace: number;
  /** Share of clustered resamples in which the model holds that place. */
  pHoldsPlace: number;
  /** Share in which it has the highest resampled mean (shared on an exact tie). */
  pTopByPoints: number;
  placeRange: [number, number];
}

export interface RankFragilityResult {
  models: RankFragility[];
  /**
   * Share of resamples in which the set of models with the top point-estimate
   * mean is a subset of the published top group. M4.5's provisional target is
   * 0.90, and this is a POINT-ESTIMATE stability, not tier stability under
   * re-testing — recomputing the adjusted tiering inside each resample would be
   * a bootstrap of a bootstrap and is not what this number means.
   */
  topGroupStability: number;
  reps: number;
  clusters: number;
}

export function rankFragility(
  units: readonly AuditUnitScores[],
  clusterOf: ReadonlyMap<string, string>,
  opts: { reps?: number; seed: string },
): RankFragilityResult {
  if (!Array.isArray(units) || units.length === 0) {
    throw new StatsError('rankFragility: no audit units supplied');
  }
  const reps = opts.reps ?? 2000;
  if (!Number.isInteger(reps) || reps < 100) {
    throw new StatsError(`rankFragility: reps must be an integer >= 100, got ${reps}`);
  }
  if (typeof opts.seed !== 'string' || opts.seed.length === 0) {
    throw new StatsError('rankFragility: a non-empty seed label is required');
  }
  const models = Object.keys(units[0]!.scores).sort();

  const byCluster = new Map<string, AuditUnitScores[]>();
  for (const u of units) {
    const cluster = clusterOf.get(u.unit);
    if (cluster === undefined || cluster.length === 0) {
      throw new StatsError(`rankFragility: unit ${u.unit} has no cluster assignment`);
    }
    for (const m of models) {
      if (typeof u.scores[m] !== 'number' || !Number.isFinite(u.scores[m])) {
        throw new StatsError(`rankFragility: unit ${u.unit} has no finite score for ${m}`);
      }
    }
    let bucket = byCluster.get(cluster);
    if (!bucket) byCluster.set(cluster, (bucket = []));
    bucket.push(u);
  }
  if (byCluster.size < 2) {
    throw new StatsError(
      `rankFragility: ${byCluster.size} cluster(s); resampling one cluster reports no variability`,
    );
  }

  const placesFor = (rows: readonly AuditUnitScores[]): Map<string, number> => {
    const mean = new Map<string, number>();
    for (const m of models) {
      mean.set(m, rows.reduce((a, u) => a + u.scores[m]!, 0) / rows.length);
    }
    const places = new Map<string, number>();
    for (const m of models) {
      let better = 0;
      for (const other of models) if (mean.get(other)! > mean.get(m)!) better += 1;
      places.set(m, better + 1);
    }
    return places;
  };

  const published = placesFor(units);
  const publishedTop = new Set(models.filter((m) => published.get(m) === 1));

  const clusters = [...byCluster.keys()].sort();
  const rnd = seededUniform(fnv1a32(opts.seed));
  const holds = new Map<string, number>(models.map((m) => [m, 0]));
  const top = new Map<string, number>(models.map((m) => [m, 0]));
  const lo = new Map<string, number>(models.map((m) => [m, Number.POSITIVE_INFINITY]));
  const hi = new Map<string, number>(models.map((m) => [m, 0]));
  let topGroupStable = 0;

  for (let rep = 0; rep < reps; rep++) {
    const rows: AuditUnitScores[] = [];
    for (let k = 0; k < clusters.length; k++) {
      const drawn = byCluster.get(clusters[(rnd() * clusters.length) | 0]!)!;
      for (const u of drawn) rows.push(u);
    }
    const places = placesFor(rows);
    let subset = true;
    for (const m of models) {
      const place = places.get(m)!;
      if (place === published.get(m)) holds.set(m, holds.get(m)! + 1);
      if (place === 1) {
        top.set(m, top.get(m)! + 1);
        if (!publishedTop.has(m)) subset = false;
      }
      lo.set(m, Math.min(lo.get(m)!, place));
      hi.set(m, Math.max(hi.get(m)!, place));
    }
    if (subset) topGroupStable += 1;
  }

  return {
    models: models
      .map((m) => ({
        modelId: m,
        publishedPlace: published.get(m)!,
        pHoldsPlace: holds.get(m)! / reps,
        pTopByPoints: top.get(m)! / reps,
        placeRange: [lo.get(m)!, hi.get(m)!] as [number, number],
      }))
      .sort((x, y) => x.publishedPlace - y.publishedPlace || x.modelId.localeCompare(y.modelId)),
    topGroupStability: topGroupStable / reps,
    reps,
    clusters: clusters.length,
  };
}
