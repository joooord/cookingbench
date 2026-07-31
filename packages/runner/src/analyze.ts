import type { Question, Score, StoredResponse } from '@cookingbench/core';
// Relative rather than `@cookingbench/core` on purpose, for now: the package's
// `exports` map exposes only `.`, and `packages/core/src/index.ts` — which does
// not re-export stats.ts — belongs to another workstream. See
// docs/wp-0/INTEGRATION-NOTES.md; this becomes a package import in one line as
// soon as that file gains `export * from './stats.js';`.
import {
  clusterBootstrapMean,
  holmAdjust,
  practicalMarginIssues,
  rankFragility,
  separationClaim,
  smallestFlipSet,
  supportedTiers,
  StatsError,
  type AuditUnitScores,
  type FlipSet,
  type PracticalMargin,
  type RankFragilityResult,
  type SupportedTier,
} from '../../core/src/stats.js';
import { writeRunFileAtomic } from './firewall.js';

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
  /**
   * M4.4. The claim-bearing layer, one entry per scope.
   *
   * `separation` above is SCREENING: 91 uncorrected tests at α=0.05, on which
   * "48 of 91 pairs separate" is currently published. At that family size
   * roughly four or five of those would be expected from a roster of clones,
   * and the board's ordering comes out of exactly that pile. Nothing in
   * `separation` may be quoted as an ordering; `confirmatory` is what may.
   *
   * Absent when the confirmatory pass refused — see `refusals` inside each
   * entry, and note that a refusal is the intended outcome of missing scenario
   * families or a missing practical margin, not a bug to route around.
   */
  confirmatory?: ConfirmatoryAnalysis[];
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

/* -------------------------------------------------------------------------- */
/* M4.4 — the confirmatory layer                                              */
/* -------------------------------------------------------------------------- */

export interface ConfirmatoryPair {
  /** The model ahead on the point estimate. */
  a: string;
  b: string;
  /** Mean per-item score difference, a − b. */
  gap: number;
  /** One-sided cluster-bootstrap p-value for H0: gap ≤ 0. Floors at 1/(reps+1). */
  pValue: number;
  /** Holm-adjusted within the declared family; null when outside it. */
  pAdjusted: number | null;
  /** Adjusted p ≤ α. The ONLY field a report may read as an ordering. */
  ordered: boolean;
  /** Per-comparison (unadjusted) percentile interval on the gap. */
  ciLower: number;
  ciUpper: number;
  clusters: number;
  items: number;
  /** Sanctioned wording. Never contains "proven" — see separationClaim. */
  claim: string;
}

export interface SoleWinnerComparison {
  b: string;
  /** Lower end of the multiplicity-adjusted (Bonferroni α/m) interval. */
  lowerBound: number;
  alphaAdjusted: number;
  clearsZero: boolean;
  clearsMargin: boolean;
  holmRejected: boolean;
}

export interface SoleWinnerCheck {
  /** Null unless every requirement below was met. */
  model: string | null;
  /** Why not, in the order the requirements are checked. */
  refusals: string[];
  /** The preregistered margin actually used, or null if none was supplied. */
  margin: number | null;
  comparisons: SoleWinnerComparison[];
}

export interface ConfirmatoryAnalysis {
  scope: 'active' | 'frontier';
  /**
   * `scenario-family` only when EVERY item in scope declares one. Anything less
   * falls back to an item bootstrap, which treats variants of one scenario as
   * independent evidence and is therefore not claim-bearing.
   */
  clustering: 'scenario-family' | 'item-unclustered';
  clusterCoverage: { items: number; itemsWithFamily: number; families: number };
  /** Repeated candidate generations, which travel with their item's cluster. */
  repeats: { scoreRows: number; itemsWithRepeats: number };
  alpha: number;
  /** Number of comparisons Holm corrected over. */
  familySize: number;
  /** False means the family defaulted to the full matrix, conservatively. */
  familyDeclared: boolean;
  pairs: ConfirmatoryPair[];
  /** 1 + the number of models ordered above this one, over the FULL matrix. */
  places: Record<string, number>;
  tiers: SupportedTier[];
  tierSplits: string[];
  soleWinner: SoleWinnerCheck;
  /** Smallest audited deletion set that changes the leader, or null. */
  flip: FlipSet | null;
  flipUnit: 'scenario-family' | 'item';
  fragility: RankFragilityResult | null;
  refusals: string[];
}

