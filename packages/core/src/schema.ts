import { z } from 'zod';
import { CATEGORY_IDS } from './types.js';
import { CRAFT_AXIS_IDS, EVIDENCE_MODE_IDS } from './constructs.js';

export const rubricCriterionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  weight: z.number().positive().max(1),
});

/* -------------------------------------------------------------------------- */
/* M2.1 — the three grading modes                                             */
/* -------------------------------------------------------------------------- */

/**
 * M2.1's cascade, as the route an item declares in advance.
 *
 *   fault      deduction grading against deterministic or reference-grounded
 *              checks — the v2 judge behaviour, now named rather than assumed;
 *   dimension  anchored 0–4 scores, which is why declaring it obliges the item
 *              to carry behavioural anchors (see questionSchema's refinement);
 *   pairwise   close comparison of two valid creative answers, whose ballot
 *              carries `both unacceptable` as an outcome distinct from a tie.
 *
 * Absent means the legacy route: v1/v2 items are graded as they always were.
 * A missing mode must never be read as "any mode will do".
 */
export const JUDGE_MODES = ['fault', 'dimension', 'pairwise'] as const;
export const judgeModeSchema = z.enum(JUDGE_MODES);

/* -------------------------------------------------------------------------- */
/* M2.4 — atomic criteria                                                     */
/* -------------------------------------------------------------------------- */

export const ATOMIC_CRITERION_KINDS = ['include', 'avoid', 'critical', 'exceptional'] as const;
export const atomicCriterionKindSchema = z.enum(ATOMIC_CRITERION_KINDS);

/**
 * One checkable claim about an answer. The unit matters: a v1-style criterion
 * ("Technique accuracy — 5 = good reasoning") bundles half a dozen judgements
 * into one number, which is precisely how 800 of 970 criteria came back as 5/5.
 *
 * `weight` is required on every kind, including `critical`, but a critical
 * criterion's weight does NOT describe its consequence — M2.2 caps a critical
 * safety or allergen failure at zero for the whole task regardless of weight.
 * Anything aggregating these must apply the cap first and the weights second;
 * multiplying a critical criterion by 0.1 and moving on is the failure mode
 * this comment exists to prevent.
 */
export const atomicCriterionSchema = z.object({
  /** Stable within the item, so ballots and adjudications can cite it. */
  id: z.string().min(1).optional(),
  kind: atomicCriterionKindSchema,
  /** One claim. If it needs an "and", it is two criteria. */
  statement: z.string().min(1),
  weight: z.number().positive().finite(),
  /** Which anchored dimension this criterion is evidence for, if any. */
  dimension: z.string().min(1).optional(),
  /** What in the answer counts as evidence for or against. */
  evidence: z.string().min(1).optional(),
  /** Link into the item's failure taxonomy when this criterion is missed. */
  failureLabel: z.string().min(1).optional(),
});

/**
 * The legacy criterion shape, with `kind` declared as necessarily absent.
 *
 * Declaring the key is the point. z.object silently strips undeclared keys, so
 * without this an atomic criterion carrying a typo'd kind (`kind: includ`)
 * would fail the atomic branch, match the legacy branch, lose its `kind`
 * entirely and be graded as a v1 rubric line — a silent downgrade of exactly
 * the sort that put eighteen wrong scores into 2026-06-v2.
 */
export const legacyRubricCriterionSchema = rubricCriterionSchema.extend({
  kind: z.undefined(),
});

export const rubricEntrySchema = z.union([atomicCriterionSchema, legacyRubricCriterionSchema]);

const LEGACY_WEIGHT_SUM_TOLERANCE = 1e-6;

export function isAtomicCriterion(
  entry: unknown,
): entry is z.infer<typeof atomicCriterionSchema> {
  return typeof entry === 'object' && entry !== null && 'kind' in entry &&
    (ATOMIC_CRITERION_KINDS as readonly string[]).includes((entry as { kind: string }).kind);
}

/**
 * One line of judge attention hint from a criterion of either shape.
 *
 * judge.ts renders hints as `${c.name}: ${c.description}`, which cannot survive
 * the widened rubric type — an atomic criterion has neither field. This is that
 * line's replacement rather than a reason to give atomic criteria a vestigial
 * `name`.
 */
export function criterionAttentionHint(entry: z.infer<typeof rubricEntrySchema>): string {
  return isAtomicCriterion(entry)
    ? `${entry.kind}: ${entry.statement.trim()}`
    : `${entry.name}: ${entry.description.trim()}`;
}

/**
 * A rubric is either wholly legacy or wholly atomic, never a mixture.
 *
 * The two shapes carry incompatible arithmetic: legacy weights are shares of a
 * whole that must sum to 1, atomic weights are per-claim magnitudes that need
 * not. A mixed array has no defensible normalisation, so it is refused rather
 * than guessed at.
 */
export const rubricSchema = z
  .array(rubricEntrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    const atomic = entries.filter(isAtomicCriterion).length;
    if (atomic > 0 && atomic < entries.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a rubric must be entirely legacy {name, description, weight} or entirely atomic criteria, not both',
      });
      return;
    }
    if (atomic === 0) {
      // The v1 invariant, preserved unchanged for the 97 existing declarations.
      const sum = entries.reduce((s, c) => s + (c as { weight: number }).weight, 0);
      if (Math.abs(sum - 1) > LEGACY_WEIGHT_SUM_TOLERANCE) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'rubric weights must sum to 1' });
      }
      return;
    }
    const ids = entries
      .map((c) => (c as { id?: string }).id)
      .filter((id): id is string => typeof id === 'string');
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'atomic criterion ids must be unique within an item',
      });
    }
  });

export const numericTargetSchema = z.object({
  label: z.string().min(1),
  expected: z.number(),
  unit: z.string().optional(),
  tolerancePct: z.number().nonnegative().optional(),
  toleranceAbs: z.number().nonnegative().optional(),
});

export const toleranceBandSchema = z
  .object({
    tolerancePct: z.number().nonnegative().optional(),
    toleranceAbs: z.number().nonnegative().optional(),
    score: z.number().min(0).max(100),
  })
  .refine((b) => b.tolerancePct !== undefined || b.toleranceAbs !== undefined, {
    message: 'a tolerance band needs tolerancePct or toleranceAbs',
  });

const numericGrader = z.object({
  type: z.literal('numeric'),
  expected: z.number(),
  unit: z.string().optional(),
  tolerancePct: z.number().nonnegative().optional(),
  toleranceAbs: z.number().nonnegative().optional(),
  acceptEquivalentUnits: z.boolean().optional(),
  /**
   * Opt out of the prompt-echo filter for the rare item whose correct answer
   * legitimately IS a value from the prompt ("boiling adds no calories, so it
   * is still 270 kcal"). Without this the filter deletes the right answer.
   */
  expectedInPrompt: z.boolean().optional(),
  bands: z.array(toleranceBandSchema).min(1).optional(),
});

