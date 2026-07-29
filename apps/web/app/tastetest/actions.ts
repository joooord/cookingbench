'use server';

import { getLatestReport, getResponses } from '@/lib/data';
import { castTasteVote } from '@/lib/supabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VOTE_MS = 1_800_000; // 30 min, matches the DB check constraint

/**
 * A ballot is only meaningful if the pair it names was actually servable.
 *
 * Everything except `winner` used to be passed straight through from the
 * client, and RLS on taste_votes is `with check (true)`, so a ballot could
 * name any two strings at all. That let anyone stuff the Bradley-Terry board,
 * invent models that were never in the run, or collide with the ' phantom'
 * sentinel that anchors the fit. Validating against the published run
 * artifacts costs one cached read and closes all three.
 */
function isRealPair(runId: string, questionId: string, modelA: string, modelB: string): boolean {
  const report = getLatestReport();
  if (!report || report.runId !== runId) return false;
  const roster = new Set(report.rows.map((r) => r.modelId));
  if (!roster.has(modelA) || !roster.has(modelB) || modelA === modelB) return false;
  const answered = new Set(
    getResponses(runId)
      .filter((r) => r.questionId === questionId && r.answerText.trim())
      .map((r) => r.modelId),
  );
  return answered.has(modelA) && answered.has(modelB);
}

export async function voteAction(formData: FormData): Promise<{ ok: boolean }> {
  const winner = String(formData.get('winner'));
  if (winner !== 'a' && winner !== 'b' && winner !== 'tie') return { ok: false };

  const run_id = String(formData.get('runId'));
  const question_id = String(formData.get('questionId'));
  const model_a = String(formData.get('modelA'));
  const model_b = String(formData.get('modelB'));
  if (!isRealPair(run_id, question_id, model_a, model_b)) return { ok: false };

  // Telemetry is best-effort: malformed values become null, never a rejection.
  const sessionRaw = String(formData.get('sessionId') ?? '');
  const session_id = UUID_RE.test(sessionRaw) ? sessionRaw : null;
  const msRaw = Number(formData.get('voteMs'));
  const vote_ms =
    Number.isFinite(msRaw) && msRaw >= 0 ? Math.min(Math.round(msRaw), MAX_VOTE_MS) : null;

  const ok = await castTasteVote({
    run_id,
    question_id,
    model_a,
    model_b,
    winner,
    session_id,
    vote_ms,
  });
  return { ok };
}
