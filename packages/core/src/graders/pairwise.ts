/**
 * M2.1 pairwise mode — close comparisons between two valid creative answers.
 *
 * The five outcomes are A better, B better, substantively equal, **both
 * unacceptable**, and **abstain**. The last two are the reason this module
 * exists as more than a string union.
 *
 * `both_unacceptable` must never be stored as an ordinary tie. A tie says the
 * two answers are equally good; both-unacceptable says neither should be served
 * to anyone. Collapsing them means a pair of dangerous answers contributes the
 * same half-point each as a pair of excellent ones, and — worse — a model that
 * is reliably terrible accumulates a respectable Bradley-Terry rating out of
 * comparisons where a judge explicitly refused to endorse it. M2.8 says it
 * plainly: `abstain` is missing and `both_unacceptable` is a separate absolute
 * outcome.
 *
 * `abstain` is missingness. It is not a tie either, and it is not a zero: it is
 * the judge declining to rate, and a denominator that includes it silently
 * dilutes every real preference on the pair.
 *
 * The encoding here is deliberately awkward to collapse. There is no function
 * mapping an outcome to a scalar, no `0.5` fallback and no default branch;
 * `pairwisePoints` returns `null` for both, and every aggregate reports the
 * counts side by side rather than a single "score".
 */

export const PAIRWISE_OUTCOMES = [
  'a',
  'b',
  'equal',
  'both_unacceptable',
  'abstain',
] as const;
export type PairwiseOutcome = (typeof PAIRWISE_OUTCOMES)[number];

/**
 * What kind of thing an outcome is. Aggregators branch on this rather than on
 * the outcome string, so adding a sixth outcome is a compile error at every
 * site that has to decide what it means, instead of falling into an `else`.
 */
export type PairwiseClass = 'preference' | 'tie' | 'no-contest' | 'missing';

export const PAIRWISE_OUTCOME_CLASS: Readonly<Record<PairwiseOutcome, PairwiseClass>> =
  Object.freeze({
    a: 'preference',
    b: 'preference',
    equal: 'tie',
    both_unacceptable: 'no-contest',
    abstain: 'missing',
  });

/**
 * The only outcome that is a tie. Exported as a frozen list so a caller that
 * wants "the tie outcomes" gets exactly one and cannot quietly widen it.
 */
export const TIE_OUTCOMES = Object.freeze(['equal'] as const);

export class PairwiseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairwiseError';
  }
}

function assertOutcome(outcome: unknown): PairwiseOutcome {
  if (!(PAIRWISE_OUTCOMES as readonly unknown[]).includes(outcome)) {
    throw new PairwiseError(
      `unknown pairwise outcome ${JSON.stringify(outcome)}; expected one of ${PAIRWISE_OUTCOMES.join(', ')}`,
    );
  }
  return outcome as PairwiseOutcome;
}

export function classifyPairwise(outcome: PairwiseOutcome): PairwiseClass {
  return PAIRWISE_OUTCOME_CLASS[assertOutcome(outcome)];
}

export function isTie(outcome: PairwiseOutcome): boolean {
  return classifyPairwise(outcome) === 'tie';
}

/**
 * Bradley-Terry style points, or `null` when the ballot expresses no preference
 * between the candidates.
 *
 * `null` rather than `{ a: 0, b: 0 }`: a zero-zero row still occupies a place in
 * a denominator somewhere downstream, and the caller has to be forced to decide
 * what to do with a no-contest rather than being handed something that adds up.
 * taste.ts's fitter takes wins and half-wins; feeding it a both-unacceptable as
 * a half-win each is exactly the bug this returns null to prevent.
 */
export function pairwisePoints(outcome: PairwiseOutcome): { a: number; b: number } | null {
  switch (classifyPairwise(outcome)) {
    case 'preference':
      return outcome === 'a' ? { a: 1, b: 0 } : { a: 0, b: 1 };
    case 'tie':
      return { a: 0.5, b: 0.5 };
    case 'no-contest':
    case 'missing':
      return null;
  }
}

/** Which candidate was shown first. */
export type PairwisePresentation = 'ab' | 'ba';

