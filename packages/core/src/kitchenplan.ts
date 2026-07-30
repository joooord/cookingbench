/**
 * M1.2 — the KitchenPlan validator.
 *
 * A recipe is a dependency graph. Ingredients with quantities are leaves,
 * operations are internal nodes that consume sub-results and emit new ones, and
 * the root is the dish at service. Written that way, a whole class of judgements
 * that currently need a judge's opinion becomes arithmetic: whether every
 * declared ingredient is used, whether anything is consumed before it exists,
 * whether the graph has a cycle, whether two oven steps collide in a kitchen
 * with one oven, whether the sequence actually reaches the stated service time,
 * whether a component sits past its holding limit, whether the safety
 * checkpoints are reached, and whether the numbers survive scaling.
 *
 * Three rules shape every line below; all three come from M1.2 and each of them
 * is a way of getting the measurement wrong if ignored.
 *
 * 1. **Multiple valid plans.** Nothing here compares a plan against a reference
 *    path. Two cooks may par-boil or not, roast or braise, work in either order;
 *    the validator only ever reports a plan inconsistent with itself or with
 *    limits the *item* stated. "A validator must never reject a viable approach
 *    merely because it differs from one reference path."
 *
 * 2. **Three layers, reported separately.** `format` is whether the object
 *    parses and satisfies the item's output contract. `structure` is whether the
 *    plan is consistent *with itself* — references resolve, the graph is
 *    acyclic, states follow, the plan does not break a limit it declared.
 *    `culinary` is whether the plan is correct *against the world as the item
 *    stated it* — the real kitchen, the real service time, the real safety
 *    thresholds. A model that cooks well and emits bad JSON fails `format`, and
 *    folding that into a culinary number measures the wrong thing. There is
 *    deliberately no combined score in this module; composition is M2.1's job.
 *
 * 3. **A plan may not supply its own constraint values.** Every limit a check
 *    is measured against comes from `VerifiedConstraints`, which only an item
 *    may build and whose provenance is restricted to `prompt` or `judge-pack`.
 *    Limits inside the plan are *claims*: useful, checked for self-consistency,
 *    never used as the yardstick. A candidate that declares a second oven, a
 *    six-hour holding limit or a 52 °C chicken threshold changes nothing about
 *    what it is measured against.
 *
 * Fail closed throughout. A check with no verified limit to test against
 * reports `indeterminate`, never `pass`; "we could not tell" and "it was fine"
 * are different answers and only one of them is honest.
 */
import type {
  KitchenPlan,
  KitchenPlanContract,
  PlanIngredient,
  PlanOperation,
} from './types.js';
import { kitchenPlanSchema } from './schema.js';
import { convert, normalizeUnit } from './graders/units.js';
import { z } from 'zod';

/**
 * Semantics version of this validator. Items pin it in
 * `kitchenPlanContract.validatorVersion`; a pin from a different major refuses
 * rather than validating an item under rules it was not authored against.
 */
export const PLAN_VALIDATOR_VERSION = 'kitchenplan-1.0.0';

export class KitchenPlanValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KitchenPlanValidationError';
  }
}

/* -------------------------------------------------------------------------- */
/* findings vocabulary                                                        */
/* -------------------------------------------------------------------------- */

export const PLAN_LAYERS = ['format', 'structure', 'culinary'] as const;
export type PlanLayer = (typeof PLAN_LAYERS)[number];

export const PLAN_CHECKS = [
  /* format */
  'parse',
  'output-contract',
  /* structure — the plan against itself */
  'reference-integrity',
  'ingredient-consumption',
  'output-consumption',
  'acyclicity',
  'ordering-feasibility',
  'state-transition',
  'self-declared-limit',
  'constraint-provenance',
  /* culinary — the plan against the stated world */
  'equipment-contention',
  'cook-contention',
  'critical-path',
  'holding-limit',
  'safety-checkpoint',
  'trajectory-invariant',
  'service-state',
  'scaling',
] as const;
export type PlanCheck = (typeof PLAN_CHECKS)[number];

export const CHECK_LAYER: Readonly<Record<PlanCheck, PlanLayer>> = Object.freeze({
  parse: 'format',
  'output-contract': 'format',
  'reference-integrity': 'structure',
  'ingredient-consumption': 'structure',
  'output-consumption': 'structure',
  acyclicity: 'structure',
  'ordering-feasibility': 'structure',
  'state-transition': 'structure',
  'self-declared-limit': 'structure',
  'constraint-provenance': 'structure',
  'equipment-contention': 'culinary',
  'cook-contention': 'culinary',
  'critical-path': 'culinary',
  'holding-limit': 'culinary',
  'safety-checkpoint': 'culinary',
  'trajectory-invariant': 'culinary',
  'service-state': 'culinary',
  // Scaling is culinary rather than structural: the scaled plan is structurally
  // fine — its arithmetic is wrong, and wrong quantities are bad cooking.
  scaling: 'culinary',
});

/**
 * `warning` exists because several genuine culinary judgements look like faults
 * to arithmetic. A schedule that only collides when every step runs to the slow
 * end of its declared range, or a scaled plan that lengthens a braise, may be
 * perfectly competent. Calling those violations would reject viable approaches,
 * which M1.2 forbids; dropping them would hide real risk from the judge. They
 * are surfaced and they do not fail the plan.
 */
export type PlanSeverity = 'violation' | 'warning';

export interface PlanFinding {
  check: PlanCheck;
  layer: PlanLayer;
  severity: PlanSeverity;
  /** Stable machine code, for fixtures that must assert *why* a plan failed. */
  code: string;
  message: string;
  /** Ids the finding is about: operations, ingredients, equipment, components. */
  subjects: string[];
}

export type PlanCheckOutcome =
  | 'pass'
  | 'violation'
  | 'warning'
  /** Ran, could not decide, and refuses to guess. Never counts as a pass. */
  | 'indeterminate'
  /** Nothing to check: the plan makes no claim and the item states no limit. */
  | 'not-applicable';

export interface PlanCheckReport {
  check: PlanCheck;
  layer: PlanLayer;
  outcome: PlanCheckOutcome;
  /** Required on `indeterminate` — an undecided check with no reason is noise. */
  reason?: string;
  findings: PlanFinding[];
}

export interface PlanLayerReport {
  layer: PlanLayer;
  /**
   * `pass` only when every applicable check in the layer passed. An
   * `indeterminate` check yields `unvalidatable`, which is deliberately not
   * `fail`: the plan may be perfect and the item may simply not have stated the
   * limit. Scoring the two the same would punish candidates for item gaps.
   */
  verdict: 'pass' | 'fail' | 'unvalidatable';
  violations: number;
  warnings: number;
  indeterminate: number;
  checks: PlanCheckReport[];
}

export interface PlanValidation {
  validatorVersion: string;
  format: PlanLayerReport;
  structure: PlanLayerReport;
  culinary: PlanLayerReport;
  /** Every finding, in check order. The layer reports hold the same objects. */
  findings: PlanFinding[];
  /**
   * There is no aggregate score here on purpose. M1.2 requires structural
   * consistency and culinary correctness to be reported separately, and a
   * single number is exactly how that separation gets quietly undone.
   */
}

/* -------------------------------------------------------------------------- */
/* the verified constraint pack — the only admissible source of limits         */
/* -------------------------------------------------------------------------- */

/**
 * How the item names a component it cares about without knowing the candidate's
 * ids. The candidate chooses `id`s and `name`s freely — demanding a fixed
 * vocabulary would reject valid plans on naming grounds — so the item supplies
 * aliases and matching is token-based (see `nameMatchesAny`).
 */
export const componentMatcherSchema = z.object({
  role: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
});
export type ComponentMatcher = z.infer<typeof componentMatcherSchema>;

export const verifiedEquipmentSchema = z.object({
  id: z.string().min(1),
  aliases: z.array(z.string().min(1)).optional(),
  /** How many the stated kitchen has. Zero means "explicitly absent". */
  countAvailable: z.number().int().min(0),
  availableFromMinute: z.number().finite().min(0).optional(),
  availableUntilMinute: z.number().finite().min(0).optional(),
});
export type VerifiedEquipment = z.infer<typeof verifiedEquipmentSchema>;

export const verifiedHoldingLimitSchema = z.object({
  component: componentMatcherSchema,
  maxHoldMinutes: z.number().finite().min(0),
  condition: z.string().min(1).optional(),
});

export const verifiedSafetyCheckpointSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  component: componentMatcherSchema.optional(),
  comparator: z.enum(['at-least', 'at-most', 'between']),
  value: z.number().finite(),
  upper: z.number().finite().optional(),
  /** Any unit `graders/units` can normalise: "C", "°F", "minutes". */
  unit: z.string().min(1),
});
export type VerifiedSafetyCheckpoint = z.infer<typeof verifiedSafetyCheckpointSchema>;

export const verifiedTrajectoryInvariantSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  /**
   * The machine-checkable part, when the item has one. Without it the invariant
   * is prose for a judge and this validator says so rather than pretending.
   */
  dangerBand: z
    .object({
      minCelsius: z.number().finite(),
      maxCelsius: z.number().finite(),
      maxCumulativeMinutes: z.number().finite().min(0),
    })
    .optional(),
});

