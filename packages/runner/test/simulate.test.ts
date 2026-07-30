import { describe, expect, it } from 'vitest';
import type { Score } from '@cookingbench/core';
import {
  applyMissingPolicy,
  auditUnits,
  ceilingSensitivity,
  completeItems,
  designRequirements,
  dominantItemSensitivity,
  intervalWidths,
  judgeBenchSampleSize,
  judgeSeveritySensitivity,
  matrixFromScores,
  missingResponseSensitivity,
  multiplicityCheck,
  negativeDiscriminationScan,
  ordering,
  powerCurve,
  rankFragilityOnMatrix,
  runSimulationSuite,
  simulateScoreMatrix,
  tastePublicationThreshold,
  type ScoreMatrix,
} from '../src/simulate.js';
import {
  compareParaphrase,
  contentDrift,
  culinaryContentFingerprint,
  formatParaphraseReport,
  paraphraseObservationsFromScores,
  summariseParaphraseSet,
  type ParaphraseObservation,
} from '../src/paraphrase.js';

/**
 * Tests for simulate.ts, plus the paraphrase harness.
 *
 * The paraphrase block lives here rather than in `paraphrase.test.ts` because
 * this workstream was allocated two test files and three modules; move it to
 * its own file at integration. Its coverage is the point, not its address.
 */

/** Hand-built matrix, so every expectation below is arithmetic, not a draw. */
function matrix(rows: Record<string, (number | null)[]>, itemIds?: string[]): ScoreMatrix {
  const models = Object.keys(rows).sort();
  const width = rows[models[0]!]!.length;
  const items = itemIds ?? Array.from({ length: width }, (_, i) => `q${String(i).padStart(3, '0')}`);
  return {
    models,
    items,
    values: models.map((m) => rows[m]!),
    clusterOf: Object.fromEntries(items.map((q) => [q, q])),
  };
}

function score(modelId: string, questionId: string, value: number): Score {
  return {
    runId: 'sim',
    modelId,
    questionId,
    score: value,
    graderType: 'numeric',
    detail: {} as Score['detail'],
  };
}

describe('matrixFromScores', () => {
  it('refuses duplicated cells rather than silently keeping the last one', () => {
    expect(() =>
      matrixFromScores([score('a', 'q1', 90), score('a', 'q1', 10)]),
    ).toThrowError(/Duplicate score row/);
  });

  it('collapses repeats only when told to', () => {
    const m = matrixFromScores([score('a', 'q1', 90), score('a', 'q1', 10), score('b', 'q1', 50)], {
      aggregateRepeats: 'mean',
    });
    expect(m.values[m.models.indexOf('a')]![0]).toBe(50);
  });

  it('leaves an unanswered cell null rather than zero', () => {
    // Zero is a score. Null is the absence of one, and the whole point of
    // missingResponseSensitivity is that the two are not the same decision.
    const m = matrixFromScores([score('a', 'q1', 90), score('a', 'q2', 80), score('b', 'q1', 70)]);
    expect(m.values[m.models.indexOf('b')]![m.items.indexOf('q2')]).toBeNull();
    expect(completeItems(m)).toEqual([m.items.indexOf('q1')]);
  });

  it('does not confuse model/item pairs that concatenate the same way', () => {
    // ("a b", "c") and ("a", "b c") share a naive space-joined key.
    const m = matrixFromScores([score('a b', 'c', 10), score('a', 'b c', 90)]);
    expect(m.models).toEqual(['a', 'a b']);
    expect(m.values[0]![m.items.indexOf('b c')]).toBe(90);
    expect(m.values[1]![m.items.indexOf('c')]).toBe(10);
  });
});

