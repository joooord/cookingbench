'use server';

import { castTasteVote } from '@/lib/supabase';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_VOTE_MS = 1_800_000; // 30 min, matches the DB check constraint

export async function voteAction(formData: FormData): Promise<{ ok: boolean }> {
  const winner = String(formData.get('winner'));
  if (winner !== 'a' && winner !== 'b' && winner !== 'tie') return { ok: false };

  // Telemetry is best-effort: malformed values become null, never a rejection.
  const sessionRaw = String(formData.get('sessionId') ?? '');
  const session_id = UUID_RE.test(sessionRaw) ? sessionRaw : null;
  const msRaw = Number(formData.get('voteMs'));
  const vote_ms =
    Number.isFinite(msRaw) && msRaw >= 0 ? Math.min(Math.round(msRaw), MAX_VOTE_MS) : null;

  const ok = await castTasteVote({
    run_id: String(formData.get('runId')),
    question_id: String(formData.get('questionId')),
    model_a: String(formData.get('modelA')),
    model_b: String(formData.get('modelB')),
    winner,
    session_id,
    vote_ms,
  });
  return { ok };
}
