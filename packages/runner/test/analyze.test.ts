import { describe, expect, it } from 'vitest';
import type { Question, Score, StoredResponse } from '@cookingbench/core';
import { analyzeRun, formatConfirmatory, tiedRanks, type AnalyzeOptions } from '../src/analyze.js';
import { assertClaimLanguage, type PracticalMargin } from '../../core/src/stats.js';

function question(id: string, difficulty: 1 | 2 | 3 | 4 | 5, scenarioFamily?: string): Question {
  return {
    id,
    category: 'technique',
    difficulty,
    status: 'active',
    addedIn: 'v2',
    trap: false,
    public: true,
    prompt: `prompt for ${id}`,
    grader: { type: 'numeric', expected: 1, unit: 'g', tolerancePct: 1 },
    referenceAnswer: '1 g',
    ...(scenarioFamily ? { classification: { scenarioFamily } } : {}),
  } as Question;
}

function score(modelId: string, questionId: string, value: number): Score {
  return {
    runId: 'test',
    modelId,
    questionId,
    score: value,
    graderType: 'numeric',
    detail: {} as Score['detail'],
  };
}

function response(modelId: string, questionId: string): StoredResponse {
  return {
    runId: 'test',
    modelId,
    questionId,
    answerText: 'an answer',
    raw: {},
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    latencyMs: 1,
  };
}

/** n active items, all difficulty 3 unless `hard` says otherwise. */
function build(
  perModel: Record<string, number[]>,
  difficulties?: number[],
  extra?: { families?: string[]; opts?: AnalyzeOptions },
) {
  const n = Object.values(perModel)[0]!.length;
  const questions = Array.from({ length: n }, (_, i) =>
    question(
      `tech-${String(i).padStart(3, '0')}`,
      (difficulties?.[i] ?? 3) as 1 | 2 | 3 | 4 | 5,
      extra?.families?.[i],
    ),
  );
  const scores: Score[] = [];
  const responses: StoredResponse[] = [];
  for (const [modelId, values] of Object.entries(perModel)) {
    values.forEach((v, i) => {
      scores.push(score(modelId, questions[i]!.id, v));
      responses.push(response(modelId, questions[i]!.id));
    });
  }
  return analyzeRun('test', questions, responses, scores, extra?.opts);
}

/** Every item its own scenario family — clustering declared, but no pooling. */
function soloFamilies(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `fam-${String(i).padStart(3, '0')}`);
}

/**
 * Deterministic per-item noise. Constant offsets between models produce
 * constant per-item differences, which every bootstrap resample agrees about —
 * useless for testing a procedure whose whole job is to weigh disagreement.
 */
function pseudo(seed: number, n: number, mean: number, spread: number): number[] {
  let s = seed >>> 0;
  return Array.from({ length: n }, () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return mean + (s / 2 ** 32 - 0.5) * 2 * spread;
  });
}

const MARGIN: PracticalMargin = {
  points: 2,
  preregisteredIn: 'analysis-plan-test',
  approvedBy: 'measurement review (fixture)',
  rationale: 'two points is the smallest gap a reader would act on',
};

/** Keeps the fixtures quick; the resolution guards are exercised in core. */
const FAST: AnalyzeOptions['confirmatory'] = {
  reps: 1000,
  intervalReps: 4000,
  fragilityReps: 300,
};

