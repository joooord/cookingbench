import type { TasteVoteRecord } from '@cookingbench/core';

// Anonymous, RLS-protected Supabase access for the taste test. These values
// are public by design (publishable key + RLS policies allow only voting and
// reading tallies); env vars override for other deployments.
const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? 'https://nvdkhatenkjmbyudwbgm.supabase.co';
const SUPABASE_KEY =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? 'sb_publishable_oM34s0Y3Lxysr5oDF0fx7g_ODj-49o3';

const HEADERS = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

export interface TasteVote {
  run_id: string;
  question_id: string;
  model_a: string;
  model_b: string;
  winner: 'a' | 'b' | 'tie';
  /** Anonymous per-browser UUID (localStorage) — analysis-grade, not auth. */
  session_id?: string | null;
  /** Milliseconds from pair shown to vote cast. */
  vote_ms?: number | null;
}

export async function castTasteVote(vote: TasteVote): Promise<boolean> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/taste_votes`, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify(vote),
      cache: 'no-store',
    });
    return res.ok;
  } catch {
    return false;
  }
}

export interface TasteWinrate {
  model_id: string;
  battles: number;
  win_rate: number;
}

/**
 * Every vote ever cast, oldest first, for the Bradley-Terry taste board.
 * Paginated because PostgREST caps responses at 1000 rows.
 *
 * Reads `taste_ballots` (migration 0005), which exposes only the columns the
 * fit needs — session_id and vote_ms stay server-side rather than being
 * world-readable through the publishable key.
 */
export async function getAllTasteVotes(): Promise<TasteVoteRecord[] | null> {
  const pageSize = 1000;
  const votes: TasteVoteRecord[] = [];
  try {
    for (let page = 0; ; page++) {
      const from = page * pageSize;
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/taste_ballots?select=*&order=created_at.asc,id.asc`,
        {
          headers: { ...HEADERS, Range: `${from}-${from + pageSize - 1}` },
          next: { revalidate: 60 },
        },
      );
      if (!res.ok) return null;
      const rows = (await res.json()) as TasteVoteRecord[];
      votes.push(...rows);
      if (rows.length < pageSize) break;
    }
    return votes;
  } catch {
    return null;
  }
}

export async function getTasteWinrates(): Promise<TasteWinrate[] | null> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/taste_winrates?select=*`, {
      headers: HEADERS,
      next: { revalidate: 60 },
    });
    if (!res.ok) return null;
    const rows = (await res.json()) as TasteWinrate[];
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* v3 — Tasting Flight ballots (migration 0008)                               */
/* -------------------------------------------------------------------------- */

/**
 * The wire shape of a v3 ballot: snake_case, exactly the columns of
 * `taste_flight_ballots`, with no client-settable `evidence_class` or `cohort`.
 *
 * Both are omitted ON PURPOSE. The table defaults them to `development` and
 * `public`, and the RLS policy rejects any anonymous insert that sets them to
 * anything else. Leaving them out of the type means a future caller cannot
 * even express the attempt — the firewall is enforced in three places because
 * two of them are code and code gets edited.
 */
export interface FlightBallotInsert {
  flight_id: string;
  round: number;
  ballot_nonce: string;
  track: string;
  item_id: string;
  model_left: string;
  model_right: string;
  choice: string;
  both_seen: boolean;
  dwell_ms: number | null;
  left_words: number | null;
  right_words: number | null;
  control_kind: string;
  session_id: string | null;
}

export type CastOutcome = 'saved' | 'duplicate' | 'rejected' | 'unreachable';

/**
 * Record one ballot.
 *
 * The three failure modes are kept apart because the UI must treat them
 * differently. `duplicate` means the nonce or the (flight, round) pair is
 * already on the books — the vote IS recorded, so retrying would be wrong and
 * the flight should move on. `rejected` means the database refused the row and
 * a retry will refuse it identically. Only `unreachable` is worth retrying, and
 * that is the one the duel's original pending/error/retry loop was built for.
 * Collapsing them into a boolean is how a recorded vote comes to look lost, and
 * a permanently-refused vote comes to look retryable.
 */
export async function castFlightBallot(ballot: FlightBallotInsert): Promise<CastOutcome> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/taste_flight_ballots`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify(ballot),
      cache: 'no-store',
    });
    if (res.ok) return 'saved';
    // 409 is the unique index on ballot_nonce or on (flight_id, round).
    if (res.status === 409) return 'duplicate';
    if (res.status >= 400 && res.status < 500) return 'rejected';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/**
 * Attach the bounded post-vote reason to an already-recorded ballot.
 *
 * A separate append-only row rather than an update, so the ballot record itself
 * stays immutable to anon. `reason_index` — not text — because a public,
 * writable string column on a page that renders it is how forged model ids
 * reached the v2 taste board.
 */
export async function castBallotReason(
  ballotNonce: string,
  reasonIndex: number,
): Promise<CastOutcome> {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/taste_ballot_reasons`, {
      method: 'POST',
      headers: { ...HEADERS, Prefer: 'return=minimal' },
      body: JSON.stringify({ ballot_nonce: ballotNonce, reason_index: reasonIndex }),
      cache: 'no-store',
    });
    if (res.ok) return 'saved';
    if (res.status === 409) return 'duplicate';
    if (res.status >= 400 && res.status < 500) return 'rejected';
    return 'unreachable';
  } catch {
    return 'unreachable';
  }
}

/** A row of `taste_flight_reads` — the view, so no session_id and no dwell. */
export interface FlightBallotRead {
  id: string;
  created_at: string;
  evidence_class: string;
  flight_id: string;
  round: number;
  track: string;
  item_id: string;
  model_left: string;
  model_right: string;
  choice: string;
  both_seen: boolean;
  left_words: number | null;
  right_words: number | null;
  cohort: string;
  control_kind: string;
}

/**
 * Every v3 ballot, oldest first. Paginated because PostgREST caps at 1000.
 *
 * Returns null on ANY failure, including a partial read. A truncated ballot set
 * silently produces a different Bradley-Terry fit rather than an error, and the
 * board would render it without a word — so a page that cannot get all of it
 * gets none of it.
 */
export async function getFlightBallots(): Promise<FlightBallotRead[] | null> {
  const pageSize = 1000;
  const rows: FlightBallotRead[] = [];
  try {
    for (let page = 0; ; page++) {
      const from = page * pageSize;
      const res = await fetch(
        `${SUPABASE_URL}/rest/v1/taste_flight_reads?select=*&order=created_at.asc,id.asc`,
        {
          headers: { ...HEADERS, Range: `${from}-${from + pageSize - 1}` },
          next: { revalidate: 60 },
        },
      );
      if (!res.ok) return null;
      const batch = (await res.json()) as FlightBallotRead[];
      rows.push(...batch);
      if (batch.length < pageSize) break;
      // A bank large enough to hit this is a different problem; refusing beats
      // looping forever against a misbehaving endpoint.
      if (page > 200) return null;
    }
    return rows;
  } catch {
    return null;
  }
}