describe('the generator', () => {
  it('is reproducible from its seed and sensitive to it', () => {
    const spec = { seed: 'x', abilities: [5, 0, -5], items: 20 } as const;
    expect(simulateScoreMatrix(spec).values).toEqual(simulateScoreMatrix(spec).values);
    expect(simulateScoreMatrix({ ...spec, seed: 'y' }).values).not.toEqual(
      simulateScoreMatrix(spec).values,
    );
  });

  it('never exceeds the ceiling or goes below zero', () => {
    const m = simulateScoreMatrix({ seed: 's', abilities: [40, -40], items: 50, noiseSd: 40 });
    for (const row of m.values) for (const v of row) expect(v!).toBeGreaterThanOrEqual(0);
    for (const row of m.values) for (const v of row) expect(v!).toBeLessThanOrEqual(100);
  });

  it('produces genuinely dead items when asked for saturation', () => {
    const m = simulateScoreMatrix({ seed: 's', abilities: [8, 0, -8], items: 100, saturatedShare: 0.5 });
    const dead = completeItems(m).filter((ii) => m.values.every((row) => row[ii] === 100));
    expect(dead.length).toBeGreaterThan(30);
  });

  it('drops responses preferentially on low scores under the non-random mechanism', () => {
    const spec = { seed: 'miss', abilities: [10, 0, -10], items: 200, missingRate: 0.15 } as const;
    const mcar = simulateScoreMatrix(spec);
    const mnar = simulateScoreMatrix({ ...spec, missingMechanism: 'low-scores' });
    const lost = (m: ScoreMatrix, mi: number) => m.values[mi]!.filter((v) => v === null).length;
    // The weakest model must lose more than the strongest under MNAR, and the
    // gap must be larger than under MCAR — otherwise the mechanism is cosmetic.
    expect(lost(mnar, 2) - lost(mnar, 0)).toBeGreaterThan(lost(mcar, 2) - lost(mcar, 0));
  });

  it('refuses a degenerate design instead of returning an empty matrix', () => {
    expect(() => simulateScoreMatrix({ seed: 's', abilities: [1], items: 10 })).toThrowError(/two model/);
    expect(() => simulateScoreMatrix({ seed: 's', abilities: [1, 0], items: 1 })).toThrowError(/items/);
    expect(() => simulateScoreMatrix({ seed: '', abilities: [1, 0], items: 10 })).toThrowError(/seed/);
    expect(() =>
      simulateScoreMatrix({ seed: 's', abilities: [1, 0], items: 10, repeats: 0 }),
    ).toThrowError(/repeats/);
  });
});

describe('missing responses', () => {
  const observed = matrix({ a: [100, 100, 50, 50], b: [90, 90, null, null] });
  const truth = matrix({ a: [100, 100, 50, 50], b: [90, 90, 10, 10] });

  it('shows pairwise averaging handing the lead to the model that lost its hard items', () => {
    const results = missingResponseSensitivity(observed, truth);
    const pairwise = results.find((r) => r.policy === 'pairwise')!;
    expect(pairwise.leader).toBe('b');
    expect(pairwise.leaderChanged).toBe(true);
  });

  it('keeps the true leader under zero-scoring and item dropping', () => {
    const results = missingResponseSensitivity(observed, truth);
    expect(results.find((r) => r.policy === 'zero')!.leader).toBe('a');
    expect(results.find((r) => r.policy === 'drop-item')!.leader).toBe('a');
    expect(results.find((r) => r.policy === 'drop-item')!.itemsRetained).toBe(2);
  });

  it('counts the missing cells it was given', () => {
    expect(missingResponseSensitivity(observed, truth)[0]!.missingCells).toBe(2);
  });

  it('applyMissingPolicy(zero) scores an absent answer 0, not 100', () => {
    const zeroed = applyMissingPolicy(observed, 'zero');
    expect(zeroed.values[zeroed.models.indexOf('b')]).toEqual([90, 90, 0, 0]);
  });
});