describe('adjacent-pair separation', () => {
  it('separates a model that beats another on essentially every item', () => {
    const strong = Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? 60 : 90));
    const weak = Array.from({ length: 40 }, (_, i) => (i % 10 === 0 ? 40 : 60));
    const pairs = build({ strong, weak }).separation.filter((p) => p.scope === 'active');
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.a).toBe('strong');
    expect(pairs[0]!.separated).toBe(true);
    expect(pairs[0]!.gap).toBeGreaterThan(0);
  });

  it('calls a hair-thin lead tied, which is the whole point', () => {
    // One item apart out of 40 — the shape of the top of 2026-07-v2.1, where a
    // 0.01-point lead would otherwise read as "the best model".
    const a = Array.from({ length: 40 }, (_, i) => (i === 0 ? 100 : 80));
    const b = Array.from({ length: 40 }, (_, i) => (i === 0 ? 99 : 80));
    const pairs = build({ a, b }).separation.filter((p) => p.scope === 'active');
    expect(pairs[0]!.separated).toBe(false);
    expect(pairs[0]!.pAhead).toBeLessThan(0.95);
  });

  it('is deterministic across runs', () => {
    const perModel = {
      a: Array.from({ length: 30 }, (_, i) => 70 + (i % 7) * 4),
      b: Array.from({ length: 30 }, (_, i) => 65 + (i % 5) * 3),
    };
    expect(build(perModel).separation).toEqual(build(perModel).separation);
  });

  it('scopes the frontier comparison to difficulty >= 4 items', () => {
    const difficulties = Array.from({ length: 20 }, (_, i) => (i < 8 ? 5 : 2));
    const a = Array.from({ length: 20 }, () => 90);
    const b = Array.from({ length: 20 }, () => 80);
    const analysis = build({ a, b }, difficulties);
    expect(analysis.separation.find((p) => p.scope === 'active')!.items).toBe(20);
    expect(analysis.separation.find((p) => p.scope === 'frontier')!.items).toBe(8);
  });

  it('compares every pair, not just adjacent ones', () => {
    // 4 models => 6 pairs, so a rank can be based on a direct A-vs-D test.
    const perModel = {
      a: Array.from({ length: 30 }, () => 95),
      b: Array.from({ length: 30 }, () => 90),
      c: Array.from({ length: 30 }, () => 85),
      d: Array.from({ length: 30 }, () => 80),
    };
    const pairs = build(perModel).separation.filter((p) => p.scope === 'active');
    expect(pairs).toHaveLength(6);
    expect(pairs.filter((p) => p.adjacent)).toHaveLength(3);
  });

  it('does not let statistical ties chain into a false shared first place', () => {
    // Each model beats the next by a hair but the ends are far apart — the
    // shape of run 2026-07-v2.1, where following adjacent verdicts put a model
    // 5 points off the lead into a twelve-way tie for first.
    const step = (offset: number) => Array.from({ length: 60 }, (_, i) => 50 + offset + (i % 10));
    const analysis = build({ a: step(9), b: step(6), c: step(3), d: step(0) });
    const ranks = tiedRanks(analysis.separation, 'active');
    const pairAD = analysis.separation.find((p) => p.a === 'a' && p.b === 'd')!;
    expect(pairAD.separated).toBe(true);
    // d is proven worse than a, so it cannot share a's place whatever the
    // adjacent verdicts say.
    expect(ranks.get('d')).toBeGreaterThan(1);
    expect(ranks.get('a')).toBe(1);
  });

  it('gives models nothing is proven to beat a shared first place', () => {
    const flat = () => Array.from({ length: 40 }, (_, i) => 80 + (i % 5));
    const ranks = tiedRanks(build({ a: flat(), b: flat(), c: flat() }).separation, 'active');
    expect([...ranks.values()]).toEqual([1, 1, 1]);
  });

  it('scores each pair independently of how many other pairs were drawn', () => {
    // Per-pair seeding: a pair's verdict must not move when the roster grows.
    const a = Array.from({ length: 50 }, (_, i) => 70 + (i % 11));
    const b = Array.from({ length: 50 }, (_, i) => 62 + (i % 7));
    const two = build({ a, b }).separation.find((p) => p.a === 'a' && p.b === 'b')!;
    const three = build({ a, b, c: Array.from({ length: 50 }, () => 50) }).separation.find(
      (p) => p.a === 'a' && p.b === 'b',
    )!;
    expect(three.pAhead).toBe(two.pAhead);
  });

  it('ignores items a model is missing, so a gap is never an artefact of coverage', () => {
    const questions = [question('tech-000', 3), question('tech-001', 3)];
    const scores = [
      score('a', 'tech-000', 100),
      score('a', 'tech-001', 100),
      score('b', 'tech-000', 50),
      // b never answered tech-001.
    ];
    const responses = scores.map((s) => response(s.modelId, s.questionId));
    const pairs = analyzeRun('test', questions, responses, scores).separation.filter(
      (p) => p.scope === 'active',
    );
    expect(pairs[0]!.items).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* M4.4 — the confirmatory layer                                              */
/* -------------------------------------------------------------------------- */

function active(analysis: ReturnType<typeof build>) {
  return analysis.confirmatory!.find((c) => c.scope === 'active')!;
}

describe('confirmatory analysis', () => {
  it('leaves the published screening column untouched', () => {
    // `separation` is what the site and every committed artifact read. Adding
    // the confirmatory layer must not move a single one of its numbers.
    const perModel = {
      a: Array.from({ length: 30 }, (_, i) => 70 + (i % 7) * 4),
      b: Array.from({ length: 30 }, (_, i) => 65 + (i % 5) * 3),
    };
    const plain = build(perModel);
    const withOpts = build(perModel, undefined, { families: soloFamilies(30), opts: { confirmatory: FAST } });
    expect(withOpts.separation).toEqual(plain.separation);
  });

  it('withdraws screening orderings that cannot survive their own family', () => {
    // Four models, six pairs, genuinely noisy per-item scores. Several pairs
    // clear an uncorrected 95% on their own; most do not survive Holm across
    // the six. This is "48 of 91 pairs separate" in miniature — the family is
    // the thing that was never accounted for, not the individual test.
    const analysis = build(
      {
        a: pseudo(11, 40, 75, 25),
        b: pseudo(22, 40, 70, 25),
        c: pseudo(33, 40, 65, 25),
        d: pseudo(44, 40, 60, 25),
      },
      undefined,
      { families: soloFamilies(40), opts: { confirmatory: FAST } },
    );
    const screening = analysis.separation.filter((p) => p.scope === 'active' && p.separated);
    const conf = active(analysis);
    expect(screening.length).toBeGreaterThan(0);
    expect(conf.pairs.filter((p) => p.ordered).length).toBeLessThan(screening.length);
    // …and specifically: a pair the screening column calls separated has no
    // confirmatory ordering, with the sanctioned wording to match.
    const withdrawn = screening
      .map((s) => conf.pairs.find((p) => p.a === s.a && p.b === s.b)!)
      .filter((p) => !p.ordered);
    expect(withdrawn.length).toBeGreaterThan(0);
    expect(withdrawn[0]!.claim).toMatch(/screening only/);
  });

  it('does not let a chain of ties become a shared tier', () => {
    // Same shape as the tiedRanks fixture: each neighbour is a coin flip, the
    // ends are far apart. Walking the chain would put d in the top tier.
    const step = (offset: number) => Array.from({ length: 60 }, (_, i) => 50 + offset + (i % 10));
    const analysis = build(
      { a: step(9), b: step(6), c: step(3), d: step(0) },
      undefined,
      { families: soloFamilies(60), opts: { confirmatory: FAST } },
    );
    const c = active(analysis);
    expect(c.pairs.find((p) => p.a === 'a' && p.b === 'd')!.ordered).toBe(true);
    expect(c.places['d']).toBeGreaterThan(1);
    const topTier = c.tiers.find((t) => t.models.includes('a'))!;
    expect(topTier.models).not.toContain('d');
  });

  it('never contains an internally ordered tier', () => {
    const step = (offset: number) => Array.from({ length: 60 }, (_, i) => 50 + offset + (i % 10));
    const c = active(
      build({ a: step(9), b: step(6), c: step(3), d: step(0) }, undefined, {
        families: soloFamilies(60),
        opts: { confirmatory: FAST },
      }),
    );
    for (const tier of c.tiers) {
      for (const x of tier.models) {
        for (const y of tier.models) {
          if (x === y) continue;
          const pair = c.pairs.find((p) => p.a === x && p.b === y);
          expect(pair?.ordered ?? false).toBe(false);
        }
      }
    }
  });

  it('refuses a sole winner with no preregistered practical margin, however big the lead', () => {
    const strong = Array.from({ length: 40 }, () => 95);
    const weak = Array.from({ length: 40 }, () => 20);
    const c = active(
      build({ strong, weak }, undefined, {
        families: soloFamilies(40),
        opts: { confirmatory: FAST },
      }),
    );
    expect(c.pairs[0]!.ordered).toBe(true);
    expect(c.soleWinner.model).toBeNull();
    expect(c.soleWinner.refusals.join(' ')).toMatch(/no practical margin/);
  });

  it('names a sole winner once the margin is frozen and the lead clears it', () => {
    const strong = Array.from({ length: 40 }, (_, i) => 90 + (i % 5));
    const weak = Array.from({ length: 40 }, (_, i) => 40 + (i % 5));
    const c = active(
      build({ strong, weak }, undefined, {
        families: soloFamilies(40),
        opts: { confirmatory: { ...FAST, practicalMargin: MARGIN } },
      }),
    );
    expect(c.soleWinner.model).toBe('strong');
    expect(c.soleWinner.comparisons[0]!.clearsZero).toBe(true);
    expect(c.soleWinner.comparisons[0]!.clearsMargin).toBe(true);
    expect(c.soleWinner.comparisons[0]!.holmRejected).toBe(true);
  });

  it('refuses a sole winner whose lead is real but smaller than the margin', () => {
    // A one-point lead on every single item: statistically unmissable, and
    // exactly the "0.01-point lead is not a result" case M4.4 exists to stop.
    const ahead = Array.from({ length: 40 }, (_, i) => 71 + (i % 5));
    const behind = Array.from({ length: 40 }, (_, i) => 70 + (i % 5));
    const c = active(
      build({ ahead, behind }, undefined, {
        families: soloFamilies(40),
        opts: { confirmatory: { ...FAST, practicalMargin: MARGIN } },
      }),
    );
    expect(c.pairs[0]!.ordered).toBe(true);
    expect(c.soleWinner.model).toBeNull();
    expect(c.soleWinner.comparisons[0]!.clearsZero).toBe(true);
    expect(c.soleWinner.comparisons[0]!.clearsMargin).toBe(false);
    expect(c.soleWinner.refusals.join(' ')).toMatch(/2-point margin/);
  });

  it('clusters by scenario family, and pools items that share one', () => {
    // Twenty items in four families of five. The families disagree, so the
    // clustered interval must be wide enough to stop the ordering.
    const families = Array.from({ length: 20 }, (_, i) => `fam-${Math.floor(i / 5)}`);
    const a = Array.from({ length: 20 }, (_, i) => (Math.floor(i / 5) === 0 ? 100 : 60));
    const b = Array.from({ length: 20 }, (_, i) => (Math.floor(i / 5) === 0 ? 10 : 65));
    const c = active(build({ a, b }, undefined, { families, opts: { confirmatory: FAST } }));
    expect(c.clustering).toBe('scenario-family');
    expect(c.clusterCoverage.families).toBe(4);
    expect(c.clusterCoverage.itemsWithFamily).toBe(20);
    expect(c.pairs[0]!.clusters).toBe(4);
    expect(c.pairs[0]!.ordered).toBe(false);
  });

  it('falls back to items and refuses every claim when a family is missing', () => {
    const families = soloFamilies(40);
    delete (families as (string | undefined)[])[7];
    const strong = Array.from({ length: 40 }, (_, i) => 90 + (i % 5));
    const weak = Array.from({ length: 40 }, (_, i) => 40 + (i % 5));
    const c = active(
      build({ strong, weak }, undefined, {
        families: families as string[],
        opts: { confirmatory: { ...FAST, practicalMargin: MARGIN } },
      }),
    );
    expect(c.clustering).toBe('item-unclustered');
    expect(c.clusterCoverage.itemsWithFamily).toBe(39);
    expect(c.refusals.join(' ')).toMatch(/scenario families declared on 39\/40/);
    // The lead is enormous and would otherwise qualify. Missing families are
    // not a reason to publish anyway.
    expect(c.soleWinner.model).toBeNull();
  });

  it('folds an item’s repeats into the item rather than counting them as evidence', () => {
    const questions = Array.from({ length: 4 }, (_, i) =>
      question(`tech-00${i}`, 3, `fam-${i}`),
    );
    const scores: Score[] = [];
    for (const model of ['a', 'b']) {
      questions.forEach((q, i) => {
        scores.push(score(model, q.id, model === 'a' ? 80 + i : 60 + i));
        // A second generation of the same item, deliberately different.
        scores.push(score(model, q.id, model === 'a' ? 90 + i : 50 + i));
      });
    }
    const responses = scores.map((s) => response(s.modelId, s.questionId));
    const analysis = analyzeRun('test', questions, responses, scores, {
      confirmatory: FAST,
    });
    const c = active(analysis);
    expect(c.repeats.itemsWithRepeats).toBeGreaterThan(0);
    // Four items, not eight: a repeat is more evidence about one item, not a
    // fifth item, and letting it count twice would rank models on resampling.
    expect(c.pairs[0]!.items).toBe(4);
    expect(c.clusterCoverage.families).toBe(4);
    // 85 − 55 = 30 on every item, from the averaged repeats.
    expect(c.pairs[0]!.gap).toBeCloseTo(30, 6);
  });

  it('publishes the smallest audited deletion that flips the leader', () => {
    // Two items decide it; everything else runs the other way.
    const a = [100, 100, 50, 50, 50, 50];
    const b = [0, 0, 60, 60, 60, 60];
    const c = active(
      build({ a, b }, undefined, { families: soloFamilies(6), opts: { confirmatory: FAST } }),
    );
    expect(c.flipUnit).toBe('scenario-family');
    expect(c.flip).not.toBeNull();
    expect(c.flip!.size).toBe(2);
    expect(c.flip!.leader).toBe('a');
    expect(c.flip!.challenger).toBe('b');
    expect(c.flip!.units.length).toBe(2);
  });

  it('reports rank fragility over the clustered resample', () => {
    const c = active(
      build(
        {
          a: Array.from({ length: 20 }, (_, i) => 70 + (i % 6)),
          b: Array.from({ length: 20 }, (_, i) => 68 + (i % 6)),
        },
        undefined,
        { families: soloFamilies(20), opts: { confirmatory: FAST } },
      ),
    );
    expect(c.fragility).not.toBeNull();
    expect(c.fragility!.reps).toBe(300);
    expect(c.fragility!.clusters).toBe(20);
    expect(c.fragility!.topGroupStability).toBeGreaterThan(0);
    expect(c.fragility!.models.map((m) => m.modelId).sort()).toEqual(['a', 'b']);
  });

  it('records a refusal rather than throwing when a scope has nothing in it', () => {
    // No difficulty >= 4 items, so the frontier scope is empty.
    const analysis = build(
      { a: [80, 81, 82], b: [70, 71, 72] },
      [3, 3, 3],
      { families: soloFamilies(3), opts: { confirmatory: FAST } },
    );
    const frontier = analysis.confirmatory!.find((c) => c.scope === 'frontier')!;
    expect(frontier.refusals.join(' ')).toMatch(/nothing to compare/);
    expect(frontier.soleWinner.model).toBeNull();
    expect(frontier.pairs).toEqual([]);
  });

  it('corrects over the full matrix when no confirmatory family was declared', () => {
    const analysis = build(
      {
        a: Array.from({ length: 20 }, () => 95),
        b: Array.from({ length: 20 }, () => 90),
        c: Array.from({ length: 20 }, () => 85),
        d: Array.from({ length: 20 }, () => 80),
      },
      undefined,
      { families: soloFamilies(20), opts: { confirmatory: FAST } },
    );
    const conf = active(analysis);
    expect(conf.familyDeclared).toBe(false);
    expect(conf.familySize).toBe(6);
  });

  it('gives no adjusted verdict to a pair outside a declared family', () => {
    const analysis = build(
      {
        a: Array.from({ length: 20 }, () => 95),
        b: Array.from({ length: 20 }, () => 90),
        c: Array.from({ length: 20 }, () => 85),
      },
      undefined,
      {
        families: soloFamilies(20),
        opts: { confirmatory: { ...FAST, confirmatoryFamily: [['a', 'b']] } },
      },
    );
    const conf = active(analysis);
    expect(conf.familySize).toBe(1);
    const outside = conf.pairs.find((p) => p.a === 'a' && p.b === 'c')!;
    expect(outside.pAdjusted).toBeNull();
    // Untested is not ordered. A pair with no confirmatory verdict must never
    // fall through to the screening one.
    expect(outside.ordered).toBe(false);
  });

  it('never emits a banned claim phrase, in any field or in the printed summary', () => {
    const analysis = build(
      {
        a: Array.from({ length: 20 }, () => 95),
        b: Array.from({ length: 20 }, () => 60),
        c: Array.from({ length: 20 }, () => 30),
      },
      undefined,
      {
        families: soloFamilies(20),
        opts: { confirmatory: { ...FAST, practicalMargin: MARGIN } },
      },
    );
    for (const scope of ['active', 'frontier'] as const) {
      for (const line of formatConfirmatory(analysis, scope)) {
        expect(() => assertClaimLanguage(line)).not.toThrow();
      }
    }
    expect(() => assertClaimLanguage(JSON.stringify(analysis.confirmatory))).not.toThrow();
  });

  it('is reproducible: the same matrix produces the same confirmatory block', () => {
    const perModel = {
      a: Array.from({ length: 25 }, (_, i) => 70 + (i % 9)),
      b: Array.from({ length: 25 }, (_, i) => 66 + (i % 7)),
    };
    const one = build(perModel, undefined, {
      families: soloFamilies(25),
      opts: { confirmatory: FAST },
    });
    const two = build(perModel, undefined, {
      families: soloFamilies(25),
      opts: { confirmatory: FAST },
    });
    expect(one.confirmatory).toEqual(two.confirmatory);
  });
});
