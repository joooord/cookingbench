import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NON_SCORING_LABEL, isRankEligible, type Question } from '@cookingbench/core';
import { RUNS_DIR } from '../src/dataset.js';
import { FirewallError, assertPublishable, nonScoringBanner } from '../src/firewall.js';
import {
  identityIndex,
  judgeAnswerPanel,
  judgeDimensionAnswer,
  judgePairwiseComparison,
  type JurySeatContext,
} from '../src/judge.js';
import { ReservationLedger } from '../src/ledger.js';
import { buildRunManifest } from '../src/manifest.js';
import { OpenRouterClient } from '../src/openrouter.js';
import { mintTestGrant } from './support/grant.js';

/**
 * RUN-001 / RELEASE-002, asserted THROUGH the three judge routes themselves.
 *
 * docs/wp-0/routes.yaml reopened these risks because the citations exercised
 * helpers — `panelSeats`, `OpenRouterClient.forCandidates` — rather than
 * `judgeAnswerPanel`, `judgePairwiseComparison` and `judgeDimensionAnswer`. A
 * test of a helper cannot fail when the route stops calling it, so it is not
 * evidence about the route. Every test below calls the route's own exported
 * function and asserts the refusal by its FirewallError CODE and a distinctive
 * message fragment, so a refusal for an unrelated reason cannot pass for the
 * one being claimed.
 *
 * Offline by construction: `globalThis.fetch` is stubbed in every test and
 * records what would have been contacted, so "no provider call was attempted"
 * is an assertion rather than an assumption. No socket is opened, no key is
 * read that has any value, and the only filesystem writes are the reservation
 * journal and manifest of one scratch run, removed in afterEach.
 */

const RUN = '__test-routes-judge-scratch';

const CANDIDATE = 'moonshotai/kimi-k2.6';
/** The 2026-07 panel shape: three labs, so one conflict still leaves two seats. */
const PANEL = ['anthropic/claude-opus-4.8', 'openai/gpt-5.5', 'x-ai/grok-4.5'];

/**
 * JUDGE-001 identity: the declared provider and base model, never the slug
 * prefix and never the marketing tier. `reseller/private-gpt-5.5` is a rebadge
 * — a different vendor prefix and provider over someone else's base model — and
 * exists here so the base-model arm can be exercised separately from the
 * provider arm.
 */
const ROSTER = [
  { id: 'anthropic/claude-opus-4.8', provider: 'Anthropic', baseModel: 'anthropic:claude-opus-4.8' },
  { id: 'openai/gpt-5.5', provider: 'OpenAI', baseModel: 'openai:gpt-5.5' },
  { id: 'openai/gpt-5.4-mini', provider: 'OpenAI', baseModel: 'openai:gpt-5.4-mini' },
  { id: 'x-ai/grok-4.5', provider: 'xAI', baseModel: 'x-ai:grok-4.5' },
  { id: 'moonshotai/kimi-k2.6', provider: 'Moonshot', baseModel: 'moonshotai:kimi-k2.6' },
  { id: 'reseller/private-gpt-5.5', provider: 'Reseller', baseModel: 'openai:gpt-5.5' },
];
const identify = identityIndex(ROSTER);

/** M2.5 seating for the two v3 routes: three seats, three distinct families. */
const SEATING: JurySeatContext = {
  seats: ['x-ai/grok-4.5', 'google/gemini-3.1-pro', 'alibaba/qwen3.7-max'],
  families: ['grok', 'gemini', 'qwen'],
};

const ANSWER = 'Season it, add a splash of vinegar, then reduce the sauce by a third.';
const OTHER_ANSWER = 'Stir a spoon of raw flour through the finished braise.';

/** A v2 fault-mode item: the only mode `judgeAnswerPanel` will grade. */
const faultQuestion: Question = {
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
  referenceAnswer: 'Fresh yolk and warm water, whisking the broken sauce in drop by drop.',
  public: true,
};

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
      { id: 'c-acid', kind: 'include', statement: 'Checks salt and acid first', weight: 2, dimension: 'diagnostic ranking' },
      { id: 'c-raw-flour', kind: 'critical', statement: 'No raw flour in a finished braise', weight: 5 },
    ],
  },
  referenceAnswer: 'Season, add acid, reduce, finish with butter.',
  anchors: [
    {
      dimension: 'diagnostic ranking',
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
      { id: 'c-acid', kind: 'include', statement: 'Checks salt and acid first', weight: 2 },
      { id: 'c-raw-flour', kind: 'critical', statement: 'No raw flour in a finished braise', weight: 5 },
    ],
  },
};