describe('interval width', () => {
  it('narrows roughly as the square root of the item count', () => {
    const wide = intervalWidths(
      simulateScoreMatrix({ seed: 'iw', abilities: [5, 0, -5], items: 20 }),
      { seed: 'iw', reps: 800 },
    );
    const narrow = intervalWidths(
      simulateScoreMatrix({ seed: 'iw', abilities: [5, 0, -5], items: 200 }),
      { seed: 'iw', reps: 800 },
    );
    expect(wide.medianHalfWidth).toBeGreaterThan(narrow.medianHalfWidth * 2);
  });

  it('refuses to invent a practical margin', () => {
    const m = simulateScoreMatrix({ seed: 'iw', abilities: [5, 0, -5], items: 40 });
    const s = intervalWidths(m, { seed: 'iw', reps: 400 });
    expect(s.meetsTarget).toBeNull();
    expect(s.targetHalfWidth).toBeNull();
    expect(intervalWidths(m, { seed: 'iw', reps: 400, practicalMarginPoints: 100 }).meetsTarget).toBe(true);
  });

  it('flags a roster whose uncertainty covers its own spread', () => {
    // Abilities a fraction of the noise: the published-board failure mode.
    const m = simulateScoreMatrix({ seed: 'flat', abilities: [0.2, 0, -0.2], items: 30, noiseSd: 20 });
    expect(intervalWidths(m, { seed: 'flat', reps: 800 }).uncertaintyRatio).toBeGreaterThan(1);
  });

  it('refuses a matrix with no complete item', () => {
    expect(() =>
      intervalWidths(matrix({ a: [1, null], b: [null, 2] }), { seed: 's' }),
    ).toThrowError(/complete/);
  });
});

describe('item influence', () => {
  const swing = matrix({ a: [0, 100, 100, 100], b: [100, 90, 90, 90] });

  it('finds the dominant item and the leader change it causes', () => {
    const r = dominantItemSensitivity(swing);
    expect(r.itemId).toBe('q000');
    expect(r.varianceShare).toBeGreaterThan(0.9);
    expect(r.leader).toBe('b');
    expect(r.leaderWithoutItem).toBe('a');
    expect(r.leaderChanged).toBe(true);
    expect(r.flipSize).toBe(1);
  });

  it('reports effective items well below the nominal count when one item dominates', () => {
    expect(dominantItemSensitivity(swing).effectiveItems).toBeLessThan(2);
    // Equal per-item variance across four items: exactly four effective items.
    const even = matrix({ a: [90, 80, 90, 80], b: [70, 60, 70, 60] });
    expect(dominantItemSensitivity(even).effectiveItems).toBeCloseTo(4, 1);
  });

  it('separates a mis-keyed item from a saturated one', () => {
    // q000 rewards the weak models; q001 is flat. Only the first is a defect
    // the discrimination scan should call negative.
    const m = matrix({
      a: [10, 100, 95, 92, 90, 88, 96],
      b: [40, 100, 85, 82, 80, 78, 86],
      c: [70, 100, 75, 72, 70, 68, 76],
      d: [100, 100, 65, 62, 60, 58, 66],
    });
    const scan = negativeDiscriminationScan(m);
    const q0 = scan.find((s) => s.itemId === 'q000')!;
    const q1 = scan.find((s) => s.itemId === 'q001')!;
    expect(q0.negative).toBe(true);
    expect(q0.itemTotal).toBeLessThan(0);
    expect(q1.flat).toBe(true);
    expect(q1.negative).toBe(false);
    expect(scan.find((s) => s.itemId === 'q002')!.negative).toBe(false);
  });

  it('needs two complete items before it will report influence', () => {
    expect(() => dominantItemSensitivity(matrix({ a: [1], b: [2] }))).toThrowError(/two complete/);
  });
});

