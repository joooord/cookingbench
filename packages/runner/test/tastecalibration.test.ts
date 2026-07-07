import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { CompletionClient, CompletionResult } from '../src/openrouter.js';
import { loadQuestions, RUNS_DIR } from '../src/dataset.js';
import { loadTasteAnchors, runTasteCalibration } from '../src/tastecalibration.js';

const questionsById = new Map(loadQuestions().map((q) => [q.id, q]));
const anchors = loadTasteAnchors();
const goodTexts = new Set(anchors.map((a) => a.good.trim()));
const PANEL = ['j/one', 'j/two'];
const RUN_ID = 'mock-taste-cal-test';

function extractAnswers(content: string): { a: string; b: string } {
  const aTag = 'ANSWER A:\n';
  const bTag = 'ANSWER B:\n';
  const ai = content.indexOf(aTag);
  const bi = content.indexOf(bTag);
  return {
    a: content.slice(ai + aTag.length, bi).trim(),
    b: content.slice(bi + bTag.length).trim(),
  };
}

function result(text: string): CompletionResult {
  return { text, raw: {}, tokensIn: 1, tokensOut: 1, costUsd: 0, latencyMs: 1, finishReason: 'stop' };
}

/** Always votes for whichever answer sits in position A — pure position bias. */
const positionBiasedClient: CompletionClient = {
  async complete() {
    return result('{"winner":"a","reason":"first"}');
  },
};

/** Picks the answer whose text is the anchor's `good` one, regardless of position. */
const goodPreferringClient: CompletionClient = {
  async complete(_model, messages) {
    const { a, b } = extractAnswers(messages[1]!.content);
    const winner = goodTexts.has(a) ? 'a' : goodTexts.has(b) ? 'b' : 'tie';
    return result(`{"winner":"${winner}","reason":"better"}`);
  },
};

afterAll(() => {
  rmSync(join(RUNS_DIR, RUN_ID), { recursive: true, force: true });
});

describe('taste calibration gate', () => {
  it('fails a position-biased judge', async () => {
    const res = await runTasteCalibration(positionBiasedClient, PANEL, RUN_ID, questionsById);
    expect(res.passed).toBe(false);
    // It votes A in both orders, so on non-tie anchors the reversed order is wrong.
    expect(res.judges.every((j) => j.anchors.some((a) => !a.pass))).toBe(true);
  });

  it('passes a judge that consistently prefers the good answer', async () => {
    const res = await runTasteCalibration(goodPreferringClient, PANEL, RUN_ID, questionsById);
    expect(res.passed).toBe(true);
    for (const judge of res.judges) expect(judge.anchors.every((a) => a.pass)).toBe(true);
  });
});
