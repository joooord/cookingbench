/**
 * M4.4 fixtures.
 *
 * These are written to break the module, not to demonstrate it. Each block
 * targets a specific way the analysis could quietly report more certainty than
 * it has: multiplicity (91 uncorrected tests are live today), correlated items
 * drawn apart, a chained tie promoted to a shared tier, a phantom opponent
 * inventing evidence across clusters that were never compared, and a
 * both-unacceptable verdict smuggled back in as half a win.
 */

import { describe, expect, it } from 'vitest';
import {
  assertClaimLanguage,
  clusterBootstrapMean,
  comparisonGraph,
  davidsonClusterBootstrap,
  davidsonSummary,
  fitDavidson,
  FORBIDDEN_CLAIM_PHRASES,
  holmAdjust,
  practicalMarginIssues,
  rankFragility,
  resolvePracticalMargin,
  separationClaim,
  smallestFlipSet,
  StatsError,
  supportedTiers,
  type AuditUnitScores,
  type ClusterUnit,
  type PairwiseObservation,
} from '../src/stats.js';

/* -------------------------------------------------------------------------- */
/* Holm                                                                       */
/* -------------------------------------------------------------------------- */

describe('holmAdjust', () => {
  it('is monotone: the adjusted column never falls as the raw p rises', () => {
    // (m − i)·p is NOT monotone on its own — a bigger raw p can carry a smaller
    // multiplier — so without the running maximum a report sorted on the
    // adjusted column would show a weaker result above a stronger one.
    const tests = [0.001, 0.02, 0.021, 0.022, 0.5, 0.9].map((p, i) => ({ key: `t${i}`, p }));
    const out = holmAdjust(tests);
    const byRaw = [...out].sort((a, b) => a.p - b.p);
    for (let i = 1; i < byRaw.length; i++) {
      expect(byRaw[i]!.pAdjusted).toBeGreaterThanOrEqual(byRaw[i - 1]!.pAdjusted);
    }
    for (const d of out) expect(d.pAdjusted).toBeGreaterThanOrEqual(d.p);
  });

  it('rejections form a prefix — nothing is rejected above a failure', () => {
    const tests = [0.0001, 0.004, 0.03, 0.04, 0.9].map((p, i) => ({ key: `t${i}`, p }));
    const out = holmAdjust(tests).sort((a, b) => a.step - b.step);
    let seenFailure = false;
    for (const d of out) {
      if (!d.rejected) seenFailure = true;
      else expect(seenFailure).toBe(false);
    }
  });

  it('kills the live defect: 91 pairs at an uncorrected p of 0.04 order nothing', () => {
    // This is the shape of run 2026-07-v2.1's "48 of 91 pairs separate". Every
    // one of these clears 0.05 on its own and not one survives the family.
    const tests = Array.from({ length: 91 }, (_, i) => ({ key: `pair-${i}`, p: 0.04 }));
    const out = holmAdjust(tests);
    expect(out.every((d) => !d.rejected)).toBe(true);
    expect(out[0]!.pAdjusted).toBe(1);
  });

  it('still finds a genuinely strong result inside a large family', () => {
    const tests = [
      { key: 'strong', p: 0.0001 },
      ...Array.from({ length: 90 }, (_, i) => ({ key: `noise-${i}`, p: 0.4 })),
    ];
    const out = holmAdjust(tests);
    expect(out.find((d) => d.key === 'strong')!.rejected).toBe(true);
    expect(out.filter((d) => d.rejected)).toHaveLength(1);
  });

  it('matches the sequential procedure by hand', () => {
    // m = 3. 0.01·3 = 0.03 ≤ 0.05; 0.02·2 = 0.04 ≤ 0.05; 0.04·1 = 0.04 but the
    // running maximum has already reached 0.04, so all three are rejected.
    const out = holmAdjust([
      { key: 'a', p: 0.01 },
      { key: 'b', p: 0.02 },
      { key: 'c', p: 0.04 },
    ]).sort((x, y) => x.step - y.step);
    expect(out.map((d) => Math.round(d.pAdjusted * 1000) / 1000)).toEqual([0.03, 0.04, 0.04]);
    expect(out.every((d) => d.rejected)).toBe(true);
  });

  it('refuses a duplicate key rather than correcting over a miscounted family', () => {
    expect(() => holmAdjust([{ key: 'a', p: 0.1 }, { key: 'a', p: 0.2 }])).toThrow(StatsError);
  });

  it('refuses a p outside [0, 1], a NaN and a nonsense alpha', () => {
    expect(() => holmAdjust([{ key: 'a', p: 1.2 }])).toThrow(/lie in \[0, 1\]/);
    expect(() => holmAdjust([{ key: 'a', p: Number.NaN }])).toThrow(/lie in \[0, 1\]/);
    expect(() => holmAdjust([{ key: 'a', p: 0.01 }], 0)).toThrow(/alpha/);
    expect(() => holmAdjust([{ key: 'a', p: 0.01 }], 1)).toThrow(/alpha/);
  });

  it('orders equal p-values by key so the multipliers are reproducible', () => {
    // Bootstrap p-values pile up on the 1/(reps+1) floor; without a stable
    // tie-break the assignment of multipliers would depend on insertion order.
    const a = holmAdjust([
      { key: 'z', p: 0.01 },
      { key: 'a', p: 0.01 },
    ]);
    const b = holmAdjust([
      { key: 'a', p: 0.01 },
      { key: 'z', p: 0.01 },
    ]);
    expect(a).toEqual(b);
  });
});