describe('judge severity', () => {
  it('cannot reorder a complete matrix that never touches the ceiling', () => {
    // The invariant that makes the ceiling channel the interesting one: an
    // additive shift on a shared item set is a constant for every model.
    const m = matrix({ a: [60, 55, 50], b: [40, 45, 50], c: [30, 35, 40] });
    for (const r of judgeSeveritySensitivity(m, { shifts: [-20, -5, 0, 5, 20] })) {
      expect(r.orderingChanged).toBe(false);
    }
  });

  it('destroys discrimination when leniency presses the roster against the cap', () => {
    const m = matrix({ a: [98, 96, 94], b: [90, 88, 86], c: [80, 78, 76] });
    const results = judgeSeveritySensitivity(m, { shifts: [0, 20] });
    expect(results[1]!.spreadSd).toBeLessThan(results[0]!.spreadSd);
  });

  it('reorders through unequal coverage of the judged items', () => {
    const m = matrix({ a: [null, 80, 80], b: [60, 82, 82] });
    const results = judgeSeveritySensitivity(m, { shifts: [0, 40], judgedItems: ['q000'] });
    expect(results[0]!.leader).toBe('a');
    expect(results[1]!.leader).toBe('b');
    expect(results[1]!.leaderChanged).toBe(true);
  });

  it('leaves unjudged items alone', () => {
    const m = matrix({ a: [50, 50], b: [40, 40] });
    const shifted = judgeSeveritySensitivity(m, { shifts: [10], judgedItems: ['q000'] });
    expect(shifted[0]!.meanScore).toBe(50);
  });
});

describe('ceiling and saturation', () => {
  it('kills items as the cap comes down', () => {
    const m = matrix({ a: [100, 96, 92], b: [98, 94, 90], c: [96, 92, 88] });
    const [full, mid] = ceilingSensitivity(m, [100, 95]);
    expect(mid!.allPerfectItems).toBeGreaterThan(full!.allPerfectItems);
    expect(mid!.spreadSd).toBeLessThan(full!.spreadSd);
  });
});

describe('power and multiplicity', () => {
  it('detects a real gap far more often with more items', () => {
    const few = powerCurve({ seed: 'p', gapPoints: 6, itemCounts: [10], sims: 20, bootstrapReps: 200 });
    const many = powerCurve({ seed: 'p', gapPoints: 6, itemCounts: [200], sims: 20, bootstrapReps: 200 });
    expect(many[0]!.power).toBeGreaterThan(few[0]!.power);
    expect(many[0]!.power).toBeGreaterThan(0.8);
  });

  it('keeps the false-positive rate near nominal when there is no gap', () => {
    const nul = powerCurve({ seed: 'p0', gapPoints: 0, itemCounts: [100], sims: 40, bootstrapReps: 200 });
    expect(nul[0]!.power).toBeLessThanOrEqual(0.2);
  });

  it('shows the uncorrected pair family inventing separations, and Holm removing them', () => {
    const r = multiplicityCheck({ seed: 'm', models: 5, items: 30, sims: 20, bootstrapReps: 200 });
    expect(r.pairs).toBe(10);
    expect(r.familywiseErrorUncorrected).toBeGreaterThan(0);
    expect(r.familywiseErrorHolm).toBeLessThanOrEqual(r.familywiseErrorUncorrected);
    expect(r.familywiseErrorHolm).toBeLessThanOrEqual(0.2);
  });

  it('is reproducible', () => {
    const opts = { seed: 'm', models: 4, items: 20, sims: 5, bootstrapReps: 150 } as const;
    expect(multiplicityCheck(opts)).toEqual(multiplicityCheck(opts));
  });
});

describe('design requirements', () => {
  it('refuses a target the item count cannot reach and says why', () => {
    const r = designRequirements({ targetHalfWidth: 0.1, itemVariance: 100, generationVariance: 0 });
    expect(r.items).toBeNull();
    expect(r.refusal).toMatch(/repeats do not reduce the item component/);
  });

  it('does not buy repeats when the variance is item-driven', () => {
    const r = designRequirements({ targetHalfWidth: 2, itemVariance: 100, generationVariance: 0 });
    expect(r.items).toBe(100);
    expect(r.repeats).toBe(1);
  });

  it('buys repeats when the variance is generation-driven', () => {
    const r = designRequirements({ targetHalfWidth: 2, itemVariance: 0, generationVariance: 400 });
    expect(r.repeats).toBeGreaterThan(1);
    expect((r.items ?? 0) * (r.repeats ?? 0)).toBeGreaterThanOrEqual(384);
  });

  it('rejects a nonsensical target', () => {
    expect(() =>
      designRequirements({ targetHalfWidth: 0, itemVariance: 1, generationVariance: 0 }),
    ).toThrowError(/positive/);
  });
});

