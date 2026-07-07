import { describe, expect, it } from 'vitest';
import type { Question } from '@cookingbench/core';
import {
  buildTasteJudgeMessages,
  parseTasteJudgeVerdict,
  planPairs,
  tastePanelSeats,
  pairVerdictToVotes,
  type PairVerdictRecord,
} from '../src/tastejudge.js';

function q(id: string): Question {
  return {
    id,
    category: 'recipe-generation',
    difficulty: 3,
    status: 'active',
    addedIn: 'v3',
    trap: false,
    prompt: `Make something for ${id}`,
    grader: { type: 'llm-judge' },
    referenceAnswer: 'ref',
    public: true,
  } as Question;
}

const ROSTER = [
  'anthropic/claude-fable-5',
  'anthropic/claude-opus-4.8',
  'openai/gpt-5.5',
  'openai/gpt-5.4-mini',
  'google/gemini-3.1-pro-preview',
  'x-ai/grok-4.3',
  'qwen/qwen3.5-plus-20260420',
  'moonshot/kimi-k2.6',
  'mistral/mistral-large-3',
  'meta/llama-4-maverick',
  'deepseek/deepseek-v4-pro',
  'google/gemini-3.5-flash',
  'anthropic/claude-sonnet-4.6',
];

const PANEL = [
  'anthropic/claude-opus-4.8',
  'openai/gpt-5.5',
  'qwen/qwen3.5-plus-20260420',
  'google/gemini-3.1-pro-preview',
  'x-ai/grok-4.3',
];

describe('taste judge prompt + parsing', () => {
  it('includes both anonymised answers and the tie rule', () => {
    const messages = buildTasteJudgeMessages(q('rgen-001'), "As ChatGPT, I'd braise it.", 'Roast it hot.');
    const user = messages[1]!.content;
    expect(user).toContain('ANSWER A');
    expect(user).toContain('ANSWER B');
    expect(user).toContain('[assistant]'); // "As ChatGPT" anonymised
    expect(user).not.toContain('ChatGPT');
    expect(messages[0]!.content.toLowerCase()).toContain('tie');
    expect(messages[0]!.content.toLowerCase()).toContain('ignore length');
  });

  it('parses a valid verdict and rejects invalid ones', () => {
    expect(parseTasteJudgeVerdict('{"winner":"a","reason":"tastier"}')).toEqual({
      winner: 'a',
      reason: 'tastier',
    });
    expect(parseTasteJudgeVerdict('noise {"winner":"tie","reason":"even"} tail').winner).toBe('tie');
    expect(() => parseTasteJudgeVerdict('no json here')).toThrow();
    expect(() => parseTasteJudgeVerdict('{"winner":"c"}')).toThrow();
  });
});

describe('tastePanelSeats', () => {
  it('excludes both contenders’ providers and yields exactly 2 seats for every roster pair', () => {
    for (let i = 0; i < ROSTER.length; i++) {
      for (let j = i + 1; j < ROSTER.length; j++) {
        const [a, b] = ROSTER[i]! < ROSTER[j]! ? [ROSTER[i]!, ROSTER[j]!] : [ROSTER[j]!, ROSTER[i]!];
        const seats = tastePanelSeats(PANEL, a, b, 'rgen-001');
        expect(seats).toHaveLength(2);
        for (const s of seats) {
          expect(s.split('/')[0]).not.toBe(a.split('/')[0]);
          expect(s.split('/')[0]).not.toBe(b.split('/')[0]);
        }
      }
    }
  });

  it('is deterministic', () => {
    const one = tastePanelSeats(PANEL, 'meta/llama-4-maverick', 'moonshot/kimi-k2.6', 'rgen-002');
    const two = tastePanelSeats(PANEL, 'meta/llama-4-maverick', 'moonshot/kimi-k2.6', 'rgen-002');
    expect(one).toEqual(two);
  });

  it('throws when fewer than two seats remain', () => {
    const tiny = ['anthropic/claude-opus-4.8', 'openai/gpt-5.5'];
    expect(() => tastePanelSeats(tiny, 'anthropic/claude-fable-5', 'x-ai/grok-4.3', 'q')).toThrow();
  });
});

describe('planPairs', () => {
  const eligible = new Map<string, string[]>([
    ['rgen-001', ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']],
    ['rgen-002', ['m0', 'm1']],
  ]);
  const questions = [q('rgen-001'), q('rgen-002')];

  it('is deterministic and produces canonical, de-duplicated pairs', () => {
    const a = planPairs('run-x', questions, eligible, 4);
    const b = planPairs('run-x', questions, eligible, 4);
    expect(a).toEqual(b);
    for (const p of a) expect(p.modelA < p.modelB).toBe(true);
    const keys = a.map((p) => `${p.questionId}:${p.modelA}:${p.modelB}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('respects the per-question knob and caps at the round-robin size', () => {
    const plan = planPairs('run-x', questions, eligible, 4);
    expect(plan.filter((p) => p.questionId === 'rgen-001')).toHaveLength(4);
    // rgen-002 has only one possible pair, so it can't exceed that.
    expect(plan.filter((p) => p.questionId === 'rgen-002')).toHaveLength(1);
  });

  it('balances appearances within a question (disjoint pairs per round)', () => {
    const plan = planPairs('run-x', questions, eligible, 3).filter((p) => p.questionId === 'rgen-001');
    const counts = new Map<string, number>();
    for (const p of plan) {
      counts.set(p.modelA, (counts.get(p.modelA) ?? 0) + 1);
      counts.set(p.modelB, (counts.get(p.modelB) ?? 0) + 1);
    }
    const values = [...counts.values()];
    expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
  });
});

describe('pairVerdictToVotes', () => {
  it('emits one PanelTasteVote per seat with the collapsed winner', () => {
    const record: PairVerdictRecord = {
      runId: 'r',
      questionId: 'rgen-001',
      modelA: 'a/x',
      modelB: 'b/y',
      promptVersion: 'taste-judge-v1',
      judgedAt: 'now',
      costUsd: 0,
      seats: [
        {
          judgeModel: 'j/one',
          forward: { winner: 'a', reason: '' },
          reversed: { winner: 'a', reason: '' },
          final: 'a',
          positionConsistent: true,
        },
        {
          judgeModel: 'j/two',
          forward: { winner: 'a', reason: '' },
          reversed: { winner: 'b', reason: '' },
          final: 'tie',
          positionConsistent: false,
        },
      ],
    };
    const votes = pairVerdictToVotes(record);
    expect(votes).toHaveLength(2);
    expect(votes[0]).toMatchObject({ model_a: 'a/x', model_b: 'b/y', winner: 'a', judge_model: 'j/one' });
    expect(votes[1]).toMatchObject({ winner: 'tie', judge_model: 'j/two', position_consistent: false });
  });
});