const numericMultiGrader = z.object({
  type: z.literal('numeric-multi'),
  targets: z.array(numericTargetSchema).min(2),
  scoring: z.enum(['all-or-nothing', 'proportional']),
});

const rangeGrader = z.object({
  type: z.literal('range'),
  min: z.number(),
  max: z.number(),
  unit: z.string().optional(),
});

const keywordGrader = z
  .object({
    type: z.literal('keyword'),
    required: z.array(z.array(z.string().min(1)).min(1)).optional(),
    forbidden: z.array(z.string().min(1)).optional(),
  })
  .refine((g) => (g.required?.length ?? 0) > 0 || (g.forbidden?.length ?? 0) > 0, {
    message: 'a keyword grader needs at least one required group or forbidden term',
  });

const llmJudgeGrader = z.object({
  type: z.literal('llm-judge'),
  /**
   * M2.1. Which of the three routes grades this item. Absent = the legacy
   * route; see judgeModeSchema for why absence is not a default.
   */
  judgeMode: judgeModeSchema.optional(),
  // Optional under judge-v2 (deduction grading): rubric criteria serve only as
  // attention hints, alongside or instead of question.judgingNotes. Under v3
  // the same field carries atomic criteria instead — see rubricSchema, which
  // keeps the legacy sum-to-1 rule for legacy declarations and refuses a mix.
  rubric: rubricSchema.optional(),
  constraintChecks: z
    .array(
      z.union([numericGrader, numericMultiGrader, rangeGrader, keywordGrader]),
    )
    .optional(),
  judgeWeight: z.number().positive().max(1).optional(),
});

export const graderSpecSchema = z.union([
  numericGrader,
  numericMultiGrader,
  rangeGrader,
  keywordGrader,
  llmJudgeGrader,
]);

/* -------------------------------------------------------------------------- */
/* M2.3 — behavioural scoring anchors                                         */
/* -------------------------------------------------------------------------- */

/** M2.1's dimension mode is a 0–4 scale, so an anchor set is exactly five bands. */
export const ANCHOR_BAND_INDICES = [0, 1, 2, 3, 4] as const;

export const anchorBandSchema = z.object({
  band: z.number().int().min(0).max(4),
  /** What an answer at this band OBSERVABLY does. See anchorBandObservability. */
  descriptor: z.string().min(1),
  /** Optional pointer at a worked example or archived answer that sits here. */
  exampleRef: z.string().min(1).optional(),
});

/**
 * Words M2.3 names, and their close relatives, as stems.
 *
 * M2.3: "Terms such as 'excellent,' 'creative' or 'authentic' are insufficient
 * without operational meaning." They are not banned — a band may well say
 * "creative in the sense that it..." — but they carry no observable content on
 * their own, so they do not count towards one.
 */
export const NON_OBSERVABLE_EVALUATIVE_STEMS = [
  'excellen', 'creativ', 'authentic', 'good', 'bad', 'great', 'poor', 'weak', 'strong',
  'amazing', 'outstanding', 'exceptional', 'impressive', 'superb', 'delicious', 'tasty',
  'sophisticat', 'elegant', 'professional', 'masterful', 'brilliant', 'flawless', 'perfect',
  'mediocre', 'subpar', 'solid', 'nice', 'wonderful', 'beautiful', 'stunning', 'thoughtful',
  'insightful', 'clever', 'inspired', 'adequate', 'satisfactory', 'decent', 'quality',
] as const;

/**
 * Stems that name something an answer visibly DID. Prefix-matched and
 * deliberately generous: a false accept here is caught by the content-word rule
 * below, whereas a false reject would push an author towards vaguer wording to
 * satisfy the checker, which is the opposite of what M2.3 wants.
 */
export const OBSERVABLE_BEHAVIOUR_STEMS = [
  'name', 'identif', 'state', 'specif', 'quantif', 'cite', 'list', 'rank', 'order', 'sequenc',
  'select', 'choos', 'chose', 'propos', 'recommend', 'suggest', 'advis', 'explain', 'justif',
  'argu', 'predict', 'infer', 'deriv', 'calculat', 'convert', 'scal', 'measur', 'check',
  'verif', 'test', 'confirm', 'detect', 'notic', 'observ', 'flag', 'warn', 'ask', 'clarif',
  'distinguish', 'compar', 'contrast', 'correct', 'repair', 'rescu', 'recover', 'adapt',
  'substitut', 'omit', 'miss', 'ignor', 'skip', 'contradict', 'invent', 'fabricat', 'assum',
  'hedge', 'refus', 'stop', 'escalat', 'describ', 'mention', 'includ', 'exclud', 'add',
  'remov', 'appl', 'use', 'give', 'provid', 'offer', 'hold', 'plate', 'serv', 'season',
  'reheat', 'rest', 'chill', 'link', 'attribut', 'traces', 'trace', 'repeat', 'restat',
] as const;

/**
 * Words carrying no content of their own for the purposes of the density rule:
 * function words, hedging adverbs and the generic nouns a vacuous band leans on
 * ("the answer", "the work", "overall").
 */
const ANCHOR_FILLER_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'with', 'without',
  'from', 'by', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this',
  'that', 'these', 'those', 'their', 'there', 'they', 'he', 'she', 'his', 'her', 'not', 'no',
  'any', 'all', 'some', 'more', 'most', 'less', 'least', 'very', 'quite', 'fairly', 'mostly',
  'entirely', 'completely', 'fully', 'largely', 'reasonably', 'sufficiently', 'generally',
  'somewhat', 'overall', 'throughout', 'answer', 'answers', 'response', 'responses', 'reply',
  'work', 'level', 'standard', 'band', 'score', 'scores',
]);

const ANCHOR_MIN_WORDS = 5;
const ANCHOR_MIN_CONTENT_WORDS = 3;

export const ANCHOR_ISSUE_REASONS = [
  'not-a-set',
  'empty',
  'too-short',
  'no-observable-behaviour',
  'evaluative-only',
  'duplicate-band-text',
  'band-coverage',
] as const;
export type AnchorIssueReason = (typeof ANCHOR_ISSUE_REASONS)[number];

export interface AnchorIssue {
  /** The 0–4 band at fault, where the fault belongs to one band. */
  band?: number;
  reason: AnchorIssueReason;
  detail: string;
}

function anchorTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9'\- ]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function matchesStem(token: string, stems: readonly string[]): boolean {
  return stems.some((stem) => token.startsWith(stem));
}

