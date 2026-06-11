import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Question } from '@cookingbench/core';
import { DATA_DIR, RUNS_DIR } from './dataset.js';
import { judgeAnswer } from './judge.js';
import type { CompletionClient } from './openrouter.js';

const ANCHORS_PATH = join(DATA_DIR, 'calibration', 'anchors.yaml');
const MAE_LIMIT = 10;
const DEFAULT_TOLERANCE = 20;

export interface CalibrationAnchor {
  questionId: string;
  note?: string;
  expectedScore: number;
  toleranceAbs?: number;
  answerText: string;
}

export interface CalibrationResult {
  judgeModel: string;
  judgePromptVersion: string;
  atIso: string;
  mae: number;
  passed: boolean;
  anchors: Array<{
    questionId: string;
    note?: string;
    expected: number;
    got: number;
    pass: boolean;
  }>;
}

export function loadAnchors(): CalibrationAnchor[] {
  return parse(readFileSync(ANCHORS_PATH, 'utf8')) as CalibrationAnchor[];
}

function calibrationPath(runId: string): string {
  return join(RUNS_DIR, runId, 'calibration.json');
}

export function readCalibration(runId: string): CalibrationResult | null {
  const path = calibrationPath(runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationResult;
}

/**
 * The judge gate (README Phase 3): before any paid judging, the judge must
 * reproduce 12 hand-scored anchor answers within tolerance. Catches a drifted
 * judge model, a broken prompt, or a severity scheme that stopped biting.
 */
export async function runCalibration(
  client: CompletionClient,
  judgeModel: string,
  judgePromptVersion: string,
  runId: string,
  questionsById: Map<string, Question>,
): Promise<CalibrationResult> {
  const anchors = loadAnchors();
  const results: CalibrationResult['anchors'] = [];
  for (const anchor of anchors) {
    const question = questionsById.get(anchor.questionId);
    if (!question) throw new Error(`Calibration anchor references unknown question ${anchor.questionId}`);
    const verdict = await judgeAnswer(client, judgeModel, question, anchor.answerText);
    const tolerance = anchor.toleranceAbs ?? DEFAULT_TOLERANCE;
    results.push({
      questionId: anchor.questionId,
      note: anchor.note,
      expected: anchor.expectedScore,
      got: Math.round(verdict.score * 10) / 10,
      pass: Math.abs(verdict.score - anchor.expectedScore) <= tolerance,
    });
  }
  const mae =
    results.reduce((sum, r) => sum + Math.abs(r.got - r.expected), 0) / Math.max(results.length, 1);
  const result: CalibrationResult = {
    judgeModel,
    judgePromptVersion,
    atIso: new Date().toISOString(),
    mae: Math.round(mae * 10) / 10,
    passed: mae <= MAE_LIMIT && results.every((r) => r.pass),
    anchors: results,
  };
  writeFileSync(calibrationPath(runId), JSON.stringify(result, null, 2));
  return result;
}