export const verifiedServiceComponentSchema = componentMatcherSchema.extend({
  state: z.string().min(1).optional(),
  minTemperatureCelsius: z.number().finite().optional(),
});

/**
 * Limits the validator is allowed to measure against.
 *
 * `source` is restricted to the two provenances M1.2 permits. There is no
 * `candidate-assumption` member and adding one would defeat the entire module:
 * the plan's own `planLimitSourceSchema` has that value precisely so a plan can
 * confess an assumption, and a confessed assumption is still not evidence.
 */
export const verifiedConstraintsSchema = z.object({
  source: z.enum(['prompt', 'judge-pack']),
  equipment: z.array(verifiedEquipmentSchema).optional(),
  /** Pairs of hands. Absent means the item stated none; see cook-contention. */
  cooks: z.number().int().min(1).optional(),
  serviceAtMinute: z.number().finite().min(0).optional(),
  /** Absent means zero: an item wanting a window must state one. */
  serviceToleranceMinutes: z.number().finite().min(0).optional(),
  ambientTemperatureCelsius: z.number().finite().optional(),
  holdingLimits: z.array(verifiedHoldingLimitSchema).optional(),
  safetyCheckpoints: z.array(verifiedSafetyCheckpointSchema).optional(),
  trajectoryInvariants: z.array(verifiedTrajectoryInvariantSchema).optional(),
  serviceComponents: z.array(verifiedServiceComponentSchema).optional(),
});
export type VerifiedConstraints = z.infer<typeof verifiedConstraintsSchema>;

/**
 * Parse an item-supplied constraint pack. Use this rather than a cast: the
 * `source` enum is the firewall, and a cast walks straight through it.
 */
