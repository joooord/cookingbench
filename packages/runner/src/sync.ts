import { canPublish, type ModelEntry, type Question, type RunConfig, type Score, type StoredResponse } from '@cookingbench/core';
import { assertGrantForRun, PermitError, type VerifiedGrant } from './permit.js';
import { serviceRoleClient } from './supabase.js';

/**
 * RUN-001 / RELEASE-002 — moving results into the live project, and making them
 * public.
 *
 * Everything here is bound to ONE run id: the grant's. Approval is issued for a
 * single manifest, a manifest names a single run, and nothing in this file may
 * act on a different one. Before this, `syncRun(grant, config, …)` took whatever
 * config the CLI had loaded and `publishRun(grant, runId)` took whatever string
 * it was handed, so a permit approved for a cheap development probe could sync
 * and publish the historical board. The capability was checked; the SUBJECT was
 * not, which is the same defect class as a capability check that returns an
 * unrestricted client.
 */

export async function syncDataset(
  grant: VerifiedGrant,
  models: ModelEntry[],
  questions: Question[],
): Promise<void> {
  // The dataset is not run-scoped, so there is no run to bind — but the permit
  // must still be live at the moment of the write, not merely at start-up.
  const db = serviceRoleClient(grant, 'result-sync', 'syncDataset');
  await db.upsertModels(
    models.map((m) => ({
      id: m.id,
      display_name: m.displayName,
      provider: m.provider,
      family: m.family ?? null,
      release_date: m.releaseDate ?? null,
      active: m.active,
    })),
  );

  await db.upsertQuestions(
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
}

export async function syncRun(
  grant: VerifiedGrant,
  config: RunConfig,
  responses: StoredResponse[],
  scores: Score[],
): Promise<void> {
  // The binding check comes FIRST, before a connection is opened or a row is
  // built: a refusal for the wrong run must cost nothing and touch nothing.
  assertGrantForRun(grant, config.runId, 'syncRun');

  // Every response and every score must belong to the same run as well. A mixed
  // batch would otherwise carry rows from an unapproved run in under an
  // approved run's id, because the row's run_id is rewritten to the grant's on
  // the way out — the payload is what reaches the live table, so the payload is
  // what has to be checked.
  const foreign = [
    ...responses.filter((r) => r.runId !== config.runId).map((r) => `response ${r.runId} × ${r.modelId}`),
    ...scores.filter((s) => s.runId !== config.runId).map((s) => `score ${s.runId} × ${s.modelId}`),
  ];
  if (foreign.length > 0) {
    throw new PermitError(
      `syncRun refused: ${foreign.length} row(s) belong to another run (e.g. ${foreign[0]}). ` +
        `One permit, one manifest, one run.`,
      'PERMIT_RUN_MISMATCH',
    );
  }

  const db = serviceRoleClient(grant, 'result-sync', 'syncRun');
  const totalCost = responses.reduce((sum, r) => sum + r.costUsd, 0);
  await db.upsertRun({
    config,
    methodology_version: config.methodologyVersion,
    total_cost_usd: totalCost,
  });

  // Upsert responses in chunks, then map their generated ids for the scores.
  for (let i = 0; i < responses.length; i += 100) {
    await db.upsertResponses(
      responses.slice(i, i + 100).map((r) => ({
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
    );
  }

  // Paginated: PostgREST caps a select at 1000 rows, and a full run is ~2400
  // responses. Unpaginated, every score whose response fell outside the first
  // page mapped to undefined and was silently dropped by the null-guard below
  // — about 58% of them — while the success message still printed.
  const PAGE = 1000;
  const idByPair = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const idRows = await db.readResponseIds({ from, to: from + PAGE - 1 });
    for (const r of idRows) idByPair.set(`${r.model_id}::${r.question_id}`, r.id);
    if (idRows.length < PAGE) break;
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
    await db.upsertScores(
      scores.slice(i, i + 200).map((s) => ({
        response_id: idByPair.get(`${s.modelId}::${s.questionId}`)!,
        score: s.score,
        grader_type: s.graderType,
        detail: s.detail,
        judge_model: s.judgeModel ?? null,
      })),
    );
  }
}

export async function publishRun(grant: VerifiedGrant, runId: string): Promise<void> {
  // Making a synced run publicly readable is publication, not sync — and it is
  // publication OF ONE RUN, the one the approver signed for.
  assertGrantForRun(grant, runId, 'publishRun');

  // RELEASE-002: check the ARTIFACT, not only the capability. The grant carries
  // the evidence class and release state of the manifest it was verified
  // against, so this boundary can refuse a development probe holding a
  // publication capability without re-reading anything a caller supplied.
  //
  // This is not the whole of RELEASE-002 — writeLeaderboard and writeAnalysis
  // still do not call assertPublishable, and that gap is recorded — but the
  // live-database publication path no longer trusts the capability alone.
  if (!canPublish({ evidenceClass: grant.evidenceClass, releaseState: grant.releaseState })) {
    throw new PermitError(
      `publishRun refused: run '${runId}' is evidence class '${grant.evidenceClass}' in release state ` +
        `'${grant.releaseState}'. Only an approved public-release manifest in 'released' may create a public result.`,
      'PERMIT_KIND_FORBIDS_EVIDENCE_CLASS',
    );
  }

  const db = serviceRoleClient(grant, 'publication', 'publishRun');
  await db.markRunPublished();
}
