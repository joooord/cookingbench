import { CATEGORY_IDS, type CategoryId, type ModelEntry, type Question, type Score, type StoredResponse } from '@cookingbench/core';

export interface LeaderboardRow {
  modelId: string;
  displayName: string;
  provider: string;
  family?: string;
  /** v2: mean over status:active questions, 0–100. (v1 artifacts: mean of category means.) */
  overall: number;
  /** 95% bootstrap CI over active questions, [lo, hi]. */
  overallCi?: [number, number];
  /** Mean over status:basics questions — the saturation/regression gate, not a ranking signal. */
  basics?: number | null;
  /** Mean over difficulty ≥ 4 active questions — the frontier-separating signal. */
  frontier?: number | null;
  /** v1 column kept for old artifacts. */
  hardSet?: number | null;
  categories: Partial<Record<CategoryId, number>>;
  questionsGraded: number;
  /** Responses that stayed empty/filtered after retries — transport noise, scored 0 but surfaced. */
  incidents?: number;
  costUsd: number;
  /**
   * v3: 95% rank interval from the paired bootstrap — [bestRank, worstRank].
   * bestRank = 1 + (models significantly above this one), worstRank =
   * N − (models significantly below). Adjacent leaderboard rows with
   * overlapping rank intervals are statistically indistinguishable.
   */
  rankCi?: [number, number];
}

