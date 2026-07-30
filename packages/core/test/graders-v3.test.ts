import { describe, expect, it } from 'vitest';
import type { AtomicCriterion, RubricCriterion } from '../src/types.js';
import {
  applyCaps,
  CAP_MATRIX,
  CapPolicyError,
  presentationMayContribute,
  type CapFinding,
} from '../src/graders/caps.js';
import {
  capDimensions,
  combineDimensionPanel,
  combineDimensions,
  DimensionScoringError,
  type CriterionBand,
  type DimensionCriterion,
} from '../src/graders/dimension.js';
import {
  canonicaliseOutcome,
  foldRaterUnit,
  isTie,
  pairwisePoints,
  pairwiseVerdict,
  PairwiseError,
  preferenceShare,
  tallyPairwise,
  TIE_OUTCOMES,
  type PairwiseBallot,
  type RaterUnit,
} from '../src/graders/pairwise.js';
import { routeCascade, routeDimensionMode } from '../src/graders/index.js';

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function atomic(
  id: string,
  weight: number,
  extra: Partial<AtomicCriterion> = {},
): AtomicCriterion {
  return { id, kind: 'include', statement: `claim ${id}`, weight, ...extra } as AtomicCriterion;
}

function legacy(name: string, weight: number): RubricCriterion {
  return { name, description: `${name} description`, weight };
}

function bands(...entries: [string, number | null][]): CriterionBand[] {
  return entries.map(([criterion, band]) => ({ criterion, band }));
}

function seat(judge: string, entries: CriterionBand[], confidence?: number) {
  return { judge, bands: entries, confidence };
}

/* -------------------------------------------------------------------------- */
/* dimension mode — the weights must actually be read                         */
/* -------------------------------------------------------------------------- */

describe('combineDimensions — weighted arithmetic', () => {
  const criteria = [atomic('c1', 3), atomic('c2', 1), atomic('c3', 1)];

  it('matches the hand-computed weighted mean, not the unweighted one', () => {
    // bands 4/2/0 → points 100/50/0; (3·100 + 1·50 + 1·0) / 5 = 70.
    const result = combineDimensions(criteria, bands(['c1', 4], ['c2', 2], ['c3', 0]));
    expect(result.score).toBeCloseTo(70, 10);
    // The unweighted mean of the same bands is 50. If this ever equals 50 the
    // weights have been dropped again, which is the whole defect this fixes.
    expect(result.score).not.toBeCloseTo(50, 6);
  });

  it('changes when only the weights change — the declared weights are load-bearing', () => {
    const reweighted = [atomic('c1', 1), atomic('c2', 1), atomic('c3', 3)];
    const same = bands(['c1', 4], ['c2', 2], ['c3', 0]);
    expect(combineDimensions(criteria, same).score).toBeCloseTo(70, 10);
    // (1·100 + 1·50 + 3·0) / 5 = 30.
    expect(combineDimensions(reweighted, same).score).toBeCloseTo(30, 10);
  });

  it('honours legacy rubric weights that sum to 1', () => {
    const rubric = [legacy('Diagnosis', 0.4), legacy('Rescue', 0.4), legacy('Clarity', 0.2)];
    // (0.4·100 + 0.4·50 + 0.2·25) / 1.0 = 65.
    const result = combineDimensions(
      rubric,
      bands(['Diagnosis', 4], ['Rescue', 2], ['Clarity', 1]),
    );
    expect(result.score).toBeCloseTo(65, 10);
  });

  it('lets an answer be correct and dull: an exceptional criterion moves the score', () => {
    const withExceptional = [
      atomic('core', 3),
      atomic('flair', 1, { kind: 'exceptional', statement: 'goes beyond the competent answer' }),
    ];
    const dull = combineDimensions(withExceptional, bands(['core', 4], ['flair', 0]));
    const excellent = combineDimensions(withExceptional, bands(['core', 4], ['flair', 4]));
    // (3·100 + 1·0)/4 = 75 versus 100. A deduction grader scores both 100.
    expect(dull.score).toBeCloseTo(75, 10);
    expect(excellent.score).toBeCloseTo(100, 10);
    expect(excellent.score).toBeGreaterThan(dull.score);
  });

  it('does not penalise appropriately expressed uncertainty', () => {
    const criteriaWithUncertainty = [
      atomic('core', 3),
      atomic('hedge', 1, {
        dimension: 'uncertainty',
        statement: 'flags what cannot be determined from the prompt',
      }),
    ];
    const silent = combineDimensions(criteriaWithUncertainty, bands(['core', 4], ['hedge', 0]));
    const flagged = combineDimensions(criteriaWithUncertainty, bands(['core', 4], ['hedge', 4]));
    expect(flagged.score).toBeGreaterThan(silent.score);
    // And it is scored, not silently discarded as "not real content".
    expect(flagged.byDimension['uncertainty']).toBeCloseTo(100, 10);
    expect(flagged.abstained).toEqual([]);
  });
});

