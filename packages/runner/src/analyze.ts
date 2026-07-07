import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Question, Score, StoredResponse } from '@cookingbench/core';
import { RUNS_DIR } from './dataset.js';

export interface QuestionAnalysis {
  questionId: string;
  category: string;
  difficulty: number;
  graderType: string;
  models: number;
  mean: number;
  sd: number;
  min: number;
  max: number;
  /** Every model scored 100 — the item contributes nothing to ranking. */
  allPerfect: boolean;
  /** mean(top half of models by overall) − mean(bottom half) on this item. */
  discrimination: number;
  /** Responses with empty text or a non-stop finish reason (transport noise). */
  anomalies: number;
  verdict: 'retire-candidate' | 'basics-candidate' | 'grader-audit' | 'keep';
}

export interface AnalyzeOptions {
  /**
   * The run's judge prompt version. Under judge-v2 (deduction grading) an
   * all-perfect llm-judge item IS genuine saturation and gets demoted; under
   * v1 (absolute rubric) it is not treated as evidence.
   */
  judgePromptVersion?: string;
}

export interface RunAnalysis {
  runId: string;
  generatedAt: string;
  models: number;
  questions: number;
  allPerfect: number;
  saturated: number;
  questionsAnalyzed: QuestionAnalysis[];
}

function finishReason(r: StoredResponse): string | undefined {
  const raw = r.raw as { choices?: Array<{ finish_reason?: string }> } | undefined;
  return raw?.choices?.[0]?.finish_reason;
}

/**
 * Item analysis over a finished run: saturation, discrimination and transport
 * anomalies per question. This is the de-saturation ratchet — items flagged
 * `basics-candidate` should be demoted out of the active set for the next
 * methodology version.
 */
export function analyzeRun(
  runId: string,
  questions: Question[],
  responses: StoredResponse[],
  scores: Score[],
  opts: AnalyzeOptions = {},
): RunAnalysis {
  const judgeV2 = opts.judgePromptVersion === 'judge-v2';
  const questionsById = new Map(questions.map((q) => [q.id, q]));

  // Model ranking by mean score, for the discrimination split.
  const byModel = new Map<string, number[]>();
  for (const s of scores) {
    if (!byModel.has(s.modelId)) byModel.set(s.modelId, []);
    byModel.get(s.modelId)!.push(s.score);
  }
  const ranked = [...byModel.entries()]
    .map(([m, v]) => [m, v.reduce((a, b) => a + b, 0) / v.length] as const)
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m);
  const topHalf = new Set(ranked.slice(0, Math.ceil(ranked.length / 2)));

  const byQuestion = new Map<string, Score[]>();
  for (const s of scores) {
    if (!byQuestion.has(s.questionId)) byQuestion.set(s.questionId, []);
    byQuestion.get(s.questionId)!.push(s);
  }
  const anomalousModels = new Map<string, Set<string>>();
  for (const r of responses) {
    const fr = finishReason(r);
    if (!r.answerText.trim() || (fr !== undefined && fr !== 'stop')) {
      if (!anomalousModels.has(r.questionId)) anomalousModels.set(r.questionId, new Set());
      anomalousModels.get(r.questionId)!.add(r.modelId);
    }
  }

  const items: QuestionAnalysis[] = [];
  for (const [questionId, qScores] of byQuestion) {
    const q = questionsById.get(questionId);
    if (!q) continue;
    const values = qScores.map((s) => s.score);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
    const anomalous = anomalousModels.get(questionId) ?? new Set<string>();
    const anomalies = anomalous.size;
    const allPerfect = values.every((v) => v === 100);
    // Spread caused purely by transport anomalies (empty/filtered/truncated
    // responses) is not skill signal — judge the item on the clean scores, and
    // exclude anomalous models from the discrimination split too, so a
    // reproducible content_filter can't manufacture negative discrimination.
    const cleanScores = qScores.filter((s) => !anomalous.has(s.modelId));
    const cleanValues = cleanScores.map((s) => s.score);
    const cleanPerfect = cleanValues.length > 0 && cleanValues.every((v) => v === 100);
    const top = cleanScores.filter((s) => topHalf.has(s.modelId)).map((s) => s.score);
    const bottom = cleanScores.filter((s) => !topHalf.has(s.modelId)).map((s) => s.score);
    const discrimination = Math.round((avg(top) - avg(bottom)) * 10) / 10;
    // Demote saturated items to basics. Deterministic items are demoted when
    // every clean score is 100; llm-judge items only under judge-v2 (deduction
    // grading), where all-perfect is genuine saturation rather than a v1 rubric
    // artifact. A deterministic item where weaker models beat stronger ones with
    // real spread is flagged `grader-audit` — usually a mis-keyed grader.
    let verdict: QuestionAnalysis['verdict'] = 'keep';
    if (cleanPerfect && (q.grader.type !== 'llm-judge' || judgeV2)) {
      verdict = 'basics-candidate';
    } else if (q.grader.type !== 'llm-judge' && discrimination <= -10 && sd >= 20) {
      verdict = 'grader-audit';
    }
    items.push({
      questionId,
      category: q.category,
      difficulty: q.difficulty,
      graderType: q.grader.type,
      models: values.length,
      mean: Math.round(mean * 10) / 10,
      sd: Math.round(sd * 10) / 10,
      min: Math.min(...values),
      max: Math.max(...values),
      allPerfect,
      discrimination,
      anomalies,
      verdict,
    });
  }
  items.sort((a, b) => a.sd - b.sd || a.questionId.localeCompare(b.questionId));

  return {
    runId,
    generatedAt: new Date().toISOString(),
    models: byModel.size,
    questions: items.length,
    allPerfect: items.filter((i) => i.allPerfect).length,
    saturated: items.filter((i) => i.mean >= 95 && i.sd <= 5).length,
    questionsAnalyzed: items,
  };
}

export function writeAnalysis(runId: string, analysis: RunAnalysis): void {
  writeFileSync(join(RUNS_DIR, runId, 'analysis.json'), JSON.stringify(analysis, null, 2));
}
