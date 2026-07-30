/**
 * M1.2 fixtures.
 *
 * These are written to break the validator, not to demonstrate it. The two
 * things most likely to be wrong in a module like this are (a) rejecting a
 * perfectly good plan because it took a different route through the kitchen and
 * (b) passing something because a limit was missing, so both are tested harder
 * than the happy path. Every "unsafe" fixture is a mutation of a fixture that
 * passes, so a failure localises to the mutation rather than to the plumbing.
 */
import { describe, expect, it } from 'vitest';
import type { KitchenPlan, PlanEquipment, PlanIngredient, PlanOperation } from '../src/types.js';
import {
  buildPlanGraph,
  compareScaledPlan,
  formatFailure,
  isValidatorVersionCompatible,
  KitchenPlanValidationError,
  PLAN_VALIDATOR_VERSION,
  readKitchenPlan,
  readVerifiedConstraints,
  scaleKitchenPlan,
  scheduleOperations,
  validateKitchenPlan,
  type PlanCheck,
  type PlanValidation,
  type VerifiedConstraints,
} from '../src/kitchenplan.js';
import { buildTrnTable, type TrnTable } from '../src/trn.js';

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const clone = <T>(value: T): T => structuredClone(value);

/**
 * Fixtures are mutated by name, not by array position. One of the tests below
 * deliberately shuffles the operation array, and index-based mutation would
 * have quietly moved with it.
 */
function op(plan: KitchenPlan, id: string): PlanOperation {
  const found = plan.operations.find((o) => o.id === id);
  if (!found) throw new Error(`fixture has no operation "${id}"`);
  return found;
}

function ingredient(plan: KitchenPlan, id: string): PlanIngredient {
  const found = plan.ingredients.find((i) => i.id === id);
  if (!found) throw new Error(`fixture has no ingredient "${id}"`);
  return found;
}

function equipmentEntry(plan: KitchenPlan, id: string): PlanEquipment {
  const found = plan.equipment.find((e) => e.id === id);
  if (!found) throw new Error(`fixture has no equipment "${id}"`);
  return found;
}

function servedComponent(plan: KitchenPlan, componentId: string) {
  const found = plan.serviceState.components.find((c) => c.componentId === componentId);
  if (!found) throw new Error(`fixture does not serve "${componentId}"`);
  return found;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`fixture has nothing at index ${index}`);
  return item;
}

/**
 * The brief every plan below answers, expressed as the item would verify it:
 * chicken and potatoes for four, an oven that takes one thing at a time, one
 * hob ring, one cook, on the table by minute 100.
 */
function stateBrief(): VerifiedConstraints {
  return readVerifiedConstraints({
    source: 'prompt',
    equipment: [
      { id: 'oven', aliases: ['oven'], countAvailable: 1 },
      { id: 'hob', aliases: ['hob', 'stovetop'], countAvailable: 1 },
    ],
    cooks: 1,
    serviceAtMinute: 100,
    ambientTemperatureCelsius: 20,
    holdingLimits: [
      { component: { role: 'potatoes', aliases: ['potatoes'] }, maxHoldMinutes: 20 },
      { component: { role: 'chicken', aliases: ['chicken'] }, maxHoldMinutes: 45 },
    ],
    safetyCheckpoints: [
      {
        id: 'chicken-core',
        description: 'chicken reaches a safe core temperature',
        component: { role: 'chicken', aliases: ['chicken'] },
        comparator: 'at-least',
        value: 75,
        unit: 'C',
      },
    ],
    trajectoryInvariants: [
      {
        id: 'danger-zone',
        statement: 'no component spends more than two hours between 5 and 60 °C',
        dangerBand: { minCelsius: 5, maxCelsius: 60, maxCumulativeMinutes: 120 },
      },
    ],
    serviceComponents: [
      { role: 'chicken', aliases: ['chicken'], minTemperatureCelsius: 63 },
      { role: 'potatoes', aliases: ['potatoes'], minTemperatureCelsius: 60 },
    ],
  });
}

