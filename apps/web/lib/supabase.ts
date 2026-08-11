import type { TasteVoteRecord } from '@cookingbench/core';

/**
 * WP-0 compatibility boundary for the former anonymous Supabase routes.
 *
 * This no-live-data branch has no shared permit or authority boundary for
 * browser reads or writes. Keeping anonymous transport here would therefore
 * describe an operation as authorised when only its destination was fixed.
 * The public functions remain so existing UI callers fail honestly, but every
 * one returns its existing unavailable/refused sentinel before any transport
 * can be constructed.
 */

export interface TasteVote {
  run_id: string;
  question_id: string;
  model_a: string;
  model_b: string;
  winner: 'a' | 'b' | 'tie';
  /** Anonymous per-browser UUID (localStorage) - analysis-grade, not auth. */
  session_id?: string | null;
  /** Milliseconds from pair shown to vote cast. */
  vote_ms?: number | null;
}

export async function castTasteVote(vote: TasteVote): Promise<boolean> {
  void vote;
  return false;
}

export interface TasteWinrate {
  model_id: string;
  battles: number;
  win_rate: number;
}

/**
 * Compatibility refusal for the former live ballot reader.
 *
 * `null` means live ballot evidence is unavailable. It must not be confused
 * with an empty, successfully read ballot set.
 */
export async function getAllTasteVotes(): Promise<TasteVoteRecord[] | null> {
  return null;
}

export async function getTasteWinrates(): Promise<TasteWinrate[] | null> {
  return null;
}

/* -------------------------------------------------------------------------- */
/* v3 - Tasting Flight ballots (migration 0008)                               */
/* -------------------------------------------------------------------------- */

/**
 * Retained v3 ballot shape for callers of the compatibility refusal.
 *
 * It deliberately cannot express evidence_class or cohort. That preserves the
 * old call contract, but it is not presented as an authority boundary: this
 * module transmits no ballot on the WP-0 no-live-data branch.
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
 * Compatibility refusal for the former live flight-ballot writer.
 *
 * `unreachable` preserves the caller contract without implying that a ballot
 * was saved, duplicated or inspected by a live service.
 */
export async function castFlightBallot(ballot: FlightBallotInsert): Promise<CastOutcome> {
  void ballot;
  return 'unreachable';
}

/**
 * Compatibility refusal for the former live ballot-reason writer.
 */
export async function castBallotReason(
  ballotNonce: string,
  reasonIndex: number,
): Promise<CastOutcome> {
  void ballotNonce;
  void reasonIndex;
  return 'unreachable';
}

/** A row of `taste_flight_reads` - the view, so no session_id and no dwell. */
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
 * Compatibility refusal for the former live flight-ballot reader.
 */
export async function getFlightBallots(): Promise<FlightBallotRead[] | null> {
  return null;
}
