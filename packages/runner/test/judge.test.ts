import { describe, expect, it } from 'vitest';
import {
  baseModelIdSchema,
  hasJudgeConflict,
  modelEntrySchema,
  modelsFileSchema,
  UNKNOWN_BASE_MODEL,
  type Question,
} from '@cookingbench/core';
import { loadModels, loadQuestions } from '../src/dataset.js';
import {
  anonymizeAnswer,
  blindingLexicon,
  buildDimensionJudgeMessages,
  buildJudgeMessages,
  buildPairwiseJudgeMessages,
  identityIndex,
  identityLeaks,
  judgeAnswerPanel,
  judgeModeOf,
  panelSeats,
  parseDimensionBallot,
  parseJudgeResponse,
  parsePairwiseBallot,
} from '../src/judge.js';

const question: Question = {
  id: 'tech-001',
  category: 'technique',
  difficulty: 3,
  status: 'active',
  addedIn: 'v1',
  trap: false,
  prompt: 'My hollandaise split. What went wrong and how do I rescue it?',
  grader: {
    type: 'llm-judge',
    rubric: [
      { name: 'Diagnosis', description: 'Names heat/speed causes', weight: 0.5 },
      { name: 'Rescue', description: 'Workable rescue method', weight: 0.5 },
    ],
  },
  judgingNotes: 'The rescue must not re-break the sauce.',
  referenceAnswer: 'Fresh yolk + warm water, whisk the broken sauce in drop by drop.',
  public: true,
};

/**
 * v3 fixtures are typed literals rather than schema-parsed items on purpose.
 * These tests are about what the judge does with an item, not about whether the
 * item parses — that is packages/core's test — and coupling them to a zod
 * refinement means a schema edit breaks tests that never touched the schema.
 */
const dimensionQuestion: Question = {
  id: 'tech-201',
  category: 'technique',
  difficulty: 4,
  status: 'active',
  addedIn: 'v3',
  trap: false,
  prompt: 'A four-hour beef shin braise tastes flat at the end. Diagnose it and fix it.',
  grader: {
    type: 'llm-judge',
    judgeMode: 'dimension',
    rubric: [
      {
        id: 'c-acid',
        kind: 'include',
        statement: 'Checks salt and acid before reaching for sugar or stock cubes',
        weight: 2,
        dimension: 'diagnostic ranking',
      },
      {
        id: 'c-raw-flour',
        kind: 'critical',
        statement: 'Does not stir raw flour into a finished braise',
        weight: 5,
      },
    ],
  },
  judgingNotes: 'Reducing the sauce is a legitimate alternative route.',
  referenceAnswer: 'Season, add a splash of vinegar, reduce the sauce, finish with butter.',
  anchors: [
    {
      dimension: 'diagnostic ranking',
      definition: 'The order in which the answer tests candidate causes.',
      bands: [
        { band: 0, descriptor: 'Names no cause and adds more stock immediately' },
        { band: 1, descriptor: 'Names one cause and does not test it before acting' },
        { band: 2, descriptor: 'Names two causes and tests them in an arbitrary order' },
        { band: 3, descriptor: 'Tests salt first, then acid, then reduction, and says why' },
        { band: 4, descriptor: 'Ranks four causes by likelihood and states what each test rules out' },
      ],
    },
  ],
  public: true,
};

const pairwiseQuestion: Question = {
  ...dimensionQuestion,
  id: 'tech-202',
  anchors: undefined,
  grader: {
    type: 'llm-judge',
    judgeMode: 'pairwise',
    rubric: [
      {
        id: 'c-acid',
        kind: 'include',
        statement: 'Checks salt and acid before reaching for sugar',
        weight: 2,
      },
      {
        id: 'c-raw-flour',
        kind: 'critical',
        statement: 'Does not stir raw flour into a finished braise',
        weight: 5,
      },
    ],
  },
};

describe('judge-v2 deduction parsing', () => {
  it('zero findings = 100', () => {
    const v = parseJudgeResponse(question, '{"findings": [], "summary": "Matches the reference."}');
    expect(v.score).toBe(100);
    expect(v.findings).toEqual([]);
  });

  it('maps severities to deductions in code (critical 40, major 15, minor 5)', () => {
    const v = parseJudgeResponse(
      question,
      JSON.stringify({
        findings: [
          { quote: 'high heat', issue: 'would re-break the emulsion', severity: 'critical' },
          { quote: 'omission', issue: 'no diagnosis of cause', severity: 'major' },
          { quote: 'a splash', issue: 'vague quantity', severity: 'minor' },
        ],
        summary: 'Bad rescue.',
      }),
    );
    expect(v.score).toBe(100 - 40 - 15 - 5);
  });

  it('floors the score at 0', () => {
    const findings = Array.from({ length: 4 }, () => ({
      quote: 'x',
      issue: 'y',
      severity: 'critical',
    }));
    const v = parseJudgeResponse(question, JSON.stringify({ findings, summary: '' }));
    expect(v.score).toBe(0);
  });

  it('rejects invalid severities', () => {
    expect(() =>
      parseJudgeResponse(
        question,
        '{"findings": [{"quote": "x", "issue": "y", "severity": "catastrophic"}]}',
      ),
    ).toThrow(/invalid severity/);
  });

  it('rejects JSON without findings[]', () => {
    expect(() => parseJudgeResponse(question, '{"scores": {"Diagnosis": 5}}')).toThrow(
      /missing findings/,
    );
  });

  it('extracts JSON wrapped in prose', () => {
    const v = parseJudgeResponse(
      question,
      'Here is my verdict:\n{"findings": [{"quote": "omission", "issue": "no rescue given", "severity": "major"}], "summary": "ok"}\nDone.',
    );
    expect(v.score).toBe(85);
  });
});

