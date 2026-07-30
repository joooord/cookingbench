/**
 * M4.6 — simulation and power checks.
 *
 * "This tests the analysis design without calling new candidate models." Every
 * function here is pure and seeded: it runs on a synthetic score matrix, or on
 * an ARCHIVED one read out of a finished run. Nothing in this file may make a
 * network call, and nothing may write.
 *
 * The purpose is to find out, before spending money, whether the planned design
 * can detect a difference worth publishing — and, just as important, whether it
 * would announce one that is not there. Two results the archived run already
 * hints at and which the simulators below are built to quantify:
 *
 *   - the published board's per-model intervals (mean half-width 3.58 points)
 *     are wider than the entire spread of the roster (SD 3.42), so "likely
 *     interval width" is not an academic question here;
 *   - `analysis.separation` runs 91 uncorrected pair tests at α=0.05 and 48 of
 *     them came back separated. `multiplicityCheck` measures what that family
 *     size does to the family-wise error rate under a roster of clones.
 *
 * Determinism: every entry point takes a `seed` STRING, hashed with the same
 * FNV-1a the judge rotation and pair seeding use. Seeds are derived per
 * scenario rather than drawn from one shared stream, for the reason analyze.ts
 * documents at length — with a shared stream a scenario's answer depends on how
 * many scenarios ran before it, and adding a case silently moves old results.
 */

import type { Score } from '@cookingbench/core';
import { computeTasteRatings, type TasteVoteRecord } from '@cookingbench/core';
// Relative for the same reason analyze.ts is: core's `exports` map does not
// expose stats.ts yet. One-line change when index.ts re-exports it.
import {
  clusterBootstrapMean,
  fnv1a32,
  holmAdjust,
  rankFragility,
  seededUniform,
  smallestFlipSet,
  type AuditUnitScores,
  type RankFragilityResult,
} from '../../core/src/stats.js';

export class SimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SimulationError';
  }
}

/* -------------------------------------------------------------------------- */
/* Score matrices                                                             */
/* -------------------------------------------------------------------------- */

export interface ScoreMatrix {
  models: string[];
  items: string[];
  /** values[modelIndex][itemIndex]; null means no response was recorded. */
  values: (number | null)[][];
  /**
   * Item → scenario family. Resampling has to move whole families or variants
   * of one scenario are counted as independent evidence. Defaults to each item
   * being its own family, which is what the archived runs actually are.
   */
  clusterOf: Record<string, string>;
}

function matrixValue(m: ScoreMatrix, mi: number, ii: number): number | null {
  return m.values[mi]![ii]!;
}

/** Mean over the items a model actually has, or null when it has none. */
export function modelMean(m: ScoreMatrix, mi: number): number | null {
  let sum = 0;
  let n = 0;
  for (let ii = 0; ii < m.items.length; ii++) {
    const v = matrixValue(m, mi, ii);
    if (v !== null) {
      sum += v;
      n++;
    }
  }
  return n === 0 ? null : sum / n;
}

/** Models ordered by mean, descending; ties broken by id so it is stable. */
export function ordering(m: ScoreMatrix): string[] {
  return m.models
    .map((id, i) => ({ id, mean: modelMean(m, i) ?? Number.NEGATIVE_INFINITY }))
    .sort((a, b) => b.mean - a.mean || a.id.localeCompare(b.id))
    .map((r) => r.id);
}

/**
 * Build a matrix from archived scores. READ-ONLY input; nothing is written.
 *
 * Refuses duplicated (model, item) cells unless the caller declares how to
 * collapse them. Repeated candidate generations are a planned v3 feature and
 * the silent behaviour — last row wins, because a Map overwrote — would make a
 * two-generation run quietly report only its second generation.
 */
export function matrixFromScores(
  scores: readonly Score[],
  opts: { aggregateRepeats?: 'mean' | 'refuse'; clusterOf?: Record<string, string> } = {},
): ScoreMatrix {
  const policy = opts.aggregateRepeats ?? 'refuse';
  const cells = new Map<string, number[]>();
  const models = new Set<string>();
  const items = new Set<string>();
  for (const s of scores) {
    if (!Number.isFinite(s.score)) {
      throw new SimulationError(`Non-finite score for ${s.modelId} × ${s.questionId}.`);
    }
    models.add(s.modelId);
    items.add(s.questionId);
    // JSON-encoded tuple, not a separator character. A literal NUL sat here
    // originally, which made the source file itself binary to grep and every
    // other tool; and any separator that can appear in — or be stripped from
    // — a component is not injective, so ("ab","c") and ("a","bc") collide.
    // firewall.ts learned this the same way and keys its cells the same way.
    const key = JSON.stringify([s.modelId, s.questionId]);
    const bucket = cells.get(key);
    if (bucket) {
      if (policy === 'refuse') {
        throw new SimulationError(
          `Duplicate score row for ${s.modelId} × ${s.questionId}. Pass aggregateRepeats:'mean' to collapse repeated generations deliberately.`,
        );
      }
      bucket.push(s.score);
    } else {
      cells.set(key, [s.score]);
    }
  }
  const modelList = [...models].sort();
  const itemList = [...items].sort();
  const values = modelList.map((m) =>
    itemList.map((q) => {
      const bucket = cells.get(JSON.stringify([m, q]));
      return bucket ? bucket.reduce((a, b) => a + b, 0) / bucket.length : null;
    }),
  );
  return {
    models: modelList,
    items: itemList,
    values,
    clusterOf: opts.clusterOf ?? Object.fromEntries(itemList.map((q) => [q, q])),
  };
}

/** Items every model answered. Any comparison must run over these alone. */
export function completeItems(m: ScoreMatrix): number[] {
  const idx: number[] = [];
  for (let ii = 0; ii < m.items.length; ii++) {
    let complete = true;
    for (let mi = 0; mi < m.models.length; mi++) if (matrixValue(m, mi, ii) === null) complete = false;
    if (complete) idx.push(ii);
  }
  return idx;
}

/** Audit units for the stats helpers, over complete items only. */
export function auditUnits(m: ScoreMatrix): AuditUnitScores[] {
  return completeItems(m).map((ii) => ({
    unit: m.items[ii]!,
    scores: Object.fromEntries(m.models.map((id, mi) => [id, matrixValue(m, mi, ii)!])),
  }));
}

/* -------------------------------------------------------------------------- */
/* Deterministic draws                                                        */
/* -------------------------------------------------------------------------- */

/** Box–Muller on the project's LCG. Two uniforms per draw, no caching, so the
 *  stream position depends only on how many draws were requested. */
