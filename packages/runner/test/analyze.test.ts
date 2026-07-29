import { describe, expect, it } from 'vitest';
import type { Question, Score, StoredResponse } from '@cookingbench/core';
import { analyzeRun, tiedRanks } from '../src/analyze.js';

function question(id: string, difficulty: 1 | 2 | 3 | 4 | 5): Question {
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
function build(perModel: Record<string, number[]>, difficulties?: number[]) {
  const n = Object.values(perModel)[0]!.length;
  const questions = Array.from({ length: n }, (_, i) =>
    question(`tech-${String(i).padStart(3, '0')}`, (difficulties?.[i] ?? 3) as 1 | 2 | 3 | 4 | 5),
  );
  const scores: Score[] = [];
  const responses: StoredResponse[] = [];
  for (const [modelId, values] of Object.entries(perModel)) {
    values.forEach((v, i) => {
      scores.push(score(modelId, questions[i]!.id, v));
      responses.push(response(modelId, questions[i]!.id));
    });
  }
  return analyzeRun('test', questions, responses, scores);
}

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