describe('rank fragility', () => {
  it('reports a fragile top group when one item carries the lead', () => {
    const m = matrix({ a: [0, 100, 100, 100, 100], b: [100, 90, 90, 90, 90] });
    const r = rankFragilityOnMatrix(m, { seed: 'f', reps: 500 });
    expect(r.topGroupStability).toBeLessThan(0.95);
  });

  it('refuses to resample a single cluster', () => {
    expect(() => rankFragilityOnMatrix(matrix({ a: [1], b: [2] }), { seed: 'f' })).toThrowError(
      /cluster/,
    );
  });

  it('exposes audit units built only from complete items', () => {
    expect(auditUnits(matrix({ a: [1, null], b: [2, 3] }))).toHaveLength(1);
  });
});

describe('JudgeBench sizing', () => {
  const strata = [
    { name: 'safety-critical', weight: 0.3, expectedAgreement: 0.85 },
    { name: 'craft', weight: 0.45, expectedAgreement: 0.8 },
    { name: 'constraint-following', weight: 0.25, expectedAgreement: 0.9 },
  ];

  it('refuses weights that do not account for the whole sample', () => {
    const r = judgeBenchSampleSize({
      strata: [{ name: 'a', weight: 0.5, expectedAgreement: 0.9 }],
      targetHalfWidth: 0.05,
    });
    expect(r.refusals.join(' ')).toMatch(/sum to/);
    expect(r.strata).toHaveLength(0);
    expect(r.totalCases).toBe(0);
  });

  it('refuses a certainty it cannot size', () => {
    expect(
      judgeBenchSampleSize({
        strata: [{ name: 'a', weight: 1, expectedAgreement: 1 }],
        targetHalfWidth: 0.05,
      }).refusals.join(' '),
    ).toMatch(/agreement/);
  });

  it('sizes the total from the neediest stratum, leaving no shortfall', () => {
    const r = judgeBenchSampleSize({ strata, targetHalfWidth: 0.05 });
    expect(r.refusals).toHaveLength(0);
    for (const s of r.strata) expect(s.shortfall).toBe(0);
    // The safety stratum carries only 30% of the sample, so it is what drives
    // the total; a pooled n would be roughly a third of this.
    expect(r.totalCases).toBeGreaterThan(500);
  });

  it('demands more cases for a tighter claim', () => {
    const loose = judgeBenchSampleSize({ strata, targetHalfWidth: 0.1 });
    const tight = judgeBenchSampleSize({ strata, targetHalfWidth: 0.03 });
    expect(tight.totalCases).toBeGreaterThan(loose.totalCases * 3);
  });

  it('honours a minimum per stratum even when the maths says three cases', () => {
    const r = judgeBenchSampleSize({
      strata: [{ name: 'a', weight: 1, expectedAgreement: 0.5 }],
      targetHalfWidth: 0.49,
      minPerStratum: 30,
    });
    expect(r.strata[0]!.required).toBe(30);
  });

  it('refuses an unsupported confidence level rather than interpolating', () => {
    expect(() =>
      judgeBenchSampleSize({ strata, targetHalfWidth: 0.05, confidence: 0.975 }),
    ).toThrowError(/confidence/);
  });
});

