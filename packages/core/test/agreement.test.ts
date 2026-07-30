/**
 * Tests for the M2.7/M2.8 jury-fitness statistics.
 *
 * These are written as attempts to break the module, not as a feature tour. The
 * recurring targets are the three ways an agreement statistic flatters a panel:
 * silently dropping missing ratings, collapsing `abstain` or
 * `both_unacceptable` into a tie, and reporting a coefficient of 1.0 for a
 * matrix that contains no information. The known-answer alpha cases are all
 * hand-computable and the arithmetic is written out beside each one, so a
 * refactor that changes a coefficient has to argue with the derivation.
 */
import { describe, expect, it } from 'vitest';
import {
  AgreementError,
  agreementRate,
  assertPairwiseDistance,
  bootstrapAlpha,
  clopperPearson,
  clusteredBootstrap,
  consensusLabel,
  evaluateReleaseCriteria,
  humanParity,
  identicalAnswerControl,
  judgeBenchLabelSetSchema,
  krippendorffAlpha,
  macroF1,
  M28_PROVISIONAL_LABEL,
  orderEffect,
  paddedDuplicatePreference,
  pairwiseRatingsForAgreement,
  parseJudgeBenchLabels,
  provisionalM28Criteria,
  regularisedIncompleteBeta,
  repeatConsistency,
  safetyRates,
  stratumAgreement,
  styleInvariance,
  type AgreementRating,
  type AuditBallot,
  type Measurement,
  type PaddedDuplicateBallot,
  type Prediction,
  type ReleaseCriterion,
} from '../src/agreement.js';

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Build a matrix from `{ unit: [ratings in rater order] }`, `null` = missing. */
function matrix(
  raters: readonly string[],
  rows: Record<string, readonly (number | string | null)[]>,
): AgreementRating[] {
  const out: AgreementRating[] = [];
  for (const [unit, values] of Object.entries(rows)) {
    values.forEach((value, i) => {
      out.push({ unit, rater: raters[i]!, value });
    });
  }
  return out;
}

