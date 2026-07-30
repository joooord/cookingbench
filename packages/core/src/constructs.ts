/**
 * Stage 1 construct vocabulary — M1.5 (the proposed Craft axes and the
 * evidence-mode map) and M1.6 (what each axis is not).
 *
 * Like evidence.ts this module is pure data and predicates: no I/O, no zod
 * dependency on the item schema, so schema.ts may import from here and never
 * the other way round.
 *
 * The load-bearing decision in this file is what it does NOT export. There is
 * no `CRAFT_WEIGHTS: Record<CraftAxisId, number>` constant, because M1.5 says
 * in terms that the weights "are a starting proposal, not an agreed scientific
 * fact" and that reviewers "must approve or replace them before results are
 * seen". A constant that can be imported and multiplied would be agreed within
 * a week of someone needing a number, and no reviewer would ever have said so.
 * The proposal is therefore reachable only as `proposedWeight` on an axis
 * record, and a usable weight map exists only by passing an approval record
 * through `resolveCraftWeights`, which refuses everything short of a real one.
 */

/** M1.5. The six Craft axes, in the order the plan tabulates them. */
export const CRAFT_AXIS_IDS = [
  'technical-reasoning',
  'diagnosis-recovery',
  'flavour-sensory',
  'adaptation-lateral',
  'execution-service',
  'history-context',
] as const;
export type CraftAxisId = (typeof CRAFT_AXIS_IDS)[number];

export interface CraftAxis {
  id: CraftAxisId;
  /** The plan's own row label. */
  name: string;
  /** The plan's own "what it measures" cell. */
  measures: string;
  /**
   * M1.5's proposed weight. UNAPPROVED. Named `proposedWeight` rather than
   * `weight` so that no call site can read as though a decision had been taken.
   */
  proposedWeight: number;
}

/**
 * The approval status of `proposedWeight`, as data rather than a comment so a
 * report generator can print it next to any number it derives from the
 * proposal. Flip this only when Gate 1 records a real approval, and expect the
 * accompanying test to fail until `resolveCraftWeights` has a record to accept.
 */
export const CRAFT_WEIGHT_STATUS = 'unapproved-proposal' as const;

/** The banner any surface must carry if it shows a proposal-derived number. */
export const CRAFT_WEIGHT_PROPOSAL_LABEL =
  'PROPOSED WEIGHTS — NOT APPROVED, NOT A RESULT' as const;

export const PROPOSED_CRAFT_AXES: Readonly<Record<CraftAxisId, CraftAxis>> = Object.freeze({
  'technical-reasoning': Object.freeze({
    id: 'technical-reasoning',
    name: 'Technical reasoning and food theory',
    measures: 'Mechanisms, transfer of principles, consequence prediction',
    proposedWeight: 0.2,
  }),
  'diagnosis-recovery': Object.freeze({
    id: 'diagnosis-recovery',
    name: 'Diagnosis and recovery',
    measures: 'Finding likely causes and choosing workable rescues',
    proposedWeight: 0.2,
  }),
  'flavour-sensory': Object.freeze({
    id: 'flavour-sensory',
    name: 'Flavour and sensory judgement',
    measures: 'Balance, identity, progression, texture, temperature and aroma',
    proposedWeight: 0.2,
  }),
  'adaptation-lateral': Object.freeze({
    id: 'adaptation-lateral',
    name: 'Adaptation and lateral problem-solving',
    measures: 'Resourcefulness under unfamiliar or conflicting constraints',
    proposedWeight: 0.15,
  }),
  'execution-service': Object.freeze({
    id: 'execution-service',
    name: 'Execution, service and practicality',
    measures: 'Timing, holding, equipment, communication, waste and realism',
    proposedWeight: 0.15,
  }),
  'history-context': Object.freeze({
    id: 'history-context',
    name: 'Culinary history, tradition and context',
    measures: 'Provenance, change over time, cultural context and responsible adaptation',
    proposedWeight: 0.1,
  }),
});

/**
 * M1.5. Originality, restraint, clarity and uncertainty are scored across the
 * axes where they are relevant. They are deliberately NOT axes: giving each its
 * own category is how a benchmark ends up with a trivia-heavy originality
 * column that item count alone has weighted.
 */
export const CROSS_CUTTING_DIMENSION_IDS = [
  'originality',
  'restraint',
  'clarity',
  'uncertainty',
] as const;
export type CrossCuttingDimensionId = (typeof CROSS_CUTTING_DIMENSION_IDS)[number];

