'use server';

import {
  TASTE_CHOICES,
  TASTE_DWELL_BOUNDS,
  type TasteChoice,
} from '@cookingbench/core';
import { castBallotReason, castFlightBallot } from '@/lib/supabase';
import {
  buildFlight,
  FlightUnavailableError,
  mintReceipt,
  revealFlight,
  roundContext,
  type BuiltFlight,
  type RoundIdentity,
} from './flight';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Server actions for the Tasting Flight.
 *
 * Everything the client sends is untrusted. The only thing it holds that the
 * server cares about is the sealed token, and the token is the sole source of
 * truth for which models, which item and which nonce a round refers to — the
 * client cannot name them because it has never seen them. That is what makes
 * the ballot honest rather than merely blinded.
 */

export type StartFlightResult =
  | { ok: true; flight: BuiltFlight }
  | { ok: false; reason: string };

export async function startFlightAction(track: string): Promise<StartFlightResult> {
  try {
    return { ok: true, flight: buildFlight(track) };
  } catch (err) {
    if (err instanceof FlightUnavailableError) return { ok: false, reason: err.publicReason };
    // Never leak an internal message to the page; the log keeps the detail.
    console.error('startFlightAction failed', err);
    return { ok: false, reason: 'The Taste Test could not be served just now.' };
  }
}

export interface CastBallotInput {
  token: string;
  round: number;
  choice: string;
  /** Milliseconds from the round appearing to the primary vote. */
  dwellMs: number;
  /** The reader opened or scrolled BOTH proposals before choosing. */
  bothSeen: boolean;
  sessionId: string;
}

export type CastBallotResult =
  | { ok: true; receipt: string; duplicate: boolean }
  | { ok: false; retryable: boolean; reason: string };

/**
 * Record the primary vote. Deliberately does NOT accept a reason code: M5.3
 * requires the reason to be asked only after the primary vote has locked, and
 * accepting both in one call would make it possible to build a UI that asks
 * them together — which is the thing the requirement forbids.
 */
export async function castBallotAction(input: CastBallotInput): Promise<CastBallotResult> {
  const choice = input?.choice;
  if (!(TASTE_CHOICES as readonly string[]).includes(choice)) {
    return { ok: false, retryable: false, reason: 'Unrecognised choice.' };
  }

  let context;
  try {
    context = roundContext(input?.token, input?.round);
  } catch (err) {
    if (err instanceof FlightUnavailableError) {
      return { ok: false, retryable: false, reason: err.publicReason };
    }
    throw err;
  }
  if (!context) {
    // Expired, tampered, or from a deployment with a different key. All three
    // are the same answer to the visitor and none of them is retryable.
    return {
      ok: false,
      retryable: false,
      reason: 'This flight has expired. Start a fresh one — nothing was recorded.',
    };
  }

  // Dwell is a SIGNAL, not a gate. A ballot below the accidental-vote floor is
  // still recorded and is excluded in analysis by `admitTasteBallots`, where
  // the exclusion is counted and visible. Dropping it here would make the
  // mis-tap rate unmeasurable, and the mis-tap rate is a Gate 5 criterion.
  const rawMs = Number(input?.dwellMs);
  const dwell_ms =
    Number.isFinite(rawMs) && rawMs >= 0
      ? Math.min(Math.round(rawMs), TASTE_DWELL_BOUNDS.maxMs)
      : null;

  const sessionId = String(input?.sessionId ?? '');
  const outcome = await castFlightBallot({
    flight_id: context.flightId,
    round: context.round,
    ballot_nonce: context.nonce,
    track: context.track,
    item_id: context.itemId,
    model_left: context.modelLeft,
    model_right: context.modelRight,
    choice,
    both_seen: input?.bothSeen === true,
    dwell_ms,
    left_words: context.leftWords,
    right_words: context.rightWords,
    control_kind: context.controlKind,
    session_id: UUID_RE.test(sessionId) ? sessionId : null,
  });

  if (outcome === 'saved' || outcome === 'duplicate') {
    // A duplicate means the row is already on the books — the vote is recorded,
    // so the reader has earned the receipt and must not be asked to retry.
    return {
      ok: true,
      receipt: mintReceipt(context.flightId, context.round, choice as TasteChoice),
      duplicate: outcome === 'duplicate',
    };
  }
  if (outcome === 'rejected') {
    return {
      ok: false,
      retryable: false,
      reason: 'The kitchen refused that ballot. Nothing was recorded.',
    };
  }
  return { ok: false, retryable: true, reason: 'Your vote didn’t reach the kitchen.' };
}

/**
 * Attach the bounded post-vote reason, AFTER the primary vote has locked.
 *
 * A separate action taking a separate call is not ceremony: M5.3 says the
 * reason "must not influence the initial choice or become a substitute for the
 * ballot", and an action that could accept both at once is an interface that
 * permits asking both at once. It writes an append-only row keyed by the spent
 * nonce, so nothing about the recorded vote can change.
 *
 * The client sends an INDEX into the round's offered reasons and never the
 * wording, so no visitor-supplied string can reach the permanent record. The
 * index is checked against the sealed round's real item here as well as by the
 * database's 0–2 constraint.
 */
export async function attachReasonAction(
  token: string,
  round: number,
  reasonIndex: number,
): Promise<{ ok: boolean; reason?: string }> {
  if (!Number.isInteger(reasonIndex) || reasonIndex < 0 || reasonIndex > 2) {
    return { ok: false, reason: 'Unrecognised reason.' };
  }
  let context;
  try {
    context = roundContext(token, round);
  } catch (err) {
    if (err instanceof FlightUnavailableError) return { ok: false, reason: err.publicReason };
    throw err;
  }
  if (!context) return { ok: false, reason: 'This flight has expired.' };
  if (reasonIndex >= context.reasonCount) {
    return { ok: false, reason: 'Unrecognised reason.' };
  }
  const outcome = await castBallotReason(context.nonce, reasonIndex);
  // A duplicate is a double-tap, not a failure — the reason is already on the
  // books and re-asking would look like the first answer did not register.
  return outcome === 'saved' || outcome === 'duplicate'
    ? { ok: true }
    : { ok: false, reason: 'That didn’t reach the kitchen.' };
}

export type RevealResult =
  | { ok: true; identities: RoundIdentity[] }
  | { ok: false; reason: string };

/** The reveal. Refuses without a valid receipt for every round. */
export async function revealAction(
  token: string,
  receipts: string[],
): Promise<RevealResult> {
  let identities: RoundIdentity[] | null;
  try {
    identities = revealFlight(token, receipts);
  } catch (err) {
    if (err instanceof FlightUnavailableError) return { ok: false, reason: err.publicReason };
    throw err;
  }
  if (!identities) {
    return { ok: false, reason: 'The flight is not complete, so there is nothing to reveal yet.' };
  }
  return { ok: true, identities };
}
