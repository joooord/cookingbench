import { readFileSync } from 'node:fs';
import { canonicalJson } from '@cookingbench/core';
import {
  resolveOutputPath,
  resolveRunFile,
  writeOutputFileAtomic,
  writeRunFileAtomic,
} from './firewall.js';
import { sha256Hex } from './permit.js';
// Same relative import `analyze.ts`, `simulate.ts` and `specificity.ts` already
// document: core's `exports` map exposes only `.`, and `index.ts` does not
// re-export `stats.ts` yet. One line to change when it does.
import { fnv1a32 } from '../../core/src/stats.js';

/**
 * M2.6 — the adjudication workflow.
 *
 * The defect this module exists for: run `2026-07-v2.1` flagged 73 answers for
 * cross-judge disagreement above 15 points and then did nothing with them. The
 * disputed mean stayed the score, the flag was written into `scores.json`, and
 * the leaderboard was published over the top of it. A flag that changes no
 * number and blocks no report is a comment, not a control.
 *
 * Three things follow from that, and they are the whole design:
 *
 * 1. **The queue is computed, not curated.** `buildAdjudicationQueue` derives
 *    the mandatory set from the panel evidence and the declared policy. Nobody
 *    decides which disputes are worth reviewing; M2.6's categories decide, and
 *    the stratified audit sample means the *unflagged* population is checked
 *    too rather than assumed correct.
 * 2. **Absence is never permission.** No queue is not an empty queue; no
 *    recorded confidence is not high confidence; no declared headline tier is
 *    not "this pair affects nothing"; no automation-coverage validation is not
 *    "the automation is validated". Every one of those refuses. This is
 *    deliberately expensive — see `UNVALIDATED_COVERAGE` — because the cheap
 *    reading is how 73 disputes became zero reviews.
 * 3. **No report may be generated while adjudications are pending.**
 *    `assertReportPermitted` is the gate, and it fails closed on a missing
 *    record, a missing queue, a queue that has changed since the decisions were
 *    taken, and a critical safety case signed off by somebody who did not
 *    declare independence.
 *
 * The module is pure apart from four clearly-named I/O helpers at the bottom,
 * all of which go through the firewall, so a retro-adjudication of a published
 * run is refused at the path layer rather than trusted to a convention.
 */

export type AdjudicationErrorCode =
  | 'INVALID_POLICY'
  | 'INVALID_OBSERVATION'
  | 'DUPLICATE_CASE'
  | 'INVALID_RECORD'
  | 'REPORT_BLOCKED'
  | 'PRESENTATION_UNBLINDED';

export class AdjudicationError extends Error {
  constructor(
    message: string,
    readonly code: AdjudicationErrorCode,
  ) {
    super(message);
    this.name = 'AdjudicationError';
  }
}

/* -------------------------------------------------------------------------- */
/* a hand-rolled validator, and why                                           */
/* -------------------------------------------------------------------------- */

/*
 * `packages/runner` does not depend on zod. Only `packages/core` does, and
 * under pnpm's strict layout `import { z } from 'zod'` does not resolve inside
 * this package at all — so a schema here would be a runtime failure, not a
 * refactor. `firewall.ts` validates its historical registry by hand for the
 * same reason and this follows it.
 *
 * The one convention worth preserving from the zod files: collect EVERY fault
 * and throw once. A hand-assembled adjudication file corrected one message at a
 * time takes as many passes as it has mistakes, and reviewers give up.
 */

type Faults = string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The `.strict()` equivalent. Load-bearing: see the `evidence` field below. */
function rejectUnknownKeys(o: Record<string, unknown>, allowed: readonly string[], path: string, faults: Faults): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) faults.push(`${path}.${key}: unknown field`);
  }
}