export function readVerifiedConstraints(raw: unknown): VerifiedConstraints {
  const parsed = verifiedConstraintsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new KitchenPlanValidationError(
      `verified constraints are not usable: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* format layer — parsing and the output contract                              */
/* -------------------------------------------------------------------------- */

export type PlanParseResult =
  | { ok: true; plan: KitchenPlan; findings: PlanFinding[] }
  | { ok: false; plan: null; findings: PlanFinding[] };

/**
 * Read a candidate's plan.
 *
 * Accepts an already-parsed object (the runner may have decoded YAML, which
 * core has no dependency for) or a JSON string, optionally wrapped in prose and
 * a fenced code block, because that is what models actually return.
 *
 * Everything this function reports lands in the `format` layer and nowhere
 * else. A model that cannot emit the object has not cooked badly; it has failed
 * an output contract, and the two are tracked apart.
 */
export function readKitchenPlan(raw: unknown): PlanParseResult {
  let candidate: unknown = raw;

  if (typeof raw === 'string') {
    const decoded = decodeJsonish(raw);
    if (decoded === undefined) {
      return {
        ok: false,
        plan: null,
        findings: [
          finding('parse', 'violation', 'unparseable', 'the response contains no parseable JSON object', []),
        ],
      };
    }
    candidate = decoded;
  }

  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return {
      ok: false,
      plan: null,
      findings: [
        finding('parse', 'violation', 'not-an-object', 'a KitchenPlan must be a JSON object', []),
      ],
    };
  }

  const parsed = kitchenPlanSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      plan: null,
      findings: parsed.error.issues.map((issue) =>
        finding(
          'parse',
          'violation',
          'schema',
          `${issue.path.join('.') || '(root)'}: ${issue.message}`,
          issue.path.length > 0 ? [issue.path.join('.')] : [],
        ),
      ),
    };
  }

  return { ok: true, plan: parsed.data, findings: [] };
}

/**
 * Pull a JSON object out of a model response.
 *
 * Order matters: a bare parse first (the well-behaved case), then a fenced
 * block, then the widest brace span. The brace span is last because it is the
 * guess, and a response containing prose braces should not beat a proper fence.
 */
function decodeJsonish(text: string): unknown {
  const attempt = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };

  const direct = attempt(text.trim());
  if (direct !== undefined) return direct;

  const fenced = /```(?:json|yaml|yml)?\s*\n([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    const inner = attempt(fenced[1].trim());
    if (inner !== undefined) return inner;
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) {
    const span = attempt(text.slice(first, last + 1));
    if (span !== undefined) return span;
  }
  return undefined;
}

/** The M1.2 object names an item may demand in `requiredObjects`. */
export const PLAN_OBJECTS = [
  'title',
  'servings',
  'locale',
  'serviceAtMinute',
  'ingredients',
  'equipment',
  'operations',
  'dependencies',
  'branches',
  'stateTransitions',
  'safetyCheckpoints',
  'trajectoryInvariants',
  'observations',
  'holdingLimits',
  'serviceState',
  'assumptions',
] as const;
export type PlanObject = (typeof PLAN_OBJECTS)[number];

/**
 * Major-version compatibility. A newer minor may validate an item pinned to an
 * older one — the rules only grew — but an older validator must not pretend to
 * enforce semantics it does not have, and a major bump means the semantics
 * changed under the item's feet.
 */
export function isValidatorVersionCompatible(pin: string, current = PLAN_VALIDATOR_VERSION): boolean {
  const parse = (v: string) => /^kitchenplan-(\d+)\.(\d+)\.(\d+)$/.exec(v);
  const a = parse(pin);
  const b = parse(current);
  if (!a || !b) return false;
  if (a[1] !== b[1]) return false;
  const older = Number(a[2]) < Number(b[2]) || (a[2] === b[2] && Number(a[3]) <= Number(b[3]));
  return older;
}

function checkOutputContract(plan: KitchenPlan, contract: KitchenPlanContract | undefined): PlanCheckReport {
  if (!contract) {
    return report('output-contract', 'not-applicable', [], 'the item declares no KitchenPlan contract');
  }
  if (!isValidatorVersionCompatible(contract.validatorVersion)) {
    // An item bug, not a candidate one — so it throws rather than scoring the
    // candidate down for the author's pin. `bench validate` is where this dies.
    throw new KitchenPlanValidationError(
      `item pins validator ${contract.validatorVersion}, which is not compatible with ${PLAN_VALIDATOR_VERSION}`,
    );
  }

  const findings: PlanFinding[] = [];
  for (const name of contract.requiredObjects) {
    if (!(PLAN_OBJECTS as readonly string[]).includes(name)) {
      throw new KitchenPlanValidationError(
        `item requires unknown KitchenPlan object "${name}" — the validator cannot check it`,
      );
    }
    const value = (plan as Record<string, unknown>)[name];
    const missing = value === undefined || (Array.isArray(value) && value.length === 0);
    if (missing) {
      findings.push(
        finding('output-contract', 'violation', 'required-object-missing', `the item requires "${name}" and the plan omits it`, [name]),
      );
    }
  }
  return report('output-contract', findings.length > 0 ? 'violation' : 'pass', findings);
}

/* -------------------------------------------------------------------------- */
/* the graph                                                                   */
/* -------------------------------------------------------------------------- */

export interface PlanGraphNode {
  id: string;
  kind: 'ingredient' | 'output';
  name: string;
  /** Declared state at creation: an ingredient's starting state or an output's. */
  state: string;
  /** Operation that produced it; absent for ingredients. */
  producer?: string;
}

export interface PlanEdge {
  from: string;
  to: string;
  /** `produces` is implied by inputs/outputs; the rest are declared. */
  kind: 'produces' | 'finish-to-start' | 'start-to-start' | 'finish-to-finish';
  lagMinutes: number;
}

export interface PlanGraph {
  nodes: Map<string, PlanGraphNode>;
  operations: Map<string, PlanOperation>;
  ingredients: Map<string, PlanIngredient>;
  consumersOf: Map<string, string[]>;
  edges: PlanEdge[];
  /** Topological operation order, or null when the strict edges cycle. */
  order: string[] | null;
  /** The offending operation ids, in cycle order, when `order` is null. */
  cycle: string[] | null;
  /** Ids declared more than once, across ingredients and operation outputs. */
  duplicateIds: string[];
  /** Operation inputs naming nothing that exists. */
  unresolvedInputs: { operation: string; input: string }[];
}

/**
 * Build the dependency graph.
 *
 * Only `produces` and `finish-to-start` edges take part in cycle detection.
 * A pair of mutual `start-to-start` edges says "start these together", which is
 * a legitimate instruction, and reporting it as a cycle would reject a viable
 * plan. Genuinely unsatisfiable timing is caught by the scheduler instead,
 * where it belongs.
 */
export function buildPlanGraph(plan: KitchenPlan): PlanGraph {
  const nodes = new Map<string, PlanGraphNode>();
  const duplicateIds: string[] = [];

  const declare = (node: PlanGraphNode) => {
    if (nodes.has(node.id)) {
      if (!duplicateIds.includes(node.id)) duplicateIds.push(node.id);
      return;
    }
    nodes.set(node.id, node);
  };

  const ingredients = new Map<string, PlanIngredient>();
  for (const ing of plan.ingredients) {
    if (ingredients.has(ing.id) && !duplicateIds.includes(ing.id)) duplicateIds.push(ing.id);
    ingredients.set(ing.id, ing);
    declare({ id: ing.id, kind: 'ingredient', name: ing.name, state: ing.startingState });
  }

  const operations = new Map<string, PlanOperation>();
  for (const op of plan.operations) {
    if (operations.has(op.id) && !duplicateIds.includes(op.id)) duplicateIds.push(op.id);
    operations.set(op.id, op);
    for (const out of op.outputs) {
      declare({ id: out.id, kind: 'output', name: out.name, state: out.state, producer: op.id });
    }
  }

  const consumersOf = new Map<string, string[]>();
  const edges: PlanEdge[] = [];
  const unresolvedInputs: { operation: string; input: string }[] = [];

  for (const op of plan.operations) {
    for (const input of op.inputs) {
      const node = nodes.get(input);
      if (!node) {
        unresolvedInputs.push({ operation: op.id, input });
        continue;
      }
      consumersOf.set(input, [...(consumersOf.get(input) ?? []), op.id]);
      if (node.producer && node.producer !== op.id) {
        edges.push({ from: node.producer, to: op.id, kind: 'produces', lagMinutes: 0 });
      }
    }
  }

  for (const dep of plan.dependencies) {
    edges.push({ from: dep.from, to: dep.to, kind: dep.kind, lagMinutes: dep.lagMinutes ?? 0 });
  }

  const strict = edges.filter((e) => e.kind === 'produces' || e.kind === 'finish-to-start');
  const { order, cycle } = topologicalOrder(
    plan.operations.map((o) => o.id),
    strict.filter((e) => operations.has(e.from) && operations.has(e.to)),
  );

  return { nodes, operations, ingredients, consumersOf, edges, order, cycle, duplicateIds, unresolvedInputs };
}

/**
 * Kahn's algorithm, with the survivors walked to name an actual cycle. A
 * validator that says "there is a cycle" without saying where is useless to the
 * author it exists to help.
 */
function topologicalOrder(
  ids: string[],
  edges: { from: string; to: string }[],
): { order: string[] | null; cycle: string[] | null } {
  const indegree = new Map<string, number>(ids.map((id) => [id, 0]));
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const e of edges) {
    if (!indegree.has(e.from) || !indegree.has(e.to)) continue;
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    out.get(e.from)!.push(e.to);
  }

  // Declared order as the tie-break, so the result is reproducible.
  const queue = ids.filter((id) => indegree.get(id) === 0);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  if (order.length === ids.length) return { order, cycle: null };

  const remaining = new Set(ids.filter((id) => !order.includes(id)));
  const path: string[] = [];
  const seen = new Set<string>();
  let node = [...remaining][0];
  while (node !== undefined && !seen.has(node)) {
    seen.add(node);
    path.push(node);
    node = (out.get(node) ?? []).find((n) => remaining.has(n));
  }
  if (node !== undefined) {
    const start = path.indexOf(node);
    return { order: null, cycle: [...path.slice(start), node] };
  }
  return { order: null, cycle: path };
}

/* -------------------------------------------------------------------------- */
/* scheduling                                                                  */
/* -------------------------------------------------------------------------- */

export interface ScheduledOperation {
  id: string;
  start: number;
  finish: number;
  /** The operation declared no duration; it was scheduled as instantaneous. */
  durationAssumedZero: boolean;
  /** The plan declared this start; otherwise it is the earliest feasible one. */
  declaredStart: boolean;
}

export interface PlanSchedule {
  basis: 'min' | 'max';
  byOperation: Map<string, ScheduledOperation>;
  makespan: number;
  /** True when every operation declared a duration. Soundness depends on it. */
  durationsComplete: boolean;
  /** The timing constraints could not be satisfied simultaneously. */
  unsatisfiable: boolean;
}

/**
 * Earliest-start schedule over the dependency constraints.
 *
 * A declared `startAtMinute` is used as-is, even when it is earlier than
 * feasible: the plan is asserting that time, and overwriting it with the
 * feasible one would erase the very claim `ordering-feasibility` exists to
 * check. Operations with no declared duration are scheduled as instantaneous
 * and flagged, because assuming any other number would be inventing one.
 */
export function scheduleOperations(plan: KitchenPlan, graph: PlanGraph, basis: 'min' | 'max'): PlanSchedule {
  const ids = plan.operations.map((o) => o.id);
  const durationOf = (op: PlanOperation): number => {
    if (!op.duration) return 0;
    return basis === 'min' ? op.duration.minMinutes : op.duration.maxMinutes;
  };
  const durationsComplete = plan.operations.every((op) => op.duration !== undefined);

  const start = new Map<string, number>();
  for (const op of plan.operations) start.set(op.id, op.startAtMinute ?? 0);

  const relevant = graph.edges.filter((e) => graph.operations.has(e.from) && graph.operations.has(e.to));

  // Relaxation rather than a single topological pass: start-to-start and
  // finish-to-finish edges are not restricted to the acyclic subgraph, so one
  // pass in topological order is not guaranteed to reach the fixed point.
  let changed = true;
  let passes = 0;
  const limit = ids.length * 2 + 2;
  while (changed && passes < limit) {
    changed = false;
    passes += 1;
    for (const edge of relevant) {
      const from = graph.operations.get(edge.from)!;
      const to = graph.operations.get(edge.to)!;
      const fromStart = start.get(from.id)!;
      const fromFinish = fromStart + durationOf(from);
      let earliest: number;
      switch (edge.kind) {
        case 'produces':
        case 'finish-to-start':
          earliest = fromFinish + edge.lagMinutes;
          break;
        case 'start-to-start':
          earliest = fromStart + edge.lagMinutes;
          break;
        case 'finish-to-finish':
          earliest = fromFinish + edge.lagMinutes - durationOf(to);
          break;
      }
      // A declared start is never pushed later: the plan's own claim stands and
      // is judged, not silently repaired.
      if (to.startAtMinute !== undefined) continue;
      if (earliest > (start.get(to.id) ?? 0) + 1e-9) {
        start.set(to.id, earliest);
        changed = true;
      }
    }
  }

  const byOperation = new Map<string, ScheduledOperation>();
  let makespan = 0;
  for (const op of plan.operations) {
    const s = start.get(op.id)!;
    const f = s + durationOf(op);
    byOperation.set(op.id, {
      id: op.id,
      start: s,
      finish: f,
      durationAssumedZero: op.duration === undefined,
      declaredStart: op.startAtMinute !== undefined,
    });
    makespan = Math.max(makespan, f);
  }

  return { basis, byOperation, makespan, durationsComplete, unsatisfiable: changed && passes >= limit };
}

/* -------------------------------------------------------------------------- */
/* the validator                                                               */
/* -------------------------------------------------------------------------- */

export interface ValidateOptions {
  contract?: KitchenPlanContract;
}

/**
 * Validate a parsed plan against limits the *item* verified.
 *
 * `constraints` is required and has no default. An optional constraint pack
 * would mean a caller could validate a plan against nothing at all and read the
 * resulting clean sheet as competence, which is the exact failure M1.2 warns
 * about from the other direction.
 */
export function validateKitchenPlan(
  plan: KitchenPlan,
  constraints: VerifiedConstraints,
  options: ValidateOptions = {},
): PlanValidation {
  if (!constraints || typeof constraints !== 'object') {
    throw new KitchenPlanValidationError('a verified constraint pack is required; a plan cannot validate itself');
  }
  if (constraints.source !== 'prompt' && constraints.source !== 'judge-pack') {
    throw new KitchenPlanValidationError(
      `constraint pack provenance "${String((constraints as { source?: unknown }).source)}" is not verified evidence`,
    );
  }

  const graph = buildPlanGraph(plan);
  const optimistic = scheduleOperations(plan, graph, 'min');
  const pessimistic = scheduleOperations(plan, graph, 'max');

  const checks: PlanCheckReport[] = [
    checkOutputContract(plan, options.contract),
    checkReferenceIntegrity(plan, graph),
    checkIngredientConsumption(plan, graph),
    checkOutputConsumption(plan, graph),
    checkAcyclicity(graph),
    checkOrderingFeasibility(plan, graph, optimistic),
    checkStateTransitions(plan, graph),
    checkSelfDeclaredLimits(plan, graph, optimistic),
    checkConstraintProvenance(plan, constraints),
    checkEquipmentContention(plan, graph, constraints, optimistic, pessimistic),
    checkCookContention(plan, constraints, optimistic, pessimistic),
    checkCriticalPath(plan, constraints, optimistic, pessimistic),
    checkHoldingLimits(plan, graph, constraints, optimistic),
    checkSafetyCheckpoints(plan, graph, constraints, optimistic),
    checkTrajectoryInvariants(plan, graph, constraints, optimistic),
    checkServiceState(plan, graph, constraints),
  ];

  return assemble(checks);
}

/** Format-layer-only result for a response whose plan never parsed. */
export function formatFailure(findings: PlanFinding[]): PlanValidation {
  return assemble([report('parse', 'violation', findings)]);
}

function assemble(checks: PlanCheckReport[]): PlanValidation {
  const byLayer = (layer: PlanLayer): PlanLayerReport => {
    const own = checks.filter((c) => c.layer === layer);
    const violations = own.reduce((n, c) => n + c.findings.filter((f) => f.severity === 'violation').length, 0);
    const warnings = own.reduce((n, c) => n + c.findings.filter((f) => f.severity === 'warning').length, 0);
    const indeterminate = own.filter((c) => c.outcome === 'indeterminate').length;
    // A layer with no checks at all is `unvalidatable`, never `pass`. The case
    // that matters is a response whose plan never parsed: nothing culinary ran,
    // and a clean culinary sheet there would read as "cooks fine" on the
    // strength of having produced no plan.
    const verdict =
      violations > 0 ? 'fail' : indeterminate > 0 || own.length === 0 ? 'unvalidatable' : 'pass';
    return { layer, verdict, violations, warnings, indeterminate, checks: own };
  };

  return {
    validatorVersion: PLAN_VALIDATOR_VERSION,
    format: byLayer('format'),
    structure: byLayer('structure'),
    culinary: byLayer('culinary'),
    findings: checks.flatMap((c) => c.findings),
  };
}

/* -------------------------------------------------------------------------- */
/* structure checks                                                            */
/* -------------------------------------------------------------------------- */

function checkReferenceIntegrity(plan: KitchenPlan, graph: PlanGraph): PlanCheckReport {
  const findings: PlanFinding[] = [];
  const equipmentIds = new Set(plan.equipment.map((e) => e.id));

  for (const id of graph.duplicateIds) {
    findings.push(
      finding('reference-integrity', 'violation', 'duplicate-id', `id "${id}" names more than one thing`, [id]),
    );
  }
  for (const { operation, input } of graph.unresolvedInputs) {
    findings.push(
      finding('reference-integrity', 'violation', 'unknown-input', `operation "${operation}" consumes unknown "${input}"`, [operation, input]),
    );
  }
  for (const op of plan.operations) {
    for (const eq of op.equipment) {
      if (!equipmentIds.has(eq)) {
        findings.push(
          finding('reference-integrity', 'violation', 'unknown-equipment', `operation "${op.id}" uses undeclared equipment "${eq}"`, [op.id, eq]),
        );
      }
    }
  }
  for (const dep of plan.dependencies) {
    for (const end of [dep.from, dep.to]) {
      if (!graph.operations.has(end)) {
        findings.push(
          finding('reference-integrity', 'violation', 'unknown-dependency-end', `dependency names unknown operation "${end}"`, [end]),
        );
      }
    }
  }
  for (const branch of plan.branches ?? []) {
    for (const op of branch.operations) {
      if (!graph.operations.has(op)) {
        findings.push(
          finding('reference-integrity', 'violation', 'unknown-branch-operation', `branch "${branch.id}" names unknown operation "${op}"`, [branch.id, op]),
        );
      }
    }
  }
  for (const t of plan.stateTransitions) {
    if (!graph.nodes.has(t.subjectId)) {
      findings.push(
        finding('reference-integrity', 'violation', 'unknown-transition-subject', `state transition names unknown subject "${t.subjectId}"`, [t.subjectId]),
      );
    }
    if (!graph.operations.has(t.byOperation)) {
      findings.push(
        finding('reference-integrity', 'violation', 'unknown-transition-operation', `state transition names unknown operation "${t.byOperation}"`, [t.byOperation]),
      );
    }
  }
  for (const cp of plan.safetyCheckpoints) {
    if (!graph.operations.has(cp.afterOperation)) {
      findings.push(
        finding('reference-integrity', 'violation', 'unknown-checkpoint-operation', `safety checkpoint "${cp.id}" names unknown operation "${cp.afterOperation}"`, [cp.id, cp.afterOperation]),
      );
    }
  }
  for (const h of plan.holdingLimits) {
    if (!graph.nodes.has(h.componentId)) {
      findings.push(
        finding('reference-integrity', 'violation', 'unknown-holding-component', `holding limit names unknown component "${h.componentId}"`, [h.componentId]),
      );
    }
  }
  for (const c of plan.serviceState.components) {
    if (!graph.nodes.has(c.componentId)) {
      findings.push(
        finding('reference-integrity', 'violation', 'unknown-service-component', `service state names unknown component "${c.componentId}"`, [c.componentId]),
      );
    }
  }

  return report('reference-integrity', findings.length > 0 ? 'violation' : 'pass', findings);
}

function checkIngredientConsumption(plan: KitchenPlan, graph: PlanGraph): PlanCheckReport {
  const servedDirectly = new Set(plan.serviceState.components.map((c) => c.componentId));
  const findings: PlanFinding[] = [];
  for (const ing of plan.ingredients) {
    const consumed = (graph.consumersOf.get(ing.id) ?? []).length > 0;
    // An ingredient plated untouched — a raw garnish, bread on the side — is
    // consumed by the dish even though no operation touches it. Calling that an
    // orphan would reject a viable plan.
    if (!consumed && !servedDirectly.has(ing.id)) {
      findings.push(
        finding('ingredient-consumption', 'violation', 'orphan-ingredient', `ingredient "${ing.id}" (${ing.name}) is declared and never used`, [ing.id]),
      );
    }
  }
  return report('ingredient-consumption', findings.length > 0 ? 'violation' : 'pass', findings);
}

function checkOutputConsumption(plan: KitchenPlan, graph: PlanGraph): PlanCheckReport {
  const served = new Set(plan.serviceState.components.map((c) => c.componentId));
  const findings: PlanFinding[] = [];
  for (const op of plan.operations) {
    for (const out of op.outputs) {
      const consumed = (graph.consumersOf.get(out.id) ?? []).length > 0;
      if (!consumed && !served.has(out.id)) {
        findings.push(
          finding('output-consumption', 'violation', 'dangling-output', `"${out.id}" is produced by "${op.id}", never used and never served`, [op.id, out.id]),
        );
      }
      if (consumed && served.has(out.id)) {
        // Both eaten and cooked with: the graph puts one component in two
        // places at once. Almost always a missing split operation.
        findings.push(
          finding('output-consumption', 'violation', 'served-and-consumed', `"${out.id}" is served and also used by a later operation`, [out.id]),
        );
      }
    }
  }
  return report('output-consumption', findings.length > 0 ? 'violation' : 'pass', findings);
}

function checkAcyclicity(graph: PlanGraph): PlanCheckReport {
  if (graph.cycle) {
    return report('acyclicity', 'violation', [
      finding('acyclicity', 'violation', 'cycle', `operations form a cycle: ${graph.cycle.join(' → ')}`, graph.cycle),
    ]);
  }
  return report('acyclicity', 'pass', []);
}

function checkOrderingFeasibility(plan: KitchenPlan, graph: PlanGraph, optimistic: PlanSchedule): PlanCheckReport {
  const findings: PlanFinding[] = [];

  if (optimistic.unsatisfiable) {
    findings.push(
      finding('ordering-feasibility', 'violation', 'timing-unsatisfiable', 'the declared timing constraints have no simultaneous solution', []),
    );
  }

  // A declared start earlier than the earliest possible finish of something it
  // consumes is the plain "consumes what does not yet exist" fault, and it is
  // only visible once times are declared — without them the graph order already
  // guarantees feasibility.
  for (const op of plan.operations) {
    if (op.startAtMinute === undefined) continue;
    for (const input of op.inputs) {
      const node = graph.nodes.get(input);
      if (!node?.producer) continue;
      const producer = optimistic.byOperation.get(node.producer);
      if (!producer) continue;
      if (op.startAtMinute < producer.finish - 1e-9) {
        findings.push(
          finding(
            'ordering-feasibility',
            'violation',
            'consumes-before-produced',
            `operation "${op.id}" starts at ${op.startAtMinute} min and consumes "${input}", which cannot exist before ${round(producer.finish)} min`,
            [op.id, input, node.producer],
          ),
        );
      }
    }
    for (const dep of plan.dependencies) {
      if (dep.to !== op.id) continue;
      const from = optimistic.byOperation.get(dep.from);
      if (!from) continue;
      const lag = dep.lagMinutes ?? 0;
      const earliest =
        dep.kind === 'start-to-start' ? from.start + lag : dep.kind === 'finish-to-start' ? from.finish + lag : undefined;
      if (earliest !== undefined && op.startAtMinute < earliest - 1e-9) {
        findings.push(
          finding(
            'ordering-feasibility',
            'violation',
            'declared-start-breaks-dependency',
            `operation "${op.id}" starts at ${op.startAtMinute} min, before its ${dep.kind} dependency on "${dep.from}" allows (${round(earliest)} min)`,
            [op.id, dep.from],
          ),
        );
      }
    }
  }

  return report('ordering-feasibility', findings.length > 0 ? 'violation' : 'pass', findings);
}

function checkStateTransitions(plan: KitchenPlan, graph: PlanGraph): PlanCheckReport {
  if (plan.stateTransitions.length === 0) {
    return report('state-transition', 'not-applicable', [], 'the plan declares no state transitions');
  }
  if (!graph.order) {
    return report('state-transition', 'indeterminate', [], 'the graph is cyclic, so transitions have no order to follow');
  }

  const position = new Map(graph.order.map((id, i) => [id, i]));
  const findings: PlanFinding[] = [];
  const current = new Map<string, string>();
  for (const [id, node] of graph.nodes) current.set(id, node.state);

  const ordered = [...plan.stateTransitions].sort((a, b) => {
    const pa = position.get(a.byOperation) ?? Number.MAX_SAFE_INTEGER;
    const pb = position.get(b.byOperation) ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return (a.atMinute ?? 0) - (b.atMinute ?? 0);
  });

  for (const t of ordered) {
    const op = graph.operations.get(t.byOperation);
    const known = current.get(t.subjectId);
    if (known === undefined || !op) continue; // reference-integrity owns this
    if (!sameState(known, t.from)) {
      findings.push(
        finding(
          'state-transition',
          'violation',
          'invalid-transition',
          `"${t.subjectId}" is "${known}" when "${t.byOperation}" claims to take it from "${t.from}"`,
          [t.subjectId, t.byOperation],
        ),
      );
    }
    const handled = op.inputs.includes(t.subjectId) || op.outputs.some((o) => o.id === t.subjectId);
    if (!handled) {
      findings.push(
        finding(
          'state-transition',
          'violation',
          'transition-without-contact',
          `operation "${t.byOperation}" transforms "${t.subjectId}" without taking it as an input or producing it`,
          [t.byOperation, t.subjectId],
        ),
      );
    }
    current.set(t.subjectId, t.to);
  }

  return report('state-transition', findings.length > 0 ? 'violation' : 'pass', findings);
}

/**
 * The plan against its own declared limits.
 *
 * This needs no verified pack at all: a plan that declares a two-hour holding
 * limit and then holds for three is inconsistent whatever the prompt said, and
 * that is structural, not culinary. Keeping it separate is also what stops the
 * provenance firewall from swallowing real faults — a candidate cannot escape
 * its own arithmetic by sourcing its limits badly.
 */
function checkSelfDeclaredLimits(plan: KitchenPlan, graph: PlanGraph, schedule: PlanSchedule): PlanCheckReport {
  const findings: PlanFinding[] = [];

  for (const limit of plan.holdingLimits) {
    const node = graph.nodes.get(limit.componentId);
    if (!node?.producer) continue;
    const produced = schedule.byOperation.get(node.producer);
    if (!produced) continue;
    const usedAt = nextContactMinute(limit.componentId, graph, schedule) ?? plan.serviceState.atMinute;
    const held = usedAt - produced.finish;
    if (held > limit.maxHoldMinutes + 1e-9) {
      findings.push(
        finding(
          'self-declared-limit',
          // Instantaneous stand-ins make the finish time early and so the hold
          // long: an over-estimate. Over-estimated holds cannot prove a breach,
          // so they are reported as warnings rather than violations.
          schedule.durationsComplete ? 'violation' : 'warning',
          'holds-past-own-limit',
          `"${limit.componentId}" is held ${round(held)} min against the plan's own ${limit.maxHoldMinutes} min limit`,
          [limit.componentId],
        ),
      );
    }
  }

  for (const cp of plan.safetyCheckpoints) {
    if (!cp.threshold) continue;
    const op = graph.operations.get(cp.afterOperation);
    if (!op?.temperature) continue;
    const reached = temperatureIn(op.temperature.value, op.temperature.unit, cp.threshold.unit);
    if (reached === undefined) continue;
    if (!satisfiesThreshold(reached, cp.threshold)) {
      findings.push(
        finding(
          'self-declared-limit',
          'violation',
          'checkpoint-contradicts-operation',
          `checkpoint "${cp.id}" requires ${describeThreshold(cp.threshold)} but "${cp.afterOperation}" reaches only ${op.temperature.value}°${op.temperature.unit}`,
          [cp.id, cp.afterOperation],
        ),
      );
    }
  }

  return report('self-declared-limit', worstOutcome(findings), findings);
}

/**
 * The firewall check: what the plan claims about the world it is cooking in.
 *
 * Declaring more equipment than the stated kitchen has is a violation — it is
 * directly contradicted. Claiming `prompt` provenance for a limit the pack does
 * not carry is only a warning: an item author encodes the machine-checkable
 * limits, not every sentence of the brief, so an unverifiable claim is a flag
 * for review rather than proof of invention.
 */
function checkConstraintProvenance(plan: KitchenPlan, constraints: VerifiedConstraints): PlanCheckReport {
  const findings: PlanFinding[] = [];
  const verified = constraints.equipment ?? [];

  for (const declared of plan.equipment) {
    const match = matchEquipment(declared.id, declared.name, verified);
    if (!match) {
      if (verified.length > 0) {
        findings.push(
          finding(
            'constraint-provenance',
            'violation',
            'equipment-not-in-stated-kitchen',
            `the plan declares "${declared.name}" (${declared.id}), which the stated kitchen does not contain`,
            [declared.id],
          ),
        );
      }
      continue;
    }
    if (declared.countAvailable > match.countAvailable) {
      findings.push(
        finding(
          'constraint-provenance',
          'violation',
          'self-declared-capacity',
          `the plan claims ${declared.countAvailable}× "${declared.id}" where the stated kitchen has ${match.countAvailable}`,
          [declared.id],
        ),
      );
    }
    if (declared.capacitySource === 'candidate-assumption' && declared.capacity !== undefined) {
      findings.push(
        finding(
          'constraint-provenance',
          'warning',
          'assumed-capacity',
          `the capacity of "${declared.id}" is the plan's own assumption and is not used as a limit`,
          [declared.id],
        ),
      );
    }
  }

  const packHasHolding = (constraints.holdingLimits ?? []).length > 0;
  const packHasSafety = (constraints.safetyCheckpoints ?? []).length > 0;
  const packHasTrajectory = (constraints.trajectoryInvariants ?? []).length > 0;
  const claimed: [string, string, boolean][] = [
    ...plan.holdingLimits.map((h) => [h.source, `holding limit for "${h.componentId}"`, packHasHolding] as [string, string, boolean]),
    ...plan.safetyCheckpoints.map((c) => [c.source, `safety checkpoint "${c.id}"`, packHasSafety] as [string, string, boolean]),
    ...plan.trajectoryInvariants.map((t) => [t.source, `trajectory invariant "${t.id}"`, packHasTrajectory] as [string, string, boolean]),
    ...(plan.assumptions ?? []).map((a) => [a.source, `assumption "${a.statement}"`, false] as [string, string, boolean]),
  ];
  for (const [source, what, corroborated] of claimed) {
    if (source !== 'candidate-assumption' && !corroborated) {
      findings.push(
        finding(
          'constraint-provenance',
          'warning',
          'unverifiable-provenance',
          `${what} claims "${source}" provenance that the verified pack cannot corroborate`,
          [],
        ),
      );
    }
  }

  const worst = findings.some((f) => f.severity === 'violation')
    ? 'violation'
    : findings.length > 0
      ? 'warning'
      : 'pass';
  return report('constraint-provenance', worst, findings);
}

/* -------------------------------------------------------------------------- */
/* culinary checks                                                             */
/* -------------------------------------------------------------------------- */

interface Occupancy {
  operation: string;
  start: number;
  finish: number;
}

function checkEquipmentContention(
  plan: KitchenPlan,
  graph: PlanGraph,
  constraints: VerifiedConstraints,
  optimistic: PlanSchedule,
  pessimistic: PlanSchedule,
): PlanCheckReport {
  const usesEquipment = plan.operations.some((op) => op.equipment.length > 0);
  const verified = constraints.equipment ?? [];
  if (!usesEquipment && verified.length === 0) {
    return report('equipment-contention', 'not-applicable', [], 'no operation uses equipment and the item states no kitchen');
  }
  if (verified.length === 0) {
    return report('equipment-contention', 'indeterminate', [], 'the item states no kitchen, so contention cannot be verified');
  }
  const timedOps = plan.operations.filter((op) => op.equipment.length > 0);
  if (timedOps.some((op) => op.duration === undefined)) {
    return report(
      'equipment-contention',
      'indeterminate',
      [],
      'an equipment-using operation declares no duration, so occupancy is unknown',
    );
  }

  const findings: PlanFinding[] = [];

  for (const equipmentId of uniqueInOrder(timedOps.flatMap((op) => op.equipment))) {
    const declared = plan.equipment.find((e) => e.id === equipmentId);
    const match = declared ? matchEquipment(declared.id, declared.name, verified) : matchEquipment(equipmentId, equipmentId, verified);
    // Not in the stated kitchen means a count of zero, not an unknown: the
    // honest verdict on roasting in an oven you do not have is that you cannot.
    const available = match?.countAvailable ?? 0;
    const users = timedOps.filter((op) => op.equipment.includes(equipmentId));

    if (available === 0) {
      findings.push(
        finding(
          'equipment-contention',
          'violation',
          'equipment-unavailable',
          `${users.length} operation(s) use "${equipmentId}", which the stated kitchen does not provide`,
          [equipmentId, ...users.map((u) => u.id)],
        ),
      );
      continue;
    }

    const definite = overlapPeaks(users.map((op) => occupancy(op, optimistic)));
    const possible = overlapPeaks(users.map((op) => occupancy(op, pessimistic)));
    if (definite.peak > available) {
      findings.push(
        finding(
          'equipment-contention',
          'violation',
          'equipment-oversubscribed',
          `${definite.peak} simultaneous uses of "${equipmentId}" against ${available} available (${definite.who.join(', ')})`,
          [equipmentId, ...definite.who],
        ),
      );
    } else if (possible.peak > available) {
      // Only collides when every step runs long. Real risk, not proof.
      findings.push(
        finding(
          'equipment-contention',
          'warning',
          'equipment-tight',
          `"${equipmentId}" is oversubscribed only if operations run to their maximum durations (${possible.who.join(', ')})`,
          [equipmentId, ...possible.who],
        ),
      );
    }

    if (match) {
      for (const op of users) {
        const slot = occupancy(op, pessimistic);
        if (match.availableFromMinute !== undefined && slot.start < match.availableFromMinute - 1e-9) {
          findings.push(
            finding('equipment-contention', 'violation', 'equipment-before-window', `"${op.id}" uses "${equipmentId}" at ${round(slot.start)} min, before it is available (${match.availableFromMinute} min)`, [op.id, equipmentId]),
          );
        }
        if (match.availableUntilMinute !== undefined && slot.finish > match.availableUntilMinute + 1e-9) {
          findings.push(
            finding('equipment-contention', 'violation', 'equipment-after-window', `"${op.id}" holds "${equipmentId}" until ${round(slot.finish)} min, past its availability (${match.availableUntilMinute} min)`, [op.id, equipmentId]),
          );
        }
      }
    }
  }

  return report('equipment-contention', worstOutcome(findings), findings);
}

function checkCookContention(
  plan: KitchenPlan,
  constraints: VerifiedConstraints,
  optimistic: PlanSchedule,
  pessimistic: PlanSchedule,
): PlanCheckReport {
  if (constraints.cooks === undefined) {
    // No stated cook count is no claim at all. This is not "assume infinitely
    // many hands" — no verdict is issued.
    return report('cook-contention', 'not-applicable', [], 'the item states no cook count');
  }
  const active = plan.operations.filter((op) => op.attention === 'active');
  if (active.length === 0) {
    return report('cook-contention', 'indeterminate', [], 'no operation declares whether it occupies the cook');
  }
  if (active.some((op) => op.duration === undefined)) {
    return report('cook-contention', 'indeterminate', [], 'an active operation declares no duration');
  }

  const findings: PlanFinding[] = [];
  const definite = overlapPeaks(active.map((op) => occupancy(op, optimistic)));
  const possible = overlapPeaks(active.map((op) => occupancy(op, pessimistic)));
  if (definite.peak > constraints.cooks) {
    findings.push(
      finding('cook-contention', 'violation', 'cook-oversubscribed', `${definite.peak} hands-on operations overlap against ${constraints.cooks} cook(s) (${definite.who.join(', ')})`, definite.who),
    );
  } else if (possible.peak > constraints.cooks) {
    findings.push(
      finding('cook-contention', 'warning', 'cook-tight', `hands-on work overlaps only if operations run long (${possible.who.join(', ')})`, possible.who),
    );
  }
  return report('cook-contention', worstOutcome(findings), findings);
}

function checkCriticalPath(
  plan: KitchenPlan,
  constraints: VerifiedConstraints,
  optimistic: PlanSchedule,
  pessimistic: PlanSchedule,
): PlanCheckReport {
  if (constraints.serviceAtMinute === undefined) {
    return report('critical-path', 'indeterminate', [], 'the item states no service time');
  }
  const tolerance = constraints.serviceToleranceMinutes ?? 0;
  const deadline = constraints.serviceAtMinute + tolerance;
  const findings: PlanFinding[] = [];

  if (optimistic.makespan > deadline + 1e-9) {
    // A lower bound that already misses the deadline is proof, even with
    // durations missing — missing durations only make the bound smaller.
    findings.push(
      finding(
        'critical-path',
        'violation',
        'cannot-reach-service',
        `the fastest reading of the plan finishes at ${round(optimistic.makespan)} min, past the stated service at ${constraints.serviceAtMinute} min`,
        [],
      ),
    );
  } else if (!optimistic.durationsComplete) {
    // The reverse does not hold: a bound that fits proves nothing when steps
    // were scheduled as instantaneous.
    return report(
      'critical-path',
      'indeterminate',
      findings,
      'operations without declared durations were scheduled as instantaneous, so a fit cannot be confirmed',
    );
  } else if (pessimistic.makespan > deadline + 1e-9) {
    findings.push(
      finding(
        'critical-path',
        'warning',
        'service-at-risk',
        `the plan only reaches service on time if steps run to their minimum durations (slowest reading finishes at ${round(pessimistic.makespan)} min)`,
        [],
      ),
    );
  }

  if (plan.serviceState.atMinute > deadline + 1e-9) {
    findings.push(
      finding(
        'critical-path',
        'violation',
        'service-declared-late',
        `the plan serves at ${plan.serviceState.atMinute} min against a stated service time of ${constraints.serviceAtMinute} min`,
        [],
      ),
    );
  }

  return report('critical-path', worstOutcome(findings), findings);
}

function checkHoldingLimits(
  plan: KitchenPlan,
  graph: PlanGraph,
  constraints: VerifiedConstraints,
  schedule: PlanSchedule,
): PlanCheckReport {
  const limits = constraints.holdingLimits ?? [];
  if (limits.length === 0) {
    return report('holding-limit', 'not-applicable', [], 'the item states no holding limits');
  }
  const findings: PlanFinding[] = [];

  for (const limit of limits) {
    const nodes = [...graph.nodes.values()].filter((n) => nameMatchesAny(n.name, limit.component.aliases) || nameMatchesAny(n.id, limit.component.aliases));
    if (nodes.length === 0) {
      findings.push(
        finding(
          'holding-limit',
          'violation',
          'held-component-absent',
          `nothing in the plan corresponds to "${limit.component.role}", which the item holds to ${limit.maxHoldMinutes} min`,
          [],
        ),
      );
      continue;
    }
    for (const node of nodes) {
      if (!node.producer) continue;
      const produced = schedule.byOperation.get(node.producer);
      if (!produced) continue;
      const usedAt = nextContactMinute(node.id, graph, schedule) ?? plan.serviceState.atMinute;
      const held = usedAt - produced.finish;
      if (held > limit.maxHoldMinutes + 1e-9) {
        findings.push(
          finding(
            'holding-limit',
            schedule.durationsComplete ? 'violation' : 'warning',
            'held-too-long',
            `"${node.id}" waits ${round(held)} min against the stated ${limit.maxHoldMinutes} min limit for ${limit.component.role}`,
            [node.id],
          ),
        );
      }
    }
  }

  return report('holding-limit', worstOutcome(findings), findings);
}

function checkSafetyCheckpoints(
  plan: KitchenPlan,
  graph: PlanGraph,
  constraints: VerifiedConstraints,
  schedule: PlanSchedule,
): PlanCheckReport {
  const required = constraints.safetyCheckpoints ?? [];
  if (required.length === 0) {
    return report('safety-checkpoint', 'not-applicable', [], 'the item states no safety thresholds');
  }
  const findings: PlanFinding[] = [];

  for (const need of required) {
    const candidates = plan.safetyCheckpoints.filter((cp) => {
      // A candidate-assumed checkpoint may exist and may even be right; it
      // cannot discharge a verified requirement, or the plan would be
      // certifying its own safety.
      if (cp.source === 'candidate-assumption') return false;
      if (!need.component) return true;
      const op = graph.operations.get(cp.afterOperation);
      const names = [cp.check, ...(op ? [op.action, ...op.outputs.map((o) => o.name)] : [])];
      return names.some((n) => nameMatchesAny(n, need.component!.aliases));
    });

    if (candidates.length === 0) {
      findings.push(
        finding(
          'safety-checkpoint',
          'violation',
          'required-checkpoint-missing',
          `the plan declares no verified checkpoint for "${need.description}"`,
          [need.id],
        ),
      );
      continue;
    }

    const met = candidates.some((cp) => {
      if (!cp.threshold) return false;
      const value = convertMeasure(cp.threshold.value, cp.threshold.unit, need.unit);
      if (value === undefined) return false;
      return satisfiesRequirement(value, need);
    });
    if (!met) {
      const shown = candidates
        .map((cp) => (cp.threshold ? `${cp.threshold.value} ${cp.threshold.unit}` : 'no threshold'))
        .join(', ');
      findings.push(
        finding(
          'safety-checkpoint',
          'violation',
          'checkpoint-below-threshold',
          `"${need.description}" requires ${describeRequirement(need)}; the plan offers ${shown}`,
          [need.id, ...candidates.map((c) => c.id)],
        ),
      );
      continue;
    }

    // A checkpoint reached after the food is served is not a checkpoint.
    for (const cp of candidates) {
      const op = schedule.byOperation.get(cp.afterOperation);
      if (op && op.finish > plan.serviceState.atMinute + 1e-9) {
        findings.push(
          finding(
            'safety-checkpoint',
            'violation',
            'checkpoint-after-service',
            `checkpoint "${cp.id}" completes at ${round(op.finish)} min, after service at ${plan.serviceState.atMinute} min`,
            [cp.id],
          ),
        );
      }
    }
  }

  return report('safety-checkpoint', worstOutcome(findings), findings);
}

/**
 * Cumulative time in a stated danger band.
 *
 * The model is deliberately crude and its limits should be stated wherever a
 * result is shown: it counts *declared* minutes only — the duration of
 * operations whose declared temperature falls in the band, plus gaps during
 * which a component is not inside any operation, valued at the item's stated
 * ambient. It knows nothing about thermal mass, so a violation is strong
 * evidence and a pass is not a safety certificate. When the item states no
 * ambient and there are gaps to value, it refuses instead of assuming one.
 */
function checkTrajectoryInvariants(
  plan: KitchenPlan,
  graph: PlanGraph,
  constraints: VerifiedConstraints,
  schedule: PlanSchedule,
): PlanCheckReport {
  const invariants = (constraints.trajectoryInvariants ?? []).filter((i) => i.dangerBand);
  if ((constraints.trajectoryInvariants ?? []).length === 0) {
    return report('trajectory-invariant', 'not-applicable', [], 'the item states no trajectory invariants');
  }
  if (invariants.length === 0) {
    return report('trajectory-invariant', 'indeterminate', [], 'the stated invariants carry no machine-checkable band');
  }
  if (!schedule.durationsComplete) {
    return report('trajectory-invariant', 'indeterminate', [], 'operations without durations make exposure time unknowable');
  }

  const findings: PlanFinding[] = [];

  for (const invariant of invariants) {
    const band = invariant.dangerBand!;
    for (const node of graph.nodes.values()) {
      const contacts = contactIntervals(node.id, graph, schedule);
      if (contacts.length === 0) continue;

      let exposed = 0;
      let unknownGap = false;
      for (const contact of contacts) {
        const op = graph.operations.get(contact.operation)!;
        const celsius = op.temperature ? toCelsius(op.temperature.value, op.temperature.unit) : undefined;
        if (celsius === undefined) {
          // No declared temperature: value it at ambient, which must be stated.
          if (constraints.ambientTemperatureCelsius === undefined) {
            unknownGap = true;
            continue;
          }
          if (inBand(constraints.ambientTemperatureCelsius, band)) exposed += contact.finish - contact.start;
        } else if (inBand(celsius, band)) {
          exposed += contact.finish - contact.start;
        }
      }

      // A component absorbed by a later operation stops existing there; only
      // something still on the pass at service accrues time up to service.
      // Without this a raw ingredient would be charged for the whole cook.
      const extant = (graph.consumersOf.get(node.id) ?? []).length === 0;
      const gaps = gapIntervals(contacts, extant ? plan.serviceState.atMinute : undefined);
      const gapMinutes = gaps.reduce((n, g) => n + (g.finish - g.start), 0);
      if (gapMinutes > 1e-9) {
        if (constraints.ambientTemperatureCelsius === undefined) unknownGap = true;
        else if (inBand(constraints.ambientTemperatureCelsius, band)) exposed += gapMinutes;
      }

      if (exposed > band.maxCumulativeMinutes + 1e-9) {
        findings.push(
          finding(
            'trajectory-invariant',
            'violation',
            'danger-band-exceeded',
            `"${node.id}" spends ${round(exposed)} min between ${band.minCelsius}–${band.maxCelsius}°C against a stated maximum of ${band.maxCumulativeMinutes} min (${invariant.statement})`,
            [node.id, invariant.id],
          ),
        );
      } else if (unknownGap) {
        findings.push(
          finding(
            'trajectory-invariant',
            'warning',
            'exposure-partly-unknown',
            `"${node.id}" has time at an undeclared temperature, so its exposure against "${invariant.id}" is a lower bound`,
            [node.id, invariant.id],
          ),
        );
      }
    }
  }

  return report('trajectory-invariant', worstOutcome(findings), findings);
}

function checkServiceState(plan: KitchenPlan, graph: PlanGraph, constraints: VerifiedConstraints): PlanCheckReport {
  const required = constraints.serviceComponents ?? [];
  if (required.length === 0) {
    return report('service-state', 'not-applicable', [], 'the item states no required service components');
  }
  const findings: PlanFinding[] = [];

  for (const need of required) {
    const served = plan.serviceState.components.filter((c) => {
      const node = graph.nodes.get(c.componentId);
      const names = [c.componentId, ...(node ? [node.name] : [])];
      return names.some((n) => nameMatchesAny(n, need.aliases));
    });
    if (served.length === 0) {
      findings.push(
        finding('service-state', 'violation', 'required-component-not-served', `nothing matching "${need.role}" is present at service`, [need.role]),
      );
      continue;
    }
    for (const component of served) {
      if (need.state && !sameState(component.state, need.state)) {
        findings.push(
          finding(
            'service-state',
            'violation',
            'wrong-service-state',
            `"${component.componentId}" is served "${component.state}" where the item requires "${need.state}"`,
            [component.componentId],
          ),
        );
      }
      if (need.minTemperatureCelsius !== undefined) {
        const celsius = component.temperature
          ? toCelsius(component.temperature.value, component.temperature.unit)
          : undefined;
        if (celsius === undefined) {
          findings.push(
            finding(
              'service-state',
              'violation',
              'service-temperature-undeclared',
              `"${component.componentId}" must be served at ${need.minTemperatureCelsius}°C or above and declares no temperature`,
              [component.componentId],
            ),
          );
        } else if (celsius < need.minTemperatureCelsius - 1e-9) {
          findings.push(
            finding(
              'service-state',
              'violation',
              'service-too-cold',
              `"${component.componentId}" is served at ${round(celsius)}°C against a required ${need.minTemperatureCelsius}°C`,
              [component.componentId],
            ),
          );
        }
      }
    }
  }

  return report('service-state', worstOutcome(findings), findings);
}

/* -------------------------------------------------------------------------- */
/* scaling                                                                     */
/* -------------------------------------------------------------------------- */

/** Relative tolerance on a scaled quantity. Rounding to a sane number is fine. */
export const SCALE_TOLERANCE = 0.02;

export interface ScaleOptions {
  tolerance?: number;
}

/**
 * Scale the graph.
 *
 * Quantities and servings scale; durations, temperatures and the graph itself
 * do not. That is a culinary claim, not an omission: heat transfer is not
 * linear in volume, and a validator that doubled the roasting time when the
 * joint doubled would be encoding an error and then marking candidates against
 * it. Whether a bigger batch needs longer is exactly the judgement the item is
 * asking about, so the reference scaling stays silent on it.
 */
export function scaleKitchenPlan(plan: KitchenPlan, factor: number): KitchenPlan {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new KitchenPlanValidationError(`scale factor ${factor} is not a positive number`);
  }
  const servings = plan.servings * factor;
  if (!Number.isInteger(servings)) {
    throw new KitchenPlanValidationError(
      `scaling ${plan.servings} servings by ${factor} gives ${servings}, which is not a whole number of servings`,
    );
  }
  // A deep copy, not a spread. A spread shares `operations`, `dependencies` and
  // every ingredient without a quantity with the input, so a caller adjusting
  // the scaled plan — which is the entire point of having one — silently edits
  // the plan it is being compared against, and the comparison finds nothing.
  const scaled: KitchenPlan = structuredClone(plan);
  scaled.servings = servings;
  for (const ingredient of scaled.ingredients) {
    if (ingredient.quantity) ingredient.quantity.amount *= factor;
  }
  return scaled;
}

