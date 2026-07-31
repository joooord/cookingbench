import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { computeTasteRatings, type TasteVoteRecord } from '@cookingbench/core';
import { REPO_ROOT } from './dataset.js';
import { outputRoot, resolveOutputPath, writeOutputFileAtomic } from './firewall.js';
import type { VerifiedGrant } from './permit.js';
import { TASTE_ARCHIVE_CAPABILITY, serviceRoleClient } from './supabase.js';

/**
 * Snapshot every taste vote into committed artifacts so the human signal is
 * preserved for all time, independent of the live database. Votes are
 * immutable, so a full re-export ordered by (created_at, id) yields
 * append-only git diffs.
 */

/**
 * Refuse any archive replacement that loses or mutates a committed ballot.
 *
 * Deletions, mutations, duplicates and reordering are all rejected: an
 * append-only record that a single bad query can truncate is not a record.
 */
export function assertArchiveGrows(incomingLines: string[], existingPath?: string): void {
  // Path parameterised so the failure modes are testable against fixtures
  // rather than the live committed archive; production always uses the guard.
  const path = existingPath ?? resolveOutputPath('taste', 'votes.ndjson', { write: false });
  const idOf = (line: string) => (JSON.parse(line) as { id: string }).id;

  const seen = new Set<string>();
  for (const line of incomingLines) {
    const id = idOf(line);
    if (seen.has(id)) throw new Error(`Taste archive rejected: duplicate ballot id ${id} in the incoming set.`);
    seen.add(id);
  }

  if (!existsSync(path)) return;
  const existing = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  const incomingById = new Map(incomingLines.map((l) => [idOf(l), l]));

  const missing: string[] = [];
  const mutated: string[] = [];
  for (const line of existing) {
    const id = idOf(line);
    const now = incomingById.get(id);
    if (now === undefined) missing.push(id);
    else if (now !== line) mutated.push(id);
  }
  if (missing.length > 0 || mutated.length > 0) {
    throw new Error(
      `Taste archive rejected: the incoming set is not a superset of the committed archive. ` +
        `${missing.length} ballot(s) missing${missing.length ? ` (${missing.slice(0, 3).join(', ')}…)` : ''}, ` +
        `${mutated.length} mutated${mutated.length ? ` (${mutated.slice(0, 3).join(', ')}…)` : ''}. ` +
        `Refusing to shrink or rewrite the permanent ballot record.`,
    );
  }
  // Committed prefix must stay in order: the file's stability is what makes
  // its diffs append-only and reviewable.
  const incomingPrefix = incomingLines.slice(0, existing.length);
  for (let i = 0; i < existing.length; i++) {
    if (incomingPrefix[i] !== existing[i]) {
      throw new Error(
        `Taste archive rejected: committed ballot order changed at line ${i + 1}. Expected ${idOf(existing[i]!)}.`,
      );
    }
  }
}

export async function archiveTasteVotes(grant: VerifiedGrant): Promise<void> {
  const db = serviceRoleClient(grant, TASTE_ARCHIVE_CAPABILITY, 'archiveTasteVotes');
  const votes: TasteVoteRecord[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    // A fixed operation, not a raw client. serviceRoleClient no longer hands
    // back something that can reach any table — the whole point of RUN-001's
    // narrowed surface is that an archive read cannot become a write.
    const data = await db.readTasteVotes({ from, to: from + pageSize - 1 });
    votes.push(...(data as TasteVoteRecord[]));
    if (data.length < pageSize) break;
  }

  const dir = outputRoot('taste');
  mkdirSync(dir, { recursive: true });

  // Stable key order per line so re-exports diff cleanly.
  const canonical = (v: TasteVoteRecord) =>
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
    });
  const lines = votes.map(canonical);

  // The ballots are the permanent record; the board is derived. Confinement
  // alone does not protect them — this replaced the archive wholesale from a
  // live query, so a short, empty or altered response would silently rewrite
  // history. Require the incoming set to be a strict SUPERSET of what is
  // already committed before anything is replaced.
  assertArchiveGrows(lines);

  writeOutputFileAtomic('taste', 'votes.ndjson', lines.join('\n') + (lines.length ? '\n' : ''));

  const ratings = computeTasteRatings(votes, { bootstrap: 200 });
  writeOutputFileAtomic(
    'taste',
    'ratings.json',
    JSON.stringify({ generatedAt: new Date().toISOString(), totalVotes: votes.length, ratings }, null, 2) + '\n',
  );

  console.log(`✓ ${votes.length} votes → data/taste/votes.ndjson`);
  console.log(`✓ ${ratings.length} model ratings → data/taste/ratings.json`);
  console.log('Commit data/taste/ to make this snapshot permanent.');
}
