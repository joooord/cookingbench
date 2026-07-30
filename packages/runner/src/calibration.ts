import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Question } from '@cookingbench/core';
import { DATA_DIR } from './dataset.js';
import { resolveRunDir } from './firewall.js';
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

export interface JudgeCalibration {
  judgeModel: string;
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

export interface CalibrationResult {
  /** Panel label or single judge id. */
  judgeModel: string;
  judgePanel?: string[];
  judgePromptVersion: string;
  atIso: string;
  /** What this calibration pass cost across every seat and anchor. */
  costUsd?: number;
  /** Worst per-judge MAE. */
  mae: number;
  passed: boolean;
  judges: JudgeCalibration[];
}

export function loadAnchors(): CalibrationAnchor[] {
  return parse(readFileSync(ANCHORS_PATH, 'utf8')) as CalibrationAnchor[];
}

function calibrationPath(runId: string): string {
  return join(resolveRunDir(runId, { write: true }), 'calibration.json');
}

export function readCalibration(runId: string): CalibrationResult | null {
  const path = calibrationPath(runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as CalibrationResult;
}

async function calibrateOne(
  client: CompletionClient,
  judgeModel: string,
  anchors: CalibrationAnchor[],
  questionsById: Map<string, Question>,
  spend: { costUsd: number },
): Promise<JudgeCalibration> {
  const results: JudgeCalibration['anchors'] = [];
  for (const anchor of anchors) {
    const question = questionsById.get(anchor.questionId);
    if (!question) throw new Error(`Calibration anchor references unknown question ${anchor.questionId}`);
    const verdict = await judgeAnswer(client, judgeModel, question, anchor.answerText, spend);
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
  return {
    judgeModel,
    mae: Math.round(mae * 10) / 10,
    passed: mae <= MAE_LIMIT && results.every((r) => r.pass),
    anchors: results,
  };
}

/**
 * The judge gate (README Phase 3): before any paid judging, EVERY panel seat
 * must independently reproduce the hand-scored anchors within tolerance.
 * Catches a drifted judge model, a broken prompt, or a severity scheme that
 * stopped biting.
 */
export async function runCalibration(
  client: CompletionClient,
  judgeLabel: string,
  judgePanel: string[],
  judgePromptVersion: string,
  runId: string,
  questionsById: Map<string, Question>,
): Promise<CalibrationResult> {
  const anchors = loadAnchors();
  // Anchors x seats x two calls each — real money, and previously unrecorded.
  const spend = { costUsd: 0 };
  const judges: JudgeCalibration[] = [];
  for (const judgeModel of judgePanel) {
    judges.push(await calibrateOne(client, judgeModel, anchors, questionsById, spend));
  }
  const result: CalibrationResult = {
    judgeModel: judgeLabel,
    judgePanel,
    judgePromptVersion,
    atIso: new Date().toISOString(),
    mae: Math.max(...judges.map((j) => j.mae)),
    passed: judges.every((j) => j.passed),
    costUsd: Math.round(spend.costUsd * 10000) / 10000,
    judges,
  };
  writeFileSync(calibrationPath(runId), JSON.stringify(result, null, 2));
  return result;
}