export interface ConfirmatoryOptions {
  /**
   * M4.3's minimum practically meaningful difference. Absent means no
   * sole-winner claim is possible — deliberately, and it is absent today: no
   * margin has been preregistered for this benchmark, so the honest output is a
   * refusal rather than a number chosen after seeing the board.
   */
  practicalMargin?: PracticalMargin | null;
  /** Family-wise error rate. */
  alpha?: number;
  /** Resamples for the all-pairs p-values. */
  reps?: number;
  /**
   * Resamples for the leader family, where the interval is read at α/(n−1) and
   * needs enough draws below the adjusted quantile to be a real bound.
   */
  intervalReps?: number;
  /** Resamples for rank fragility. */
  fragilityReps?: number;
  /**
   * Named confirmatory comparisons, as [above, below] pairs. Absent corrects
   * over every pair — the conservative reading, chosen because an undeclared
   * family is not a smaller family, it is an unstated one.
   */
  confirmatoryFamily?: ReadonlyArray<readonly [string, string]>;
}

export interface AnalyzeOptions {
  confirmatory?: ConfirmatoryOptions;
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
    confirmatory: [
      confirmatoryAnalysis(questions, scores, 'active', opts.confirmatory ?? {}),
      confirmatoryAnalysis(questions, scores, 'frontier', opts.confirmatory ?? {}),
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

/* -------------------------------------------------------------------------- */
/* M4.4 — the confirmatory pass                                               */
/* -------------------------------------------------------------------------- */

interface ScopeMatrix {
  /** Models ranked by mean score, best first; ties broken by id. */
  models: string[];
  /** Items every model answered, sorted. */
  items: string[];
  /** model → item → mean score over that item's repeats. */
  mean: Map<string, Map<string, number>>;
  /** item → scenario family. Falls back to the item id when none is declared. */
  clusterOf: Map<string, string>;
  familyDeclared: boolean;
  itemsWithFamily: number;
  scoreRows: number;
  itemsWithRepeats: number;
}

/**
 * The scored matrix for one scope, with repeats folded into their item.
 *
 * Repeats are averaged per (model, item) rather than entered as separate rows.
 * A repeat is not extra evidence about the bank — it is extra evidence about
 * one item — and letting an item with three generations weigh three times as
 * much as its neighbours would rank models on how often they were resampled.
 * Folding them here also means a repeat can never be drawn apart from its item,
 * which is half of M4.4's "keep repeats together"; the other half is that the
 * item then travels with its scenario family.
 */
function buildScopeMatrix(
  questions: Question[],
  scores: Score[],
  scope: 'active' | 'frontier',
): ScopeMatrix {
  const wanted = new Map<string, Question>();
  for (const q of questions) {
    if (q.status === 'active' && (scope === 'active' || q.difficulty >= 4)) wanted.set(q.id, q);
  }
  const cells = new Map<string, Map<string, number[]>>();
  let scoreRows = 0;
  for (const s of scores) {
    if (!wanted.has(s.questionId)) continue;
    scoreRows += 1;
    let row = cells.get(s.modelId);
    if (!row) cells.set(s.modelId, (row = new Map()));
    let bucket = row.get(s.questionId);
    if (!bucket) row.set(s.questionId, (bucket = []));
    bucket.push(s.score);
  }
  // Same coverage rule pairwiseSeparation enforces: an item only counts when
  // every model answered it, so no gap can be an artefact of who was asked.
  const items = [...wanted.keys()]
    .filter((q) => cells.size > 0 && [...cells.values()].every((row) => row.has(q)))
    .sort();

  let itemsWithRepeats = 0;
  const mean = new Map<string, Map<string, number>>();
  for (const [modelId, row] of cells) {
    const byItem = new Map<string, number>();
    for (const item of items) {
      const values = row.get(item)!;
      if (values.length > 1) itemsWithRepeats += 1;
      byItem.set(item, values.reduce((a, b) => a + b, 0) / values.length);
    }
    mean.set(modelId, byItem);
  }

  const overall = (m: string) =>
    items.length === 0 ? 0 : items.reduce((a, q) => a + mean.get(m)!.get(q)!, 0) / items.length;
  const models = [...mean.keys()].sort((a, b) => overall(b) - overall(a) || a.localeCompare(b));

  const clusterOf = new Map<string, string>();
  let itemsWithFamily = 0;
  for (const item of items) {
    const family = wanted.get(item)!.classification?.scenarioFamily;
    if (typeof family === 'string' && family.length > 0) {
      itemsWithFamily += 1;
      clusterOf.set(item, family);
    } else {
      // The item stands as its own cluster so the machinery still runs, but
      // `familyDeclared` goes false and every claim downstream is refused.
      clusterOf.set(item, item);
    }
  }

  return {
    models,
    items,
    mean,
    clusterOf,
    familyDeclared: items.length > 0 && itemsWithFamily === items.length,
    itemsWithFamily,
    scoreRows,
    itemsWithRepeats,
  };
}

/**
 * The claim-bearing analysis: Holm-corrected orderings, supported tiers, the
 * sole-winner test against a preregistered margin, the smallest audited
 * deletion that flips the leader, and rank fragility.
 *
 * Every failure mode here resolves to a refusal recorded in `refusals`, never
 * to a thrown error and never to a permissive default. `bench analyze` runs
 * after every paid run and must not die because a roster is too small to
 * resolve a Bonferroni quantile — but neither may it quietly publish a bound it
 * could not compute.
 */
function confirmatoryAnalysis(
  questions: Question[],
  scores: Score[],
  scope: 'active' | 'frontier',
  opts: ConfirmatoryOptions,
): ConfirmatoryAnalysis {
  const alpha = opts.alpha ?? 0.05;
  const reps = opts.reps ?? 4000;
  const intervalReps = opts.intervalReps ?? 8000;
  const fragilityReps = opts.fragilityReps ?? 2000;
  const matrix = buildScopeMatrix(questions, scores, scope);
  const refusals: string[] = [];

  const marginIssues = practicalMarginIssues(opts.practicalMargin);
  const margin = marginIssues.length === 0 ? opts.practicalMargin!.points : null;
  if (margin === null) {
    refusals.push(`no sole-winner claim: ${marginIssues.join('; ')}`);
  }
  if (!matrix.familyDeclared) {
    refusals.push(
      `scenario families declared on ${matrix.itemsWithFamily}/${matrix.items.length} items in scope; ` +
        'the resample falls back to items, which treats variants of one scenario as independent evidence',
    );
  }

  const clusterCount = new Set(matrix.clusterOf.values()).size;
  const base: ConfirmatoryAnalysis = {
    scope,
    clustering: matrix.familyDeclared ? 'scenario-family' : 'item-unclustered',
    clusterCoverage: {
      items: matrix.items.length,
      itemsWithFamily: matrix.itemsWithFamily,
      families: clusterCount,
    },
    repeats: { scoreRows: matrix.scoreRows, itemsWithRepeats: matrix.itemsWithRepeats },
    alpha,
    familySize: 0,
    familyDeclared: opts.confirmatoryFamily !== undefined,
    pairs: [],
    places: {},
    tiers: [],
    tierSplits: [],
    soleWinner: { model: null, refusals: [...refusals], margin, comparisons: [] },
    flip: null,
    flipUnit: matrix.familyDeclared ? 'scenario-family' : 'item',
    fragility: null,
    refusals,
  };
  if (matrix.models.length < 2 || matrix.items.length === 0) {
    refusals.push(
      `nothing to compare in scope ${scope}: ${matrix.models.length} model(s), ${matrix.items.length} item(s)`,
    );
    base.soleWinner.refusals = [...refusals];
    return base;
  }

  const units = (a: string, b: string) =>
    matrix.items.map((item) => ({
      cluster: matrix.clusterOf.get(item)!,
      id: item,
      value: matrix.mean.get(a)!.get(item)! - matrix.mean.get(b)!.get(item)!,
    }));

  // ---- the all-pairs family, which the tiering is built from ---------------
  const declared = opts.confirmatoryFamily
    ? new Set(opts.confirmatoryFamily.map(([a, b]) => `${a}>${b}`))
    : null;
  const raw: Array<{ a: string; b: string; result: ReturnType<typeof clusterBootstrapMean> }> = [];
  for (let i = 0; i < matrix.models.length; i++) {
    for (let j = i + 1; j < matrix.models.length; j++) {
      const a = matrix.models[i]!;
      const b = matrix.models[j]!;
      try {
        raw.push({
          a,
          b,
          // Seeded per pair, exactly as pairwiseSeparation is and for the same
          // reason: a pair's verdict must not move when the roster grows.
          result: clusterBootstrapMean(units(a, b), {
            seed: `confirmatory:${scope}:${a}:${b}`,
            reps,
            alpha,
          }),
        });
      } catch (err) {
        refusals.push(`pair ${a} > ${b}: ${err instanceof StatsError ? err.message : String(err)}`);
      }
    }
  }
  if (raw.length === 0) {
    base.soleWinner.refusals = [...refusals];
    return base;
  }

  const inFamily = raw.filter((r) => declared === null || declared.has(`${r.a}>${r.b}`));
  const holm = new Map(
    holmAdjust(
      inFamily.map((r) => ({ key: `${r.a}>${r.b}`, p: r.result.pValue })),
      alpha,
    ).map((d) => [d.key, d]),
  );

  const pairs: ConfirmatoryPair[] = raw.map((r) => {
    const decision = holm.get(`${r.a}>${r.b}`);
    const ordered = decision?.rejected === true;
    return {
      a: r.a,
      b: r.b,
      gap: Math.round(r.result.mean * 100) / 100,
      pValue: r.result.pValue,
      pAdjusted: decision ? decision.pAdjusted : null,
      ordered,
      ciLower: Math.round(r.result.lower * 100) / 100,
      ciUpper: Math.round(r.result.upper * 100) / 100,
      clusters: r.result.clusters,
      items: r.result.units,
      claim: separationClaim(ordered ? 'multiplicity-adjusted' : 'unadjusted-screening'),
    };
  });
  base.familySize = holm.size;
  base.pairs = pairs;

  // ---- supported tiers over the full matrix -------------------------------
  try {
    const tiering = supportedTiers(
      matrix.models,
      pairs.map((p) => ({ a: p.a, b: p.b, ordered: p.ordered })),
    );
    base.tiers = tiering.tiers;
    base.tierSplits = tiering.splits;
    base.places = Object.fromEntries(tiering.places);
  } catch (err) {
    refusals.push(`tiering refused: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---- the sole-winner test ------------------------------------------------
  const leader = matrix.models[0]!;
  const challengers = matrix.models.slice(1);
  const soleRefusals = [...refusals];
  const comparisons: SoleWinnerComparison[] = [];
  // Bonferroni across the leader family, because Holm's step-down yields
  // adjusted p-values but no matching simultaneous interval. Single-step is
  // conservative and, unlike a Holm-shaped interval, actually valid.
  const alphaAdjusted = alpha / challengers.length;
  let intervalsUsable = true;
  const leaderTests: Array<{ key: string; p: number }> = [];
  for (const b of challengers) {
    try {
      const result = clusterBootstrapMean(units(leader, b), {
        seed: `confirmatory-winner:${scope}:${leader}:${b}`,
        reps: intervalReps,
        alpha: alphaAdjusted,
      });
      leaderTests.push({ key: b, p: result.pValue });
      comparisons.push({
        b,
        lowerBound: Math.round(result.lower * 1000) / 1000,
        alphaAdjusted,
        clearsZero: result.lower > 0,
        clearsMargin: margin !== null && result.lower > margin,
        holmRejected: false,
      });
    } catch (err) {
      intervalsUsable = false;
      soleRefusals.push(
        `sole-winner interval ${leader} vs ${b}: ${err instanceof StatsError ? err.message : String(err)}`,
      );
    }
  }
  if (intervalsUsable && comparisons.length === challengers.length) {
    const leaderHolm = new Map(holmAdjust(leaderTests, alpha).map((d) => [d.key, d]));
    for (const c of comparisons) c.holmRejected = leaderHolm.get(c.b)?.rejected === true;
    const topTier = base.tiers[0];
    if (!topTier || topTier.models.length !== 1 || topTier.models[0] !== leader) {
      soleRefusals.push(
        `no sole winner: the top supported tier holds ${topTier ? topTier.models.join(', ') : 'nothing'}`,
      );
    }
    const failed = comparisons.filter((c) => !c.holmRejected || !c.clearsMargin || !c.clearsZero);
    if (margin !== null && failed.length > 0) {
      soleRefusals.push(
        `no sole winner: ${failed.length} of ${comparisons.length} comparisons do not clear both zero and the ` +
          `${margin}-point margin after adjustment (${failed.map((f) => f.b).join(', ')})`,
      );
    }
    if (soleRefusals.length === 0) base.soleWinner.model = leader;
  }
  base.soleWinner.comparisons = comparisons;
  base.soleWinner.refusals = soleRefusals;

  // ---- influence and fragility --------------------------------------------
  // Audit units carry TOTALS, not means. Deleting a scenario family removes a
  // different number of items per family, but both models cover the same items,
  // so the denominators stay equal and "does the challenger lead now" is still
  // exactly the sign of the summed difference — which is what makes the greedy
  // deletion set provably minimal.
  const byUnit = new Map<string, Record<string, number>>();
  for (const item of matrix.items) {
    const unit = base.flipUnit === 'scenario-family' ? matrix.clusterOf.get(item)! : item;
    let row = byUnit.get(unit);
    if (!row) byUnit.set(unit, (row = Object.fromEntries(matrix.models.map((m) => [m, 0]))));
    for (const m of matrix.models) row[m] = (row[m] ?? 0) + matrix.mean.get(m)!.get(item)!;
  }
  const auditUnits: AuditUnitScores[] = [...byUnit.entries()]
    .sort((x, y) => x[0].localeCompare(y[0]))
    .map(([unit, scores2]) => ({ unit, scores: scores2 }));
  try {
    base.flip = smallestFlipSet(auditUnits);
  } catch (err) {
    refusals.push(`influence set refused: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    base.fragility = rankFragility(
      matrix.items.map((item) => ({
        unit: item,
        scores: Object.fromEntries(matrix.models.map((m) => [m, matrix.mean.get(m)!.get(item)!])),
      })),
      matrix.clusterOf,
      { reps: fragilityReps, seed: `fragility:${scope}` },
    );
  } catch (err) {
    refusals.push(`rank fragility refused: ${err instanceof Error ? err.message : String(err)}`);
  }

  return base;
}

/**
 * Competition place per model on the SCREENING evidence: one plus the number of
 * models the uncorrected paired bootstrap put above it.
 *
 * This is not a confirmatory ordering and its output must not be described as
 * one — the phrase M4.4 bans for an unadjusted 95% result is "proven better",
 * and it used to be in this comment. Ninety-one uncorrected tests at α=0.05
 * expect four or five false orderings from a roster of clones, and this
 * function will happily award places off them. `RunAnalysis.confirmatory`
 * carries the Holm-adjusted places; prefer them everywhere.
 *
 * Kept because the site and the CLI read it, and because the one thing it does
 * get right is worth keeping: places come from the full pair matrix, not a
 * chain of adjacent verdicts — see pairwiseSeparation for why chaining is
 * wrong.
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

/**
 * Printable confirmatory summary for `bench analyze`.
 *
 * Lives here rather than in cli.ts so that the wording is testable: the CLI's
 * existing separation block prints "separated"/"tied" off uncorrected
 * p-values, which is the presentation M4.4 rules out. Every line this returns
 * is passed through `assertClaimLanguage` by the accompanying test.
 */
export function formatConfirmatory(analysis: RunAnalysis, scope: 'active' | 'frontier'): string[] {
  const c = analysis.confirmatory?.find((x) => x.scope === scope);
  if (!c) return [`No confirmatory analysis for scope ${scope}.`];
  const lines: string[] = [];
  lines.push(
    `\nConfirmatory analysis — ${scope}: cluster bootstrap by ${c.clustering}, ` +
      `${c.clusterCoverage.families} cluster(s) over ${c.clusterCoverage.items} item(s), ` +
      `Holm across ${c.familySize} comparison(s) at alpha ${c.alpha}.`,
  );
  const ordered = c.pairs.filter((p) => p.ordered).length;
  lines.push(
    `  ${ordered}/${c.pairs.length} pairs ordered after adjustment ` +
      `(the uncorrected screening column in \`separation\` orders more; it is not a result).`,
  );
  for (const tier of c.tiers) {
    lines.push(`  tier ${tier.tier} (place ${tier.place}): ${tier.models.join(', ')}`);
  }
  for (const split of c.tierSplits) lines.push(`  ! ${split}`);
  lines.push(
    c.soleWinner.model
      ? `  sole winner: ${c.soleWinner.model} — ${separationClaim('adjusted-and-practical')}`
      : `  no sole winner. ${c.soleWinner.refusals.join(' | ') || 'reason not recorded'}`,
  );
  if (c.flip) {
    lines.push(
      `  influence: deleting ${c.flip.size} audited ${c.flipUnit} unit(s) ` +
        `(${(c.flip.share * 100).toFixed(1)}% of the evidence) puts ${c.flip.challenger} ahead of ` +
        `${c.flip.leader}: ${c.flip.units.join(', ')}`,
    );
  } else {
    lines.push('  influence: no proper subset of the audited units changes the leader.');
  }
  if (c.fragility) {
    lines.push(
      `  rank fragility over ${c.fragility.reps} clustered resamples — top-group stability ` +
        `${(c.fragility.topGroupStability * 100).toFixed(1)}% (M4.5 target 90%):`,
    );
    for (const m of c.fragility.models) {
      lines.push(
        `    ${m.modelId.padEnd(30)} place ${m.publishedPlace} held ${(m.pHoldsPlace * 100).toFixed(1)}% ` +
          `range ${m.placeRange[0]}–${m.placeRange[1]}  top ${(m.pTopByPoints * 100).toFixed(1)}%`,
      );
    }
  }
  for (const r of c.refusals) lines.push(`  refused: ${r}`);
  return lines;
}

export function writeAnalysis(runId: string, analysis: RunAnalysis): void {
  // Firewall-resolved: analysis.json feeds the site (apps/web reads it for the
  // separation table), so a mistargeted run id here is a publish route.
  //
  // `join(resolveRunDir(...), 'analysis.json')` guarded the DIRECTORY and then
  // let `writeFileSync` follow the leaf. Probed: with `analysis.json` linked to
  // a file outside the repository, the write succeeded and overwrote it. Every
  // other writer in this codebase already goes through `writeRunFileAtomic`,
  // which resolves the leaf and stages-then-renames so the entry is REPLACED
  // rather than followed; this one did not, which is why DATA-001 was recorded
  // as closed while a write route out of the runs root was still open.
  writeRunFileAtomic(runId, 'analysis.json', JSON.stringify(analysis, null, 2));
}
