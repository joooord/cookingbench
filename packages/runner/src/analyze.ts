import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Question, Score, StoredResponse } from '@cookingbench/core';
import { RUNS_DIR } from './dataset.js';

export interface QuestionAnalysis {
  questionId: string;
  category: string;
  /** active | basics | retired — the ratchet only acts on active items. */
  status: string;
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
  /**
   * This item's share of the total between-model variance across active items.
   * A handful of items carrying most of the ranking is fragile: in 2026-06-v2
   * the top ten held 54% of it, so ten authoring mistakes could have moved the
   * board more than the other ninety-two items combined.
   */
  varianceShare?: number;
  /**
   * Set when most of the roster lands outside the expected answer on a numeric
   * item. When two-thirds of frontier models agree with each other and disagree
   * with the reference, the reference is the more likely error — nutr-036 marks
   * 10 of 13 wrong on a calorie estimate they all cluster around. Review the
   * reference before marking the models wrong.
   */
  referenceSuspect?: boolean;
  verdict: 'retire-candidate' | 'basics-candidate' | 'keep';
}

export interface RunAnalysis {
  runId: string;
  generatedAt: string;
  models: number;
  questions: number;
  /** All-perfect across every analysed item, active and basics together. */
  allPerfect: number;
  saturated: number;
  /** Active items only — the figures the de-saturation targets are set against. */
  activeQuestions: number;
  activeAllPerfect: number;
  activeSaturated: number;
  /**
   * Active items carrying any between-model signal at all (sd > 1). The gap
   * between this and activeQuestions is what the benchmark is paying for and
   * not using: 102 items behaving like about 57.
   */
  activeWithSignal: number;
  /**
   * How many equally-informative items the active set is worth, by the inverse
   * Herfindahl of variance shares. Robust to a long tail of near-dead items in
   * a way that a simple count is not — if one item carried everything this
   * would be 1, however many items were nominally active.
   */
  effectiveItems: number;
  /** Items whose reference answer most of the roster contradicts. */
  referenceSuspects: string[];
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
): RunAnalysis {
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
    if (!q || q.status === 'retired') continue;
    const values = qScores.map((s) => s.score);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
    const top = qScores.filter((s) => topHalf.has(s.modelId)).map((s) => s.score);
    const bottom = qScores.filter((s) => !topHalf.has(s.modelId)).map((s) => s.score);
    const avg = (v: number[]) => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0);
    const anomalous = anomalousModels.get(questionId) ?? new Set<string>();
    const anomalies = anomalous.size;
    const allPerfect = values.every((v) => v === 100);
    // Spread caused purely by transport anomalies (empty/filtered/truncated
    // responses) is not skill signal — judge the item on the clean scores.
    const cleanValues = qScores.filter((s) => !anomalous.has(s.modelId)).map((s) => s.score);
    const cleanPerfect = cleanValues.length > 0 && cleanValues.every((v) => v === 100);
    // llm-judge items are never demoted here: judge-v2 (deduction grading)
    // changes their scoring regime entirely, so v1 saturation is not evidence.
    // Only an ACTIVE item can be demoted to basics. Without this check the
    // ratchet recommended demoting items that were already basics — 82 of the
    // 115 basics-candidate verdicts in run 2026-06-v2 — and reported saturation
    // against a denominator of all 184 items rather than the 102 that count.
    const verdict: QuestionAnalysis['verdict'] =
      q.status === 'active' && q.grader.type !== 'llm-judge' && cleanPerfect
        ? 'basics-candidate'
        : 'keep';
    // Numeric items are pass/fail per model, so a near-unanimous zero means
    // either every model is wrong or the expected value is. With frontier
    // models clustering, the second is the better bet — flag it for review
    // rather than silently marking the roster wrong.
    const numericFamily = ['numeric', 'range', 'numeric-multi'].includes(q.grader.type);
    const zeroes = values.filter((v) => v === 0).length;
    const referenceSuspect =
      numericFamily && values.length >= 3 && zeroes / values.length >= 2 / 3;

    items.push({
      questionId,
      category: q.category,
      status: q.status,
      difficulty: q.difficulty,
      graderType: q.grader.type,
      models: values.length,
      mean: Math.round(mean * 10) / 10,
      sd: Math.round(sd * 10) / 10,
      min: Math.min(...values),
      max: Math.max(...values),
      allPerfect,
      discrimination: Math.round((avg(top) - avg(bottom)) * 10) / 10,
      anomalies,
      ...(referenceSuspect ? { referenceSuspect: true } : {}),
      verdict,
    });
  }
  // Variance shares over active items only — basics are excluded from the
  // ranking by design, so their saturation is not a defect.
  const activeItems = items.filter((i) => i.status === 'active');
  const totalVariance = activeItems.reduce((sum, i) => sum + i.sd * i.sd, 0);
  for (const item of activeItems) {
    item.varianceShare =
      totalVariance > 0 ? Math.round(((item.sd * item.sd) / totalVariance) * 1000) / 1000 : 0;
  }
  // Inverse Herfindahl: 1 / sum(share^2). Equal shares over n items gives n;
  // one item holding everything gives 1.
  const herfindahl = activeItems.reduce((sum, i) => sum + (i.varianceShare ?? 0) ** 2, 0);
  const effectiveItems = herfindahl > 0 ? Math.round(10 / herfindahl) / 10 : 0;

  items.sort((a, b) => a.sd - b.sd || a.questionId.localeCompare(b.questionId));

  return {
    runId,
    generatedAt: new Date().toISOString(),
    models: byModel.size,
    questions: items.length,
    allPerfect: items.filter((i) => i.allPerfect).length,
    saturated: items.filter((i) => i.mean >= 95 && i.sd <= 5).length,
    activeQuestions: items.filter((i) => i.status === 'active').length,
    activeAllPerfect: items.filter((i) => i.status === 'active' && i.allPerfect).length,
    activeSaturated: items.filter((i) => i.status === 'active' && i.mean >= 95 && i.sd <= 5).length,
    activeWithSignal: activeItems.filter((i) => i.sd > 1).length,
    effectiveItems,
    referenceSuspects: items.filter((i) => i.referenceSuspect).map((i) => i.questionId),
    questionsAnalyzed: items,
  };
}

export function writeAnalysis(runId: string, analysis: RunAnalysis): void {
  writeFileSync(join(RUNS_DIR, runId, 'analysis.json'), JSON.stringify(analysis, null, 2));
}