function reqString(o: Record<string, unknown>, key: string, path: string, faults: Faults): string | undefined {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') {
    faults.push(`${path}.${key}: expected a non-empty string, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

function optString(o: Record<string, unknown>, key: string, path: string, faults: Faults): string | undefined {
  if (o[key] === undefined) return undefined;
  return reqString(o, key, path, faults);
}

function reqBoolean(o: Record<string, unknown>, key: string, path: string, faults: Faults): boolean | undefined {
  const v = o[key];
  if (typeof v !== 'boolean') {
    // Not coerced. `"false"` and `0` are the values a hand-edited worksheet
    // actually contains, and both are truthy or falsy in ways nobody intended.
    faults.push(`${path}.${key}: expected a boolean, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

function reqNumber(
  o: Record<string, unknown>,
  key: string,
  path: string,
  faults: Faults,
  range: { min: number; max: number },
): number | undefined {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < range.min || v > range.max) {
    faults.push(`${path}.${key}: expected a finite number in [${range.min}, ${range.max}], got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

function optNumber(
  o: Record<string, unknown>,
  key: string,
  path: string,
  faults: Faults,
  range: { min: number; max: number },
): number | undefined {
  if (o[key] === undefined) return undefined;
  return reqNumber(o, key, path, faults, range);
}

function reqEnum<T extends string>(
  o: Record<string, unknown>,
  key: string,
  path: string,
  faults: Faults,
  allowed: readonly T[],
): T | undefined {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    faults.push(`${path}.${key}: expected one of ${allowed.join(' | ')}, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v as T;
}

/* -------------------------------------------------------------------------- */
/* what the panel produced — the input side                                   */
/* -------------------------------------------------------------------------- */

/** M2.1's three routes. Carried on the observation so the queue can say which. */
export type JudgementMode = 'fault-deduction' | 'dimension' | 'pairwise';

/**
 * One thing a seat said, and what it said it about.
 *
 * `provenance` is not decoration. M2.2 forbids an LLM judge accepting a
 * safety-critical case alone, and that rule is only enforceable if a critical
 * finding carries where it came from. An absent provenance is read as
 * `llm-judge` — see `safetyTriggers` for why that direction and not the other.
 */
export interface SeatEvidence {
  /** The passage the seat is talking about, verbatim, when it quoted one. */
  quote?: string;
  /** What the seat says is wrong (or right) about it. */
  statement: string;
  severity?: 'critical' | 'major' | 'minor';
  provenance?: 'deterministic' | 'human' | 'llm-judge';
}

export interface SeatVerdict {
  judgeModel: string;
  /** From the jury design, not re-derived. Absent on legacy two-seat panels. */
  judgeFamily?: string;
  /** 0–100, or null when the seat abstained or the route produces no number. */
  score: number | null;
  /**
   * 0–1. `null` means the seat recorded none — which is unmeasured, not
   * certain. Nothing in this file converts a null into a high value.
   */
  confidence: number | null;
  evidence: readonly SeatEvidence[];
  summary?: string;
  /** Candidate ids this seat tagged with a critical safety/allergen failure. */
  criticalTags?: readonly string[];
}

export interface ObservedAnswer {
  modelId: string;
  text: string;
}

/**
 * A single automated judgement, in the neutral shape the queue reasons over.
 *
 * Deliberately not `Score` and not `DimensionAggregate`: this module has to
 * cover the legacy two-seat panel that produced the 73 real flags, the M2.1
 * dimension route and the M2.1 pairwise route, and coupling to any one of their
 * result types would make the workflow available to only one of them.
 */
export interface PanelObservation {
  runId: string;
  questionId: string;
  /** One candidate for dimension/fault routes, two for pairwise. */
  candidates: readonly string[];
  mode: JudgementMode;
  /**
   * The declared stratum this case belongs to — a capability axis, a severity
   * band, a control family. Required: the audit sample is stratified and the
   * automation-coverage check is per stratum, so an unstratified case can be
   * neither sampled nor covered, and treating it as its own stratum would hand
   * it a guaranteed sample slot.
   */
  stratum: string;
  /** True when this case belongs to the critical safety/allergen set. */
  critical?: boolean;
  seats: readonly SeatVerdict[];
  /** Points of spread the pipeline recorded, or null if it computed none. */
  disagreement: number | null;
  /** Shannon bits over rater-unit outcomes (pairwise), or null. */
  entropy: number | null;
  /** Panel confidence 0–1, or null when no seat reported one. */
  confidence: number | null;
  /** Escalations the M2.5 aggregation already raised, passed through verbatim. */
  escalations?: readonly { reason: string; detail: string }[];
  /** Two presentations from one judge named opposite winners. */
  orderUnstable?: boolean;
  /** The number automation would publish. Preserved, never treated as decided. */
  provisionalScore: number | null;
  prompt: string;
  answers: readonly ObservedAnswer[];
}

/**
 * A reference or judge pack somebody has disputed.
 *
 * M2.6 makes *all* challenged references mandatory, and a challenge does not
 * have to come with a disagreement — the 2026-07 grader audit found three
 * reference answers scoring 0 against their own graders while every seat agreed
 * the candidate was wrong. Unanimity is not evidence that the key is right.
 */
export interface ReferenceChallenge {
  questionId: string;
  /** Who raised it, and on what basis. Both required by `assertPolicy`. */
  raisedBy: string;
  detail: string;
}

/* -------------------------------------------------------------------------- */
/* policy — every threshold declared, none defaulted                          */
/* -------------------------------------------------------------------------- */

export const MANDATORY_REVIEW_REASONS = [
  /** Seats disagreed about a critical safety/allergen failure. */
  'safety-disagreement',
  /** A critical failure resting on LLM evidence alone (M2.2). */
  'safety-llm-only',
  /** Cross-seat spread above the declared tolerance. */
  'split-beyond-tolerance',
  /** Vote entropy above tolerance, or unmeasured, outside validated coverage. */
  'entropy-outside-coverage',
  /** Panel confidence below tolerance, or unmeasured, outside validated coverage. */
  'confidence-outside-coverage',
  /** An order-unstable pair that a headline tier claim rests on. */
  'order-unstable-headline',
  /** The item's reference or judge pack has been challenged. */
  'challenged-reference',
  /** Drawn into the stratified audit of otherwise-unflagged cases. */
  'stratified-audit-sample',
] as const;
export type MandatoryReviewReason = (typeof MANDATORY_REVIEW_REASONS)[number];

/**
 * Which strata the automated route has actually been validated on.
 *
 * M2.6 only excuses a high-entropy or low-confidence case from review when it
 * sits *inside validated automation coverage*, and M2.8 fixes what validated
 * means: a sealed JudgeBench holdout that passed. So coverage is a claim with a
 * provenance, not a switch — and a holdout that failed or was never run covers
 * nothing, whatever its stratum list says.
 */
export interface AutomationCoverage {
  /** The JudgeBench sealed-holdout attempt this claim rests on. */
  validatedBy: string;
  verdict: 'pass' | 'fail' | 'not-run';
  /** Strata that holdout actually powered. Anything else is outside coverage. */
  strata: readonly string[];
}

/**
 * Today's honest coverage, exported so a caller has to type it out rather than
 * omit the field.
 *
 * There is no passing sealed holdout in this repository, so no stratum is
 * covered, so every case whose confidence the panel never recorded is mandatory
 * review. On `2026-07-v2.1` that is all 630 judged answers, not the 73 flagged
 * ones — the legacy panel records no per-seat confidence at all. That number is
 * the finding, not a bug in this file: it is the size of the automatic
 * acceptance nobody has validated.
 */
export const UNVALIDATED_COVERAGE: AutomationCoverage = Object.freeze({
  validatedBy: 'none — no sealed JudgeBench holdout has been opened',
  verdict: 'not-run',
  strata: Object.freeze([]) as readonly string[],
});

/** Strata the automation may be trusted on. Empty unless a holdout passed. */
export function coveredStrata(coverage: AutomationCoverage): ReadonlySet<string> {
  if (coverage.verdict !== 'pass') return new Set();
  return new Set(coverage.strata);
}

/**
 * The stratified audit of otherwise-unflagged cases.
 *
 * Preregistered, because a sample size picked after looking at the flags is not
 * a sample — it is a choice about how much auditing the result can survive.
 */
export interface SamplingPlan {
  /** Reproducible draw. Any string; hashed per case, never a shared stream. */
  seed: string;
  /** Share of each stratum's unflagged cases to audit. 0 < fraction ≤ 1. */
  fraction: number;
  /** Floor per stratum, so a thin stratum is still audited at all. */
  minimumPerStratum: number;
  /** Where the plan was frozen, so it can be shown to predate the flags. */
  preregisteredIn: string;
}

/**
 * The models a published tier claim rests on.
 *
 * `'undeclared'` is not the same as `[]`. An empty array is a positive
 * statement that no tier claim is being made, so an order-unstable pair affects
 * nothing; `'undeclared'` means nobody has said, and every order-unstable pair
 * is therefore mandatory. Collapsing the two is how a headline claim gets made
 * over an unreviewed instability.
 */
export type HeadlineTier = readonly string[] | 'undeclared';

export interface AdjudicationPolicy {
  /**
   * Points of cross-seat spread above which review is mandatory. M2.6 says
   * "larger than the declared tolerance", so it is declared here rather than
   * defaulted. `DEFAULT_DISAGREEMENT_TOLERANCE` (15) in core is the provisional
   * value v2 practice used; a starting point, not a measured constant.
   */
  disagreementTolerance: number;
  /** Bits of vote entropy above which a pairwise case counts as high-entropy. */
  entropyTolerance: number;
  /** Panel confidence below which a case counts as low-confidence. */
  minimumConfidence: number;
  headlineTier: HeadlineTier;
  coverage: AutomationCoverage;
  sampling: SamplingPlan;
  /** Disputed references. All of them are reviewed, disagreement or not. */
  challenges?: readonly ReferenceChallenge[];
}

function assertPolicy(policy: AdjudicationPolicy): void {
  const bad = (msg: string): never => {
    throw new AdjudicationError(msg, 'INVALID_POLICY');
  };
  if (!policy || typeof policy !== 'object') bad('a policy is required');
  for (const [name, value] of [
    ['disagreementTolerance', policy.disagreementTolerance],
    ['entropyTolerance', policy.entropyTolerance],
    ['minimumConfidence', policy.minimumConfidence],
  ] as const) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      bad(`policy.${name} must be a finite non-negative number; got ${JSON.stringify(value)}`);
    }
  }
  if (policy.minimumConfidence > 1) {
    bad(`policy.minimumConfidence is a 0–1 probability; got ${policy.minimumConfidence}`);
  }
  if (policy.headlineTier !== 'undeclared' && !Array.isArray(policy.headlineTier)) {
    bad("policy.headlineTier must be a model-id array or the literal 'undeclared'");
  }
  const s = policy.sampling;
  if (!s || typeof s !== 'object') bad('policy.sampling is required');
  if (typeof s.fraction !== 'number' || !Number.isFinite(s.fraction) || s.fraction <= 0 || s.fraction > 1) {
    // Zero is refused rather than accepted as "audit disabled". M2.6 requires a
    // stratified sample of otherwise-unflagged cases precisely so the unflagged
    // population is not assumed correct; a rate of zero is that assumption
    // wearing a config field.
    bad(
      `policy.sampling.fraction must be in (0, 1]; got ${JSON.stringify(s.fraction)} ` +
        '(a zero-rate audit assumes the unflagged population correct, which is what the audit exists to test)',
    );
  }
  if (!Number.isInteger(s.minimumPerStratum) || s.minimumPerStratum < 1) {
    bad(`policy.sampling.minimumPerStratum must be an integer ≥ 1; got ${JSON.stringify(s.minimumPerStratum)}`);
  }
  if (typeof s.seed !== 'string' || s.seed.trim() === '') bad('policy.sampling.seed must be a non-empty string');
  if (typeof s.preregisteredIn !== 'string' || s.preregisteredIn.trim() === '') {
    bad(
      'policy.sampling.preregisteredIn must name where the plan was frozen; an unrecorded sampling plan cannot be shown to predate the flags',
    );
  }
  const c = policy.coverage;
  if (!c || typeof c !== 'object') {
    bad('policy.coverage is required — pass UNVALIDATED_COVERAGE if no holdout has passed');
  }
  if (!['pass', 'fail', 'not-run'].includes(c.verdict)) {
    bad(`policy.coverage.verdict must be pass | fail | not-run; got ${JSON.stringify(c.verdict)}`);
  }
  if (typeof c.validatedBy !== 'string' || c.validatedBy.trim() === '') {
    bad('policy.coverage.validatedBy must name the holdout attempt the coverage claim rests on');
  }
  if (!Array.isArray(c.strata)) bad('policy.coverage.strata must be an array');
  if (c.verdict === 'pass' && c.strata.length === 0) {
    bad('policy.coverage claims a passing holdout but names no covered stratum; a pass over nothing covers nothing');
  }
  for (const challenge of policy.challenges ?? []) {
    if (!challenge?.questionId?.trim() || !challenge?.raisedBy?.trim() || !challenge?.detail?.trim()) {
      bad('every reference challenge needs questionId, raisedBy and detail — an anonymous, unexplained challenge cannot be adjudicated');
    }
  }
}

/* -------------------------------------------------------------------------- */
/* the queue                                                                  */
/* -------------------------------------------------------------------------- */

export interface ReviewTrigger {
  reason: MandatoryReviewReason;
  /** Why it fired, in the reviewer's terms. */
  detail: string;
}

export interface AdjudicationCase {
  /** Digest of (runId, questionId, sorted candidates). Not a joined string. */
  caseId: string;
  runId: string;
  questionId: string;
  /** In observation order. Presentation order is `blindOrder`, not this. */
  candidates: readonly string[];
  mode: JudgementMode;
  stratum: string;
  critical: boolean;
  /** Sorted, deduplicated, never empty. */
  reasons: readonly MandatoryReviewReason[];
  triggers: readonly ReviewTrigger[];
  disagreement: number | null;
  entropy: number | null;
  confidence: number | null;
  orderUnstable: boolean;
  /** What automation would have published. Kept so an override is comparable. */
  provisionalScore: number | null;
  seats: readonly SeatVerdict[];
  prompt: string;
  answers: readonly ObservedAnswer[];
  /**
   * Indices into `answers`, in the order a blinded reviewer sees them. Derived
   * from the case id so it is reproducible, and recorded so the decision can be
   * mapped back to a candidate afterwards.
   */
  blindOrder: readonly number[];
}

export interface StratumPopulation {
  stratum: string;
  /** Every observation in this stratum. */
  total: number;
  /** Queued because a mandatory category fired. */
  mandatory: number;
  /** Queued by the stratified audit draw alone. */
  sampled: number;
}

export interface AdjudicationQueue {
  version: 1;
  runId: string;
  policy: AdjudicationPolicy;
  /** Sorted by caseId, so the artifact diffs cleanly. */
  cases: readonly AdjudicationCase[];
  population: readonly StratumPopulation[];
  /**
   * sha256 over the whole queue except this field. The record binds to it, so
   * decisions taken against one queue cannot be presented as clearance for a
   * different one — a re-judged answer or a re-authored item changes the hash
   * and the report gate reopens.
   */
  queueHash: string;
}

/** Stable case identity: a digest, not a delimiter-joined string. */
export function caseIdFor(runId: string, questionId: string, candidates: readonly string[]): string {
  // A joined string collides on free-text ids: question "a::b" + candidate "c"
  // and question "a" + candidate "b::c" produce the same key, and every
  // duplicate guard below is built on this value. Candidates are sorted so one
  // pair is one case whichever order it was observed in.
  return sha256Hex(canonicalJson([runId, questionId, [...candidates].sort()])).slice(0, 32);
}

function assertObservation(o: PanelObservation): void {
  const bad = (msg: string): never => {
    throw new AdjudicationError(`observation ${o?.questionId ?? '(no question)'}: ${msg}`, 'INVALID_OBSERVATION');
  };
  if (!o || typeof o !== 'object') bad('is not an object');
  if (!o.runId?.trim()) bad('runId is required');
  if (!o.questionId?.trim()) bad('questionId is required');
  if (!Array.isArray(o.candidates) || o.candidates.length === 0) bad('at least one candidate is required');
  if (!o.stratum?.trim()) {
    bad('stratum is required — an unstratified case can be neither audit-sampled nor covered by an automation claim');
  }
  if (!Array.isArray(o.seats) || o.seats.length === 0) {
    bad('at least one seat verdict is required; a case with no recorded verdict is an incident, not an automated result');
  }
  if (!Array.isArray(o.answers) || o.answers.length === 0) bad('at least one answer is required');
  for (const candidate of o.candidates) {
    if (!o.answers.some((a) => a.modelId === candidate)) {
      bad(`candidate ${candidate} has no answer text; a reviewer cannot adjudicate an answer they cannot read`);
    }
  }
  if (o.mode === 'pairwise' && o.candidates.length !== 2) {
    bad(`pairwise mode needs exactly two candidates, got ${o.candidates.length}`);
  }
}

/** Deterministic per-case draw. Never a shared stream — see analyze.ts. */
function caseUniform(seed: string, scope: string, caseId: string): number {
  return fnv1a32(`${seed}:${scope}:${caseId}`) / 0x100000000;
}

/**
 * Critical-safety triggers (M2.6 "any safety disagreement", M2.2 "never
 * LLM-only").
 *
 * Two separate faults, kept separate so the audit can count them apart:
 *  - seats disagreeing about whether a critical failure is present;
 *  - a critical failure that only an LLM judge ever asserted, which M2.2 says
 *    may not be accepted on that evidence alone.
 *
 * Evidence with no declared provenance counts as `llm-judge`. That is the
 * conservative reading and it is the right one: the legacy panel records no
 * provenance at all, and reading "unlabelled" as "deterministic" would exempt
 * every historical safety finding from the rule written to catch them.
 */
function safetyTriggers(o: PanelObservation): ReviewTrigger[] {
  const triggers: ReviewTrigger[] = [];
  const seatsFlaggingCritical = o.seats.filter(
    (s) => (s.criticalTags?.length ?? 0) > 0 || s.evidence.some((e) => e.severity === 'critical'),
  );
  if (seatsFlaggingCritical.length > 0 && seatsFlaggingCritical.length < o.seats.length) {
    triggers.push({
      reason: 'safety-disagreement',
      detail:
        `${seatsFlaggingCritical.length} of ${o.seats.length} seats raised a critical failure ` +
        `(${seatsFlaggingCritical.map((s) => s.judgeModel).join(', ')}); the rest did not`,
    });
  }
  const criticalEvidence = o.seats.flatMap((s) => s.evidence.filter((e) => e.severity === 'critical'));
  if (criticalEvidence.length > 0) {
    const corroborated = criticalEvidence.some((e) => e.provenance === 'deterministic' || e.provenance === 'human');
    if (!corroborated) {
      triggers.push({
        reason: 'safety-llm-only',
        detail:
          'every critical finding on this case rests on LLM-judge evidence; M2.2 requires a deterministic rule ' +
          'or a relevant human specialist to confirm a safety-critical case',
      });
    }
  }
  return triggers;
}

function mandatoryTriggers(
  o: PanelObservation,
  policy: AdjudicationPolicy,
  covered: ReadonlySet<string>,
  challengedQuestions: ReadonlySet<string>,
): ReviewTrigger[] {
  const triggers: ReviewTrigger[] = [...safetyTriggers(o)];

  if (o.disagreement !== null && o.disagreement > policy.disagreementTolerance) {
    triggers.push({
      reason: 'split-beyond-tolerance',
      detail: `cross-seat spread ${o.disagreement} exceeds the declared tolerance of ${policy.disagreementTolerance} points`,
    });
  }

  const inCoverage = covered.has(o.stratum);

  // Entropy is only defined over rater-unit OUTCOMES, which is a pairwise
  // notion. Escalating a null on a dimension route would double-count the
  // spread `split-beyond-tolerance` already covers, so it is checked only where
  // the statistic exists — and there, an unmeasured entropy escalates.
  if (o.mode === 'pairwise' && !inCoverage) {
    if (o.entropy === null) {
      triggers.push({
        reason: 'entropy-outside-coverage',
        detail: `stratum "${o.stratum}" is outside validated automation coverage and the panel recorded no vote entropy; unmeasured is not unanimous`,
      });
    } else if (o.entropy > policy.entropyTolerance) {
      triggers.push({
        reason: 'entropy-outside-coverage',
        detail: `vote entropy ${o.entropy.toFixed(3)} bits exceeds ${policy.entropyTolerance} and stratum "${o.stratum}" is outside validated automation coverage`,
      });
    }
  }

  if (!inCoverage) {
    if (o.confidence === null) {
      triggers.push({
        reason: 'confidence-outside-coverage',
        detail: `stratum "${o.stratum}" is outside validated automation coverage and no seat recorded a confidence; absent confidence is unmeasured, never certain`,
      });
    } else if (o.confidence < policy.minimumConfidence) {
      triggers.push({
        reason: 'confidence-outside-coverage',
        detail: `panel confidence ${o.confidence.toFixed(3)} is below ${policy.minimumConfidence} and stratum "${o.stratum}" is outside validated automation coverage`,
      });
    }
  }

  if (o.orderUnstable) {
    const tier = policy.headlineTier;
    if (tier === 'undeclared') {
      triggers.push({
        reason: 'order-unstable-headline',
        detail:
          'the two presentations disagreed and no headline tier has been declared, so it cannot be shown that this pair affects none',
      });
    } else {
      const affected = o.candidates.filter((c) => tier.includes(c));
      if (affected.length > 0) {
        triggers.push({
          reason: 'order-unstable-headline',
          detail: `order-unstable pair involving declared headline-tier model(s) ${affected.join(', ')}`,
        });
      }
    }
  }

  if (challengedQuestions.has(o.questionId)) {
    triggers.push({
      reason: 'challenged-reference',
      detail: `the reference or judge pack for ${o.questionId} has been challenged; M2.6 reviews all challenged references regardless of panel agreement`,
    });
  }

  return triggers;
}

export interface BuildQueueInput {
  runId: string;
  observations: readonly PanelObservation[];
  policy: AdjudicationPolicy;
}

/**
 * Derive the mandatory review set and the stratified audit sample.
 *
 * Two-pass by necessity: the audit sample is drawn from *otherwise-unflagged*
 * cases, so every mandatory category has to be evaluated first. Drawing first
 * and subtracting afterwards would shrink the audit by however many of its
 * draws happened to be flagged, which is exactly the wrong direction — a run
 * with more disputes would get less independent auditing.
 */
export function buildAdjudicationQueue(input: BuildQueueInput): AdjudicationQueue {
  assertPolicy(input.policy);
  if (!input.runId?.trim()) throw new AdjudicationError('runId is required', 'INVALID_POLICY');

  const covered = coveredStrata(input.policy.coverage);
  const challenged = new Set((input.policy.challenges ?? []).map((c) => c.questionId));

  interface Entry {
    o: PanelObservation;
    caseId: string;
    triggers: ReviewTrigger[];
  }
  const entries: Entry[] = [];
  const seen = new Set<string>();
  for (const o of input.observations) {
    assertObservation(o);
    if (o.runId !== input.runId) {
      throw new AdjudicationError(
        `observation for ${o.questionId} belongs to run ${o.runId}, not ${input.runId}; a queue mixing runs cannot gate either one's report`,
        'INVALID_OBSERVATION',
      );
    }
    const caseId = caseIdFor(o.runId, o.questionId, o.candidates);
    if (seen.has(caseId)) {
      // Two observations of one (run, item, candidate set). Keeping either
      // silently leaves the other unadjudicated while the queue reports
      // complete, which is the exact failure this module exists to prevent.
      throw new AdjudicationError(
        `duplicate observation for ${o.questionId} / ${o.candidates.join(' vs ')}; one case cannot carry two panel results`,
        'DUPLICATE_CASE',
      );
    }
    seen.add(caseId);
    entries.push({ o, caseId, triggers: mandatoryTriggers(o, input.policy, covered, challenged) });
  }

  // Stratified audit of everything the mandatory categories did not catch.
  const unflaggedByStratum = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.triggers.length > 0) continue;
    const bucket = unflaggedByStratum.get(e.o.stratum) ?? [];
    bucket.push(e);
    unflaggedByStratum.set(e.o.stratum, bucket);
  }
  const { seed, fraction, minimumPerStratum } = input.policy.sampling;
  for (const [stratum, bucket] of unflaggedByStratum) {
    const target = Math.min(bucket.length, Math.max(minimumPerStratum, Math.ceil(fraction * bucket.length)));
    const ordered = [...bucket].sort((a, b) => {
      const ua = caseUniform(seed, `audit:${stratum}`, a.caseId);
      const ub = caseUniform(seed, `audit:${stratum}`, b.caseId);
      // Tie-break on the case id so the draw is total even if two ids land in
      // the same 32-bit bucket; without it the order depends on Array.sort's
      // stability over the input order, which is not part of the artifact.
      return ua === ub ? a.caseId.localeCompare(b.caseId) : ua - ub;
    });
    for (const e of ordered.slice(0, target)) {
      e.triggers.push({
        reason: 'stratified-audit-sample',
        detail: `drawn into the preregistered audit of unflagged cases in stratum "${stratum}" (${target} of ${bucket.length}, plan ${input.policy.sampling.preregisteredIn})`,
      });
    }
  }

  const cases: AdjudicationCase[] = entries
    .filter((e) => e.triggers.length > 0)
    .map((e) => {
      const reasons = [...new Set(e.triggers.map((t) => t.reason))].sort();
      const c: AdjudicationCase = {
        caseId: e.caseId,
        runId: e.o.runId,
        questionId: e.o.questionId,
        candidates: [...e.o.candidates],
        mode: e.o.mode,
        stratum: e.o.stratum,
        critical: e.o.critical ?? false,
        reasons,
        triggers: [...e.triggers].sort((a, b) => a.reason.localeCompare(b.reason)),
        disagreement: e.o.disagreement,
        entropy: e.o.entropy,
        confidence: e.o.confidence,
        orderUnstable: e.o.orderUnstable ?? false,
        provisionalScore: e.o.provisionalScore,
        seats: e.o.seats.map((s) => ({ ...s, evidence: [...s.evidence] })),
        prompt: e.o.prompt,
        answers: e.o.answers.map((a) => ({ ...a })),
        blindOrder: blindOrderFor(e.caseId, e.o.answers.length, seed),
      };
      return c;
    })
    .sort((a, b) => a.caseId.localeCompare(b.caseId));

  const strata = [...new Set(entries.map((e) => e.o.stratum))].sort();
  const population: StratumPopulation[] = strata.map((stratum) => {
    const inStratum = cases.filter((c) => c.stratum === stratum);
    return {
      stratum,
      total: entries.filter((e) => e.o.stratum === stratum).length,
      mandatory: inStratum.filter((c) => c.reasons.some((r) => r !== 'stratified-audit-sample')).length,
      sampled: inStratum.filter((c) => c.reasons.length === 1 && c.reasons[0] === 'stratified-audit-sample').length,
    };
  });

  const body = { version: 1 as const, runId: input.runId, policy: input.policy, cases, population };
  return { ...body, queueHash: sha256Hex(canonicalJson(body)) };
}