export interface PairwiseBallot {
  judge: string;
  presentation: PairwisePresentation;
  /** As the judge wrote it: `a` means "the first answer shown", not candidate A. */
  outcome: PairwiseOutcome;
  /** 0–1. Absent is not confident; the router fails closed on it. */
  confidence?: number;
  /** The seat flagged a safety concern about one or both answers. */
  safetyFlag?: boolean;
  rationale?: string;
}

/**
 * Rewrite a ballot's outcome in terms of candidate identity rather than
 * position. M2.8 requires canonicalisation before any agreement analysis, and
 * an aggregator that skips it reports the position effect as if it were signal.
 * The symmetric outcomes are unchanged by definition.
 */
export function canonicaliseOutcome(
  outcome: PairwiseOutcome,
  presentation: PairwisePresentation,
): PairwiseOutcome {
  const canonical = assertOutcome(outcome);
  if (presentation === 'ab') return canonical;
  if (presentation !== 'ba') {
    throw new PairwiseError(
      `unknown presentation ${JSON.stringify(presentation)}; expected 'ab' or 'ba'`,
    );
  }
  if (canonical === 'a') return 'b';
  if (canonical === 'b') return 'a';
  return canonical;
}

export interface RaterUnit {
  judge: string;
  /**
   * The canonicalised outcome, or `null` when the judge's two presentations
   * disagreed. M2.5: an order flip is instability requiring escalation, not two
   * independent votes, so the unit yields no outcome at all.
   */
  outcome: PairwiseOutcome | null;
  orderUnstable: boolean;
  /** Lowest confidence across the unit's presentations, when all declared one. */
  confidence?: number;
  safetyFlag: boolean;
  presentations: PairwiseOutcome[];
}

/**
 * Fold one judge's presentations of the same pair into a single rater unit.
 *
 * Any post-canonicalisation difference counts as instability, including
 * `a` versus `equal`. A weaker rule ("only a↔b counts as a flip") would let a
 * seat that flips between decisive and undecided pass as stable, and the
 * ordinal distance between those is not obviously smaller than between a and b.
 */
export function foldRaterUnit(ballots: readonly PairwiseBallot[]): RaterUnit {
  if (!Array.isArray(ballots) || ballots.length === 0) {
    throw new PairwiseError('a rater unit needs at least one ballot');
  }
  const judges = new Set(ballots.map((b) => b.judge));
  if (judges.size !== 1) {
    throw new PairwiseError(
      `a rater unit is one judge's presentations; got ${[...judges].join(', ')}`,
    );
  }
  const seenPresentations = new Set<PairwisePresentation>();
  const canonical: PairwiseOutcome[] = [];
  const confidences: number[] = [];
  let safetyFlag = false;
  for (const ballot of ballots) {
    if (seenPresentations.has(ballot.presentation)) {
      throw new PairwiseError(
        `judge ${ballot.judge} submitted presentation ${ballot.presentation} twice for one pair`,
      );
    }
    seenPresentations.add(ballot.presentation);
    canonical.push(canonicaliseOutcome(ballot.outcome, ballot.presentation));
    if (typeof ballot.confidence === 'number' && Number.isFinite(ballot.confidence)) {
      confidences.push(ballot.confidence);
    }
    if (ballot.safetyFlag) safetyFlag = true;
  }
  const distinct = new Set(canonical);
  const orderUnstable = distinct.size > 1;
  return {
    judge: ballots[0]!.judge,
    outcome: orderUnstable ? null : canonical[0]!,
    orderUnstable,
    confidence:
      confidences.length === ballots.length && confidences.length > 0
        ? Math.min(...confidences)
        : undefined,
    safetyFlag,
    presentations: canonical,
  };
}

export interface PairwiseTally {
  a: number;
  b: number;
  equal: number;
  bothUnacceptable: number;
  abstain: number;
  /** Rater units whose presentations disagreed; they contribute nothing. */
  unstable: number;
  /**
   * a + b + equal. `bothUnacceptable` and `abstain` are deliberately absent
   * from this sum and there is no field that adds them back in.
   */
  preferenceDenominator: number;
  /** Every rater unit, including the ones outside the denominator. */
  units: number;
}

