import { describe, expect, it } from 'vitest';
import type { Question } from '@cookingbench/core';
import {
  aggregateDimension,
  aggregatePairwise,
  applySeverityCorrection,
  assertPoolAdmissible,
  blindingLexicon,
  buildJuryDesign,
  conflictFreeSeats,
  identityIndex,
  judgeDimensionAnswer,
  judgeFamilyGroups,
  judgePairwiseComparison,
  juryFor,
  leaveOneFamilyOutPairwise,
  resolveRaterUnit,
  unitOutcomeKey,
  voteEntropy,
  type Comparison,
  type DimensionBallot,
  type JuryPool,
  type JurySeatContext,
  type PairwiseBallot,
  type PresentationOrder,
  type RaterUnit,
} from '../src/judge.js';
import type { ChatMessage, CompletionClient } from '../src/openrouter.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const POOL_MODELS = [
  { id: 'anthropic/opus', provider: 'Anthropic', family: 'claude' },
  { id: 'openai/gpt', provider: 'OpenAI', family: 'gpt' },
  { id: 'x-ai/grok', provider: 'xAI', family: 'grok' },
  { id: 'google/gemini', provider: 'Google', family: 'gemini' },
  { id: 'alibaba/qwen', provider: 'Alibaba', family: 'qwen' },
  { id: 'deepseek/ds', provider: 'DeepSeek', family: 'deepseek' },
];

const CANDIDATE_MODELS = [
  { id: 'anthropic/sonnet', displayName: 'Claude Sonnet 9', provider: 'Anthropic', family: 'claude-mid' },
  { id: 'openai/gpt-mini', displayName: 'GPT-9 Mini', provider: 'OpenAI', family: 'gpt-mini' },
  { id: 'meta/llama', displayName: 'Llama 4 Maverick', provider: 'Meta', family: 'llama' },
  { id: 'mistral/large', displayName: 'Mistral Large 3', provider: 'Mistral', family: 'mistral' },
  { id: 'moonshot/kimi', displayName: 'Kimi K3', provider: 'Moonshot AI', family: 'kimi' },
];

const identify = identityIndex([...POOL_MODELS, ...CANDIDATE_MODELS]);
const LEXICON = blindingLexicon([...POOL_MODELS, ...CANDIDATE_MODELS]);
const POOL: JuryPool = { version: 'pool-2026-07', seats: POOL_MODELS.map((m) => m.id) };

const dimensionQuestion: Question = {
  id: 'tech-201',
  category: 'technique',
  difficulty: 4,
  status: 'active',
  addedIn: 'v3',
  trap: false,
  prompt: 'A four-hour beef shin braise tastes flat at the end. Diagnose it and fix it.',
  grader: {
    type: 'llm-judge',
    judgeMode: 'dimension',
    rubric: [
      { id: 'c-acid', kind: 'include', statement: 'Checks salt and acid first', weight: 2 },
      { id: 'c-raw-flour', kind: 'critical', statement: 'No raw flour in a finished braise', weight: 5 },
    ],
  },
  referenceAnswer: 'Season, add acid, reduce, finish with butter.',
  anchors: [
    {
      dimension: 'diagnostic ranking',
      bands: [
        { band: 0, descriptor: 'Names no cause and adds more stock immediately' },
        { band: 1, descriptor: 'Names one cause and does not test it before acting' },
        { band: 2, descriptor: 'Names two causes and tests them in an arbitrary order' },
        { band: 3, descriptor: 'Tests salt first, then acid, then reduction, and says why' },
        { band: 4, descriptor: 'Ranks four causes by likelihood and states what each test rules out' },
      ],
    },
  ],
  public: true,
};

function ballot(
  order: PresentationOrder,
  outcome: PairwiseBallot['outcome'],
  overrides: Partial<PairwiseBallot> = {},
): PairwiseBallot {
  return {
    order,
    outcome,
    criteria: [{ criterionId: 'c-acid', favours: 'equal', evidence: 'both salt first' }],
    criticalTags: [],
    confidence: 0.9,
    reasoning: 'because',
    ...overrides,
  };
}

function unit(
  judgeModel: string,
  judgeFamily: string,
  first: PairwiseBallot,
  second: PairwiseBallot,
): RaterUnit {
  return resolveRaterUnit({
    judgeModel,
    judgeFamily,
    candidateA: 'meta/llama',
    candidateB: 'mistral/large',
    ballots: [first, second],
  });
}

function dimensionBallot(band: number, flour: 'met' | 'missed', confidence = 0.9): DimensionBallot {
  return {
    dimensions: [{ dimension: 'diagnostic ranking', band, evidence: 'tests salt first' }],
    criteria: [
      { criterionId: 'c-acid', decision: 'met', evidence: 'salt then vinegar' },
      { criterionId: 'c-raw-flour', decision: flour, evidence: 'flour check' },
    ],
    confidence,
    summary: 'ok',
  };
}

interface RecordedCall {
  modelId: string;
  messages: ChatMessage[];
}

function fakeClient(reply: (call: RecordedCall) => string): CompletionClient & {
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  return {
    calls,
    async complete(modelId, messages) {
      const call = { modelId, messages };
      calls.push(call);
      return {
        text: reply(call),
        raw: {},
        tokensIn: 100,
        tokensOut: 100,
        costUsd: 0.01,
        latencyMs: 1,
      };
    },
  };
}

