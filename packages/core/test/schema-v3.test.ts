import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  anchorBandObservability,
  behaviouralAnchorIssues,
  criterionAttentionHint,
  behaviouralAnchorSetSchema,
  interactiveScriptSchema,
  judgePackSchema,
  kitchenPlanSchema,
  questionFileSchema,
  questionSchema,
  reviewFlagSchema,
  rubricSchema,
  sensoryDossierSchema,
} from '../src/schema.js';
import {
  CRAFT_AXIS_IDS,
  EVIDENCE_MODE_MAP,
  PROPOSED_CRAFT_AXES,
  craftWeightApprovalIssues,
  exclusionsFor,
  proposedCraftWeights,
  resolveCraftWeights,
  type CraftWeightApproval,
} from '../src/constructs.js';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const QUESTIONS_DIR = join(REPO_ROOT, 'data', 'questions');

// packages/core deliberately depends on zod and nothing else — it is imported by
// the web app, and a YAML parser in its dependency tree would be dead weight
// there. The dataset still has to be parsed to prove it survives this schema, so
// the test borrows the runner's copy rather than adding a dependency the library
// does not need.
const requireFrom = createRequire(import.meta.url);
const { parse: parseYaml } = requireFrom(
  requireFrom.resolve('yaml', { paths: [join(REPO_ROOT, 'packages', 'runner')] }),
) as { parse: (src: string) => unknown };

/* -------------------------------------------------------------------------- */
/* (a) the existing bank                                                      */
/* -------------------------------------------------------------------------- */