describe('taste publication thresholds', () => {
  it('shows five battles buying an interval far too wide to publish', () => {
    const points = tastePublicationThreshold({
      seed: 't',
      strengths: [2, 1.4, 1, 0.7],
      battlesLadder: [5, 60],
      sims: 4,
      bootstrap: 40,
    });
    expect(points[0]!.medianHalfWidth).toBeGreaterThan(points[1]!.medianHalfWidth);
    expect(points[0]!.medianHalfWidth).toBeGreaterThan(100);
  });

  it('refuses a non-positive strength instead of sampling NaN win probabilities', () => {
    expect(() =>
      tastePublicationThreshold({ seed: 't', strengths: [1, 0], battlesLadder: [10], sims: 1, bootstrap: 20 }),
    ).toThrowError(/positive/);
  });

  it('is reproducible and refuses a single contender', () => {
    const opts = {
      seed: 't',
      strengths: [2, 1],
      battlesLadder: [10],
      sims: 2,
      bootstrap: 30,
    } as const;
    expect(tastePublicationThreshold(opts)).toEqual(tastePublicationThreshold(opts));
    expect(() => tastePublicationThreshold({ ...opts, strengths: [1] })).toThrowError(/two/);
  });
});

describe('the suite', () => {
  it('runs end to end on a supplied matrix and is deterministic apart from the timestamp', () => {
    const m = simulateScoreMatrix({
      seed: 'suite',
      abilities: [6, 3, 0, -3, -6],
      items: 40,
      saturatedShare: 0.3,
    });
    // 600 reps, not 300: clusterBootstrapMean refuses to resolve a 0.025
    // quantile from fewer than ten order statistics, which is the correct
    // behaviour and a real constraint on the suite's cheap-defaults mode.
    const opts = { seed: 'suite', matrix: m, reps: 600, sims: 5 };
    const a = runSimulationSuite(opts);
    const b = runSimulationSuite(opts);
    expect(a.source).toBe('archived');
    expect({ ...a, generatedAt: '' }).toEqual({ ...b, generatedAt: '' });
    expect(a.intervals.models).toHaveLength(5);
  });
});

/* ========================================================================== */
/* paraphrase.ts                                                              */
/* ========================================================================== */

const BASE_PROMPT =
  'You are baking for a guest with a severe peanut allergy. Scale a recipe that serves 4 up to 10 servings and give the oven temperature in °C for a fan oven, starting from 180 °C conventional.';

function obs(modelId: string, value: number, over: Partial<ParaphraseObservation> = {}): ParaphraseObservation {
  return { modelId, score: value, graderType: 'numeric', ...over };
}

function attested() {
  return { by: 'reviewer', at: '2026-07-30' };
}

describe('culinary content fingerprint', () => {
  it('treats unit spellings as the same content', () => {
    const a = culinaryContentFingerprint('Heat the oven to 180 °C and bake for 25 minutes.');
    const b = culinaryContentFingerprint('Heat the oven to 180 degrees Celsius and bake for 25 mins.');
    expect(a).toEqual(b);
  });

  it('treats written numbers as the same content', () => {
    expect(contentDrift('Add 2 tsp of salt.', 'Add two teaspoons of salt.').changed).toBe(false);
  });

  it('catches a changed quantity', () => {
    const drift = contentDrift('Bake at 180 °C.', 'Bake at 200 °C.');
    expect(drift.changed).toBe(true);
    expect(drift.differences.join(' ')).toMatch(/degC/);
  });

  it('treats a unit conversion as a content change, because the item now tests something else', () => {
    expect(contentDrift('Bake at 180 °C.', 'Bake at 350 °F.').changed).toBe(true);
  });

  it('catches a dropped allergen constraint', () => {
    const drift = contentDrift(BASE_PROMPT, BASE_PROMPT.replace('severe peanut allergy', 'dietary requirement'));
    expect(drift.changed).toBe(true);
    expect(drift.differences.join(' ')).toMatch(/peanut/);
  });

  it('does not fire on ordinary rewording', () => {
    const reworded =
      'A guest has a severe peanut allergy. Take a recipe for 4 people to 10 servings, and convert 180 °C conventional to the right fan-oven temperature in °C.';
    expect(contentDrift(BASE_PROMPT, reworded).changed).toBe(false);
  });
});