/** P(X >= k | n, p) for the exact-interval cross-check. */
function binomialTailAtLeast(k: number, n: number, p: number): number {
  let total = 0;
  for (let i = k; i <= n; i++) {
    let logC = 0;
    for (let j = 1; j <= i; j++) logC += Math.log((n - i + j) / j);
    total += Math.exp(logC + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return total;
}

function binomialTailAtMost(k: number, n: number, p: number): number {
  return 1 - binomialTailAtLeast(k + 1, n, p);
}

/* -------------------------------------------------------------------------- */
/* Krippendorff's alpha — known answers                                       */
/* -------------------------------------------------------------------------- */

describe("Krippendorff's alpha, hand-computed cases", () => {
  it('returns exactly 1 for perfect agreement with variation present', () => {
    const result = krippendorffAlpha(matrix(['r1', 'r2'], { u1: [0, 0], u2: [1, 1] }), {
      metric: 'nominal',
    });
    expect(result.alpha).toBeCloseTo(1, 12);
    expect(result.degenerate).toBeNull();
    expect(result.pairableUnits).toBe(2);
  });

  it('goes negative when raters disagree more than chance would', () => {
    // u1 = (0,1), u2 = (1,0). Coincidence o01 = o10 = 2, marginals n0 = n1 = 2,
    // n = 4. Do = (1/4)(2 + 2) = 1. De = (1/12)(2·2 + 2·2) = 2/3.
    // alpha = 1 − 1/(2/3) = −0.5.
    const result = krippendorffAlpha(matrix(['r1', 'r2'], { u1: [0, 1], u2: [1, 0] }), {
      metric: 'nominal',
    });
    expect(result.alpha).toBeCloseTo(-0.5, 12);
  });

  it('reproduces the four-unit nominal worked example (8/15)', () => {
    // u1 (0,0), u2 (0,0), u3 (1,1), u4 (0,1).
    // o00 = 4, o11 = 2, o01 = o10 = 1. n0 = 5, n1 = 3, n = 8.
    // Do = (1/8)(1 + 1) = 0.25.
    // De = (1/(8·7))(5·3 + 3·5) = 30/56.
    // alpha = 1 − 0.25·56/30 = 1 − 7/15 = 8/15.
    const result = krippendorffAlpha(
      matrix(['r1', 'r2'], { u1: [0, 0], u2: [0, 0], u3: [1, 1], u4: [0, 1] }),
      { metric: 'nominal' },
    );
    expect(result.alpha).toBeCloseTo(8 / 15, 12);
    expect(result.pairableValues).toBe(8);
  });

  it('credits an adjacent-band near miss on the ordinal metric (94/99) but not the nominal one (8/13)', () => {
    // u1 (0,0), u2 (4,4), u3 (2,3), domain 0..4.
    // Marginals: n0 = 2, n2 = 1, n3 = 1, n4 = 2, n = 6.
    // Ordinal δ²(2,3) = (n2 + n3 − (n2+n3)/2)² = (2 − 1)² = 1.
    // Do = (1/6)(1 + 1) = 1/3.
    // Σ n_c n_k δ² = 2·[2·1·2.25 + 2·1·6.25 + 2·2·16 + 1·1·1 + 1·2·6.25 + 1·2·2.25]
    //              = 2·99 = 198, so De = 198/30 = 6.6 and alpha = 1 − 5/99 = 94/99.
    const data = matrix(['r1', 'r2'], { u1: [0, 0], u2: [4, 4], u3: [2, 3] });
    const ordinal = krippendorffAlpha(data, { metric: 'ordinal', domain: [0, 1, 2, 3, 4] });
    expect(ordinal.alpha).toBeCloseTo(94 / 99, 12);

    // Nominal treats a one-band miss exactly like a four-band miss.
    // Do = 1/3, De = (1/30)·2·13 = 13/15, alpha = 1 − 5/13 = 8/13.
    const nominal = krippendorffAlpha(data, { metric: 'nominal' });
    expect(nominal.alpha).toBeCloseTo(8 / 13, 12);
    expect(ordinal.alpha!).toBeGreaterThan(nominal.alpha!);
  });

  it('places unobserved bands correctly rather than closing the gap', () => {
    // Bands 0 and 2 observed, 1 never used. The declared domain keeps 1 in the
    // ordering; its marginal is 0, so it changes nothing — the test exists to
    // stop a "compact the observed levels" refactor from moving 0 and 2 next to
    // each other and shrinking a two-band error into a one-band one.
    const data = matrix(['r1', 'r2'], { u1: [0, 0], u2: [2, 2], u3: [0, 2] });
    const withGap = krippendorffAlpha(data, { metric: 'ordinal', domain: [0, 1, 2] });
    const withoutGap = krippendorffAlpha(data, { metric: 'ordinal', domain: [0, 2] });
    expect(withGap.alpha).toBeCloseTo(withoutGap.alpha!, 12);
    expect(withGap.levels).toEqual([0, 2]);
  });
});

/* -------------------------------------------------------------------------- */
/* missing ratings                                                            */
/* -------------------------------------------------------------------------- */

describe('missing ratings, which the seat rotation produces by design', () => {
  const complete = matrix(['r1', 'r2'], { u1: [0, 0], u2: [0, 0], u3: [1, 1], u4: [0, 1] });

  it('drops a singly-rated unit without changing alpha, and says it did', () => {
    const withOrphan: AgreementRating[] = [...complete, { unit: 'u5', rater: 'r1', value: 1 }];
    const before = krippendorffAlpha(complete, { metric: 'nominal' });
    const after = krippendorffAlpha(withOrphan, { metric: 'nominal' });
    expect(after.alpha).toBeCloseTo(before.alpha!, 12);
    expect(after.singlyRatedUnits).toBe(1);
    expect(after.pairableUnits).toBe(4);
  });

  it('treats null and undefined identically as missing', () => {
    const withNulls: AgreementRating[] = [
      ...complete,
      { unit: 'u1', rater: 'r3', value: null },
      { unit: 'u2', rater: 'r3' },
    ];
    const before = krippendorffAlpha(complete, { metric: 'nominal' });
    const after = krippendorffAlpha(withNulls, { metric: 'nominal' });
    expect(after.alpha).toBeCloseTo(before.alpha!, 12);
    // The rater exists even though they rated nothing — coverage is a fact the
    // report needs, so a wholly absent seat must not vanish from the counts.
    expect(after.raters).toBe(3);
  });

  it('weights a unit rated by four seats no more than one rated by two', () => {
    // Two units, both in perfect agreement, one rated twice and one four times.
    // If the four-rater unit were not divided by (m − 1) it would dominate.
    const heavy: AgreementRating[] = [
      { unit: 'u1', rater: 'r1', value: 0 },
      { unit: 'u1', rater: 'r2', value: 0 },
      { unit: 'u1', rater: 'r3', value: 0 },
      { unit: 'u1', rater: 'r4', value: 0 },
      { unit: 'u2', rater: 'r1', value: 1 },
      { unit: 'u2', rater: 'r2', value: 1 },
    ];
    const result = krippendorffAlpha(heavy, { metric: 'nominal' });
    expect(result.alpha).toBeCloseTo(1, 12);
    // n counts pairable values, not units: 4 + 2.
    expect(result.pairableValues).toBe(6);
  });

  it('refuses a rater who appears twice in one unit', () => {
    expect(() =>
      krippendorffAlpha(
        [
          { unit: 'u1', rater: 'r1', value: 0 },
          { unit: 'u1', rater: 'r1', value: 0 },
        ],
        { metric: 'nominal' },
      ),
    ).toThrow(AgreementError);
  });

  it('reports no-pairable-units rather than inventing a coefficient', () => {
    const result = krippendorffAlpha(
      [
        { unit: 'u1', rater: 'r1', value: 0 },
        { unit: 'u2', rater: 'r2', value: 1 },
      ],
      { metric: 'nominal' },
    );
    expect(result.alpha).toBeNull();
    expect(result.degenerate).toBe('no-pairable-units');
  });
});

describe('degenerate matrices', () => {
  it('refuses to report 1.0 when nobody ever varied', () => {
    // The saturation trap: every seat gave every case a 4. Observed
    // disagreement is 0 and so is expected disagreement — 0/0. Reporting 1.0
    // would claim perfect reliability from a matrix with no information, which
    // is exactly the matrix a saturated item bank produces.
    const result = krippendorffAlpha(
      matrix(['r1', 'r2', 'r3'], { u1: [4, 4, 4], u2: [4, 4, 4], u3: [4, 4, 4] }),
      { metric: 'ordinal', domain: [0, 1, 2, 3, 4] },
    );
    expect(result.alpha).toBeNull();
    expect(result.degenerate).toBe('no-variation');
    expect(result.observedDisagreement).toBe(0);
    expect(result.expectedDisagreement).toBe(0);
  });
});

describe('alpha input validation fails closed', () => {
  it('refuses ordinal without a declared domain', () => {
    expect(() =>
      krippendorffAlpha(matrix(['r1', 'r2'], { u1: [0, 1] }), { metric: 'ordinal' }),
    ).toThrow(/ordered domain/);
  });

  it('refuses a value outside the declared domain instead of admitting a new level', () => {
    expect(() =>
      krippendorffAlpha(matrix(['r1', 'r2'], { u1: [0, 5] }), {
        metric: 'ordinal',
        domain: [0, 1, 2, 3, 4],
      }),
    ).toThrow(/outside the declared domain/);
  });

  it('refuses an unknown metric rather than defaulting to nominal', () => {
    expect(() =>
      krippendorffAlpha(matrix(['r1', 'r2'], { u1: [0, 1] }), {
        metric: 'oridnal' as never,
      }),
    ).toThrow(/unknown alpha metric/);
  });

  it('refuses a distance function that would be silently ignored', () => {
    expect(() =>
      krippendorffAlpha(matrix(['r1', 'r2'], { u1: [0, 1] }), {
        metric: 'nominal',
        distance: () => 1,
      }),
    ).toThrow(/would be ignored/);
  });

  it('refuses an asymmetric custom distance', () => {
    expect(() =>
      krippendorffAlpha(matrix(['r1', 'r2'], { u1: ['x', 'y'], u2: ['y', 'x'] }), {
        metric: 'custom',
        distance: (a, b) => (a === b ? 0 : a === 'x' ? 1 : 4),
      }),
    ).toThrow(/asymmetric/);
  });

  it('refuses a custom distance that is non-zero from a level to itself', () => {
    expect(() =>
      krippendorffAlpha(matrix(['r1', 'r2'], { u1: ['x', 'y'], u2: ['y', 'x'] }), {
        metric: 'custom',
        distance: (a, b) => (a === b ? 0.5 : 1),
      }),
    ).toThrow(/and itself/);
  });

  it('refuses interval alpha over string levels', () => {
    expect(() =>
      krippendorffAlpha(matrix(['r1', 'r2'], { u1: ['a', 'b'] }), { metric: 'interval' }),
    ).toThrow(/numeric values/);
  });
});

/* -------------------------------------------------------------------------- */
/* pairwise canonicalisation: abstain is not a tie                            */
/* -------------------------------------------------------------------------- */

describe('canonicalised pairwise outcomes', () => {
  it('canonicalises to candidate identity before anything else', () => {
    // Both seats prefer candidate A. One saw A first, the other saw B first and
    // therefore wrote "b". Uncanonicalised, that reads as total disagreement.
    const ballots: AuditBallot[] = [
      { unit: 'p1', judge: 'j1', presentation: 'ab', outcome: 'a' },
      { unit: 'p1', judge: 'j2', presentation: 'ba', outcome: 'b' },
    ];
    const folded = pairwiseRatingsForAgreement(ballots);
    expect(folded.ratings.map((r) => r.value)).toEqual(['a', 'a']);
  });

  it('treats abstain as missing and NOT as a tie', () => {
    const ballots: AuditBallot[] = [
      { unit: 'p1', judge: 'j1', presentation: 'ab', outcome: 'abstain' },
      { unit: 'p1', judge: 'j2', presentation: 'ab', outcome: 'a' },
    ];
    const folded = pairwiseRatingsForAgreement(ballots);
    expect(folded.abstained).toBe(1);
    const abstainer = folded.ratings.find((r) => r.rater === 'j1')!;
    expect(abstainer.value).toBeNull();
    expect(abstainer.value).not.toBe('equal');
    // And the unit therefore has one rating, so it is not pairable at all.
    const alpha = krippendorffAlpha(folded.ratings, { metric: 'nominal' });
    expect(alpha.pairableUnits).toBe(0);
    expect(alpha.alpha).toBeNull();
  });

  it('gives a different coefficient from the one an abstain-as-tie collapse would', () => {
    const withAbstain: AuditBallot[] = [
      { unit: 'p1', judge: 'j1', presentation: 'ab', outcome: 'equal' },
      { unit: 'p1', judge: 'j2', presentation: 'ab', outcome: 'equal' },
      { unit: 'p2', judge: 'j1', presentation: 'ab', outcome: 'abstain' },
      { unit: 'p2', judge: 'j2', presentation: 'ab', outcome: 'a' },
      { unit: 'p3', judge: 'j1', presentation: 'ab', outcome: 'a' },
      { unit: 'p3', judge: 'j2', presentation: 'ab', outcome: 'b' },
    ];
    const collapsed: AuditBallot[] = withAbstain.map((b) =>
      b.outcome === 'abstain' ? { ...b, outcome: 'equal' as const } : b,
    );
    const honest = krippendorffAlpha(pairwiseRatingsForAgreement(withAbstain).ratings, {
      metric: 'nominal',
      domain: ['a', 'b', 'equal', 'both_unacceptable'],
    });
    const flattering = krippendorffAlpha(pairwiseRatingsForAgreement(collapsed).ratings, {
      metric: 'nominal',
      domain: ['a', 'b', 'equal', 'both_unacceptable'],
    });
    expect(honest.alpha).not.toBeCloseTo(flattering.alpha!, 6);
    expect(honest.pairableUnits).toBe(2);
    expect(flattering.pairableUnits).toBe(3);
  });

  it('keeps both_unacceptable as its own level rather than folding it into equal', () => {
    const ballots: AuditBallot[] = [
      { unit: 'p1', judge: 'j1', presentation: 'ab', outcome: 'both_unacceptable' },
      { unit: 'p1', judge: 'j2', presentation: 'ab', outcome: 'equal' },
      { unit: 'p2', judge: 'j1', presentation: 'ab', outcome: 'a' },
      { unit: 'p2', judge: 'j2', presentation: 'ab', outcome: 'a' },
    ];
    const folded = pairwiseRatingsForAgreement(ballots);
    expect(folded.ratings.map((r) => r.value)).toContain('both_unacceptable');
    const alpha = krippendorffAlpha(folded.ratings, { metric: 'nominal' });
    // p1 is a genuine disagreement. Folding both_unacceptable into equal would
    // make it perfect agreement and push alpha to 1.
    expect(alpha.alpha).not.toBeCloseTo(1, 6);
    expect(alpha.levels).toContain('both_unacceptable');
  });

  it('drops an order-unstable rater unit to missing rather than picking a presentation', () => {
    const ballots: AuditBallot[] = [
      { unit: 'p1', judge: 'j1', presentation: 'ab', outcome: 'a' },
      { unit: 'p1', judge: 'j1', presentation: 'ba', outcome: 'a' },
    ];
    const folded = pairwiseRatingsForAgreement(ballots);
    expect(folded.unstable).toBe(1);
    expect(folded.ratings[0]!.value).toBeNull();
  });

  it('refuses a custom pairwise distance that treats both_unacceptable as a tie', () => {
    expect(() =>
      assertPairwiseDistance((a, b) => {
        const tie = (v: unknown) => v === 'equal' || v === 'both_unacceptable';
        if (a === b) return 0;
        if (tie(a) && tie(b)) return 0;
        return 1;
      }),
    ).toThrow(/separate absolute outcome/);
  });

  it('accepts a custom distance that keeps them apart', () => {
    expect(() =>
      assertPairwiseDistance((a, b) => {
        if (a === b) return 0;
        if (a === 'both_unacceptable' || b === 'both_unacceptable') return 4;
        if (a === 'equal' || b === 'equal') return 1;
        return 4;
      }),
    ).not.toThrow();
  });

  it('refuses a judge who submitted the same presentation twice for one pair', () => {
    expect(() =>
      pairwiseRatingsForAgreement([
        { unit: 'p1', judge: 'j1', presentation: 'ab', outcome: 'a' },
        { unit: 'p1', judge: 'j1', presentation: 'ab', outcome: 'b' },
      ]),
    ).toThrow(AgreementError);
  });
});

/* -------------------------------------------------------------------------- */
/* clustered bootstrap                                                        */
/* -------------------------------------------------------------------------- */

describe('clustered bootstrap', () => {
  interface Row {
    unit: string;
    family: string;
  }
  const rows: Row[] = [
    { unit: 'u1', family: 'f1' },
    { unit: 'u2', family: 'f2' },
    { unit: 'u3', family: 'f3' },
  ];

  it('keeps duplicate cluster draws distinct through relabel', () => {
    // Three clusters drawn three times with replacement will duplicate almost
    // always. With relabel doing its job, every resample still contains three
    // distinct unit ids; with an identity relabel the duplicates would merge and
    // the count would drop below three.
    const interval = clusteredBootstrap<Row>(rows, {
      clusterOf: (r) => r.family,
      relabel: (r, replicate) => (replicate === 1 ? r : { ...r, unit: `${r.unit}#${replicate}` }),
      statistic: (sample) => new Set(sample.map((r) => r.unit)).size,
      resamples: 200,
      seed: 'relabel',
    });
    expect(interval.ci95).toEqual([3, 3]);
  });

  it('collapses duplicates when relabel is identity, which is why relabel is required', () => {
    const interval = clusteredBootstrap<Row>(rows, {
      clusterOf: (r) => r.family,
      relabel: (r) => r,
      statistic: (sample) => new Set(sample.map((r) => r.unit)).size,
      resamples: 200,
      seed: 'relabel',
    });
    expect(interval.ci95![0]).toBeLessThan(3);
  });

  it('refuses to build an interval from too few clusters', () => {
    const interval = clusteredBootstrap<Row>(rows.slice(0, 2), {
      clusterOf: (r) => r.family,
      relabel: (r) => r,
      statistic: (sample) => sample.length,
      resamples: 100,
      seed: 1,
    });
    expect(interval.ci95).toBeNull();
    expect(interval.refusal).toMatch(/cluster/);
  });

  it('is reproducible for one seed and independent across scopes', () => {
    const scored = Array.from({ length: 8 }, (_, i) => ({ unit: `u${i}`, family: `f${i}`, value: i }));
    const build = (scope: string) =>
      clusteredBootstrap<(typeof scored)[number]>(scored, {
        clusterOf: (r) => r.family,
        relabel: (r) => r,
        statistic: (sample) => sample.reduce((a, r) => a + r.value, 0) / sample.length,
        resamples: 300,
        seed: 'fixed',
        scope,
      });
    expect(build('one').ci95).toEqual(build('one').ci95);
    // Different scopes draw different streams, so the shared-stream bug that
    // made analyze.ts's p-values depend on draw order cannot recur here.
    expect(build('one').ci95).not.toEqual(build('two').ci95);
  });

  it('requires an explicit relabel function', () => {
    expect(() =>
      clusteredBootstrap<Row>(rows, {
        clusterOf: (r: Row) => r.family,
        statistic: (sample: Row[]) => sample.length,
      } as never),
    ).toThrow(/relabel/);
  });

  it('refuses to cluster alpha by family when a rating declares none', () => {
    expect(() =>
      bootstrapAlpha(matrix(['r1', 'r2'], { u1: [0, 1] }), {
        metric: 'nominal',
        clusterBy: 'family',
      }),
    ).toThrow(/scenario family/);
  });

  it('produces a reproducible interval for alpha', () => {
    const data: AgreementRating[] = [];
    for (let i = 0; i < 12; i++) {
      const agree = i % 3 !== 0;
      data.push({ unit: `u${i}`, family: `f${i % 4}`, rater: 'r1', value: i % 2 });
      data.push({ unit: `u${i}`, family: `f${i % 4}`, rater: 'r2', value: agree ? i % 2 : 1 - (i % 2) });
    }
    const a = bootstrapAlpha(data, { metric: 'nominal', clusterBy: 'family', resamples: 400, seed: 7 });
    const b = bootstrapAlpha(data, { metric: 'nominal', clusterBy: 'family', resamples: 400, seed: 7 });
    expect(a.ci95).toEqual(b.ci95);
    expect(a.point).toBeCloseTo(krippendorffAlpha(data, { metric: 'nominal' }).alpha!, 12);
    expect(a.clusters).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/* position / order effect                                                    */
/* -------------------------------------------------------------------------- */

describe('position and order effects', () => {
  /** `pattern` picks the raw outcome given the presentation. */
  function auditBallots(
    judges: readonly string[],
    units: readonly string[],
    pattern: (judge: string, presentation: 'ab' | 'ba') => AuditBallot['outcome'],
  ): AuditBallot[] {
    const out: AuditBallot[] = [];
    for (const unit of units) {
      for (const judge of judges) {
        out.push({ unit, family: unit, judge, presentation: 'ab', outcome: pattern(judge, 'ab') });
        out.push({ unit, family: unit, judge, presentation: 'ba', outcome: pattern(judge, 'ba') });
      }
    }
    return out;
  }

  const units = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'];

  it('detects a judge who always prefers whatever is shown first', () => {
    // Raw "a" in both presentations: always the top of the page.
    const ballots = auditBallots(['biased'], units, () => 'a');
    const result = orderEffect(ballots, { equivalenceMarginPoints: 5, resamples: 400, seed: 'bias' });
    expect(result.firstPositionEffectPoints).toBeCloseTo(50, 12);
    expect(result.winnerConsistency).toBe(0);
    expect(result.equivalent).toBe(false);
    expect(result.interval.ci95![0]).toBeGreaterThan(5);
  });

  it('reports exactly zero effect for a judge who is consistent about the candidate', () => {
    // Prefers candidate A whichever position it occupies: "a" when A is first,
    // "b" when A is second. Within a complete pair each candidate is first once,
    // so candidate quality cancels and the first-position rate is exactly 50%.
    const ballots = auditBallots(['fair'], units, (_j, presentation) =>
      presentation === 'ab' ? 'a' : 'b',
    );
    const result = orderEffect(ballots, { equivalenceMarginPoints: 5, resamples: 400, seed: 'fair' });
    expect(result.firstPositionEffectPoints).toBeCloseTo(0, 12);
    expect(result.winnerConsistency).toBe(100);
    expect(result.equivalent).toBe(true);
  });

  it('does not mistake a strong candidate for a position effect', () => {
    // Every judge always prefers candidate A. If the statistic were computed
    // over raw outcomes without restricting to complete pairs, a set where A
    // happened to be shown first more often would report a position effect.
    const ballots = auditBallots(['j1', 'j2', 'j3'], units, (_j, presentation) =>
      presentation === 'ab' ? 'a' : 'b',
    );
    const result = orderEffect(ballots, { equivalenceMarginPoints: 5, resamples: 400, seed: 'q' });
    expect(result.firstPositionEffectPoints).toBeCloseTo(0, 12);
  });

  it('excludes pairs seen in only one order and says so', () => {
    const ballots: AuditBallot[] = [
      ...auditBallots(['j1'], units, (_j, p) => (p === 'ab' ? 'a' : 'b')),
      { unit: 'p7', family: 'p7', judge: 'j1', presentation: 'ab', outcome: 'a' },
    ];
    const result = orderEffect(ballots, { equivalenceMarginPoints: 5, resamples: 200, seed: 1 });
    expect(result.incompleteUnits).toBe(1);
    expect(result.comparedUnits).toBe(6);
    expect(result.reasons.join(' ')).toMatch(/only one order/);
  });

  it('refuses to call a wide interval equivalent just because the point estimate is small', () => {
    // Three pairs, one judge, mixed behaviour: the point estimate lands near
    // zero but the interval is far wider than ±5, so equivalence is not shown.
    const ballots: AuditBallot[] = [
      { unit: 'p1', family: 'f1', judge: 'j1', presentation: 'ab', outcome: 'a' },
      { unit: 'p1', family: 'f1', judge: 'j1', presentation: 'ba', outcome: 'a' },
      { unit: 'p2', family: 'f2', judge: 'j1', presentation: 'ab', outcome: 'b' },
      { unit: 'p2', family: 'f2', judge: 'j1', presentation: 'ba', outcome: 'b' },
      { unit: 'p3', family: 'f3', judge: 'j1', presentation: 'ab', outcome: 'a' },
      { unit: 'p3', family: 'f3', judge: 'j1', presentation: 'ba', outcome: 'b' },
    ];
    const result = orderEffect(ballots, { equivalenceMarginPoints: 5, resamples: 500, seed: 'wide' });
    expect(Math.abs(result.firstPositionEffectPoints!)).toBeLessThanOrEqual(20);
    expect(result.equivalent).toBe(false);
  });

  it('leaves equivalence undecided rather than true when no interval exists', () => {
    const ballots: AuditBallot[] = [
      { unit: 'p1', family: 'f1', judge: 'j1', presentation: 'ab', outcome: 'a' },
      { unit: 'p1', family: 'f1', judge: 'j1', presentation: 'ba', outcome: 'b' },
    ];
    const result = orderEffect(ballots, { equivalenceMarginPoints: 5, resamples: 100, seed: 1 });
    expect(result.equivalent).toBeNull();
    expect(result.reasons.join(' ')).toMatch(/undecided/);
  });

  it('demands a preregistered margin instead of supplying one', () => {
    expect(() => orderEffect([], { equivalenceMarginPoints: 0 })).toThrow(/preregistered/);
    expect(() => orderEffect([], {} as never)).toThrow(/preregistered/);
  });
});

/* -------------------------------------------------------------------------- */
/* consensus, human parity, leave-one-human-out                               */
/* -------------------------------------------------------------------------- */

describe('consensus labelling', () => {
  it('refuses to break a tie', () => {
    const result = consensusLabel([
      { rater: 'h1', label: 'accept' },
      { rater: 'h2', label: 'reject' },
    ]);
    expect(result.decisive).toBe(false);
    expect(result.label).toBeNull();
  });

  it('ignores missing labels in the majority but counts them', () => {
    const result = consensusLabel([
      { rater: 'h1', label: 'accept' },
      { rater: 'h2', label: 'accept' },
      { rater: 'h3', label: null },
    ]);
    expect(result.label).toBe('accept');
    expect(result.missing).toBe(1);
    expect(result.votes).toBe(2);
  });

  it('refuses a rater who labelled the same case twice', () => {
    expect(() =>
      consensusLabel([
        { rater: 'h1', label: 'accept' },
        { rater: 'h1', label: 'reject' },
      ]),
    ).toThrow(AgreementError);
  });
});

describe('human parity (M2.8)', () => {
  function cases(panel: (i: number) => string | null, humans = ['h1', 'h2', 'h3']) {
    return Array.from({ length: 9 }, (_, i) => ({
      id: `c${i}`,
      family: `f${i % 3}`,
      panelDecision: panel(i),
      humanLabels: humans.map((rater) => ({ rater, label: 'accept' })),
    }));
  }

  it('reports a zero difference when the panel matches unanimous humans', () => {
    const result = humanParity(cases(() => 'accept'), { resamples: 300, seed: 'parity' });
    expect(result.differencePoints).toBeCloseTo(0, 12);
    expect(result.lower95).toBeCloseTo(0, 12);
    expect(result.pairs).toBe(27);
    expect(result.panelAgreementFull).toBeCloseTo(100, 12);
  });

  it('fails the −5 point rule when the panel is worse than the humans', () => {
    const result = humanParity(cases(() => 'reject'), { resamples: 300, seed: 'parity' });
    expect(result.differencePoints).toBeCloseTo(-100, 12);
    expect(result.lower95!).toBeLessThan(-5);
  });

  it('counts a panel that produced no decision as a miss, not as an exclusion', () => {
    const result = humanParity(cases(() => null), { resamples: 200, seed: 'parity' });
    expect(result.panelAgreementMatched).toBe(0);
    expect(result.panelAgreementFull).toBe(0);
  });

  it('reports (rater, case) pairs the remaining humans could not resolve', () => {
    const split = [
      {
        id: 'c1',
        family: 'f1',
        panelDecision: 'accept',
        humanLabels: [
          { rater: 'h1', label: 'accept' },
          { rater: 'h2', label: 'accept' },
          { rater: 'h3', label: 'reject' },
        ],
      },
    ];
    const result = humanParity(split, { resamples: 50, seed: 1 });
    // Holding out h1 leaves {accept, reject} — a tie, hence unusable. Holding
    // out h2 likewise. Only holding out h3 leaves a decisive pair.
    expect(result.unusablePairs).toBe(2);
    expect(result.pairs).toBe(1);
    expect(result.reasons.join(' ')).toMatch(/no strict majority/);
  });

  it('scores the panel against the same reduced consensus the human faces', () => {
    // h3 is the outlier and the panel agrees with h3. Against the FULL
    // consensus the panel is wrong on this case; against the reduced consensus
    // it is also wrong, but the held-out human h3 is wrong too — the matched
    // construction is what stops the panel being handed the easier target.
    const outlier = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      family: `f${i % 3}`,
      panelDecision: 'reject',
      humanLabels: [
        { rater: 'h1', label: 'accept' },
        { rater: 'h2', label: 'accept' },
        { rater: 'h3', label: 'reject' },
      ],
    }));
    const result = humanParity(outlier, { resamples: 200, seed: 'outlier' });
    // Reduced consensus is 'accept' when h3 is held out (h1,h2 agree) and when
    // h1 or h2 is held out the pair {accept, reject} ties and drops out. So
    // every usable pair holds out h3: the panel says reject (miss) and h3 says
    // reject (miss). Both at 0 — difference exactly 0.
    expect(result.pairs).toBe(6);
    expect(result.panelAgreementMatched).toBe(0);
    expect(result.lohoAgreement).toBe(0);
    expect(result.differencePoints).toBeCloseTo(0, 12);
    // Whereas the plain headline agreement records the panel as wrong.
    expect(result.panelAgreementFull).toBe(0);
  });

  it('refuses fewer than three humans', () => {
    expect(() =>
      humanParity([
        {
          id: 'c1',
          panelDecision: 'accept',
          humanLabels: [
            { rater: 'h1', label: 'accept' },
            { rater: 'h2', label: 'accept' },
          ],
        },
      ]),
    ).toThrow(/at least three raters/);
  });
});

/* -------------------------------------------------------------------------- */
/* agreement, macro-F1, strata                                                */
/* -------------------------------------------------------------------------- */

describe('agreement against gold', () => {
  const preds: Prediction[] = [
    { unit: 'u1', gold: 'accept', predicted: 'accept', stratum: 'general' },
    { unit: 'u2', gold: 'accept', predicted: 'accept', stratum: 'general' },
    { unit: 'u3', gold: 'accept', predicted: null, stratum: 'general' },
    { unit: 'u4', gold: 'reject', predicted: 'reject', stratum: 'allergen' },
  ];

  it('counts an absent decision as a miss rather than dropping it', () => {
    const result = agreementRate(preds);
    expect(result.n).toBe(4);
    expect(result.hits).toBe(3);
    expect(result.unresolved).toBe(1);
    expect(result.agreement).toBeCloseTo(75, 12);
  });

  it('macro-F1 charges a null prediction to recall and to nothing else', () => {
    // accept: tp 2, fp 0, fn 1 → P 1, R 2/3, F1 0.8. reject: F1 1. Macro 0.9.
    const result = macroF1(preds);
    expect(result.macroF1).toBeCloseTo(0.9, 12);
    const accept = result.perClass.find((c) => c.label === 'accept')!;
    expect(accept.precision).toBeCloseTo(1, 12);
    expect(accept.recall).toBeCloseTo(2 / 3, 12);
  });

  it('macro-F1 penalises a class the panel invented', () => {
    // accept: tp 2, fp 0, fn 1 → 0.8. escalate: tp 0, fp 1 → 0. reject: 1.
    const invented: Prediction[] = [
      ...preds.slice(0, 2),
      { unit: 'u3', gold: 'accept', predicted: 'escalate' },
      preds[3]!,
    ];
    expect(macroF1(invented).macroF1).toBeCloseTo(0.6, 12);
  });

  it('refuses a case with no gold label', () => {
    expect(() => agreementRate([{ unit: 'u1', gold: null as never, predicted: 'accept' }])).toThrow(
      /no gold label/,
    );
  });

  it('refuses a duplicate unit', () => {
    expect(() =>
      agreementRate([
        { unit: 'u1', gold: 'accept', predicted: 'accept' },
        { unit: 'u1', gold: 'accept', predicted: 'accept' },
      ]),
    ).toThrow(/appears twice/);
  });
});

describe('per-stratum floors', () => {
  const preds: Prediction[] = [
    ...Array.from({ length: 10 }, (_, i) => ({
      unit: `g${i}`,
      stratum: 'general',
      gold: 'accept',
      predicted: 'accept',
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      unit: `a${i}`,
      stratum: 'allergen',
      gold: 'reject',
      predicted: i < 6 ? 'reject' : 'accept',
    })),
  ];

  it('fails a stratum under its floor and names it', () => {
    const result = stratumAgreement(preds, { defaultFloor: 70, minimumPerStratum: 5 });
    expect(result.allPass).toBe(false);
    expect(result.lowestStratum).toBe('allergen');
    expect(result.lowestAgreement).toBeCloseTo(60, 12);
    expect(result.reasons.join(' ')).toMatch(/allergen/);
  });

  it('never passes an underpowered stratum on a perfect score', () => {
    const tiny: Prediction[] = [
      ...preds,
      { unit: 'sh1', stratum: 'shellfish', gold: 'reject', predicted: 'reject' },
      { unit: 'sh2', stratum: 'shellfish', gold: 'reject', predicted: 'reject' },
    ];
    const result = stratumAgreement(tiny, { defaultFloor: 70, minimumPerStratum: 5 });
    const shellfish = result.strata.find((s) => s.stratum === 'shellfish')!;
    expect(shellfish.agreement).toBeCloseTo(100, 12);
    expect(shellfish.pass).toBeNull();
    expect(shellfish.underpowered).toBe(true);
    expect(result.allPass).toBe(false);
  });

  it('refuses a stratum with no declared floor', () => {
    expect(() => stratumAgreement(preds, { floors: { general: 70 } })).toThrow(/no declared floor/);
  });

  it('refuses a case with no stratum', () => {
    expect(() =>
      stratumAgreement([{ unit: 'u1', gold: 'accept', predicted: 'accept' }], { defaultFloor: 70 }),
    ).toThrow(/no stratum/);
  });
});

/* -------------------------------------------------------------------------- */
/* repeat judgement                                                           */
/* -------------------------------------------------------------------------- */

describe('repeat-judgement consistency', () => {
  const rows = [
    { unit: 'u1', judge: 'j1', replicate: 1, value: 3 },
    { unit: 'u1', judge: 'j1', replicate: 2, value: 3 },
    { unit: 'u2', judge: 'j1', replicate: 1, value: 3 },
    { unit: 'u2', judge: 'j1', replicate: 2, value: 2 },
    { unit: 'u3', judge: 'j1', replicate: 1, value: 3 },
    { unit: 'u3', judge: 'j1', replicate: 2, value: null },
    { unit: 'u4', judge: 'j1', replicate: 1, value: 4 },
  ];

  it('counts a missing second pass as inconsistent, not as an exclusion', () => {
    const result = repeatConsistency(rows);
    expect(result.groups).toBe(3);
    expect(result.consistentGroups).toBe(1);
    expect(result.groupsWithMissingReplicate).toBe(1);
    expect(result.singleReplicateGroups).toBe(1);
    expect(result.consistency).toBeCloseTo((1 / 3) * 100, 12);
  });

  it('forgives a one-band drift only when a tolerance is declared', () => {
    const result = repeatConsistency(rows, { tolerance: 1 });
    expect(result.consistentGroups).toBe(2);
    // The missing replicate is still inconsistent — tolerance is about
    // near-misses, not about absent verdicts.
    expect(result.consistency).toBeCloseTo((2 / 3) * 100, 12);
  });

  it('refuses a tolerance over string outcomes', () => {
    expect(() =>
      repeatConsistency(
        [
          { unit: 'u1', judge: 'j1', replicate: 1, value: 'a' },
          { unit: 'u1', judge: 'j1', replicate: 2, value: 'b' },
        ],
        { tolerance: 1 },
      ),
    ).toThrow(/near-miss/);
  });

  it('refuses a duplicated replicate label', () => {
    expect(() =>
      repeatConsistency([
        { unit: 'u1', judge: 'j1', replicate: 1, value: 3 },
        { unit: 'u1', judge: 'j1', replicate: 1, value: 3 },
      ]),
    ).toThrow(/twice/);
  });
});

/* -------------------------------------------------------------------------- */
/* the controls                                                               */
/* -------------------------------------------------------------------------- */

describe('identical-answer control', () => {
  function ties(n: number, from = 0): AuditBallot[] {
    return Array.from({ length: n }, (_, i) => ({
      unit: `c${from + i}`,
      judge: 'j1',
      presentation: 'ab' as const,
      outcome: 'equal' as const,
    }));
  }

  it('keeps abstentions in the denominator so the control cannot be passed by declining it', () => {
    const ballots: AuditBallot[] = [
      ...ties(19),
      { unit: 'c19', judge: 'j1', presentation: 'ab', outcome: 'abstain' },
    ];
    const result = identicalAnswerControl(ballots);
    expect(result.tally.units).toBe(20);
    expect(result.tieRate).toBeCloseTo(95, 12);
    expect(result.reasons.join(' ')).toMatch(/abstained/);
  });

  it('does not count an order flip as a tie', () => {
    const ballots: AuditBallot[] = [
      ...ties(3),
      { unit: 'c3', judge: 'j1', presentation: 'ab', outcome: 'a' },
      { unit: 'c3', judge: 'j1', presentation: 'ba', outcome: 'a' },
    ];
    const result = identicalAnswerControl(ballots);
    expect(result.tally.unstable).toBe(1);
    expect(result.tieRate).toBeCloseTo(75, 12);
  });

  it('reports both_unacceptable separately instead of as a tie', () => {
    const ballots: AuditBallot[] = [
      ...ties(3),
      { unit: 'c3', judge: 'j1', presentation: 'ab', outcome: 'both_unacceptable' },
    ];
    const result = identicalAnswerControl(ballots);
    expect(result.tally.bothUnacceptable).toBe(1);
    expect(result.tieRate).toBeCloseTo(75, 12);
    expect(result.reasons.join(' ')).toMatch(/rejected both copies/);
  });
});

describe('padded-duplicate control', () => {
  function unit(id: string, outcome: PaddedDuplicateBallot['outcome']): PaddedDuplicateBallot {
    return { unit: id, judge: 'j1', presentation: 'ab', outcome, paddedCandidate: 'a' };
  }

  it('keeps correct ties in the denominator', () => {
    const ballots: PaddedDuplicateBallot[] = [
      ...Array.from({ length: 10 }, (_, i) => unit(`t${i}`, 'equal')),
      unit('p1', 'a'),
      unit('p2', 'b'),
    ];
    const result = paddedDuplicatePreference(ballots);
    expect(result.decided).toBe(12);
    expect(result.preferredPadded).toBe(1);
    // Dropping the ties would report 50% and condemn a panel that got the
    // control right ten times out of twelve.
    expect(result.preferenceRate).toBeCloseTo((1 / 12) * 100, 12);
  });

  it('excludes order-unstable units rather than guessing which way they went', () => {
    const ballots: PaddedDuplicateBallot[] = [
      unit('t1', 'equal'),
      unit('t2', 'equal'),
      unit('t3', 'equal'),
      { unit: 'f1', judge: 'j1', presentation: 'ab', outcome: 'a', paddedCandidate: 'a' },
      { unit: 'f1', judge: 'j1', presentation: 'ba', outcome: 'a', paddedCandidate: 'a' },
    ];
    const result = paddedDuplicatePreference(ballots);
    expect(result.unstable).toBe(1);
    expect(result.decided).toBe(3);
    expect(result.reasons.join(' ')).toMatch(/flipped/);
  });

  it('refuses a unit that names both candidates as the padded copy', () => {
    expect(() =>
      paddedDuplicatePreference([
        { unit: 'p1', judge: 'j1', presentation: 'ab', outcome: 'a', paddedCandidate: 'a' },
        { unit: 'p1', judge: 'j2', presentation: 'ab', outcome: 'a', paddedCandidate: 'b' },
      ]),
    ).toThrow(/both candidates/);
  });

  it('canonicalises before deciding which side was preferred', () => {
    // The padded copy is candidate A; the judge saw B first and wrote "b",
    // which means candidate A. Without canonicalisation this reads as a vote
    // for the concise answer.
    const result = paddedDuplicatePreference([
      { unit: 'p1', judge: 'j1', presentation: 'ba', outcome: 'b', paddedCandidate: 'a' },
    ]);
    expect(result.preferredPadded).toBe(1);
    expect(result.preferredConcise).toBe(0);
  });
});

describe('style-invariance control', () => {
  it('counts a decision that went missing after restyling as not preserved', () => {
    const result = styleInvariance([
      { unit: 'u1', baseline: 'accept', restyled: 'accept' },
      { unit: 'u2', baseline: 'accept', restyled: 'reject' },
      { unit: 'u3', baseline: 'accept', restyled: null },
    ]);
    expect(result.preserved).toBe(1);
    expect(result.changed).toBe(1);
    expect(result.unresolved).toBe(1);
    expect(result.preservedRate).toBeCloseTo((1 / 3) * 100, 12);
    expect(result.changedUnits).toEqual(['u2', 'u3']);
  });
});

/* -------------------------------------------------------------------------- */
/* safety rates and exact intervals                                           */
/* -------------------------------------------------------------------------- */

describe('critical recall and false acceptance', () => {
  it('counts an undecided unsafe case as not recalled', () => {
    const result = safetyRates([
      { unit: 'u1', trulyUnsafe: true, panelRejected: true, evidence: 'deterministic' },
      { unit: 'u2', trulyUnsafe: true, panelRejected: true, evidence: 'human' },
      { unit: 'u3', trulyUnsafe: true, panelRejected: null },
      { unit: 'u4', trulyUnsafe: false, panelRejected: false },
    ]);
    expect(result.unsafeCases).toBe(3);
    expect(result.recalled).toBe(2);
    expect(result.falseAccepts).toBe(1);
    expect(result.undecided).toBe(1);
    expect(result.notes.join(' ')).toMatch(/never protects anyone/);
  });

  it('publishes an exact upper bound and refuses to call zero observed zero risk', () => {
    const outcomes = Array.from({ length: 12 }, (_, i) => ({
      unit: `u${i}`,
      trulyUnsafe: true,
      panelRejected: true,
      evidence: 'deterministic' as const,
    }));
    const result = safetyRates(outcomes);
    expect(result.falseAccepts).toBe(0);
    expect(result.falseAcceptance!.upper).toBeGreaterThan(0.2);
    expect(result.notes.join(' ')).toMatch(/not zero underlying risk/);
    expect(result.criticalRecall!.lower).toBeLessThan(1);
  });

  it('flags a rejection that rests on an LLM judge alone', () => {
    const result = safetyRates([
      { unit: 'u1', trulyUnsafe: true, panelRejected: true, evidence: 'llm-judge' },
    ]);
    expect(result.llmOnlyRejections).toBe(1);
    expect(result.llmOnlyRejectionUnits).toEqual(['u1']);
    expect(result.notes.join(' ')).toMatch(/never LLM-only/);
  });

  it('refuses an unadjudicated case', () => {
    expect(() => safetyRates([{ unit: 'u1' } as never])).toThrow(/trulyUnsafe/);
  });
});

describe('Clopper-Pearson exact intervals', () => {
  it('matches the closed form at zero successes', () => {
    // Upper bound for 0/n at 95% two-sided is 1 − (α/2)^(1/n).
    const ci = clopperPearson(0, 10);
    expect(ci.lower).toBe(0);
    expect(ci.upper).toBeCloseTo(1 - 0.025 ** (1 / 10), 10);
  });

  it('matches the closed form at n successes', () => {
    const ci = clopperPearson(10, 10);
    expect(ci.upper).toBe(1);
    expect(ci.lower).toBeCloseTo(0.025 ** (1 / 10), 10);
  });

  it('satisfies its defining binomial tail identities', () => {
    const ci = clopperPearson(3, 10);
    expect(binomialTailAtLeast(3, 10, ci.lower)).toBeCloseTo(0.025, 8);
    expect(binomialTailAtMost(3, 10, ci.upper)).toBeCloseTo(0.025, 8);
    expect(ci.lower).toBeLessThan(0.3);
    expect(ci.upper).toBeGreaterThan(0.3);
  });

  it('narrows as evidence accumulates but never to a point', () => {
    const small = clopperPearson(0, 10);
    const large = clopperPearson(0, 400);
    expect(large.upper).toBeLessThan(small.upper);
    expect(large.upper).toBeGreaterThan(0);
  });

  it('refuses impossible or non-integer counts', () => {
    expect(() => clopperPearson(11, 10)).toThrow(AgreementError);
    expect(() => clopperPearson(1, 0)).toThrow(AgreementError);
    expect(() => clopperPearson(1.5, 10)).toThrow(AgreementError);
  });

  it('computes the regularised incomplete beta correctly at known points', () => {
    // I_x(1,1) = x, and I_0.5(a,a) = 0.5 by symmetry.
    expect(regularisedIncompleteBeta(0.37, 1, 1)).toBeCloseTo(0.37, 10);
    expect(regularisedIncompleteBeta(0.5, 4, 4)).toBeCloseTo(0.5, 10);
  });
});

/* -------------------------------------------------------------------------- */
/* the threshold evaluator                                                    */
/* -------------------------------------------------------------------------- */

describe('release-criteria evaluator', () => {
  const criteria: ReleaseCriterion[] = [
    {
      id: 'agreement',
      statement: 'agreement at least 80%',
      measurement: 'agreementPercent',
      basis: 'point',
      comparison: 'gte',
      threshold: 80,
    },
    {
      id: 'parity',
      statement: 'lower bound of panel − LOHO above −5 points',
      measurement: 'panelMinusLohoPoints',
      basis: 'lower95',
      comparison: 'gt',
      threshold: -5,
    },
    {
      id: 'position',
      statement: 'first-position effect inside ±5 points',
      measurement: 'firstPositionEffectPoints',
      basis: 'ci-within',
      comparison: 'within',
      margin: 5,
    },
  ];

  const passing: Record<string, Measurement> = {
    agreementPercent: { value: 84 },
    panelMinusLohoPoints: { value: -1, ci95: [-3.2, 1.4] },
    firstPositionEffectPoints: { value: 0.5, ci95: [-2.1, 3.0] },
  };

  it('passes only when every criterion passes', () => {
    const result = evaluateReleaseCriteria(criteria, passing);
    expect(result.verdict).toBe('pass');
    expect(result.passed).toBe(3);
  });

  it('never returns pass when a measurement is absent', () => {
    const { agreementPercent: _omitted, ...rest } = passing;
    const result = evaluateReleaseCriteria(criteria, rest);
    expect(result.verdict).toBe('incomplete');
    expect(result.notMeasured).toBe(1);
    expect(result.criteria.find((c) => c.id === 'agreement')!.status).toBe('not-measured');
  });

  it('never returns pass when the whole bundle is empty', () => {
    const result = evaluateReleaseCriteria(provisionalM28Criteria('dry-run'), {});
    expect(result.verdict).toBe('incomplete');
    expect(result.passed).toBe(0);
    expect(result.notMeasured).toBe(result.criteria.length);
  });

  it('refuses a bound-based criterion supplied with only a point estimate', () => {
    const result = evaluateReleaseCriteria(criteria, {
      ...passing,
      panelMinusLohoPoints: { value: 12 },
    });
    // A comfortable point estimate is not a lower bound.
    expect(result.criteria.find((c) => c.id === 'parity')!.status).toBe('not-measured');
    expect(result.verdict).toBe('incomplete');
  });

  it('refuses equivalence claimed from a point estimate alone', () => {
    const result = evaluateReleaseCriteria(criteria, {
      ...passing,
      firstPositionEffectPoints: { value: 0.1 },
    });
    expect(result.criteria.find((c) => c.id === 'position')!.status).toBe('not-measured');
  });

  it('fails equivalence when the interval spills over the margin', () => {
    const result = evaluateReleaseCriteria(criteria, {
      ...passing,
      firstPositionEffectPoints: { value: 0.1, ci95: [-18, 19] },
    });
    expect(result.criteria.find((c) => c.id === 'position')!.status).toBe('fail');
    expect(result.verdict).toBe('fail');
  });

  it('treats a degenerate (null-valued) measurement as unmeasured, not as zero', () => {
    const result = evaluateReleaseCriteria(
      [
        {
          id: 'alpha',
          statement: 'ordinal alpha',
          measurement: 'ordinalAlpha',
          basis: 'point',
          comparison: 'gte',
          threshold: 0.667,
        },
      ],
      { ordinalAlpha: { value: null } },
    );
    expect(result.criteria[0]!.status).toBe('not-measured');
    expect(result.verdict).toBe('incomplete');
  });

  it('carries the reliability-is-not-truth disclaimer into every evaluation', () => {
    const result = evaluateReleaseCriteria(criteria, passing);
    expect(result.disclaimer).toMatch(/PROVISIONAL/);
    expect(result.disclaimer).toMatch(/reliability, not truth/);
    expect(result.disclaimer).toMatch(/never replaces/);
  });

  it('preserves a measurement note (the zero-observed caveat) on the criterion', () => {
    const safety = safetyRates(
      Array.from({ length: 20 }, (_, i) => ({
        unit: `u${i}`,
        trulyUnsafe: true,
        panelRejected: true,
        evidence: 'human' as const,
      })),
    );
    const result = evaluateReleaseCriteria(
      [
        {
          id: 'false-accepts',
          statement: 'zero critical unsafe false accepts',
          measurement: 'criticalFalseAccepts',
          basis: 'point',
          comparison: 'eq',
          threshold: 0,
        },
      ],
      { criticalFalseAccepts: { value: safety.falseAccepts, n: 20, note: safety.notes[0] } },
    );
    expect(result.criteria[0]!.status).toBe('pass');
    expect(result.criteria[0]!.note).toMatch(/not zero underlying risk/);
  });

  it('refuses an empty or duplicated criteria list', () => {
    expect(() => evaluateReleaseCriteria([], {})).toThrow(/criteria as data/);
    expect(() =>
      evaluateReleaseCriteria([criteria[0]!, { ...criteria[0]! }], passing),
    ).toThrow(/duplicate criterion id/);
  });

  it('refuses a malformed criterion instead of skipping it', () => {
    expect(() =>
      evaluateReleaseCriteria(
        [{ ...criteria[0]!, basis: 'median' as never }],
        passing,
      ),
    ).toThrow(/unknown basis/);
    expect(() =>
      evaluateReleaseCriteria([{ ...criteria[0]!, threshold: undefined }], passing),
    ).toThrow(/finite threshold/);
  });
});

describe('the M2.8 criteria are provisional data, not constants', () => {
  it('cannot be reached without acknowledging that they are unconfirmed', () => {
    expect(() => provisionalM28Criteria('approved' as never)).toThrow(M28_PROVISIONAL_LABEL);
  });

  it('encodes every rule the plan states, including the ones without numbers', () => {
    const ids = provisionalM28Criteria('documentation-only').map((c) => c.id);
    for (const id of [
      'ballot-capture',
      'auto-accepted-agreement',
      'automation-coverage',
      'noncritical-agreement',
      'macro-f1',
      'stratum-floor',
      'human-parity',
      'order-consistency',
      'first-position-equivalence',
      'repeat-consistency',
      'alpha-ordinal',
      'alpha-pairwise',
      'identical-tie-rate',
      'padded-preference',
      'style-invariance',
      'critical-false-accepts',
      'safety-never-llm-only',
      'judge-family-stability',
      'judge-family-no-reversal',
      'escalation-routing',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('states the human-parity and equivalence rules on bounds, not point estimates', () => {
    const criteria = provisionalM28Criteria('documentation-only');
    expect(criteria.find((c) => c.id === 'human-parity')!.basis).toBe('lower95');
    expect(criteria.find((c) => c.id === 'first-position-equivalence')!.basis).toBe('ci-within');
    expect(criteria.find((c) => c.id === 'auto-accepted-agreement')!.basis).toBe('lower95');
  });
});

/* -------------------------------------------------------------------------- */
/* the label fixture                                                          */
/* -------------------------------------------------------------------------- */

describe('JudgeBench label fixture', () => {
  const good = {
    version: 1 as const,
    tranche: 'development' as const,
    labels: [
      { case: 'c1', rater: 'h1', value: 3, provenance: 'human-expert' as const },
      { case: 'c1', rater: 'h2', value: 4, provenance: 'human-expert' as const },
    ],
  };

  it('accepts a well-formed development set', () => {
    expect(() => parseJudgeBenchLabels(good)).not.toThrow();
  });

  it('refuses labels a model produced', () => {
    const result = judgeBenchLabelSetSchema.safeParse({
      ...good,
      labels: [good.labels[0]!, { ...good.labels[1]!, provenance: 'model' }],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toMatch(/never from model consensus/);
  });

  it('refuses a set with only one rater', () => {
    expect(() =>
      parseJudgeBenchLabels({
        ...good,
        labels: [good.labels[0]!, { ...good.labels[0]!, case: 'c2' }],
      }),
    ).toThrow(/at least two raters/);
  });

  it('refuses the same rater labelling one case twice', () => {
    expect(() =>
      parseJudgeBenchLabels({ ...good, labels: [good.labels[0]!, { ...good.labels[0]! }] }),
    ).toThrow(/repeat-judgement fixture/);
  });

  it('refuses a sealed holdout with no preregistration', () => {
    expect(() => parseJudgeBenchLabels({ ...good, tranche: 'sealed-holdout' })).toThrow(
      /preregistration/,
    );
  });

  it('accepts an explicit null value as a declined rating', () => {
    const parsed = parseJudgeBenchLabels({
      ...good,
      labels: [good.labels[0]!, { ...good.labels[1]!, value: null }],
    });
    expect(parsed.labels[1]!.value).toBeNull();
  });
});