describe('the v1/v2 bank survives the v3 contract', () => {
  const files = readdirSync(QUESTIONS_DIR)
    .filter((f) => f.endsWith('.yaml'))
    .sort();

  it('has question files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  const parsed = files.map((file) => {
    const result = questionFileSchema.safeParse(
      parseYaml(readFileSync(join(QUESTIONS_DIR, file), 'utf8')),
    );
    return { file, result };
  });

  for (const { file, result } of parsed) {
    it(`parses ${file}`, () => {
      expect(result.success ? null : result.error.message).toBeNull();
    });
  }

  const items = parsed.flatMap(({ result }) => (result.success ? result.data : []));

  it('still holds all 184 legacy items', () => {
    // Counted by vintage, not by total: another workstream may be adding v3
    // items to this directory while this runs, and the invariant under test is
    // that none of the existing 184 broke, not that the bank stopped growing.
    const legacy = items.filter((q) => q.addedIn === 'v1' || q.addedIn === 'v2');
    expect(legacy.length).toBe(184);
  });

  it('never reinterprets a legacy rubric criterion as an atomic one', () => {
    // Deliberately NOT pinned to an absolute count. The first version asserted
    // exactly 97, which is how many existed the day it was written — and it
    // broke within the hour, when the grader audit converted a defective
    // keyword item to llm-judge and legitimately took the bank to 100. The
    // invariant that actually matters is that no legacy `{name, description,
    // weight}` criterion is silently absorbed into the new atomic shape on the
    // way in; the population size is the dataset's business, not this test's.
    const criteria = items
      .filter((q) => q.grader.type === 'llm-judge')
      .flatMap((q) => (q.grader.type === 'llm-judge' ? (q.grader.rubric ?? []) : []));
    const legacy = criteria.filter((c) => !('kind' in c) || c.kind === undefined);
    expect(legacy.length).toBeGreaterThan(90);
    expect(criteria.length).toBe(legacy.length);
    for (const c of legacy) {
      expect(typeof (c as { name?: unknown }).name).toBe('string');
      expect(typeof (c as { description?: unknown }).description).toBe('string');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const anchorSet = {
  dimension: 'diagnostic ranking',
  definition: 'Whether the causes are ranked and separated by a test.',
  bands: [
    { band: 0, descriptor: 'Names no cause, or names one the stated observations rule out.' },
    { band: 1, descriptor: 'Names one plausible cause and proposes no test that would confirm it.' },
    { band: 2, descriptor: 'Names two causes and ranks them, but omits the test that separates them.' },
    { band: 3, descriptor: 'Ranks the causes and specifies one test, ignoring the holding window.' },
    {
      band: 4,
      descriptor:
        'Ranks three causes, cites the observation supporting each, and specifies the test that separates the top two.',
    },
  ],
};

const judgePack = {
  capabilityUnderTest: 'Diagnosing a split emulsion from stated observations',
  hardConstraints: ['no added dairy', 'ready within 20 minutes'],
  criteria: [
    {
      id: 'c1',
      kind: 'include' as const,
      statement: 'Names temperature shock as the leading cause',
      weight: 3,
      dimension: 'diagnostic ranking',
    },
    { id: 'c2', kind: 'critical' as const, statement: 'Does not advise reheating above 85 °C', weight: 5 },
    { id: 'c3', kind: 'avoid' as const, statement: 'Does not add cream to hide the split', weight: 2 },
    { id: 'c4', kind: 'exceptional' as const, statement: 'Gives a stopping rule for the rescue', weight: 1 },
  ],
  intendedOutcome: { practical: 'A rescued sauce that holds through service.' },
  sources: [{ citation: 'McGee, On Food and Cooking, 2nd ed.', confidence: 'high' as const }],
  solutionFamilies: [
    { id: 'rebuild', summary: 'Rebuild on a fresh yolk', whyAcceptable: 'Recovers the emulsion without dilution.' },
    { id: 'stabilise', summary: 'Stabilise with mustard and cold water', whyAcceptable: 'Faster, and keeps the seasoning.' },
  ],
  commonFailureModes: [
    { label: 'more-heat', description: 'Advises more heat, which finishes the split.', domain: 'reasoning' as const },
  ],
  workedExamples: [
    { kind: 'exceptional' as const, answer: 'Rebuild on a yolk…', whyItLandsHere: 'Ranks causes and gives a stopping rule.' },
    { kind: 'competent-ordinary' as const, answer: 'Whisk in cold water…', whyItLandsHere: 'Works, no stopping rule.' },
    { kind: 'plausible-but-wrong' as const, answer: 'Warm it gently to bring it back…', whyItLandsHere: 'Reads well, finishes the split.' },
    { kind: 'clearly-failing' as const, answer: 'Add flour.', whyItLandsHere: 'Neither diagnoses nor rescues.' },
  ],
};

const interactiveScript = {
  scriptVersion: 'ik-1',
  ambiguity: { kind: 'safety' as const, genuine: true, whatIsUnderspecified: 'How long the sauce sat out.' },
  clarificationBudget: 1,
  acceptableFirstMoves: ['clarification' as const, 'safe-fallback' as const],
  clarificationResponses: [
    { topic: 'holding time', matches: ['how long', 'left out'], reply: 'It has been out of the fridge for three hours.' },
  ],
  defaultClarificationReply: 'That detail is not available; proceed on what you have.',
  secondTurn: { kind: 'observation' as const, text: 'The sauce now smells faintly sour.' },
  trajectoryInvariants: ['The sauce is never returned to service after three hours ambient.'],
  expectedFinalState: 'Sauce discarded, replacement started, service time restated.',
};

const kitchenPlan = {
  title: 'Braised shin with mash',
  servings: 4,
  locale: 'en-GB',
  serviceAtMinute: 210,
  serviceClock: '19:30',
  ingredients: [
    { id: 'shin', name: 'Beef shin', quantity: { amount: 1.2, unit: 'kg' }, allergens: [], startingState: 'raw, whole' },
    { id: 'butter', name: 'Butter', quantity: { amount: 60, unit: 'g' }, allergens: ['milk'], startingState: 'chilled' },
  ],
  equipment: [{ id: 'oven', name: 'Domestic oven', countAvailable: 1, capacity: '4 shelves' }],
  operations: [
    {
      id: 'sear',
      action: 'sear',
      inputs: ['shin'],
      outputs: [{ id: 'seared-shin', name: 'Seared shin', state: 'browned' }],
      equipment: ['oven'],
      duration: { minMinutes: 8, maxMinutes: 12 },
      temperature: { value: 220, unit: 'C' as const, kind: 'surface' as const },
      sensoryTarget: 'Deep brown crust, nutty smell',
      attention: 'active' as const,
    },
  ],
  dependencies: [{ from: 'sear', to: 'sear', kind: 'finish-to-start' as const }],
  stateTransitions: [{ subjectId: 'shin', from: 'raw, whole', to: 'browned', byOperation: 'sear' }],
  safetyCheckpoints: [
    {
      id: 'core-temp',
      afterOperation: 'sear',
      check: 'Core temperature before holding',
      threshold: { value: 75, unit: 'C', comparator: 'at-least' as const },
      source: 'judge-pack' as const,
    },
  ],
  trajectoryInvariants: [
    { id: 'danger-zone', statement: 'No component sits between 5 and 60 °C for over two hours.', source: 'prompt' as const },
  ],
  holdingLimits: [{ componentId: 'seared-shin', maxHoldMinutes: 90, condition: 'hot-held at or above 63 °C', source: 'prompt' as const }],
  serviceState: {
    atMinute: 210,
    components: [{ componentId: 'seared-shin', state: 'rested, sliced' }],
  },
};

const v3Item = {
  id: 'plan-001',
  category: 'technique',
  difficulty: 4,
  prompt: 'The sauce split ten minutes before service. Diagnose and rescue it.',
  referenceAnswer: 'Rebuild the emulsion on a fresh yolk.',
  public: true,
  grader: {
    type: 'llm-judge',
    judgeMode: 'dimension',
    rubric: judgePack.criteria,
  },
  anchors: [anchorSet],
  judgePack,
  outputContract: { format: 'kitchen-plan', requiredSections: ['diagnosis', 'rescue'] },
  kitchenPlanContract: { requiredObjects: ['operations', 'holdingLimits'], validatorVersion: 'kp-0.1' },
  interactiveScript,
  classification: {
    primaryCapability: 'diagnosis-recovery',
    secondaryCapabilities: ['execution-service'],
    evidenceLayer: 'interactive-kitchen',
    taskFamily: 'diagnosis-and-recovery',
    scenarioFamily: 'split-emulsion-at-service',
    stratumHypothesis: { stratum: 'chef-frontier', rationale: 'Needs a ranked diagnosis under time pressure.' },
    shortcutBlocked: 'Reciting "add an emulsifier" without diagnosing the cause.',
    failureTaxonomy: [{ domain: 'safety', label: 'reheat-above-safe-temperature' }],
  },
  provenance: {
    itemVersion: '1.0.0',
    authoringChain: [{ stage: 'human-seed', actor: 'J. Pitts' }],
    author: 'J. Pitts',
    modelExposures: [{ modelId: 'anthropic/claude-opus-5', purpose: 'adversarial-probe' }],
    independentSolves: [{ solverKind: 'human-specialist', solverId: 'chef-04', blind: true, outcome: 'solved' }],
    verificationState: 'certified',
    safetyReview: { required: true, status: 'passed', reviewer: 'EHO-trained reviewer' },
    currentKitchen: { asOf: '2026-07-01', jurisdiction: 'UK', nextReview: '2027-07-01' },
  },
  exposure: { state: 'chefs-table', hashCommitment: 'sha256:abc' },
  adversarialCases: [
    { kind: 'keyword-stuffing', answer: 'emulsion yolk mustard split', expect: 'at-most', score: 40 },
    { kind: 'correct-concise', answer: 'Rebuild on a fresh yolk, off the heat.', expect: 'at-least', score: 80 },
  ],
  evidencePack: { sharedWithCandidate: true, materials: [{ label: 'Service notes', content: 'Sauce made at 17:40.' }] },
  validatorVersion: 'det-0.4',
};

/* -------------------------------------------------------------------------- */
/* (b) round trips                                                            */
/* -------------------------------------------------------------------------- */

describe('the v3 blocks round-trip', () => {
  it('parses an item carrying every new block', () => {
    const parsed = questionSchema.safeParse(v3Item);
    expect(parsed.success ? null : parsed.error.message).toBeNull();
  });

  it('preserves every block unchanged', () => {
    const parsed = questionSchema.parse(v3Item);
    expect(parsed.anchors).toEqual(v3Item.anchors);
    expect(parsed.judgePack).toEqual(v3Item.judgePack);
    expect(parsed.interactiveScript).toEqual(v3Item.interactiveScript);
    expect(parsed.outputContract).toEqual(v3Item.outputContract);
    expect(parsed.kitchenPlanContract).toEqual(v3Item.kitchenPlanContract);
    expect(parsed.provenance).toEqual(v3Item.provenance);
    expect(parsed.exposure).toEqual(v3Item.exposure);
    expect(parsed.adversarialCases).toEqual(v3Item.adversarialCases);
    expect(parsed.evidencePack).toEqual(v3Item.evidencePack);
    // The one field with a default: an uncertified stratum hypothesis must come
    // back as uncertified rather than as nothing.
    expect(parsed.classification?.stratumHypothesis.certified).toBe(false);
    expect(parsed.grader.type === 'llm-judge' && parsed.grader.judgeMode).toBe('dimension');
  });

  it('round-trips a KitchenPlan through JSON without losing a field', () => {
    const parsed = kitchenPlanSchema.parse(kitchenPlan);
    expect(parsed).toEqual(kitchenPlan);
    expect(kitchenPlanSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(kitchenPlan);
  });

  it('round-trips a sensory dossier with all seven balance strategies', () => {
    const dossier = {
      dishIdentity: 'Charred hispi with anchovy butter',
      intendedDinerExperience: 'Smoke first, then salt, then sweetness.',
      firstAroma: 'Scorched brassica',
      aromaticProgression: 'Smoke into browned butter into lemon zest',
      dominantFlavours: ['char', 'anchovy'],
      supportingFlavours: ['brown butter'],
      finishingFlavours: ['lemon'],
      balance: {
        salt: 'Anchovy carries it; no added salt at the pass.',
        acid: 'Lemon squeezed at service.',
        sweetness: 'From the cabbage itself.',
        bitterness: 'Char, kept under control by resting.',
        savouriness: 'Anchovy and browned butter solids.',
        fat: 'Butter, spooned not poured.',
        heat: 'None.',
      },
      textureContrast: 'Crisp outer leaves against a soft heart.',
      temperatureContrast: 'Hot cabbage, cold butter finish.',
      progression: 'Smoke, salt, then a clean acidic finish.',
      likelySensoryFailure: { failure: 'Acrid char', correction: 'Shorter contact, higher heat.' },
      deliberateOmissions: ['chilli', 'garlic'],
    };
    expect(sensoryDossierSchema.parse(dossier)).toEqual(dossier);
  });

  it('leaves a legacy item untouched — no v3 keys invented on the way through', () => {
    const legacy = {
      id: 'conv-007',
      category: 'conversions',
      prompt: 'Convert 350 °F to Celsius.',
      difficulty: 1,
      referenceAnswer: '177 °C',
      public: true,
      grader: { type: 'numeric', expected: 177, unit: 'C', tolerancePct: 2 },
    };
    const parsed = questionSchema.parse(legacy);
    expect(parsed.anchors).toBeUndefined();
    expect(parsed.judgePack).toBeUndefined();
    expect(parsed.classification).toBeUndefined();
    expect(parsed.status).toBe('active');
  });
});

/* -------------------------------------------------------------------------- */
/* (c) the anchor observability rule                                          */
/* -------------------------------------------------------------------------- */

describe('behavioural anchors must describe observable behaviour', () => {
  const withBands = (descriptors: string[]) => ({
    dimension: 'flavour reasoning',
    bands: descriptors.map((descriptor, band) => ({ band, descriptor })),
  });

  it('accepts the worked anchor set', () => {
    expect(behaviouralAnchorIssues(anchorSet)).toEqual([]);
    expect(behaviouralAnchorSetSchema.safeParse(anchorSet).success).toBe(true);
  });

  it('rejects M2.3’s named adjectives standing alone', () => {
    for (const bare of [
      'Excellent, creative and authentic throughout.',
      'An outstanding and sophisticated piece of work.',
      'Good answer, well judged, appropriate for the brief.',
    ]) {
      const verdict = anchorBandObservability(bare);
      expect(verdict.observable, bare).toBe(false);
    }
  });

  it('rejects an evaluative band that smuggles in a verb', () => {
    // "Provides" is a behaviour verb, so rule one passes and rule two must be
    // the thing that catches this. If the content-word rule is ever removed,
    // this is the test that notices.
    const verdict = anchorBandObservability(
      'Provides an excellent, creative and authentic answer overall.',
    );
    expect(verdict.observable).toBe(false);
    expect(verdict.reason).toBe('evaluative-only');
  });

  it('rejects a band with no verb at all', () => {
    const verdict = anchorBandObservability('The acid, the fat and the crunch.');
    expect(verdict.observable).toBe(false);
    expect(verdict.reason).toBe('no-observable-behaviour');
  });

  it('rejects a band too short to describe anything', () => {
    expect(anchorBandObservability('Names the acid.').reason).toBe('too-short');
  });

  it('fails closed on a missing, blank or non-string descriptor', () => {
    for (const junk of [undefined, null, '', '   ', 42, {}]) {
      expect(anchorBandObservability(junk).observable, String(junk)).toBe(false);
    }
    expect(behaviouralAnchorIssues(undefined)[0]?.reason).toBe('not-a-set');
    expect(behaviouralAnchorIssues({ dimension: 'x' })[0]?.reason).toBe('not-a-set');
  });

  it('accepts a band that uses an evaluative word with an operational clause', () => {
    const verdict = anchorBandObservability(
      'Creative in the sense that it names one addition and predicts the texture it changes.',
    );
    expect(verdict.observable).toBe(true);
  });

  it('accepts a quantified band with no lexicon verb, and rejects the same band unquantified', () => {
    // A quantified claim is observable by construction, which is the only
    // reason the first of these passes: neither sentence contains a verb from
    // the lexicon.
    expect(
      anchorBandObservability('Fewer than 2 of the 4 hard limits appear anywhere in the plan.')
        .observable,
    ).toBe(true);
    expect(
      anchorBandObservability('Fewer than two of the four hard limits appear anywhere in the plan.')
        .reason,
    ).toBe('no-observable-behaviour');
  });

  it('refuses an anchor set whose bands are non-observable', () => {
    const bad = withBands([
      'Excellent, creative and authentic throughout.',
      'Names one plausible cause and proposes no test that would confirm it.',
      'Names two causes and ranks them, but omits the test that separates them.',
      'Ranks the causes and specifies one test, ignoring the holding window.',
      'Ranks three causes, cites the observation supporting each, and specifies the separating test.',
    ]);
    const result = behaviouralAnchorSetSchema.safeParse(bad);
    expect(result.success).toBe(false);
    expect(behaviouralAnchorIssues(bad).map((i) => i.reason)).toContain('no-observable-behaviour');
  });

  it('refuses two bands sharing a descriptor', () => {
    const repeated = 'Names two causes and ranks them, but omits the test that separates them.';
    const bad = withBands([
      'Names no cause, or names one the stated observations rule out.',
      'Names one plausible cause and proposes no test that would confirm it.',
      repeated,
      repeated,
      'Ranks three causes, cites the observation supporting each, and specifies the separating test.',
    ]);
    expect(behaviouralAnchorIssues(bad).map((i) => i.reason)).toContain('duplicate-band-text');
    expect(behaviouralAnchorSetSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses a set that skips a band or numbers one outside 0–4', () => {
    const skipped = {
      dimension: 'flavour reasoning',
      bands: [0, 1, 2, 3, 5].map((band) => ({
        band,
        descriptor: `Names ${band} causes and specifies the test that separates them.`,
      })),
    };
    expect(behaviouralAnchorSetSchema.safeParse(skipped).success).toBe(false);
    const fourBands = {
      dimension: 'flavour reasoning',
      bands: anchorSet.bands.slice(0, 4),
    };
    expect(behaviouralAnchorSetSchema.safeParse(fourBands).success).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* attempts to break the rest of the contract                                 */
/* -------------------------------------------------------------------------- */

describe('rubric criteria', () => {
  it('keeps the legacy sum-to-1 rule for legacy declarations', () => {
    expect(
      rubricSchema.safeParse([
        { name: 'A', description: 'd', weight: 0.5 },
        { name: 'B', description: 'd', weight: 0.4 },
      ]).success,
    ).toBe(false);
  });

  it('does not impose sum-to-1 on atomic weights', () => {
    expect(
      rubricSchema.safeParse([
        { kind: 'include', statement: 'names the acid', weight: 3 },
        { kind: 'critical', statement: 'no raw flour', weight: 5 },
      ]).success,
    ).toBe(true);
  });

  it('refuses a mixture of the two shapes', () => {
    expect(
      rubricSchema.safeParse([
        { name: 'A', description: 'd', weight: 1 },
        { kind: 'include', statement: 'names the acid', weight: 3 },
      ]).success,
    ).toBe(false);
  });

  it('refuses a mistyped kind rather than silently grading it as legacy', () => {
    // The failure this guards: z.object strips undeclared keys, so without the
    // explicit `kind: undefined` on the legacy branch this object would lose its
    // kind and be graded as a v1 rubric line.
    const result = rubricSchema.safeParse([
      { kind: 'includ', name: 'A', description: 'd', weight: 1 },
    ]);
    expect(result.success).toBe(false);
  });

  it('renders an attention hint from either shape', () => {
    expect(criterionAttentionHint({ name: 'Balance', description: ' logic ', weight: 1 })).toBe(
      'Balance: logic',
    );
    expect(
      criterionAttentionHint({ kind: 'critical', statement: ' no raw flour ', weight: 5 }),
    ).toBe('critical: no raw flour');
  });

  it('refuses duplicate atomic criterion ids', () => {
    expect(
      rubricSchema.safeParse([
        { id: 'c1', kind: 'include', statement: 'names the acid', weight: 1 },
        { id: 'c1', kind: 'avoid', statement: 'adds cream', weight: 1 },
      ]).success,
    ).toBe(false);
  });
});

describe('judge packs', () => {
  it('refuses a pack missing the plausible-but-wrong example', () => {
    const pack = {
      ...judgePack,
      workedExamples: judgePack.workedExamples.filter((e) => e.kind !== 'plausible-but-wrong'),
    };
    const result = judgePackSchema.safeParse(pack);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result)).toContain('plausible-but-wrong');
  });

  it('refuses a single solution family unless it is justified', () => {
    const one = { ...judgePack, solutionFamilies: [judgePack.solutionFamilies[0]] };
    expect(judgePackSchema.safeParse(one).success).toBe(false);
    expect(
      judgePackSchema.safeParse({ ...one, singleFamilyJustification: 'Only one safe route exists.' })
        .success,
    ).toBe(true);
  });

  it('refuses a rejecting validator fixture that does not name the finding', () => {
    const pack = {
      ...judgePack,
      validatorFixtures: [{ kind: 'cycle' as const, planRef: 'fixtures/cycle.yaml', expect: 'reject' as const }],
    };
    expect(judgePackSchema.safeParse(pack).success).toBe(false);
  });

  it('refuses a fixture that supplies both an inline plan and a reference', () => {
    const pack = {
      ...judgePack,
      validatorFixtures: [
        {
          kind: 'valid-alternative' as const,
          plan: kitchenPlan,
          planRef: 'fixtures/alt.yaml',
          expect: 'accept' as const,
        },
      ],
    };
    expect(judgePackSchema.safeParse(pack).success).toBe(false);
  });

  it('requires hard constraints to be stated, even as an empty list', () => {
    const { hardConstraints, ...withoutConstraints } = judgePack;
    expect(judgePackSchema.safeParse(withoutConstraints).success).toBe(false);
    expect(judgePackSchema.safeParse({ ...judgePack, hardConstraints: [] }).success).toBe(true);
  });

  it('refuses an intended outcome that names none of the three kinds', () => {
    expect(judgePackSchema.safeParse({ ...judgePack, intendedOutcome: {} }).success).toBe(false);
  });
});

describe('item-level cross-field rules', () => {
  it('refuses dimension mode without anchors', () => {
    const { anchors, ...withoutAnchors } = v3Item;
    // Asserted on the message, not merely on failure: dropping the anchors also
    // orphans a criterion's `dimension`, so a bare `success === false` would
    // pass even if the anchor rule were deleted.
    const result = questionSchema.safeParse({
      ...withoutAnchors,
      grader: { ...withoutAnchors.grader, rubric: [{ kind: 'include', statement: 'x', weight: 1 }] },
    });
    expect(result.success).toBe(false);
    expect(result.success ? '' : result.error.message).toContain('requires behavioural anchors');
  });

  it('refuses a criterion pointing at a dimension the item does not anchor', () => {
    const item = {
      ...v3Item,
      grader: {
        ...v3Item.grader,
        rubric: [{ kind: 'include', statement: 'names the acid', weight: 1, dimension: 'sensory logic' }],
      },
    };
    expect(questionSchema.safeParse(item).success).toBe(false);
  });

  it('refuses a KitchenPlan output contract with no validator contract', () => {
    const { kitchenPlanContract, ...withoutContract } = v3Item;
    expect(questionSchema.safeParse(withoutContract).success).toBe(false);
  });

  it('refuses two anchor sets for the same dimension', () => {
    const item = { ...v3Item, anchors: [anchorSet, { ...anchorSet, dimension: 'Diagnostic Ranking ' }] };
    expect(questionSchema.safeParse(item).success).toBe(false);
  });

  it('refuses a Current Kitchen block missing its jurisdiction or review date', () => {
    const item = {
      ...v3Item,
      provenance: { ...v3Item.provenance, currentKitchen: { asOf: '2026-07-01' } },
    };
    expect(questionSchema.safeParse(item).success).toBe(false);
  });

  it('refuses a required review recorded as not-required', () => {
    expect(reviewFlagSchema.safeParse({ required: true, status: 'not-required' }).success).toBe(false);
    expect(reviewFlagSchema.safeParse({ required: true, status: 'pending' }).success).toBe(true);
  });

  it('refuses a correct-answer fixture asserting a ceiling instead of a floor', () => {
    const item = {
      ...v3Item,
      adversarialCases: [{ kind: 'correct-concise', answer: 'Rebuild on a yolk.', expect: 'at-most', score: 90 }],
    };
    expect(questionSchema.safeParse(item).success).toBe(false);
  });
});

describe('KitchenPlan structure', () => {
  it('refuses an ingredient with no allergen list at all', () => {
    const plan = {
      ...kitchenPlan,
      ingredients: [{ id: 'x', name: 'Butter', startingState: 'chilled' }],
    };
    expect(kitchenPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('refuses a duration whose maximum is below its minimum', () => {
    const plan = {
      ...kitchenPlan,
      operations: [{ ...kitchenPlan.operations[0], duration: { minMinutes: 12, maxMinutes: 8 } }],
    };
    expect(kitchenPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('refuses a safety checkpoint with no declared limit source', () => {
    const plan = {
      ...kitchenPlan,
      safetyCheckpoints: [{ id: 's', afterOperation: 'sear', check: 'core temp' }],
    };
    expect(kitchenPlanSchema.safeParse(plan).success).toBe(false);
  });

  it('accepts a plan whose limits are candidate assumptions, so the validator can refuse them', () => {
    // M1.2 forbids a candidate validating its own plan on invented assumptions.
    // The schema's job is to make the assumption visible, not to hide it — the
    // refusal belongs to the validator, which cannot refuse what will not parse.
    const plan = {
      ...kitchenPlan,
      holdingLimits: [{ ...kitchenPlan.holdingLimits[0], source: 'candidate-assumption' as const }],
    };
    const parsed = kitchenPlanSchema.safeParse(plan);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.holdingLimits[0]?.source).toBe('candidate-assumption');
  });

  it('accepts a structurally well-formed plan containing a dependency cycle', () => {
    // Fixtures for cycles, invalid transitions and resource conflicts must be
    // authorable, or the validator ships untested against them.
    const plan = {
      ...kitchenPlan,
      dependencies: [
        { from: 'a', to: 'b', kind: 'finish-to-start' as const },
        { from: 'b', to: 'a', kind: 'finish-to-start' as const },
      ],
    };
    expect(kitchenPlanSchema.safeParse(plan).success).toBe(true);
  });
});

describe('the interactive script stays deterministic', () => {
  it('refuses a script that permits clarification with no fixed fallback reply', () => {
    const { defaultClarificationReply, ...script } = interactiveScript;
    expect(interactiveScriptSchema.safeParse(script).success).toBe(false);
  });

  it('refuses clarification as a first move when the budget is zero', () => {
    const script = { ...interactiveScript, clarificationBudget: 0 };
    expect(interactiveScriptSchema.safeParse(script).success).toBe(false);
  });

  it('accepts the clear half of a paired item, where no clarification is due', () => {
    const script = {
      ...interactiveScript,
      ambiguity: { kind: 'none' as const, genuine: false },
      clarificationBudget: 0,
      acceptableFirstMoves: ['action' as const],
      defaultClarificationReply: undefined,
      clarificationResponses: undefined,
      pairedCounterpartId: 'plan-001',
    };
    expect(interactiveScriptSchema.safeParse(script).success).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* constructs                                                                 */
/* -------------------------------------------------------------------------- */

describe('Craft axes and their unapproved weights', () => {
  it('proposes weights that sum to 1', () => {
    const sum = CRAFT_AXIS_IDS.reduce((s, id) => s + PROPOSED_CRAFT_AXES[id].proposedWeight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it('refuses to resolve weights without an approval record', () => {
    expect(() => resolveCraftWeights(undefined)).toThrow(/unapproved proposal/);
    expect(craftWeightApprovalIssues(null)).toHaveLength(1);
  });

  const approval: CraftWeightApproval = {
    approvedAt: '2026-08-01',
    approvers: [
      { name: 'A. Chef', role: 'culinary' },
      { name: 'B. Statistician', role: 'measurement' },
    ],
    weights: { ...proposedCraftWeights('documentation-only') },
    rationale: 'docs/methodology/weights.md',
    resultsSeen: false,
  };

  it('accepts a complete approval', () => {
    expect(craftWeightApprovalIssues(approval)).toEqual([]);
    expect(resolveCraftWeights(approval)['flavour-sensory']).toBeCloseTo(0.2, 10);
  });

  it('refuses an approval taken after results were seen', () => {
    expect(craftWeightApprovalIssues({ ...approval, resultsSeen: true })).toContain(
      'weights must be approved before results are seen (resultsSeen must be false)',
    );
    // An omitted flag is a refusal too — silence is not a statement.
    const { resultsSeen, ...silent } = approval;
    expect(craftWeightApprovalIssues(silent as CraftWeightApproval).length).toBeGreaterThan(0);
  });

  it('refuses an approval without both a culinary and a measurement reviewer', () => {
    const culinaryOnly = { ...approval, approvers: [{ name: 'A. Chef', role: 'culinary' as const }] };
    expect(craftWeightApprovalIssues(culinaryOnly)).toContain(
      'no measurement reviewer approved these weights',
    );
  });

  it('refuses weights that do not sum to 1, or name an axis that does not exist', () => {
    const skewed = {
      ...approval,
      weights: { ...approval.weights, 'flavour-sensory': 0.5 },
    };
    expect(craftWeightApprovalIssues(skewed).some((i) => i.startsWith('weights sum to'))).toBe(true);
    const invented = { ...approval, weights: { ...approval.weights, plating: 0.1 } };
    expect(craftWeightApprovalIssues(invented)).toContain(
      'weights given for unknown axes: plating',
    );
  });

  it('reports no M1.6 exclusion where the plan states none', () => {
    // Two axes carry no bullet. An empty list is the honest answer; a plausible
    // invented statement would read as approved text.
    expect(exclusionsFor('diagnosis-recovery')).toEqual([]);
    expect(exclusionsFor('execution-service')).toEqual([]);
    expect(exclusionsFor('technical-reasoning')[0]?.statement).toContain('chemistry vocabulary');
  });

  it('keeps Palate and Public Taste out of the weighted Craft score', () => {
    expect(EVIDENCE_MODE_MAP.palate.weightable).toBe(false);
    expect(EVIDENCE_MODE_MAP.palate.aggregation).toBe('not-added-again');
    expect(EVIDENCE_MODE_MAP['public-taste'].aggregation).toBe('never-overrides');
    expect(EVIDENCE_MODE_MAP['fundamentals-gate'].contributesTo).toEqual([]);
  });
});