describe('combineDimensions — abstention is missingness', () => {
  const criteria = [atomic('c1', 3), atomic('c2', 1), atomic('c3', 1)];

  it('excludes an abstained criterion from the denominator', () => {
    // bands 4/null/0 → (3·100 + 1·0) / 4 = 75.
    const result = combineDimensions(criteria, bands(['c1', 4], ['c2', null], ['c3', 0]));
    expect(result.score).toBeCloseTo(75, 10);
    expect(result.weightUsed).toBe(4);
    expect(result.weightAbstained).toBe(1);
    expect(result.abstained).toEqual(['c2']);
    // The two ways of getting abstention wrong: counting it as zero (60) or
    // leaving it in the denominator at its band value (70).
    expect(result.score).not.toBeCloseTo(60, 6);
    expect(result.score).not.toBeCloseTo(70, 6);
  });

  it('refuses when every content criterion abstained rather than scoring 0 or 100', () => {
    expect(() =>
      combineDimensions(criteria, bands(['c1', null], ['c2', null], ['c3', null])),
    ).toThrow(DimensionScoringError);
  });

  it('refuses a silently omitted criterion — abstention must be written down', () => {
    expect(() => combineDimensions(criteria, bands(['c1', 4], ['c2', 2]))).toThrow(
      /has no band/,
    );
  });
});

describe('combineDimensions — fails closed on unusable input', () => {
  const criteria = [atomic('c1', 1), atomic('c2', 1)];

  it('refuses a mixed legacy/atomic criterion list', () => {
    const mixed: DimensionCriterion[] = [atomic('c1', 1), legacy('Clarity', 0.5)];
    expect(() => combineDimensions(mixed, bands(['c1', 4], ['Clarity', 4]))).toThrow(
      /entirely legacy|entirely atomic/,
    );
  });

  it('refuses a non-integer band rather than averaging behind the harness', () => {
    expect(() =>
      combineDimensions(criteria, [
        { criterion: 'c1', band: 3.5 },
        { criterion: 'c2', band: 4 },
      ]),
    ).toThrow(/anchored bands are integers/);
  });

  it('refuses a band outside 0–4', () => {
    expect(() => combineDimensions(criteria, bands(['c1', 5], ['c2', 4]))).toThrow(/outside 0–4/);
  });

  it('refuses a band naming a criterion the item never declared', () => {
    expect(() =>
      combineDimensions(criteria, bands(['c1', 4], ['c2', 4], ['invented', 4])),
    ).toThrow(/does not declare/);
  });

  it('refuses duplicate criterion keys', () => {
    expect(() =>
      combineDimensions([atomic('c1', 1), atomic('c1', 2)], bands(['c1', 4])),
    ).toThrow(/declared twice/);
  });

  it('refuses a zero-weight criterion — that is the decorative-weight bug again', () => {
    expect(() =>
      combineDimensions([atomic('c1', 1), atomic('c2', 0)], bands(['c1', 4], ['c2', 4])),
    ).toThrow(/weights must be positive/);
  });

  it('refuses an empty criterion list', () => {
    expect(() => combineDimensions([], [])).toThrow(DimensionScoringError);
  });
});

describe('presentation is separate and bounded', () => {
  const criteria = [
    atomic('content', 1),
    atomic('polish', 9, { dimension: 'presentation', statement: 'well laid out' }),
  ];

  it('keeps presentation out of the content score however heavily it is weighted', () => {
    const result = combineDimensions(criteria, bands(['content', 1], ['polish', 4]));
    // Content alone: band 1 → 25. If presentation were folded in at weight 9
    // the answer would read 92.5.
    expect(result.score).toBeCloseTo(25, 10);
    expect(result.presentation).toEqual({ score: 100, weight: 9 });
    expect(result.byDimension['presentation']).toBeUndefined();
  });

  it('refuses to let presentation contribute once any cap has been recorded', () => {
    const clean = applyCaps(80, []);
    expect(presentationMayContribute(clean)).toBe(true);
    // Non-binding cap: the score was already below 40, but the fault happened.
    const capped = applyCaps(30, [
      { kind: 'hard-constraint', reason: 'used the banned pan', evidence: 'deterministic' },
    ]);
    expect(capped.score).toBe(30);
    expect(capped.applied[0]!.binding).toBe(false);
    expect(presentationMayContribute(capped)).toBe(false);
  });
});

