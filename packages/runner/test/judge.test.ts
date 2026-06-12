import { describe, expect, it } from 'vitest';
import type { Question } from '@cookingbench/core';
import { anonymizeAnswer, buildJudgeMessages, panelSeats, parseJudgeResponse } from '../src/judge.js';

const question: Question = {
  id: 'tech-001',
  category: 'technique',
  difficulty: 3,
  status: 'active',
  addedIn: 'v1',
  trap: false,
  prompt: 'My hollandaise split. What went wrong and how do I rescue it?',
  grader: {
    type: 'llm-judge',
    rubric: [
      { name: 'Diagnosis', description: 'Names heat/speed causes', weight: 0.5 },
      { name: 'Rescue', description: 'Workable rescue method', weight: 0.5 },
    ],
  },
  judgingNotes: 'The rescue must not re-break the sauce.',
  referenceAnswer: 'Fresh yolk + warm water, whisk the broken sauce in drop by drop.',
  public: true,
};

describe('judge-v2 deduction parsing', () => {
  it('zero findings = 100', () => {
    const v = parseJudgeResponse(question, '{"findings": [], "summary": "Matches the reference."}');
    expect(v.score).toBe(100);
    expect(v.findings).toEqual([]);
  });

  it('maps severities to deductions in code (critical 40, major 15, minor 5)', () => {
    const v = parseJudgeResponse(
      question,
      JSON.stringify({
        findings: [
          { quote: 'high heat', issue: 'would re-break the emulsion', severity: 'critical' },
          { quote: 'omission', issue: 'no diagnosis of cause', severity: 'major' },
          { quote: 'a splash', issue: 'vague quantity', severity: 'minor' },
        ],
        summary: 'Bad rescue.',
      }),
    );
    expect(v.score).toBe(100 - 40 - 15 - 5);
  });

  it('floors the score at 0', () => {
    const findings = Array.from({ length: 4 }, () => ({
      quote: 'x',
      issue: 'y',
      severity: 'critical',
    }));
    const v = parseJudgeResponse(question, JSON.stringify({ findings, summary: '' }));
    expect(v.score).toBe(0);
  });

  it('rejects invalid severities', () => {
    expect(() =>
      parseJudgeResponse(
        question,
        '{"findings": [{"quote": "x", "issue": "y", "severity": "catastrophic"}]}',
      ),
    ).toThrow(/invalid severity/);
  });

  it('rejects JSON without findings[]', () => {
    expect(() => parseJudgeResponse(question, '{"scores": {"Diagnosis": 5}}')).toThrow(
      /missing findings/,
    );
  });

  it('extracts JSON wrapped in prose', () => {
    const v = parseJudgeResponse(
      question,
      'Here is my verdict:\n{"findings": [{"quote": "omission", "issue": "no rescue given", "severity": "major"}], "summary": "ok"}\nDone.',
    );
    expect(v.score).toBe(85);
  });
});

describe('judge-v2 prompt assembly', () => {
  it('prefers judgingNotes as attention hints', () => {
    const messages = buildJudgeMessages(question, 'Whisk in warm water.');
    const user = messages[1]!.content;
    expect(user).toContain('PAY PARTICULAR ATTENTION TO');
    expect(user).toContain('must not re-break');
  });

  it('falls back to rubric descriptions when judgingNotes is absent', () => {
    const noNotes = { ...question, judgingNotes: undefined };
    const user = buildJudgeMessages(noNotes, 'Whisk.')[1]!.content;
    expect(user).toContain('Diagnosis: Names heat/speed causes');
  });

  it('anonymizes model self-identification', () => {
    expect(anonymizeAnswer('As ChatGPT, I suggest whisking.')).not.toMatch(/chatgpt/i);
  });
});

describe('panel seat assignment', () => {
  const PANEL = ['anthropic/claude-opus-4.8', 'qwen/qwen3.5-plus-20260420', 'openai/gpt-5.5'];

  it('never lets a judge score its own provider', () => {
    expect(panelSeats(PANEL, 'anthropic/claude-fable-5', 'tech-001')).toEqual([
      'qwen/qwen3.5-plus-20260420',
      'openai/gpt-5.5',
    ]);
    expect(panelSeats(PANEL, 'openai/gpt-5.4-mini', 'tech-001')).toEqual([
      'anthropic/claude-opus-4.8',
      'qwen/qwen3.5-plus-20260420',
    ]);
    expect(panelSeats(PANEL, 'qwen/qwen3.5-plus-20260420', 'tech-001')).toEqual([
      'anthropic/claude-opus-4.8',
      'openai/gpt-5.5',
    ]);
  });

  it('rotates the dropped seat deterministically for non-conflicted candidates', () => {
    const a = panelSeats(PANEL, 'moonshotai/kimi-k2.6', 'tech-001');
    const b = panelSeats(PANEL, 'moonshotai/kimi-k2.6', 'tech-001');
    expect(a).toEqual(b); // reproducible
    expect(a).toHaveLength(2);
    // across many questions, all three judges get seat time
    const used = new Set<string>();
    for (let i = 0; i < 30; i++) {
      for (const seat of panelSeats(PANEL, 'moonshotai/kimi-k2.6', `q-${i}`)) used.add(seat);
    }
    expect(used.size).toBe(3);
  });
});
