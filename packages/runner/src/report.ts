import { CATEGORY_IDS, type CategoryId, type ModelEntry, type Question, type Score, type StoredResponse } from '@cookingbench/core';

export interface LeaderboardRow {
  modelId: string;
  displayName: string;
  provider: string;
  family?: string;
  /** Unweighted mean of category means, 0–100. */
  overall: number;
  /** Mean over difficulty-3 questions only — the frontier-separating signal. */
  hardSet: number | null;
  categories: Partial<Record<CategoryId, number>>;
  questionsGraded: number;
  costUsd: number;
}

export interface LeaderboardReport {
  runId: string;
  generatedAt: string;
  rows: LeaderboardRow[];
}

export function buildLeaderboard(
  runId: string,
  models: Pick<ModelEntry, 'id' | 'displayName' | 'provider' | 'family'>[],
  questions: Question[],
  responses: StoredResponse[],
  scores: Score[],
): LeaderboardReport {
  const questionCategory = new Map(questions.map((q) => [q.id, q.category]));
  const hardIds = new Set(questions.filter((q) => q.difficulty === 3).map((q) => q.id));
  const hardScores = new Map<string, number[]>();
  const costByModel = new Map<string, number>();
  for (const r of responses) {
    costByModel.set(r.modelId, (costByModel.get(r.modelId) ?? 0) + r.costUsd);
  }

  const byModel = new Map<string, Map<CategoryId, number[]>>();
  for (const s of scores) {
    const category = questionCategory.get(s.questionId);
    if (!category) continue;
    if (!byModel.has(s.modelId)) byModel.set(s.modelId, new Map());
    const perCategory = byModel.get(s.modelId)!;
    if (!perCategory.has(category)) perCategory.set(category, []);
    perCategory.get(category)!.push(s.score);
    if (hardIds.has(s.questionId)) {
      if (!hardScores.has(s.modelId)) hardScores.set(s.modelId, []);
      hardScores.get(s.modelId)!.push(s.score);
    }
  }

  const rows: LeaderboardRow[] = [];
  for (const [modelId, perCategory] of byModel) {
    const meta = models.find((m) => m.id === modelId);
    const categories: Partial<Record<CategoryId, number>> = {};
    let graded = 0;
    const categoryMeans: number[] = [];
    for (const category of CATEGORY_IDS) {
      const values = perCategory.get(category);
      if (!values || values.length === 0) continue;
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      categories[category] = Math.round(mean * 10) / 10;
      categoryMeans.push(mean);
      graded += values.length;
    }
    const hard = hardScores.get(modelId);
    rows.push({
      modelId,
      displayName: meta?.displayName ?? modelId,
      provider: meta?.provider ?? 'Unknown',
      family: meta?.family,
      hardSet: hard && hard.length > 0
        ? Math.round((hard.reduce((a, b) => a + b, 0) / hard.length) * 10) / 10
        : null,
      overall:
        Math.round(
          (categoryMeans.reduce((a, b) => a + b, 0) / Math.max(categoryMeans.length, 1)) * 10,
        ) / 10,
      categories,
      questionsGraded: graded,
      costUsd: Math.round((costByModel.get(modelId) ?? 0) * 10000) / 10000,
    });
  }
  rows.sort((a, b) => b.overall - a.overall);
  return { runId, generatedAt: new Date().toISOString(), rows };
}