/** Recompute the hash a queue should carry. Used by the report gate. */
export function queueHashOf(queue: AdjudicationQueue): string {
  const { queueHash: _stored, ...body } = queue;
  return sha256Hex(canonicalJson(body));
}

/**
 * Deterministic presentation order for the blinded reviewer.
 *
 * Answers arrive in whatever order the pipeline produced them, which on a
 * leaderboard-driven pipeline correlates with rank. Showing them in that order
 * hands a blinded reviewer the ranking back.
 */
function blindOrderFor(caseId: string, n: number, seed: string): number[] {
  return Array.from({ length: n }, (_unused, i) => i).sort((a, b) => {
    const ua = caseUniform(seed, `blind:${a}`, caseId);
    const ub = caseUniform(seed, `blind:${b}`, caseId);
    return ua === ub ? a - b : ua - ub;
  });
}

/* -------------------------------------------------------------------------- */
/* presentation                                                               */
/* -------------------------------------------------------------------------- */

export interface PresentationOptions {
  /**
   * No default. A reviewer either sees candidate and seat identities or does
   * not, and which one it is has to be a decision somebody made at the call
   * site — a default would make blinding an accident of not passing an option.
   */
  identity: 'blind' | 'revealed';
  /**
   * Required when `identity` is 'blind'. Answer text self-identifies ("as an
   * Anthropic model…"), so hiding the label while printing the text verbatim is
   * half a blind and reads as a whole one. Pass
   * `(t) => anonymizeAnswer(t, blindingLexicon(loadModels()))` from judge.ts.
   */
  anonymise?: (text: string) => string;
}