/** Approach A: roast the bird whole, boil the potatoes on the hob. */
function roastAndBoil(): KitchenPlan {
  return {
    title: 'Roast chicken with boiled potatoes',
    servings: 4,
    locale: 'en-GB',
    serviceAtMinute: 90,
    ingredients: [
      { id: 'chicken', name: 'whole chicken', quantity: { amount: 1600, unit: 'g' }, allergens: [], startingState: 'raw, chilled' },
      { id: 'salt', name: 'salt', quantity: { amount: 12, unit: 'g' }, allergens: [], startingState: 'dry' },
      { id: 'potatoes', name: 'potatoes', quantity: { amount: 800, unit: 'g' }, allergens: [], startingState: 'raw, peeled' },
      { id: 'water', name: 'water', quantity: { amount: 2, unit: 'l' }, allergens: [], startingState: 'cold' },
    ],
    equipment: [
      { id: 'oven', name: 'oven', countAvailable: 1 },
      { id: 'hob', name: 'hob ring', countAvailable: 1 },
    ],
    operations: [
      {
        id: 'op-season',
        action: 'season',
        inputs: ['chicken', 'salt'],
        outputs: [{ id: 'chicken-seasoned', name: 'seasoned chicken', state: 'seasoned, raw' }],
        equipment: [],
        duration: { minMinutes: 5, maxMinutes: 5 },
        attention: 'active',
        startAtMinute: 0,
      },
      {
        id: 'op-roast',
        action: 'roast',
        inputs: ['chicken-seasoned'],
        outputs: [{ id: 'chicken-roasted', name: 'roasted chicken', state: 'cooked through' }],
        equipment: ['oven'],
        duration: { minMinutes: 70, maxMinutes: 70 },
        temperature: { value: 75, unit: 'C', kind: 'internal' },
        sensoryTarget: 'juices run clear at the thigh joint',
        attention: 'passive',
        startAtMinute: 5,
      },
      {
        id: 'op-rest',
        action: 'rest',
        inputs: ['chicken-roasted'],
        outputs: [{ id: 'chicken-rested', name: 'rested chicken', state: 'rested' }],
        equipment: [],
        duration: { minMinutes: 15, maxMinutes: 15 },
        attention: 'passive',
        startAtMinute: 75,
      },
      {
        id: 'op-boil',
        action: 'boil',
        inputs: ['potatoes', 'water'],
        outputs: [{ id: 'potatoes-boiled', name: 'boiled potatoes', state: 'tender' }],
        equipment: ['hob'],
        duration: { minMinutes: 25, maxMinutes: 25 },
        temperature: { value: 100, unit: 'C', kind: 'water' },
        attention: 'passive',
        startAtMinute: 60,
      },
    ],
    dependencies: [{ from: 'op-roast', to: 'op-rest', kind: 'finish-to-start', lagMinutes: 0 }],
    stateTransitions: [
      { subjectId: 'chicken', from: 'raw, chilled', to: 'seasoned, raw', byOperation: 'op-season' },
      { subjectId: 'chicken-roasted', from: 'cooked through', to: 'rested', byOperation: 'op-rest' },
    ],
    safetyCheckpoints: [
      {
        id: 'cp-core',
        afterOperation: 'op-roast',
        check: 'chicken core temperature at the thickest part of the thigh',
        threshold: { value: 75, unit: 'C', comparator: 'at-least' },
        source: 'prompt',
      },
    ],
    trajectoryInvariants: [
      { id: 'ti-1', statement: 'nothing sits in the danger zone for two hours', source: 'prompt' },
    ],
    holdingLimits: [{ componentId: 'potatoes-boiled', maxHoldMinutes: 20, condition: 'drained, covered', source: 'prompt' }],
    serviceState: {
      atMinute: 90,
      components: [
        { componentId: 'chicken-rested', state: 'rested', temperature: { value: 68, unit: 'C', kind: 'internal' } },
        { componentId: 'potatoes-boiled', state: 'tender', temperature: { value: 70, unit: 'C', kind: 'internal' } },
      ],
    },
  };
}

/**
 * Approach B: spatchcock, sear on the hob, finish in the oven, roast the
 * potatoes in the oven afterwards. Different ingredients, different operations,
 * different order, different equipment usage — and just as correct. If the
 * validator ever fails this fixture while passing A it has acquired a
 * preferred recipe, which is the failure mode M1.2 names explicitly.
 */
function searAndRoast(): KitchenPlan {
  return {
    title: 'Spatchcocked chicken with roast potatoes',
    servings: 4,
    locale: 'en-GB',
    serviceAtMinute: 90,
    ingredients: [
      { id: 'chicken', name: 'whole chicken', quantity: { amount: 1600, unit: 'g' }, allergens: [], startingState: 'raw, chilled' },
      { id: 'oil', name: 'rapeseed oil', quantity: { amount: 30, unit: 'ml' }, allergens: [], startingState: 'bottled' },
      { id: 'potatoes', name: 'potatoes', quantity: { amount: 800, unit: 'g' }, allergens: [], startingState: 'raw, peeled' },
      { id: 'dripping', name: 'beef dripping', quantity: { amount: 60, unit: 'g' }, allergens: [], startingState: 'solid, chilled' },
    ],
    equipment: [
      { id: 'oven', name: 'oven', countAvailable: 1 },
      { id: 'hob', name: 'hob ring', countAvailable: 1 },
    ],
    operations: [
      {
        id: 'op-spatchcock',
        action: 'spatchcock',
        inputs: ['chicken'],
        outputs: [{ id: 'chicken-flat', name: 'spatchcocked chicken', state: 'flattened, raw' }],
        equipment: [],
        duration: { minMinutes: 5, maxMinutes: 5 },
        attention: 'active',
        startAtMinute: 0,
      },
      {
        id: 'op-sear',
        action: 'sear',
        inputs: ['chicken-flat', 'oil'],
        outputs: [{ id: 'chicken-seared', name: 'seared chicken', state: 'browned, raw inside' }],
        equipment: ['hob'],
        duration: { minMinutes: 8, maxMinutes: 8 },
        temperature: { value: 200, unit: 'C', kind: 'surface' },
        attention: 'active',
        startAtMinute: 5,
      },
      {
        id: 'op-oven',
        action: 'finish in the oven',
        inputs: ['chicken-seared'],
        outputs: [{ id: 'chicken-done', name: 'roasted chicken', state: 'cooked through' }],
        equipment: ['oven'],
        duration: { minMinutes: 30, maxMinutes: 30 },
        temperature: { value: 75, unit: 'C', kind: 'internal' },
        attention: 'passive',
        startAtMinute: 13,
      },
      {
        id: 'op-rest',
        action: 'rest',
        inputs: ['chicken-done'],
        outputs: [{ id: 'chicken-rested', name: 'rested chicken', state: 'rested' }],
        equipment: [],
        duration: { minMinutes: 10, maxMinutes: 10 },
        attention: 'passive',
        startAtMinute: 43,
      },
      {
        id: 'op-roast-pot',
        action: 'roast',
        inputs: ['potatoes', 'dripping'],
        outputs: [{ id: 'potatoes-roasted', name: 'roast potatoes', state: 'crisp' }],
        equipment: ['oven'],
        duration: { minMinutes: 40, maxMinutes: 40 },
        temperature: { value: 200, unit: 'C', kind: 'oven' },
        attention: 'passive',
        startAtMinute: 45,
      },
    ],
    dependencies: [{ from: 'op-oven', to: 'op-rest', kind: 'finish-to-start', lagMinutes: 0 }],
    stateTransitions: [
      { subjectId: 'chicken', from: 'raw, chilled', to: 'flattened, raw', byOperation: 'op-spatchcock' },
      { subjectId: 'chicken-done', from: 'cooked through', to: 'rested', byOperation: 'op-rest' },
    ],
    safetyCheckpoints: [
      {
        id: 'cp-core',
        afterOperation: 'op-oven',
        check: 'chicken core temperature',
        threshold: { value: 75, unit: 'C', comparator: 'at-least' },
        source: 'prompt',
      },
    ],
    trajectoryInvariants: [{ id: 'ti-1', statement: 'nothing sits in the danger zone', source: 'prompt' }],
    holdingLimits: [{ componentId: 'chicken-rested', maxHoldMinutes: 45, condition: 'loosely covered', source: 'prompt' }],
    serviceState: {
      atMinute: 90,
      components: [
        { componentId: 'chicken-rested', state: 'rested', temperature: { value: 66, unit: 'C', kind: 'internal' } },
        { componentId: 'potatoes-roasted', state: 'crisp', temperature: { value: 80, unit: 'C', kind: 'internal' } },
      ],
    },
  };
}

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function codes(result: PlanValidation, check?: PlanCheck): string[] {
  return result.findings.filter((f) => !check || f.check === check).map((f) => f.code);
}