/**
 * Is this band descriptor a description of observable behaviour?
 *
 * Two independent conditions, both required, because either alone is trivially
 * satisfiable:
 *
 *   1. it names a behaviour — a verb from the lexicon, or a digit, since a
 *      quantified statement ("two of the three causes") is observable by
 *      construction;
 *   2. once function words, hedges and the M2.3 evaluative vocabulary are
 *      removed, at least three content words remain.
 *
 * Rule 2 is what stops "Provides an excellent, creative and authentic answer
 * overall" from passing on the strength of "provides". Rule 1 is what stops a
 * concrete but purely nominal band ("the acid, the fat, the crunch") from
 * passing as a description of what the answer did with them.
 *
 * Fails closed on anything that is not a non-empty string.
 */
export function anchorBandObservability(
  descriptor: unknown,
): { observable: boolean; reason?: AnchorIssueReason; detail?: string } {
  if (typeof descriptor !== 'string' || descriptor.trim().length === 0) {
    return { observable: false, reason: 'empty', detail: 'band descriptor is missing or blank' };
  }
  const tokens = anchorTokens(descriptor);
  if (tokens.length < ANCHOR_MIN_WORDS) {
    return {
      observable: false,
      reason: 'too-short',
      detail: `${tokens.length} words: too short to name both a behaviour and what puts it in this band`,
    };
  }

  const hasBehaviour =
    tokens.some((t) => matchesStem(t, OBSERVABLE_BEHAVIOUR_STEMS)) || /\d/.test(descriptor);
  if (!hasBehaviour) {
    return {
      observable: false,
      reason: 'no-observable-behaviour',
      detail: 'no verb naming what the answer does, and nothing quantified',
    };
  }

  const evaluative = tokens.filter((t) => matchesStem(t, NON_OBSERVABLE_EVALUATIVE_STEMS));
  const content = new Set(
    tokens.filter(
      (t) =>
        !ANCHOR_FILLER_WORDS.has(t) &&
        !matchesStem(t, NON_OBSERVABLE_EVALUATIVE_STEMS) &&
        t.length > 1,
    ),
  );
  if (content.size < ANCHOR_MIN_CONTENT_WORDS) {
    return {
      observable: false,
      reason: 'evaluative-only',
      detail:
        evaluative.length > 0
          ? `bare evaluative terms (${[...new Set(evaluative)].join(', ')}) with no operational clause`
          : 'no substantive content once filler is removed',
    };
  }
  return { observable: true };
}

export function isObservableAnchorBand(descriptor: unknown): boolean {
  return anchorBandObservability(descriptor).observable;
}

/**
 * Everything wrong with an anchor set. Empty result = usable.
 *
 * Takes `unknown` on purpose: it is called from a zod refinement, from tests
 * and from authoring tools that have not parsed anything yet, and an anchor set
 * that cannot be understood must refuse rather than pass silently.
 */
export function behaviouralAnchorIssues(set: unknown): AnchorIssue[] {
  if (typeof set !== 'object' || set === null) {
    return [{ reason: 'not-a-set', detail: 'anchor set is not an object' }];
  }
  const bands = (set as { bands?: unknown }).bands;
  if (!Array.isArray(bands)) {
    return [{ reason: 'not-a-set', detail: 'anchor set has no bands array' }];
  }

  const issues: AnchorIssue[] = [];
  const seen = new Map<number, string>();
  for (const raw of bands) {
    const band = (raw as { band?: unknown })?.band;
    const descriptor = (raw as { descriptor?: unknown })?.descriptor;
    if (typeof band !== 'number' || !ANCHOR_BAND_INDICES.includes(band as 0 | 1 | 2 | 3 | 4)) {
      issues.push({ reason: 'band-coverage', detail: `band index ${String(band)} is not 0–4` });
      continue;
    }
    if (seen.has(band)) {
      issues.push({ band, reason: 'band-coverage', detail: `band ${band} is described twice` });
      continue;
    }
    seen.set(band, typeof descriptor === 'string' ? descriptor.trim().toLowerCase() : '');

    const verdict = anchorBandObservability(descriptor);
    if (!verdict.observable) {
      issues.push({ band, reason: verdict.reason!, detail: verdict.detail! });
    }
  }

  for (const index of ANCHOR_BAND_INDICES) {
    if (!seen.has(index)) {
      issues.push({ band: index, reason: 'band-coverage', detail: `band ${index} is missing` });
    }
  }

  // Two bands with the same words describe no boundary between them, which is
  // the Gate 2 requirement that anchors "distinguish ordinary from exceptional
  // work" failing in the least visible way available.
  const byText = new Map<string, number[]>();
  for (const [band, text] of seen) {
    if (text.length === 0) continue;
    byText.set(text, [...(byText.get(text) ?? []), band]);
  }
  for (const [, sharing] of byText) {
    if (sharing.length > 1) {
      issues.push({
        reason: 'duplicate-band-text',
        detail: `bands ${sharing.sort().join(' and ')} share the same descriptor`,
      });
    }
  }

  return issues;
}

export const behaviouralAnchorSetSchema = z
  .object({
    /** The scored dimension these bands anchor, e.g. "diagnostic ranking". */
    dimension: z.string().min(1),
    /** What the dimension means, so a judge is not reverse-engineering it. */
    definition: z.string().min(1).optional(),
    bands: z.array(anchorBandSchema).length(ANCHOR_BAND_INDICES.length),
  })
  .superRefine((set, ctx) => {
    for (const issue of behaviouralAnchorIssues(set)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: issue.band === undefined ? ['bands'] : ['bands', issue.band],
        message: `${issue.reason}: ${issue.detail}`,
      });
    }
  });

/* -------------------------------------------------------------------------- */
/* M2.4 — judge packs                                                         */
/* -------------------------------------------------------------------------- */

export const SOURCE_CONFIDENCES = ['high', 'medium', 'low', 'contested'] as const;

export const sourceRefSchema = z.object({
  citation: z.string().min(1),
  url: z.string().min(1).optional(),
  /**
   * M3.1 requires source confidence, and `contested` is a first-class value:
   * M3's history family explicitly admits items where the disagreement between
   * sources IS the expected answer.
   */
  confidence: z.enum(SOURCE_CONFIDENCES),
  accessedAt: z.string().min(1).optional(),
});

export const solutionFamilySchema = z.object({
  id: z.string().min(1),
  summary: z.string().min(1),
  /** Why this route is acceptable, in the item's own terms. */
  whyAcceptable: z.string().min(1),
  /** What would make an answer in this family wrong anyway. */
  boundaries: z.string().min(1).optional(),
});

