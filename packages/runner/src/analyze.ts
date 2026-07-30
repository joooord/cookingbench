import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Question, Score, StoredResponse } from '@cookingbench/core';
import { resolveRunDir } from './firewall.js';

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
  /**
   * Which adjacent pairs on the leaderboard are actually separated, and which
   * are a coin flip dressed up as a ranking.
   *
   * The per-model CI on the board is a *marginal* interval, so two models can
   * look distinct while their intervals overlap heavily, or look tied while one
   * beats the other on nearly every item. Both readings are wrong for the same
   * reason: every model answers the same questions, so item difficulty is
   * shared and the comparison should be paired. Resampling the per-item score
   * *differences* removes that shared difficulty and is far more sensitive.
   *
   * In 2026-07-v2.1 this is the difference between publishing "GPT-5.6 Sol Pro
   * is the best cook" off a 0.01-point lead and reporting the truth: the top
   * three are inseparable (P≈0.52), and exactly one adjacent pair in a
   * fourteen-model table is genuinely apart.
   */
  separation: PairSeparation[];
  questionsAnalyzed: QuestionAnalysis[];
}

export interface PairSeparation {
  /** The higher-ranked model of the pair. */
  a: string;
  b: string;
  /** Which item set the comparison was run over. */
  scope: 'active' | 'frontier';
  /** Mean per-item score difference, a − b. */
  gap: number;
  /** Share of bootstrap resamples in which a still leads b. */
  pAhead: number;
  /** pAhead ≥ 0.95 — the pair is ordered, not tied. */
  separated: boolean;
  /** b sits immediately below a in the ranking. The readable CLI summary. */
  adjacent: boolean;
  items: number;
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
    // The signal is specifically that the *strong* models fail too. If only the
    // weaker half misses, the item is doing its job. Requiring the top half to
    // fail as well is what separates "hard" from "the expected value is wrong",
    // and it needs a real roster behind it — on a three-model set where two are
    // deliberately weak, "two thirds scored 0" means nothing at all.
    const topZeroes = qScores.filter((s) => topHalf.has(s.modelId) && s.score === 0).length;
    const topCount = qScores.filter((s) => topHalf.has(s.modelId)).length;
    const referenceSuspect =
      numericFamily &&
      values.length >= 6 &&
      zeroes / values.length >= 2 / 3 &&
      topCount > 0 &&
      topZeroes / topCount >= 2 / 3;

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
    separation: [
      ...pairwiseSeparation(questions, scores, 'active'),
      ...pairwiseSeparation(questions, scores, 'frontier'),
    ],
    questionsAnalyzed: items,
  };
}

/** Deterministic LCG — the CIs on the board are seeded for the same reason. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => ((state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** FNV-1a, as used for judge seat rotation. */
function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

const BOOTSTRAP_REPS = 4000;
const SEPARATION_SEED = 12345;

/**
 * Paired bootstrap over items for EVERY pair of models, not just adjacent ones.
 *
 * All pairs, because statistical non-separation is not transitive and treating
 * it as if it were produces nonsense. Chaining the adjacent verdicts in
 * 2026-07-v2.1 — each pair tied with the next — merges twelve of fourteen
 * models into one blob and awards Qwen 3.7 Max (90.7) a share of first place,
 * while the direct test has GPT-5.6 Sol Pro beating it at P=1.000. "A ties B"
 * and "B ties C" says nothing about A vs C. Ranking therefore has to ask about
 * A vs C directly, which means the full 91-pair matrix for a 14-model roster.
 *
 * `frontier` reruns it over difficulty ≥ 4 active items. That subset is small,
 * so it is not a substitute for the headline column — but it is a pre-declared
 * column of the methodology rather than a slice chosen after seeing results,
 * and it is where a saturated set still has room to discriminate: in
 * 2026-07-v2.1 the top three tie on all 102 active items while Grok 4.5
 * separates from three of the four models below it on the harder 35.
 */
function pairwiseSeparation(
  questions: Question[],
  scores: Score[],
  scope: 'active' | 'frontier',
): PairSeparation[] {
  const wanted = new Set(
    questions
      .filter((q) => q.status === 'active' && (scope === 'active' || q.difficulty >= 4))
      .map((q) => q.id),
  );
  const byModel = new Map<string, Map<string, number>>();
  for (const s of scores) {
    if (!wanted.has(s.questionId)) continue;
    let row = byModel.get(s.modelId);
    if (!row) byModel.set(s.modelId, (row = new Map()));
    row.set(s.questionId, s.score);
  }
  // Only items every model answered, so a gap can never be an artefact of one
  // model being averaged over a different set than its opponent.
  const items = [...wanted].filter((q) => [...byModel.values()].every((m) => m.has(q)));
  if (items.length === 0 || byModel.size < 2) return [];

  const mean = (m: string) => items.reduce((a, q) => a + byModel.get(m)!.get(q)!, 0) / items.length;
  const ranked = [...byModel.keys()].sort((a, b) => mean(b) - mean(a) || a.localeCompare(b));

  const out: PairSeparation[] = [];
  for (let i = 0; i < ranked.length; i++) {
    for (let j = i + 1; j < ranked.length; j++) {
      const a = ranked[i]!;
      const b = ranked[j]!;
      // Seeded per pair, not from one shared stream. With a shared stream every
      // pair's p-value depends on how many pairs were drawn before it, so
      // adding a model to the roster silently moves the verdict on unrelated
      // pairs — qwen>mistral read 0.951 as an adjacent-only comparison and
      // 0.937 once the full matrix was drawn ahead of it. Per-pair seeding
      // makes each verdict reproducible on its own terms.
      const rnd = seededRandom(hashSeed(`${SEPARATION_SEED}:${scope}:${a}:${b}`));
      const diffs = items.map((q) => byModel.get(a)!.get(q)! - byModel.get(b)!.get(q)!);
      let ahead = 0;
      for (let rep = 0; rep < BOOTSTRAP_REPS; rep++) {
        let sum = 0;
        for (let k = 0; k < diffs.length; k++) sum += diffs[(rnd() * diffs.length) | 0]!;
        if (sum > 0) ahead++;
      }
      const pAhead = ahead / BOOTSTRAP_REPS;
      out.push({
        a,
        b,
        scope,
        gap: Math.round((diffs.reduce((x, y) => x + y, 0) / diffs.length) * 100) / 100,
        pAhead: Math.round(pAhead * 1000) / 1000,
        separated: pAhead >= 0.95,
        adjacent: j === i + 1,
        items: items.length,
      });
    }
  }
  return out;
}

/**
 * Competition rank per model: one plus the number of models proven better.
 *
 * "Proven" means the paired bootstrap separated them, so models the data cannot
 * order share a place. Built from the full pair matrix rather than a chain of
 * adjacent verdicts — see pairwiseSeparation for why chaining is wrong.
 */
export function tiedRanks(separation: PairSeparation[], scope: 'active' | 'frontier'): Map<string, number> {
  const pairs = separation.filter((p) => p.scope === scope);
  const models = new Set(pairs.flatMap((p) => [p.a, p.b]));
  const ranks = new Map<string, number>();
  for (const m of models) {
    const better = pairs.filter((p) => p.b === m && p.separated).length;
    ranks.set(m, better + 1);
  }
  return ranks;
}

export function writeAnalysis(runId: string, analysis: RunAnalysis): void {
  // Firewall-resolved: analysis.json feeds the site (apps/web reads it for the
  // separation table), so a mistargeted run id here is a publish route.
  writeFileSync(join(resolveRunDir(runId, { write: true }), 'analysis.json'), JSON.stringify(analysis, null, 2));
}
