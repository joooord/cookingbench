import { createClient } from '@supabase/supabase-js';
import type { ModelEntry, Question, RunConfig, Score, StoredResponse } from '@cookingbench/core';

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example)');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export async function syncDataset(models: ModelEntry[], questions: Question[]): Promise<void> {
  const db = client();
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
    })),
  );
  if (questionError) throw new Error(`questions upsert failed: ${questionError.message}`);
}

export async function syncRun(
  config: RunConfig,
  responses: StoredResponse[],
  scores: Score[],
): Promise<void> {
  const db = client();
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

  const { data: idRows, error: idError } = await db
    .from('responses')
    .select('id, model_id, question_id')
    .eq('run_id', config.runId);
  if (idError) throw new Error(`responses id fetch failed: ${idError.message}`);
  const idByPair = new Map(idRows!.map((r) => [`${r.model_id}::${r.question_id}`, r.id as number]));

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

export async function publishRun(runId: string): Promise<void> {
  const db = client();
  const { error } = await db.from('runs').update({ published: true }).eq('id', runId);
  if (error) throw new Error(`publish failed: ${error.message}`);
}