export const FAILURE_TAXONOMY_DOMAINS = [
  'reasoning',
  'sequencing',
  'safety',
  'feasibility',
  'state',
  'context',
  'sensory',
] as const;

export const FAILURE_SEVERITIES = ['critical', 'major', 'minor'] as const;

export const failureModeSchema = z.object({
  label: z.string().min(1),
  description: z.string().min(1),
  domain: z.enum(FAILURE_TAXONOMY_DOMAINS).optional(),
  severity: z.enum(FAILURE_SEVERITIES).optional(),
});

export const WORKED_EXAMPLE_KINDS = [
  'exceptional',
  'competent-ordinary',
  'plausible-but-wrong',
  'clearly-failing',
] as const;

export const workedExampleSchema = z.object({
  kind: z.enum(WORKED_EXAMPLE_KINDS),
  answer: z.string().min(1),
  /** Why it lands there, in criterion terms — not "because it is better". */
  whyItLandsHere: z.string().min(1),
  /** Where it should score, for calibration. */
  expectedBand: z.number().int().min(0).max(4).optional(),
  expectedScoreMax: z.number().min(0).max(100).optional(),
});

export const KITCHEN_PLAN_FIXTURE_KINDS = [
  'valid-alternative',
  'invalid-transition',
  'cycle',
  'resource-conflict',
  'unsafe-trajectory',
  'incorrect-service-state',
] as const;

export const judgePackSchema = z
  .object({
    /** M2.4's first line: what capability this item is testing. */
    capabilityUnderTest: z.string().min(1),
    /**
     * Required, not defaulted. An item with no hard constraints must say so
     * with an empty list; silence is the state where nobody knows whether the
     * constraints were considered.
     */
    hardConstraints: z.array(z.string().min(1)),
    criteria: z.array(atomicCriterionSchema).min(1),
    /** M2.4: the intended sensory, practical or historical outcome. */
    intendedOutcome: z
      .object({
        sensory: z.string().min(1).optional(),
        practical: z.string().min(1).optional(),
        historical: z.string().min(1).optional(),
      })
      .refine((o) => Boolean(o.sensory || o.practical || o.historical), {
        message: 'intendedOutcome needs at least one of sensory, practical or historical',
      }),
    sources: z.array(sourceRefSchema),
    solutionFamilies: z.array(solutionFamilySchema).min(1),
    /**
     * Required when only one family is declared. M2.4 asks for MULTIPLE
     * acceptable solution families; a pack with one is a reference answer
     * wearing a new schema, which is the thing judge packs replace. It is
     * allowed only where the author says out loud why the item genuinely has
     * one route.
     */
    singleFamilyJustification: z.string().min(1).optional(),
    commonFailureModes: z.array(failureModeSchema).min(1),
    workedExamples: z.array(workedExampleSchema),
    /** M2.4: KitchenPlan items also carry validator fixtures. */
    validatorFixtures: z
      .array(
        z.object({
          kind: z.enum(KITCHEN_PLAN_FIXTURE_KINDS),
          /** Inline plan, or a repo-relative path to one. Exactly one. */
          plan: z.unknown().optional(),
          planRef: z.string().min(1).optional(),
          expect: z.enum(['accept', 'reject']),
          /** The finding the validator must produce when it rejects. */
          expectedFinding: z.string().min(1).optional(),
        }),
      )
      .optional(),
  })
  .superRefine((pack, ctx) => {
    if (pack.solutionFamilies.length < 2 && !pack.singleFamilyJustification) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['solutionFamilies'],
        message:
          'declare multiple acceptable solution families, or justify the single family in singleFamilyJustification',
      });
    }
    const ids = pack.solutionFamilies.map((f) => f.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['solutionFamilies'],
        message: 'solution family ids must be unique',
      });
    }
    // All four worked examples, every time. The plausible-but-wrong one is the
    // whole reason the list exists: a pack that only shows a judge good and bad
    // answers has not tested the case where the answer reads well and is wrong.
    const present = new Set(pack.workedExamples.map((e) => e.kind));
    const missing = WORKED_EXAMPLE_KINDS.filter((k) => !present.has(k));
    if (missing.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['workedExamples'],
        message: `missing worked example(s): ${missing.join(', ')}`,
      });
    }
    for (const [index, fixture] of (pack.validatorFixtures ?? []).entries()) {
      const hasInline = fixture.plan !== undefined;
      if (hasInline === Boolean(fixture.planRef)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['validatorFixtures', index],
          message: 'a validator fixture needs exactly one of plan or planRef',
        });
      }
      if (fixture.expect === 'reject' && !fixture.expectedFinding) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['validatorFixtures', index],
          message:
            'a rejecting fixture must name the finding, or it passes when the validator rejects for the wrong reason',
        });
      }
    }
  });

/* -------------------------------------------------------------------------- */
/* M1.2 — KitchenPlan                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Minutes on a plan-relative clock, zero at the first operation. Service sits
 * at `serviceAtMinute`; wall-clock time is decoration carried separately,
 * because a plan that only says "19:30" cannot be checked against a duration.
 */
export const planMinuteSchema = z.number().finite().min(0);

export const planQuantitySchema = z.object({
  amount: z.number().finite(),
  /** Free text: "g", "tbsp", "gō", "medium onions". Locale traps live here. */
  unit: z.string().min(1),
  /** "About a handful" is a real instruction; recording it beats losing it. */
  approximate: z.boolean().optional(),
});

/**
 * Where a number a validator relies on came from.
 *
 * M1.2: "A candidate cannot validate its own plan by inventing convenient
 * assumptions." Structural validation is deterministic only against limits
 * that came from the prompt or an independently verified judge pack, so every
 * limit carries its provenance and `candidate-assumption` is an explicit,
 * non-default value the validator must refuse to treat as verified.
 */
export const PLAN_LIMIT_SOURCES = ['prompt', 'judge-pack', 'candidate-assumption'] as const;
export const planLimitSourceSchema = z.enum(PLAN_LIMIT_SOURCES);

export const planIngredientSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  quantity: planQuantitySchema.optional(),
  /**
   * Required, possibly empty. An omitted allergen list and a genuinely
   * allergen-free ingredient are indistinguishable, and one of them kills
   * somebody.
   */
  allergens: z.array(z.string().min(1)),
  /**
   * Free text by design. A closed enum of culinary states would reject viable
   * plans on vocabulary grounds, which M1.2 forbids: "a validator must never
   * reject a viable approach merely because it differs from one reference
   * path."
   */
  startingState: z.string().min(1),
  notes: z.string().min(1).optional(),
});

