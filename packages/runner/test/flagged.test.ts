import { describe, expect, it } from 'vitest';
import type { Question, Score, StoredResponse } from '@cookingbench/core';
import { buildFlaggedReport } from '../src/flagged.js';

function question(id: string): Question {
  return {
    id,
    category: 'flavor-pairing',
    difficulty: 3,
    status: 'active',
    addedIn: 'v2',
    trap: false,
    prompt: `What pairs with ${id}?`,
    grader: { type: 'llm-judge' },
    referenceAnswer: 'A sound reference answer.',
    public: true,
  } as Question;
}

function response(modelId: string, questionId: string, answerText: string): StoredResponse {
  return {
    runId: 'r',
    modelId,
    questionId,
    answerText,
    raw: {},
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    latencyMs: 1,
  } as StoredResponse;
}

describe('buildFlaggedReport', () => {
  const questions = [question('flav-050'), question('flav-051')];
  const responses = [
    response('a/model', 'flav-050', 'Answer one, quite detailed.'),
    response('b/model', 'flav-051', 'Answer two.'),
  ];
  const scores: Score[] = [
    {
      runId: 'r',
      modelId: 'a/model',
      questionId: 'flav-050',
      score: 40,
      graderType: 'llm-judge',
      detail: {
        flagged: true,
        disagreement: 60,
        verdicts: [
          { judgeModel: 'j/one', score: 70, summary: 'Mostly fine', findings: [] },
          {
            judgeModel: 'j/two',
            score: 10,
            summary: 'Missed the point',
            findings: [{ severity: 'critical', issue: 'wrong dish', quote: 'serve raw' }],
          },
        ],
      },
    },
    // Not flagged — must be excluded.
    {
      runId: 'r',
      modelId: 'b/model',
      questionId: 'flav-051',
      score: 95,
      graderType: 'llm-judge',
      detail: { flagged: false, disagreement: 5 },
    },
  ];

  it('includes only flagged answers, grouped with seat detail and a verdict line', () => {
    const { markdown, count } = buildFlaggedReport('r', questions, responses, scores);
    expect(count).toBe(1);
    expect(markdown).toContain('## flav-050');
    expect(markdown).not.toContain('flav-051'); // the un-flagged one is excluded
    expect(markdown).toContain('j/one → 70');
    expect(markdown).toContain('j/two → 10');
    expect(markdown).toContain('wrong dish');
    expect(markdown).toContain('Answer one, quite detailed.');
    expect(markdown).toContain('**Human verdict:**');
  });

  it('reports zero when nothing is flagged', () => {
    const none = buildFlaggedReport('r', questions, responses, [scores[1]!]);
    expect(none.count).toBe(0);
  });
});