export interface LeaderboardReport {
  runId: string;
  generatedAt: string;
  /** Absent on pre-v2 artifacts — readers treat missing as 'v1'. */
  methodologyVersion?: string;
  rows: LeaderboardRow[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

/** Deterministic PRNG so published CIs are reproducible from the artifacts. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOOTSTRAP_RESAMPLES = 2000;

function percentileCi(sortedMeans: number[]): [number, number] {
  return [
    round1(sortedMeans[Math.floor(0.025 * sortedMeans.length)]!),
    round1(sortedMeans[Math.ceil(0.975 * sortedMeans.length) - 1]!),
  ];
}

export interface PairedBootstrapResult {
  /** Per-model 95% CI on the mean active score. */
  ci: Map<string, [number, number]>;
  /** Per-model 95% rank interval, [bestRank, worstRank]. */
  rankCi: Map<string, [number, number]>;
}

/**
 * Paired bootstrap over active questions: each resample draws one set of
 * question ids and scores *every* model on it. Question difficulty is shared
 * noise across models, so pairing is what makes model-vs-model differences —
 * and the rank intervals derived from them — meaningful at this dataset size
 * (Miller 2024, arXiv:2411.00640). Independent per-model resamples cannot say
 * whether 96.4 vs 95.1 is real; this can.
 *
 * Rank interval (MathArena-style, arXiv:2505.23281): model i significantly
 * trails j when j's resampled mean exceeds i's in ≥ 97.5% of replicates
 * (ties split). bestRank = 1 + #(significantly above), worstRank =
 * N − #(significantly below).
 */
export function pairedBootstrap(
  scoresByModel: Map<string, Map<string, number>>,
  questionIds: string[],
  seed = 42,
): PairedBootstrapResult {
  const models = [...scoresByModel.keys()];
  const ci = new Map<string, [number, number]>();
  const rankCi = new Map<string, [number, number]>();
  if (models.length === 0 || questionIds.length === 0) return { ci, rankCi };
  if (questionIds.length < 2) {
    for (const m of models) {
      const only = round1(scoresByModel.get(m)!.get(questionIds[0]!) ?? 0);
      ci.set(m, [only, only]);
      rankCi.set(m, [1, models.length]);
    }
    return { ci, rankCi };
  }

  const rand = mulberry32(seed);
  const replicateMeans = new Map<string, number[]>(models.map((m) => [m, []]));
  // wins.get(a).get(b) = replicates where a's resampled mean beat b's (ties ½).
  const wins = new Map<string, Map<string, number>>(
    models.map((m) => [m, new Map(models.map((o) => [o, 0]))]),
  );

  for (let i = 0; i < BOOTSTRAP_RESAMPLES; i++) {
    const sample: string[] = [];
    for (let j = 0; j < questionIds.length; j++) {
      sample.push(questionIds[Math.floor(rand() * questionIds.length)]!);
    }
    const meansThisReplicate = new Map<string, number>();
    for (const m of models) {
      const byQuestion = scoresByModel.get(m)!;
      let sum = 0;
      let n = 0;
      for (const qid of sample) {
        const s = byQuestion.get(qid);
        // A model can lack a score (e.g. an answer excluded as unjudged);
        // its mean is over the questions it does have, same as the headline.
        if (s !== undefined) {
          sum += s;
          n++;
        }
      }
      const value = n > 0 ? sum / n : 0;
      meansThisReplicate.set(m, value);
      replicateMeans.get(m)!.push(value);
    }
    for (let a = 0; a < models.length; a++) {
      for (let b = a + 1; b < models.length; b++) {
        const ma = meansThisReplicate.get(models[a]!)!;
        const mb = meansThisReplicate.get(models[b]!)!;
        const winA = ma > mb ? 1 : ma < mb ? 0 : 0.5;
        wins.get(models[a]!)!.set(models[b]!, wins.get(models[a]!)!.get(models[b]!)! + winA);
        wins.get(models[b]!)!.set(models[a]!, wins.get(models[b]!)!.get(models[a]!)! + (1 - winA));
      }
    }
  }

  for (const m of models) {
    const sorted = [...replicateMeans.get(m)!].sort((x, y) => x - y);
    ci.set(m, percentileCi(sorted));
    let above = 0;
    let below = 0;
    for (const other of models) {
      if (other === m) continue;
      const fractionOtherWins = wins.get(other)!.get(m)! / BOOTSTRAP_RESAMPLES;
      if (fractionOtherWins >= 0.975) above++;
      if (fractionOtherWins <= 0.025) below++;
    }
    rankCi.set(m, [above + 1, models.length - below]);
  }
  return { ci, rankCi };
}

export function buildLeaderboard(
  runId: string,
  models: Pick<ModelEntry, 'id' | 'displayName' | 'provider' | 'family'>[],
  questions: Question[],
  responses: StoredResponse[],
  scores: Score[],
  methodologyVersion = 'v2',
): LeaderboardReport {
  const questionsById = new Map(questions.map((q) => [q.id, q]));

  const costByModel = new Map<string, number>();
  const incidentsByModel = new Map<string, number>();
  for (const r of responses) {
    costByModel.set(r.modelId, (costByModel.get(r.modelId) ?? 0) + r.costUsd);
    if (r.transportFailure || !r.answerText.trim()) {
      incidentsByModel.set(r.modelId, (incidentsByModel.get(r.modelId) ?? 0) + 1);
    }
  }

  interface Buckets {
    active: number[];
    activeById: Map<string, number>;
    basics: number[];
    frontier: number[];
    perCategory: Map<CategoryId, number[]>;
  }
  const byModel = new Map<string, Buckets>();
  for (const s of scores) {
    const q = questionsById.get(s.questionId);
    if (!q || q.status === 'retired') continue;
    // Unjudged answers are missing data, not zeros — report.ts warns upstream.
    if ((s.detail as { judgePending?: boolean }).judgePending) continue;
    if (!byModel.has(s.modelId)) {
      byModel.set(s.modelId, {
        active: [],
        activeById: new Map(),
        basics: [],
        frontier: [],
        perCategory: new Map(),
      });
    }
    const buckets = byModel.get(s.modelId)!;
    if (q.status === 'basics') {
      buckets.basics.push(s.score);
      continue;
    }
    buckets.active.push(s.score);
    buckets.activeById.set(s.questionId, s.score);
    if (q.difficulty >= 4) buckets.frontier.push(s.score);
    if (!buckets.perCategory.has(q.category)) buckets.perCategory.set(q.category, []);
    buckets.perCategory.get(q.category)!.push(s.score);
  }

  // One shared set of resamples for every model — see pairedBootstrap.
  const activeQuestionIds = [
    ...new Set([...byModel.values()].flatMap((b) => [...b.activeById.keys()])),
  ].sort();
  const bootstrap = pairedBootstrap(
    new Map([...byModel.entries()].map(([m, b]) => [m, b.activeById])),
    activeQuestionIds,
  );

  const rows: LeaderboardRow[] = [];
  for (const [modelId, buckets] of byModel) {
    const meta = models.find((m) => m.id === modelId);
    const categories: Partial<Record<CategoryId, number>> = {};
    for (const category of CATEGORY_IDS) {
      const values = buckets.perCategory.get(category);
      if (values && values.length > 0) categories[category] = round1(mean(values));
    }
    rows.push({
      modelId,
      displayName: meta?.displayName ?? modelId,
      provider: meta?.provider ?? 'Unknown',
      family: meta?.family,
      overall: buckets.active.length > 0 ? round1(mean(buckets.active)) : 0,
      overallCi: buckets.active.length > 0 ? bootstrap.ci.get(modelId) : undefined,
      rankCi: buckets.active.length > 0 ? bootstrap.rankCi.get(modelId) : undefined,
      basics: buckets.basics.length > 0 ? round1(mean(buckets.basics)) : null,
      frontier: buckets.frontier.length > 0 ? round1(mean(buckets.frontier)) : null,
      categories,
      questionsGraded: buckets.active.length + buckets.basics.length,
      incidents: incidentsByModel.get(modelId) ?? 0,
      costUsd: Math.round((costByModel.get(modelId) ?? 0) * 10000) / 10000,
    });
  }
  rows.sort((a, b) => b.overall - a.overall);
  return { runId, generatedAt: new Date().toISOString(), methodologyVersion, rows };
}