export const planEquipmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** "28 cm pan", "4 shelves", or a measured capacity. */
  capacity: z.union([z.string().min(1), planQuantitySchema]).optional(),
  /** How many exist. Zero is legal and means "named but unavailable". */
  countAvailable: z.number().int().min(0),
  availableFromMinute: planMinuteSchema.optional(),
  availableUntilMinute: planMinuteSchema.optional(),
  /** Where the capacity figure came from — see planLimitSourceSchema. */
  capacitySource: planLimitSourceSchema.optional(),
  notes: z.string().min(1).optional(),
});

export const planTemperatureSchema = z.object({
  value: z.number().finite(),
  unit: z.enum(['C', 'F']),
  /** Oven air and meat core are different claims; conflating them is a defect. */
  kind: z.enum(['oven', 'surface', 'internal', 'ambient', 'oil', 'water', 'fridge', 'freezer']),
});

export const planDurationSchema = z
  .object({
    minMinutes: z.number().finite().min(0),
    maxMinutes: z.number().finite().min(0),
  })
  .refine((d) => d.maxMinutes >= d.minMinutes, {
    message: 'maxMinutes must be at least minMinutes',
  });

export const planOperationSchema = z.object({
  id: z.string().min(1),
  /** "sear", "rest", "emulsify" — the verb, not a sentence. */
  action: z.string().min(1),
  /** Ids of ingredients or of earlier operation outputs. */
  inputs: z.array(z.string().min(1)),
  outputs: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        state: z.string().min(1),
      }),
    )
    .min(1),
  /** Equipment ids. Empty means hands only — again, said rather than implied. */
  equipment: z.array(z.string().min(1)),
  duration: planDurationSchema.optional(),
  temperature: planTemperatureSchema.optional(),
  /** "Until the fond is deep brown and the pan smells nutty." */
  sensoryTarget: z.string().min(1).optional(),
  /**
   * Whether the cook is occupied. Without this, parallel branches are a graph
   * drawing rather than a claim about whether one person can execute the plan.
   */
  attention: z.enum(['active', 'passive']).optional(),
  startAtMinute: planMinuteSchema.optional(),
});

export const PLAN_DEPENDENCY_KINDS = [
  'finish-to-start',
  'start-to-start',
  'finish-to-finish',
] as const;

export const planDependencySchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(PLAN_DEPENDENCY_KINDS),
  /** Minimum gap; a rest or a chill is a dependency with a lag, not a step. */
  lagMinutes: z.number().finite().min(0).optional(),
});

export const planBranchSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  operations: z.array(z.string().min(1)).min(1),
  /** Branches asserted to run concurrently with this one. */
  parallelWith: z.array(z.string().min(1)).optional(),
});

export const planStateTransitionSchema = z.object({
  /** Ingredient or operation-output id whose state changes. */
  subjectId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  byOperation: z.string().min(1),
  atMinute: planMinuteSchema.optional(),
});

export const planSafetyCheckpointSchema = z.object({
  id: z.string().min(1),
  /** The operation after which the check happens. */
  afterOperation: z.string().min(1),
  check: z.string().min(1),
  threshold: z
    .object({
      value: z.number().finite(),
      unit: z.string().min(1),
      comparator: z.enum(['at-least', 'at-most', 'between']),
      upper: z.number().finite().optional(),
    })
    .optional(),
  source: planLimitSourceSchema,
});

export const planTrajectoryInvariantSchema = z.object({
  id: z.string().min(1),
  /** "No component sits between 5 and 60 °C for more than two hours in total." */
  statement: z.string().min(1),
  appliesFromMinute: planMinuteSchema.optional(),
  appliesUntilMinute: planMinuteSchema.optional(),
  source: planLimitSourceSchema,
});

export const planObservationSchema = z.object({
  id: z.string().min(1),
  atMinute: planMinuteSchema,
  subjectId: z.string().min(1).optional(),
  observation: z.string().min(1),
  /** Whether the plan is expected to change in response. */
  requiresResponse: z.boolean(),
});

export const planHoldingLimitSchema = z.object({
  componentId: z.string().min(1),
  maxHoldMinutes: z.number().finite().min(0),
  /** "Hot-held at or above 63 °C", "covered, ambient". */
  condition: z.string().min(1),
  source: planLimitSourceSchema,
});

