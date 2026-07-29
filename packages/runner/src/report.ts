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
  /**
   * Active items excluded from `overall` because they never got a verdict.
   * Non-zero means this row's mean is over a smaller denominator than its
   * peers', which a reader has to know before comparing the numbers.
   */
  unjudged?: number;
  costUsd: number;
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

/** 95% percentile bootstrap over questions (2000 resamples, fixed seed). */
function bootstrapCi(values: number[], seed = 42): [number, number] {
  if (values.length < 2) {
    const v = round1(values[0] ?? 0);
    return [v, v];
  }
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < 2000; i++) {
    let sum = 0;
    for (let j = 0; j < values.length; j++) {
      sum += values[Math.floor(rand() * values.length)]!;
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  return [round1(means[Math.floor(0.025 * means.length)]!), round1(means[Math.ceil(0.975 * means.length) - 1]!)];
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
    basics: number[];
    frontier: number[];
    unjudged: number;
    perCategory: Map<CategoryId, number[]>;
  }
  const byModel = new Map<string, Buckets>();
  const ensure = (modelId: string): Buckets => {
    if (!byModel.has(modelId)) {
      byModel.set(modelId, { active: [], basics: [], frontier: [], unjudged: 0, perCategory: new Map() });
    }
    return byModel.get(modelId)!;
  };
  for (const s of scores) {
    const q = questionsById.get(s.questionId);
    if (!q || q.status === 'retired') continue;
    // Unjudged answers are missing data, not zeros — but the exclusion has to
    // be counted and surfaced, because it shrinks this model's denominator
    // relative to everyone else's. (Empty answers are scored 0 by cmdJudge and
    // never reach here, so what remains is a genuine judge failure.)
    if ((s.detail as { judgePending?: boolean }).judgePending) {
      if (q.status !== 'basics') ensure(s.modelId).unjudged++;
      continue;
    }
    const buckets = ensure(s.modelId);
    if (q.status === 'basics') {
      buckets.basics.push(s.score);
      continue;
    }
    buckets.active.push(s.score);
    if (q.difficulty >= 4) buckets.frontier.push(s.score);
    if (!buckets.perCategory.has(q.category)) buckets.perCategory.set(q.category, []);
    buckets.perCategory.get(q.category)!.push(s.score);
  }

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
      overallCi: buckets.active.length > 0 ? bootstrapCi(buckets.active) : undefined,
      basics: buckets.basics.length > 0 ? round1(mean(buckets.basics)) : null,
      frontier: buckets.frontier.length > 0 ? round1(mean(buckets.frontier)) : null,
      categories,
      questionsGraded: buckets.active.length + buckets.basics.length,
      incidents: incidentsByModel.get(modelId) ?? 0,
      unjudged: buckets.unjudged,
      costUsd: Math.round((costByModel.get(modelId) ?? 0) * 10000) / 10000,
    });
  }
  rows.sort((a, b) => b.overall - a.overall);
  return { runId, generatedAt: new Date().toISOString(), methodologyVersion, rows };
}