/**
 * M1.1 evidence layers and the M1.5 evidence/task-mode table are the same seven
 * names viewed twice: once as what CookingBench reports, once as how each feeds
 * the construct. One list, so the two can never drift apart.
 */
export const EVIDENCE_MODE_IDS = [
  'fundamentals-gate',
  'kitchen-plan',
  'interactive-kitchen',
  'craft-prose',
  'palate',
  'public-taste',
  'kitchen-outcome',
] as const;
export type EvidenceModeId = (typeof EVIDENCE_MODE_IDS)[number];

/** M1.5's aggregation column, as an enum so the rule is checkable, not prose. */
export const AGGREGATION_RULES = [
  /** A failure here disqualifies; a pass buys nothing. */
  'non-compensatory',
  /** Enters the Craft score exactly once, through the mapped axis criteria. */
  'counts-once-through-mapped-criteria',
  /** Scored under the preregistered Craft analysis. */
  'preregistered-craft-analysis',
  /** Public expression of evidence already counted — never added a second time. */
  'not-added-again',
  /** Reported alongside, and may never overturn correctness or safety. */
  'never-overrides',
  /** Separate real-world evidence, outside the Craft computation entirely. */
  'separate-evidence',
] as const;
export type AggregationRule = (typeof AGGREGATION_RULES)[number];

export interface EvidenceModeMapping {
  mode: EvidenceModeId;
  /**
   * Craft axes this mode contributes to. Empty is meaningful, not missing: the
   * Fundamentals Gate, Public Taste and Kitchen Outcome contribute to NO Craft
   * axis. That is the whole point of M1.5 — a model cannot buy Craft points by
   * passing the safety gate, and Public Taste cannot lift a Craft score.
   */
  contributesTo: readonly CraftAxisId[];
  /** The plan's own wording for what this mode contributes. */
  contributionNote: string;
  /** The plan's own "public output" cell. */
  publicOutput: string;
  aggregation: AggregationRule;
  /**
   * Whether this mode's evidence may be multiplied by a Craft weight at all.
   * Palate is the trap here: it is the public face of the 20% flavour axis, so
   * scoring it again on top of that axis double-counts one piece of evidence.
   */
  weightable: boolean;
}

export const EVIDENCE_MODE_MAP: Readonly<Record<EvidenceModeId, EvidenceModeMapping>> =
  Object.freeze({
    'fundamentals-gate': Object.freeze({
      mode: 'fundamentals-gate',
      contributesTo: Object.freeze([] as const),
      contributionNote: 'Safety and hard constraints',
      publicOutput: 'Qualified / not qualified plus failure detail',
      aggregation: 'non-compensatory',
      weightable: false,
    }),
    'kitchen-plan': Object.freeze({
      mode: 'kitchen-plan',
      contributesTo: Object.freeze([
        'technical-reasoning',
        'execution-service',
        'adaptation-lateral',
      ] as const),
      contributionNote: 'Theory, execution, service, adaptation',
      publicOutput: 'Plan validity and failure profile',
      aggregation: 'counts-once-through-mapped-criteria',
      weightable: true,
    }),
    'interactive-kitchen': Object.freeze({
      mode: 'interactive-kitchen',
      contributesTo: Object.freeze([
        'diagnosis-recovery',
        'adaptation-lateral',
        'execution-service',
      ] as const),
      contributionNote: 'Diagnosis, adaptation, execution',
      publicOutput: 'Clarification and recovery profile',
      aggregation: 'counts-once-through-mapped-criteria',
      weightable: true,
    }),
    'craft-prose': Object.freeze({
      mode: 'craft-prose',
      contributesTo: Object.freeze([
        'technical-reasoning',
        'diagnosis-recovery',
        'history-context',
      ] as const),
      contributionNote: 'Theory, diagnosis, history, context',
      publicOutput: 'Anchored construct scores',
      aggregation: 'preregistered-craft-analysis',
      weightable: true,
    }),
    palate: Object.freeze({
      mode: 'palate',
      contributesTo: Object.freeze(['flavour-sensory'] as const),
      contributionNote: 'Flavour and sensory judgement',
      publicOutput: 'Jury distribution and supported preference',
      aggregation: 'not-added-again',
      weightable: false,
    }),
    'public-taste': Object.freeze({
      mode: 'public-taste',
      contributesTo: Object.freeze([] as const),
      contributionNote: 'Reader preference',
      publicOutput: 'Separate public rating',
      aggregation: 'never-overrides',
      weightable: false,
    }),
    'kitchen-outcome': Object.freeze({
      mode: 'kitchen-outcome',
      contributesTo: Object.freeze([] as const),
      contributionNote: 'Physical execution and taste',
      publicOutput: 'Separate real-world result',
      aggregation: 'separate-evidence',
      weightable: false,
    }),
  });