export function tallyPairwise(units: readonly RaterUnit[]): PairwiseTally {
  if (!Array.isArray(units)) throw new PairwiseError('units must be an array');
  const tally: PairwiseTally = {
    a: 0,
    b: 0,
    equal: 0,
    bothUnacceptable: 0,
    abstain: 0,
    unstable: 0,
    preferenceDenominator: 0,
    units: units.length,
  };
  for (const unit of units) {
    if (unit.orderUnstable || unit.outcome === null) {
      tally.unstable += 1;
      continue;
    }
    switch (assertOutcome(unit.outcome)) {
      case 'a':
        tally.a += 1;
        break;
      case 'b':
        tally.b += 1;
        break;
      case 'equal':
        tally.equal += 1;
        break;
      case 'both_unacceptable':
        tally.bothUnacceptable += 1;
        break;
      case 'abstain':
        tally.abstain += 1;
        break;
    }
  }
  tally.preferenceDenominator = tally.a + tally.b + tally.equal;
  return tally;
}

/**
 * Preference shares over the units that expressed one.
 *
 * Throws on an empty denominator instead of returning 0.5/0.5. A pair where
 * every seat abstained or rejected both answers has produced no preference
 * evidence, and "50/50" is a claim of exact equipoise that nobody made.
 */
export function preferenceShare(tally: PairwiseTally): { a: number; b: number } {
  if (tally.preferenceDenominator <= 0) {
    throw new PairwiseError(
      'no preference evidence on this pair (all units abstained, rejected both answers or flipped on order); ' +
        'there is no share to report',
    );
  }
  const half = tally.equal / 2;
  return {
    a: (tally.a + half) / tally.preferenceDenominator,
    b: (tally.b + half) / tally.preferenceDenominator,
  };
}

export type PairwiseWinner = 'a' | 'b' | 'tie' | 'no-contest' | 'insufficient';

export interface PairwiseVerdict {
  winner: PairwiseWinner;
  tally: PairwiseTally;
  /** Present only when a preference denominator existed. */
  share: { a: number; b: number } | null;
  escalate: boolean;
  reasons: string[];
}

export interface PairwisePolicy {
  /**
   * Rater units that must express a preference, a tie or a rejection before a
   * verdict is claimed. Two is the floor a panel of three can lose one seat to.
   */
  minimumUnits?: number;
}

/**
 * The pair's verdict, with `no-contest` as a first-class result.
 *
 * `no-contest` wins outright when both-unacceptable is at least as common as
 * any preference outcome: if half the panel says neither answer should be
 * served, declaring one of them the winner reports a ranking over two things
 * the panel refused. It is not a tie and callers must not display it as one.
 */
export function pairwiseVerdict(
  units: readonly RaterUnit[],
  policy: PairwisePolicy = {},
): PairwiseVerdict {
  const tally = tallyPairwise(units);
  const minimumUnits = policy.minimumUnits ?? 2;
  const reasons: string[] = [];
  let escalate = false;

  if (tally.unstable > 0) {
    escalate = true;
    reasons.push(`${tally.unstable} rater unit(s) flipped with presentation order`);
  }

  const usable = tally.preferenceDenominator + tally.bothUnacceptable;
  if (usable < minimumUnits) {
    escalate = true;
    reasons.push(`only ${usable} usable rater unit(s), below the declared minimum of ${minimumUnits}`);
    return { winner: 'insufficient', tally, share: null, escalate, reasons };
  }

  const decisive = Math.max(tally.a, tally.b, tally.equal);
  if (tally.bothUnacceptable >= decisive && tally.bothUnacceptable > 0) {
    escalate = true;
    reasons.push('both answers were rejected by at least as many seats as preferred either');
    return { winner: 'no-contest', tally, share: null, escalate, reasons };
  }

  const share = preferenceShare(tally);
  if (tally.bothUnacceptable > 0) {
    // A minority rejection does not decide the pair, but it is a safety-shaped
    // disagreement and M2.6 makes any safety disagreement a human matter.
    escalate = true;
    reasons.push(`${tally.bothUnacceptable} seat(s) rejected both answers while others chose one`);
  }

  let winner: PairwiseWinner;
  if (tally.a > tally.b) winner = 'a';
  else if (tally.b > tally.a) winner = 'b';
  else winner = 'tie';

  return { winner, tally, share, escalate, reasons };
}