/**
 * Render one case for a human reviewer: the question, every answer, and every
 * seat's verdict with the evidence it cited.
 *
 * The seat labels are blinded along with the candidates. A reviewer who knows
 * which seat said what brings the same brand priors to the dispute that the
 * jury blinding exists to keep out of the scores, and the mapping is in the
 * queue artifact for anyone reconstructing the decision afterwards.
 */
export function presentCase(c: AdjudicationCase, options: PresentationOptions): string {
  if (!options || (options.identity !== 'blind' && options.identity !== 'revealed')) {
    throw new AdjudicationError(
      `presentation identity must be 'blind' or 'revealed'; got ${JSON.stringify(options?.identity)}`,
      'PRESENTATION_UNBLINDED',
    );
  }
  const blind = options.identity === 'blind';
  const anonymise = options.anonymise;
  if (blind && typeof anonymise !== 'function') {
    throw new AdjudicationError(
      'blind presentation requires an `anonymise` function: answer text self-identifies, so a blinded label over verbatim text is not a blind',
      'PRESENTATION_UNBLINDED',
    );
  }
  const show = (text: string) => (blind && anonymise ? anonymise(text) : text);

  const lines: string[] = [];
  lines.push(`CASE ${c.caseId}`);
  lines.push(
    `  item        ${c.questionId}  (${c.mode}, stratum "${c.stratum}"${c.critical ? ', CRITICAL SAFETY' : ''})`,
  );
  if (!blind) lines.push(`  candidates  ${c.candidates.join(', ')}`);
  lines.push(`  reasons     ${c.reasons.join(', ')}`);
  for (const t of c.triggers) lines.push(`    - ${t.reason}: ${t.detail}`);
  lines.push(
    `  automation  provisional ${c.provisionalScore ?? 'none'}` +
      `, spread ${c.disagreement ?? 'unrecorded'}` +
      `, entropy ${c.entropy ?? 'unrecorded'}` +
      `, confidence ${c.confidence ?? 'unrecorded'}`,
  );
  lines.push('');
  lines.push('  QUESTION');
  lines.push(indent(c.prompt, 4));
  lines.push('');
  c.blindOrder.forEach((answerIndex, position) => {
    const answer = c.answers[answerIndex];
    if (!answer) return;
    const label = blind ? `ANSWER ${position + 1}` : `ANSWER ${position + 1} — ${answer.modelId}`;
    lines.push(`  ${label}`);
    lines.push(indent(show(answer.text), 4));
    lines.push('');
  });
  c.seats.forEach((seat, i) => {
    const label = blind
      ? `SEAT ${i + 1}`
      : `SEAT ${i + 1} — ${seat.judgeModel}${seat.judgeFamily ? ` (${seat.judgeFamily})` : ''}`;
    lines.push(`  ${label}`);
    lines.push(`    score ${seat.score ?? 'abstained'}, confidence ${seat.confidence ?? 'unrecorded'}`);
    if (seat.criticalTags?.length) {
      lines.push(
        `    critical tags: ${blind ? `${seat.criticalTags.length} candidate(s)` : seat.criticalTags.join(', ')}`,
      );
    }
    if (seat.summary) lines.push(indent(show(seat.summary), 4));
    for (const e of seat.evidence) {
      const severity = e.severity ?? 'unrated';
      const provenance = e.provenance ?? 'llm-judge (undeclared)';
      lines.push(`    [${severity}/${provenance}] ${show(e.statement)}`);
      if (e.quote) lines.push(`      quote: ${JSON.stringify(show(e.quote))}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((l) => `${pad}${l}`)
    .join('\n');
}

/* -------------------------------------------------------------------------- */
/* the recorded decision                                                      */
/* -------------------------------------------------------------------------- */

export const REVIEW_DECISIONS = ['uphold', 'override', 'item-defective'] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

/**
 * Who decided.
 *
 * `provenance` accepts the single value `'human'`, for the same reason
 * `judgeBenchLabelSetSchema` refuses `model`: an adjudication resolved by a
 * model is the panel grading its own dispute. There is no code path that
 * accepts any other value.
 */
export interface Reviewer {
  id: string;
  role: string;
  /** What makes this person qualified to resolve this dispute. */
  qualification: string;
  /** Independent of the item's author and of the panel's operator. */
  independent: boolean;
  provenance: 'human';
}

export interface AdjudicationDecision {
  caseId: string;
  decision: ReviewDecision;
  /** What the decision rests on. Checked for placeholders. */
  evidence: string;
  /**
   * 0–1. Required: an adjudication with no stated confidence reads as certainty
   * to everything downstream, and M2.6 asks for it explicitly.
   */
  confidence: number;
  reviewer: Reviewer;
  decidedAt: string;
  /** Required for `override`, refused otherwise. */
  overrideScore?: number;
  /** M2.6: whether the item must change. Required, not optional. */
  itemChangeRequired: boolean;
  /** M2.6: whether the judge prompt must change. Required, not optional. */
  judgePromptChangeRequired: boolean;
  /** Required when either flag is true — a change nobody described is not actionable. */
  changeNote?: string;
  /** Required for `item-defective`. */
  defect?: string;
}

export interface AdjudicationRecord {
  version: 1;
  runId: string;
  /** The queue these decisions clear. Binding, not informational. */
  queueHash: string;
  decisions: readonly AdjudicationDecision[];
}

/** Placeholders a half-filled worksheet leaves behind. Never evidence. */
const EVIDENCE_PLACEHOLDERS = new Set(['todo', 'tbd', 'n/a', 'na', '-', '?', 'ok', 'fine', 'agreed', 'looks right']);

const DECISION_KEYS = [
  'caseId',
  'decision',
  'evidence',
  'confidence',
  'reviewer',
  'decidedAt',
  'overrideScore',
  'itemChangeRequired',
  'judgePromptChangeRequired',
  'changeNote',
  'defect',
] as const;
const REVIEWER_KEYS = ['id', 'role', 'qualification', 'independent', 'provenance'] as const;

function parseReviewer(value: unknown, path: string, faults: Faults): Reviewer | undefined {
  if (!isRecord(value)) {
    faults.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(value, REVIEWER_KEYS, path, faults);
  const id = reqString(value, 'id', path, faults);
  const role = reqString(value, 'role', path, faults);
  const qualification = reqString(value, 'qualification', path, faults);
  const independent = reqBoolean(value, 'independent', path, faults);
  const provenance = value['provenance'];
  if (provenance !== 'human') {
    faults.push(
      `${path}.provenance: must be the literal "human"; got ${JSON.stringify(provenance)} — an adjudication resolved by a model is the panel grading its own dispute`,
    );
  }
  if (id === undefined || role === undefined || qualification === undefined || independent === undefined || provenance !== 'human') {
    return undefined;
  }
  return { id, role, qualification, independent, provenance: 'human' };
}

function parseDecision(value: unknown, path: string, faults: Faults): AdjudicationDecision | undefined {
  if (!isRecord(value)) {
    faults.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(value, DECISION_KEYS, path, faults);
  const caseId = reqString(value, 'caseId', path, faults);
  const decision = reqEnum(value, 'decision', path, faults, REVIEW_DECISIONS);
  const evidenceRaw = value['evidence'];
  let evidence: string | undefined;
  if (typeof evidenceRaw !== 'string') {
    faults.push(`${path}.evidence: expected a string, got ${JSON.stringify(evidenceRaw)}`);
  } else {
    const trimmed = evidenceRaw.trim();
    if (trimmed === '' || EVIDENCE_PLACEHOLDERS.has(trimmed.toLowerCase()) || trimmed.toLowerCase() === decision) {
      faults.push(
        `${path}.evidence: ${JSON.stringify(evidenceRaw)} restates the decision or is a placeholder; M2.6 records the evidence the decision rests on, not that one was taken`,
      );
    } else {
      evidence = evidenceRaw;
    }
  }
  const confidence = reqNumber(value, 'confidence', path, faults, { min: 0, max: 1 });
  const reviewer = parseReviewer(value['reviewer'], `${path}.reviewer`, faults);
  const decidedAt = reqString(value, 'decidedAt', path, faults);
  const overrideScore = optNumber(value, 'overrideScore', path, faults, { min: 0, max: 100 });
  const itemChangeRequired = reqBoolean(value, 'itemChangeRequired', path, faults);
  const judgePromptChangeRequired = reqBoolean(value, 'judgePromptChangeRequired', path, faults);
  const changeNote = optString(value, 'changeNote', path, faults);
  const defect = optString(value, 'defect', path, faults);

  if (decision === 'override' && overrideScore === undefined) {
    faults.push(`${path}.overrideScore: an override must state the score that replaces the panel's`);
  }
  if (decision !== undefined && decision !== 'override' && value['overrideScore'] !== undefined) {
    // A stored override score beside "uphold" is ambiguous, and the ambiguity
    // resolves in whichever direction the reader's code happens to check first.
    // Refuse it here rather than pick a winner later.
    faults.push(`${path}.overrideScore: only meaningful on an override; ${decision} must not carry one`);
  }
  if (decision === 'item-defective') {
    if (defect === undefined) faults.push(`${path}.defect: marking an item defective requires describing the defect`);
    if (itemChangeRequired === false) {
      faults.push(
        `${path}.itemChangeRequired: an item declared defective whose item need not change is incoherent; one of the two is wrong`,
      );
    }
  }
  if ((itemChangeRequired || judgePromptChangeRequired) && changeNote === undefined) {
    faults.push(`${path}.changeNote: a required change must say what changes; an unrecorded change request is never actioned`);
  }

  if (
    caseId === undefined ||
    decision === undefined ||
    evidence === undefined ||
    confidence === undefined ||
    reviewer === undefined ||
    decidedAt === undefined ||
    itemChangeRequired === undefined ||
    judgePromptChangeRequired === undefined
  ) {
    return undefined;
  }
  return {
    caseId,
    decision,
    evidence,
    confidence,
    reviewer,
    decidedAt,
    itemChangeRequired,
    judgePromptChangeRequired,
    ...(overrideScore === undefined ? {} : { overrideScore }),
    ...(changeNote === undefined ? {} : { changeNote }),
    ...(defect === undefined ? {} : { defect }),
  };
}

const RECORD_KEYS = ['version', 'runId', 'queueHash', 'decisions'] as const;

export function parseAdjudicationRecord(value: unknown): AdjudicationRecord {
  const faults: Faults = [];
  if (!isRecord(value)) {
    throw new AdjudicationError('invalid adjudication record: expected an object', 'INVALID_RECORD');
  }
  rejectUnknownKeys(value, RECORD_KEYS, '(root)', faults);
  if (value['version'] !== 1) faults.push(`(root).version: expected 1, got ${JSON.stringify(value['version'])}`);
  const runId = reqString(value, 'runId', '(root)', faults);
  const queueHash = value['queueHash'];
  if (typeof queueHash !== 'string' || !/^[0-9a-f]{64}$/.test(queueHash)) {
    faults.push(`(root).queueHash: expected a 64-character sha256 hex digest, got ${JSON.stringify(queueHash)}`);
  }
  const rawDecisions = value['decisions'];
  const decisions: AdjudicationDecision[] = [];
  if (!Array.isArray(rawDecisions)) {
    faults.push(`(root).decisions: expected an array, got ${JSON.stringify(rawDecisions)}`);
  } else {
    const seen = new Set<string>();
    rawDecisions.forEach((raw, i) => {
      const parsed = parseDecision(raw, `decisions[${i}]`, faults);
      if (!parsed) return;
      if (seen.has(parsed.caseId)) {
        // Two decisions on one case: whichever the reader takes is arbitrary,
        // and "last wins" would let an override be quietly reversed by
        // appending an uphold.
        faults.push(`decisions[${i}].caseId: case ${parsed.caseId} is decided twice; a case has one adjudication`);
        return;
      }
      seen.add(parsed.caseId);
      decisions.push(parsed);
    });
  }
  if (faults.length > 0) {
    throw new AdjudicationError(`invalid adjudication record:\n- ${faults.join('\n- ')}`, 'INVALID_RECORD');
  }
  return { version: 1, runId: runId!, queueHash: queueHash as string, decisions };
}

export function serialiseAdjudicationRecord(record: AdjudicationRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** An empty record bound to a queue — the worksheet a reviewer starts from. */
export function blankRecordFor(queue: AdjudicationQueue): AdjudicationRecord {
  return { version: 1, runId: queue.runId, queueHash: queue.queueHash, decisions: [] };
}

/* -------------------------------------------------------------------------- */
/* status and the report gate                                                 */
/* -------------------------------------------------------------------------- */

export interface PendingCase {
  caseId: string;
  questionId: string;
  reasons: readonly MandatoryReviewReason[];
  /** Why this case is still pending — undecided, or decided unacceptably. */
  why: string;
}

export interface AdjudicationStatus {
  runId: string;
  queueHash: string;
  total: number;
  decided: number;
  pending: readonly PendingCase[];
  /** Decisions whose caseId is not in the queue. Never silently ignored. */
  unknownDecisions: readonly string[];
  /** The record binds to a different queue than the one supplied. */
  queueMismatch: boolean;
  complete: boolean;
}

/**
 * Compare a queue against a record.
 *
 * A case counts as resolved only when it has a decision AND, if it is a
 * critical safety case, that decision came from a reviewer who declared
 * independence — M2.7 requires qualified independent review of every critical
 * safety case, and a sign-off from the panel's own operator is not that.
 */
export function adjudicationStatus(
  queue: AdjudicationQueue,
  record: AdjudicationRecord | null,
): AdjudicationStatus {
  const expected = queueHashOf(queue);
  const queueMismatch = record !== null && record.queueHash !== expected;
  const byCase = new Map((record?.decisions ?? []).map((d) => [d.caseId, d]));
  const known = new Set(queue.cases.map((c) => c.caseId));

  const pending: PendingCase[] = [];
  let decided = 0;
  for (const c of queue.cases) {
    const decision = queueMismatch ? undefined : byCase.get(c.caseId);
    if (!decision) {
      pending.push({
        caseId: c.caseId,
        questionId: c.questionId,
        reasons: c.reasons,
        why: queueMismatch ? 'the record binds to a different queue' : 'no decision recorded',
      });
      continue;
    }
    if (c.critical && !decision.reviewer.independent) {
      pending.push({
        caseId: c.caseId,
        questionId: c.questionId,
        reasons: c.reasons,
        why: `critical safety case decided by ${decision.reviewer.id}, who did not declare independence`,
      });
      continue;
    }
    decided++;
  }

  const unknownDecisions = (record?.decisions ?? [])
    .map((d) => d.caseId)
    .filter((id) => !known.has(id))
    .sort();

  return {
    runId: queue.runId,
    queueHash: expected,
    total: queue.cases.length,
    decided,
    pending,
    unknownDecisions,
    queueMismatch,
    complete: !queueMismatch && pending.length === 0,
  };
}

export interface ReportPermission {
  permitted: boolean;
  /** Empty iff permitted. Each entry is publishable as-is. */
  reasons: readonly string[];
  status: AdjudicationStatus | null;
}

/**
 * THE GATE. No report may be generated while adjudications are pending.
 *
 * Fails closed in every direction, and the directions matter:
 *
 *  - `queue: null` refuses. A report path that never built the queue has not
 *    established that there is nothing to review; it has established nothing.
 *    This is the inversion the whole module turns on — in `2026-07-v2.1` the
 *    absence of an adjudication step read as permission to publish.
 *  - `record: null` refuses whenever the queue holds a case, and permits when
 *    it holds none. An empty queue is a computed result; a missing record is
 *    not.
 *  - a queue-hash mismatch refuses, because decisions taken over one set of
 *    answers say nothing about another.
 *  - a stale decision for a case outside the queue is reported, and blocks. It
 *    means the reviewer worked from a different worksheet, so their other
 *    decisions cannot be assumed to be about the cases they now match by id.
 */
export function reportPermitted(input: {
  queue: AdjudicationQueue | null;
  record: AdjudicationRecord | null;
}): ReportPermission {
  if (!input.queue) {
    return {
      permitted: false,
      reasons: [
        'no adjudication queue was built for this run; an unbuilt queue is not an empty one, and a report cannot be shown to clear M2.6 without one',
      ],
      status: null,
    };
  }
  const status = adjudicationStatus(input.queue, input.record);
  const reasons: string[] = [];
  if (input.record === null && input.queue.cases.length > 0) {
    reasons.push(
      `${input.queue.cases.length} case(s) require human adjudication and no adjudication record exists for run ${input.queue.runId}`,
    );
  }
  if (status.queueMismatch) {
    reasons.push(
      `the adjudication record binds to queue ${input.record?.queueHash.slice(0, 12)}… but the current queue is ${status.queueHash.slice(0, 12)}…; the evidence changed after the decisions were taken`,
    );
  }
  if (status.pending.length > 0) {
    const head = status.pending
      .slice(0, 5)
      .map((p) => `${p.questionId} (${p.caseId.slice(0, 8)}…): ${p.why}`)
      .join('; ');
    reasons.push(
      `${status.pending.length} of ${status.total} adjudication case(s) are pending: ${head}${status.pending.length > 5 ? '; …' : ''}`,
    );
  }
  if (status.unknownDecisions.length > 0) {
    reasons.push(
      `${status.unknownDecisions.length} decision(s) refer to cases that are not in the queue: ${status.unknownDecisions.slice(0, 5).join(', ')}`,
    );
  }
  return { permitted: reasons.length === 0, reasons, status };
}

/** `reportPermitted`, as an assertion for the report path to call. */
export function assertReportPermitted(input: {
  queue: AdjudicationQueue | null;
  record: AdjudicationRecord | null;
}): void {
  const permission = reportPermitted(input);
  if (permission.permitted) return;
  throw new AdjudicationError(
    `Refusing to generate a report while adjudications are pending (M2.6):\n- ${permission.reasons.join('\n- ')}`,
    'REPORT_BLOCKED',
  );
}

/* -------------------------------------------------------------------------- */
/* applying a decision                                                        */
/* -------------------------------------------------------------------------- */

export interface ResolvedScore {
  /** null means the case contributes no score at all. */
  score: number | null;
  /** True when the item is excluded from this model's denominator. */
  excluded: boolean;
  reason: string;
}

/**
 * Turn one adjudication into the number (or absence of one) that counts.
 *
 * The branch worth reading twice is `item-defective`: it excludes, it does not
 * score zero. A defective item is missing data about the model, and scoring it
 * 0 charges the model for the benchmark's own fault — which is precisely what
 * the 2026-07 grader audit found `subs-020` doing to twelve of thirteen models.
 * Excluding shrinks the denominator, which the leaderboard already knows how to
 * surface (`unjudged`).
 */
export function resolveAdjudicatedScore(
  c: AdjudicationCase,
  decision: AdjudicationDecision,
): ResolvedScore {
  if (decision.caseId !== c.caseId) {
    throw new AdjudicationError(`decision for ${decision.caseId} applied to case ${c.caseId}`, 'INVALID_RECORD');
  }
  if (decision.decision === 'uphold') {
    return {
      score: c.provisionalScore,
      excluded: c.provisionalScore === null,
      reason:
        c.provisionalScore === null
          ? 'upheld, but the panel produced no score to uphold; the case contributes nothing'
          : 'panel result upheld on review',
    };
  }
  if (decision.decision === 'override') {
    return {
      score: decision.overrideScore ?? null,
      excluded: decision.overrideScore === undefined,
      reason: `overridden by ${decision.reviewer.id}`,
    };
  }
  return {
    score: null,
    excluded: true,
    reason: `item declared defective (${decision.defect ?? 'no defect recorded'}); excluded, not scored zero`,
  };
}

/* -------------------------------------------------------------------------- */
/* summary printing                                                           */
/* -------------------------------------------------------------------------- */

export function formatAdjudicationQueue(queue: AdjudicationQueue): string[] {
  const lines: string[] = [];
  lines.push(
    `Adjudication queue for ${queue.runId} — ${queue.cases.length} case(s), hash ${queue.queueHash.slice(0, 12)}…`,
  );
  const byReason = new Map<MandatoryReviewReason, number>();
  for (const c of queue.cases) for (const r of c.reasons) byReason.set(r, (byReason.get(r) ?? 0) + 1);
  for (const reason of MANDATORY_REVIEW_REASONS) {
    const n = byReason.get(reason) ?? 0;
    if (n > 0) lines.push(`  ${reason.padEnd(30)} ${n}`);
  }
  lines.push(`  ${'critical safety cases'.padEnd(30)} ${queue.cases.filter((c) => c.critical).length}`);
  lines.push('  by stratum (queued / total):');
  for (const p of queue.population) {
    lines.push(
      `    ${p.stratum.padEnd(28)} ${p.mandatory + p.sampled} / ${p.total}   (mandatory ${p.mandatory}, audit ${p.sampled})`,
    );
  }
  if (queue.policy.coverage.verdict !== 'pass') {
    lines.push(
      `  NOTE: automation coverage is "${queue.policy.coverage.verdict}" (${queue.policy.coverage.validatedBy}), so no stratum is validated ` +
        'and every case with an unmeasured confidence is mandatory review. That is the size of the unvalidated automatic acceptance, not a bug.',
    );
  }
  return lines;
}

export function formatAdjudicationStatus(status: AdjudicationStatus): string[] {
  const lines: string[] = [];
  lines.push(
    `Adjudication status for ${status.runId}: ${status.decided}/${status.total} decided, ${status.pending.length} pending`,
  );
  if (status.queueMismatch) lines.push('  QUEUE MISMATCH — the record was taken against different evidence');
  for (const p of status.pending.slice(0, 20)) {
    lines.push(`  pending ${p.questionId} [${p.reasons.join(',')}] — ${p.why}`);
  }
  if (status.pending.length > 20) lines.push(`  … and ${status.pending.length - 20} more`);
  for (const id of status.unknownDecisions) lines.push(`  stale decision for unknown case ${id}`);
  return lines;
}

/* -------------------------------------------------------------------------- */
/* legacy adapter — the 73 real flags                                          */
/* -------------------------------------------------------------------------- */

/** Structural shape of a stored score row; not the `Score` type, on purpose. */
export interface StoredScoreRow {
  runId: string;
  modelId: string;
  questionId: string;
  score: number;
  graderType: string;
  detail: unknown;
}

interface LegacyVerdict {
  judgeModel: string;
  score: number;
  summary?: string;
  findings: SeatEvidence[];
}

/**
 * Read the stored judge detail, refusing anything it cannot understand.
 *
 * Refusing rather than skipping is the whole point: a detail shape this adapter
 * does not recognise is a judged answer that would otherwise vanish from the
 * queue, and a queue that silently omits cases reports "complete" while the
 * disputes it never saw stay unreviewed.
 */
function readLegacyDetail(
  detail: unknown,
  label: string,
): { pending: boolean; disagreement: number | null; verdicts: LegacyVerdict[] } {
  if (!isRecord(detail)) {
    throw new AdjudicationError(`score ${label}: judge detail is not an object`, 'INVALID_OBSERVATION');
  }
  const pending = detail['judgePending'] === true;
  const disagreementRaw = detail['disagreement'];
  if (disagreementRaw !== undefined && (typeof disagreementRaw !== 'number' || !Number.isFinite(disagreementRaw))) {
    throw new AdjudicationError(
      `score ${label}: detail.disagreement is ${JSON.stringify(disagreementRaw)}, which is not a number`,
      'INVALID_OBSERVATION',
    );
  }
  const disagreement = typeof disagreementRaw === 'number' ? disagreementRaw : null;
  const rawVerdicts = detail['verdicts'];
  const verdicts: LegacyVerdict[] = [];
  if (rawVerdicts !== undefined) {
    if (!Array.isArray(rawVerdicts)) {
      throw new AdjudicationError(`score ${label}: detail.verdicts is not an array`, 'INVALID_OBSERVATION');
    }
    for (const [i, raw] of rawVerdicts.entries()) {
      if (!isRecord(raw)) throw new AdjudicationError(`score ${label}: verdicts[${i}] is not an object`, 'INVALID_OBSERVATION');
      const judgeModel = raw['judgeModel'];
      const score = raw['score'];
      if (typeof judgeModel !== 'string' || judgeModel === '') {
        throw new AdjudicationError(`score ${label}: verdicts[${i}].judgeModel is missing`, 'INVALID_OBSERVATION');
      }
      if (typeof score !== 'number' || !Number.isFinite(score)) {
        throw new AdjudicationError(`score ${label}: verdicts[${i}].score is not a number`, 'INVALID_OBSERVATION');
      }
      const rawFindings = raw['findings'];
      const findings: SeatEvidence[] = [];
      if (rawFindings !== undefined) {
        if (!Array.isArray(rawFindings)) {
          throw new AdjudicationError(`score ${label}: verdicts[${i}].findings is not an array`, 'INVALID_OBSERVATION');
        }
        for (const [j, f] of rawFindings.entries()) {
          if (!isRecord(f)) throw new AdjudicationError(`score ${label}: verdicts[${i}].findings[${j}] is not an object`, 'INVALID_OBSERVATION');
          const issue = f['issue'];
          const severity = f['severity'];
          if (typeof issue !== 'string' || issue === '') {
            throw new AdjudicationError(`score ${label}: verdicts[${i}].findings[${j}].issue is missing`, 'INVALID_OBSERVATION');
          }
          if (severity !== 'critical' && severity !== 'major' && severity !== 'minor') {
            throw new AdjudicationError(
              `score ${label}: verdicts[${i}].findings[${j}].severity is ${JSON.stringify(severity)}`,
              'INVALID_OBSERVATION',
            );
          }
          findings.push({
            ...(typeof f['quote'] === 'string' ? { quote: f['quote'] } : {}),
            statement: issue,
            severity,
            // Undeclared, and therefore LLM-judge — see `safetyTriggers`.
            provenance: 'llm-judge',
          });
        }
      }
      verdicts.push({
        judgeModel,
        score,
        ...(typeof raw['summary'] === 'string' ? { summary: raw['summary'] } : {}),
        findings,
      });
    }
  }
  return { pending, disagreement, verdicts };
}

export interface LegacyAdapterOptions {
  /**
   * Declared stratum for an item. Required, and required to return a non-empty
   * string: defaulting to the item's category would put the audit sample and
   * the coverage claim on a field that was never chosen as a stratum.
   */
  stratumOf: (questionId: string) => string;
  /** Whether the item belongs to the critical safety/allergen set. */
  criticalItem: (questionId: string) => boolean;
  promptOf: (questionId: string) => string;
  answerOf: (modelId: string, questionId: string) => string;
}

export interface LegacyAdapterResult {
  observations: PanelObservation[];
  /** Rows that could not become an observation, with the reason. Never dropped. */
  skipped: Array<{ questionId: string; modelId: string; why: string }>;
}

/**
 * Turn stored judge-panel scores into observations.
 *
 * Everything the legacy panel does not record arrives as `null` here —
 * per-seat confidence, vote entropy, evidence provenance, order stability — and
 * every one of those nulls escalates rather than resolving favourably. That is
 * the point: the v2 route was never validated to run without human review, so
 * its silence about confidence cannot be read as confidence.
 */
export function observationsFromStoredScores(
  rows: readonly StoredScoreRow[],
  options: LegacyAdapterOptions,
): LegacyAdapterResult {
  const observations: PanelObservation[] = [];
  const skipped: LegacyAdapterResult['skipped'] = [];
  for (const row of rows) {
    if (row.graderType !== 'llm-judge') continue;
    const detail = readLegacyDetail(row.detail, `${row.modelId}/${row.questionId}`);
    if (detail.pending) {
      skipped.push({
        questionId: row.questionId,
        modelId: row.modelId,
        why: 'judge never returned a verdict (an incident, not a dispute)',
      });
      continue;
    }
    if (detail.verdicts.length === 0) {
      skipped.push({
        questionId: row.questionId,
        modelId: row.modelId,
        why: 'no per-seat verdicts stored; there is nothing for a reviewer to weigh',
      });
      continue;
    }
    const stratum = options.stratumOf(row.questionId);
    if (typeof stratum !== 'string' || stratum.trim() === '') {
      throw new AdjudicationError(
        `stratumOf(${row.questionId}) returned ${JSON.stringify(stratum)}; every observation needs a declared stratum`,
        'INVALID_OBSERVATION',
      );
    }
    observations.push({
      runId: row.runId,
      questionId: row.questionId,
      candidates: [row.modelId],
      mode: 'fault-deduction',
      stratum,
      critical: options.criticalItem(row.questionId),
      seats: detail.verdicts.map((v) => ({
        judgeModel: v.judgeModel,
        score: v.score,
        // The legacy ballot has no confidence field. Not 1, not 0.5: absent.
        confidence: null,
        ...(v.summary === undefined ? {} : { summary: v.summary }),
        evidence: v.findings,
      })),
      disagreement: detail.disagreement,
      entropy: null,
      confidence: null,
      orderUnstable: false,
      provisionalScore: row.score,
      prompt: options.promptOf(row.questionId),
      answers: [{ modelId: row.modelId, text: options.answerOf(row.modelId, row.questionId) }],
    });
  }
  return { observations, skipped };
}

/* -------------------------------------------------------------------------- */
/* I/O — firewall-guarded, and deliberately the only impure part               */
/* -------------------------------------------------------------------------- */

export const ADJUDICATION_QUEUE_FILE = 'adjudication-queue.json';
export const ADJUDICATION_FILE = 'adjudication.json';

/**
 * `runs` for a live run; `shadow` for a published one.
 *
 * A published run is frozen, so `runs` refuses it at the firewall — which is
 * correct, and is the reason this parameter exists rather than a silent
 * fallback. Re-adjudicating `2026-07-v2.1` produces shadow evidence about a
 * frozen artifact; it does not edit the artifact.
 */
export type AdjudicationFamily = 'runs' | 'shadow';

function writeAdjudicationArtifact(family: AdjudicationFamily, runId: string, file: string, body: string): string {
  return family === 'runs'
    ? writeRunFileAtomic(runId, file, body)
    : writeOutputFileAtomic('shadow', `${runId}/${file}`, body);
}

export function writeAdjudicationQueue(queue: AdjudicationQueue, family: AdjudicationFamily = 'runs'): string {
  return writeAdjudicationArtifact(family, queue.runId, ADJUDICATION_QUEUE_FILE, `${JSON.stringify(queue, null, 2)}\n`);
}

export function writeAdjudicationRecord(record: AdjudicationRecord, family: AdjudicationFamily = 'runs'): string {
  return writeAdjudicationArtifact(family, record.runId, ADJUDICATION_FILE, serialiseAdjudicationRecord(record));
}

/**
 * Read a record, or `null` when there is none.
 *
 * `null` here is not permission — `reportPermitted` treats it as blocking
 * whenever the queue holds a case. A malformed file throws rather than reading
 * as absent, because "unparseable" and "no disputes" must not be the same
 * outcome; that equivalence is the same one `readHistoricalRegistry` was fixed
 * for.
 */
export function readAdjudicationRecord(
  runId: string,
  family: AdjudicationFamily = 'runs',
): AdjudicationRecord | null {
  const path =
    family === 'runs'
      ? resolveRunFile(runId, ADJUDICATION_FILE, { write: false })
      : resolveOutputPath('shadow', `${runId}/${ADJUDICATION_FILE}`, { write: false });
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AdjudicationError(
      `adjudication record ${path} is not valid JSON (${(e as Error).message}); refusing to treat an unreadable record as an empty one`,
      'INVALID_RECORD',
    );
  }
  return parseAdjudicationRecord(parsed);
}