function outcome(result: PlanValidation, check: PlanCheck): string {
  const layer = [result.format, result.structure, result.culinary].find((l) =>
    l.checks.some((c) => c.check === check),
  );
  return layer?.checks.find((c) => c.check === check)?.outcome ?? 'missing';
}

/* -------------------------------------------------------------------------- */
/* multiple valid plans                                                       */
/* -------------------------------------------------------------------------- */

describe('two different valid plans for the same brief', () => {
  it('accepts both without preferring either', () => {
    const brief = stateBrief();
    for (const plan of [roastAndBoil(), searAndRoast()]) {
      const result = validateKitchenPlan(plan, brief);
      expect(result.findings.filter((f) => f.severity === 'violation')).toEqual([]);
      expect(result.structure.verdict).toBe('pass');
      expect(result.culinary.verdict).toBe('pass');
    }
  });

  it('reaches the same verdict on a plan whose operations are declared in a scrambled order', () => {
    // Declaration order is not execution order. A validator that quietly relied
    // on the array order would pass the fixture and fail the shuffle.
    const plan = roastAndBoil();
    plan.operations = ['op-boil', 'op-rest', 'op-season', 'op-roast'].map((id) => op(plan, id));
    const result = validateKitchenPlan(plan, stateBrief());
    expect(result.findings.filter((f) => f.severity === 'violation')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* structure                                                                  */
/* -------------------------------------------------------------------------- */

describe('structural consistency', () => {
  it('catches an ingredient nobody uses', () => {
    const plan = roastAndBoil();
    plan.ingredients.push({ id: 'thyme', name: 'thyme', allergens: [], startingState: 'fresh' });
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'ingredient-consumption')).toContain('orphan-ingredient');
    expect(result.structure.verdict).toBe('fail');
    // The fault is structural and must not leak into the culinary column.
    expect(result.culinary.verdict).toBe('pass');
  });

  it('does not call a plated raw garnish an orphan', () => {
    const plan = roastAndBoil();
    plan.ingredients.push({ id: 'parsley', name: 'parsley', allergens: [], startingState: 'chopped' });
    plan.serviceState.components.push({ componentId: 'parsley', state: 'scattered over' });
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'ingredient-consumption')).toEqual([]);
  });

  it('catches a component that is cooked and then thrown away', () => {
    const plan = roastAndBoil();
    plan.operations.push({
      id: 'op-stock',
      action: 'simmer',
      inputs: ['water'],
      outputs: [{ id: 'stock', name: 'stock', state: 'reduced' }],
      equipment: ['hob'],
      duration: { minMinutes: 10, maxMinutes: 10 },
      startAtMinute: 0,
    });
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'output-consumption')).toContain('dangling-output');
  });

  it('catches a component that is both served and used in a later step', () => {
    const plan = roastAndBoil();
    plan.operations.push({
      id: 'op-mash',
      action: 'mash',
      inputs: ['potatoes-boiled'],
      outputs: [{ id: 'mash', name: 'mash', state: 'smooth' }],
      equipment: [],
      duration: { minMinutes: 5, maxMinutes: 5 },
      startAtMinute: 85,
    });
    plan.serviceState.components.push({ componentId: 'mash', state: 'smooth' });
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'output-consumption')).toContain('served-and-consumed');
  });

  it('names the cycle rather than merely reporting one', () => {
    const plan = roastAndBoil();
    op(plan, 'op-season').inputs.push('chicken-rested');
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'acyclicity')).toEqual(['cycle']);
    const cycle = result.findings.find((f) => f.code === 'cycle')!;
    expect(cycle.subjects).toContain('op-season');
    expect(cycle.subjects).toContain('op-rest');
  });

  it('does not mistake a mutual start-to-start pair for a cycle', () => {
    // "Get these two going together" is an instruction, not a contradiction.
    const plan = roastAndBoil();
    plan.dependencies.push(
      { from: 'op-boil', to: 'op-rest', kind: 'start-to-start', lagMinutes: 0 },
      { from: 'op-rest', to: 'op-boil', kind: 'start-to-start', lagMinutes: 0 },
    );
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'acyclicity')).toEqual([]);
  });

  it('catches a step that starts before its input exists', () => {
    const plan = roastAndBoil();
    op(plan, 'op-rest').startAtMinute = 70; // rest begins while the bird is still roasting
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'ordering-feasibility')).toContain('consumes-before-produced');
    expect(codes(result, 'ordering-feasibility')).toContain('declared-start-breaks-dependency');
  });

  it('catches a state transition that starts from the wrong state', () => {
    const plan = roastAndBoil();
    at(plan.stateTransitions, 1).from = 'raw, chilled';
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'state-transition')).toContain('invalid-transition');
  });

  it('catches an operation transforming something it never touches', () => {
    const plan = roastAndBoil();
    plan.stateTransitions.push({
      subjectId: 'potatoes',
      from: 'raw, peeled',
      to: 'tender',
      byOperation: 'op-roast',
    });
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'state-transition')).toContain('transition-without-contact');
  });

  it('refuses to order transitions when the graph is cyclic instead of guessing', () => {
    const plan = roastAndBoil();
    op(plan, 'op-season').inputs.push('chicken-rested');
    expect(outcome(validateKitchenPlan(plan, stateBrief()), 'state-transition')).toBe('indeterminate');
  });

  it('catches a plan that breaks a holding limit it set itself', () => {
    const plan = roastAndBoil();
    op(plan, 'op-boil').startAtMinute = 20; // potatoes done at 45, served at 90
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'self-declared-limit')).toContain('holds-past-own-limit');
  });

  it('catches a checkpoint the plan contradicts one line later', () => {
    const plan = roastAndBoil();
    op(plan, 'op-roast').temperature = { value: 61, unit: 'C', kind: 'internal' };
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'self-declared-limit')).toContain('checkpoint-contradicts-operation');
  });

  it('resolves ids and refuses references to things that do not exist', () => {
    const plan = roastAndBoil();
    op(plan, 'op-roast').inputs = ['chicken-brined'];
    op(plan, 'op-roast').equipment = ['tandoor'];
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'reference-integrity')).toEqual(
      expect.arrayContaining(['unknown-input', 'unknown-equipment']),
    );
  });

  it('rejects one id naming two things', () => {
    const plan = roastAndBoil();
    at(op(plan, 'op-boil').outputs, 0).id = 'chicken-rested';
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'reference-integrity')).toContain('duplicate-id');
  });
});

