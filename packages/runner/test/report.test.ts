import { describe, expect, it } from 'vitest';
import type { Question, Score, StoredResponse } from '@cookingbench/core';
import { buildLeaderboard } from '../src/report.js';

const MODELS = [
  { id: 'lab/alpha', displayName: 'Alpha', provider: 'Lab', family: 'alpha' },
  { id: 'lab/beta', displayName: 'Beta', provider: 'Lab', family: 'beta' },
];

function question(id: string, status: Question['status'] = 'active'): Question {
  return {
    id,
    category: 'technique',
    difficulty: 3,
    status,
    addedIn: 'v2',
    trap: false,
    public: true,
    prompt: `prompt for ${id}`,
    grader: { type: 'numeric', expected: 1, unit: 'g', tolerancePct: 1 },
    referenceAnswer: '1 g',
  } as Question;
}

function score(modelId: string, questionId: string, detail: unknown = {}): Score {
  return {
    runId: 'test',
    modelId,
    questionId,
    score: 100,
    graderType: 'llm-judge',
    detail: detail as Score['detail'],
  };
}

function response(modelId: string, questionId: string, costUsd: number): StoredResponse {
  return {
    runId: 'test',
    modelId,
    questionId,
    answerText: 'an answer',
    raw: {},
    tokensIn: 1,
    tokensOut: 1,
    costUsd,
    latencyMs: 1,
  };
}

const rowFor = (report: ReturnType<typeof buildLeaderboard>, modelId: string) =>
  report.rows.find((r) => r.modelId === modelId)!;

describe('buildLeaderboard cost fields', () => {
  it('leaves judgeCostUsd undefined rather than 0 when nothing recorded one', () => {
    // "Not recorded" and "free" must not render the same. A 0 here would let a
    // page publish "$0.00 judging" for a run that simply predates cost
    // recording, which is the same class of lie as calling candidate spend the
    // run cost.
    const questions = [question('tech-001')];
    const report = buildLeaderboard(
      'test',
      MODELS,
      questions,
      [response('lab/alpha', 'tech-001', 0.5)],
      [score('lab/alpha', 'tech-001')],
    );
    expect(rowFor(report, 'lab/alpha').judgeCostUsd).toBeUndefined();
    expect('judgeCostUsd' in rowFor(report, 'lab/alpha')).toBe(true);
  });

  it('sums judge spend per model across active, basics and retired items', () => {
    // The money was spent on every verdict the panel returned, whichever tier
    // the item ended up in. Charging the run only for the items that reach a
    // column would understate it exactly the way the site used to.
    const questions = [
      question('tech-001', 'active'),
      question('tech-002', 'basics'),
      question('tech-003', 'retired'),
    ];
    const report = buildLeaderboard(
      'test',
      MODELS,
      questions,
      [
        response('lab/alpha', 'tech-001', 0.1),
        response('lab/alpha', 'tech-002', 0.1),
        response('lab/alpha', 'tech-003', 0.1),
      ],
      [
        score('lab/alpha', 'tech-001', { judgeCostUsd: 0.02 }),
        score('lab/alpha', 'tech-002', { judgeCostUsd: 0.03 }),
        score('lab/alpha', 'tech-003', { judgeCostUsd: 0.04 }),
      ],
    );
    expect(rowFor(report, 'lab/alpha').judgeCostUsd).toBeCloseTo(0.09, 6);
  });

  it('counts judge spend on answers still awaiting a verdict', () => {
    // A judgePending score is excluded from every column, but a partially
    // judged run still paid for the calls that landed.
    const questions = [question('tech-001'), question('tech-002')];
    const report = buildLeaderboard(
      'test',
      MODELS,
      questions,
      [response('lab/alpha', 'tech-001', 0.1), response('lab/alpha', 'tech-002', 0.1)],
      [
        score('lab/alpha', 'tech-001', { judgeCostUsd: 0.02 }),
        score('lab/alpha', 'tech-002', { judgePending: true, judgeCostUsd: 0.05 }),
      ],
    );
    expect(rowFor(report, 'lab/alpha').judgeCostUsd).toBeCloseTo(0.07, 6);
    expect(rowFor(report, 'lab/alpha').unjudged).toBe(1);
  });

  it('keeps candidate and judge spend in separate fields', () => {
    // costUsd is what the site's per-model column shows. If judge spend ever
    // leaks into it the column silently becomes a different quantity from the
    // one the breakdown adds up.
    const questions = [question('tech-001')];
    const report = buildLeaderboard(
      'test',
      MODELS,
      questions,
      [response('lab/alpha', 'tech-001', 1.25)],
      [score('lab/alpha', 'tech-001', { judgeCostUsd: 0.75 })],
    );
    expect(rowFor(report, 'lab/alpha').costUsd).toBeCloseTo(1.25, 6);
    expect(rowFor(report, 'lab/alpha').judgeCostUsd).toBeCloseTo(0.75, 6);
  });

  it('ignores malformed judge costs instead of producing a NaN row', () => {
    // A NaN would propagate into every total downstream and render as "$NaN",
    // so a corrupt detail field must be treated as unrecorded.
    const questions = [question('tech-001'), question('tech-002')];
    const report = buildLeaderboard(
      'test',
      MODELS,
      questions,
      [response('lab/alpha', 'tech-001', 0.1), response('lab/alpha', 'tech-002', 0.1)],
      [
        score('lab/alpha', 'tech-001', { judgeCostUsd: Number.NaN }),
        score('lab/alpha', 'tech-002', { judgeCostUsd: '0.40' }),
      ],
    );
    expect(rowFor(report, 'lab/alpha').judgeCostUsd).toBeUndefined();
  });

  it('attributes judge spend to the model whose answer was judged', () => {
    const questions = [question('tech-001')];
    const report = buildLeaderboard(
      'test',
      MODELS,
      questions,
      [response('lab/alpha', 'tech-001', 0.1), response('lab/beta', 'tech-001', 0.2)],
      [
        score('lab/alpha', 'tech-001', { judgeCostUsd: 0.02 }),
        score('lab/beta', 'tech-001', { judgeCostUsd: 0.06 }),
      ],
    );
    expect(rowFor(report, 'lab/alpha').judgeCostUsd).toBeCloseTo(0.02, 6);
    expect(rowFor(report, 'lab/beta').judgeCostUsd).toBeCloseTo(0.06, 6);
  });
});