export const planServiceStateSchema = z.object({
  atMinute: planMinuteSchema,
  components: z
    .array(
      z.object({
        componentId: z.string().min(1),
        state: z.string().min(1),
        temperature: planTemperatureSchema.optional(),
        platedWith: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1),
  notes: z.string().min(1).optional(),
});

/**
 * The M1.2 minimum object set.
 *
 * Deliberately shape-only: this schema does NOT resolve id references, detect
 * cycles or check resource conflicts. Two reasons, and the second is the one
 * that bites. First, semantic validity is the downstream validator's job and
 * M1.2 requires structural consistency and culinary correctness to be reported
 * separately. Second, M2.4 requires fixtures containing cycles, invalid
 * transitions, resource conflicts and unsafe trajectories — if the schema
 * refused those, the fixtures could not be authored in the first place and the
 * validator would ship untested against exactly the plans it exists to catch.
 */
export const kitchenPlanSchema = z.object({
  title: z.string().min(1),
  servings: z.number().int().min(1),
  /** BCP-47 or a plain locale name; AU tbsp and UK pint traps live here. */
  locale: z.string().min(1),
  serviceAtMinute: planMinuteSchema,
  /** Wall-clock service time, for rendering only. */
  serviceClock: z.string().min(1).optional(),
  ingredients: z.array(planIngredientSchema).min(1),
  equipment: z.array(planEquipmentSchema),
  operations: z.array(planOperationSchema).min(1),
  dependencies: z.array(planDependencySchema),
  branches: z.array(planBranchSchema).optional(),
  stateTransitions: z.array(planStateTransitionSchema),
  safetyCheckpoints: z.array(planSafetyCheckpointSchema),
  trajectoryInvariants: z.array(planTrajectoryInvariantSchema),
  observations: z.array(planObservationSchema).optional(),
  holdingLimits: z.array(planHoldingLimitSchema),
  serviceState: planServiceStateSchema,
  /** Anything the plan assumed, with where the assumption came from. */
  assumptions: z
    .array(z.object({ statement: z.string().min(1), source: planLimitSourceSchema }))
    .optional(),
});

/** What an item demands of a candidate's plan, and how it will be validated. */
export const kitchenPlanContractSchema = z.object({
  /** Which of the M1.2 objects this item actually scores. */
  requiredObjects: z.array(z.string().min(1)).min(1),
  validatorVersion: z.string().min(1),
  /**
   * Limits the validator may treat as verified, restated here so the item —
   * not the candidate — owns them.
   */
  verifiedLimits: z
    .array(
      z.object({
        statement: z.string().min(1),
        source: z.enum(['prompt', 'judge-pack']),
      }),
    )
    .optional(),
  notes: z.string().min(1).optional(),
});

/* -------------------------------------------------------------------------- */
/* M1.4 — the sensory dossier                                                 */
/* -------------------------------------------------------------------------- */

/**
 * M1.4's "compact comparable contract". Every field is required, including the
 * seven balance strategies: the contract exists so that Palate judges compare
 * like with like and unstructured verbosity stops paying, and an optional field
 * is one an eloquent answer will simply omit.
 */
export const sensoryDossierSchema = z.object({
  dishIdentity: z.string().min(1),
  intendedDinerExperience: z.string().min(1),
  firstAroma: z.string().min(1),
  aromaticProgression: z.string().min(1),
  dominantFlavours: z.array(z.string().min(1)).min(1),
  supportingFlavours: z.array(z.string().min(1)),
  finishingFlavours: z.array(z.string().min(1)),
  balance: z.object({
    salt: z.string().min(1),
    acid: z.string().min(1),
    sweetness: z.string().min(1),
    bitterness: z.string().min(1),
    savouriness: z.string().min(1),
    fat: z.string().min(1),
    heat: z.string().min(1),
  }),
  textureContrast: z.string().min(1),
  temperatureContrast: z.string().min(1),
  /** First bite to finish. */
  progression: z.string().min(1),
  likelySensoryFailure: z.object({
    failure: z.string().min(1),
    correction: z.string().min(1),
  }),
  /** M1.4's last line, and the one restraint is measured on. */
  deliberateOmissions: z.array(z.string().min(1)).min(1),
});

/* -------------------------------------------------------------------------- */
/* M1.3 — the Interactive Kitchen script                                      */
/* -------------------------------------------------------------------------- */

/** M1.3 requires preference, common-sense and safety ambiguity kept apart. */
export const AMBIGUITY_KINDS = ['preference', 'common-sense', 'safety', 'none'] as const;

/** M1.3's four legitimate opening moves. */
export const FIRST_MOVES = ['action', 'clarification', 'refusal', 'safe-fallback'] as const;

export const SECOND_TURN_KINDS = [
  'observation',
  'condition-change',
  'late-disclosure',
  'equipment-loss',
  'ingredient-loss',
] as const;

/**
 * A deterministic two-turn script. Deterministic is the whole design: the v3
 * pilot uses "fixed two-turn observation/change scripts" precisely so that no
 * part of the second turn depends on a model improvising a reply, which would
 * make the item unreproducible and the harness a second candidate.
 */
export const interactiveScriptSchema = z
  .object({
    scriptVersion: z.string().min(1),
    ambiguity: z.object({
      kind: z.enum(AMBIGUITY_KINDS),
      /**
       * Whether the ambiguity is real. M1.3 penalises needless questioning as
       * well as reckless guessing, so the clear half of a paired item declares
       * `genuine: false` and expects no clarification at all.
       */
      genuine: z.boolean(),
      whatIsUnderspecified: z.string().min(1).optional(),
    }),
    /** Usually one. Zero means the item forbids clarification outright. */
    clarificationBudget: z.number().int().min(0),
    acceptableFirstMoves: z.array(z.enum(FIRST_MOVES)).min(1),
    /** Fixed replies, matched on topic. */
    clarificationResponses: z
      .array(
        z.object({
          topic: z.string().min(1),
          matches: z.array(z.string().min(1)).min(1),
          reply: z.string().min(1),
        }),
      )
      .optional(),
    /**
     * The reply given when the model asks something unanticipated. Required
     * whenever clarification is permitted: without it the harness has to
     * improvise, and an improvised turn is a different item for every model.
     */
    defaultClarificationReply: z.string().min(1).optional(),
    secondTurn: z.object({
      kind: z.enum(SECOND_TURN_KINDS),
      /** Delivered verbatim, whatever the first move was. */
      text: z.string().min(1),
    }),
    /** What must remain true across the whole trajectory. */
    trajectoryInvariants: z.array(z.string().min(1)),
    expectedFinalState: z.string().min(1),
    /** The clear counterpart item, per M3's paired-prompt requirement. */
    pairedCounterpartId: z.string().min(1).optional(),
    /** Questions that would be needless here, for the judge pack to cite. */
    needlessQuestionExamples: z.array(z.string().min(1)).optional(),
  })
  .superRefine((script, ctx) => {
    if (script.clarificationBudget > 0 && !script.defaultClarificationReply) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultClarificationReply'],
        message:
          'a script permitting clarification must fix the reply to an unanticipated question',
      });
    }
    if (script.clarificationBudget === 0 && script.acceptableFirstMoves.includes('clarification')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['acceptableFirstMoves'],
        message: 'clarification cannot be an acceptable first move when the budget is zero',
      });
    }
  });

/* -------------------------------------------------------------------------- */
/* M3.1 / M3.6 — item classification, provenance and exposure                 */
/* -------------------------------------------------------------------------- */

/** M3.7 reporting strata. Assigned as a hypothesis; see stratumHypothesis. */
export const ITEM_STRATA = ['chef-consensus', 'chef-frontier', 'chef-horizon'] as const;

/**
 * M3.6 bank exposure. Orthogonal to `status` (active/basics/retired), which
 * says whether an item scores; this says who has seen it. An item can be
 * `public-core` and `active` at once, and `retired` appears in both lists
 * meaning different things — disclosed here, not-run there.
 */
export const EXPOSURE_STATES = [
  'public-core',
  'live',
  'chefs-table',
  'linking-anchor',
  'retired',
] as const;

/** The vocabulary's verification ladder, recorded rather than inferred. */
export const VERIFICATION_STATES = [
  'draft',
  'independent-solve',
  'expert-review',
  'certified',
  'certified-after-repair',
  'diagnostic-only',
  'admitted',
  'retired',
] as const;

export const KITCHEN_CONTEXTS = ['domestic', 'professional', 'resource-limited'] as const;

export const itemContextSchema = z.object({
  /** "en-GB", "AU", "JP" — the locale whose conventions the item assumes. */
  locale: z.string().min(1),
  kitchen: z.enum(KITCHEN_CONTEXTS),
  equipment: z.array(z.string().min(1)),
  skillLevel: z.string().min(1).optional(),
  /** M1.8: browser-enabled and closed-book conditions are reported apart. */
  toolConditions: z
    .object({
      browsing: z.boolean(),
      images: z.boolean(),
      followUpQuestions: z.boolean(),
    })
    .optional(),
});