const SEATING: JurySeatContext = {
  seats: ['x-ai/grok', 'google/gemini', 'alibaba/qwen'],
  families: ['grok', 'gemini', 'qwen'],
};

/* -------------------------------------------------------------------------- */
/* M2.5 — the pool                                                            */
/* -------------------------------------------------------------------------- */

describe('the judge pool has to be wide enough before anything is seated', () => {
  it('accepts a pool spanning five or more distinct provider/base-model families', () => {
    const groups = assertPoolAdmissible(POOL, identify);
    expect(new Set(groups.values()).size).toBe(6);
  });

  it('refuses a pool of four families rather than seating what it has', () => {
    const narrow: JuryPool = { version: 'narrow', seats: POOL.seats.slice(0, 4) };
    expect(() => assertPoolAdmissible(narrow, identify)).toThrow(/at least 5/);
  });

  it('counts two members of one lab as ONE family, not two seats', () => {
    // Six seats, five families: a pool that looks big enough by seat count and
    // is not. Counting seats instead of families is how a jury ends up with one
    // lab holding two of three votes.
    const models = [
      ...POOL_MODELS.slice(0, 5),
      { id: 'anthropic/haiku', provider: 'Anthropic', family: 'claude-small' },
    ];
    const lookup = identityIndex(models);
    const groups = judgeFamilyGroups(models.map((m) => m.id), lookup);
    expect(groups.get('anthropic/haiku')).toBe(groups.get('anthropic/opus'));
    expect(new Set(groups.values()).size).toBe(5);
  });

  it('groups a rebadge chain transitively', () => {
    // A shares a provider with B, B shares a base model with C. None of the
    // three may sit together, and a pairwise-only grouping would miss A vs C.
    const models = [
      { id: 'lab/one', provider: 'Lab', family: 'alpha' },
      { id: 'lab/two', provider: 'Lab', family: 'beta' },
      { id: 'reseller/three', provider: 'Reseller', family: 'beta' },
    ];
    const groups = judgeFamilyGroups(
      models.map((m) => m.id),
      identityIndex(models),
    );
    expect(new Set(groups.values()).size).toBe(1);
  });

  it('refuses to group a seat with no declared identity', () => {
    // hasJudgeConflict treats unknown identity as conflicting with everything,
    // so an unidentified seat would silently collapse the pool into one family
    // and read as "not enough families" for the wrong reason.
    const models = [...POOL_MODELS, { id: 'mystery/model', provider: 'Nobody' }];
    expect(() =>
      judgeFamilyGroups(models.map((m) => m.id), identityIndex(models)),
    ).toThrow(/no declared identity for mystery\/model/);
  });

  it('refuses a pool that lists the same seat twice', () => {
    const doubled: JuryPool = { version: 'doubled', seats: [...POOL.seats, 'openai/gpt'] };
    expect(() => assertPoolAdmissible(doubled, identify)).toThrow(/more than once/);
  });

  it('excludes every seat conflicting with EITHER candidate of a duel', () => {
    const free = conflictFreeSeats(POOL.seats, ['anthropic/sonnet', 'openai/gpt-mini'], identify);
    expect(free).not.toContain('anthropic/opus');
    expect(free).not.toContain('openai/gpt');
    expect(free).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.5 — the balanced incomplete-block design                                */
/* -------------------------------------------------------------------------- */

describe('jury assignment refuses to shrink the panel', () => {
  it('seats exactly three conflict-free families', () => {
    const design = buildJuryDesign({
      pool: POOL,
      comparisons: [{ key: 'tech-201', candidates: ['meta/llama'] }],
      identify,
    });
    const selection = juryFor(design, 'tech-201');
    expect(selection.ok).toBe(true);
    if (!selection.ok) return;
    expect(selection.seats).toHaveLength(3);
    expect(new Set(selection.families).size).toBe(3);
  });

  it('routes to a human rather than dropping to two seats', () => {
    // `b/two` is a rebadge: served by OpenAI over xAI's base model. It knocks
    // out two pool families by itself, and with `a/one`'s provider that leaves
    // two. M2.5 says expand the pool or route to humans; it does not say "use
    // what is left".
    const narrow: JuryPool = { version: 'narrow', seats: POOL.seats.slice(0, 5) };
    const pairIdentify = identityIndex([
      ...POOL_MODELS,
      { id: 'a/one', provider: 'Anthropic', family: 'claude-mid' },
      { id: 'b/two', provider: 'OpenAI', family: 'grok' },
      { id: 'c/three', provider: 'Mistral', family: 'mistral' },
    ]);
    const design = buildJuryDesign({
      pool: narrow,
      comparisons: [
        { key: 'duel-1', candidates: ['a/one', 'b/two'] },
        { key: 'duel-2', candidates: ['a/one', 'c/three'] },
      ],
      identify: pairIdentify,
    });
    const selection = juryFor(design, 'duel-1');
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.routeTo).toBe('human');
    expect(selection.reason).toMatch(/may not be reduced/);
    expect(selection.diagnostics.join('\n')).toMatch(/same provider \(Anthropic\)/);
    expect(selection.diagnostics.join('\n')).toMatch(/same base-model family \(grok\)/);
    // Refusal is per comparison, not a blanket stop: duel-2 still has three.
    expect(design.balance.routedToHuman).toEqual(['duel-1']);
    expect(juryFor(design, 'duel-2').ok).toBe(true);
  });

  it('refuses to improvise a jury for a comparison outside the design', () => {
    const design = buildJuryDesign({
      pool: POOL,
      comparisons: [{ key: 'tech-201', candidates: ['meta/llama'] }],
      identify,
    });
    const selection = juryFor(design, 'tech-999');
    expect(selection.ok).toBe(false);
    if (selection.ok) return;
    expect(selection.reason).toMatch(/not in jury design/);
  });

  it('refuses a comparison list with a duplicate key', () => {
    expect(() =>
      buildJuryDesign({
        pool: POOL,
        comparisons: [
          { key: 'tech-201', candidates: ['meta/llama'] },
          { key: 'tech-201', candidates: ['mistral/large'] },
        ],
        identify,
      }),
    ).toThrow(/more than once/);
  });

  it('never seats a judge that conflicts with the candidate it judges', () => {
    const comparisons: Comparison[] = CANDIDATE_MODELS.flatMap((m, i) =>
      Array.from({ length: 12 }, (_, n) => ({ key: `q-${i}-${n}`, candidates: [m.id] })),
    );
    const design = buildJuryDesign({ pool: POOL, comparisons, identify });
    for (const assignment of design.assignments.values()) {
      expect(assignment.selection.ok).toBe(true);
      if (!assignment.selection.ok) continue;
      const legal = conflictFreeSeats(POOL.seats, assignment.candidates, identify);
      for (const seat of assignment.selection.seats) expect(legal).toContain(seat);
    }
  });
});

describe('the design is balanced, and balanced is not "random enough"', () => {
  const comparisons: Comparison[] = Array.from({ length: 60 }, (_, i) => ({
    key: `tech-${String(i).padStart(3, '0')}`,
    candidates: ['meta/llama'],
  }));
  const design = buildJuryDesign({ pool: POOL, comparisons, identify });

  it('gives every eligible judge family the same seat count, within one', () => {
    expect(design.balance.balanced).toBe(true);
    const block = design.balance.blocks[0]!;
    expect(block.eligibleFamilies).toHaveLength(6);
    const counts = Object.values(block.seatCounts);
    // 60 comparisons × 3 seats over 6 families: exactly 30 each.
    expect(counts.every((c) => c === 30)).toBe(true);
    expect(block.spread).toBe(0);
  });

  it('gives every candidate family an equivalent distribution of judge families', () => {
    // The leniency guarantee, stated as a measurement: if one judge family is
    // systematically softer, it must not sit for one candidate more than for
    // another, or the softness turns into a ranking.
    const mixed: Comparison[] = CANDIDATE_MODELS.flatMap((m, i) =>
      Array.from({ length: 24 }, (_, n) => ({ key: `mix-${i}-${n}`, candidates: [m.id] })),
    );
    const mixedDesign = buildJuryDesign({ pool: POOL, comparisons: mixed, identify });
    expect(mixedDesign.balance.balanced).toBe(true);
    for (const block of mixedDesign.balance.blocks) {
      const counts = Object.values(block.seatCounts);
      expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
      // And every eligible family really did sit — a "balanced" block that
      // seated three families 24 times and three never would also have spread 0
      // if the unused ones were dropped from the record.
      expect(counts.filter((c) => c === 0)).toHaveLength(0);
    }
  });

  it('is reproducible, and independent of the order the comparisons arrive in', () => {
    const again = buildJuryDesign({ pool: POOL, comparisons, identify });
    const reversed = buildJuryDesign({
      pool: POOL,
      comparisons: [...comparisons].reverse(),
      identify,
    });
    for (const key of comparisons.map((c) => c.key)) {
      const a = juryFor(design, key);
      const b = juryFor(again, key);
      const c = juryFor(reversed, key);
      expect(a).toEqual(b);
      expect(a).toEqual(c);
    }
  });

  it('does not hand the same triple to every item, or to every category', () => {
    // Item ids are category-prefixed, so assigning in key order would give one
    // category one panel and another category a different one — a panel
    // correlated with content, which is the systematic-leniency failure.
    const byCategory: Comparison[] = ['nutr', 'safe'].flatMap((prefix) =>
      Array.from({ length: 30 }, (_, n) => ({
        key: `${prefix}-${String(n).padStart(3, '0')}`,
        candidates: ['meta/llama'],
      })),
    );
    const catDesign = buildJuryDesign({ pool: POOL, comparisons: byCategory, identify });
    const triples = new Set<string>();
    const perCategory = new Map<string, Map<string, number>>();
    for (const [key, assignment] of catDesign.assignments) {
      if (!assignment.selection.ok) continue;
      triples.add([...assignment.selection.families].sort().join('+'));
      const prefix = key.slice(0, 4);
      const counts = perCategory.get(prefix) ?? new Map<string, number>();
      for (const family of assignment.selection.families) {
        counts.set(family, (counts.get(family) ?? 0) + 1);
      }
      perCategory.set(prefix, counts);
    }
    expect(triples.size).toBeGreaterThan(4);
    for (const counts of perCategory.values()) {
      // 30 items × 3 seats over 6 families = 15 expected each. Hash ordering
      // does not promise exact balance WITHIN a subset of a block, only across
      // it, so this is a correlation check, not a balance check.
      expect(Math.min(...counts.values())).toBeGreaterThan(8);
      expect(Math.max(...counts.values())).toBeLessThan(22);
    }
  });

  it('a different seed produces a different, still-legal design', () => {
    const other = buildJuryDesign({ pool: POOL, comparisons, identify, seed: 'other-seed' });
    const changed = comparisons.filter(
      (c) => JSON.stringify(juryFor(design, c.key)) !== JSON.stringify(juryFor(other, c.key)),
    );
    expect(changed.length).toBeGreaterThan(0);
    expect(other.balance.balanced).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.5 — order design                                                        */
/* -------------------------------------------------------------------------- */

describe('two presentations are one rater unit', () => {
  it('records a stable preference once, not twice', () => {
    // AB says "A" and BA says "B": both name llama. One unit, one vote.
    const u = unit('x-ai/grok', 'grok', ballot('AB', 'A'), ballot('BA', 'B'));
    expect(u.outcome).toEqual({ kind: 'candidate', modelId: 'meta/llama' });
    expect(u.orderFlip).toBe(false);
    const aggregate = aggregatePairwise([u]);
    expect(aggregate.primary.decidedUnits).toBe(1);
    expect(aggregate.primary.votes['candidate:meta/llama']).toBe(1);
  });

  it('canonicalises position to candidate identity, so B-A is not a mirror bug', () => {
    // "A" in a B–A presentation is the SECOND candidate. Getting this wrong
    // credits the wrong model and looks like agreement.
    const u = unit('x-ai/grok', 'grok', ballot('AB', 'A'), ballot('BA', 'A'));
    expect(u.orderFlip).toBe(true);
    expect(u.outcome.kind).toBe('unstable');
  });

  it('treats an order flip as instability, contributing no vote at all', () => {
    const flipped = unit('x-ai/grok', 'grok', ballot('AB', 'A'), ballot('BA', 'A'));
    const clean = [
      unit('google/gemini', 'gemini', ballot('AB', 'A'), ballot('BA', 'B')),
      unit('alibaba/qwen', 'qwen', ballot('AB', 'A'), ballot('BA', 'B')),
    ];
    const aggregate = aggregatePairwise([flipped, ...clean]);
    expect(aggregate.primary.decidedUnits).toBe(2);
    expect(aggregate.unstable).toBe(1);
    expect(aggregate.escalate).toBe(true);
    expect(aggregate.escalations.map((e) => e.reason)).toContain('order-flip');
  });

  it('refuses two presentations in the same order', () => {
    // Running A–B twice cannot detect a position effect, which is the only
    // reason both orders are run at all.
    expect(() =>
      unit('x-ai/grok', 'grok', ballot('AB', 'A'), ballot('AB', 'B')),
    ).toThrow(/one AB and one BA/);
  });

  it('refuses a unit built from one presentation', () => {
    expect(() =>
      resolveRaterUnit({
        judgeModel: 'x-ai/grok',
        judgeFamily: 'grok',
        candidateA: 'meta/llama',
        candidateB: 'mistral/large',
        ballots: [ballot('AB', 'A')],
      }),
    ).toThrow(/exactly two presentations/);
  });

  it('records a winner-versus-tie disagreement as no reliable preference', () => {
    const u = unit('x-ai/grok', 'grok', ballot('AB', 'A'), ballot('BA', 'equal'));
    expect(u.outcome).toEqual({ kind: 'equal' });
    expect(u.instability).toBe('presentation-inconsistent');
  });

  it('never averages an unstable "both unacceptable" away against a preference', () => {
    const u = unit('x-ai/grok', 'grok', ballot('AB', 'A'), {
      ...ballot('BA', 'both_unacceptable'),
      criticalTags: [{ answer: 'both', issue: 'raw flour in a finished braise' }],
    });
    expect(u.outcome.kind).toBe('unstable');
    expect(u.criticalTags).toEqual(['meta/llama', 'mistral/large']);
  });

  it('keeps a stable "both unacceptable" as its own outcome, never as a tie', () => {
    const tagged = { criticalTags: [{ answer: 'both' as const, issue: 'unsafe holding time' }] };
    const u = unit(
      'x-ai/grok',
      'grok',
      { ...ballot('AB', 'both_unacceptable'), ...tagged },
      { ...ballot('BA', 'both_unacceptable'), ...tagged },
    );
    expect(unitOutcomeKey(u.outcome)).toBe('both_unacceptable');
    expect(unitOutcomeKey(u.outcome)).not.toBe('equal');
  });

  it('treats an abstention in either order as missing, not as half a vote', () => {
    const u = unit('x-ai/grok', 'grok', ballot('AB', 'A'), ballot('BA', 'abstain'));
    expect(u.outcome.kind).toBe('abstain');
    const aggregate = aggregatePairwise([u]);
    expect(aggregate.primary.decidedUnits).toBe(0);
    expect(aggregate.primary.outcome).toBe('no-majority');
    expect(aggregate.escalations.map((e) => e.reason)).toContain('abstention');
  });

  it('takes the LOWER of the two presentation confidences', () => {
    const u = unit(
      'x-ai/grok',
      'grok',
      ballot('AB', 'A', { confidence: 0.9 }),
      ballot('BA', 'B', { confidence: 0.4 }),
    );
    expect(u.confidence).toBe(0.4);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.5 — aggregation                                                         */
/* -------------------------------------------------------------------------- */

describe('the primary analysis is an unweighted majority and nothing else', () => {
  const forLlama = (judge: string, family: string) =>
    unit(judge, family, ballot('AB', 'A'), ballot('BA', 'B'));
  const forMistral = (judge: string, family: string) =>
    unit(judge, family, ballot('AB', 'B'), ballot('BA', 'A'));

  it('names the strict majority winner and retains everything else', () => {
    const units = [
      forLlama('x-ai/grok', 'grok'),
      forLlama('google/gemini', 'gemini'),
      forMistral('alibaba/qwen', 'qwen'),
    ];
    const aggregate = aggregatePairwise(units);
    expect(aggregate.primary.method).toBe('unweighted-majority');
    expect(aggregate.primary.outcome).toBe('candidate:meta/llama');
    // M2.1: every automated result records the route it came down and the
    // prompt version it is comparable within.
    expect(aggregate.route).toBe('pairwise');
    expect(aggregate.promptVersion).toBe('judge-v3-pairwise');
    expect(aggregate.primary.winnerSharePct).toBeCloseTo(66.7, 0);
    expect(aggregate.units).toHaveLength(3);
    // Per-criterion decisions and their evidence survive aggregation.
    expect(aggregate.units[0]!.presentations[0]!.criteria[0]!.evidence).toBe('both salt first');
    expect(aggregate.entropy).toBeGreaterThan(0);
  });

  it('reports no majority instead of a plurality', () => {
    const units = [
      forLlama('x-ai/grok', 'grok'),
      forMistral('google/gemini', 'gemini'),
      unit('alibaba/qwen', 'qwen', ballot('AB', 'equal'), ballot('BA', 'equal')),
    ];
    const aggregate = aggregatePairwise(units);
    expect(aggregate.primary.outcome).toBe('no-majority');
    expect(aggregate.escalations.map((e) => e.reason)).toContain('no-majority');
  });

  it('refuses to tally units from two different duels', () => {
    const other = resolveRaterUnit({
      judgeModel: 'google/gemini',
      judgeFamily: 'gemini',
      candidateA: 'meta/llama',
      candidateB: 'moonshot/kimi',
      ballots: [ballot('AB', 'A'), ballot('BA', 'B')],
    });
    expect(() => aggregatePairwise([forLlama('x-ai/grok', 'grok'), other])).toThrow(
      /disagree about which pair/,
    );
  });

  it('refuses one judge appearing as two rater units', () => {
    expect(() => aggregatePairwise([forLlama('x-ai/grok', 'grok'), forLlama('x-ai/grok', 'grok')]))
      .toThrow(/more than one rater unit/);
  });

  it('escalates a split critical tag', () => {
    const tagged = unit('x-ai/grok', 'grok', ballot('AB', 'A', {
      criticalTags: [{ answer: 'B', issue: 'holds chicken at 40 °C for three hours' }],
    }), ballot('BA', 'B', {
      criticalTags: [{ answer: 'A', issue: 'holds chicken at 40 °C for three hours' }],
    }));
    const aggregate = aggregatePairwise([
      tagged,
      forLlama('google/gemini', 'gemini'),
      forLlama('alibaba/qwen', 'qwen'),
    ]);
    expect(aggregate.escalations.map((e) => e.reason)).toContain('split-critical-tag');
  });

  it('escalates a criterion decided in opposite directions', () => {
    const disagreeing = unit(
      'x-ai/grok',
      'grok',
      ballot('AB', 'A', {
        criteria: [{ criterionId: 'c-acid', favours: 'A', evidence: 'A salts first' }],
      }),
      ballot('BA', 'B', {
        criteria: [{ criterionId: 'c-acid', favours: 'A', evidence: 'now the other one' }],
      }),
    );
    const aggregate = aggregatePairwise([disagreeing]);
    expect(aggregate.escalations.map((e) => e.reason)).toContain('criterion-gap');
  });

  it('escalates a low-confidence panel even when it agrees', () => {
    const shaky = [
      unit('x-ai/grok', 'grok', ballot('AB', 'A', { confidence: 0.3 }), ballot('BA', 'B', { confidence: 0.3 })),
      forLlama('google/gemini', 'gemini'),
      forLlama('alibaba/qwen', 'qwen'),
    ];
    const aggregate = aggregatePairwise(shaky);
    expect(aggregate.primary.outcome).toBe('candidate:meta/llama');
    expect(aggregate.escalations.map((e) => e.reason)).toContain('low-confidence');
  });

  it('refuses to aggregate nothing', () => {
    expect(() => aggregatePairwise([])).toThrow(/no rater units/);
  });
});

describe('leave-one-judge-family-out', () => {
  it('distinguishes losing the majority from reversing it', () => {
    const units = [
      unit('x-ai/grok', 'grok', ballot('AB', 'A'), ballot('BA', 'B')),
      unit('google/gemini', 'gemini', ballot('AB', 'A'), ballot('BA', 'B')),
      unit('alibaba/qwen', 'qwen', ballot('AB', 'B'), ballot('BA', 'A')),
    ];
    const lofo = leaveOneFamilyOutPairwise(units);
    expect(lofo).toHaveLength(3);
    const dropGrok = lofo.find((l) => l.family === 'grok')!;
    // 2–1 becomes 1–1: the majority is gone. That is a power question, not a
    // validity one, and calling it a reversal would fire M2.8's winner-reversal
    // criterion on every close comparison in the bank.
    expect(dropGrok.outcome).toBe('no-majority');
    expect(dropGrok.reversal).toBe(false);
    expect(dropGrok.shareDeltaPct).toBeLessThan(0);
  });

  it('reports a genuine reversal when one family was carrying the verdict', () => {
    // Several items for one pair, pooled: the case M2.8's criterion is actually
    // about ("removing one judge family … produces no confirmed winner
    // reversal"). Within a single duel a three-family jury cannot reverse, only
    // deadlock — which is why this is tested on a pooled set.
    const units = [
      unit('x-ai/grok', 'grok', ballot('AB', 'A'), ballot('BA', 'B')),
      unit('x-ai/grok-2', 'grok', ballot('AB', 'A'), ballot('BA', 'B')),
      unit('x-ai/grok-3', 'grok', ballot('AB', 'A'), ballot('BA', 'B')),
      unit('google/gemini', 'gemini', ballot('AB', 'B'), ballot('BA', 'A')),
      unit('alibaba/qwen', 'qwen', ballot('AB', 'B'), ballot('BA', 'A')),
    ];
    const dropGrok = leaveOneFamilyOutPairwise(units).find((l) => l.family === 'grok')!;
    expect(dropGrok.outcome).toBe('candidate:mistral/large');
    expect(dropGrok.reversal).toBe(true);
    expect(dropGrok.winnerSharePct).toBe(100);
  });

  it('is published alongside every aggregate, not on request', () => {
    const aggregate = aggregatePairwise([
      unit('x-ai/grok', 'grok', ballot('AB', 'A'), ballot('BA', 'B')),
      unit('google/gemini', 'gemini', ballot('AB', 'A'), ballot('BA', 'B')),
      unit('alibaba/qwen', 'qwen', ballot('AB', 'B'), ballot('BA', 'A')),
    ]);
    expect(aggregate.leaveOneFamilyOut.map((l) => l.family).sort()).toEqual([
      'gemini',
      'grok',
      'qwen',
    ]);
  });
});

describe('vote entropy', () => {
  it('is zero for a unanimous panel and rises with disagreement', () => {
    expect(voteEntropy(['a', 'a', 'a'])).toBe(0);
    expect(voteEntropy(['a', 'b'])).toBe(1);
    expect(voteEntropy(['a', 'b', 'c', 'd'])).toBe(2);
  });

  it('refuses an empty ballot set instead of calling it unanimous', () => {
    // Zero is the arithmetic answer and the wrong one: "perfect agreement"
    // derived from no ballots is exactly the number that ends up on a board.
    expect(() => voteEntropy([])).toThrow(/undefined, not zero disagreement/);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.5 — severity correction is sensitivity only                             */
/* -------------------------------------------------------------------------- */

describe('severity correction cannot become the primary analysis', () => {
  const weights = { critical: 40, major: 15, minor: 5 };
  const findings = [{ severity: 'major' as const }, { severity: 'minor' as const }];

  it('computes a sensitivity score from development-learned weights', () => {
    const result = applySeverityCorrection(
      {
        learnedOn: 'development',
        appliedAs: 'sensitivity',
        weights,
        provenance: 'fitted on JudgeBench development pool, 2026-07',
      },
      findings,
    );
    expect(result.sensitivityScore).toBe(80);
    expect(result.isPrimary).toBe(false);
  });

  it('refuses to be applied as the primary', () => {
    expect(() =>
      applySeverityCorrection(
        { learnedOn: 'development', appliedAs: 'primary', weights, provenance: 'x' },
        findings,
      ),
    ).toThrow(/primary analysis is the unweighted majority/);
  });

  it('refuses weights learned anywhere but development evidence', () => {
    for (const learnedOn of ['holdout', 'live', 'unknown'] as const) {
      expect(() =>
        applySeverityCorrection(
          { learnedOn, appliedAs: 'sensitivity', weights, provenance: 'x' },
          findings,
        ),
      ).toThrow(/development evidence/);
    }
  });

  it('refuses an unprovenanced correction', () => {
    expect(() =>
      applySeverityCorrection(
        { learnedOn: 'development', appliedAs: 'sensitivity', weights, provenance: '  ' },
        findings,
      ),
    ).toThrow(/without provenance/);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.1 + M2.3 — anchored aggregation                                         */
/* -------------------------------------------------------------------------- */

describe('anchored ballots aggregate by majority, keeping the disagreement visible', () => {
  const entry = (judgeModel: string, judgeFamily: string, ballot: DimensionBallot) => ({
    judgeModel,
    judgeFamily,
    ballot,
  });

  it('takes the majority band and retains every seat’s band and evidence', () => {
    const aggregate = aggregateDimension(dimensionQuestion, [
      entry('x-ai/grok', 'grok', dimensionBallot(3, 'met')),
      entry('google/gemini', 'gemini', dimensionBallot(3, 'met')),
      entry('alibaba/qwen', 'qwen', dimensionBallot(2, 'met')),
    ]);
    expect(aggregate.route).toBe('dimension');
    expect(aggregate.promptVersion).toBe('judge-v3-dimension');
    const dimension = aggregate.primary.dimensions[0]!;
    expect(dimension.majorityBand).toBe(3);
    expect(dimension.bands).toEqual([3, 3, 2]);
    expect(dimension.gap).toBe(1);
    expect(aggregate.primary.criteria[0]!.evidence).toHaveLength(3);
    expect(aggregate.escalate).toBe(false);
  });

  it('escalates a large criterion gap even when a majority exists', () => {
    const aggregate = aggregateDimension(dimensionQuestion, [
      entry('x-ai/grok', 'grok', dimensionBallot(4, 'met')),
      entry('google/gemini', 'gemini', dimensionBallot(4, 'met')),
      entry('alibaba/qwen', 'qwen', dimensionBallot(1, 'met')),
    ]);
    expect(aggregate.primary.dimensions[0]!.majorityBand).toBe(4);
    expect(aggregate.escalations.map((e) => e.reason)).toContain('criterion-gap');
  });

  it('escalates a split on a critical criterion, majority or not', () => {
    const aggregate = aggregateDimension(dimensionQuestion, [
      entry('x-ai/grok', 'grok', dimensionBallot(3, 'missed')),
      entry('google/gemini', 'gemini', dimensionBallot(3, 'met')),
      entry('alibaba/qwen', 'qwen', dimensionBallot(3, 'met')),
    ]);
    const critical = aggregate.primary.criteria.find((c) => c.criterionId === 'c-raw-flour')!;
    expect(critical.majority).toBe('met');
    expect(critical.split).toBe(true);
    expect(aggregate.escalations.map((e) => e.reason)).toContain('split-critical-tag');
  });

  it('reports no majority band rather than averaging three different bands', () => {
    const aggregate = aggregateDimension(dimensionQuestion, [
      entry('x-ai/grok', 'grok', dimensionBallot(1, 'met')),
      entry('google/gemini', 'gemini', dimensionBallot(2, 'met')),
      entry('alibaba/qwen', 'qwen', dimensionBallot(3, 'met')),
    ]);
    expect(aggregate.primary.dimensions[0]!.majorityBand).toBeNull();
    expect(aggregate.escalations.map((e) => e.reason)).toContain('no-majority');
  });

  it('publishes leave-one-family-out bands', () => {
    const aggregate = aggregateDimension(dimensionQuestion, [
      entry('x-ai/grok', 'grok', dimensionBallot(4, 'met')),
      entry('google/gemini', 'gemini', dimensionBallot(2, 'met')),
      entry('alibaba/qwen', 'qwen', dimensionBallot(2, 'met')),
    ]);
    const withoutGemini = aggregate.leaveOneFamilyOut.find((l) => l.family === 'gemini')!;
    // 4/2/2 has a majority of 2; without gemini it is 4/2 and there is none.
    expect(aggregate.primary.dimensions[0]!.majorityBand).toBe(2);
    expect(withoutGemini.dimensions[0]!.majorityBand).toBeNull();
  });

  it('refuses a ballot missing the dimension it claims to have scored', () => {
    const broken: DimensionBallot = { ...dimensionBallot(3, 'met'), dimensions: [] };
    expect(() =>
      aggregateDimension(dimensionQuestion, [entry('x-ai/grok', 'grok', broken)]),
    ).toThrow(/left dimension "diagnostic ranking" unscored/);
  });

  it('refuses to aggregate an empty seat list', () => {
    expect(() => aggregateDimension(dimensionQuestion, [])).toThrow(/no seats/);
  });
});

/* -------------------------------------------------------------------------- */
/* Execution — the seats, the two orders and the money                        */
/* -------------------------------------------------------------------------- */

const pairwiseQuestion: Question = {
  ...dimensionQuestion,
  id: 'tech-202',
  anchors: undefined,
  grader: {
    type: 'llm-judge',
    judgeMode: 'pairwise',
    rubric: [
      { id: 'c-acid', kind: 'include', statement: 'Checks salt and acid first', weight: 2 },
      { id: 'c-raw-flour', kind: 'critical', statement: 'No raw flour in a finished braise', weight: 5 },
    ],
  },
};

const ALPHA = 'Season it, add a splash of vinegar, then reduce the sauce.';
const BETA = 'Drop in two stock cubes and stir through a spoon of raw flour.';

/** A judge that always prefers ALPHA, whichever position it is shown in. */
function positionBlindReply(call: RecordedCall): string {
  const user = call.messages[1]!.content;
  const alphaFirst = user.indexOf(ALPHA) < user.indexOf(BETA);
  return JSON.stringify({
    outcome: alphaFirst ? 'A' : 'B',
    criteria: [
      { id: 'c-acid', favours: alphaFirst ? 'A' : 'B', evidence: 'salts before sweetening' },
      { id: 'c-raw-flour', favours: alphaFirst ? 'A' : 'B', evidence: 'no raw flour' },
    ],
    criticalFailures: [],
    confidence: 0.85,
    reasoning: 'One seasons, one thickens with raw flour.',
  });
}

describe('running a pairwise comparison', () => {
  it('asks every seat for both orders and returns three rater units, not six votes', async () => {
    const client = fakeClient(positionBlindReply);
    const result = await judgePairwiseComparison(
      client,
      SEATING,
      pairwiseQuestion,
      { modelId: 'meta/llama', answerText: ALPHA },
      { modelId: 'mistral/large', answerText: BETA },
    );
    expect(client.calls).toHaveLength(6);
    for (const seat of SEATING.seats) {
      expect(client.calls.filter((c) => c.modelId === seat)).toHaveLength(2);
    }
    expect(result.units).toHaveLength(3);
    expect(result.primary.decidedUnits).toBe(3);
    expect(result.primary.outcome).toBe('candidate:meta/llama');
    expect(result.escalate).toBe(false);
    expect(result.costUsd).toBeCloseTo(0.06, 5);
    expect(result.candidates).toEqual(['meta/llama', 'mistral/large']);
  });

  it('sends nothing that names either candidate', async () => {
    const client = fakeClient(positionBlindReply);
    await judgePairwiseComparison(
      client,
      SEATING,
      pairwiseQuestion,
      { modelId: 'meta/llama', answerText: `${ALPHA} I am Llama 4 Maverick, made by Meta.` },
      { modelId: 'mistral/large', answerText: BETA },
      { lexicon: LEXICON },
    );
    const sent = client.calls.flatMap((c) => c.messages.map((m) => m.content)).join('\n');
    expect(sent).not.toMatch(/meta\/llama|mistral\/large|maverick/i);
  });

  it('refuses a jury of two before spending a penny', async () => {
    const client = fakeClient(() => {
      throw new Error('must not be called');
    });
    await expect(
      judgePairwiseComparison(
        client,
        { seats: ['x-ai/grok', 'google/gemini'], families: ['grok', 'gemini'] },
        pairwiseQuestion,
        { modelId: 'meta/llama', answerText: ALPHA },
        { modelId: 'mistral/large', answerText: BETA },
      ),
    ).rejects.toThrow(/may not be reduced/);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses two seats from one judge family', async () => {
    const client = fakeClient(positionBlindReply);
    await expect(
      judgePairwiseComparison(
        client,
        { seats: ['x-ai/grok', 'x-ai/grok-2', 'google/gemini'], families: ['grok', 'grok', 'gemini'] },
        pairwiseQuestion,
        { modelId: 'meta/llama', answerText: ALPHA },
        { modelId: 'mistral/large', answerText: BETA },
      ),
    ).rejects.toThrow(/same judge family/);
    expect(client.calls).toHaveLength(0);
  });

  it('refuses to compare a model with itself', async () => {
    const client = fakeClient(positionBlindReply);
    await expect(
      judgePairwiseComparison(
        client,
        SEATING,
        pairwiseQuestion,
        { modelId: 'meta/llama', answerText: ALPHA },
        { modelId: 'meta/llama', answerText: BETA },
      ),
    ).rejects.toThrow(/names meta\/llama twice/);
  });

  it('catches a position-biased judge as instability rather than counting it twice', async () => {
    // A judge that always says "the first one" is the first-position effect in
    // its purest form. It must not read as two votes for opposite models.
    const client = fakeClient((call) =>
      call.modelId === 'x-ai/grok'
        ? JSON.stringify({
            outcome: 'A',
            criteria: [
              { id: 'c-acid', favours: 'A', evidence: 'first shown' },
              { id: 'c-raw-flour', favours: 'A', evidence: 'first shown' },
            ],
            criticalFailures: [],
            confidence: 0.9,
            reasoning: 'the first one',
          })
        : positionBlindReply(call),
    );
    const result = await judgePairwiseComparison(
      client,
      SEATING,
      pairwiseQuestion,
      { modelId: 'meta/llama', answerText: ALPHA },
      { modelId: 'mistral/large', answerText: BETA },
    );
    expect(result.unstable).toBe(1);
    expect(result.primary.decidedUnits).toBe(2);
    expect(result.escalations.map((e) => e.reason)).toContain('order-flip');
  });
});

describe('running a dimension ballot', () => {
  it('collects one ballot per seat and aggregates by majority', async () => {
    const bands = new Map([
      ['x-ai/grok', 3],
      ['google/gemini', 3],
      ['alibaba/qwen', 2],
    ]);
    const client = fakeClient((call) =>
      JSON.stringify({
        dimensions: [
          {
            dimension: 'diagnostic ranking',
            band: bands.get(call.modelId),
            evidence: 'tests salt, then acid',
          },
        ],
        criteria: [
          { id: 'c-acid', decision: 'met', evidence: 'salt first' },
          { id: 'c-raw-flour', decision: 'met', evidence: 'no flour' },
        ],
        confidence: 0.8,
        summary: 'sound',
      }),
    );
    const result = await judgeDimensionAnswer(client, SEATING, 'openai/gpt-5.5', dimensionQuestion, ALPHA);
    expect(client.calls).toHaveLength(3);
    expect(result.primary.dimensions[0]!.majorityBand).toBe(3);
    expect(result.ballots.map((b) => b.judgeFamily)).toEqual(['grok', 'gemini', 'qwen']);
    expect(result.costUsd).toBeCloseTo(0.03, 5);
  });

  it('retries a malformed ballot and gives up rather than inventing one', async () => {
    let attempts = 0;
    const client = fakeClient(() => {
      attempts++;
      return 'no json here';
    });
    await expect(judgeDimensionAnswer(client, SEATING, 'openai/gpt-5.5', dimensionQuestion, ALPHA)).rejects.toThrow(
      /no JSON/,
    );
    // Three attempts per seat, and the cost of all of them is still recorded.
    expect(attempts).toBe(9);
  });
});