/** Anything an M1.6 exclusion can be about. */
export type ExclusionSubject = CraftAxisId | CrossCuttingDimensionId | EvidenceModeId;

export interface ConstructExclusion {
  subject: ExclusionSubject;
  /** Verbatim from M1.6. Reworded statements stop being the approved text. */
  statement: string;
}

/**
 * M1.6, as data. Every bullet, verbatim, attached to the thing it constrains.
 *
 * Two axes — `diagnosis-recovery` and `execution-service` — carry no bullet.
 * `exclusionsFor` therefore returns an empty list for them, and that is the
 * honest answer: M1.6 does not define what they are not, and inventing a
 * plausible ninth bullet would put words the reviewers never approved into an
 * artefact that reads as the approved definition.
 */
export const CONSTRUCT_EXCLUSIONS: readonly ConstructExclusion[] = Object.freeze([
  Object.freeze({
    subject: 'technical-reasoning' as ExclusionSubject,
    statement: 'Food theory is not a chemistry vocabulary test.',
  }),
  Object.freeze({
    subject: 'history-context' as ExclusionSubject,
    statement: 'Food history is not a list of dates or unsupported origin stories.',
  }),
  Object.freeze({
    subject: 'originality' as ExclusionSubject,
    statement: 'Creativity is not ingredient accumulation or novelty for its own sake.',
  }),
  Object.freeze({
    subject: 'adaptation-lateral' as ExclusionSubject,
    statement: 'Problem-solving is not a riddle with one clever phrase.',
  }),
  Object.freeze({
    subject: 'flavour-sensory' as ExclusionSubject,
    statement:
      'Flavour is not a judge stating personal preference without sensory reasoning.',
  }),
  Object.freeze({
    subject: 'clarity' as ExclusionSubject,
    statement: 'Concision is not a substitute for completeness.',
  }),
  Object.freeze({
    subject: 'craft-prose' as ExclusionSubject,
    statement: 'Long, polished writing is not evidence of culinary competence.',
  }),
  Object.freeze({
    subject: 'kitchen-plan' as ExclusionSubject,
    statement: 'KitchenPlan is not a syntax-compliance contest.',
  }),
  Object.freeze({
    subject: 'interactive-kitchen' as ExclusionSubject,
    statement: 'Interactive Kitchen is not a reward for asking unnecessary questions.',
  }),
]);

export function exclusionsFor(subject: ExclusionSubject): readonly ConstructExclusion[] {
  return CONSTRUCT_EXCLUSIONS.filter((e) => e.subject === subject);
}

/* -------------------------------------------------------------------------- */
/* Weight approval                                                            */
/* -------------------------------------------------------------------------- */

export const CRAFT_WEIGHT_APPROVER_ROLES = ['culinary', 'measurement', 'safety', 'other'] as const;
export type CraftWeightApproverRole = (typeof CRAFT_WEIGHT_APPROVER_ROLES)[number];

export interface CraftWeightApprover {
  name: string;
  role: CraftWeightApproverRole;
  affiliation?: string;
}

/**
 * A reviewer decision on the M1.5 proposal. "Approve or replace" means the
 * weights may differ from the proposal; it does not mean the axis set may
 * change, because changing the axes is a construct change and needs a plan
 * revision, not a weighting sign-off.
 */
export interface CraftWeightApproval {
  /** ISO 8601 date the approval was recorded. */
  approvedAt: string;
  approvers: readonly CraftWeightApprover[];
  /** Must cover exactly the six axes and sum to 1. */
  weights: Readonly<Record<string, number>>;
  /** Where the written rationale lives — M1.5 requires one. */
  rationale: string;
  /**
   * Whether the approvers had seen candidate results when they signed. M1.5
   * requires approval "before results are seen", so `true` is a refusal, not a
   * disclosure. It is recorded rather than assumed because an approval that
   * simply omits the question is the one to worry about.
   */
  resultsSeen: boolean;
}