/* -------------------------------------------------------------------------- */
/* the provenance firewall                                                    */
/* -------------------------------------------------------------------------- */

describe('a plan cannot supply its own constraint values', () => {
  it('rejects a plan that gives itself a second oven, and still schedules against one', () => {
    const plan = roastAndBoil();
    equipmentEntry(plan, 'oven').countAvailable = 2;
    equipmentEntry(plan, 'oven').capacity = '2 shelves';
    equipmentEntry(plan, 'oven').capacitySource = 'candidate-assumption';
    // Roast the potatoes in the oven the plan just invented, alongside the bird.
    op(plan, 'op-boil').equipment = ['oven'];
    op(plan, 'op-boil').startAtMinute = 30;

    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'constraint-provenance')).toContain('self-declared-capacity');
    expect(codes(result, 'equipment-contention')).toContain('equipment-oversubscribed');
    // Reported in different layers: claiming the kitchen is structural, running
    // out of oven is culinary.
    expect(result.structure.verdict).toBe('fail');
    expect(result.culinary.verdict).toBe('fail');
  });

  it('treats equipment the stated kitchen does not have as unavailable, not as free', () => {
    const plan = roastAndBoil();
    plan.equipment.push({ id: 'sous-vide', name: 'sous vide circulator', countAvailable: 1 });
    op(plan, 'op-roast').equipment = ['sous-vide'];
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'constraint-provenance')).toContain('equipment-not-in-stated-kitchen');
    expect(codes(result, 'equipment-contention')).toContain('equipment-unavailable');
  });

  it('flags provenance the pack cannot corroborate without calling it bad cooking', () => {
    const plan = roastAndBoil();
    plan.assumptions = [{ statement: 'the oven is already hot', source: 'prompt' }];
    const result = validateKitchenPlan(plan, stateBrief());
    const finding = result.findings.find((f) => f.code === 'unverifiable-provenance');
    expect(finding?.severity).toBe('warning');
    expect(result.structure.verdict).toBe('pass');
  });

  it('will not accept a constraint pack sourced from the candidate', () => {
    const rogue = { source: 'candidate-assumption', equipment: [] } as unknown as VerifiedConstraints;
    expect(() => validateKitchenPlan(roastAndBoil(), rogue)).toThrow(KitchenPlanValidationError);
    expect(() => readVerifiedConstraints({ source: 'candidate-assumption' })).toThrow(KitchenPlanValidationError);
  });

  it('will not validate against nothing at all', () => {
    expect(() => validateKitchenPlan(roastAndBoil(), undefined as unknown as VerifiedConstraints)).toThrow(
      KitchenPlanValidationError,
    );
  });

  it('refuses to confirm contention when the item states no kitchen', () => {
    const brief = readVerifiedConstraints({ source: 'prompt', serviceAtMinute: 100 });
    const result = validateKitchenPlan(roastAndBoil(), brief);
    expect(outcome(result, 'equipment-contention')).toBe('indeterminate');
    // Not "pass". An unstated limit leaves the layer unvalidatable.
    expect(result.culinary.verdict).toBe('unvalidatable');
  });
});

/* -------------------------------------------------------------------------- */
/* culinary feasibility                                                       */
/* -------------------------------------------------------------------------- */