/** Every (candidate, item) coordinate any test below is entitled to buy. */
const CELLS = [
  { modelId: CANDIDATE, questionId: faultQuestion.id },
  { modelId: CANDIDATE, questionId: dimensionQuestion.id },
  { modelId: CANDIDATE, questionId: pairwiseQuestion.id },
  { modelId: 'openai/gpt-5.4-mini', questionId: faultQuestion.id },
  { modelId: 'reseller/private-gpt-5.5', questionId: faultQuestion.id },
];

beforeEach(() => {
  // Never sent anywhere — `fetch` is stubbed in every test. Present only so a
  // completion that IS authorised fails on the stub rather than on config.
  process.env.OPENROUTER_API_KEY ??= 'test-key-not-used-offline';
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(join(RUNS_DIR, RUN), { recursive: true, force: true });
});

/** A permit that may judge these answers and buy nothing else. */
function judgeGrant() {
  return mintTestGrant({
    permitId: 'permit-judge-route-01',
    kind: 'legacy-shadow',
    capabilities: ['judge-inference'],
    cells: CELLS,
    runId: RUN,
  });
}

/**
 * A permit for CANDIDATE inference over the same coordinates.
 *
 * The point of the pairing: identical cells, identical run, and the only
 * difference is the kind of work authorised at them. A client built from this
 * grant is a real, paid, fully-constructed client — it simply was never
 * authorised to judge.
 */
function candidateGrant() {
  return mintTestGrant({
    permitId: 'permit-judge-route-02',
    kind: 'development-probe',
    capabilities: ['candidate-inference'],
    cells: CELLS,
    runId: RUN,
  });
}

function ledgerFor(grant: ReturnType<typeof judgeGrant>) {
  // No run lock: these tests are about the routes, not about the lock. The
  // production entry (`forGrant`) cannot turn it off at all.
  return ReservationLedger.forTests(grant, RUN, { lock: false });
}

interface Transport {
  /** Model ids that reached the socket, in call order. */
  contacted: string[];
  fetchSpy: ReturnType<typeof vi.fn>;
}

/** Stub the transport and record every model a request would have named. */
function stubTransport(reply: () => string): Transport {
  const contacted: string[] = [];
  const fetchSpy = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    const request = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
    contacted.push(String(request.model));
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: reply() }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 200, cost: 0.02 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  vi.stubGlobal('fetch', fetchSpy);
  return { contacted, fetchSpy };
}

const faultVerdict = () => JSON.stringify({ findings: [], summary: 'Matches the reference.' });

const dimensionBallot = () =>
  JSON.stringify({
    dimensions: [{ dimension: 'diagnostic ranking', band: 3, evidence: 'tests salt first' }],
    criteria: [
      { id: 'c-acid', decision: 'met', evidence: 'salt then vinegar' },
      { id: 'c-raw-flour', decision: 'met', evidence: 'no flour anywhere' },
    ],
    confidence: 0.8,
    summary: 'Sound.',
  });

const pairwiseBallot = () =>
  JSON.stringify({
    outcome: 'A',
    criteria: [
      { id: 'c-acid', favours: 'A', evidence: 'salts before sweetening' },
      { id: 'c-raw-flour', favours: 'A', evidence: 'no raw flour' },
    ],
    criticalFailures: [],
    confidence: 0.9,
    reasoning: 'One seasons, one thickens with raw flour.',
  });

/**
 * Capture the refusal a route threw, insisting it came from the firewall.
 *
 * `rejects.toThrow(/…/)` alone would let a refusal for an unrelated reason —
 * a malformed ballot, a seating error, a missing key — stand in for the
 * authorisation refusal being claimed, which is how a risk gets recorded as
 * closed on evidence about something else entirely.
 */
async function firewallRefusal(run: () => Promise<unknown>): Promise<FirewallError> {
  try {
    await run();
  } catch (error) {
    expect(error, `the route refused, but not through the firewall: ${String(error)}`).toBeInstanceOf(
      FirewallError,
    );
    return error as FirewallError;
  }
  throw new Error('expected the route to refuse; it returned a verdict instead');
}

