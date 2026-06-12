'use server';

import { castTasteVote } from '@/lib/supabase';

export async function voteAction(formData: FormData): Promise<{ ok: boolean }> {
  const winner = String(formData.get('winner'));
  if (winner !== 'a' && winner !== 'b' && winner !== 'tie') return { ok: false };
  const ok = await castTasteVote({
    run_id: String(formData.get('runId')),
    question_id: String(formData.get('questionId')),
    model_a: String(formData.get('modelA')),
    model_b: String(formData.get('modelB')),
    winner,
  });
  return { ok };
}