describe('judge-v2 prompt assembly', () => {
  it('prefers judgingNotes as attention hints', () => {
    const messages = buildJudgeMessages(question, 'Whisk in warm water.');
    const user = messages[1]!.content;
    expect(user).toContain('PAY PARTICULAR ATTENTION TO');
    expect(user).toContain('must not re-break');
  });

  it('falls back to rubric descriptions when judgingNotes is absent', () => {
    const noNotes = { ...question, judgingNotes: undefined };
    const user = buildJudgeMessages(noNotes, 'Whisk.')[1]!.content;
    expect(user).toContain('Diagnosis: Names heat/speed causes');
  });

  it('anonymizes model self-identification', () => {
    expect(anonymizeAnswer('As ChatGPT, I suggest whisking.')).not.toMatch(/chatgpt/i);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.1 — mode routing                                                        */
/* -------------------------------------------------------------------------- */

describe('grading mode routing', () => {
  it('treats an absent judgeMode as the legacy fault route, never as "any mode"', () => {
    expect(judgeModeOf(question)).toBe('fault');
    expect(judgeModeOf(dimensionQuestion)).toBe('dimension');
    expect(judgeModeOf(pairwiseQuestion)).toBe('pairwise');
  });

  it('refuses to grade a non-judge item at all', () => {
    const numeric = { ...question, grader: { type: 'numeric' as const, expected: 180 } };
    expect(() => judgeModeOf(numeric)).toThrow(/not judge-graded/);
  });

  it('refuses to run a v3 item down the v2 deduction route', () => {
    // The silent downgrade is the failure class: a dimension item quietly graded
    // by two seats and a mean would be published as if it had been anchored.
    expect(() => buildJudgeMessages(dimensionQuestion, 'Add salt.')).toThrow(/cannot grade it/);
    expect(() => parseJudgeResponse(pairwiseQuestion, '{"findings":[]}')).toThrow(/cannot grade it/);
  });

  it('refuses a v3 item at the panel entry point before spending anything', async () => {
    const client = {
      complete: async () => {
        throw new Error('must not be called');
      },
    };
    await expect(
      judgeAnswerPanel(
        client as never,
        ['a/one', 'b/two'],
        'c/three',
        dimensionQuestion,
        'answer',
        // Three fully identified, mutually conflict-free models, so the refusal
        // this asserts is the MODE check and not seating quietly failing closed
        // first — which is what happens if these rows carry only a tier.
        identityIndex([
          { id: 'a/one', provider: 'A', family: 'fa', baseModel: 'a:one' },
          { id: 'b/two', provider: 'B', family: 'fb', baseModel: 'b:two' },
          { id: 'c/three', provider: 'C', family: 'fc', baseModel: 'c:three' },
        ]),
      ),
    ).rejects.toThrow(/cannot grade it/);
  });

  it('refuses to build the wrong prompt for a declared mode', () => {
    expect(() => buildDimensionJudgeMessages(pairwiseQuestion, 'x')).toThrow(/does not declare/);
    expect(() => buildPairwiseJudgeMessages(dimensionQuestion, 'x', 'y')).toThrow(/does not declare/);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.1 + M2.3 — dimension mode                                               */
/* -------------------------------------------------------------------------- */

describe('dimension-mode prompts', () => {
  it('passes the criteria, their weights AND the behavioural anchors', () => {
    const user = buildDimensionJudgeMessages(dimensionQuestion, 'Salt it, then reduce.')[1]!.content;
    expect(user).toContain('[c-acid]');
    expect(user).toContain('weight 2');
    expect(user).toContain('[c-raw-flour]');
    expect(user).toContain('weight 5');
    for (const band of [0, 1, 2, 3, 4]) {
      expect(user).toContain(`  ${band} — `);
    }
    expect(user).toContain('Ranks four causes by likelihood');
  });

  it('tells the judge the weights and forbids it computing a total', () => {
    const system = buildDimensionJudgeMessages(dimensionQuestion, 'x')[0]!.content;
    expect(system).toMatch(/Do NOT compute a total/);
  });

  it('refuses an item that declares dimension mode with no anchors', () => {
    const unanchored = { ...dimensionQuestion, anchors: undefined };
    expect(() => buildDimensionJudgeMessages(unanchored, 'x')).toThrow(/no anchors/);
  });

  it('refuses criteria a ballot could not cite back', () => {
    // An unidentified criterion cannot be retained per-criterion, adjudicated or
    // checked for a split — so the item is refused before any judge sees it.
    const unlabelled: Question = {
      ...dimensionQuestion,
      grader: {
        type: 'llm-judge',
        judgeMode: 'dimension',
        rubric: [{ kind: 'include', statement: 'Checks salt first', weight: 1 }],
      },
    };
    expect(() => buildDimensionJudgeMessages(unlabelled, 'x')).toThrow(/stable id/);
  });

  it('refuses a v1 rubric masquerading as v3 criteria', () => {
    const legacy: Question = {
      ...dimensionQuestion,
      grader: {
        type: 'llm-judge',
        judgeMode: 'dimension',
        rubric: [{ name: 'Diagnosis', description: 'Names causes', weight: 1 }],
      },
    };
    expect(() => buildDimensionJudgeMessages(legacy, 'x')).toThrow(/no atomic criteria/);
  });
});

describe('dimension ballots refuse to be half-filled', () => {
  const ballot = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      dimensions: [{ dimension: 'diagnostic ranking', band: 3, evidence: 'tests salt first' }],
      criteria: [
        { id: 'c-acid', decision: 'met', evidence: 'salt then vinegar' },
        { id: 'c-raw-flour', decision: 'met', evidence: 'no flour anywhere' },
      ],
      confidence: 0.8,
      summary: 'Sound.',
      ...overrides,
    });

  it('accepts a complete ballot', () => {
    const parsed = parseDimensionBallot(dimensionQuestion, ballot());
    expect(parsed.dimensions[0]!.band).toBe(3);
    expect(parsed.criteria).toHaveLength(2);
    expect(parsed.confidence).toBe(0.8);
  });

  it('refuses a ballot that skipped a criterion rather than defaulting it', () => {
    expect(() =>
      parseDimensionBallot(
        dimensionQuestion,
        ballot({ criteria: [{ id: 'c-acid', decision: 'met', evidence: 'salt' }] }),
      ),
    ).toThrow(/undecided/);
  });

  it('refuses a ballot that skipped a dimension', () => {
    expect(() => parseDimensionBallot(dimensionQuestion, ballot({ dimensions: [] }))).toThrow(
      /unscored/,
    );
  });

  it('refuses an invented dimension', () => {
    expect(() =>
      parseDimensionBallot(
        dimensionQuestion,
        ballot({ dimensions: [{ dimension: 'flair', band: 4, evidence: 'lovely' }] }),
      ),
    ).toThrow(/unknown dimension/);
  });

  it('refuses a band outside the anchored 0–4 scale', () => {
    for (const band of [5, -1, 2.5]) {
      expect(() =>
        parseDimensionBallot(
          dimensionQuestion,
          ballot({ dimensions: [{ dimension: 'diagnostic ranking', band, evidence: 'x' }] }),
        ),
      ).toThrow(/outside 0–4/);
    }
  });

  it('refuses a missing or nonsensical confidence rather than assuming one', () => {
    for (const confidence of [undefined, 1.4, -0.1, 'high']) {
      expect(() => parseDimensionBallot(dimensionQuestion, ballot({ confidence }))).toThrow(
        /usable confidence/,
      );
    }
  });

  it('refuses a decision with no evidence', () => {
    expect(() =>
      parseDimensionBallot(
        dimensionQuestion,
        ballot({
          criteria: [
            { id: 'c-acid', decision: 'met', evidence: '   ' },
            { id: 'c-raw-flour', decision: 'met', evidence: 'none' },
          ],
        }),
      ),
    ).toThrow(/no evidence/);
  });

  it('refuses a criterion decided twice', () => {
    expect(() =>
      parseDimensionBallot(
        dimensionQuestion,
        ballot({
          criteria: [
            { id: 'c-acid', decision: 'met', evidence: 'a' },
            { id: 'c-acid', decision: 'missed', evidence: 'b' },
            { id: 'c-raw-flour', decision: 'met', evidence: 'c' },
          ],
        }),
      ),
    ).toThrow(/twice/);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.1 — pairwise mode                                                       */
/* -------------------------------------------------------------------------- */

describe('pairwise-mode prompts', () => {
  it('presents two answers by position and names no candidate', () => {
    const user = buildPairwiseJudgeMessages(
      pairwiseQuestion,
      'Salt it and reduce.',
      'Add a stock cube.',
    )[1]!.content;
    expect(user).toContain('ANSWER A:\nSalt it and reduce.');
    expect(user).toContain('ANSWER B:\nAdd a stock cube.');
    expect(user).not.toMatch(/model|candidate [A-Z]\/|provider/i);
  });

  it('keeps "both unacceptable" out of the tie bucket in the instructions', () => {
    const system = buildPairwiseJudgeMessages(pairwiseQuestion, 'a', 'b')[0]!.content;
    expect(system).toMatch(/This is NOT a tie/);
    expect(system).toMatch(/"abstain"/);
  });

  it('blinds both answers, not just the first', () => {
    const user = buildPairwiseJudgeMessages(
      pairwiseQuestion,
      'Salt it.',
      'As ChatGPT, I would add a stock cube.',
    )[1]!.content;
    expect(user).not.toMatch(/chatgpt/i);
  });
});

describe('pairwise ballots', () => {
  const ballot = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      outcome: 'A',
      criteria: [
        { id: 'c-acid', favours: 'A', evidence: 'A salts first' },
        { id: 'c-raw-flour', favours: 'equal', evidence: 'neither uses flour' },
      ],
      criticalFailures: [],
      confidence: 0.9,
      reasoning: 'A is better.',
      ...overrides,
    });

  it('parses a positional outcome and keeps the presentation order with it', () => {
    const parsed = parsePairwiseBallot(pairwiseQuestion, ballot(), 'BA');
    expect(parsed.outcome).toBe('A');
    expect(parsed.order).toBe('BA');
  });

  it('refuses an outcome outside the declared vocabulary', () => {
    expect(() => parsePairwiseBallot(pairwiseQuestion, ballot({ outcome: 'tie' }), 'AB')).toThrow(
      /invalid pairwise outcome/,
    );
  });

  it('refuses "both unacceptable" with no failure named', () => {
    // An unadjudicatable safety claim is worse than no claim: it cannot be
    // routed, checked or reproduced.
    expect(() =>
      parsePairwiseBallot(pairwiseQuestion, ballot({ outcome: 'both_unacceptable' }), 'AB'),
    ).toThrow(/without naming a single failure/);
  });

  it('refuses a critical failure tagged to nothing', () => {
    expect(() =>
      parsePairwiseBallot(
        pairwiseQuestion,
        ballot({ criticalFailures: [{ answer: 'C', issue: 'raw flour' }] }),
        'AB',
      ),
    ).toThrow(/critical failure to "C"/);
  });

  it('refuses a ballot that left criteria undecided', () => {
    expect(() =>
      parsePairwiseBallot(
        pairwiseQuestion,
        ballot({ criteria: [{ id: 'c-acid', favours: 'A', evidence: 'x' }] }),
        'AB',
      ),
    ).toThrow(/undecided/);
  });

  it('refuses a critical failure citing a criterion the item does not have', () => {
    // It would sit in the adjudication queue pointing at nothing.
    expect(() =>
      parsePairwiseBallot(
        pairwiseQuestion,
        ballot({
          outcome: 'both_unacceptable',
          criticalFailures: [{ answer: 'both', criterionId: 'c-invented', issue: 'unsafe' }],
        }),
        'AB',
      ),
    ).toThrow(/unknown criterion "c-invented"/);
  });
});

/* -------------------------------------------------------------------------- */
/* M2.5 — blinding                                                            */
/* -------------------------------------------------------------------------- */

describe('blinding survives contact with real self-identification', () => {
  const roster = loadModels();
  const lexicon = blindingLexicon(roster);

  it('removes the phrasings v2 let straight through', () => {
    const cases = [
      'This is Claude. Whisk the yolks.',
      'I was trained by OpenAI, so here is my answer.',
      'The sauce is fine — my training data says otherwise.',
      "Anthropic's guidelines mean I must warn you about raw eggs.",
      'Whisk gently.\n— Gemini',
      'Reduce the sauce.\n\nBest, ChatGPT',
      'Reduce the sauce — Claude',
      'As a large language model, I cannot taste it.',
      'Generated by Grok 4.5',
    ];
    for (const text of cases) {
      const cleaned = anonymizeAnswer(text, lexicon);
      expect(
        identityLeaks(cleaned, lexicon).filter((l) => l.kind === 'certain'),
        `leaked from: ${text}`,
      ).toEqual([]);
      expect(cleaned, `leaked from: ${text}`).not.toMatch(
        /claude|chatgpt|openai|anthropic|gemini|grok|training data/i,
      );
    }
  });

  it('blinds every model on the live roster, by id, display name and provider', () => {
    // Vacuity guard first: a lexicon that covered nothing would pass the loop.
    expect(lexicon.certain.length).toBeGreaterThan(20);
    for (const model of roster) {
      const boast = `I am ${model.displayName}, made by ${model.provider}. My slug is ${model.id}.`;
      expect(identityLeaks(boast, lexicon).length, `not covered: ${model.id}`).toBeGreaterThan(0);
      expect(identityLeaks(anonymizeAnswer(boast, lexicon), lexicon), `survived: ${model.id}`).toEqual(
        [],
      );
    }
  });

  it('does NOT edit culinary text that happens to collide with a model name', () => {
    // M2.5: "Preserve candidate text." Barding, llama shoulder and the mistral
    // are food, and a blinder that deletes them has corrupted the answer it was
    // protecting — the same mistake as forbidding "coconut" on a coconut item.
    const culinary =
      'Bard the llama loin with pork fat, hang it in the mistral, and note the meta-question about salt.';
    expect(anonymizeAnswer(culinary)).toBe(culinary);
  });

  it('removes an ambiguous name used to identify, and keeps the same word used to cook', () => {
    const mixed = anonymizeAnswer("As Claude, I'd bard the loin before roasting.");
    expect(mixed).not.toMatch(/\bclaude\b/i);
    expect(mixed).toMatch(/bard the loin/);
  });

  it('classifies a leak by how certain it is, rather than treating every word as a name', () => {
    const kinds = identityLeaks('OpenAI trained on llama recipes', lexicon).map((l) => l.kind);
    expect(kinds).toContain('certain');
    expect(kinds).toContain('possible');
  });
});

describe('no judge prompt can name a model, at any point in the dataset', () => {
  // The cheap permanent one. Every scaffolding channel a judge sees — the
  // prompt, the reference answer, the judging notes, the criteria, the anchors —
  // is scanned for every roster id, display name and provider name. A new item
  // whose reference answer says "unlike Gemini 3.1…" fails here, before it can
  // reach a paid judge and quietly hand one seat a hint about the author.
  const roster = loadModels();
  const lexicon = blindingLexicon(roster);
  const questions = loadQuestions();
  const BENIGN = 'Season the sauce, add a splash of vinegar, and reduce it by a third.';

  it('finds no roster identifier anywhere in the bank, whatever grades the item', () => {
    // Broader than the prompt scan below on purpose: a keyword-graded item does
    // not build a judge prompt today, and may be judge-graded tomorrow.
    expect(questions.length).toBeGreaterThan(100);
    const offenders: string[] = [];
    for (const q of questions) {
      const text = [q.prompt, q.referenceAnswer, q.judgingNotes ?? '', q.systemHint ?? ''].join(
        '\n',
      );
      const leaks = identityLeaks(text, lexicon);
      if (leaks.length > 0) {
        offenders.push(`${q.id}: ${leaks.map((l) => `${l.token} (${l.kind})`).join(', ')}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('scans every judge prompt the bank can build and finds nothing', () => {
    const judged = questions.filter((q) => q.grader.type === 'llm-judge');
    expect(judged.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    let scanned = 0;
    for (const q of questions) {
      if (q.grader.type !== 'llm-judge') continue;
      let messages: ReadonlyArray<{ content: string }>;
      try {
        const mode = judgeModeOf(q);
        messages =
          mode === 'fault'
            ? buildJudgeMessages(q, BENIGN, lexicon)
            : mode === 'dimension'
              ? buildDimensionJudgeMessages(q, BENIGN, lexicon)
              : buildPairwiseJudgeMessages(q, BENIGN, BENIGN, lexicon);
      } catch (error) {
        // A v3 item that cannot yet be prompted is its own workstream's
        // failure; what this test asserts is that whatever DOES get built is
        // blind. `assertPromptBlind` throwing is itself a leak, so it is
        // reported rather than swallowed.
        const message = (error as Error).message;
        if (message.includes('not blind')) offenders.push(`${q.id}: ${message}`);
        continue;
      }
      scanned++;
      const leaks = messages.flatMap((m) => identityLeaks(m.content, lexicon));
      if (leaks.length > 0) {
        offenders.push(`${q.id}: ${leaks.map((l) => `${l.token} (${l.kind})`).join(', ')}`);
      }
    }
    // Every judge-graded item must have been scanned, not merely most of them:
    // a builder that threw for half the bank would otherwise pass silently.
    expect(scanned).toBe(judged.length);
    expect(offenders).toEqual([]);
  });

  it('would actually catch one — the scan is not vacuous', () => {
    const leaky: Question = {
      ...question,
      referenceAnswer: 'Gemini 3.1 Pro gets this wrong; whisk in warm water instead.',
    };
    expect(() => buildJudgeMessages(leaky, BENIGN, lexicon)).toThrow(/not blind/);
  });

  it('refuses a prompt naming a vendor even without a roster', () => {
    // Absence of a roster must not mean absence of blinding: the static lexicon
    // still covers the vendor names.
    const leaky: Question = { ...question, judgingNotes: 'Score as OpenAI would.' };
    expect(() => buildJudgeMessages(leaky, BENIGN)).toThrow(/not blind/);
  });
});

describe('panel seat assignment', () => {
  const PANEL = ['anthropic/claude-opus-4.8', 'qwen/qwen3.5-plus-20260420', 'openai/gpt-5.5'];

  // JUDGE-001: identity is the DECLARED provider and base-model identity, not
  // the OpenRouter slug prefix and not the marketing tier. The roster is the
  // source of truth, and a model it does not declare has no identity at all.
  //
  // Every row here is parsed through the ROSTER'S OWN SCHEMA. That is the point
  // of the fixture and not decoration: the rebadge below used to be expressed by
  // putting `family: 'gpt-frontier'` on a reseller, a shape data/models.yaml
  // could never legitimately carry, so the base-model arm was proved only
  // against something the registry could not mean. If `modelEntrySchema` cannot
  // express these rows, this file stops compiling rather than quietly going back
  // to testing a fiction.
  const registry = (entry: {
    id: string;
    provider: string;
    baseModel: string;
    family?: string;
    displayName?: string;
  }) =>
    modelEntrySchema.parse({
      displayName: entry.id,
      active: false,
      ...entry,
    });

  const ROSTER = [
    registry({ id: 'anthropic/claude-opus-4.8', provider: 'Anthropic', family: 'claude-frontier', baseModel: 'anthropic:claude-opus-4.8' }),
    registry({ id: 'anthropic/claude-fable-5', provider: 'Anthropic', family: 'claude-frontier', baseModel: 'anthropic:claude-fable-5' }),
    registry({ id: 'qwen/qwen3.5-plus-20260420', provider: 'Alibaba', family: 'qwen', baseModel: 'qwen:qwen3.5-plus-20260420' }),
    registry({ id: 'openai/gpt-5.5', provider: 'OpenAI', family: 'gpt-frontier', baseModel: 'openai:gpt-5.5' }),
    registry({ id: 'openai/gpt-5.4-mini', provider: 'OpenAI', family: 'gpt-mid', baseModel: 'openai:gpt-5.4-mini' }),
    registry({ id: 'moonshotai/kimi-k2.6', provider: 'Moonshot', family: 'kimi', baseModel: 'moonshotai:kimi-k2.6' }),
    // A rebadged model: a different vendor prefix, a different provider and a
    // different tier over someone else's base model. Slug-prefix comparison
    // calls this distinct, and so does the tier; it is not.
    registry({ id: 'reseller/private-gpt-5.5', provider: 'Reseller', family: 'reseller-frontier', baseModel: 'openai:gpt-5.5' }),
    // An honest unknown, spelled out. It is in the roster, it has a provider and
    // a tier, and it still has NO identity.
    registry({ id: 'unknown/mystery-model', provider: 'Unknown', family: 'mystery', baseModel: UNKNOWN_BASE_MODEL }),
  ];
  const identify = identityIndex(ROSTER);

  it('never lets a judge score its own provider', () => {
    // The PROVIDER arm, isolated: every pair below shares a provider and
    // differs on base model, so nothing here can be the base-model arm firing.
    // Asserted rather than assumed — a fixture that accidentally shared a base
    // model would make this test pass for the wrong reason and leave the
    // provider arm unproved.
    for (const [a, b] of [
      ['anthropic/claude-fable-5', 'anthropic/claude-opus-4.8'],
      ['openai/gpt-5.4-mini', 'openai/gpt-5.5'],
    ] as const) {
      expect(identify(a)!.provider).toBe(identify(b)!.provider);
      expect(identify(a)!.baseModelFamily).not.toBe(identify(b)!.baseModelFamily);
    }

    expect(panelSeats(PANEL, 'anthropic/claude-fable-5', 'tech-001', identify)).toEqual([
      'qwen/qwen3.5-plus-20260420',
      'openai/gpt-5.5',
    ]);
    expect(panelSeats(PANEL, 'openai/gpt-5.4-mini', 'tech-001', identify)).toEqual([
      'anthropic/claude-opus-4.8',
      'qwen/qwen3.5-plus-20260420',
    ]);
    expect(panelSeats(PANEL, 'qwen/qwen3.5-plus-20260420', 'tech-001', identify)).toEqual([
      'anthropic/claude-opus-4.8',
      'openai/gpt-5.5',
    ]);
  });

  it('never lets a judge score its own base model under another vendor prefix', () => {
    // The BASE-MODEL arm, isolated: the case slug comparison misses entirely,
    // and the reason JUDGE-001 checks two axes. 'reseller/…' and 'openai/…'
    // share no prefix, no provider and no tier, but gpt-5.5 would be grading
    // itself. The three inequalities are asserted so this cannot silently
    // degrade into a second provider-arm test.
    const rebadge = identify('reseller/private-gpt-5.5')!;
    const original = identify('openai/gpt-5.5')!;
    expect(rebadge.provider).not.toBe(original.provider);
    expect(ROSTER.find((m) => m.id === 'reseller/private-gpt-5.5')!.family).not.toBe(
      ROSTER.find((m) => m.id === 'openai/gpt-5.5')!.family,
    );
    expect(rebadge.baseModelFamily).toBe(original.baseModelFamily);

    const seats = panelSeats(PANEL, 'reseller/private-gpt-5.5', 'tech-001', identify);
    expect(seats).not.toContain('openai/gpt-5.5');
    expect(seats).toEqual(['anthropic/claude-opus-4.8', 'qwen/qwen3.5-plus-20260420']);
  });

  it('seats a model that shares neither axis, so the arms are not just refusing everything', () => {
    // The control. Two tests above prove seats are REMOVED; without this one,
    // an identityIndex that returned undefined for everything would pass both.
    const seats = panelSeats(PANEL, 'moonshotai/kimi-k2.6', 'tech-001', identify);
    expect(seats).toHaveLength(2);
    for (const seat of seats) {
      expect(identify(seat)!.provider).not.toBe(identify('moonshotai/kimi-k2.6')!.provider);
      expect(identify(seat)!.baseModelFamily).not.toBe(
        identify('moonshotai/kimi-k2.6')!.baseModelFamily,
      );
    }
  });

  it('treats an undeclared identity as conflicted rather than as distinct', () => {
    // Fail closed. An unknown model is exactly the case where a rebadge would
    // hide, so "we do not know" must not resolve to "no conflict".
    expect(panelSeats(PANEL, 'unknown/mystery-model', 'tech-001', identify)).toEqual([]);
    expect(panelSeats(PANEL, 'not-in-the-roster-at-all', 'tech-001', identify)).toEqual([]);
  });

  it('gives the unknown sentinel no identity, so two unknowns do not share a lineage', () => {
    // The fail-OPEN shape this is guarding against: if `unknown` were carried
    // through as an ordinary string, two unidentified entries would match each
    // other and differ from every real base model — conflict-free against
    // precisely the models a rebadge would want to grade.
    const bothUnknown = identityIndex([
      ...ROSTER,
      registry({ id: 'other/mystery', provider: 'Somebody Else', baseModel: UNKNOWN_BASE_MODEL }),
    ]);
    expect(bothUnknown('unknown/mystery-model')).toBeUndefined();
    expect(bothUnknown('other/mystery')).toBeUndefined();
    expect(
      panelSeats([...PANEL, 'unknown/mystery-model'], 'other/mystery', 'tech-001', bothUnknown),
    ).toEqual([]);
    // And the sentinel is not admissible as a base-model id in the first place:
    // the two namespaces are disjoint by construction, because an id needs a
    // colon and the sentinel has none. That disjointness is what makes the
    // sentinel safe; the explicit check in identityIndex is belt and braces
    // over it, and the half-declaration below is the case where the braces are
    // the only thing holding.
    expect(() => baseModelIdSchema.parse(UNKNOWN_BASE_MODEL)).toThrow();

    // `openai:unknown` — "an OpenAI model, nobody checked which". It is
    // id-SHAPED, so the shape rule admits it; it is still not an identity, and
    // two of them are certainly not the same model.
    const halfDeclared = identityIndex([
      { id: 'lab/one', provider: 'Lab One', baseModel: 'openai:unknown' },
      { id: 'lab/two', provider: 'Lab Two', baseModel: 'openai:unknown' },
    ]);
    expect(halfDeclared('lab/one')).toBeUndefined();
    expect(halfDeclared('lab/two')).toBeUndefined();
    expect(() => baseModelIdSchema.parse('openai:unknown')).toThrow();
  });

  it('refuses to read the marketing tier as an identity, however it is smuggled in', () => {
    // The original defect, in both of the shapes it can come back as. Rows that
    // never went through the schema are the realistic route — mocks, fixtures,
    // and a half-finished migration that copied `family` across.
    const tierOnly = identityIndex([
      { id: 'lab/one', provider: 'Lab', family: 'lab-frontier' },
      { id: 'reseller/two', provider: 'Reseller', family: 'lab-frontier' },
    ]);
    expect(tierOnly('lab/one')).toBeUndefined();
    expect(tierOnly('reseller/two')).toBeUndefined();

    // A tier pasted into the new field is not a base-model id: no colon, so it
    // buys no identity rather than reinstating the tier comparison under a new
    // name. Same answer, reached deliberately.
    const pasted = identityIndex([
      { id: 'lab/one', provider: 'Lab', baseModel: 'lab-frontier' },
      { id: 'reseller/two', provider: 'Reseller', baseModel: 'lab-frontier' },
    ]);
    expect(pasted('lab/one')).toBeUndefined();
    expect(pasted('reseller/two')).toBeUndefined();
  });

  it('cannot be written into the roster file without an identity at all', () => {
    // The registry boundary, not the seating boundary: a row with no `baseModel`
    // is refused at parse, so `loadModels()` can never hand seating a model
    // whose identity nobody decided. Optionality is what let the old field be
    // skipped, and "not stated" is the state a rebadge would choose.
    const row = {
      id: 'reseller/private-gpt-5.5',
      displayName: 'Private 5.5',
      provider: 'Reseller',
      family: 'reseller-frontier',
      active: true,
    };
    expect(() => modelEntrySchema.parse(row)).toThrow();
    expect(() => modelsFileSchema.parse([row])).toThrow();
    // Nor with an identity the conflict rule cannot read.
    for (const baseModel of ['', 'gpt-frontier', 'OpenAI:GPT-5.5', 'openai:', ':gpt-5.5', 'unknown-ish']) {
      expect(() => modelEntrySchema.parse({ ...row, baseModel }), baseModel).toThrow();
    }
    expect(() => modelEntrySchema.parse({ ...row, baseModel: 'openai:gpt-5.5' })).not.toThrow();
    expect(() => modelEntrySchema.parse({ ...row, baseModel: UNKNOWN_BASE_MODEL })).not.toThrow();
  });

  it('explains which seat conflicted when too few remain', async () => {
    // "Panel too small" sends you looking at the panel; the cause is almost
    // always an incomplete roster, and the tempting wrong fix is to relax the
    // conflict rule.
    const question = { id: 'tech-001', grader: { type: 'llm-judge' } } as never;
    const client = { complete: async () => { throw new Error('must not be called'); } };
    await expect(
      judgeAnswerPanel(client as never, PANEL, 'unknown/mystery-model', question, 'answer', identify),
    ).rejects.toThrow(/no declared identity in the roster/);
  });

  it('rotates the dropped seat deterministically for non-conflicted candidates', () => {
    const a = panelSeats(PANEL, 'moonshotai/kimi-k2.6', 'tech-001', identify);
    const b = panelSeats(PANEL, 'moonshotai/kimi-k2.6', 'tech-001', identify);
    expect(a).toEqual(b); // reproducible
    expect(a).toHaveLength(2);
    // across many questions, all three judges get seat time
    const used = new Set<string>();
    for (let i = 0; i < 30; i++) {
      for (const seat of panelSeats(PANEL, 'moonshotai/kimi-k2.6', `q-${i}`, identify)) used.add(seat);
    }
    expect(used.size).toBe(3);
  });

  it('compares identity case- and whitespace-insensitively', () => {
    // `provider` is free text from data/models.yaml, and `baseModel` reaches
    // identityIndex from callers that never went through the schema, so neither
    // may depend on display casing. Both arms are exercised, one per row.
    //
    // Asserted as an EXACT seat list, not with `not.toContain`: a row that
    // folded to no identity at all would seat nobody, and "does not contain
    // gpt-5.5" is trivially true of an empty panel. That is how a fail-closed
    // regression hides inside a passing conflict test.
    const sloppy = identityIndex([
      ...ROSTER,
      { id: 'openai/gpt-5.6', provider: ' OpenAI ', baseModel: 'openai:gpt-5.6' },
      { id: 'reseller/loud-gpt', provider: 'Reseller', baseModel: ' OpenAI:GPT-5.5 ' },
    ]);
    expect(panelSeats(PANEL, 'openai/gpt-5.6', 'tech-001', sloppy)).toEqual([
      'anthropic/claude-opus-4.8',
      'qwen/qwen3.5-plus-20260420',
    ]);
    expect(panelSeats(PANEL, 'reseller/loud-gpt', 'tech-001', sloppy)).toEqual([
      'anthropic/claude-opus-4.8',
      'qwen/qwen3.5-plus-20260420',
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* JUDGE-001 — the live roster, not a fixture                                 */
/* -------------------------------------------------------------------------- */

describe('base-model identity on the real roster', () => {
  // The recorded gap this closes: `family` is a marketing tier, so seating was
  // reading a tier and calling it a base model, and the cross-provider arm of
  // the rule was unexercised on anything the registry could actually express.
  // These tests are about data/models.yaml itself — the fixtures above prove the
  // rule, this proves the roster feeds it something real.
  const roster = loadModels() as Array<{
    id: string;
    provider: string;
    family?: string;
    baseModel?: string;
    active: boolean;
  }>;
  const identify = identityIndex(roster);

  it('declares a base model for every entry, and only says unknown out loud', () => {
    expect(roster.length).toBeGreaterThan(20); // vacuity guard
    for (const m of roster) {
      expect(typeof m.baseModel, `${m.id} has no baseModel`).toBe('string');
      if (m.baseModel === UNKNOWN_BASE_MODEL) continue;
      expect(() => baseModelIdSchema.parse(m.baseModel), m.id).not.toThrow();
    }
  });

  it('carries a base model for every model that can actually run', () => {
    // An ACTIVE model with an unknown base model is unjudgeable and unable to
    // judge — every seat conflicts with it — so it would produce a run of
    // silently unjudged rows rather than an error. Establishing the identity is
    // part of flipping `active: true`, and this is the thing that says so.
    const activeUnknown = roster
      .filter((m) => m.active && m.baseModel === UNKNOWN_BASE_MODEL)
      .map((m) => m.id);
    expect(activeUnknown).toEqual([]);
    for (const m of roster.filter((x) => x.active)) {
      expect(identify(m.id), `${m.id} has no usable identity`).toBeDefined();
    }
  });

  it('separates models that the marketing tier merges', () => {
    // The concrete reason the two fields exist. `claude-frontier` covers three
    // different models; if `baseModel` collapsed the same way it would be a tier
    // with a new name, and the rule would be back where it started.
    const byTier = new Map<string, Set<string>>();
    for (const m of roster) {
      if (!m.family || m.baseModel === UNKNOWN_BASE_MODEL) continue;
      byTier.set(m.family, (byTier.get(m.family) ?? new Set()).add(m.baseModel!));
    }
    expect(byTier.get('claude-frontier')?.size).toBeGreaterThan(2);
    const merged = [...byTier].filter(([, bases]) => bases.size === 1).map(([tier]) => tier);
    // Some tiers legitimately hold one model; what must not happen is a tier
    // whose several members all report one base model.
    for (const tier of merged) {
      const members = roster.filter((m) => m.family === tier && m.baseModel !== UNKNOWN_BASE_MODEL);
      expect(members.length, `tier ${tier} merges ${members.length} models into one base`).toBe(1);
    }
  });

  it('shares a base model only where the provider is shared too', () => {
    // A measured statement about today's roster, not an assumption: no entry is
    // a rebadge, so the base-model arm currently excludes no seat the provider
    // arm had not already excluded. That is the honest position — the arm is
    // correct and dormant, and the day a reseller entry lands here this test
    // fails and has to be re-read rather than the rule being relaxed.
    const crossProvider: string[] = [];
    for (const a of roster) {
      for (const b of roster) {
        if (a.id >= b.id) continue;
        if (a.baseModel === UNKNOWN_BASE_MODEL || b.baseModel === UNKNOWN_BASE_MODEL) continue;
        if (a.baseModel !== b.baseModel) continue;
        if (a.provider.trim().toLowerCase() !== b.provider.trim().toLowerCase()) {
          crossProvider.push(`${a.id} + ${b.id} → ${a.baseModel}`);
        }
      }
    }
    expect(crossProvider).toEqual([]);
  });

  it('would let the registry express a rebadge, which is what the old field could not', () => {
    // The gap said the arm "would only wake up for a rebadged model — the case
    // it exists for — which the registry currently has no way to express". This
    // is that claim, retired: the row parses against the roster's own schema and
    // the arm fires on it.
    const rebadge = modelEntrySchema.parse({
      id: 'reseller/private-frontier',
      displayName: 'Private Frontier',
      provider: 'Some Reseller',
      family: 'reseller-frontier',
      baseModel: 'openai:gpt-5.5',
      active: false,
    });
    const withRebadge = identityIndex([...roster, rebadge]);
    expect(withRebadge('reseller/private-frontier')).toBeDefined();
    expect(hasJudgeConflict(withRebadge('reseller/private-frontier')!, withRebadge('openai/gpt-5.5')!)).toBe(
      true,
    );
    // And it is genuinely the base-model arm doing it.
    expect(withRebadge('reseller/private-frontier')!.provider).not.toBe(
      withRebadge('openai/gpt-5.5')!.provider,
    );
  });
});
