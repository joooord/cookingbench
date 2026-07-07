import { describe, expect, it } from 'vitest';
import type { Question, Score, StoredResponse } from '@cookingbench/core';
import { analyzeRun } from '../src/analyze.js';

// Six models ranked strongest (m0) to weakest (m5).
const MODELS = ['m0/a', 'm1/b', 'm2/c', 'm3/d', 'm4/e', 'm5/f'];

function question(id: string, graderType: 'numeric' | 'llm-judge'): Question {
  const grader =
    graderType === 'numeric'
      ? ({ type: 'numeric', expected: 1, unit: 'g' } as const)
      : ({ type: 'llm-judge' } as const);
  return {
    id,
    category: 'nutrition',
    difficulty: 3,
    status: 'active',
    addedIn: 'v2',
    trap: false,
    prompt: `prompt for ${id}`,
    grader,
    referenceAnswer: 'ref',
    public: true,
  } as Question;
}

function score(modelId: string, questionId: string, value: number): Score {
  return { runId: 'r', modelId, questionId, score: value, graderType: 'numeric', detail: {} } as Score;
}

function response(modelId: string, questionId: string, finish = 'stop', text = 'ok'): StoredResponse {
  return {
    runId: 'r',
    modelId,
    questionId,
    answerText: text,
    raw: { choices: [{ finish_reason: finish }] },
    tokensIn: 1,
    tokensOut: 1,
    costUsd: 0,
    latencyMs: 1,
  } as StoredResponse;
}

/** Three ranking items that make m0..m5 a clear strong→weak overall order. */
function rankingScaffold(): { questions: Question[]; scores: Score[]; responses: StoredResponse[] } {
  const questions: Question[] = [];
  const scores: Score[] = [];
  const responses: StoredResponse[] = [];
  for (const rid of ['rank-1', 'rank-2', 'rank-3']) {
    questions.push(question(rid, 'numeric'));
    MODELS.forEach((m, i) => {
      scores.push(score(m, rid, Math.round((100 * (MODELS.length - 1 - i)) / (MODELS.length - 1))));
      responses.push(response(m, rid));
    });
  }
  return { questions, scores, responses };
}

function analysisFor(
  questionId: string,
  extra: { questions: Question[]; scores: Score[]; responses: StoredResponse[] },
  judgePromptVersion?: string,
) {
  const base = rankingScaffold();
  const analysis = analyzeRun(
    'r',
    [...base.questions, ...extra.questions],
    [...base.responses, ...extra.responses],
    [...base.scores, ...extra.scores],
    { judgePromptVersion },
  );
  return analysis.questionsAnalyzed.find((i) => i.questionId === questionId)!;
}

describe('analyzeRun verdicts', () => {
  it('demotes an all-perfect llm-judge item only under judge-v2', () => {
    const extra = {
      questions: [question('flav-100', 'llm-judge')],
      scores: MODELS.map((m) => score(m, 'flav-100', 100)),
      responses: MODELS.map((m) => response(m, 'flav-100')),
    };
    expect(analysisFor('flav-100', extra, 'judge-v2').verdict).toBe('basics-candidate');
    expect(analysisFor('flav-100', extra, 'v1').verdict).toBe('keep');
  });

  it('excludes content-filtered responses from discrimination', () => {
    // The strongest model is content-filtered (score 0); its 0 must not create
    // fake negative discrimination — the clean scores are all 100.
    const extra = {
      questions: [question('nutr-cf', 'numeric')],
      scores: [
        score('m0/a', 'nutr-cf', 0),
        ...MODELS.slice(1).map((m) => score(m, 'nutr-cf', 100)),
      ],
      responses: [
        response('m0/a', 'nutr-cf', 'content_filter', ''),
        ...MODELS.slice(1).map((m) => response(m, 'nutr-cf')),
      ],
    };
    const item = analysisFor('nutr-cf', extra);
    expect(item.anomalies).toBe(1);
    expect(item.discrimination).toBe(0);
    expect(item.verdict).toBe('basics-candidate');
  });

  it('flags a mis-keyed deterministic grader as grader-audit', () => {
    // Weaker models beat stronger ones with real spread → negative discrimination.
    const extra = {
      questions: [question('num-bad', 'numeric')],
      scores: MODELS.map((m, i) => score(m, 'num-bad', i < 3 ? 0 : 100)),
      responses: MODELS.map((m) => response(m, 'num-bad')),
    };
    const item = analysisFor('num-bad', extra);
    expect(item.discrimination).toBeLessThanOrEqual(-10);
    expect(item.verdict).toBe('grader-audit');
  });
});