function normals(seed: string): () => number {
  const rnd = seededUniform(fnv1a32(seed));
  return () => {
    // log(0) is −∞; the LCG can return exactly 0.
    const u1 = Math.max(rnd(), Number.MIN_VALUE);
    const u2 = rnd();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* -------------------------------------------------------------------------- */
/* The generator                                                              */
/* -------------------------------------------------------------------------- */

export interface SimulationSpec {
  seed: string;
  /** Latent ability per model, as score points around `base`. */
  abilities: number[];
  items: number;
  /** Shared item difficulty — the reason comparisons are paired, not marginal. */
  itemDifficultySd?: number;
  /** Per-cell grader/judge noise. */
  noiseSd?: number;
  base?: number;
  /** Hard cap. The mechanism behind every saturation result in this project. */
  ceiling?: number;
  /** Share of items every model scores at the ceiling regardless of ability. */
  saturatedShare?: number;
  /** Share of items where ability enters NEGATIVELY — a mis-keyed grader. */
  negativeDiscriminationShare?: number;
  /** Multiplier on the ability effect for one item, creating a dominant item. */
  dominantItemMultiplier?: number;
  /** Repeated candidate generations per cell, averaged. Cuts noise by √k. */
  repeats?: number;
  /** Share of cells with no response at all. */
  missingRate?: number;
  /**
   * MCAR drops uniformly. `low-scores` drops preferentially where the model was
   * doing badly, which is the realistic shape: truncation and content filters
   * fire on the hard items, so missingness is exactly not random.
   */
  missingMechanism?: 'mcar' | 'low-scores';
}

/**
 * Generate a score matrix. Every stochastic feature is drawn from one seeded
 * stream in a fixed order, so the same spec always produces the same matrix.
 */
export function simulateScoreMatrix(spec: SimulationSpec): ScoreMatrix {
  if (!Number.isInteger(spec.items) || spec.items < 2) {
    throw new SimulationError(`items must be an integer >= 2, got ${spec.items}`);
  }
  if (!Array.isArray(spec.abilities) || spec.abilities.length < 2) {
    throw new SimulationError('at least two model abilities are required');
  }
  if (typeof spec.seed !== 'string' || spec.seed === '') {
    throw new SimulationError('a non-empty seed label is required');
  }
  const base = spec.base ?? 80;
  const ceiling = spec.ceiling ?? 100;
  const repeats = spec.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1) {
    throw new SimulationError(`repeats must be an integer >= 1, got ${repeats}`);
  }
  const noiseSd = spec.noiseSd ?? 10;
  const gauss = normals(spec.seed);
  const rnd = seededUniform(fnv1a32(`${spec.seed}:structure`));

  const difficulty = Array.from({ length: spec.items }, () => gauss() * (spec.itemDifficultySd ?? 8));
  const saturated = Array.from({ length: spec.items }, () => rnd() < (spec.saturatedShare ?? 0));
  const negative = Array.from({ length: spec.items }, () => rnd() < (spec.negativeDiscriminationShare ?? 0));
  // Item 0 carries the multiplier: a fixed position keeps the scenario legible
  // and the seed already decides everything else about it.
  const dominant = spec.dominantItemMultiplier ?? 1;

  const models = spec.abilities.map((_, i) => `m${String(i).padStart(2, '0')}`);
  const items = Array.from({ length: spec.items }, (_, i) => `q${String(i).padStart(3, '0')}`);

  const values: (number | null)[][] = spec.abilities.map((ability, mi) =>
    Array.from({ length: spec.items }, (_, ii) => {
      if (saturated[ii]) return ceiling;
      const sign = negative[ii] ? -1 : 1;
      const weight = ii === 0 ? dominant : 1;
      let sum = 0;
      for (let r = 0; r < repeats; r++) {
        sum += clamp(base + sign * weight * ability + difficulty[ii]! + gauss() * noiseSd, 0, ceiling);
      }
      // Clip per generation, then average: a model at the ceiling on two of
      // three generations really does keep those two 100s. Averaging first and
      // clipping once would hide the ceiling effect the whole exercise is about.
      void mi;
      return sum / repeats;
    }),
  );

  const missingRate = spec.missingRate ?? 0;
  if (missingRate > 0) {
    const mrnd = seededUniform(fnv1a32(`${spec.seed}:missing`));
    const mech = spec.missingMechanism ?? 'mcar';
    for (let mi = 0; mi < models.length; mi++) {
      for (let ii = 0; ii < items.length; ii++) {
        const v = values[mi]![ii]!;
        // Under 'low-scores' the hazard doubles at 0 and vanishes at the
        // ceiling, so the mean rate stays near `missingRate` while the
        // mechanism is firmly non-random.
        const hazard = mech === 'mcar' ? missingRate : missingRate * 2 * (1 - (v ?? 0) / (ceiling || 1));
        if (mrnd() < hazard) values[mi]![ii] = null;
      }
    }
  }

  return {
    models,
    items,
    values,
    clusterOf: Object.fromEntries(items.map((q) => [q, q])),
  };
}

/* -------------------------------------------------------------------------- */
/* Missingness policy                                                         */
/* -------------------------------------------------------------------------- */

export type MissingPolicy = 'zero' | 'drop-item' | 'pairwise';

/**
 * Resolve missing cells under a declared policy.
 *
 *  - `zero`      what the pipeline does today: an empty answer scores 0 and is
 *                reported as an incident. Honest about transport failure,
 *                brutal when the failure is not the model's fault.
 *  - `drop-item` remove any item that is not complete, so every model is
 *                averaged over the same set. Comparable, but throws away
 *                evidence and shrinks the item pool exactly where models fail.
 *  - `pairwise`  each model keeps its own item set. NEVER safe for ranking —
 *                a model that lost its hardest items is averaged over an easier
 *                benchmark. Provided so the size of that bias can be measured.
 */
export function applyMissingPolicy(m: ScoreMatrix, policy: MissingPolicy): ScoreMatrix {
  if (policy === 'zero') {
    return { ...m, values: m.values.map((row) => row.map((v) => (v === null ? 0 : v))) };
  }
  if (policy === 'pairwise') return m;
  const keep = completeItems(m);
  return {
    models: m.models,
    items: keep.map((ii) => m.items[ii]!),
    values: m.values.map((row) => keep.map((ii) => row[ii]!)),
    clusterOf: Object.fromEntries(keep.map((ii) => [m.items[ii]!, m.clusterOf[m.items[ii]!] ?? m.items[ii]!])),
  };
}

export interface MissingnessResult {
  policy: MissingPolicy;
  missingCells: number;
  itemsRetained: number;
  leader: string;
  ordering: string[];
  /** Point change in the leader's mean against the complete-data reference. */
  leaderMeanShift: number;
  leaderChanged: boolean;
  orderingChanged: boolean;
}

/**
 * How much the missing-response policy alone moves the board.
 *
 * `reference` is the matrix as it would have been with no losses. On archived
 * evidence there is no such matrix, so pass the observed one and read the
 * comparison as policy-versus-policy rather than policy-versus-truth.
 */
export function missingResponseSensitivity(
  observed: ScoreMatrix,
  reference: ScoreMatrix,
  policies: readonly MissingPolicy[] = ['zero', 'drop-item', 'pairwise'],
): MissingnessResult[] {
  const refOrder = ordering(reference);
  const refLeaderMean = modelMean(reference, reference.models.indexOf(refOrder[0]!)) ?? 0;
  const missingCells = observed.values.reduce(
    (a, row) => a + row.filter((v) => v === null).length,
    0,
  );
  return policies.map((policy) => {
    const resolved = applyMissingPolicy(observed, policy);
    const order = ordering(resolved);
    const leader = order[0]!;
    const leaderMean = modelMean(resolved, resolved.models.indexOf(leader)) ?? 0;
    return {
      policy,
      missingCells,
      itemsRetained: resolved.items.length,
      leader,
      ordering: order,
      leaderMeanShift: round(leaderMean - refLeaderMean, 3),
      leaderChanged: leader !== refOrder[0],
      orderingChanged: order.join('>') !== refOrder.join('>'),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Interval width                                                             */
/* -------------------------------------------------------------------------- */

export interface IntervalWidthResult {
  modelId: string;
  mean: number;
  lower: number;
  upper: number;
  halfWidth: number;
}

export interface IntervalWidthSummary {
  models: IntervalWidthResult[];
  medianHalfWidth: number;
  /** Between-model SD of the means. */
  spreadSd: number;
  /**
   * medianHalfWidth ÷ spreadSd. Above 1 the typical model's own uncertainty
   * covers the whole roster and no ordering is readable off the column; run
   * 2026-07-v2.1 sits at about 1.05.
   */
  uncertaintyRatio: number;
  /** M4.5: half-width no larger than half the minimum meaningful difference. */
  meetsTarget: boolean | null;
  targetHalfWidth: number | null;
}

export function intervalWidths(
  m: ScoreMatrix,
  opts: { seed: string; reps?: number; alpha?: number; practicalMarginPoints?: number },
): IntervalWidthSummary {
  const items = completeItems(m);
  if (items.length === 0) throw new SimulationError('no item is complete across every model');
  const results = m.models.map((id, mi) => {
    const r = clusterBootstrapMean(
      items.map((ii) => ({
        cluster: m.clusterOf[m.items[ii]!] ?? m.items[ii]!,
        id: m.items[ii]!,
        value: matrixValue(m, mi, ii)!,
      })),
      { seed: `${opts.seed}:interval:${id}`, reps: opts.reps ?? 2000, alpha: opts.alpha ?? 0.05 },
    );
    return {
      modelId: id,
      mean: round(r.mean, 3),
      lower: round(r.lower, 3),
      upper: round(r.upper, 3),
      halfWidth: round((r.upper - r.lower) / 2, 3),
    };
  });
  const halves = results.map((r) => r.halfWidth).sort((a, b) => a - b);
  const median = halves[Math.floor(halves.length / 2)]!;
  const means = results.map((r) => r.mean);
  const mu = means.reduce((a, b) => a + b, 0) / means.length;
  const spreadSd = Math.sqrt(means.reduce((a, b) => a + (b - mu) ** 2, 0) / means.length);
  // Half the minimum practically meaningful difference (M4.5). Null rather
  // than a default, because inventing the margin here is exactly the move the
  // methodology forbids: a margin chosen after seeing the widths always passes.
  const target = opts.practicalMarginPoints !== undefined ? opts.practicalMarginPoints / 2 : null;
  return {
    models: results,
    medianHalfWidth: round(median, 3),
    spreadSd: round(spreadSd, 3),
    uncertaintyRatio: spreadSd > 0 ? round(median / spreadSd, 3) : Number.POSITIVE_INFINITY,
    meetsTarget: target === null ? null : median <= target,
    targetHalfWidth: target,
  };
}

/* -------------------------------------------------------------------------- */
/* Item-level sensitivity                                                     */
/* -------------------------------------------------------------------------- */

export interface DominantItemResult {
  /** Item with the largest share of between-model variance. */
  itemId: string;
  varianceShare: number;
  /** Inverse Herfindahl of the shares: how many equally-informative items. */
  effectiveItems: number;
  leader: string;
  leaderWithoutItem: string;
  leaderChanged: boolean;
  /** Smallest audited deletion set that flips the leader, if any. */
  flipSize: number | null;
  flipShare: number | null;
}

/**
 * Sensitivity to one dominant item.
 *
 * Two separate questions, deliberately both answered: how concentrated the
 * evidence is (variance share, effective items) and whether the concentration
 * actually matters (does deleting the item, or the smallest deletable set,
 * change who leads). A benchmark can be badly concentrated and still robust,
 * and reporting only the first would overstate the problem.
 */
export function dominantItemSensitivity(m: ScoreMatrix): DominantItemResult {
  const items = completeItems(m);
  if (items.length < 2) throw new SimulationError('at least two complete items are required');
  const variances = items.map((ii) => {
    const col = m.models.map((_, mi) => matrixValue(m, mi, ii)!);
    const mu = col.reduce((a, b) => a + b, 0) / col.length;
    return col.reduce((a, b) => a + (b - mu) ** 2, 0) / col.length;
  });
  const total = variances.reduce((a, b) => a + b, 0);
  const shares = variances.map((v) => (total > 0 ? v / total : 0));
  let top = 0;
  for (let i = 1; i < shares.length; i++) if (shares[i]! > shares[top]!) top = i;
  const herf = shares.reduce((a, s) => a + s * s, 0);

  const withoutIdx = items.filter((_, i) => i !== top);
  const without: ScoreMatrix = {
    models: m.models,
    items: withoutIdx.map((ii) => m.items[ii]!),
    values: m.values.map((row) => withoutIdx.map((ii) => row[ii]!)),
    clusterOf: m.clusterOf,
  };
  const leader = ordering(m)[0]!;
  const leaderWithout = ordering(without)[0]!;
  let flip: { size: number; share: number } | null = null;
  try {
    const f = smallestFlipSet(auditUnits(m));
    flip = f ? { size: f.size, share: f.share } : null;
  } catch {
    // smallestFlipSet refuses fewer than two models or an incomplete unit; a
    // refused influence analysis is reported as "not available", never as zero
    // influence, which is what a swallowed error would look like downstream.
    flip = null;
  }
  return {
    itemId: m.items[items[top]!]!,
    varianceShare: round(shares[top]!, 4),
    effectiveItems: herf > 0 ? round(1 / herf, 1) : 0,
    leader,
    leaderWithoutItem: leaderWithout,
    leaderChanged: leader !== leaderWithout,
    flipSize: flip?.size ?? null,
    flipShare: flip ? round(flip.share, 4) : null,
  };
}

export interface DiscriminationResult {
  itemId: string;
  /** Correlation of the item's scores with each model's mean over OTHER items. */
  itemTotal: number;
  /** Mean score, for reading alongside the correlation. */
  mean: number;
  /** No spread at all: every model scored identically. */
  flat: boolean;
  /** itemTotal <= 0 on an item with spread — a mis-key, ambiguity or judge failure. */
  negative: boolean;
}

/**
 * Corrected item-total correlation per item (M4.9's first-line diagnostic).
 *
 * "Corrected" — the item is excluded from the total it is correlated against.
 * Without that correction every item correlates with itself through the total,
 * which inflates short benchmarks most and would make a 20-item set look
 * uniformly well-behaved.
 *
 * A flat item is reported as flat, not as negative. Zero variance gives an
 * undefined correlation, and the two conditions have different fixes: a flat
 * item is saturated, a negative one is probably wrong.
 */
export function negativeDiscriminationScan(m: ScoreMatrix): DiscriminationResult[] {
  const items = completeItems(m);
  return items.map((ii) => {
    const col = m.models.map((_, mi) => matrixValue(m, mi, ii)!);
    const rest = m.models.map((_, mi) => {
      let sum = 0;
      let n = 0;
      for (const jj of items) {
        if (jj === ii) continue;
        sum += matrixValue(m, mi, jj)!;
        n++;
      }
      return n === 0 ? 0 : sum / n;
    });
    const r = correlation(col, rest);
    const mu = col.reduce((a, b) => a + b, 0) / col.length;
    const flat = col.every((v) => v === col[0]);
    return {
      itemId: m.items[ii]!,
      itemTotal: r === null ? 0 : round(r, 4),
      mean: round(mu, 2),
      flat,
      negative: !flat && r !== null && r <= 0,
    };
  });
}

function correlation(a: readonly number[], b: readonly number[]): number | null {
  const ma = a.reduce((x, y) => x + y, 0) / a.length;
  const mb = b.reduce((x, y) => x + y, 0) / b.length;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i]! - ma) * (b[i]! - mb);
    saa += (a[i]! - ma) ** 2;
    sbb += (b[i]! - mb) ** 2;
  }
  return saa <= 0 || sbb <= 0 ? null : sab / Math.sqrt(saa * sbb);
}

/* -------------------------------------------------------------------------- */
/* Judge severity and the ceiling                                             */
/* -------------------------------------------------------------------------- */

export interface SeverityResult {
  shiftPoints: number;
  meanScore: number;
  leader: string;
  leaderChanged: boolean;
  orderingChanged: boolean;
  /** Between-model SD after the shift — the discrimination that survives. */
  spreadSd: number;
}

/**
 * Impact of judge severity.
 *
 * Worth being precise about, because the naive expectation is wrong in both
 * directions. An additive shift applied to a fixed set of items, on a matrix
 * where every model answers every item, moves every model's mean by exactly
 * the same amount — it is a constant, and it cannot reorder anything. Even
 * restricting it to the judged subset does not help: the subset is the same
 * subset for everyone.
 *
 * Severity therefore bites through two channels only, and both are modelled:
 *
 *   - the CEILING. A strict judge pushes a saturated roster off 100 and
 *     *creates* discrimination; a lenient one presses everyone against the cap
 *     and destroys it. Clipping is non-linear, so it reorders.
 *   - UNEQUAL COVERAGE. A model missing some judged items takes a smaller
 *     share of the shift than one that answered them all, so severity and the
 *     missing-response policy interact. Pass the raw matrix (nulls intact) to
 *     see it; pass a drop-item matrix and it is invisible by construction.
 *
 * `judgedItems` matters for the ceiling channel: shifting unjudged
 * deterministic items too would exaggerate how much of the board a judge
 * controls.
 */
export function judgeSeveritySensitivity(
  m: ScoreMatrix,
  opts: { shifts?: readonly number[]; judgedItems?: readonly string[]; ceiling?: number } = {},
): SeverityResult[] {
  const shifts = opts.shifts ?? [-15, -5, 0, 5, 15];
  const ceiling = opts.ceiling ?? 100;
  const judged = opts.judgedItems ? new Set(opts.judgedItems) : null;
  const baseOrder = ordering(m);
  return shifts.map((shift) => {
    const shifted: ScoreMatrix = {
      ...m,
      values: m.values.map((row) =>
        row.map((v, ii) => {
          if (v === null) return null;
          if (judged && !judged.has(m.items[ii]!)) return v;
          return clamp(v + shift, 0, ceiling);
        }),
      ),
    };
    const order = ordering(shifted);
    const means = shifted.models.map((_, mi) => modelMean(shifted, mi) ?? 0);
    const mu = means.reduce((a, b) => a + b, 0) / means.length;
    return {
      shiftPoints: shift,
      meanScore: round(mu, 3),
      leader: order[0]!,
      leaderChanged: order[0] !== baseOrder[0],
      orderingChanged: order.join('>') !== baseOrder.join('>'),
      spreadSd: round(Math.sqrt(means.reduce((a, b) => a + (b - mu) ** 2, 0) / means.length), 3),
    };
  });
}

export interface CeilingResult {
  ceiling: number;
  allPerfectItems: number;
  itemsWithSignal: number;
  spreadSd: number;
  /** Complete items whose scores are identical for every model. */
  deadItems: number;
}

/** Saturation and ceiling scenarios: what a cap does to the usable evidence. */
export function ceilingSensitivity(m: ScoreMatrix, ceilings: readonly number[] = [100, 95, 90]): CeilingResult[] {
  const items = completeItems(m);
  return ceilings.map((ceiling) => {
    const capped = m.values.map((row) => row.map((v) => (v === null ? null : Math.min(v, ceiling))));
    let allPerfect = 0;
    let withSignal = 0;
    let dead = 0;
    for (const ii of items) {
      const col = m.models.map((_, mi) => capped[mi]![ii]!);
      if (col.every((v) => v === ceiling)) allPerfect++;
      const mu = col.reduce((a, b) => a + b, 0) / col.length;
      const sd = Math.sqrt(col.reduce((a, b) => a + (b - mu) ** 2, 0) / col.length);
      if (sd > 1) withSignal++;
      if (sd === 0) dead++;
    }
    const means = m.models.map((_, mi) => {
      const row = items.map((ii) => capped[mi]![ii]!);
      return row.reduce((a, b) => a + b, 0) / row.length;
    });
    const mu = means.reduce((a, b) => a + b, 0) / means.length;
    return {
      ceiling,
      allPerfectItems: allPerfect,
      itemsWithSignal: withSignal,
      deadItems: dead,
      spreadSd: round(Math.sqrt(means.reduce((a, b) => a + (b - mu) ** 2, 0) / means.length), 3),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Power, design and multiplicity                                             */
/* -------------------------------------------------------------------------- */

/** Resamples in which `diffs` summed positive. The published test's raw count. */
function pairedAheadCount(diffs: readonly number[], seed: string, reps: number): number {
  const rnd = seededUniform(fnv1a32(seed));
  let ahead = 0;
  for (let rep = 0; rep < reps; rep++) {
    let sum = 0;
    for (let k = 0; k < diffs.length; k++) sum += diffs[(rnd() * diffs.length) | 0]!;
    if (sum > 0) ahead++;
  }
  return ahead;
}

/** Share of paired resamples in which `diffs` stays positive. The published test. */
function pairedPAhead(diffs: readonly number[], seed: string, reps: number): number {
  return pairedAheadCount(diffs, seed, reps) / reps;
}

/**
 * Two-sided bootstrap p-value with the (1 + k)/(B + 1) correction.
 *
 * The correction is load-bearing, and its absence was a real defect in this
 * function's first version: without it a pair that led in all 300 resamples
 * gets p = 0 exactly, p = 0 clears every multiplicity threshold however small,
 * and the Holm arm of the check below reported a family-wise error of 0.8 —
 * making a correct procedure look broken because the input was not a p-value.
 */
function pairedPValue(ahead: number, reps: number): number {
  const forward = (1 + (reps - ahead)) / (reps + 1);
  const reverse = (1 + ahead) / (reps + 1);
  return Math.min(1, 2 * Math.min(forward, reverse));
}

export interface PowerPoint {
  items: number;
  gapPoints: number;
  /** Share of simulated runs where the paired bootstrap separated the pair. */
  power: number;
  sims: number;
}

/**
 * Detection rate for a true gap of `gapPoints`, at each item count.
 *
 * Runs the ACTUAL published procedure (paired item bootstrap, threshold 0.95)
 * on simulated data rather than a normal approximation of it, because the
 * procedure is what will be used and the approximation is exactly the sort of
 * thing that quietly disagrees with it on 100 heavily-tied items.
 */
export function powerCurve(opts: {
  seed: string;
  gapPoints: number;
  itemCounts: readonly number[];
  sims?: number;
  bootstrapReps?: number;
  noiseSd?: number;
  itemDifficultySd?: number;
  ceiling?: number;
  base?: number;
  saturatedShare?: number;
}): PowerPoint[] {
  const sims = opts.sims ?? 200;
  const reps = opts.bootstrapReps ?? 800;
  return opts.itemCounts.map((items) => {
    let detected = 0;
    for (let s = 0; s < sims; s++) {
      const m = simulateScoreMatrix({
        seed: `${opts.seed}:power:${items}:${opts.gapPoints}:${s}`,
        abilities: [opts.gapPoints / 2, -opts.gapPoints / 2],
        items,
        noiseSd: opts.noiseSd ?? 10,
        itemDifficultySd: opts.itemDifficultySd ?? 8,
        ceiling: opts.ceiling ?? 100,
        base: opts.base ?? 80,
        saturatedShare: opts.saturatedShare ?? 0,
      });
      const diffs = completeItems(m).map((ii) => matrixValue(m, 0, ii)! - matrixValue(m, 1, ii)!);
      if (pairedPAhead(diffs, `${opts.seed}:boot:${items}:${s}`, reps) >= 0.95) detected++;
    }
    return { items, gapPoints: opts.gapPoints, power: round(detected / sims, 3), sims };
  });
}

export interface DesignRequirement {
  targetHalfWidth: number;
  /** Smallest (items, repeats) pair from the supplied grid that reaches it. */
  items: number | null;
  repeats: number | null;
  predictedHalfWidth: number | null;
  /** Null result means no grid point qualifies; the reason says which way. */
  refusal: string | null;
}

/**
 * How many items and repeated generations a target interval width needs.
 *
 * Analytic, then deliberately conservative about it: the half-width of a mean
 * over n items with k repeats is about 1.96·√(itemVar/n + genVar/(n·k)).
 * Repeats only ever divide the GENERATION component, so a design whose noise is
 * item-driven cannot be rescued by re-rolling the same items — which is the
 * answer to "should we run each model three times?" for a benchmark whose
 * variance is 24 effective items wide.
 */
export function designRequirements(opts: {
  targetHalfWidth: number;
  itemVariance: number;
  generationVariance: number;
  itemGrid?: readonly number[];
  repeatGrid?: readonly number[];
}): DesignRequirement {
  const { targetHalfWidth, itemVariance, generationVariance } = opts;
  if (!(targetHalfWidth > 0)) {
    throw new SimulationError(`targetHalfWidth must be positive, got ${targetHalfWidth}`);
  }
  if (itemVariance < 0 || generationVariance < 0) {
    throw new SimulationError('variance components must be non-negative');
  }
  const itemGrid = opts.itemGrid ?? [25, 50, 100, 150, 200, 300, 500];
  const repeatGrid = opts.repeatGrid ?? [1, 2, 3, 5];
  let best: { items: number; repeats: number; hw: number } | null = null;
  for (const items of [...itemGrid].sort((a, b) => a - b)) {
    for (const repeats of [...repeatGrid].sort((a, b) => a - b)) {
      const hw = 1.96 * Math.sqrt(itemVariance / items + generationVariance / (items * repeats));
      if (hw <= targetHalfWidth) {
        // Cheapest first: the grids are sorted ascending and the first hit
        // costs the fewest inference calls (items × repeats), because repeats
        // multiply cost while dividing only part of the variance.
        if (!best || items * repeats < best.items * best.repeats) best = { items, repeats, hw };
      }
    }
  }
  if (!best) {
    const floor = 1.96 * Math.sqrt(itemVariance / Math.max(...itemGrid));
    return {
      targetHalfWidth,
      items: null,
      repeats: null,
      predictedHalfWidth: null,
      refusal:
        floor > targetHalfWidth
          ? `Unreachable on this grid: even ${Math.max(...itemGrid)} items leave a half-width of ${floor.toFixed(2)}, and repeats do not reduce the item component.`
          : 'No grid point reaches the target.',
    };
  }
  return {
    targetHalfWidth,
    items: best.items,
    repeats: best.repeats,
    predictedHalfWidth: round(best.hw, 3),
    refusal: null,
  };
}

export interface MultiplicityResult {
  models: number;
  pairs: number;
  sims: number;
  alpha: number;
  /** Share of simulated null rosters where ANY pair was called separated. */
  familywiseErrorUncorrected: number;
  /** Same, after Holm over the full pair family. */
  familywiseErrorHolm: number;
  /** Mean number of falsely separated pairs per null roster, uncorrected. */
  falsePairsPerRun: number;
  /**
   * Whether the resample count can resolve the smallest Holm threshold at all.
   *
   * The smallest attainable bootstrap p is 1/(reps+1), and Holm's tightest step
   * is α/m. With 91 pairs at α=0.05 that needs about 1,800 resamples; below it
   * NOTHING can be rejected and `familywiseErrorHolm` comes out 0 for a reason
   * that has nothing to do with Holm. False here means the Holm arm is a
   * resolution artefact and must not be quoted.
   */
  holmResolvable: boolean;
  bootstrapReps: number;
}

/**
 * What the 91-pair screening family does under a roster of clones.
 *
 * Every model here has identical ability, so every separation is false. This
 * is the number that decides whether `analysis.separation` may be quoted as an
 * ordering: at α=0.05 and 91 tests, "48 of 91 pairs separated" needs a
 * baseline, and the baseline is not zero.
 *
 * Defaults are small on purpose — the nested loops are sims × pairs × reps ×
 * items — so raise them before quoting a figure, and keep the seed.
 */
export function multiplicityCheck(opts: {
  seed: string;
  models: number;
  items: number;
  sims?: number;
  bootstrapReps?: number;
  alpha?: number;
  noiseSd?: number;
  itemDifficultySd?: number;
}): MultiplicityResult {
  const sims = opts.sims ?? 50;
  const reps = opts.bootstrapReps ?? 300;
  const alpha = opts.alpha ?? 0.05;
  if (opts.models < 2) throw new SimulationError('multiplicityCheck needs at least two models');
  let anyUncorrected = 0;
  let anyHolm = 0;
  let falsePairs = 0;
  const pairCount = (opts.models * (opts.models - 1)) / 2;
  for (let s = 0; s < sims; s++) {
    const m = simulateScoreMatrix({
      seed: `${opts.seed}:null:${s}`,
      abilities: Array.from({ length: opts.models }, () => 0),
      items: opts.items,
      noiseSd: opts.noiseSd ?? 10,
      itemDifficultySd: opts.itemDifficultySd ?? 8,
    });
    const items = completeItems(m);
    const tests: { key: string; p: number }[] = [];
    let falseHere = 0;
    for (let a = 0; a < opts.models; a++) {
      for (let b = a + 1; b < opts.models; b++) {
        const diffs = items.map((ii) => matrixValue(m, a, ii)! - matrixValue(m, b, ii)!);
        const ahead = pairedAheadCount(diffs, `${opts.seed}:pair:${s}:${a}:${b}`, reps);
        // Two-sided in effect: the board tests whichever model leads, so the
        // false-positive opportunity exists in both directions. Testing only
        // a>b would halve the measured error rate for the wrong reason.
        const pAhead = Math.max(ahead / reps, 1 - ahead / reps);
        if (pAhead >= 1 - alpha) falseHere++;
        tests.push({ key: `${a}:${b}`, p: pairedPValue(ahead, reps) });
      }
    }
    falsePairs += falseHere;
    if (falseHere > 0) anyUncorrected++;
    if (holmAdjust(tests, alpha).some((d) => d.rejected)) anyHolm++;
  }
  return {
    models: opts.models,
    pairs: pairCount,
    sims,
    alpha,
    familywiseErrorUncorrected: round(anyUncorrected / sims, 3),
    familywiseErrorHolm: round(anyHolm / sims, 3),
    falsePairsPerRun: round(falsePairs / sims, 2),
    holmResolvable: 1 / (reps + 1) <= alpha / pairCount,
    bootstrapReps: reps,
  };
}

/** Rank fragility over the matrix, clustered by scenario family. */
export function rankFragilityOnMatrix(
  m: ScoreMatrix,
  opts: { seed: string; reps?: number },
): RankFragilityResult {
  const units = auditUnits(m);
  const clusterOf = new Map(units.map((u) => [u.unit, m.clusterOf[u.unit] ?? u.unit]));
  return rankFragility(units, clusterOf, { seed: opts.seed, reps: opts.reps ?? 2000 });
}

/* -------------------------------------------------------------------------- */
/* Culinary JudgeBench sizing                                                 */
/* -------------------------------------------------------------------------- */

export interface JudgeBenchStratum {
  name: string;
  /** Share of the sample this stratum should carry. Must sum to 1. */
  weight: number;
  /** Expected agreement in this stratum; safety strata are usually lower. */
  expectedAgreement: number;
}

export interface JudgeBenchStratumSize {
  name: string;
  weight: number;
  expectedAgreement: number;
  /** Cases needed for the target half-width IN this stratum. */
  required: number;
  /** Cases this stratum receives if the total is allocated by weight. */
  allocated: number;
  shortfall: number;
}

export interface JudgeBenchSizing {
  targetHalfWidth: number;
  confidence: number;
  strata: JudgeBenchStratumSize[];
  /** Total driven by the neediest stratum, not by the pooled estimate. */
  totalCases: number;
  refusals: string[];
}

/**
 * Sample size and composition for Culinary JudgeBench.
 *
 * Wilson, searched numerically, not Wald. Judge-agreement studies live at
 * p ≈ 0.85–0.95 where the Wald interval is both too narrow and capable of
 * exceeding 1, and sizing a study with it under-recruits by a third exactly
 * where the estimate matters most.
 *
 * The total is set by the stratum that needs the most cases once allocation is
 * done by weight, not by a pooled n. A pooled sample that is adequate overall
 * and thin on the dangerous-premise stratum cannot answer the safety question,
 * which is the only question the panel is non-compensatory about.
 */
export function judgeBenchSampleSize(opts: {
  strata: readonly JudgeBenchStratum[];
  targetHalfWidth: number;
  confidence?: number;
  minPerStratum?: number;
  maxCases?: number;
}): JudgeBenchSizing {
  const refusals: string[] = [];
  const confidence = opts.confidence ?? 0.95;
  const z = zFor(confidence);
  const minPerStratum = opts.minPerStratum ?? 30;
  const maxCases = opts.maxCases ?? 20000;
  if (!(opts.targetHalfWidth > 0) || opts.targetHalfWidth >= 0.5) {
    refusals.push(`targetHalfWidth must lie in (0, 0.5); got ${opts.targetHalfWidth}.`);
  }
  if (opts.strata.length === 0) refusals.push('No strata declared.');
  const weightSum = opts.strata.reduce((a, s) => a + s.weight, 0);
  if (Math.abs(weightSum - 1) > 1e-6) {
    refusals.push(`Stratum weights sum to ${weightSum.toFixed(4)}, not 1. An undeclared remainder is an undeclared stratum.`);
  }
  for (const s of opts.strata) {
    if (!(s.weight > 0)) refusals.push(`Stratum '${s.name}' has weight ${s.weight}; a zero-weight stratum is not in the design.`);
    if (!(s.expectedAgreement > 0 && s.expectedAgreement < 1)) {
      refusals.push(`Stratum '${s.name}' expects agreement ${s.expectedAgreement}; must lie in (0, 1).`);
    }
  }
  if (refusals.length > 0) {
    return { targetHalfWidth: opts.targetHalfWidth, confidence, strata: [], totalCases: 0, refusals };
  }

  const required = opts.strata.map((s) => ({
    stratum: s,
    n: Math.max(minPerStratum, wilsonRequiredN(s.expectedAgreement, opts.targetHalfWidth, z, maxCases)),
  }));
  // Allocation by weight, then scale the total up until every stratum's share
  // clears its own requirement.
  let total = 0;
  for (const r of required) total = Math.max(total, Math.ceil(r.n / r.stratum.weight));
  const strata: JudgeBenchStratumSize[] = required.map((r) => {
    const allocated = Math.round(total * r.stratum.weight);
    return {
      name: r.stratum.name,
      weight: r.stratum.weight,
      expectedAgreement: r.stratum.expectedAgreement,
      required: r.n,
      allocated,
      shortfall: Math.max(0, r.n - allocated),
    };
  });
  if (required.some((r) => r.n >= maxCases)) {
    refusals.push(
      `At least one stratum needs ${maxCases}+ cases for a ±${opts.targetHalfWidth} half-width; widen the target or accept a coarser claim.`,
    );
  }
  return { targetHalfWidth: opts.targetHalfWidth, confidence, strata, totalCases: total, refusals };
}

/** Smallest n whose Wilson interval at `p` is no wider than ±`half`. */
function wilsonRequiredN(p: number, half: number, z: number, cap: number): number {
  for (let n = 5; n <= cap; n++) {
    const denom = 1 + (z * z) / n;
    const centre = (p + (z * z) / (2 * n)) / denom;
    const spread = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
    // Wilson is asymmetric; use the wider side so the claim holds on both.
    if (Math.max(centre + spread - p, p - (centre - spread)) <= half) return n;
  }
  return cap;
}

/** Normal quantiles for the confidence levels a release gate actually uses. */
function zFor(confidence: number): number {
  const table: Record<string, number> = { '0.9': 1.6449, '0.95': 1.96, '0.99': 2.5758 };
  const z = table[String(confidence)];
  if (z === undefined) {
    throw new SimulationError(
      `Unsupported confidence level ${confidence}. Add it to the table deliberately rather than interpolating a quantile.`,
    );
  }
  return z;
}

/* -------------------------------------------------------------------------- */
/* Taste publication thresholds                                               */
/* -------------------------------------------------------------------------- */

export interface TasteThresholdPoint {
  battlesPerModel: number;
  votes: number;
  /** Median half-width of the bootstrap CI on the Bradley–Terry rating. */
  medianHalfWidth: number;
  /** Share of simulations where the true best model came top on rating. */
  topCorrect: number;
  /** Share where a model with a CI at all was produced (needs >= 5 battles). */
  ratedShare: number;
}

/**
 * Publication threshold for Taste ratings.
 *
 * The site currently publishes a Taste column at five battles. This simulates
 * votes from known Bradley–Terry strengths and measures what a rating is worth
 * at each volume: the interval half-width, and how often the true best model
 * actually comes top. Five battles is the hypothesis being tested, not an
 * input to trust — and the live board has 26 ballots in total.
 *
 * Costly: each simulation refits the MM iteration `bootstrap` times. Keep the
 * defaults small and raise them for a real report.
 */
export function tastePublicationThreshold(opts: {
  seed: string;
  /** True latent strengths, one per model. Ratios drive win probabilities. */
  strengths: readonly number[];
  battlesLadder?: readonly number[];
  sims?: number;
  bootstrap?: number;
  tieRate?: number;
}): TasteThresholdPoint[] {
  const ladder = opts.battlesLadder ?? [5, 10, 25, 50];
  const sims = opts.sims ?? 20;
  const bootstrap = opts.bootstrap ?? 100;
  const tieRate = opts.tieRate ?? 0.1;
  if (opts.strengths.length < 2) throw new SimulationError('at least two strengths are required');
  // p = s_a/(s_a+s_b) is meaningless for a non-positive strength, and a pair of
  // zeroes divides by zero into a NaN that would sample as a silent 'b' win.
  for (const s of opts.strengths) {
    if (!Number.isFinite(s) || s <= 0) {
      throw new SimulationError(`Bradley–Terry strengths must be finite and positive, got ${s}`);
    }
  }
  if (!(opts.tieRate === undefined || (opts.tieRate >= 0 && opts.tieRate < 1))) {
    throw new SimulationError(`tieRate must lie in [0, 1), got ${opts.tieRate}`);
  }
  const models = opts.strengths.map((_, i) => `taste-m${i}`);
  let trueTop = 0;
  for (let i = 1; i < opts.strengths.length; i++) {
    if (opts.strengths[i]! > opts.strengths[trueTop]!) trueTop = i;
  }

  return ladder.map((battlesPerModel) => {
    const halves: number[] = [];
    let correct = 0;
    let rated = 0;
    const totalVotes = Math.round((battlesPerModel * models.length) / 2);
    for (let s = 0; s < sims; s++) {
      const rnd = seededUniform(fnv1a32(`${opts.seed}:taste:${battlesPerModel}:${s}`));
      const votes: TasteVoteRecord[] = [];
      for (let v = 0; v < totalVotes; v++) {
        const a = (rnd() * models.length) | 0;
        let b = (rnd() * models.length) | 0;
        if (b === a) b = (b + 1) % models.length;
        const pa = opts.strengths[a]! / (opts.strengths[a]! + opts.strengths[b]!);
        const draw = rnd();
        const winner: TasteVoteRecord['winner'] =
          draw < tieRate ? 'tie' : rnd() < pa ? 'a' : 'b';
        votes.push({
          run_id: 'sim',
          question_id: `q${v % 20}`,
          model_a: models[a]!,
          model_b: models[b]!,
          winner,
        });
      }
      const ratings = computeTasteRatings(votes, { bootstrap, seed: 1234 + s });
      const withCi = ratings.filter((r) => r.ci95);
      rated += withCi.length / models.length;
      for (const r of withCi) halves.push((r.ci95![1] - r.ci95![0]) / 2);
      if (ratings[0]?.modelId === models[trueTop]) correct++;
    }
    halves.sort((a, b) => a - b);
    return {
      battlesPerModel,
      votes: totalVotes,
      // Zero half-widths would be reported as a suspiciously good result, so
      // an empty list reports Infinity: nothing was rated, not "perfectly".
      medianHalfWidth: halves.length ? round(halves[Math.floor(halves.length / 2)]!, 2) : Number.POSITIVE_INFINITY,
      topCorrect: round(correct / sims, 3),
      ratedShare: round(rated / sims, 3),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Suite                                                                      */
/* -------------------------------------------------------------------------- */

export interface SimulationSuiteOptions {
  seed: string;
  /** Archived matrix, e.g. from `matrixFromScores(readScores(runId))`. */
  matrix?: ScoreMatrix;
  /** Items scored by the judge panel, for the severity scenario. */
  judgedItems?: readonly string[];
  practicalMarginPoints?: number;
  /**
   * Cheap defaults; a published report should raise these and say so. `reps`
   * has a hard floor set by the interval: at α=0.05 the 0.025 quantile needs
   * ten order statistics, so anything below 400 is refused by
   * `clusterBootstrapMean` rather than silently producing a two-draw bound.
   */
  reps?: number;
  sims?: number;
}

export interface SimulationReport {
  seed: string;
  generatedAt: string;
  source: 'archived' | 'simulated';
  intervals: IntervalWidthSummary;
  dominantItem: DominantItemResult;
  severity: SeverityResult[];
  ceiling: CeilingResult[];
  negativeDiscrimination: DiscriminationResult[];
  missingness: MissingnessResult[];
  power: PowerPoint[];
  design: DesignRequirement;
  multiplicity: MultiplicityResult;
  fragility: RankFragilityResult;
  judgeBench: JudgeBenchSizing;
  taste: TasteThresholdPoint[];
}

/**
 * Run every M4.6 check. Entry point for the CLI wiring (see
 * docs/wp-0/INTEGRATION-NOTES.md); it takes an already-loaded matrix so this
 * module never touches the filesystem.
 *
 * `generatedAt` is the only non-deterministic field. Everything else is a pure
 * function of `seed` and the matrix, which is the point.
 */
export function runSimulationSuite(opts: SimulationSuiteOptions): SimulationReport {
  const reps = opts.reps ?? 1000;
  const sims = opts.sims ?? 50;
  const matrix =
    opts.matrix ??
    simulateScoreMatrix({
      seed: `${opts.seed}:fallback`,
      abilities: [6, 4, 2, 0, -2, -4, -6],
      items: 100,
      saturatedShare: 0.3,
    });
  const complete = applyMissingPolicy(matrix, 'drop-item');
  const itemVariance = varianceOfItemMeans(complete);
  return {
    seed: opts.seed,
    generatedAt: new Date().toISOString(),
    source: opts.matrix ? 'archived' : 'simulated',
    intervals: intervalWidths(complete, {
      seed: opts.seed,
      reps,
      ...(opts.practicalMarginPoints !== undefined
        ? { practicalMarginPoints: opts.practicalMarginPoints }
        : {}),
    }),
    dominantItem: dominantItemSensitivity(complete),
    // The RAW matrix, nulls intact: dropping incomplete items first would
    // remove the unequal-coverage channel and leave only the ceiling one.
    severity: judgeSeveritySensitivity(matrix, opts.judgedItems ? { judgedItems: opts.judgedItems } : {}),
    ceiling: ceilingSensitivity(complete),
    negativeDiscrimination: negativeDiscriminationScan(complete).filter((d) => d.negative || d.flat),
    missingness: missingResponseSensitivity(matrix, complete),
    power: powerCurve({
      seed: opts.seed,
      gapPoints: 2,
      itemCounts: [25, 50, 100, 200],
      sims,
      bootstrapReps: Math.max(300, Math.floor(reps / 2)),
    }),
    design: designRequirements({
      targetHalfWidth: (opts.practicalMarginPoints ?? 2) / 2,
      itemVariance,
      // Generation variance is not estimable from a single-generation archive.
      // Zero here is a placeholder that makes repeats look useless, which is
      // the conservative direction; the Development Probe measures it properly.
      generationVariance: 0,
    }),
    multiplicity: multiplicityCheck({
      seed: opts.seed,
      models: complete.models.length,
      items: Math.min(complete.items.length, 60),
      sims,
      bootstrapReps: 300,
    }),
    fragility: rankFragilityOnMatrix(complete, { seed: `${opts.seed}:fragility`, reps: Math.max(100, reps) }),
    judgeBench: judgeBenchSampleSize({
      strata: [
        { name: 'safety-critical', weight: 0.3, expectedAgreement: 0.85 },
        { name: 'craft', weight: 0.45, expectedAgreement: 0.8 },
        { name: 'constraint-following', weight: 0.25, expectedAgreement: 0.9 },
      ],
      targetHalfWidth: 0.05,
    }),
    taste: tastePublicationThreshold({
      seed: opts.seed,
      strengths: [1.6, 1.3, 1.0, 0.8, 0.6],
      sims: Math.min(sims, 20),
    }),
  };
}

/** Variance of per-item means: the item component of a model mean's variance. */
function varianceOfItemMeans(m: ScoreMatrix): number {
  const items = completeItems(m);
  const perItem = items.map((ii) => {
    const col = m.models.map((_, mi) => matrixValue(m, mi, ii)!);
    return col.reduce((a, b) => a + b, 0) / col.length;
  });
  const mu = perItem.reduce((a, b) => a + b, 0) / perItem.length;
  return perItem.reduce((a, b) => a + (b - mu) ** 2, 0) / perItem.length;
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/** Terse text summary for the CLI. */
export function formatSimulationReport(r: SimulationReport): string {
  const lines = [
    `Simulation and power checks — seed ${r.seed} (${r.source})`,
    `Interval half-width: median ${r.intervals.medianHalfWidth} vs between-model SD ${r.intervals.spreadSd} (ratio ${r.intervals.uncertaintyRatio})`,
    `Dominant item ${r.dominantItem.itemId}: ${(r.dominantItem.varianceShare * 100).toFixed(1)}% of variance, effective items ${r.dominantItem.effectiveItems}, leader changes without it: ${r.dominantItem.leaderChanged}`,
    `Smallest deletion that flips the leader: ${r.dominantItem.flipSize ?? 'none'} unit(s)`,
    `Judge severity: ordering changes at ${r.severity.filter((s) => s.orderingChanged).map((s) => `${s.shiftPoints > 0 ? '+' : ''}${s.shiftPoints}`).join(', ') || 'no shift tested'}`,
    `Negative-discrimination or flat items: ${r.negativeDiscrimination.length}`,
    `Missingness: ${r.missingness.map((x) => `${x.policy}${x.leaderChanged ? ' (LEADER CHANGES)' : ''}`).join(', ')}`,
    `Power at ${r.power[0]?.gapPoints ?? '?'} points: ${r.power.map((p) => `${p.items} items → ${(p.power * 100).toFixed(0)}%`).join(', ')}`,
    `Family-wise error over ${r.multiplicity.pairs} pairs: uncorrected ${r.multiplicity.familywiseErrorUncorrected}, Holm ${r.multiplicity.familywiseErrorHolm}`,
    `Top-group stability: ${r.fragility.topGroupStability}`,
    `JudgeBench: ${r.judgeBench.totalCases} cases${r.judgeBench.refusals.length ? ` (refusals: ${r.judgeBench.refusals.join('; ')})` : ''}`,
    `Taste: ${r.taste.map((t) => `${t.battlesPerModel} battles → ±${t.medianHalfWidth}, top correct ${(t.topCorrect * 100).toFixed(0)}%`).join('; ')}`,
  ];
  return lines.join('\n');
}
