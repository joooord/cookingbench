import type { ModelEntry, Question, RunConfig, Score, StoredResponse } from '@cookingbench/core';
import type { VerifiedGrant } from './permit.js';
import { serviceRoleClient } from './supabase.js';

export async function syncDataset(
  grant: VerifiedGrant,
  models: ModelEntry[],
  questions: Question[],
): Promise<void> {
  const db = serviceRoleClient(grant, 'result-sync', 'syncDataset');
  const { error: modelError } = await db.from('models').upsert(
    models.map((m) => ({
      id: m.id,
      display_name: m.displayName,
      provider: m.provider,
      family: m.family ?? null,
      release_date: m.releaseDate ?? null,
      active: m.active,
    })),
  );
  if (modelError) throw new Error(`models upsert failed: ${modelError.message}`);

  const { error: questionError } = await db.from('questions').upsert(
    questions.map((q) => ({
      id: q.id,
      category: q.category,
      difficulty: q.difficulty,
      prompt: q.prompt,
      system_hint: q.systemHint ?? null,
      grader: q.grader,
      reference_answer: q.referenceAnswer,
      source: q.source ?? null,
      is_public: q.public,
      // Added in migration 0004 — without it the DB-side leaderboard view
      // cannot tell active items from basics and can never reproduce Overall.
      status: q.status,
    })),
  );
  if (questionError) throw new Error(`questions upsert failed: ${questionError.message}`);
}

export async function syncRun(
  grant: VerifiedGrant,
  config: RunConfig,
  responses: StoredResponse[],
  scores: Score[],
): Promise<void> {
  const db = serviceRoleClient(grant, 'result-sync', 'syncRun');
  const totalCost = responses.reduce((sum, r) => sum + r.costUsd, 0);
  const { error: runError } = await db.from('runs').upsert({
    id: config.runId,
    config,
    methodology_version: config.methodologyVersion,
    total_cost_usd: totalCost,
  });
  if (runError) throw new Error(`runs upsert failed: ${runError.message}`);

  // Upsert responses in chunks, then map their generated ids for the scores.
  for (let i = 0; i < responses.length; i += 100) {
    const chunk = responses.slice(i, i + 100);
    const { error } = await db.from('responses').upsert(
      chunk.map((r) => ({
        run_id: r.runId,
        model_id: r.modelId,
        question_id: r.questionId,
        raw: r.raw,
        answer_text: r.answerText,
        tokens_in: r.tokensIn,
        tokens_out: r.tokensOut,
        cost_usd: r.costUsd,
        latency_ms: r.latencyMs,
        finish_reason: r.finishReason ?? null,
      })),
      { onConflict: 'run_id,model_id,question_id' },
    );
    if (error) throw new Error(`responses upsert failed: ${error.message}`);
  }

  // Paginated: PostgREST caps a select at 1000 rows, and a full run is ~2400
  // responses. Unpaginated, every score whose response fell outside the first
  // page mapped to undefined and was silently dropped by the null-guard below
  // — about 58% of them — while the success message still printed.
  const PAGE = 1000;
  const idByPair = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data: idRows, error: idError } = await db
      .from('responses')
      .select('id, model_id, question_id')
      .eq('run_id', config.runId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (idError) throw new Error(`responses id fetch failed: ${idError.message}`);
    for (const r of idRows ?? []) idByPair.set(`${r.model_id}::${r.question_id}`, r.id as number);
    if ((idRows?.length ?? 0) < PAGE) break;
  }

  // A score with no matching response is a real gap, not something to skip
  // quietly — the null-guard that used to swallow these is what made the
  // unpaginated fetch above lose 58% of scores without a word.
  const orphans = scores.filter((s) => !idByPair.has(`${s.modelId}::${s.questionId}`));
  if (orphans.length > 0) {
    throw new Error(
      `${orphans.length} of ${scores.length} scores have no stored response ` +
        `(e.g. ${orphans[0]!.modelId} × ${orphans[0]!.questionId}) — refusing to sync a partial run`,
    );
  }

  for (let i = 0; i < scores.length; i += 200) {
    const chunk = scores.slice(i, i + 200);
    const { error } = await db.from('scores').upsert(
      chunk
        .map((s) => {
          const responseId = idByPair.get(`${s.modelId}::${s.questionId}`);
          if (responseId === undefined) return null;
          return {
            response_id: responseId,
            score: s.score,
            grader_type: s.graderType,
            detail: s.detail,
            judge_model: s.judgeModel ?? null,
          };
        })
        .filter((row) => row !== null),
    );
    if (error) throw new Error(`scores upsert failed: ${error.message}`);
  }
}

export async function publishRun(grant: VerifiedGrant, runId: string): Promise<void> {
  // Making a synced run publicly readable is publication, not sync.
  const db = serviceRoleClient(grant, 'publication', 'publishRun');
  const { error } = await db.from('runs').update({ published: true }).eq('id', runId);
  if (error) throw new Error(`publish failed: ${error.message}`);
}
