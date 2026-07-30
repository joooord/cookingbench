import type { GradeResult, GraderSpec, Question } from '../types.js';
import { gradeKeyword } from './keyword.js';
import { gradeNumeric, gradeNumericMulti, gradeRange } from './numeric.js';
import {
  applyCaps,
  type CapFinding,
  type CapOutcome,
} from './caps.js';
import {
  capDimensions,
  type DimensionPanelResult,
  type DimensionResult,
} from './dimension.js';
import {
  type PairwiseVerdict,
  type RaterUnit,
} from './pairwise.js';

export { extractQuantities, findAnswerLine, gradableScope } from './extract.js';
export { convert, dimensionOf, normalizeUnit } from './units.js';
export { gradeKeyword } from './keyword.js';
export { gradeNumeric, gradeNumericMulti, gradeRange } from './numeric.js';
export * from './caps.js';
export * from './dimension.js';
export * from './pairwise.js';

export function gradeSpec(
  spec: GraderSpec,
  answerText: string,
  promptText?: string,
): GradeResult {
  switch (spec.type) {
    case 'numeric':
      return gradeNumeric(spec, answerText, promptText);
    case 'numeric-multi':
      return gradeNumericMulti(spec, answerText, promptText);
    case 'range':
      return gradeRange(spec, answerText, promptText);
    case 'keyword':
      return gradeKeyword(spec, answerText);
    case 'llm-judge':
      throw new Error('llm-judge questions are graded by the judge pipeline, not gradeSpec');
  }
}

/**
 * Grade everything that can be graded without an LLM. For llm-judge questions
 * this returns only the deterministic constraint-check component (or null if
 * there is none); the judge pipeline blends it later via blendJudgeScore.
 */
export function gradeDeterministic(
  question: Question,
  answerText: string,
): GradeResult | null {
  const { grader, prompt } = question;
  if (grader.type !== 'llm-judge') {
    return gradeSpec(grader, answerText, prompt);
  }
  if (!grader.constraintChecks || grader.constraintChecks.length === 0) return null;
  const results = grader.constraintChecks.map((c) => gradeSpec(c, answerText, prompt));
  const mean = results.reduce((s, r) => s + r.score, 0) / results.length;
  return { score: mean, detail: { constraintChecks: results } };
}

/**
 * Combine a 0–100 judge score with the deterministic constraint score for an
 * llm-judge question. judgeWeight defaults to 0.7 when constraint checks exist.
 */
export function blendJudgeScore(
  question: Question,
  judgeScore: number,
  constraintScore: number | null,
): number {
  const grader = question.grader;
  if (grader.type !== 'llm-judge') {
    throw new Error(`blendJudgeScore called on ${grader.type} question ${question.id}`);
  }
  if (constraintScore === null) return judgeScore;
  const w = grader.judgeWeight ?? 0.7;
  return w * judgeScore + (1 - w) * constraintScore;
}

/* -------------------------------------------------------------------------- */
/* M2.1 — the cascade router                                                  */
/* -------------------------------------------------------------------------- */

/**
 * M2.1 applies the three grading modes as a cascade:
 *
 *   deterministic and reference-grounded checks
 *     → blind structured judgement
 *       → human escalation
 *
 * The router decides which rung a given item's evidence actually reached, and
 * records the four things M2.1 requires of *every* automated result: the route
 * used, confidence, judge disagreement, and whether a human could have changed
 * it. All four, on every result — a pipeline that records three of them cannot
 * answer the only question an auditor asks, which is "who decided this".
 *
 * Two rules are load-bearing and neither is negotiable in a caller:
 *
 *  1. **No safety-critical case is accepted on an LLM judge alone.** A
 *     deterministic rule or a relevant human specialist must confirm it. The
 *     router forces `human-escalation` on a safety-critical item whose only
 *     evidence is a judge panel, whatever that panel concluded — including, and
 *     especially, when it concluded the answer was fine. A clean LLM verdict on
 *     a hazard item is not evidence of safety; it is an absence of evidence.
 *  2. **Caps are applied after the weighted score**, and an escalated item
 *     carries `score: null` with the automation's number preserved separately
 *     as `provisionalScore`. Publishing a provisional number as a score is how
 *     "awaiting review" quietly becomes "reviewed".
 */
export const CASCADE_ROUTES = [
  'deterministic',
  'structured-judgement',
  'human-escalation',
] as const;
export type CascadeRoute = (typeof CASCADE_ROUTES)[number];