describe('dimension ceilings (M2.2 context cap)', () => {
  const criteria = [
    atomic('history', 2, { dimension: 'context' }),
    atomic('method', 2, { dimension: 'technique' }),
  ];

  it('caps the named dimension and recombines the total', () => {
    const raw = combineDimensions(criteria, bands(['history', 4], ['method', 4]));
    expect(raw.score).toBeCloseTo(100, 10);
    const capped = capDimensions(raw, { context: 40 });
    // (40·2 + 100·2) / 4 = 70.
    expect(capped.score).toBeCloseTo(70, 10);
    expect(capped.byDimension['context']).toBe(40);
    expect(capped.appliedDimensionCeilings).toEqual({ context: 40 });
  });

  it('ignores a ceiling for a dimension the item does not score', () => {
    const raw = combineDimensions(criteria, bands(['history', 4], ['method', 4]));
    expect(capDimensions(raw, { sensory: 10 }).score).toBeCloseTo(100, 10);
  });

  it('refuses an out-of-range ceiling', () => {
    const raw = combineDimensions(criteria, bands(['history', 4], ['method', 4]));
    expect(() => capDimensions(raw, { context: 140 })).toThrow(DimensionScoringError);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.2 caps — non-compensatory, applied after the weighted score             */
/* -------------------------------------------------------------------------- */

describe('applyCaps', () => {
  it('beats a high weighted score: critical safety zeroes 96', () => {
    const outcome = applyCaps(96, [
      { kind: 'critical-safety', reason: 'sous-vide chicken held at 46 °C for 3 h', evidence: 'deterministic' },
    ]);
    expect(outcome.score).toBe(0);
    expect(outcome.ceiling).toBe(0);
    expect(outcome.safetyCritical).toBe(true);
    expect(outcome.applied[0]!.binding).toBe(true);
  });

  it('beats a high weighted score: allergen failure zeroes 100', () => {
    expect(
      applyCaps(100, [
        { kind: 'critical-allergen', reason: 'peanut oil in a peanut-allergy brief', evidence: 'human' },
      ]).score,
    ).toBe(0);
  });

  it('caps a non-safety hard-constraint failure at 40 and an infeasible plan at 60', () => {
    expect(
      applyCaps(96, [{ kind: 'hard-constraint', reason: 'served 6, brief said 4', evidence: 'deterministic' }])
        .score,
    ).toBe(40);
    expect(
      applyCaps(96, [{ kind: 'infeasible-plan', reason: 'two dishes need the one oven at once', evidence: 'deterministic' }])
        .score,
    ).toBe(60);
    expect(
      applyCaps(96, [{ kind: 'omitted-required-output', reason: 'no shopping list', evidence: 'deterministic' }])
        .score,
    ).toBe(60);
  });

  it('takes the lowest ceiling when several caps apply', () => {
    const outcome = applyCaps(96, [
      { kind: 'infeasible-plan', reason: 'timing impossible', evidence: 'deterministic' },
      { kind: 'hard-constraint', reason: 'wrong servings', evidence: 'deterministic' },
    ]);
    expect(outcome.score).toBe(40);
    expect(outcome.applied).toHaveLength(2);
  });

  it('cannot be compensated by strength elsewhere — the cap is applied last', () => {
    // A perfect weighted score plus a perfect presentation score still ends at 40.
    const outcome = applyCaps(100, [
      { kind: 'hard-constraint', reason: 'used the equipment the brief excluded', evidence: 'deterministic' },
    ]);
    expect(outcome.score).toBe(40);
    expect(presentationMayContribute(outcome)).toBe(false);
  });

  it('waives an unsupported historical claim the candidate flagged as uncertain', () => {
    const flagged: CapFinding = {
      kind: 'unsupported-historical-claim',
      reason: 'attributes carbonara to 1944 GIs',
      evidence: 'llm-judge',
      dimensionCeiling: 40,
      appropriatelyFlagged: true,
    };
    const outcome = applyCaps(90, [flagged]);
    expect(outcome.score).toBe(90);
    expect(outcome.applied).toEqual([]);
    expect(outcome.waived).toHaveLength(1);
    expect(outcome.dimensionCeilings).toEqual({});
  });

  it('applies the context ceiling when the same claim is asserted as fact', () => {
    const outcome = applyCaps(90, [
      {
        kind: 'unsupported-historical-claim',
        reason: 'attributes carbonara to 1944 GIs',
        evidence: 'llm-judge',
        dimensionCeiling: 40,
      },
    ]);
    // Dimension-scope: the task score is untouched here; the combiner enforces it.
    expect(outcome.score).toBe(90);
    expect(outcome.dimensionCeilings).toEqual({ context: 40 });
  });

  it('refuses a dimension-scope finding with no declared ceiling', () => {
    expect(() =>
      applyCaps(90, [
        { kind: 'unsupported-historical-claim', reason: 'no source', evidence: 'llm-judge' },
      ]),
    ).toThrow(CapPolicyError);
  });

  it('does NOT let a hedge waive a safety cap', () => {
    // "I'm not sure, but you can probably leave it out overnight" is a hazard
    // with a hedge in front of it, not appropriate uncertainty.
    const outcome = applyCaps(95, [
      {
        kind: 'critical-safety',
        reason: 'suggests room-temperature thawing of raw chicken',
        evidence: 'human',
        appropriatelyFlagged: true,
      },
    ]);
    expect(outcome.score).toBe(0);
    expect(outcome.waived).toEqual([]);
    expect(outcome.applied[0]!.hedgeIgnored).toBe(true);
    expect(CAP_MATRIX['critical-safety'].waivedByFlaggedUncertainty).toBe(false);
    expect(CAP_MATRIX['critical-allergen'].waivedByFlaggedUncertainty).toBe(false);
  });

  it('refuses an unknown cap kind instead of ignoring it', () => {
    expect(() =>
      applyCaps(90, [{ kind: 'mildly-annoying' as never, reason: 'x', evidence: 'human' }]),
    ).toThrow(/unknown cap kind/);
  });

  it('refuses a finding with no evidence source or no reason', () => {
    expect(() =>
      applyCaps(90, [{ kind: 'hard-constraint', reason: '', evidence: 'human' }]),
    ).toThrow(CapPolicyError);
    expect(() =>
      applyCaps(90, [{ kind: 'hard-constraint', reason: 'x', evidence: 'vibes' as never }]),
    ).toThrow(CapPolicyError);
  });

  it('refuses an out-of-range weighted score', () => {
    expect(() => applyCaps(101, [])).toThrow(CapPolicyError);
    expect(() => applyCaps(Number.NaN, [])).toThrow(CapPolicyError);
  });

  it('marks a safety cap resting on LLM evidence alone', () => {
    const llmOnly = applyCaps(90, [
      { kind: 'critical-safety', reason: 'unsafe hold time', evidence: 'llm-judge' },
    ]);
    expect(llmOnly.safetyEvidenceIsLlmOnly).toBe(true);
    const confirmed = applyCaps(90, [
      { kind: 'critical-safety', reason: 'unsafe hold time', evidence: 'llm-judge' },
      { kind: 'critical-safety', reason: 'unsafe hold time', evidence: 'deterministic' },
    ]);
    expect(confirmed.safetyEvidenceIsLlmOnly).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.1 pairwise — both_unacceptable and abstain are not ties                 */
/* -------------------------------------------------------------------------- */

describe('pairwise outcomes', () => {
  it('treats only "equal" as a tie', () => {
    expect(isTie('equal')).toBe(true);
    expect(isTie('both_unacceptable')).toBe(false);
    expect(isTie('abstain')).toBe(false);
    expect([...TIE_OUTCOMES]).toEqual(['equal']);
  });

  it('refuses to give both_unacceptable or abstain half a win each', () => {
    expect(pairwisePoints('equal')).toEqual({ a: 0.5, b: 0.5 });
    expect(pairwisePoints('both_unacceptable')).toBeNull();
    expect(pairwisePoints('abstain')).toBeNull();
    // Stated as an inequality too, because "null" is only useful if nobody can
    // read it as the tie row by accident.
    expect(pairwisePoints('both_unacceptable')).not.toEqual(pairwisePoints('equal'));
  });

  it('throws on an unknown outcome rather than defaulting', () => {
    expect(() => pairwisePoints('draw' as never)).toThrow(PairwiseError);
  });

  it('canonicalises against presentation order', () => {
    expect(canonicaliseOutcome('a', 'ab')).toBe('a');
    expect(canonicaliseOutcome('a', 'ba')).toBe('b');
    expect(canonicaliseOutcome('b', 'ba')).toBe('a');
    expect(canonicaliseOutcome('equal', 'ba')).toBe('equal');
    expect(canonicaliseOutcome('both_unacceptable', 'ba')).toBe('both_unacceptable');
    expect(() => canonicaliseOutcome('a', 'xy' as never)).toThrow(PairwiseError);
  });
});

describe('rater units', () => {
  const ab = (outcome: PairwiseBallot['outcome'], confidence = 0.9): PairwiseBallot => ({
    judge: 'j1',
    presentation: 'ab',
    outcome,
    confidence,
  });
  const ba = (outcome: PairwiseBallot['outcome'], confidence = 0.9): PairwiseBallot => ({
    judge: 'j1',
    presentation: 'ba',
    outcome,
    confidence,
  });

  it('folds a consistent judge into one outcome', () => {
    // Shown B first, the judge picked the second answer — that is candidate A.
    const unit = foldRaterUnit([ab('a'), ba('b')]);
    expect(unit.outcome).toBe('a');
    expect(unit.orderUnstable).toBe(false);
  });

  it('yields no outcome when the judge flips with order', () => {
    const unit = foldRaterUnit([ab('a'), ba('a')]);
    expect(unit.orderUnstable).toBe(true);
    expect(unit.outcome).toBeNull();
  });

  it('counts a decisive/undecided flip as instability too', () => {
    expect(foldRaterUnit([ab('a'), ba('equal')]).orderUnstable).toBe(true);
  });

  it('refuses two ballots from different judges, or the same presentation twice', () => {
    expect(() =>
      foldRaterUnit([ab('a'), { ...ba('b'), judge: 'j2' }]),
    ).toThrow(PairwiseError);
    expect(() => foldRaterUnit([ab('a'), ab('a')])).toThrow(/twice/);
  });
});

describe('pairwise aggregation', () => {
  const unit = (judge: string, outcome: RaterUnit['outcome'], extra: Partial<RaterUnit> = {}): RaterUnit => ({
    judge,
    outcome,
    orderUnstable: false,
    safetyFlag: false,
    presentations: outcome === null ? [] : [outcome],
    confidence: 0.9,
    ...extra,
  });

  it('keeps both_unacceptable and abstain out of the preference denominator', () => {
    const tally = tallyPairwise([
      unit('j1', 'a'),
      unit('j2', 'both_unacceptable'),
      unit('j3', 'abstain'),
    ]);
    expect(tally).toMatchObject({ a: 1, b: 0, equal: 0, bothUnacceptable: 1, abstain: 1 });
    expect(tally.preferenceDenominator).toBe(1);
    expect(tally.units).toBe(3);
    // Shares are over the one unit that expressed a preference.
    expect(preferenceShare(tally)).toEqual({ a: 1, b: 0 });
  });

  it('never reports both_unacceptable as a tie', () => {
    const verdict = pairwiseVerdict([
      unit('j1', 'both_unacceptable'),
      unit('j2', 'both_unacceptable'),
    ]);
    expect(verdict.winner).toBe('no-contest');
    expect(verdict.winner).not.toBe('tie');
    expect(verdict.tally.equal).toBe(0);
    expect(verdict.share).toBeNull();
    expect(verdict.escalate).toBe(true);
  });

  it('refuses to invent 50/50 when nobody expressed a preference', () => {
    const tally = tallyPairwise([unit('j1', 'abstain'), unit('j2', 'abstain')]);
    expect(tally.preferenceDenominator).toBe(0);
    expect(() => preferenceShare(tally)).toThrow(PairwiseError);
  });

  it('reports insufficient rather than a winner when abstention leaves too few units', () => {
    const verdict = pairwiseVerdict([unit('j1', 'a'), unit('j2', 'abstain')]);
    expect(verdict.winner).toBe('insufficient');
    expect(verdict.escalate).toBe(true);
  });

  it('escalates a minority both_unacceptable while still naming a winner', () => {
    const verdict = pairwiseVerdict([
      unit('j1', 'a'),
      unit('j2', 'a'),
      unit('j3', 'both_unacceptable'),
    ]);
    expect(verdict.winner).toBe('a');
    expect(verdict.escalate).toBe(true);
    expect(verdict.tally.preferenceDenominator).toBe(2);
  });

  it('counts an order-unstable unit but lets it decide nothing', () => {
    const tally = tallyPairwise([
      unit('j1', 'a'),
      unit('j2', null, { orderUnstable: true, presentations: ['a', 'b'] }),
    ]);
    expect(tally.unstable).toBe(1);
    expect(tally.preferenceDenominator).toBe(1);
  });

  it('splits ties down the middle only for genuine equals', () => {
    const tally = tallyPairwise([unit('j1', 'equal'), unit('j2', 'equal')]);
    expect(preferenceShare(tally)).toEqual({ a: 0.5, b: 0.5 });
    expect(pairwiseVerdict([unit('j1', 'equal'), unit('j2', 'equal')]).winner).toBe('tie');
  });
});

/* -------------------------------------------------------------------------- */
/* M2.1 cascade router                                                        */
/* -------------------------------------------------------------------------- */

describe('routeCascade', () => {
  const criteria = [atomic('c1', 3), atomic('c2', 1)];

  it('records the route, confidence, disagreement and human-reversibility on every result', () => {
    const result = routeCascade({
      questionId: 'conv-007',
      safetyCritical: false,
      deterministic: { score: 100, resolves: true, source: 'numeric', confidence: 1 },
    });
    expect(result.route).toBe('deterministic');
    expect(result.score).toBe(100);
    expect(result.confidence).toBe(1);
    expect(result.judgeDisagreement).toBeNull();
    expect(result.humanCouldChange).toBe(false);
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(['route', 'confidence', 'judgeDisagreement', 'humanCouldChange']),
    );
  });

  it('refuses an item that does not declare whether it is safety-critical', () => {
    expect(() =>
      routeCascade({ questionId: 'x', safetyCritical: undefined as never }),
    ).toThrow(/safetyCritical/);
  });

  it('escalates a safety-critical item whose only evidence is a confident judge panel', () => {
    const panel = combineDimensionPanel(criteria, [
      seat('opus', bands(['c1', 4], ['c2', 4]), 0.95),
      seat('gpt', bands(['c1', 4], ['c2', 4]), 0.95),
    ]);
    const result = routeDimensionMode({
      questionId: 'safe-014',
      safetyCritical: true,
      panel,
    });
    // The panel was unanimous, confident and clean. It is still not enough.
    expect(panel.score).toBe(100);
    expect(result.route).toBe('human-escalation');
    expect(result.escalations).toContain('safety-critical-requires-confirmation');
    expect(result.score).toBeNull();
    expect(result.provisionalScore).toBe(100);
    expect(result.humanCouldChange).toBe(true);
  });

  it('accepts a safety-critical item once a deterministic rule confirms it', () => {
    const panel = combineDimensionPanel(criteria, [
      seat('opus', bands(['c1', 4], ['c2', 4]), 0.95),
      seat('gpt', bands(['c1', 4], ['c2', 4]), 0.95),
    ]);
    const result = routeDimensionMode({
      questionId: 'safe-014',
      safetyCritical: true,
      panel,
      deterministic: { score: 100, resolves: false, source: 'temperature-check', confidence: 1 },
    });
    expect(result.escalations).not.toContain('safety-critical-requires-confirmation');
    expect(result.route).toBe('structured-judgement');
    expect(result.score).toBe(100);
  });

  it('escalates when a safety cap rests on the judge alone', () => {
    const panel = combineDimensionPanel(criteria, [seat('opus', bands(['c1', 4], ['c2', 4]), 0.9)]);
    const result = routeDimensionMode({
      questionId: 'safe-020',
      safetyCritical: false,
      panel,
      caps: [{ kind: 'critical-safety', reason: 'unsafe hold', evidence: 'llm-judge' }],
    });
    expect(result.escalations).toContain('safety-critical-requires-confirmation');
    expect(result.provisionalScore).toBe(0);
  });

  it('applies caps after the weighted score, not before', () => {
    const panel = combineDimensionPanel(criteria, [
      seat('opus', bands(['c1', 4], ['c2', 4]), 0.9),
      seat('gpt', bands(['c1', 4], ['c2', 4]), 0.9),
    ]);
    const result = routeDimensionMode({
      questionId: 'rgen-013',
      safetyCritical: false,
      panel,
      caps: [
        { kind: 'hard-constraint', reason: 'brief said no oven', evidence: 'deterministic' },
      ],
    });
    expect(result.caps!.applied[0]!.binding).toBe(true);
    expect(result.score).toBe(40);
  });

  it('enforces a dimension ceiling seat by seat before averaging', () => {
    const contextual = [atomic('hist', 2, { dimension: 'context' }), atomic('tech', 2)];
    const panel = combineDimensionPanel(contextual, [
      seat('opus', bands(['hist', 4], ['tech', 4]), 0.9),
      seat('gpt', bands(['hist', 4], ['tech', 4]), 0.9),
    ]);
    const result = routeCascade({
      questionId: 'hist-004',
      safetyCritical: false,
      judgement: { mode: 'dimension', panel },
      caps: [
        {
          kind: 'unsupported-historical-claim',
          reason: 'no source for the 1889 pizza story',
          evidence: 'human',
          dimensionCeiling: 40,
        },
      ],
    });
    // (40·2 + 100·2)/4 = 70 for each seat, so 70 overall.
    expect(result.provisionalScore).toBeCloseTo(70, 10);
  });

  it('escalates a judge split wider than the declared tolerance', () => {
    const panel = combineDimensionPanel(criteria, [
      seat('opus', bands(['c1', 4], ['c2', 4]), 0.9),
      seat('gpt', bands(['c1', 1], ['c2', 1]), 0.9),
    ]);
    const result = routeDimensionMode({ questionId: 'tech-011', safetyCritical: false, panel });
    expect(result.judgeDisagreement).toEqual({ kind: 'score-gap', value: 75 });
    expect(result.escalations).toContain('judge-split-over-tolerance');
    expect(result.route).toBe('human-escalation');
    expect(result.score).toBeNull();
  });

  it('escalates a seat that declared no confidence rather than assuming certainty', () => {
    const panel = combineDimensionPanel(criteria, [
      seat('opus', bands(['c1', 4], ['c2', 4]), 0.9),
      seat('gpt', bands(['c1', 4], ['c2', 4])),
    ]);
    const result = routeDimensionMode({ questionId: 'tech-012', safetyCritical: false, panel });
    expect(result.escalations).toContain('missing-confidence');
    expect(result.score).toBeNull();
  });

  it('escalates low confidence outside validated automation coverage, and not inside it', () => {
    const panel = combineDimensionPanel(criteria, [
      seat('opus', bands(['c1', 4], ['c2', 4]), 0.4),
      seat('gpt', bands(['c1', 4], ['c2', 4]), 0.5),
    ]);
    expect(
      routeDimensionMode({ questionId: 'q', safetyCritical: false, panel }).escalations,
    ).toContain('low-confidence');
    expect(
      routeDimensionMode({
        questionId: 'q',
        safetyCritical: false,
        panel,
        policy: { automationCoverageValidated: true },
      }).escalations,
    ).not.toContain('low-confidence');
  });

  it('escalates a critical-criterion breach nobody turned into a cap', () => {
    const withCritical = [
      atomic('c1', 3),
      atomic('crit', 1, { kind: 'critical', statement: 'names the allergen' }),
    ];
    const panel = combineDimensionPanel(withCritical, [
      seat('opus', bands(['c1', 4], ['crit', 1]), 0.9),
    ]);
    const unhandled = routeDimensionMode({ questionId: 'subs-020', safetyCritical: false, panel });
    expect(unhandled.escalations).toContain('unhandled-critical-criterion');
    const handled = routeDimensionMode({
      questionId: 'subs-020',
      safetyCritical: false,
      panel,
      criticalBreachesHandled: true,
      caps: [{ kind: 'critical-allergen', reason: 'missed the allergen', evidence: 'human' }],
    });
    expect(handled.escalations).not.toContain('unhandled-critical-criterion');
    expect(handled.score).toBe(0);
  });

  it('escalates a safety disagreement between seats even when the mean looks calm', () => {
    const withCritical = [
      atomic('c1', 3),
      atomic('crit', 1, { kind: 'critical', statement: 'names the allergen' }),
    ];
    const panel = combineDimensionPanel(withCritical, [
      seat('opus', bands(['c1', 4], ['crit', 4]), 0.9),
      seat('gpt', bands(['c1', 4], ['crit', 3]), 0.9),
    ]);
    expect(panel.disagreement).toBeCloseTo(6.25, 10);
    const result = routeDimensionMode({ questionId: 'subs-021', safetyCritical: false, panel });
    expect(result.escalations).toContain('safety-disagreement');
  });

  it('escalates with no score when there is no automated evidence at all', () => {
    const result = routeCascade({ questionId: 'nothing', safetyCritical: false });
    expect(result.route).toBe('human-escalation');
    expect(result.escalations).toContain('no-automated-evidence');
    expect(result.score).toBeNull();
    expect(result.confidence).toBeNull();
  });

  it('never carries a score on a pairwise item', () => {
    const units: RaterUnit[] = [
      { judge: 'j1', outcome: 'a', orderUnstable: false, safetyFlag: false, presentations: ['a'], confidence: 0.9 },
      { judge: 'j2', outcome: 'a', orderUnstable: false, safetyFlag: false, presentations: ['a'], confidence: 0.9 },
    ];
    const result = routeCascade({
      questionId: 'flav-030',
      safetyCritical: false,
      judgement: { mode: 'pairwise', verdict: pairwiseVerdict(units), units },
    });
    expect(result.score).toBeNull();
    expect(result.provisionalScore).toBeNull();
    expect(result.verdict!.winner).toBe('a');
    expect(result.judgeDisagreement).toEqual({ kind: 'outcome-split', value: 0 });
    expect(result.route).toBe('structured-judgement');
  });

  it('escalates an order-unstable pairwise unit', () => {
    const units: RaterUnit[] = [
      { judge: 'j1', outcome: null, orderUnstable: true, safetyFlag: false, presentations: ['a', 'b'], confidence: 0.9 },
      { judge: 'j2', outcome: 'a', orderUnstable: false, safetyFlag: false, presentations: ['a'], confidence: 0.9 },
      { judge: 'j3', outcome: 'a', orderUnstable: false, safetyFlag: false, presentations: ['a'], confidence: 0.9 },
    ];
    const result = routeCascade({
      questionId: 'flav-031',
      safetyCritical: false,
      judgement: { mode: 'pairwise', verdict: pairwiseVerdict(units), units },
    });
    expect(result.escalations).toContain('order-unstable');
    expect(result.route).toBe('human-escalation');
  });

  it('refuses a resolving deterministic check served alongside a judge panel', () => {
    const panel = combineDimensionPanel(criteria, [seat('opus', bands(['c1', 4], ['c2', 4]), 0.9)]);
    expect(() =>
      routeDimensionMode({
        questionId: 'conv-007',
        safetyCritical: false,
        panel,
        deterministic: { score: 40, resolves: true, source: 'numeric', confidence: 1 },
      }),
    ).toThrow(/resolving deterministic check and structured judgement/);
  });

  it('escalates a non-resolving check with nothing to blend it into', () => {
    const result = routeCascade({
      questionId: 'rgen-002',
      safetyCritical: false,
      deterministic: { score: 100, resolves: false, source: 'constraintChecks', confidence: 1 },
    });
    expect(result.route).toBe('human-escalation');
    expect(result.escalations).toContain('incomplete-evidence');
    expect(result.score).toBeNull();
    // The constraint component is preserved so a reviewer can see it, but it is
    // not published as the item's score.
    expect(result.provisionalScore).toBe(100);
  });

  it('blends a non-resolving check into the panel at the declared judge weight', () => {
    const panel = combineDimensionPanel(criteria, [
      seat('opus', bands(['c1', 4], ['c2', 4]), 0.9),
      seat('gpt', bands(['c1', 4], ['c2', 4]), 0.9),
    ]);
    const result = routeDimensionMode({
      questionId: 'rgen-003',
      safetyCritical: false,
      panel,
      deterministic: { score: 0, resolves: false, source: 'constraintChecks', confidence: 1 },
    });
    // 0.7·100 + 0.3·0 = 70.
    expect(result.score).toBeCloseTo(70, 10);
  });

  it('honours the mandatory-review policy flags', () => {
    const base = {
      questionId: 'conv-007',
      safetyCritical: false,
      deterministic: { score: 100, resolves: true, source: 'numeric', confidence: 1 },
    } as const;
    expect(routeCascade({ ...base, policy: { challengedReference: true } }).route).toBe(
      'human-escalation',
    );
    expect(routeCascade({ ...base, policy: { sampledAudit: true } }).escalations).toContain(
      'sampled-audit',
    );
  });
});