/* -------------------------------------------------------------------------- */
/* Practical margin                                                           */
/* -------------------------------------------------------------------------- */

describe('practical margin', () => {
  it('refuses absence, refuses zero, and refuses an unattributed margin', () => {
    expect(practicalMarginIssues(undefined)).toHaveLength(1);
    expect(() => resolvePracticalMargin(null)).toThrow(/not preregistered/);
    expect(() =>
      resolvePracticalMargin({
        points: 0,
        preregisteredIn: 'run-x',
        approvedBy: 'someone',
        rationale: 'because',
      }),
    ).toThrow(/greater than zero/);
    expect(() =>
      resolvePracticalMargin({
        points: 2,
        preregisteredIn: '  ',
        approvedBy: 'someone',
        rationale: 'because',
      }),
    ).toThrow(/preregisteredIn/);
  });

  it('accepts a complete record', () => {
    expect(
      resolvePracticalMargin({
        points: 2.5,
        preregisteredIn: 'analysis-plan-v3',
        approvedBy: 'measurement review',
        rationale: 'smallest gap a reader would change a purchase on',
      }),
    ).toBe(2.5);
  });
});

/* -------------------------------------------------------------------------- */
/* Cluster bootstrap                                                          */
/* -------------------------------------------------------------------------- */

function units(spec: Array<[cluster: string, values: number[]]>): ClusterUnit[] {
  const out: ClusterUnit[] = [];
  for (const [cluster, values] of spec) {
    values.forEach((value, i) => out.push({ cluster, id: `${cluster}-${i}`, value }));
  }
  return out;
}