describe('resources, timing and service', () => {
  it('catches two simultaneous oven steps against one oven', () => {
    const plan = roastAndBoil();
    op(plan, 'op-boil').equipment = ['oven'];
    op(plan, 'op-boil').startAtMinute = 40;
    const result = validateKitchenPlan(plan, stateBrief());
    const finding = result.findings.find((f) => f.code === 'equipment-oversubscribed')!;
    expect(finding.subjects).toEqual(expect.arrayContaining(['oven', 'op-roast', 'op-boil']));
  });

  it('warns rather than fails when a collision needs every step to run long', () => {
    const plan = roastAndBoil();
    op(plan, 'op-roast').duration = { minMinutes: 50, maxMinutes: 70 };
    op(plan, 'op-boil').equipment = ['oven'];
    op(plan, 'op-boil').startAtMinute = 60; // clear of the fast reading, not the slow one
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'equipment-contention')).toEqual(['equipment-tight']);
    expect(result.culinary.verdict).toBe('pass');
  });

  it('catches hands-on steps that need two cooks when the brief states one', () => {
    const plan = roastAndBoil();
    op(plan, 'op-boil').attention = 'active';
    op(plan, 'op-boil').startAtMinute = 2; // overlapping the seasoning
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'cook-contention')).toContain('cook-oversubscribed');
  });

  it('issues no cook verdict at all when the brief states no cook count', () => {
    const brief = stateBrief();
    delete brief.cooks;
    expect(outcome(validateKitchenPlan(roastAndBoil(), brief), 'cook-contention')).toBe('not-applicable');
  });

  it('catches a sequence that cannot reach the stated service time', () => {
    const plan = roastAndBoil();
    op(plan, 'op-roast').duration = { minMinutes: 150, maxMinutes: 150 };
    op(plan, 'op-rest').startAtMinute = 155;
    plan.serviceState.atMinute = 170;
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'critical-path')).toEqual(
      expect.arrayContaining(['cannot-reach-service', 'service-declared-late']),
    );
  });

  it('will not confirm a fit when a step declares no duration', () => {
    const plan = roastAndBoil();
    delete op(plan, 'op-season').duration;
    // A lower bound that fits proves nothing; a lower bound that misses is proof.
    expect(outcome(validateKitchenPlan(plan, stateBrief()), 'critical-path')).toBe('indeterminate');
  });

  it('still fails a plan that misses the deadline even at its fastest reading', () => {
    const plan = roastAndBoil();
    delete op(plan, 'op-season').duration;
    op(plan, 'op-roast').duration = { minMinutes: 200, maxMinutes: 200 };
    op(plan, 'op-rest').startAtMinute = 210;
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'critical-path')).toContain('cannot-reach-service');
  });

  it('catches a component held past the stated limit', () => {
    const plan = roastAndBoil();
    op(plan, 'op-boil').startAtMinute = 10; // potatoes ready at 35, plated at 90
    at(plan.holdingLimits, 0).maxHoldMinutes = 90; // the plan's own limit is generous
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'holding-limit')).toContain('held-too-long');
    expect(codes(result, 'self-declared-limit')).toEqual([]);
  });

  it('catches a stated component that never appears in the plan', () => {
    const brief = stateBrief();
    brief.holdingLimits!.push({ component: { role: 'gravy', aliases: ['gravy', 'jus'] }, maxHoldMinutes: 30 });
    const result = validateKitchenPlan(roastAndBoil(), brief);
    expect(codes(result, 'holding-limit')).toContain('held-component-absent');
  });
});

/* -------------------------------------------------------------------------- */
/* safety                                                                     */
/* -------------------------------------------------------------------------- */

