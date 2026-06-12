import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { computeTasteRatings, type TasteVoteRecord } from '@cookingbench/core';
import { REPO_ROOT } from './dataset.js';

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example)');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

/**
 * Snapshot every taste vote into committed artifacts so the human signal is
 * preserved for all time, independent of the live database. Votes are
 * immutable, so a full re-export ordered by (created_at, id) yields
 * append-only git diffs.
 */
export async function archiveTasteVotes(): Promise<void> {
  const db = client();
  const votes: TasteVoteRecord[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from('taste_votes')
      .select('*')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`taste_votes fetch failed: ${error.message}`);
    votes.push(...(data as TasteVoteRecord[]));
    if (!data || data.length < pageSize) break;
  }

  const dir = join(REPO_ROOT, 'data', 'taste');
  mkdirSync(dir, { recursive: true });

  // Stable key order per line so re-exports diff cleanly.
  const lines = votes.map((v) =>
    JSON.stringify({
      id: v.id,
      created_at: v.created_at,
      run_id: v.run_id,
      question_id: v.question_id,
      model_a: v.model_a,
      model_b: v.model_b,
      winner: v.winner,
      session_id: v.session_id ?? null,
      vote_ms: v.vote_ms ?? null,
    }),
  );
  writeFileSync(join(dir, 'votes.ndjson'), lines.join('\n') + (lines.length ? '\n' : ''));

  const ratings = computeTasteRatings(votes, { bootstrap: 200 });
  writeFileSync(
    join(dir, 'ratings.json'),
    JSON.stringify({ generatedAt: new Date().toISOString(), totalVotes: votes.length, ratings }, null, 2) + '\n',
  );

  console.log(`✓ ${votes.length} votes → data/taste/votes.ndjson`);
  console.log(`✓ ${ratings.length} model ratings → data/taste/ratings.json`);
  console.log('Commit data/taste/ to make this snapshot permanent.');
}