export interface ScaleComparison {
  factor: number;
  findings: PlanFinding[];
  outcome: PlanCheckOutcome;
}

/**
 * Compare a candidate's scaled plan against the base plan scaled by arithmetic.
 *
 * Quantities and ratios are the assertion, so a drifted quantity is a
 * violation. Topology is not: a bigger batch may genuinely need a second tray,
 * a longer braise or an extra step, and rejecting those would reject viable
 * approaches. Those differences are surfaced as warnings for the judge.
 */
export function compareScaledPlan(
  base: KitchenPlan,
  scaled: KitchenPlan,
  factor: number,
  options: ScaleOptions = {},
): ScaleComparison {
  const tolerance = options.tolerance ?? SCALE_TOLERANCE;
  const findings: PlanFinding[] = [];
  const add = (severity: PlanSeverity, code: string, message: string, subjects: string[]) =>
    findings.push(finding('scaling', severity, code, message, subjects));

  if (scaled.servings !== base.servings * factor) {
    add('violation', 'servings-not-scaled', `servings went from ${base.servings} to ${scaled.servings}, not ${base.servings * factor}`, []);
  }

  const scaledById = new Map(scaled.ingredients.map((i) => [i.id, i]));
  for (const ing of base.ingredients) {
    const other = scaledById.get(ing.id) ?? scaled.ingredients.find((i) => nameMatchesAny(i.name, [ing.name]));
    if (!other) {
      add('violation', 'ingredient-dropped', `"${ing.id}" (${ing.name}) is missing from the scaled plan`, [ing.id]);
      continue;
    }
    if (!ing.quantity || !other.quantity) {
      if (ing.quantity || other.quantity) {
        add('warning', 'quantity-presence-changed', `"${ing.id}" has a quantity in one plan and not the other`, [ing.id]);
      }
      continue;
    }
    const expected = ing.quantity.amount * factor;
    // Same unit compares directly. The unit table knows nothing about "gō",
    // "medium onions" or any other locale or count unit, and routing those
    // through it would quietly skip the check on exactly the items where
    // scaling errors are most likely.
    const actual =
      normaliseName(other.quantity.unit) === normaliseName(ing.quantity.unit)
        ? other.quantity.amount
        : convertMeasure(other.quantity.amount, other.quantity.unit, ing.quantity.unit);
    if (actual === undefined) {
      add('warning', 'unit-not-comparable', `"${ing.id}" scales from ${ing.quantity.unit} to ${other.quantity.unit}, which cannot be compared`, [ing.id]);
      continue;
    }
    const drift = Math.abs(actual - expected) / Math.max(Math.abs(expected), 1e-9);
    if (drift > tolerance) {
      add(
        'violation',
        'quantity-not-scaled',
        `"${ing.id}" scaled to ${round(actual)} ${ing.quantity.unit}, not ${round(expected)} ${ing.quantity.unit}`,
        [ing.id],
      );
    }
  }
  for (const ing of scaled.ingredients) {
    if (!base.ingredients.some((b) => b.id === ing.id || nameMatchesAny(b.name, [ing.name]))) {
      add('warning', 'ingredient-added', `"${ing.id}" (${ing.name}) appears only in the scaled plan`, [ing.id]);
    }
  }

  const baseOps = new Set(base.operations.map((o) => o.id));
  for (const op of scaled.operations) {
    if (!baseOps.has(op.id)) {
      add('warning', 'operation-added', `the scaled plan adds operation "${op.id}"`, [op.id]);
      continue;
    }
    const before = base.operations.find((o) => o.id === op.id)!;
    if (before.temperature && op.temperature) {
      const a = toCelsius(before.temperature.value, before.temperature.unit);
      const b = toCelsius(op.temperature.value, op.temperature.unit);
      if (a !== undefined && b !== undefined && Math.abs(a - b) > 1e-9) {
        add('warning', 'temperature-changed', `"${op.id}" changes temperature from ${round(a)}°C to ${round(b)}°C when scaled`, [op.id]);
      }
    }
    if (before.duration && op.duration && (before.duration.minMinutes !== op.duration.minMinutes || before.duration.maxMinutes !== op.duration.maxMinutes)) {
      add('warning', 'duration-changed', `"${op.id}" changes duration when scaled`, [op.id]);
    }
  }
  for (const op of base.operations) {
    if (!scaled.operations.some((o) => o.id === op.id)) {
      add('warning', 'operation-dropped', `the scaled plan drops operation "${op.id}"`, [op.id]);
    }
  }

  return { factor, findings, outcome: worstOutcome(findings) };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                     */
/* -------------------------------------------------------------------------- */

function finding(
  check: PlanCheck,
  severity: PlanSeverity,
  code: string,
  message: string,
  subjects: string[],
): PlanFinding {
  return { check, layer: CHECK_LAYER[check], severity, code, message, subjects };
}

function report(
  check: PlanCheck,
  outcome: PlanCheckOutcome,
  findings: PlanFinding[],
  reason?: string,
): PlanCheckReport {
  if (outcome === 'indeterminate' && !reason) {
    throw new KitchenPlanValidationError(`check "${check}" is indeterminate without a stated reason`);
  }
  return { check, layer: CHECK_LAYER[check], outcome, reason, findings };
}

function worstOutcome(findings: PlanFinding[]): PlanCheckOutcome {
  if (findings.some((f) => f.severity === 'violation')) return 'violation';
  if (findings.length > 0) return 'warning';
  return 'pass';
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function uniqueInOrder(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** States compare loosely on case and spacing only — never on vocabulary. */
function sameState(a: string, b: string): boolean {
  return normaliseName(a) === normaliseName(b);
}

export function normaliseName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Token-sequence containment in either direction, so an item asking for "gravy"
 * matches a plan's "onion gravy" without "jus" matching "just rested". Naked
 * substring matching was tried first and does the latter.
 */
export function nameMatchesAny(name: string, aliases: string[]): boolean {
  const hay = normaliseName(name).split(' ').filter(Boolean);
  return aliases.some((alias) => {
    const needle = normaliseName(alias).split(' ').filter(Boolean);
    if (needle.length === 0 || hay.length === 0) return false;
    return containsSequence(hay, needle) || containsSequence(needle, hay);
  });
}

function containsSequence(hay: string[], needle: string[]): boolean {
  if (needle.length > hay.length) return false;
  for (let i = 0; i <= hay.length - needle.length; i += 1) {
    if (needle.every((token, j) => hay[i + j] === token)) return true;
  }
  return false;
}

function matchEquipment(id: string, name: string, verified: VerifiedEquipment[]): VerifiedEquipment | undefined {
  return (
    verified.find((v) => v.id === id) ??
    verified.find((v) => nameMatchesAny(name, [v.id, ...(v.aliases ?? [])]) || nameMatchesAny(id, [v.id, ...(v.aliases ?? [])]))
  );
}

function occupancy(op: PlanOperation, schedule: PlanSchedule): Occupancy {
  const slot = schedule.byOperation.get(op.id)!;
  return { operation: op.id, start: slot.start, finish: slot.finish };
}

/**
 * Peak simultaneous occupancy via a sweep over interval endpoints. Zero-length
 * occupancies cannot collide with anything and are dropped: an instantaneous
 * step does not hold the oven.
 */
function overlapPeaks(slots: Occupancy[]): { peak: number; who: string[] } {
  const live = slots.filter((s) => s.finish > s.start + 1e-9);
  let peak = 0;
  let who: string[] = [];
  for (const point of live) {
    const at = point.start;
    const concurrent = live.filter((s) => s.start <= at + 1e-9 && s.finish > at + 1e-9);
    if (concurrent.length > peak) {
      peak = concurrent.length;
      who = concurrent.map((c) => c.operation);
    }
  }
  return { peak, who };
}

/** Intervals during which an operation has the component in hand. */
function contactIntervals(nodeId: string, graph: PlanGraph, schedule: PlanSchedule): Occupancy[] {
  const out: Occupancy[] = [];
  for (const op of graph.operations.values()) {
    const touches = op.inputs.includes(nodeId) || op.outputs.some((o) => o.id === nodeId);
    if (!touches) continue;
    const slot = schedule.byOperation.get(op.id);
    if (slot) out.push({ operation: op.id, start: slot.start, finish: slot.finish });
  }
  return out.sort((a, b) => a.start - b.start || a.finish - b.finish);
}

/**
 * Time between contacts, and — when the component is still extant — between the
 * last contact and service.
 *
 * Time *before* the first contact is deliberately not counted. The plan does
 * not say when an ingredient left the fridge, and charging every plan for the
 * whole cook because it declared a chicken would make the check useless. An
 * item that wants to test pre-preparation storage must say so in its pack.
 */
function gapIntervals(contacts: Occupancy[], serviceAtMinute?: number): { start: number; finish: number }[] {
  const gaps: { start: number; finish: number }[] = [];
  let cursor = contacts[0]?.finish ?? 0;
  for (const contact of contacts.slice(1)) {
    if (contact.start > cursor + 1e-9) gaps.push({ start: cursor, finish: contact.start });
    cursor = Math.max(cursor, contact.finish);
  }
  if (serviceAtMinute !== undefined && serviceAtMinute > cursor + 1e-9) {
    gaps.push({ start: cursor, finish: serviceAtMinute });
  }
  return gaps;
}

/** When the component is next picked up after being produced, if ever. */
function nextContactMinute(nodeId: string, graph: PlanGraph, schedule: PlanSchedule): number | undefined {
  const node = graph.nodes.get(nodeId);
  const producedAt = node?.producer ? (schedule.byOperation.get(node.producer)?.finish ?? 0) : 0;
  const later = (graph.consumersOf.get(nodeId) ?? [])
    .map((id) => schedule.byOperation.get(id)?.start)
    .filter((n): n is number => n !== undefined && n >= producedAt - 1e-9)
    .sort((a, b) => a - b);
  return later[0];
}

function inBand(celsius: number, band: { minCelsius: number; maxCelsius: number }): boolean {
  return celsius >= band.minCelsius && celsius <= band.maxCelsius;
}

function toCelsius(value: number, unit: 'C' | 'F'): number | undefined {
  return unit === 'C' ? value : convert(value, 'f', 'c');
}

/** Convert through the shared unit table, refusing unknown or mixed dimensions. */
function convertMeasure(value: number, from: string, to: string): number | undefined {
  const a = normalizeUnit(from);
  const b = normalizeUnit(to);
  if (!a || !b) return undefined;
  return convert(value, a, b);
}

function temperatureIn(value: number, unit: 'C' | 'F', targetUnit: string): number | undefined {
  return convertMeasure(value, unit, targetUnit);
}

function satisfiesThreshold(
  value: number,
  threshold: { value: number; comparator: 'at-least' | 'at-most' | 'between'; upper?: number },
): boolean {
  switch (threshold.comparator) {
    case 'at-least':
      return value >= threshold.value - 1e-9;
    case 'at-most':
      return value <= threshold.value + 1e-9;
    case 'between':
      return threshold.upper === undefined
        ? false // "between" without an upper bound is not a bound at all
        : value >= threshold.value - 1e-9 && value <= threshold.upper + 1e-9;
  }
}

function satisfiesRequirement(value: number, need: VerifiedSafetyCheckpoint): boolean {
  return satisfiesThreshold(value, { value: need.value, comparator: need.comparator, upper: need.upper });
}

function describeThreshold(threshold: { value: number; unit: string; comparator: string; upper?: number }): string {
  return threshold.comparator === 'between'
    ? `${threshold.value}–${threshold.upper ?? '?'} ${threshold.unit}`
    : `${threshold.comparator} ${threshold.value} ${threshold.unit}`;
}

function describeRequirement(need: VerifiedSafetyCheckpoint): string {
  return describeThreshold({ value: need.value, unit: need.unit, comparator: need.comparator, upper: need.upper });
}