describe('safety trajectory', () => {
  it('catches a checkpoint that does not reach the stated threshold', () => {
    const plan = roastAndBoil();
    at(plan.safetyCheckpoints, 0).threshold = { value: 63, unit: 'C', comparator: 'at-least' };
    op(plan, 'op-roast').temperature = { value: 63, unit: 'C', kind: 'internal' };
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'safety-checkpoint')).toContain('checkpoint-below-threshold');
  });

  it('accepts the same threshold stated in Fahrenheit', () => {
    const plan = roastAndBoil();
    at(plan.safetyCheckpoints, 0).threshold = { value: 167, unit: 'F', comparator: 'at-least' };
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'safety-checkpoint')).toEqual([]);
  });

  it('catches a missing checkpoint', () => {
    const plan = roastAndBoil();
    plan.safetyCheckpoints = [];
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'safety-checkpoint')).toContain('required-checkpoint-missing');
  });

  it('does not let a candidate-assumed checkpoint discharge a verified requirement', () => {
    const plan = roastAndBoil();
    at(plan.safetyCheckpoints, 0).source = 'candidate-assumption';
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'safety-checkpoint')).toContain('required-checkpoint-missing');
  });

  it('catches a temperature check taken after the food is served', () => {
    const plan = roastAndBoil();
    plan.serviceState.atMinute = 60;
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'safety-checkpoint')).toContain('checkpoint-after-service');
  });

  it('catches a component left in the danger band past the stated maximum', () => {
    const plan: KitchenPlan = {
      title: 'Rice, cooked early',
      servings: 4,
      locale: 'en-GB',
      serviceAtMinute: 240,
      ingredients: [
        { id: 'rice', name: 'long grain rice', quantity: { amount: 300, unit: 'g' }, allergens: [], startingState: 'dry' },
        { id: 'water', name: 'water', quantity: { amount: 600, unit: 'ml' }, allergens: [], startingState: 'cold' },
      ],
      equipment: [{ id: 'hob', name: 'hob ring', countAvailable: 1 }],
      operations: [
        {
          id: 'op-boil',
          action: 'boil',
          inputs: ['rice', 'water'],
          outputs: [{ id: 'cooked-rice', name: 'cooked rice', state: 'steaming' }],
          equipment: ['hob'],
          duration: { minMinutes: 15, maxMinutes: 15 },
          temperature: { value: 100, unit: 'C', kind: 'water' },
          startAtMinute: 0,
        },
      ],
      dependencies: [],
      stateTransitions: [],
      safetyCheckpoints: [],
      trajectoryInvariants: [],
      holdingLimits: [],
      serviceState: {
        atMinute: 240,
        components: [{ componentId: 'cooked-rice', state: 'cooled on the side', temperature: { value: 20, unit: 'C', kind: 'ambient' } }],
      },
    };
    const brief = readVerifiedConstraints({
      source: 'prompt',
      equipment: [{ id: 'hob', countAvailable: 1 }],
      serviceAtMinute: 240,
      ambientTemperatureCelsius: 20,
      trajectoryInvariants: [
        {
          id: 'danger-zone',
          statement: 'no component spends more than two hours between 5 and 60 °C',
          dangerBand: { minCelsius: 5, maxCelsius: 60, maxCumulativeMinutes: 120 },
        },
      ],
    });
    const result = validateKitchenPlan(plan, brief);
    expect(codes(result, 'trajectory-invariant')).toContain('danger-band-exceeded');
    const finding = result.findings.find((f) => f.code === 'danger-band-exceeded')!;
    expect(finding.subjects).toContain('cooked-rice');
  });

  it('refuses to price an invariant it cannot measure rather than passing it', () => {
    const brief = stateBrief();
    delete at(brief.trajectoryInvariants!, 0).dangerBand;
    expect(outcome(validateKitchenPlan(roastAndBoil(), brief), 'trajectory-invariant')).toBe('indeterminate');
  });

  it('does not charge a raw ingredient for the whole cook', () => {
    // The chicken is used at minute 5 and gone. Counting from there to service
    // would fail every plan in the bank.
    const result = validateKitchenPlan(roastAndBoil(), stateBrief());
    expect(codes(result, 'trajectory-invariant')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* service state                                                              */
/* -------------------------------------------------------------------------- */

describe('service state', () => {
  it('catches a required dish that never reaches the table', () => {
    const plan = roastAndBoil();
    plan.serviceState.components = [servedComponent(plan, 'chicken-rested')];
    plan.operations = plan.operations.filter((op) => op.id !== 'op-boil');
    plan.ingredients = plan.ingredients.filter((i) => i.id !== 'potatoes' && i.id !== 'water');
    plan.holdingLimits = [];
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'service-state')).toContain('required-component-not-served');
  });

  it('catches a dish served in the wrong state', () => {
    const brief = stateBrief();
    at(brief.serviceComponents!, 0).state = 'rested';
    const plan = roastAndBoil();
    servedComponent(plan, 'chicken-rested').state = 'straight from the oven';
    const result = validateKitchenPlan(plan, brief);
    expect(codes(result, 'service-state')).toContain('wrong-service-state');
  });

  it('catches a dish served below the stated temperature', () => {
    const plan = roastAndBoil();
    servedComponent(plan, 'chicken-rested').temperature = { value: 40, unit: 'C', kind: 'internal' };
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'service-state')).toContain('service-too-cold');
  });

  it('refuses a required temperature the plan simply does not state', () => {
    const plan = roastAndBoil();
    delete servedComponent(plan, 'chicken-rested').temperature;
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'service-state')).toContain('service-temperature-undeclared');
  });

  it('matches a component by role rather than by the item author guessing its id', () => {
    const plan = roastAndBoil();
    op(plan, 'op-boil').outputs[0] = { id: 'spuds-1', name: 'buttered new potatoes', state: 'tender' };
    at(plan.holdingLimits, 0).componentId = 'spuds-1';
    plan.serviceState.components[1] = {
      componentId: 'spuds-1',
      state: 'tender',
      temperature: { value: 70, unit: 'C', kind: 'internal' },
    };
    const result = validateKitchenPlan(plan, stateBrief());
    expect(codes(result, 'service-state')).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* format layer                                                               */
/* -------------------------------------------------------------------------- */

describe('format is tracked apart from cooking', () => {
  it('reads a plan out of a fenced block in a prose answer', () => {
    const text = `Here is my plan.\n\n\`\`\`json\n${JSON.stringify(roastAndBoil())}\n\`\`\`\n\nEnjoy.`;
    const parsed = readKitchenPlan(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.plan?.title).toBe('Roast chicken with boiled potatoes');
  });

  it('reports unparseable output as a format fault and nothing else', () => {
    const parsed = readKitchenPlan('I would roast the chicken for about an hour.');
    expect(parsed.ok).toBe(false);
    expect(parsed.findings.every((f) => f.layer === 'format')).toBe(true);
  });

  it('never reports a culinary pass for an answer that produced no plan', () => {
    const parsed = readKitchenPlan('{ not json');
    const result = formatFailure(parsed.findings);
    expect(result.format.verdict).toBe('fail');
    expect(result.culinary.verdict).toBe('unvalidatable');
    expect(result.structure.verdict).toBe('unvalidatable');
  });

  it('rejects a plan missing an object the item requires', () => {
    const plan = roastAndBoil();
    plan.safetyCheckpoints = [];
    const result = validateKitchenPlan(plan, stateBrief(), {
      contract: { requiredObjects: ['safetyCheckpoints'], validatorVersion: PLAN_VALIDATOR_VERSION },
    });
    expect(codes(result, 'output-contract')).toContain('required-object-missing');
  });

  it('throws on an item requiring an object the validator cannot check', () => {
    expect(() =>
      validateKitchenPlan(roastAndBoil(), stateBrief(), {
        contract: { requiredObjects: ['plating'], validatorVersion: PLAN_VALIDATOR_VERSION },
      }),
    ).toThrow(KitchenPlanValidationError);
  });

  it('refuses an item pinned to different validator semantics', () => {
    expect(() =>
      validateKitchenPlan(roastAndBoil(), stateBrief(), {
        contract: { requiredObjects: ['operations'], validatorVersion: 'kitchenplan-9.0.0' },
      }),
    ).toThrow(KitchenPlanValidationError);
    expect(isValidatorVersionCompatible('kitchenplan-1.0.0')).toBe(true);
    expect(isValidatorVersionCompatible('kitchenplan-1.1.0')).toBe(false);
    expect(isValidatorVersionCompatible('nonsense')).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* scaling                                                                    */
/* -------------------------------------------------------------------------- */

describe('scaling the graph', () => {
  it('scales quantities and servings and leaves the cooking alone', () => {
    const base = roastAndBoil();
    const doubled = scaleKitchenPlan(base, 2);
    expect(doubled.servings).toBe(8);
    expect(ingredient(doubled, 'chicken').quantity?.amount).toBe(3200);
    expect(op(doubled, 'op-roast').duration).toEqual(op(base, 'op-roast').duration);
    expect(op(doubled, 'op-roast').temperature).toEqual(op(base, 'op-roast').temperature);
    expect(compareScaledPlan(base, doubled, 2).findings).toEqual([]);
  });

  it('refuses a factor that produces a fraction of a serving', () => {
    const base = roastAndBoil();
    base.servings = 3;
    expect(() => scaleKitchenPlan(base, 1.5)).toThrow(KitchenPlanValidationError);
    expect(() => scaleKitchenPlan(base, 0)).toThrow(KitchenPlanValidationError);
  });

  it('catches a ratio that drifts while the rest scales', () => {
    const base = roastAndBoil();
    const scaled = scaleKitchenPlan(base, 2);
    ingredient(scaled, 'salt').quantity!.amount = 48; // salt quadrupled
    const comparison = compareScaledPlan(base, scaled, 2);
    expect(comparison.findings.map((f) => f.code)).toEqual(['quantity-not-scaled']);
    expect(comparison.outcome).toBe('violation');
  });

  it('accepts the same quantity restated in a larger unit', () => {
    const base = roastAndBoil();
    const scaled = scaleKitchenPlan(base, 2);
    ingredient(scaled, 'chicken').quantity = { amount: 3.2, unit: 'kg' };
    expect(compareScaledPlan(base, scaled, 2).findings).toEqual([]);
  });

  it('checks a unit the conversion table has never heard of', () => {
    const base = roastAndBoil();
    ingredient(base, 'chicken').quantity = { amount: 2, unit: 'gō' };
    const scaled = scaleKitchenPlan(base, 2);
    ingredient(scaled, 'chicken').quantity = { amount: 3, unit: 'gō' }; // should be 4

    expect(compareScaledPlan(base, scaled, 2).findings.map((f) => f.code)).toEqual(['quantity-not-scaled']);
  });

  it('does not treat a longer braise or an extra tray as an error', () => {
    // Heat transfer is not linear in volume. A validator that insisted the
    // timings scale would be marking candidates against a culinary mistake.
    const base = roastAndBoil();
    const scaled = scaleKitchenPlan(base, 2);
    op(scaled, 'op-roast').duration = { minMinutes: 95, maxMinutes: 95 };
    scaled.operations.push({
      id: 'op-second-tray',
      action: 'roast',
      inputs: ['potatoes'],
      outputs: [{ id: 'potatoes-tray-2', name: 'second tray', state: 'tender' }],
      equipment: ['oven'],
      duration: { minMinutes: 25, maxMinutes: 25 },
    });
    const comparison = compareScaledPlan(base, scaled, 2);
    expect(comparison.findings.every((f) => f.severity === 'warning')).toBe(true);
    expect(comparison.outcome).toBe('warning');
  });

  it('catches an ingredient quietly dropped on the way up', () => {
    const base = roastAndBoil();
    const scaled = scaleKitchenPlan(base, 2);
    scaled.ingredients = scaled.ingredients.filter((i) => i.id !== 'salt');
    expect(compareScaledPlan(base, scaled, 2).findings.map((f) => f.code)).toContain('ingredient-dropped');
  });
});

/* -------------------------------------------------------------------------- */
/* graph and schedule internals                                               */
/* -------------------------------------------------------------------------- */

describe('graph and schedule', () => {
  it('honours a declared start rather than silently repairing it', () => {
    const plan = roastAndBoil();
    op(plan, 'op-rest').startAtMinute = 10;
    const schedule = scheduleOperations(plan, buildPlanGraph(plan), 'min');
    expect(schedule.byOperation.get('op-rest')?.start).toBe(10);
  });

  it('derives a schedule from dependencies and lags when no times are declared', () => {
    const plan = roastAndBoil();
    for (const op of plan.operations) delete op.startAtMinute;
    plan.dependencies = [{ from: 'op-roast', to: 'op-rest', kind: 'finish-to-start', lagMinutes: 10 }];
    const schedule = scheduleOperations(plan, buildPlanGraph(plan), 'min');
    expect(schedule.byOperation.get('op-roast')?.start).toBe(5);
    expect(schedule.byOperation.get('op-rest')?.start).toBe(85);
    expect(schedule.makespan).toBe(100);
  });

  it('reports missing durations rather than assuming a plausible one', () => {
    const plan = roastAndBoil();
    delete op(plan, 'op-roast').duration;
    const schedule = scheduleOperations(plan, buildPlanGraph(plan), 'max');
    expect(schedule.durationsComplete).toBe(false);
    expect(schedule.byOperation.get('op-roast')?.durationAssumedZero).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* the TRN renderer                                                           */
/* -------------------------------------------------------------------------- */

function table(plan: KitchenPlan): TrnTable {
  const result = buildTrnTable(plan);
  if (!result.renderable) throw new Error(`expected a table, got refusal: ${result.reason}`);
  return result;
}

describe('TRN table model', () => {
  it('lays ingredients down the rows and operations across the columns', () => {
    const trn = table(roastAndBoil());
    expect(trn.rows.map((r) => r.nodeId)).toEqual(['chicken', 'salt', 'potatoes', 'water']);
    expect(trn.columnCount).toBe(4);

    const season = trn.cells.find((c) => c.operationId === 'op-season')!;
    expect(season).toMatchObject({ column: 1, rowStart: 0, rowSpan: 2 });
    expect(trn.cells.find((c) => c.operationId === 'op-roast')).toMatchObject({ column: 2, rowSpan: 2 });
    expect(trn.cells.find((c) => c.operationId === 'op-rest')).toMatchObject({ column: 3, rowSpan: 2 });
    // The second dish starts its own block of rows in column 1.
    expect(trn.cells.find((c) => c.operationId === 'op-boil')).toMatchObject({ column: 1, rowStart: 2, rowSpan: 2 });
  });

  it('carries the quantities and the detail a reader needs', () => {
    const trn = table(roastAndBoil());
    expect(at(trn.rows, 0).quantity).toBe('1600 g');
    const roast = trn.cells.find((c) => c.operationId === 'op-roast')!;
    expect(roast.detail).toMatchObject({ duration: '70 min', temperature: '75°C internal', equipment: ['oven'] });
  });

  it('spans every cell over a contiguous block of its own inputs', () => {
    for (const plan of [roastAndBoil(), searAndRoast()]) {
      const trn = table(plan);
      for (const cell of trn.cells) {
        expect(cell.rowSpan).toBeGreaterThan(0);
        expect(cell.rowStart + cell.rowSpan).toBeLessThanOrEqual(trn.rows.length);
      }
    }
  });

  it('draws a shared component once and points at it afterwards', () => {
    const plan = roastAndBoil();
    op(plan, 'op-boil').inputs.push('salt'); // salt seasons the water too
    const trn = table(plan);
    expect(trn.sharedComponents).toEqual(['salt']);
    const reference = trn.rows.find((r) => r.kind === 'back-reference')!;
    expect(reference.nodeId).toBe('salt');
    expect(at(trn.rows, reference.refersToRow!).kind).toBe('ingredient');
  });

  it('shows an orphan ingredient instead of quietly dropping it', () => {
    // A renderer that hid unused ingredients would conceal the exact fault the
    // validator reports two columns to the left.
    const plan = roastAndBoil();
    plan.ingredients.push({ id: 'thyme', name: 'thyme', allergens: [], startingState: 'fresh' });
    const trn = table(plan);
    expect(trn.orphanRows).toHaveLength(1);
    expect(at(trn.rows, at(trn.orphanRows, 0))).toMatchObject({ nodeId: 'thyme', kind: 'orphan' });
    expect(trn.cells.some((c) => c.rowStart === trn.orphanRows[0])).toBe(false);
  });

  it('gives a raw garnish a row of its own rather than calling it an orphan', () => {
    const plan = roastAndBoil();
    plan.ingredients.push({ id: 'parsley', name: 'parsley', allergens: [], startingState: 'chopped' });
    plan.serviceState.components.push({ componentId: 'parsley', state: 'scattered' });
    const trn = table(plan);
    expect(trn.orphanRows).toEqual([]);
    expect(trn.rows.at(-1)).toMatchObject({ nodeId: 'parsley', kind: 'served-directly' });
  });

  it('linearises to a step list in a valid execution order', () => {
    const trn = table(roastAndBoil());
    const order = trn.steps.map((s) => s.operationId);
    expect(order).toHaveLength(4);
    expect(order.indexOf('op-season')).toBeLessThan(order.indexOf('op-roast'));
    expect(order.indexOf('op-roast')).toBeLessThan(order.indexOf('op-rest'));
    expect(at(trn.steps, 0).summary).toContain('season whole chicken, salt');
  });

  it('is deterministic — the same plan renders to the same table', () => {
    const plan = roastAndBoil();
    expect(table(plan)).toEqual(table(clone(plan)));
  });

  it('refuses a cyclic plan rather than looping or drawing a lie', () => {
    const plan = roastAndBoil();
    op(plan, 'op-season').inputs.push('chicken-rested');
    const result = buildTrnTable(plan);
    expect(result.renderable).toBe(false);
    expect(result).toMatchObject({ reason: 'cycle' });
  });

  it('refuses when an operation consumes something that does not exist', () => {
    const plan = roastAndBoil();
    op(plan, 'op-roast').inputs = ['chicken-brined'];
    expect(buildTrnTable(plan)).toMatchObject({ renderable: false, reason: 'unresolved-input' });
  });

  it('refuses when one id names two things', () => {
    const plan = roastAndBoil();
    at(op(plan, 'op-boil').outputs, 0).id = 'chicken-rested';
    expect(buildTrnTable(plan)).toMatchObject({ renderable: false, reason: 'duplicate-id' });
  });

  it('renders the alternative plan just as happily', () => {
    const trn = table(searAndRoast());
    expect(trn.cells).toHaveLength(5);
    expect(trn.orphanRows).toEqual([]);
    expect(trn.columnCount).toBeGreaterThan(2);
  });
});