/* -------------------------------------------------------------------------- */
/* RUN-001 — unauthorised-inference, through each route                       */
/* -------------------------------------------------------------------------- */

describe('judge routes refuse a client that was not built to judge', () => {
  /**
   * The premise every test in this block rests on: the grant behind the
   * candidate client grants candidate-inference and NOT judge-inference, so a
   * judging client cannot be built from it at all. Asserted rather than assumed
   * — if the fixture ever acquired judge-inference the refusals below would
   * still fire on the cell mismatch and would prove nothing about capability.
   */
  function candidateScopedClient(): OpenRouterClient {
    const grant = candidateGrant();
    expect(grant.capabilities).not.toContain('judge-inference');
    expect(() => OpenRouterClient.forJudging(grant, ledgerFor(grant))).toThrow(
      /does not grant 'judge-inference'/,
    );
    return OpenRouterClient.forCandidates(grant, ledgerFor(grant));
  }

  it('refuses judgeAnswerPanel a candidate-scoped client, before any provider call', async () => {
    const { contacted, fetchSpy } = stubTransport(faultVerdict);
    const client = candidateScopedClient();

    const refusal = await firewallRefusal(() =>
      judgeAnswerPanel(client, PANEL, CANDIDATE, faultQuestion, ANSWER, identify),
    );

    // The cell kind is fixed at CONSTRUCTION, so a candidate client cannot be
    // talked into spending a judge cell by an argument: it demands that the
    // model being called is the subject of the cell, and on a judging call the
    // subject is the candidate whose answer is being scored, never the seat.
    expect(refusal.code).toBe('CELL_NOT_AUTHORISED');
    expect(refusal.message).toMatch(/A candidate call answers for itself/);
    expect(refusal.message).toContain(CANDIDATE);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(contacted).toEqual([]);

    // Vacuity guard. The same route, the same panel and the same item DO buy a
    // verdict once the client holds a judging permit — so the refusal above is
    // about the authorisation and not about the fixture being unjudgeable.
    const grant = judgeGrant();
    const verdict = await judgeAnswerPanel(
      OpenRouterClient.forJudging(grant, ledgerFor(grant)),
      PANEL,
      CANDIDATE,
      faultQuestion,
      ANSWER,
      identify,
    );
    expect(verdict.score).toBe(100);
    expect(contacted).toEqual(verdict.judges);
  });

  it('refuses judgePairwiseComparison a candidate-scoped client, before any provider call', async () => {
    const { contacted, fetchSpy } = stubTransport(pairwiseBallot);
    const client = candidateScopedClient();

    const refusal = await firewallRefusal(() =>
      judgePairwiseComparison(
        client,
        SEATING,
        pairwiseQuestion,
        { modelId: CANDIDATE, answerText: ANSWER },
        { modelId: 'openai/gpt-5.4-mini', answerText: OTHER_ANSWER },
      ),
    );

    expect(refusal.code).toBe('CELL_NOT_AUTHORISED');
    expect(refusal.message).toMatch(/A candidate call answers for itself/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(contacted).toEqual([]);

    // Vacuity guard: six calls — two presentation orders per seat — once the
    // client is authorised to judge.
    const grant = judgeGrant();
    const result = await judgePairwiseComparison(
      OpenRouterClient.forJudging(grant, ledgerFor(grant)),
      SEATING,
      pairwiseQuestion,
      { modelId: CANDIDATE, answerText: ANSWER },
      { modelId: 'openai/gpt-5.4-mini', answerText: OTHER_ANSWER },
    );
    expect(result.units).toHaveLength(3);
    expect(contacted).toHaveLength(6);
  });

  it('refuses judgeDimensionAnswer a candidate-scoped client, before any provider call', async () => {
    const { contacted, fetchSpy } = stubTransport(dimensionBallot);
    const client = candidateScopedClient();

    const refusal = await firewallRefusal(() =>
      judgeDimensionAnswer(client, SEATING, CANDIDATE, dimensionQuestion, ANSWER),
    );

    expect(refusal.code).toBe('CELL_NOT_AUTHORISED');
    expect(refusal.message).toMatch(/A candidate call answers for itself/);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(contacted).toEqual([]);

    // Vacuity guard: one anchored ballot per seat once the client may judge.
    const grant = judgeGrant();
    const result = await judgeDimensionAnswer(
      OpenRouterClient.forJudging(grant, ledgerFor(grant)),
      SEATING,
      CANDIDATE,
      dimensionQuestion,
      ANSWER,
    );
    expect(result.primary.dimensions[0]!.majorityBand).toBe(3);
    expect(contacted).toEqual(SEATING.seats);
  });

  it('refuses judgeAnswerPanel a judging client for an item the permit never named', async () => {
    // The other half of RUN-001 at this route: the capability says WHAT may be
    // done, the cell list says WHERE. A judging permit that authorises one item
    // must not buy a verdict on another, and the check has to bite through the
    // route rather than only in the client's own unit tests.
    const { contacted, fetchSpy } = stubTransport(faultVerdict);
    const grant = mintTestGrant({
      permitId: 'permit-judge-route-03',
      kind: 'legacy-shadow',
      capabilities: ['judge-inference'],
      cells: [{ modelId: CANDIDATE, questionId: 'some-other-item' }],
      runId: RUN,
    });

    const refusal = await firewallRefusal(() =>
      judgeAnswerPanel(
        OpenRouterClient.forJudging(grant, ledgerFor(grant)),
        PANEL,
        CANDIDATE,
        faultQuestion,
        ANSWER,
        identify,
      ),
    );

    expect(refusal.code).toBe('CELL_NOT_AUTHORISED');
    expect(refusal.message).toMatch(
      new RegExp(`does not authorise the judge cell ${CANDIDATE} × ${faultQuestion.id}`),
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(contacted).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* JUDGE-001 — unauthorised-publish: the conflict rule, through the route      */
/* -------------------------------------------------------------------------- */

describe('the panel route seats the conflict rule before it spends', () => {
  it('never contacts a seat sharing the candidate provider or base model, through judgeAnswerPanel', async () => {
    // A verdict from a seat grading its own house is a tainted input to a
    // public ranking, and the previous citation for this risk exercised
    // `panelSeats` alone — which cannot fail if `judgeAnswerPanel` stops
    // consulting it. Here the assertion is on what reached the SOCKET.
    const grant = judgeGrant();
    const client = OpenRouterClient.forJudging(grant, ledgerFor(grant));

    // The PROVIDER arm, isolated: same provider, different base model.
    const { contacted: providerArm } = stubTransport(faultVerdict);
    expect(identify('openai/gpt-5.4-mini')!.provider).toBe(identify('openai/gpt-5.5')!.provider);
    expect(identify('openai/gpt-5.4-mini')!.baseModelFamily).not.toBe(
      identify('openai/gpt-5.5')!.baseModelFamily,
    );
    const byProvider = await judgeAnswerPanel(
      client,
      PANEL,
      'openai/gpt-5.4-mini',
      faultQuestion,
      ANSWER,
      identify,
    );
    expect(providerArm).not.toContain('openai/gpt-5.5');
    // Asserted as the exact seat list, not merely "does not contain": a panel
    // that failed closed and seated nobody would satisfy the negative alone.
    expect(providerArm).toEqual(['anthropic/claude-opus-4.8', 'x-ai/grok-4.5']);
    expect(byProvider.judges).toEqual(providerArm);

    // The BASE-MODEL arm, isolated: different vendor prefix, different
    // provider, same base model. Slug comparison misses this case entirely.
    vi.unstubAllGlobals();
    const { contacted: baseModelArm } = stubTransport(faultVerdict);
    expect(identify('reseller/private-gpt-5.5')!.provider).not.toBe(identify('openai/gpt-5.5')!.provider);
    expect(identify('reseller/private-gpt-5.5')!.baseModelFamily).toBe(
      identify('openai/gpt-5.5')!.baseModelFamily,
    );
    const byBaseModel = await judgeAnswerPanel(
      client,
      PANEL,
      'reseller/private-gpt-5.5',
      faultQuestion,
      ANSWER,
      identify,
    );
    expect(baseModelArm).not.toContain('openai/gpt-5.5');
    expect(baseModelArm).toEqual(['anthropic/claude-opus-4.8', 'x-ai/grok-4.5']);
    expect(byBaseModel.judges).toEqual(baseModelArm);

    // And the control: a candidate sharing neither axis is judged by seats
    // drawn from the whole panel, so the two arms are not simply refusing
    // every seat that exists.
    vi.unstubAllGlobals();
    const { contacted: unconflicted } = stubTransport(faultVerdict);
    await judgeAnswerPanel(client, PANEL, CANDIDATE, faultQuestion, ANSWER, identify);
    expect(unconflicted).toHaveLength(2);
    for (const seat of unconflicted) {
      expect(identify(seat)!.provider).not.toBe(identify(CANDIDATE)!.provider);
      expect(identify(seat)!.baseModelFamily).not.toBe(identify(CANDIDATE)!.baseModelFamily);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* RELEASE-002 — unauthorised-publish: the class the verdict was bought under  */
/* -------------------------------------------------------------------------- */

describe('a panel verdict from a non-rank-eligible class cannot reach a published surface', () => {
  it('refuses to publish the run judgeAnswerPanel bought its verdict under', async () => {
    const { contacted } = stubTransport(faultVerdict);
    const grant = judgeGrant();

    // The permit that authorises this judging pass is a legacy-shadow permit:
    // re-scoring archived answers. Rank eligibility is DERIVED from that class,
    // never asserted, and the whole point of the class is that a re-analysis
    // must not be able to mint a result.
    expect(grant.evidenceClass).toBe('legacy-shadow');
    expect(isRankEligible(grant.evidenceClass)).toBe(false);

    const verdict = await judgeAnswerPanel(
      OpenRouterClient.forJudging(grant, ledgerFor(grant)),
      PANEL,
      CANDIDATE,
      faultQuestion,
      ANSWER,
      identify,
    );
    // A perfect verdict, genuinely bought: the refusal below is not the route
    // failing to produce anything worth publishing.
    expect(verdict.score).toBe(100);
    expect(contacted).toHaveLength(2);

    // The run this verdict belongs to, described by its own manifest. The class
    // and the state come from the GRANT, so the manifest cannot quietly claim a
    // better standing than the permit that paid for the ballots.
    const { manifest } = buildRunManifest(
      {
        manifestVersion: 1,
        runId: RUN,
        methodologyVersion: 'v3.0',
        schemaVersion: '1',
        gitCommit: '980dfcb',
        parentArtifacts: [],
        evidenceClass: grant.evidenceClass,
        artifactOrigin: ['archived'],
        releaseState: grant.releaseState,
        rankEligible: isRankEligible(grant.evidenceClass),
        candidateRoutes: [
          { modelId: CANDIDATE, provider: 'Moonshot', baseModelFamily: 'moonshotai:kimi-k2.6' },
        ],
        judgeRoutes: verdict.judges.map((id) => ({
          modelId: id,
          provider: identify(id)!.provider,
          baseModelFamily: identify(id)!.baseModelFamily,
        })),
        generationSettings: {
          temperature: 0,
          maxTokens: 16000,
          maxTokensRecipe: 32000,
          repeats: 1,
          repeatPolicy: 'single',
        },
        callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
        budgetCapUsd: 10,
      },
      [faultQuestion],
    );

    // THE refusal: the publication boundary every public path goes through —
    // `assertPublicationAllowed('public', …)` and `setCurrentRun` both call it.
    let refusal: FirewallError | undefined;
    try {
      assertPublishable(manifest, 'publish the panel verdict');
    } catch (error) {
      refusal = error as FirewallError;
    }
    expect(refusal).toBeInstanceOf(FirewallError);
    expect(refusal!.code).toBe('INELIGIBLE_EVIDENCE');
    expect(refusal!.message).toMatch(/evidenceClass 'legacy-shadow'/);
    expect(refusal!.message).toMatch(/Only an approved 'public-release' manifest/);

    // Rendering it anywhere is not free either: the class carries a permanent
    // label, so a surface that shows the verdict has to say what it is.
    expect(nonScoringBanner(manifest.evidenceClass)).toBe(NON_SCORING_LABEL);

    // The discrimination test on the gate itself. Change only the two fields
    // that describe standing and the identical run publishes — so the refusal
    // above is about the evidence class, not a boundary that rejects
    // everything put in front of it.
    const { manifest: released } = buildRunManifest(
      {
        ...manifest,
        evidenceClass: 'public-release',
        artifactOrigin: ['live-provider'],
        releaseState: 'released',
        rankEligible: true,
      },
      [faultQuestion],
    );
    expect(() => assertPublishable(released, 'publish the panel verdict')).not.toThrow();
    expect(nonScoringBanner(released.evidenceClass)).toBeNull();
  });
});