describe('clusterBootstrapMean', () => {
  it('orders a pair the item bootstrap orders, and refuses to once families are honoured', () => {
    // Twenty items in two scenario families that disagree. Drawn item by item
    // the disagreement averages out, the interval clears zero and the pair
    // looks ordered. Drawn as the two families they actually are, the answer
    // depends entirely on which family the draw favours — and the interval says
    // so. This is the whole reason M4.4 asks for a cluster bootstrap, and it is
    // a difference in the published verdict, not merely in the error bar.
    const spec: Array<[string, number[]]> = [
      ['fam-a', Array.from({ length: 10 }, () => 6)],
      ['fam-b', Array.from({ length: 10 }, () => -2)],
    ];
    const clustered = clusterBootstrapMean(units(spec), { seed: 'c', reps: 4000 });
    const perItem = clusterBootstrapMean(
      units(spec).map((u) => ({ ...u, cluster: u.id })),
      { seed: 'c', reps: 4000 },
    );
    expect(clustered.mean).toBeCloseTo(2, 6);
    expect(perItem.mean).toBeCloseTo(2, 6);
    expect(perItem.lower).toBeGreaterThan(0);
    expect(clustered.lower).toBeLessThan(0);
    expect(clustered.upper - clustered.lower).toBeGreaterThan(
      (perItem.upper - perItem.lower) * 2,
    );
  });

  it('refuses to bootstrap a single cluster instead of reporting zero width', () => {
    expect(() =>
      clusterBootstrapMean(units([['only', [1, 2, 3, 4]]]), { seed: 's' }),
    ).toThrow(/one cluster/);
  });

  it('refuses an interval whose quantile it cannot resolve', () => {
    // 0.05/91 is the Bonferroni level for the live 91-pair family. At 4,000
    // draws the bound would be read off order statistic 1.
    expect(() =>
      clusterBootstrapMean(units([['a', [1, 2]], ['b', [3, 4]]]), {
        seed: 's',
        reps: 4000,
        alpha: 0.05 / 91,
      }),
    ).toThrow(/order statistics/);
  });

  it('never reports a p-value of exactly zero', () => {
    const r = clusterBootstrapMean(
      units([
        ['a', [100, 100, 100]],
        ['b', [100, 100, 100]],
        ['c', [100, 100, 100]],
      ]),
      { seed: 's', reps: 1000 },
    );
    expect(r.pValue).toBeGreaterThan(0);
    expect(r.pValue).toBeCloseTo(1 / 1001, 6);
  });

  it('refuses a unit with no cluster, a non-finite value and an empty seed', () => {
    expect(() =>
      clusterBootstrapMean([{ cluster: '', id: 'x', value: 1 }], { seed: 's' }),
    ).toThrow(/no cluster id/);
    expect(() =>
      clusterBootstrapMean(
        [
          { cluster: 'a', id: 'x', value: Number.NaN },
          { cluster: 'b', id: 'y', value: 1 },
        ],
        { seed: 's' },
      ),
    ).toThrow(/non-finite/);
    expect(() => clusterBootstrapMean(units([['a', [1]], ['b', [2]]]), { seed: '' })).toThrow(
      /seed/,
    );
  });

  it('is reproducible from its seed label alone', () => {
    const spec: Array<[string, number[]]> = [
      ['a', [4, 5, 6]],
      ['b', [-1, 0, 1]],
      ['c', [2, 2, 2]],
    ];
    expect(clusterBootstrapMean(units(spec), { seed: 'k', reps: 1000 })).toEqual(
      clusterBootstrapMean(units(spec), { seed: 'k', reps: 1000 }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Supported tiers                                                            */
/* -------------------------------------------------------------------------- */

describe('supportedTiers', () => {
  it('does not let a chain of ties become a shared tier', () => {
    // The 2026-07-v2.1 disaster in miniature: a ties b, b ties c, c ties d, but
    // a is ordered above d. Walking the chain merges all four into one tier and
    // hands d a share of first place.
    const rankOrder = ['a', 'b', 'c', 'd'];
    const pairs = [
      { a: 'a', b: 'b', ordered: false },
      { a: 'b', b: 'c', ordered: false },
      { a: 'c', b: 'd', ordered: false },
      { a: 'a', b: 'c', ordered: false },
      { a: 'b', b: 'd', ordered: false },
      { a: 'a', b: 'd', ordered: true },
    ];
    const { tiers, places } = supportedTiers(rankOrder, pairs);
    expect(places.get('a')).toBe(1);
    expect(places.get('d')).toBe(2);
    const topTier = tiers.find((t) => t.models.includes('a'))!;
    expect(topTier.models).not.toContain('d');
    // b and c are genuinely unbeaten, so they do share the top group. That is
    // the honest reading, and it is not the twelve-way blob: d is excluded on
    // the strength of one direct test, not on the chain.
    expect(topTier.models).toEqual(['a', 'b', 'c']);
  });

  it('splits a place group that contains a directly ordered pair', () => {
    // "Ordered" is not transitive either, so two models can accumulate the same
    // number of superiors while one is ordered above the other. Publishing them
    // as one indistinguishable group would contradict a test we ran.
    // x is ordered above p, p is ordered above q, and x versus q is NOT
    // ordered — non-transitivity, which the wider spread of a middling model
    // produces routinely. p and q therefore both carry exactly one superior and
    // land on place 2, while p sits directly above q.
    const rankOrder = ['x', 'p', 'q'];
    const pairs = [
      { a: 'x', b: 'p', ordered: true },
      { a: 'p', b: 'q', ordered: true },
      { a: 'x', b: 'q', ordered: false },
    ];
    const { tiers, splits, places } = supportedTiers(rankOrder, pairs);
    expect(places.get('p')).toBe(2);
    expect(places.get('q')).toBe(2);
    expect(splits).toHaveLength(1);
    const withP = tiers.find((t) => t.models.includes('p'))!;
    expect(withP.models).not.toContain('q');
    expect(withP.splitFrom).toBe(2);
  });

  it('refuses a contradictory ordering rather than tiering a cycle', () => {
    expect(() =>
      supportedTiers(['a', 'b'], [
        { a: 'a', b: 'b', ordered: true },
        { a: 'b', b: 'a', ordered: true },
      ]),
    ).toThrow(/contradictory/);
  });

  it('refuses a pair naming a model outside the ranking, and a duplicate ranking', () => {
    expect(() => supportedTiers(['a', 'b'], [{ a: 'a', b: 'ghost', ordered: true }])).toThrow(
      /absent from rankOrder/,
    );
    expect(() => supportedTiers(['a', 'a'], [])).toThrow(/duplicate/);
  });

  it('gives every model place 1 when nothing at all is ordered', () => {
    const { tiers } = supportedTiers(['a', 'b', 'c'], [
      { a: 'a', b: 'b', ordered: false },
      { a: 'a', b: 'c', ordered: false },
      { a: 'b', b: 'c', ordered: false },
    ]);
    expect(tiers).toHaveLength(1);
    expect(tiers[0]!.models).toEqual(['a', 'b', 'c']);
  });
});

/* -------------------------------------------------------------------------- */
/* Claim language                                                             */
/* -------------------------------------------------------------------------- */

describe('claim language', () => {
  it('offers no wording containing a banned phrase', () => {
    for (const strength of [
      'unadjusted-screening',
      'multiplicity-adjusted',
      'adjusted-and-practical',
    ] as const) {
      expect(() => assertClaimLanguage(separationClaim(strength))).not.toThrow();
    }
  });

  it('says out loud that the unadjusted verdict is not a result', () => {
    expect(separationClaim('unadjusted-screening')).toMatch(/screening only/);
  });

  it('catches the banned phrase whatever the casing', () => {
    for (const phrase of FORBIDDEN_CLAIM_PHRASES) {
      expect(() => assertClaimLanguage(`Model A is ${phrase.toUpperCase()} than B`)).toThrow(
        StatsError,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Comparison graph and Davidson                                              */
/* -------------------------------------------------------------------------- */

function obs(
  a: string,
  b: string,
  outcome: PairwiseObservation['outcome'],
  n = 1,
): PairwiseObservation[] {
  return Array.from({ length: n }, () => ({ a, b, outcome }));
}

describe('comparison graph connectivity', () => {
  it('refuses to rate two clusters that were never compared', () => {
    const observations = [...obs('a', 'b', 'a', 5), ...obs('c', 'd', 'a', 5)];
    expect(comparisonGraph(observations).connected).toBe(false);
    expect(() => fitDavidson(observations)).toThrow(/disconnected components/);
  });

  it('does not let the phantom opponent connect them', () => {
    // The phantom gives every model a virtual win and loss, so a fitter that
    // checked connectivity after adding it would see one component and happily
    // report that {a, b} outrank {c, d} on no evidence at all.
    const observations = [...obs('a', 'b', 'a', 5), ...obs('c', 'd', 'a', 5)];
    expect(() => fitDavidson(observations, { phantom: 5 })).toThrow(/disconnected components/);
  });

  it('counts neither both_unacceptable nor abstain as an edge', () => {
    const g = comparisonGraph([
      ...obs('a', 'b', 'both_unacceptable', 3),
      ...obs('a', 'b', 'abstain', 3),
    ]);
    expect(g.edges).toBe(0);
    expect(g.components).toEqual([['a'], ['b']]);
    expect(g.isolated).toEqual(['a', 'b']);
  });

  it('surfaces a roster member with no comparisons as isolated', () => {
    const g = comparisonGraph(obs('a', 'b', 'a', 3), ['a', 'b', 'never-run']);
    expect(g.isolated).toEqual(['never-run']);
    expect(g.connected).toBe(false);
  });

  it('refuses a self-comparison and an unknown outcome', () => {
    expect(() => comparisonGraph([{ a: 'a', b: 'a', outcome: 'a' }])).toThrow(/itself/);
    expect(() =>
      comparisonGraph([{ a: 'a', b: 'b', outcome: 'draw' as PairwiseObservation['outcome'] }]),
    ).toThrow();
  });
});

describe('Davidson fit', () => {
  const connected = (): PairwiseObservation[] => [
    ...obs('a', 'b', 'a', 7),
    ...obs('a', 'b', 'b', 2),
    ...obs('a', 'b', 'equal', 4),
    ...obs('b', 'c', 'a', 6),
    ...obs('b', 'c', 'b', 1),
    ...obs('b', 'c', 'equal', 5),
    ...obs('a', 'c', 'a', 9),
    ...obs('a', 'c', 'b', 1),
    ...obs('a', 'c', 'equal', 2),
  ];

  it('recovers the ordering and fits a positive tie parameter', () => {
    const fit = fitDavidson(connected());
    expect(fit.ratings.map((r) => r.modelId)).toEqual(['a', 'b', 'c']);
    expect(fit.nu).toBeGreaterThan(0);
  });

  it('collapses to Bradley-Terry when nothing tied', () => {
    const fit = fitDavidson(connected().filter((o) => o.outcome !== 'equal'));
    expect(fit.nu).toBe(0);
  });

  it('excludes both_unacceptable from the fit entirely, and never as a tie', () => {
    const base = connected();
    const withRejections = [...base, ...obs('a', 'b', 'both_unacceptable', 6)];
    const fit = fitDavidson(withRejections);
    const clean = fitDavidson(base);

    // Counted, reported, and kept out of every rating.
    const a = fit.ratings.find((r) => r.modelId === 'a')!;
    expect(a.bothUnacceptable).toBe(6);
    expect(a.ties).toBe(6); // 4 vs b + 2 vs c — the six rejections are not here
    expect(fit.excluded.bothUnacceptable).toBe(6);
    expect(fit.nu).toBe(clean.nu);
    expect(fit.ratings.map((r) => r.rating)).toEqual(clean.ratings.map((r) => r.rating));

    // …and folding them in as ties, which is the tempting shortcut, does move
    // the numbers — so the distinction is not cosmetic.
    const asTie = fitDavidson([...base, ...obs('a', 'b', 'equal', 6)]);
    expect(asTie.nu).not.toBe(clean.nu);
  });

  it('treats abstain as missingness, not as a tie and not as a loss', () => {
    const base = connected();
    const fit = fitDavidson([...base, ...obs('b', 'c', 'abstain', 4)]);
    const clean = fitDavidson(base);
    expect(fit.excluded.abstain).toBe(4);
    expect(fit.ratings.find((r) => r.modelId === 'b')!.abstain).toBe(4);
    expect(fit.ratings.map((r) => r.rating)).toEqual(clean.ratings.map((r) => r.rating));
  });

  it('refuses a winless, tieless model when the phantom prior is disabled', () => {
    expect(() => fitDavidson(obs('a', 'b', 'a', 5), { phantom: 0 })).toThrow(/no wins and no ties/);
    const withPrior = fitDavidson(obs('a', 'b', 'a', 5));
    expect(Number.isFinite(withPrior.ratings[1]!.rating)).toBe(true);
  });

  it('refuses a negative phantom weight', () => {
    expect(() => fitDavidson(obs('a', 'b', 'a', 3), { phantom: -1 })).toThrow(/non-negative/);
  });

  it('refuses to report a fit that has not converged', () => {
    expect(() => fitDavidson(connected(), { maxIterations: 2 })).toThrow(/no convergence/);
  });
});

describe('davidsonSummary', () => {
  const base: PairwiseObservation[] = [
    ...obs('a', 'b', 'a', 6),
    ...obs('a', 'b', 'b', 3),
    ...obs('a', 'b', 'equal', 3),
    ...obs('b', 'c', 'a', 5),
    ...obs('b', 'c', 'b', 3),
    ...obs('b', 'c', 'equal', 3),
    ...obs('a', 'c', 'a', 7),
    ...obs('a', 'c', 'b', 2),
    ...obs('a', 'c', 'equal', 2),
  ];

  it('runs the declared scenarios and quantifies what the exclusion is worth', () => {
    const summary = davidsonSummary([...base, ...obs('a', 'c', 'both_unacceptable', 5)]);
    expect(summary.scenarios.map((s) => s.scenario)).toEqual([
      'primary',
      'both-unacceptable-as-tie',
      'drop-affected-pairs',
    ]);
    const asTie = summary.scenarios.find((s) => s.scenario === 'both-unacceptable-as-tie')!;
    expect(asTie.fit).not.toBeNull();
    expect(asTie.maxRatingShift).toBeGreaterThan(0);
  });

  it('reports rejections per model as a release-gating signal, never as a rating', () => {
    const summary = davidsonSummary([...base, ...obs('a', 'c', 'both_unacceptable', 5)]);
    const c = summary.bothUnacceptableByModel.find((m) => m.modelId === 'c')!;
    expect(c.bothUnacceptable).toBe(5);
    expect(c.rate).toBeGreaterThan(0);
    expect(summary.primary.ratings.find((r) => r.modelId === 'c')!.valid).toBe(22);
  });

  it('records a refused scenario instead of substituting the primary fit', () => {
    // Dropping the affected pair leaves c with no valid comparison at all, so
    // the scenario cannot be fitted. Reporting the primary numbers under its
    // name would say the sensitivity analysis passed when it never ran.
    const summary = davidsonSummary(
      [
        ...obs('a', 'b', 'a', 5),
        ...obs('a', 'b', 'equal', 2),
        ...obs('b', 'c', 'a', 4),
        ...obs('b', 'c', 'both_unacceptable', 2),
      ],
      { models: ['a', 'b', 'c'] },
    );
    const dropped = summary.scenarios.find((s) => s.scenario === 'drop-affected-pairs')!;
    expect(dropped.fit).toBeNull();
    expect(dropped.refusal).toMatch(/disconnected components/);
    expect(summary.sensitiveToExclusion).toBe(true);
  });
});

describe('davidsonClusterBootstrap', () => {
  const clustered = (
    a: string,
    b: string,
    outcome: PairwiseObservation['outcome'],
    cluster: string,
    n = 1,
  ): PairwiseObservation[] => obs(a, b, outcome, n).map((o) => ({ ...o, cluster }));

  const spread = (): PairwiseObservation[] => {
    const out: PairwiseObservation[] = [];
    for (let f = 0; f < 8; f++) {
      const fam = `fam-${f}`;
      out.push(...clustered('a', 'b', 'a', fam, 3), ...clustered('a', 'b', 'equal', fam, 1));
      out.push(...clustered('b', 'c', 'a', fam, 2), ...clustered('b', 'c', 'b', fam, 1));
      out.push(...clustered('a', 'c', 'a', fam, 3), ...clustered('a', 'c', 'equal', fam, 1));
    }
    return out;
  };

  it('refuses a ballot with no scenario family rather than treating it as its own', () => {
    // Falling back to one-cluster-per-ballot is the exact error being guarded
    // against, and it would be invisible in the output.
    expect(() =>
      davidsonClusterBootstrap([...obs('a', 'b', 'a', 4), ...obs('b', 'c', 'a', 4)], {
        seed: 's',
        reps: 20,
      }),
    ).toThrow(/declares no scenario family/);
  });

  it('produces intervals that bracket the point estimate', () => {
    const result = davidsonClusterBootstrap(spread(), { seed: 's', reps: 200 });
    expect(result.refusal).toBeUndefined();
    expect(result.intervals).not.toBeNull();
    for (const i of result.intervals!) {
      expect(i.lower).toBeLessThanOrEqual(i.rating);
      expect(i.upper).toBeGreaterThanOrEqual(i.rating);
    }
  });

  it('refuses intervals when most resamples cannot be fitted', () => {
    // Two families, and c only ever appears in one of them, so half the draws
    // leave it with no comparison at all. The surviving resamples are not a
    // random subset and their percentiles are not a confidence interval.
    const sparse = [
      ...clustered('a', 'b', 'a', 'fam-1', 4),
      ...clustered('a', 'b', 'b', 'fam-1', 2),
      ...clustered('b', 'c', 'a', 'fam-2', 4),
      ...clustered('b', 'c', 'b', 'fam-2', 2),
    ];
    const result = davidsonClusterBootstrap(sparse, {
      seed: 's',
      reps: 200,
      models: ['a', 'b', 'c'],
    });
    expect(result.intervals).toBeNull();
    expect(result.refusal).toMatch(/not a random subset/);
  });

  it('refuses a single-family bootstrap', () => {
    const result = davidsonClusterBootstrap(
      [...clustered('a', 'b', 'a', 'only', 4), ...clustered('a', 'b', 'b', 'only', 2)],
      { seed: 's', reps: 20 },
    );
    expect(result.intervals).toBeNull();
    expect(result.refusal).toMatch(/no variability/);
  });

  it('is reproducible from its seed', () => {
    const one = davidsonClusterBootstrap(spread(), { seed: 'k', reps: 100 });
    const two = davidsonClusterBootstrap(spread(), { seed: 'k', reps: 100 });
    expect(one.intervals).toEqual(two.intervals);
  });
});

/* -------------------------------------------------------------------------- */
/* Influence                                                                  */
/* -------------------------------------------------------------------------- */

function auditUnits(rows: Array<[string, number, number]>): AuditUnitScores[] {
  return rows.map(([unit, leader, challenger]) => ({
    unit,
    scores: { leader, challenger },
  }));
}

/** Exhaustive check that no smaller deletion set flips the leader. */
function bruteForceMinimum(units: AuditUnitScores[], models: string[]): number | null {
  const n = units.length;
  const totals = (keep: AuditUnitScores[], m: string) => keep.reduce((a, u) => a + u.scores[m]!, 0);
  const leader = [...models].sort((x, y) => totals(units, y) - totals(units, x))[0]!;
  for (let size = 1; size < n; size++) {
    for (let mask = 0; mask < 1 << n; mask++) {
      let bits = 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) bits += 1;
      if (bits !== size) continue;
      const keep = units.filter((_, i) => !(mask & (1 << i)));
      if (keep.length === 0) continue;
      const best = [...models].sort((x, y) => totals(keep, y) - totals(keep, x))[0]!;
      if (best !== leader) return size;
    }
  }
  return null;
}

describe('smallestFlipSet', () => {
  it('finds the exact minimum on a hand-built matrix', () => {
    // leader leads by 170 summed points. The two biggest per-unit differences
    // are 100 each; one is not enough, two are.
    const rows: Array<[string, number, number]> = [
      ['i1', 100, 0],
      ['i2', 100, 0],
      ['i3', 50, 60],
      ['i4', 50, 60],
      ['i5', 50, 60],
    ];
    const flip = smallestFlipSet(auditUnits(rows))!;
    expect(flip.leader).toBe('leader');
    expect(flip.challenger).toBe('challenger');
    expect(flip.size).toBe(2);
    expect(flip.units.sort()).toEqual(['i1', 'i2']);
    expect(flip.marginBefore).toBe(170);
    expect(flip.marginAfter).toBeLessThan(0);
    expect(flip.share).toBeCloseTo(0.4, 6);
  });

  it('agrees with brute force over every subset, on a matrix built to trip greed', () => {
    // Greedy-largest-first is only optimal because the denominators cancel.
    // This matrix has one huge unit and several medium ones, which is where a
    // careless "delete the best few" heuristic would report the wrong size.
    const rows: Array<[string, number, number]> = [
      ['a', 90, 10],
      ['b', 70, 40],
      ['c', 65, 45],
      ['d', 60, 50],
      ['e', 20, 80],
      ['f', 30, 70],
      ['g', 55, 50],
      ['h', 40, 60],
    ];
    const units = auditUnits(rows);
    const flip = smallestFlipSet(units);
    expect(flip?.size ?? null).toBe(bruteForceMinimum(units, ['leader', 'challenger']));
  });

  it('returns null when only deleting everything would flip it', () => {
    const rows: Array<[string, number, number]> = [
      ['i1', 100, 0],
      ['i2', 100, 0],
      ['i3', 100, 0],
    ];
    expect(smallestFlipSet(auditUnits(rows))).toBeNull();
  });

  it('prefers the challenger that needs the fewest deletions', () => {
    const units: AuditUnitScores[] = [
      { unit: 'u1', scores: { top: 100, near: 90, far: 10 } },
      { unit: 'u2', scores: { top: 100, near: 99, far: 10 } },
      { unit: 'u3', scores: { top: 10, near: 20, far: 10 } },
    ];
    const flip = smallestFlipSet(units)!;
    expect(flip.challenger).toBe('near');
    expect(flip.size).toBe(1);
  });

  it('refuses a ragged matrix rather than comparing different unit sets', () => {
    expect(() =>
      smallestFlipSet([
        { unit: 'u1', scores: { a: 1, b: 2 } },
        { unit: 'u2', scores: { a: 1 } },
      ]),
    ).toThrow(/no finite score/);
    expect(() =>
      smallestFlipSet([
        { unit: 'u1', scores: { a: 1, b: 2 } },
        { unit: 'u1', scores: { a: 1, b: 2 } },
      ]),
    ).toThrow(/duplicate unit/);
  });
});

describe('rankFragility', () => {
  it('exposes a leader that rests on one scenario family', () => {
    const units: AuditUnitScores[] = [];
    const clusterOf = new Map<string, string>();
    // Nine ordinary items where b is very slightly ahead …
    for (let i = 0; i < 9; i++) {
      units.push({ unit: `flat-${i}`, scores: { a: 70, b: 72 } });
      clusterOf.set(`flat-${i}`, `fam-${i}`);
    }
    // … and one family of three where a wins outright, which is the entire
    // source of a's lead. Any resample that misses that family — roughly a
    // third of them — hands first place to b.
    for (let i = 0; i < 3; i++) {
      units.push({ unit: `spike-${i}`, scores: { a: 100, b: 0 } });
      clusterOf.set(`spike-${i}`, 'fam-spike');
    }
    const result = rankFragility(units, clusterOf, { reps: 1000, seed: 'frag' });
    const a = result.models.find((m) => m.modelId === 'a')!;
    expect(a.publishedPlace).toBe(1);
    expect(a.pHoldsPlace).toBeLessThan(0.95);
    expect(result.topGroupStability).toBeLessThan(0.95);
  });

  it('refuses an unassigned unit and a single-cluster matrix', () => {
    const units: AuditUnitScores[] = [
      { unit: 'u1', scores: { a: 1, b: 2 } },
      { unit: 'u2', scores: { a: 1, b: 2 } },
    ];
    expect(() => rankFragility(units, new Map([['u1', 'f']]), { seed: 's' })).toThrow(
      /no cluster assignment/,
    );
    expect(() =>
      rankFragility(units, new Map([['u1', 'f'], ['u2', 'f']]), { seed: 's' }),
    ).toThrow(/reports no variability/);
  });
});
