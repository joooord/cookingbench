import type { Question } from '@cookingbench/core';
import type { ChatMessage, CompletionClient, CompletionResult } from './openrouter.js';

/**
 * Mock personas exercise the whole pipeline for $0 with known-quality answers,
 * so the leaderboard math can be verified end-to-end before any API spend.
 */
export const MOCK_MODELS = [
  { id: 'mock/perfect-chef', displayName: 'Mock Perfect Chef', provider: 'Mock', active: true },
  { id: 'mock/decent-cook', displayName: 'Mock Decent Cook', provider: 'Mock', active: true },
  { id: 'mock/sloppy-intern', displayName: 'Mock Sloppy Intern', provider: 'Mock', active: true },
] as const;

export type MockModelId = (typeof MOCK_MODELS)[number]['id'];

function perfectAnswer(question: Question): string {
  // The reference answer always contains the expected values/keywords.
  return `Here is the answer.\nAnswer: ${question.referenceAnswer}`;
}

function corruptNumbers(text: string): string {
  // Corrupt every number (and vulgar fraction) so all tolerance checks fail.
  return text
    .replace(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g, (m) =>
      (Number(m.replace(/,/g, '')) * 1.3 + 1).toFixed(1),
    )
    .replace(/[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]/g, '9');
}

function sloppyAnswer(question: Question): string {
  if (question.grader.type === 'keyword' || question.grader.type === 'llm-judge') {
    return 'Just wing it — exact amounts and methods rarely matter much in cooking.';
  }
  return `Answer: ${corruptNumbers(question.referenceAnswer)}`;
}

function decentAnswer(question: Question): string {
  // Correct on easy questions, sloppy on the hard ones (difficulty 3+).
  return question.difficulty >= 3 ? sloppyAnswer(question) : perfectAnswer(question);
}

export class MockClient implements CompletionClient {
  constructor(private readonly questionsById: Map<string, Question>) {}

  async complete(
    modelId: string,
    messages: ChatMessage[],
    _opts: { temperature: number; maxTokens: number },
  ): Promise<CompletionResult> {
    const prompt = messages.find((m) => m.role === 'user')?.content ?? '';
    const question = [...this.questionsById.values()].find((q) => q.prompt === prompt);
    if (!question) throw new Error('MockClient: no question matches the prompt');
    const text =
      modelId === 'mock/perfect-chef'
        ? perfectAnswer(question)
        : modelId === 'mock/decent-cook'
          ? decentAnswer(question)
          : sloppyAnswer(question);
    return {
      text,
      raw: { mock: true, modelId },
      tokensIn: Math.ceil(prompt.length / 4),
      tokensOut: Math.ceil(text.length / 4),
      costUsd: 0,
      latencyMs: 1,
      finishReason: 'stop',
    };
  }
}

/** Deterministic mock judge scores per persona, exercising the blend math. */
export function mockJudgeScore(modelId: string, question: Question): number {
  if (modelId === 'mock/perfect-chef') return 95;
  if (modelId === 'mock/decent-cook') return question.difficulty >= 3 ? 40 : 80;
  return 20;
}