export const itemClassificationSchema = z.object({
  primaryCapability: z.enum(CRAFT_AXIS_IDS),
  secondaryCapabilities: z.array(z.enum(CRAFT_AXIS_IDS)).optional(),
  evidenceLayer: z.enum(EVIDENCE_MODE_IDS),
  taskFamily: z.string().min(1),
  /**
   * M3.7: variants of one scenario are not independent evidence. Items sharing
   * a cluster id must be resampled together, and a bank that loses this field
   * silently overstates its own effective size — the failure `effectiveItems`
   * measured at 24.2 against a nominal 102.
   */
  scenarioFamily: z.string().min(1),
  /**
   * M3.7: the stratum is a HYPOTHESIS until certified. It is named as one so
   * that no report can print "Chef Frontier" as though difficulty had been
   * measured, and `certified` defaults to false so silence is not certification.
   */
  stratumHypothesis: z.object({
    stratum: z.enum(ITEM_STRATA),
    rationale: z.string().min(1),
    certified: z.boolean().default(false),
  }),
  context: itemContextSchema.optional(),
  /** M3.1: the shortcut or failure mode this item exists to block. */
  shortcutBlocked: z.string().min(1),
  /** Chef-authored labels for what going wrong here looks like. */
  failureTaxonomy: z
    .array(
      z.object({
        domain: z.enum(FAILURE_TAXONOMY_DOMAINS),
        label: z.string().min(1),
        description: z.string().min(1).optional(),
      }),
    )
    .optional(),
});

export const PROVENANCE_STAGES = [
  'human-seed',
  'agent-draft',
  'agent-mutation',
  'human-revision',
] as const;

/**
 * M3.9: "Treat provenance as granular metadata, not a binary label." A chain of
 * stages, in order, each with who or what did it — not a `humanAuthored`
 * boolean, which cannot distinguish a human-seeded agent draft revised by a
 * human from a human item an agent reworded.
 */
export const provenanceStepSchema = z.object({
  stage: z.enum(PROVENANCE_STAGES),
  /** Person or model that performed this step. */
  actor: z.string().min(1),
  at: z.string().min(1).optional(),
  /** Model version where the actor is a model — "the model" is not a version. */
  actorVersion: z.string().min(1).optional(),
  /** Prompt or transformation applied, where applicable. */
  transformation: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
});

export const MODEL_CONTACT_PURPOSES = [
  'authoring',
  'mutation',
  'difficulty-probe',
  'independent-solve',
  'adversarial-probe',
  'judging',
  'other',
] as const;

/**
 * Every model that saw this item before it scored, and why.
 *
 * M3.7 and M3.9 both turn on this: a model used to author, select, stump or
 * tune an item cannot then supply clean confirmatory evidence on it. Without a
 * per-item contact record that rule is unenforceable and gets quietly dropped.
 */
export const modelExposureSchema = z.object({
  modelId: z.string().min(1),
  modelVersion: z.string().min(1).optional(),
  purpose: z.enum(MODEL_CONTACT_PURPOSES),
  at: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
});

export const independentSolveSchema = z.object({
  solverKind: z.enum(['human-specialist', 'skilled-non-expert', 'model']),
  solverId: z.string().min(1),
  /** M3.4: blind means without the proposed answer or rubric. */
  blind: z.boolean(),
  at: z.string().min(1).optional(),
  outcome: z.enum(['solved', 'partial', 'failed']),
  notes: z.string().min(1).optional(),
});

export const REVIEW_STATUSES = ['not-required', 'pending', 'passed', 'failed'] as const;

export const reviewFlagSchema = z
  .object({
    required: z.boolean(),
    status: z.enum(REVIEW_STATUSES),
    reviewer: z.string().min(1).optional(),
    at: z.string().min(1).optional(),
    notes: z.string().min(1).optional(),
  })
  .refine((r) => !(r.required && r.status === 'not-required'), {
    message: 'a required review cannot be recorded as not-required',
  });

export const itemProvenanceSchema = z.object({
  itemVersion: z.string().min(1),
  authoringChain: z.array(provenanceStepSchema).min(1),
  author: z.string().min(1),
  reviewers: z.array(z.string().min(1)).optional(),
  repairHistory: z
    .array(z.object({ at: z.string().min(1), by: z.string().min(1), change: z.string().min(1) }))
    .optional(),
  modelExposures: z.array(modelExposureSchema),
  independentSolves: z.array(independentSolveSchema),
  verificationState: z.enum(VERIFICATION_STATES),
  sources: z.array(sourceRefSchema).optional(),
  safetyReview: reviewFlagSchema.optional(),
  culturalReview: reviewFlagSchema.optional(),
  /**
   * M1.8's Current Kitchen track. All three fields together or none: a dated
   * claim without a jurisdiction is not checkable, and one without a review
   * date silently becomes permanent.
   */
  currentKitchen: z
    .object({
      asOf: z.string().min(1),
      jurisdiction: z.string().min(1),
      nextReview: z.string().min(1),
    })
    .optional(),
});

export const itemExposureSchema = z.object({
  state: z.enum(EXPOSURE_STATES),
  /** Release whose vintage this item's scores retain. */
  releasedIn: z.string().min(1).optional(),
  retiredIn: z.string().min(1).optional(),
  /** Pre-run hash commitment for sealed material (M3.6). */
  hashCommitment: z.string().min(1).optional(),
  notes: z.string().min(1).optional(),
});

/* -------------------------------------------------------------------------- */
/* M3.1 — output contract and adversarial cases                               */
/* -------------------------------------------------------------------------- */

export const OUTPUT_FORMATS = [
  'prose',
  'kitchen-plan',
  'sensory-dossier',
  'structured-json',
  'interactive-turns',
] as const;

export const outputContractSchema = z.object({
  format: z.enum(OUTPUT_FORMATS),
  /** Sections the answer must contain, checked deterministically. */
  requiredSections: z.array(z.string().min(1)).optional(),
  /**
   * A ceiling, never a target. M2.5 forbids shortening a candidate answer to
   * remove verbosity, so this constrains what the item asks for, not what the
   * harness may do to what comes back.
   */
  maxWords: z.number().int().min(1).optional(),
  notes: z.string().min(1).optional(),
});

/** M3.5's adversarial battery, verbatim in kind. */
export const ADVERSARIAL_CASE_KINDS = [
  'correct-concise',
  'correct-unconventional',
  'polished-but-wrong',
  'verbose-non-answer',
  'hedged-contradictory',
  'keyword-stuffing',
  'negation-abuse',
  'judge-influence',
  'hard-constraint-miss',
  'style-variation',
  'semantic-equivalent-prompt',
  'alternative-valid-plan',
  'invalid-plan-convincing-answer',
] as const;