describe('paraphrase comparison', () => {
  const models = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  const reworded = BASE_PROMPT.replace('You are baking for', 'Imagine you are baking for');

  it('refuses an unattested paraphrase', () => {
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      baseScores: models.map((m) => obs(m, 80)),
      variantScores: models.map((m) => obs(m, 80)),
    });
    expect(c.verdict).toBe('refused');
    expect(c.refusals.join(' ')).toMatch(/attestation/);
    expect(c.meanDelta).toBeNull();
  });

  it('refuses content drift the attester did not accept', () => {
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p2',
      basePrompt: BASE_PROMPT,
      variantPrompt: BASE_PROMPT.replace('180 °C', '200 °C'),
      attestation: attested(),
      baseScores: models.map((m) => obs(m, 80)),
      variantScores: models.map((m) => obs(m, 80)),
    });
    expect(c.verdict).toBe('refused');
    expect(c.refusals.join(' ')).toMatch(/drifted/);
  });

  it('proceeds, with a note, when the attester accepted the drift explicitly', () => {
    const drift = contentDrift(BASE_PROMPT, BASE_PROMPT.replace('180 °C', '200 °C'));
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p2',
      basePrompt: BASE_PROMPT,
      variantPrompt: BASE_PROMPT.replace('180 °C', '200 °C'),
      attestation: { ...attested(), acceptedDrift: drift.differences },
      baseScores: models.map((m) => obs(m, 80)),
      variantScores: models.map((m) => obs(m, 80)),
      equivalenceMarginPoints: 3,
    });
    expect(c.verdict).not.toBe('refused');
    expect(c.notes.join(' ')).toMatch(/accepted/);
  });

  it('refuses a roster that is not the same on both sides', () => {
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: models.map((m) => obs(m, 80)),
      variantScores: models.slice(0, 4).map((m) => obs(m, 80)),
    });
    expect(c.verdict).toBe('refused');
    expect(c.refusals.join(' ')).toMatch(/Roster mismatch/);
  });

  it('refuses a grader or judge protocol that changed underneath the comparison', () => {
    const grader = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: models.map((m) => obs(m, 80)),
      variantScores: models.map((m) => obs(m, 80, { graderType: 'llm-judge' })),
    });
    expect(grader.refusals.join(' ')).toMatch(/grader changed/);

    const judge = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: models.map((m) => obs(m, 80, { judgeProtocol: 'panel-v2' })),
      variantScores: models.map((m) => obs(m, 80, { judgeProtocol: 'panel-v3' })),
    });
    expect(judge.refusals.join(' ')).toMatch(/judge protocol changed/);
  });

  it('refuses two scores for one model on one side', () => {
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: [...models.map((m) => obs(m, 80)), obs('m1', 60)],
      variantScores: models.map((m) => obs(m, 80)),
    });
    expect(c.refusals.join(' ')).toMatch(/more than one base score/);
  });

  it('refuses an empty pairing rather than reporting NaN', () => {
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: [],
      variantScores: [],
    });
    expect(c.verdict).toBe('refused');
    expect(c.refusals.join(' ')).toMatch(/nothing to compare/);
    expect(c.meanAbsDelta).toBeNull();
  });

  it('calls a big movement wording-sensitive', () => {
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: models.map((m) => obs(m, 100)),
      variantScores: models.map((m, i) => obs(m, i % 2 === 0 ? 70 : 80)),
      equivalenceMarginPoints: 3,
    });
    expect(c.verdict).toBe('wording-sensitive');
    expect(c.meanAbsDelta!).toBeGreaterThan(5);
    expect(c.movedModels).toBe(6);
  });

  it('calls a small but consistent shift sensitive too', () => {
    // Two points every time is not noise, and a threshold on the mean absolute
    // movement alone would have waved it through.
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: models.map((m) => obs(m, 80)),
      variantScores: models.map((m) => obs(m, 82)),
      equivalenceMarginPoints: 5,
    });
    expect(c.verdict).toBe('wording-sensitive');
  });

  it('refuses to call an item robust without a preregistered margin', () => {
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: models.map((m) => obs(m, 80)),
      variantScores: models.map((m, i) => obs(m, 80 + (i % 2 === 0 ? 1 : -1))),
    });
    expect(c.verdict).toBe('inconclusive');
    expect(c.notes.join(' ')).toMatch(/no difference was detected/i);
  });

  it('calls an item robust only when the interval fits inside the margin', () => {
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: models.map((m) => obs(m, 80)),
      variantScores: models.map((m, i) => obs(m, 80 + (i % 2 === 0 ? 1 : -1))),
      equivalenceMarginPoints: 3,
    });
    expect(c.verdict).toBe('wording-robust');
    expect(c.ci![0]).toBeGreaterThan(-3);
    expect(c.ci![1]).toBeLessThan(3);
  });

  it('will not issue a verdict off three models, however clean they look', () => {
    const three = models.slice(0, 3);
    const c = compareParaphrase({
      baseItemId: 'q1',
      variantId: 'q1-p1',
      basePrompt: BASE_PROMPT,
      variantPrompt: reworded,
      attestation: attested(),
      baseScores: three.map((m) => obs(m, 80)),
      variantScores: three.map((m) => obs(m, 80)),
      equivalenceMarginPoints: 3,
    });
    expect(c.verdict).toBe('inconclusive');
    expect(c.notes.join(' ')).toMatch(/paired model/);
  });

  it('is deterministic', () => {
    const build = () =>
      compareParaphrase({
        baseItemId: 'q1',
        variantId: 'q1-p1',
        basePrompt: BASE_PROMPT,
        variantPrompt: reworded,
        attestation: attested(),
        baseScores: models.map((m, i) => obs(m, 70 + i)),
        variantScores: models.map((m, i) => obs(m, 71 + i)),
        equivalenceMarginPoints: 3,
      });
    expect(build()).toEqual(build());
  });
});