/** M2.6's mandatory-review triggers, as values rather than prose. */
export const ESCALATION_REASONS = [
  'safety-critical-requires-confirmation',
  'safety-disagreement',
  'judge-split-over-tolerance',
  'low-confidence',
  'missing-confidence',
  'order-unstable',
  'unhandled-critical-criterion',
  'no-preference-evidence',
  'no-automated-evidence',
  'incomplete-evidence',
  'challenged-reference',
  'sampled-audit',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

/**
 * Cross-judge spread that flags an answer for human review, in points.
 *
 * Carried over from the v2 practice documented in CLAUDE.md (13.9% flag rate in
 * 2026-06-v2, described there as healthy). It is a *declared* tolerance, which
 * is all M2.6 requires of it at this stage — Stage 4 sets the real one.
 */
export const DEFAULT_DISAGREEMENT_TOLERANCE = 15;

/**
 * Confidence below which an automated result is not accepted outside validated
 * automation coverage. Declared, not measured; M2.8 fixes the real figure once
 * the sealed holdout has been powered. Named so a report can print it.
 */
export const DEFAULT_MINIMUM_CONFIDENCE = 0.7;

export interface DeterministicEvidence {
  /** 0–100. */
  score: number;
  /**
   * Does this settle the item on its own? A numeric grader on a numeric item
   * does; a constraint check on a judged item does not, and says so.
   */
  resolves: boolean;
  /** Grader type, validator id or reference id — whatever an auditor would look up. */
  source: string;
  /**
   * Confidence in the *check*, not in the answer. 1 is defensible for an exact
   * reference-grounded comparison; the 2026-06-v2 grader audit is the standing
   * reminder that it is confidence in a rule, and rules have been wrong.
   */
  confidence: number;
}

export type CascadeJudgement =
  | {
      mode: 'dimension';
      panel: DimensionPanelResult;
      /**
       * The caller has already turned every critical-criterion breach into a
       * cap finding (or adjudicated it). Absent or false with breaches present
       * forces escalation: a critical miss that reached the weighted mean and
       * stopped there is the compensation the schema warns about.
       */
      criticalBreachesHandled?: boolean;
    }
  | { mode: 'pairwise'; verdict: PairwiseVerdict; units: readonly RaterUnit[] };

export interface CascadePolicy {
  disagreementTolerance?: number;
  minimumConfidence?: number;
  /**
   * The item's stratum sits inside validated automation coverage. Defaults to
   * false: until Stage 4 certifies a stratum, low confidence escalates.
   */
  automationCoverageValidated?: boolean;
  /** M2.6: challenged references and the stratified audit sample are mandatory reviews. */
  challengedReference?: boolean;
  sampledAudit?: boolean;
  /** Judge weight when non-resolving deterministic evidence is blended in. */
  judgeWeight?: number;
}

export interface CascadeRequest {
  questionId: string;
  /**
   * Whether the item tests a safety or allergen outcome. Required, and required
   * as a boolean: a missing flag must not read as "not safety-critical".
   */
  safetyCritical: boolean;
  deterministic?: DeterministicEvidence;
  judgement?: CascadeJudgement;
  /** M2.2 findings. Applied after the weighted score, never before. */
  caps?: readonly CapFinding[];
  /** A human specialist has confirmed the safety finding (or its absence). */
  humanConfirmed?: boolean;
  policy?: CascadePolicy;
}

export type JudgeDisagreement =
  | { kind: 'score-gap'; value: number }
  | { kind: 'outcome-split'; value: number };

export interface CascadeResult {
  questionId: string;
  route: CascadeRoute;
  /**
   * 0–100, or null when nothing was resolved automatically or the item
   * escalated. Pairwise items never carry a score — read `verdict`.
   */
  score: number | null;
  /** What the automation would have said, preserved through escalation. */
  provisionalScore: number | null;
  verdict: PairwiseVerdict | null;
  /** 0–1, or null when no evidence declared one (which itself escalates). */
  confidence: number | null;
  /**
   * Unit-tagged on purpose. A points gap and an outcome split are both
   * "disagreement" and are not on the same scale; a bare number invites a
   * threshold written for one to be applied to the other.
   */
  judgeDisagreement: JudgeDisagreement | null;
  /**
   * Could a human reviewing this have returned something else?
   *
   * True whenever judgement was exercised, a cap rested on non-deterministic
   * evidence, or anything escalated. False means no judgement was exercised —
   * NOT that the result is correct. A deterministic result can be wrong: the
   * 2026-06-v2 audit found eighteen answers marked wrong by a grader defect,
   * and three reference answers scoring 0 against their own graders. A `false`
   * here says review would be a grader-defect question, not an adjudication.
   */
  humanCouldChange: boolean;
  escalations: EscalationReason[];
  caps: CapOutcome | null;
  /** Per-seat detail after any dimension ceiling, for the adjudication record. */
  dimension: DimensionResult | null;
}

function push(list: EscalationReason[], reason: EscalationReason): void {
  if (!list.includes(reason)) list.push(reason);
}

/**
 * Route one item's evidence through the cascade.
 *
 * Pure: it calls no judge and reads no files. Everything it needs has already
 * been collected, which is what makes the routing decision reproducible from
 * the stored artifacts.
 */
export function routeCascade(request: CascadeRequest): CascadeResult {
  if (typeof request?.questionId !== 'string' || request.questionId.length === 0) {
    throw new Error('routeCascade needs a questionId');
  }
  if (typeof request.safetyCritical !== 'boolean') {
    throw new Error(
      `routeCascade: ${request.questionId} does not declare safetyCritical; ` +
        'an absent flag must not be read as "not safety-critical"',
    );
  }

  if (request.deterministic?.resolves && request.judgement !== undefined) {
    // Contradictory input, refused rather than reconciled. Whichever way it were
    // reconciled would be a scoring rule invented here: dropping the panel
    // discards evidence the caller collected, and blending it contradicts
    // `resolves: true`. The cascade's first rung either settles the item or it
    // does not, and the caller has to say which.
    throw new Error(
      `routeCascade: ${request.questionId} supplies a resolving deterministic check and structured ` +
        'judgement together; set resolves:false to blend the check in, or omit the judgement',
    );
  }

  const policy = request.policy ?? {};
  const tolerance = policy.disagreementTolerance ?? DEFAULT_DISAGREEMENT_TOLERANCE;
  const minimumConfidence = policy.minimumConfidence ?? DEFAULT_MINIMUM_CONFIDENCE;
  const escalations: EscalationReason[] = [];
  const confidences: number[] = [];
  let missingConfidence = false;

  // Caps first, because a dimension-scoped ceiling has to bind before the
  // weighted score exists. applyCaps is called again below once that score is
  // final — the second call is what produces the authoritative `binding` flags.
  const ceilingProbe = applyCaps(0, request.caps ?? []);

  let baseScore: number | null = null;
  let dimensionResult: DimensionResult | null = null;
  let verdict: PairwiseVerdict | null = null;
  let judgeDisagreement: JudgeDisagreement | null = null;
  let judgementUsed = false;

  if (request.deterministic) {
    const d = request.deterministic;
    if (typeof d.confidence !== 'number' || !Number.isFinite(d.confidence)) {
      missingConfidence = true;
    } else {
      confidences.push(d.confidence);
    }
  }

  const judgement = request.judgement;
  if (judgement?.mode === 'dimension') {
    judgementUsed = true;
    const panel = judgement.panel;
    judgeDisagreement = { kind: 'score-gap', value: panel.disagreement };
    if (panel.disagreement > tolerance) push(escalations, 'judge-split-over-tolerance');

    // A seat seeing a critical breach that another seat did not is a safety
    // disagreement in M2.6's sense even when the mean looks calm.
    const breachSeats = panel.seats.filter((s) => s.result.criticalBreaches.length > 0).length;
    if (breachSeats > 0 && breachSeats < panel.seats.length) {
      push(escalations, 'safety-disagreement');
    }
    if (panel.criticalBreaches.length > 0 && judgement.criticalBreachesHandled !== true) {
      push(escalations, 'unhandled-critical-criterion');
    }

    for (const seat of panel.seats) {
      if (typeof seat.confidence !== 'number' || !Number.isFinite(seat.confidence)) {
        missingConfidence = true;
      } else {
        confidences.push(seat.confidence);
      }
    }

    // Enforce dimension ceilings seat by seat, then re-average. Capping the
    // panel mean instead would let a seat that scored context 100 subsidise one
    // that scored it 20 before the ceiling ever saw either.
    const capped = panel.seats.map((s) => capDimensions(s.result, ceilingProbe.dimensionCeilings));
    baseScore = capped.reduce((sum, r) => sum + r.score, 0) / capped.length;
    dimensionResult = capped.length === 1 ? capped[0]! : null;
  } else if (judgement?.mode === 'pairwise') {
    judgementUsed = true;
    verdict = judgement.verdict;
    const units = judgement.units;
    const decided = units.filter((u) => !u.orderUnstable && u.outcome !== null);
    if (decided.length > 0) {
      const counts = new Map<string, number>();
      for (const u of decided) counts.set(u.outcome!, (counts.get(u.outcome!) ?? 0) + 1);
      const modal = Math.max(...counts.values());
      judgeDisagreement = { kind: 'outcome-split', value: 1 - modal / decided.length };
    }
    if (units.some((u) => u.orderUnstable)) push(escalations, 'order-unstable');
    if (verdict.escalate) {
      // pairwiseVerdict already recorded why; map the ones with a reason code.
      if (verdict.winner === 'no-contest' || verdict.tally.bothUnacceptable > 0) {
        push(escalations, 'safety-disagreement');
      }
      if (verdict.winner === 'insufficient') push(escalations, 'no-preference-evidence');
    }
    const flagged = units.filter((u) => u.safetyFlag).length;
    if (flagged > 0 && flagged < units.length) push(escalations, 'safety-disagreement');
    for (const unit of units) {
      if (typeof unit.confidence !== 'number' || !Number.isFinite(unit.confidence)) {
        missingConfidence = true;
      } else {
        confidences.push(unit.confidence);
      }
    }
    // Pairwise mode yields an ordering, not a score. Leaving baseScore null is
    // the point: there is no number to cap and none to publish.
  }

  if (request.deterministic && baseScore === null) {
    baseScore = request.deterministic.score;
  } else if (request.deterministic && baseScore !== null && !request.deterministic.resolves) {
    const w = policy.judgeWeight ?? 0.7;
    baseScore = w * baseScore + (1 - w) * request.deterministic.score;
  }

  const caps = baseScore === null ? ceilingProbe : applyCaps(baseScore, request.caps ?? []);

  // --- route selection ----------------------------------------------------
  let route: CascadeRoute;
  if (request.deterministic?.resolves && !judgementUsed) {
    route = 'deterministic';
  } else if (judgementUsed) {
    route = 'structured-judgement';
  } else if (request.deterministic) {
    // A constraint check that explicitly does not settle the item, with nothing
    // to settle it. Half an answer is not an answer: the score would be the
    // constraint component alone, wearing the authority of a full grade.
    route = 'human-escalation';
    push(escalations, 'incomplete-evidence');
  } else {
    route = 'human-escalation';
    push(escalations, 'no-automated-evidence');
  }

  // M2.2's closing line, and the one rule in this file that no policy flag can
  // switch off. Safety confirmation must come from a deterministic rule or a
  // human; a judge panel — agreeing, unanimous, confident — is not either.
  const safetyConfirmed =
    request.humanConfirmed === true ||
    request.deterministic !== undefined ||
    caps.applied.some((c) => c.evidence === 'deterministic' || c.evidence === 'human');
  if (request.safetyCritical && !safetyConfirmed) {
    push(escalations, 'safety-critical-requires-confirmation');
  }
  if (caps.safetyEvidenceIsLlmOnly && request.humanConfirmed !== true) {
    push(escalations, 'safety-critical-requires-confirmation');
  }

  if (missingConfidence) push(escalations, 'missing-confidence');
  const confidence = confidences.length > 0 ? Math.min(...confidences) : null;
  if (
    confidence !== null &&
    confidence < minimumConfidence &&
    policy.automationCoverageValidated !== true
  ) {
    push(escalations, 'low-confidence');
  }
  if (policy.challengedReference) push(escalations, 'challenged-reference');
  if (policy.sampledAudit) push(escalations, 'sampled-audit');

  if (escalations.length > 0) route = 'human-escalation';

  const provisionalScore = judgement?.mode === 'pairwise' ? null : caps.score;
  const humanCouldChange =
    route !== 'deterministic' ||
    escalations.length > 0 ||
    caps.applied.some((c) => c.evidence === 'llm-judge');

  return {
    questionId: request.questionId,
    route,
    score: route === 'human-escalation' ? null : provisionalScore,
    provisionalScore,
    verdict,
    confidence,
    judgeDisagreement,
    humanCouldChange,
    escalations,
    caps: baseScore === null && (request.caps ?? []).length === 0 ? null : caps,
    dimension: dimensionResult,
  };
}

/**
 * Convenience for the common dimension-mode path: score the panel, enforce the
 * caps and route, in the order M2.1 and M2.2 require.
 */
export function routeDimensionMode(
  request: Omit<CascadeRequest, 'judgement'> & {
    panel: DimensionPanelResult;
    criticalBreachesHandled?: boolean;
  },
): CascadeResult {
  const { panel, criticalBreachesHandled, ...rest } = request;
  return routeCascade({
    ...rest,
    judgement: { mode: 'dimension', panel, criticalBreachesHandled },
  });
}
