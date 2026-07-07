import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Question } from '@cookingbench/core';
import { DATA_DIR, RUNS_DIR } from './dataset.js';
import type { CompletionClient } from './openrouter.js';
import { buildTasteJudgeMessages, parseTasteJudgeVerdict, TASTE_JUDGE_PROMPT_VERSION } from './tastejudge.js';

const ANCHORS_PATH = join(DATA_DIR, 'calibration', 'taste-anchors.yaml');

export interface TasteAnchor {
  questionId: string;
  note?: string;
  /** A clearly sound answer. */
  good: string;
  /** A plausible-looking but clearly worse answer (unsafe, off-brief, incoherent). */
  bad: string;
  /** When the pair is deliberately close, a tie is an acceptable verdict. */
  allowTie?: boolean;
}

export interface TasteAnchorResult {
  questionId: string;
  note?: string;
  /** Forward verdict (good as A) and reversed verdict (good as B), mapped raw. */
  forward: string;
  reversed: string;
  pass: boolean;
}

export interface TasteJudgeCalibration {
  judgeModel: string;
  passed: boolean;
  anchors: TasteAnchorResult[];
}

export interface TasteCalibrationResult {
  panel: string[];
  promptVersion: string;
  atIso: string;
  passed: boolean;
  judges: TasteJudgeCalibration[];
}

export function loadTasteAnchors(): TasteAnchor[] {
  return parse(readFileSync(ANCHORS_PATH, 'utf8')) as TasteAnchor[];
}

function calibrationPath(runId: string): string {
  return join(RUNS_DIR, runId, 'taste-panel', 'calibration.json');
}

export function readTasteCalibration(runId: string): TasteCalibrationResult | null {
  const path = calibrationPath(runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8')) as TasteCalibrationResult;
}

async function judgeOnce(
  client: CompletionClient,
  judgeModel: string,
  question: Question,
  first: string,
  second: string,
): Promise<'a' | 'b' | 'tie'> {
  const messages = buildTasteJudgeMessages(question, first, second);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await client.complete(judgeModel, messages, {
      temperature: 0,
      maxTokens: 800 * (attempt + 1),
      reasoning: { effort: 'low' },
    });
    try {
      return parseTasteJudgeVerdict(result.text).winner;
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error(`Taste judge ${judgeModel} failed calibration on ${question.id}`);
}

async function calibrateOne(
  client: CompletionClient,
  judgeModel: string,
  anchors: TasteAnchor[],
  questionsById: Map<string, Question>,
): Promise<TasteJudgeCalibration> {
  const results: TasteAnchorResult[] = [];
  for (const anchor of anchors) {
    const question = questionsById.get(anchor.questionId);
    if (!question) throw new Error(`Taste anchor references unknown question ${anchor.questionId}`);
    // good is A in the forward call and B in the reversed call.
    const forward = await judgeOnce(client, judgeModel, question, anchor.good, anchor.bad);
    const reversed = await judgeOnce(client, judgeModel, question, anchor.bad, anchor.good);
    // The seat must prefer `good` in BOTH orders (forward → 'a', reversed → 'b').
    // A close, allowTie anchor also accepts a tie in either order.
    const okForward = forward === 'a' || (anchor.allowTie && forward === 'tie');
    const okReversed = reversed === 'b' || (anchor.allowTie && reversed === 'tie');
    results.push({
      questionId: anchor.questionId,
      note: anchor.note,
      forward,
      reversed,
      pass: Boolean(okForward && okReversed),
    });
  }
  return { judgeModel, passed: results.every((r) => r.pass), anchors: results };
}

/**
 * The taste-panel gate: before any paid taste judging, every seat must prefer
 * the good answer over the plainly-worse one in BOTH positions on every anchor.
 * Catches a position-biased, verbosity-biased or safety-blind taste judge for $0
 * of contender spend.
 */
export async function runTasteCalibration(
  client: CompletionClient,
  panel: string[],
  runId: string,
  questionsById: Map<string, Question>,
): Promise<TasteCalibrationResult> {
  const anchors = loadTasteAnchors();
  const judges: TasteJudgeCalibration[] = [];
  for (const judgeModel of panel) {
    judges.push(await calibrateOne(client, judgeModel, anchors, questionsById));
  }
  const result: TasteCalibrationResult = {
    panel,
    promptVersion: TASTE_JUDGE_PROMPT_VERSION,
    atIso: new Date().toISOString(),
    passed: judges.every((j) => j.passed),
    judges,
  };
  mkdirSync(join(RUNS_DIR, runId, 'taste-panel'), { recursive: true });
  writeFileSync(calibrationPath(runId), JSON.stringify(result, null, 2));
  return result;
}