const WEIGHT_SUM_TOLERANCE = 1e-6;

/**
 * Everything wrong with an approval record, as human-readable reasons.
 *
 * Fails closed on absence: no record at all is the commonest state of the world
 * and must never read as "nothing objectionable found".
 */
export function craftWeightApprovalIssues(approval: CraftWeightApproval | null | undefined): string[] {
  if (!approval || typeof approval !== 'object') {
    return ['no approval record: the M1.5 weights are an unapproved proposal'];
  }
  const issues: string[] = [];

  if (!approval.approvedAt || Number.isNaN(Date.parse(approval.approvedAt))) {
    issues.push('approvedAt is missing or not a parseable date');
  }
  if (!approval.rationale || approval.rationale.trim().length === 0) {
    issues.push('no written rationale recorded');
  }
  if (approval.resultsSeen !== false) {
    // Not "if true" — an absent or non-boolean value is also a failure. M1.5
    // wants a positive statement that results were unseen.
    issues.push('weights must be approved before results are seen (resultsSeen must be false)');
  }

  const approvers = Array.isArray(approval.approvers) ? approval.approvers : [];
  const roles = new Set(approvers.map((a) => a?.role));
  // M1.5: "Culinary and measurement reviewers must approve or replace them."
  // Two culinary signatures are not the review the plan asks for.
  if (!roles.has('culinary')) issues.push('no culinary reviewer approved these weights');
  if (!roles.has('measurement')) issues.push('no measurement reviewer approved these weights');
  if (approvers.some((a) => !a?.name || a.name.trim().length === 0)) {
    issues.push('an approver has no name: an anonymous approval is not an approval');
  }

  const weights = approval.weights;
  if (!weights || typeof weights !== 'object') {
    issues.push('no weights recorded');
    return issues;
  }
  const keys = Object.keys(weights);
  const missing = CRAFT_AXIS_IDS.filter((id) => !(id in weights));
  const unknown = keys.filter((k) => !(CRAFT_AXIS_IDS as readonly string[]).includes(k));
  if (missing.length > 0) issues.push(`weights missing for: ${missing.join(', ')}`);
  if (unknown.length > 0) issues.push(`weights given for unknown axes: ${unknown.join(', ')}`);

  let sum = 0;
  for (const id of CRAFT_AXIS_IDS) {
    const w = weights[id];
    if (typeof w !== 'number' || !Number.isFinite(w) || w < 0) {
      if (id in weights) issues.push(`weight for ${id} is not a finite non-negative number`);
      continue;
    }
    sum += w;
  }
  if (missing.length === 0 && Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    issues.push(`weights sum to ${sum}, not 1`);
  }

  return issues;
}

/**
 * The only route to a usable weight map. Throws with every reason at once, so a
 * caller fixing an approval record does not discover its faults one run at a
 * time.
 */
export function resolveCraftWeights(
  approval: CraftWeightApproval | null | undefined,
): Readonly<Record<CraftAxisId, number>> {
  const issues = craftWeightApprovalIssues(approval);
  if (issues.length > 0) {
    throw new Error(`Craft weights are not approved:\n- ${issues.join('\n- ')}`);
  }
  const weights = approval!.weights;
  const resolved = {} as Record<CraftAxisId, number>;
  for (const id of CRAFT_AXIS_IDS) resolved[id] = weights[id] as number;
  return Object.freeze(resolved);
}

/**
 * The proposal as a map, for documentation and sensitivity analysis only.
 *
 * Deliberately a function with an argument that has to be typed out: the cost
 * of writing `proposedCraftWeights('documentation-only')` at a call site is one
 * line, and the benefit is that every call site says out loud that the number
 * it is about to print is not a decision.
 */
export function proposedCraftWeights(
  acknowledgement: 'documentation-only' | 'sensitivity-analysis',
): Readonly<Record<CraftAxisId, number>> {
  if (acknowledgement !== 'documentation-only' && acknowledgement !== 'sensitivity-analysis') {
    throw new Error(CRAFT_WEIGHT_PROPOSAL_LABEL);
  }
  const proposed = {} as Record<CraftAxisId, number>;
  for (const id of CRAFT_AXIS_IDS) proposed[id] = PROPOSED_CRAFT_AXES[id].proposedWeight;
  return Object.freeze(proposed);
}