describe('paraphrase evidence and reporting', () => {
  it('reads both sides out of archived scores and refuses an absent item', () => {
    const scores = [score('a', 'q1', 90), score('b', 'q1', 70)];
    expect(paraphraseObservationsFromScores(scores, 'q1')).toEqual([
      { modelId: 'a', score: 90, graderType: 'numeric' },
      { modelId: 'b', score: 70, graderType: 'numeric' },
    ]);
    expect(() => paraphraseObservationsFromScores(scores, 'q1-p1')).toThrowError(/No scores for item/);
  });

  it('never counts an inconclusive item as robust in the summary', () => {
    const models = ['m1', 'm2', 'm3', 'm4', 'm5'];
    const common = {
      basePrompt: BASE_PROMPT,
      variantPrompt: BASE_PROMPT.replace('You are baking', 'Suppose you are baking'),
      attestation: attested(),
      baseScores: models.map((m) => obs(m, 80)),
    };
    const noMargin = compareParaphrase({
      ...common,
      baseItemId: 'q1',
      variantId: 'q1-p1',
      variantScores: models.map((m, i) => obs(m, 80 + (i % 2 === 0 ? 1 : -1))),
    });
    const sensitive = compareParaphrase({
      ...common,
      baseItemId: 'q2',
      variantId: 'q2-p1',
      variantScores: models.map((m) => obs(m, 60)),
    });
    const summary = summariseParaphraseSet([noMargin, sensitive]);
    expect(summary.robust).toBe(0);
    expect(summary.inconclusive).toBe(1);
    expect(summary.sensitive).toBe(1);
    expect(summary.worst[0]!.itemId).toBe('q2');
    const text = formatParaphraseReport([noMargin, sensitive], summary);
    expect(text).toMatch(/wording-sensitive/);
    expect(text).toMatch(/inconclusive/);
  });
});