/**
 * One adversarial fixture with the score it must NOT be allowed to reach (or
 * must reach, for the correct ones). The expectation is the point: the audit
 * that found 50 items scoring 100 on bare keyword stuffing could only be run
 * because the answers and the bound were both written down.
 */
export const adversarialCaseSchema = z
  .object({
    kind: z.enum(ADVERSARIAL_CASE_KINDS),
    answer: z.string().min(1),
    expect: z.enum(['at-most', 'at-least']),
    score: z.number().min(0).max(100),
    rationale: z.string().min(1).optional(),
  })
  .refine(
    (c) =>
      !(
        (c.kind === 'correct-concise' || c.kind === 'correct-unconventional') &&
        c.expect === 'at-most'
      ),
    {
      message:
        'a correct answer fixture must assert a floor (at-least), not a ceiling — an at-most bound on a correct answer passes when the grader zeroes it',
    },
  );

/** M3.1's optional evidence pack, given to candidate and judges alike. */
export const evidencePackSchema = z.object({
  /** Shown to the candidate as well as the judge — say so explicitly. */
  sharedWithCandidate: z.boolean(),
  materials: z
    .array(z.object({ label: z.string().min(1), content: z.string().min(1) }))
    .min(1),
  sources: z.array(sourceRefSchema).optional(),
});

/* -------------------------------------------------------------------------- */
/* The item                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The un-refined object, exported so downstream tooling can `.extend()`,
 * `.pick()` or `.partial()` it for authoring drafts. Note that doing so DROPS
 * the cross-field refinements below; parse with `questionSchema` for anything
 * that will be graded.
 */
export const questionObjectSchema = z.object({
  id: z.string().regex(/^[a-z]+-\d{3}$/, 'id must look like "conv-007"'),
  category: z.enum(CATEGORY_IDS),
  difficulty: z.number().int().min(1).max(5),
  status: z.enum(['active', 'basics', 'retired']).default('active'),
  // 'v3' is admissible so v3 items can declare their vintage; the default stays
  // 'v1' because every item that omits the field predates the question.
  addedIn: z.enum(['v1', 'v2', 'v3']).default('v1'),
  trap: z.boolean().default(false),
  prompt: z.string().min(10),
  systemHint: z.string().optional(),
  grader: graderSpecSchema,
  judgingNotes: z.string().optional(),
  referenceAnswer: z.string().min(1),
  /**
   * A deliberately wrong answer. Paired with referenceAnswer it is a
   * discrimination test for the *grader* that costs nothing and calls no model:
   * the reference must score ~100 and this must score low. If both land the
   * same, the grader cannot tell right from wrong and the item is not
   * measuring anything — which is exactly what subs-020 did in 2026-06-v2,
   * where correct answers and wrong ones alike scored 0.
   */
  failingAnswer: z.string().min(1).optional(),
  source: z.string().optional(),
  public: z.boolean(),

  /* ---- v3 blocks. Every one optional: the 184 v1/v2 items predate all of  */
  /* this and must keep parsing byte-for-byte unchanged. ------------------- */

  /** M2.3 anchors, one set per scored dimension. Required by dimension mode. */
  anchors: z.array(behaviouralAnchorSetSchema).min(1).optional(),
  /** M2.4. Replaces referenceAnswer as the judge's material where present. */
  judgePack: judgePackSchema.optional(),
  outputContract: outputContractSchema.optional(),
  kitchenPlanContract: kitchenPlanContractSchema.optional(),
  interactiveScript: interactiveScriptSchema.optional(),
  classification: itemClassificationSchema.optional(),
  provenance: itemProvenanceSchema.optional(),
  exposure: itemExposureSchema.optional(),
  adversarialCases: z.array(adversarialCaseSchema).min(1).optional(),
  evidencePack: evidencePackSchema.optional(),
  /** M3.1: which deterministic validator build these checks were written for. */
  validatorVersion: z.string().min(1).optional(),
});

/**
 * The item as anything that grades it should parse it.
 *
 * The refinements are cross-field, which is why they cannot live on the blocks
 * themselves. All three are additive — a v1/v2 item declares none of the fields
 * involved and is untouched.
 */
export const questionSchema = questionObjectSchema.superRefine((q, ctx) => {
  const judgeMode = q.grader.type === 'llm-judge' ? q.grader.judgeMode : undefined;

  // M2.3: "Every scored dimension needs examples for 0, 1, 2, 3 and 4." An
  // item that declares the anchored route and ships no anchors is asking the
  // judge to invent the scale, which is the inflation v2 measured at 5/5 on
  // 800 of 970 criteria.
  if (judgeMode === 'dimension' && !q.anchors) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['anchors'],
      message: 'judgeMode "dimension" requires behavioural anchors for every scored dimension',
    });
  }

  if (q.anchors) {
    const dimensions = q.anchors.map((a) => a.dimension.trim().toLowerCase());
    if (new Set(dimensions).size !== dimensions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['anchors'],
        message: 'two anchor sets describe the same dimension',
      });
    }
  }

  // An item that demands a KitchenPlan but declares no validator contract
  // cannot be graded structurally, so it would fall back to prose judging on an
  // answer written as data — the worst of both routes.
  if (q.outputContract?.format === 'kitchen-plan' && !q.kitchenPlanContract) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['kitchenPlanContract'],
      message: 'an item whose output contract is a KitchenPlan needs a kitchenPlanContract',
    });
  }

  // Criteria may point at an anchored dimension; a pointer at a dimension the
  // item does not anchor is a typo that would silently score nothing.
  if (q.grader.type === 'llm-judge' && q.grader.rubric) {
    const anchored = new Set((q.anchors ?? []).map((a) => a.dimension.trim().toLowerCase()));
    for (const [index, criterion] of q.grader.rubric.entries()) {
      const dimension = (criterion as { dimension?: string }).dimension;
      if (dimension && !anchored.has(dimension.trim().toLowerCase())) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['grader', 'rubric', index, 'dimension'],
          message: `criterion names dimension "${dimension}", which has no anchor set`,
        });
      }
    }
  }
});

export const questionFileSchema = z.array(questionSchema).min(1);

export const modelEntrySchema = z.object({
  id: z.string().regex(/^[\w.-]+\/[\w.:-]+$/, 'expected an OpenRouter slug like "anthropic/claude-fable-5"'),
  displayName: z.string().min(1),
  provider: z.string().min(1),
  family: z.string().optional(),
  releaseDate: z.string().optional(),
  active: z.boolean(),
});

export const modelsFileSchema = z.array(modelEntrySchema).min(1);
