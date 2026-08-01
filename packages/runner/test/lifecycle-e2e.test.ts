import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NON_SCORING_LABEL,
  canonicalJson,
  type Question,
  type RunConfig,
  type Score,
  type StoredResponse,
} from '@cookingbench/core';
import { ADJUDICATION_QUEUE_FILE } from '../src/adjudicate.js';
import { analyzeRun, writeAnalysis } from '../src/analyze.js';
import { REPO_ROOT, RUNS_DIR, loadQuestions } from '../src/dataset.js';
import { FirewallError, isHistoricalRun, resolveRunDir, writeRunFileAtomic } from '../src/firewall.js';
import { JUDGE_PROMPT_VERSIONS, judgeModeOf, parseJudgeResponse } from '../src/judge.js';
import { BudgetExceededError, LedgerError, ReservationLedger } from '../src/ledger.js';
import {
  ANSWER_JOURNAL,
  BALLOT_JOURNAL,
  PUBLISHED_ARTIFACTS,
  REQUIRED_RELEASE_CHECK_IDS,
  appendBallot,
  appendJournalEntry,
  appendRawAnswer,
  assertPublicationAllowed,
  buildReleaseChecklist,
  checklistShortfall,
  clearRegisterFileForTest,
  readCurrentRun,
  readJournal,
  registerRun,
  responseIdentity,
  retainableScores,
  runState,
  setCurrentRun,
  staleScoresForRun,
  transitionRun,
  useRegisterFileForTest,
  verifyJournal,
  writeReleaseChecklist,
  type ReleaseChecklist,
} from '../src/lifecycle.js';
import { deriveRun } from '../src/derive.js';
import {
  buildRunManifest,
  readRunManifest,
  verifyRunManifest,
  verifyRunManifestWithOverrides,
  writeRunManifest,
} from '../src/manifest.js';
import { OpenRouterClient } from '../src/openrouter.js';
import {
  PERMIT_FIXTURES_DIR,
  assertGrantForRun,
  assertGrantStillValid,
  frozenMethodologyHash,
  manifestHash,
  sha256Hex,
  verifyPermit,
  verifyPermitFile,
  type VerifiedGrant,
} from '../src/permit.js';
import { redeemPermit } from '../src/redemption.js';
import { buildLeaderboard } from '../src/report.js';
import {
  mergeRunConfig,
  readAttempts,
  readResponses,
  readRunProtocol,
  writeLeaderboard,
  writeResponse,
  writeScores,
} from '../src/store.js';
import { mintTestGrant } from './support/grant.js';
import { verifyWithInstalledPublicKey, withTemporarilyRevokedPermit } from './support/production-trust.js';
import { resolveApprovedRelease } from '../../../apps/web/lib/data.js';

/**
 * WP-0 ACCEPTANCE TEST — the whole offline lifecycle, and every refusal.
 *
 * Every link in this chain already had unit tests. What nothing proved is that
 * the links CONNECT: that a manifest written before execution is the envelope a
 * permit binds, that the grant that permit mints is the one the ledger's cap
 * comes from, that the answer bought under it is the answer the checklist
 * counts, and that nothing at all reaches a reader until a named human has
 * approved a complete checklist. A suite of green units over a chain that has
 * never been walked end to end is the same class of claim as a leaderboard
 * whose ordering was never tested for separation.
 *
 * OFFLINE BY CONSTRUCTION. `globalThis.fetch` is stubbed with a spy on every
 * path that could reach a provider, and where a refusal is supposed to happen
 * BEFORE the socket the spy's call count is asserted, so "refused" is
 * distinguishable from "spent the money and then complained".
 * The signing key is generated into a temp directory and destroyed with it; no
 * signing key exists in the repository, because a system that can mint its own
 * permits approves itself. Nothing here reads a live API key, opens a socket or
 * touches the database.
 *
 * WHY TWO SCRATCH RUNS, AND WHY THAT IS NOT A CONVENIENCE.
 *
 * The permit matrix in packages/core/src/evidence.ts deliberately forbids one
 * run being both EXECUTED and PUBLISHED. `development-probe` and
 * `confirmatory-pilot` permits are the only kinds that grant inference, and
 * neither may bind a `public-release` manifest; `publication` binds
 * public-release and grants no inference at all. In production the bytes cross
 * that boundary through `derive.ts`, which requires the source run to be
 * COMMITTED. So the executed run and the published run are two artifacts here
 * exactly as they would be in production. The published artifact is committed
 * into an isolated local git object database before release, so the production
 * committed-tree check runs for real without changing this checkout's history.
 *
 * WHAT THIS TEST CANNOT DO, STATED RATHER THAN FAKED.
 *
 * The executed -> published edge is exercised through `deriveRun` after the
 * source is committed to the same isolated git history. This keeps the public
 * response lineage real too: the website receives copied source-stamped bytes,
 * not a public fixture that merely claims they were derived.
 *
 * Everything else below runs through the production entry points. Where a
 * refusal can be reached with COMMITTED material it is, via `verifyPermitFile`
 * against `data/permits/fixtures/` — expired and revoked permits that authorise
 * nothing. `test/support/grant.ts` was read first: `mintTestGrant` mints against
 * a placeholder manifest of its own, which cannot bind the real envelope under
 * test, so the chain signs its own permit over the manifest on disk using the
 * production verifier after temporarily installing its public half in the
 * fixed repository keyring. `mintTestGrant` is used where only the grant's
 * budget and cells matter.
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The executed run: a probe, honestly labelled — its answers come from a stub. */
const RUN = '__test-e2e-scratch';
/** The published run: the class a release is made of. */
const PUBLISHED = '__test-e2e-scratch-public';
/** A third run id, used only to prove authority does not carry across runs. */
const OTHER = '__test-e2e-scratch-other';
const REGISTER = '__test-e2e-scratch-register.json';

const CANDIDATE = 'mock/e2e-candidate';
const SEAT = 'mock/e2e-seat';
const KEY_ID = `e2e-lifecycle-${process.pid}-${randomUUID().slice(0, 12)}`;

/** Two deterministic items and one judge-graded item, so both routes are real. */
const ITEMS = ['conv-001', 'conv-002', 'tech-001'];
const JUDGED_ITEM = 'tech-001';

/** A run that is frozen forever (DATA-001). Read-only here, and asserted so. */
const HISTORICAL = '2026-07-v2.1';

const E2E_METHODOLOGY_HASH = frozenMethodologyHash();

/** The digest a permit against the REAL committed fixtures must name. */
const fixture = (name: string): string => join(PERMIT_FIXTURES_DIR, name);

/** Exactly what a production caller may say: a manifest and a methodology. */
function fixtureBinding(manifestOverrides: Record<string, unknown> = {}) {
  const manifest = JSON.parse(
    readFileSync(fixture('expired-probe.manifest.json'), 'utf8'),
  ) as Record<string, unknown>;
  return {
    manifest: { ...manifest, ...manifestOverrides },
  };
}

let scratch: string;
let signingKey: ReturnType<typeof generateKeyPairSync<'ed25519'>>['privateKey'];
let publicKeyPem: string;
const openLedgers: ReservationLedger[] = [];
const tempTrees: string[] = [];
let originalGitEnvironment: { gitDir: string | undefined; gitWorkTree: string | undefined } | null = null;

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  signingKey = pair.privateKey;
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
});

beforeEach(() => {
  process.env.OPENROUTER_API_KEY ??= 'test-key-not-used-offline';
  useRegisterFileForTest(REGISTER);
  scratch = mkdtempSync(join(tmpdir(), 'cb-lifecycle-e2e-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  for (const ledger of openLedgers.splice(0)) ledger.close();
  clearRegisterFileForTest();
  if (originalGitEnvironment !== null) {
    if (originalGitEnvironment.gitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = originalGitEnvironment.gitDir;
    if (originalGitEnvironment.gitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = originalGitEnvironment.gitWorkTree;
    originalGitEnvironment = null;
  }
  for (const runId of [RUN, PUBLISHED, OTHER]) {
    rmSync(join(RUNS_DIR, runId), { recursive: true, force: true });
  }
  rmSync(join(RUNS_DIR, REGISTER), { force: true });
  for (const tree of tempTrees.splice(0)) rmSync(tree, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function items(): Question[] {
  const byId = new Map(loadQuestions().map((q) => [q.id, q]));
  return ITEMS.map((id) => {
    const q = byId.get(id);
    if (!q) throw new Error(`fixture item ${id} has left the dataset; pick another`);
    return q;
  });
}

/**
 * Give the production committed-tree check a real HEAD without touching the
 * repository under test. Git still reads the actual scratch-run bytes from the
 * real work tree; only its object database and index live under this test's
 * temporary directory.
 */
function useIsolatedGitForRelease(): void {
  if (originalGitEnvironment !== null) throw new Error('isolated git is already active');
  originalGitEnvironment = {
    gitDir: process.env.GIT_DIR,
    gitWorkTree: process.env.GIT_WORK_TREE,
  };
  const isolatedWorktree = join(scratch, 'release-git');
  const initEnvironment = { ...process.env };
  delete initEnvironment.GIT_DIR;
  delete initEnvironment.GIT_WORK_TREE;
  execFileSync('git', ['init', '--quiet', isolatedWorktree], {
    cwd: REPO_ROOT,
    env: initEnvironment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.env.GIT_DIR = join(isolatedWorktree, '.git');
  process.env.GIT_WORK_TREE = REPO_ROOT;
  execFileSync('git', ['config', 'user.name', 'CookingBench lifecycle test'], { cwd: REPO_ROOT });
  execFileSync('git', ['config', 'user.email', 'lifecycle-test@invalid.local'], { cwd: REPO_ROOT });
}

function commitScratchRun(runId: string, message: string): void {
  execFileSync('git', ['add', '-f', '--', `data/runs/${runId}`], { cwd: REPO_ROOT });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: REPO_ROOT });
}

function draft(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    runId,
    methodologyVersion: 'v3.0',
    schemaVersion: '1',
    parentArtifacts: [],
    // A probe, produced from a stubbed provider: `mock` is the truthful origin
    // and it is what keeps the artifact out of any ranking.
    evidenceClass: 'development-probe',
    artifactOrigin: ['mock'],
    releaseState: 'draft',
    rankEligible: false,
    candidateRoutes: [{ modelId: CANDIDATE, provider: 'mock', baseModelFamily: 'e2e' }],
    judgeRoutes: [{ modelId: SEAT, provider: 'mock', baseModelFamily: 'e2e-seat' }],
    generationSettings: {
      temperature: 0,
      maxTokens: 16000,
      maxTokensRecipe: 32000,
      repeats: 1,
      repeatPolicy: 'single',
    },
    callPlan: { concurrency: 1, maxAttempts: 3, abortOn: [] },
    budgetCapUsd: 5,
    ...overrides,
  };
}

/** The shape a release is made of. Never executable — no permit kind grants it inference. */
const PUBLIC_RELEASE = Object.freeze({
  evidenceClass: 'public-release',
  artifactOrigin: ['live-provider'],
  releaseState: 'released',
  rankEligible: true,
});

/** Write a run's manifest through the production writer and return it. */
function seedManifest(runId: string, overrides: Record<string, unknown> = {}) {
  const qs = items();
  const { manifest } = buildRunManifest(draft(runId, overrides), qs);
  writeRunManifest(runId, manifest, qs);
  return manifest;
}

function signedPermit(
  manifest: unknown,
  overrides: Record<string, unknown> = {},
): { permit: Record<string, unknown>; signature: string; keyId: string } {
  const permit: Record<string, unknown> = {
    permitVersion: 1,
    permitId: 'permit-e2e-lifecycle-1',
    kind: 'development-probe',
    manifestHash: manifestHash(manifest),
    methodologyHash: E2E_METHODOLOGY_HASH,
    capabilities: ['candidate-inference', 'judge-inference'],
    cells: ITEMS.map((questionId) => ({ modelId: CANDIDATE, questionId })),
    budgetCapUsd: 1,
    reservationScope: 'call',
    issuer: 'wp-0 acceptance test',
    approver: 'wp-0 acceptance test',
    approvalEvidence: 'packages/runner/test/lifecycle-e2e.test.ts',
    notBefore: '2020-01-01T00:00:00Z',
    notAfter: '2099-01-01T00:00:00Z',
    executionLimit: 1,
    ...overrides,
  };
  return {
    permit,
    // Signed over the canonical JSON of the body exactly as written — which is
    // what verification checks, before it parses a single field of it.
    signature: signBytes(null, Buffer.from(canonicalJson(permit), 'utf8'), signingKey).toString('base64'),
    keyId: KEY_ID,
  };
}

function grantFor(
  manifest: unknown,
  overrides: Record<string, unknown> = {},
): VerifiedGrant {
  return verifyWithInstalledPublicKey(
    KEY_ID,
    publicKeyPem,
    {
      signedPermit: signedPermit(manifest, overrides),
      manifest,
    },
  ).grant;
}

function ledgerFor(grant: VerifiedGrant, runId: string): ReservationLedger {
  const ledger = ReservationLedger.forGrant(grant, runId);
  openLedgers.push(ledger);
  return ledger;
}

/** A provider that never was. Every completion in this file comes from here. */
function stubCompletion(body: unknown, status = 200) {
  const spy = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

function answerBody(content: string, costUsd: number | undefined) {
  return {
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 34, ...(costUsd === undefined ? {} : { cost: costUsd }) },
  };
}

/** A fault-deduction ballot, in the shape `parseJudgeResponse` accepts. */
const JUDGE_BALLOT_TEXT = JSON.stringify({
  findings: [{ quote: 'whisk it hot', issue: 'no warning about heat', severity: 'minor' }],
  summary: 'sound rescue, one omission',
  confidence: 0.8,
});

function runConfig(runId: string, overrides: Record<string, unknown> = {}): RunConfig {
  return {
    runId,
    models: [CANDIDATE],
    temperature: 0,
    maxTokens: 16000,
    maxTokensRecipe: 32000,
    budgetUsdTotal: 5,
    budgetUsdPerModel: 5,
    concurrency: 1,
    judgeModel: SEAT,
    judgePanel: [SEAT],
    judgePromptVersion: JUDGE_PROMPT_VERSIONS.fault,
    methodologyVersion: 'v3.0',
    // Read by the firewall to decide whether the directory is still writable.
    // Absent, a run that has a board freezes — which is right for a release and
    // wrong for a run that is still being assembled.
    releaseState: 'draft',
    batches: [
      {
        startedAt: '2026-07-31T00:00:00Z',
        models: [CANDIDATE],
        maxTokens: 16000,
        maxTokensRecipe: 32000,
        budgetUsdTotal: 5,
      },
    ],
    ...overrides,
  } as unknown as RunConfig;
}

function storedResponse(runId: string, questionId: string, costUsd = 0.01): StoredResponse {
  return {
    runId,
    modelId: CANDIDATE,
    questionId,
    answerText: `answer for ${questionId}`,
    raw: { choices: [{ finish_reason: 'stop' }] },
    tokensIn: 12,
    tokensOut: 34,
    costUsd,
    latencyMs: 5,
    finishReason: 'stop',
  };
}

function scoreFor(runId: string, question: Question, judged: boolean): Score {
  return {
    runId,
    modelId: CANDIDATE,
    questionId: question.id,
    score: 90,
    graderType: question.grader.type,
    detail: { note: 'offline acceptance fixture' },
    ...(judged ? { judgeModel: SEAT } : {}),
  };
}

/**
 * Everything a release checklist reads, written through the production writers.
 *
 * Deliberately NOT a shortcut around the gate: the gate reads these artifacts,
 * it does not take them as arguments. What is supplied here is evidence; what
 * is under test is what the gate concludes from it.
 */
function assembleArtifacts(runId: string, inheritedResponses = false, derivedFrom?: unknown): void {
  const qs = items();
  const storedManifest = readRunManifest(runId);
  const publicationGrant =
    storedManifest.evidenceClass === 'public-release'
      ? mintTestGrant({
          permitId: `permit-publish-${runId}`,
          kind: 'publication',
          capabilities: ['publication'],
          runId,
          manifest: storedManifest,
        })
      : undefined;
  mergeRunConfig(runConfig(runId, derivedFrom === undefined ? {} : { derivedFrom }));
  writeRunFileAtomic(
    runId,
    'calibration.json',
    `${JSON.stringify({
      judgeModel: SEAT,
      judgePanel: [SEAT],
      judgePromptVersion: JUDGE_PROMPT_VERSIONS.fault,
      atIso: '2026-07-31T00:00:00.000Z',
      mae: 0,
      passed: true,
      costUsd: 0,
      judges: [],
    }, null, 2)}\n`,
  );
  if (inheritedResponses) {
    for (const response of readResponses(runId)) {
      const id = responseIdentity(response);
      appendJournalEntry(
        runId,
        ANSWER_JOURNAL,
        id,
        { ...response, responseId: id, inheritedFrom: response.runId },
        new Date('2026-07-31T00:00:00Z'),
      );
    }
  } else {
    for (const q of qs) {
      const response = storedResponse(runId, q.id);
      writeResponse(response);
      appendRawAnswer(response);
    }
  }
  appendBallot(
    { runId, modelId: CANDIDATE, questionId: JUDGED_ITEM, judgeModelId: SEAT, promptVersion: JUDGE_PROMPT_VERSIONS.fault },
    { score: 95, findings: [] },
  );
  const responses = readResponses(runId);
  const scores = qs.map((q) => scoreFor(runId, q, q.id === JUDGED_ITEM));
  writeScores(runId, scores);
  // An honestly empty queue: one judged answer, one seat recorded, no
  // cross-seat disagreement to adjudicate. An UNBUILT queue is not an empty
  // one, which is why the file has to exist at all.
  writeRunFileAtomic(
    runId,
    ADJUDICATION_QUEUE_FILE,
    `${JSON.stringify({ version: 1, runId, policy: {}, cases: [], population: [], queueHash: '' }, null, 2)}\n`,
  );
  const verdict = assertPublicationAllowed('artifact', {
    requestedRunId: runId,
    grant: publicationGrant,
  });
  writeAnalysis(runId, analyzeRun(runId, qs, responses, scores), publicationGrant);
  writeLeaderboard(
    runId,
    buildLeaderboard(
      runId,
      [{ id: CANDIDATE, displayName: 'E2E candidate', provider: 'mock', family: 'e2e' }],
      qs,
      responses,
      scores,
      'v3.0',
      {
        evidenceClass: verdict.manifest.evidenceClass,
        releaseState: verdict.manifest.releaseState,
        rankEligible: verdict.manifest.rankEligible,
        manifestHash: verdict.manifestHash,
        nonScoringBanner: verdict.nonScoringBanner,
      },
    ),
    publicationGrant,
  );
}

/**
 * Build the baseline used by reader atomicity tests through the production
 * derivation, lifecycle and publication writers.
 *
 * The negative test mutates this one valid release after `setCurrentRun` has
 * produced the exact full artifact pin set. That keeps a missing companion
 * from being mistaken for the behavior under test.
 */
function buildProductionReleaseFixture(): ReturnType<typeof setCurrentRun> {
  seedManifest(RUN);
  assembleArtifacts(RUN);

  useIsolatedGitForRelease();
  commitScratchRun(RUN, 'reader fixture source');
  const derivation = deriveRun({
    sourceRunId: RUN,
    targetRunId: PUBLISHED,
    reason: 'reader atomicity fixture',
    now: new Date('2026-07-31T00:00:00Z'),
  });

  const manifest = seedManifest(PUBLISHED, {
    ...PUBLIC_RELEASE,
    parentArtifacts: [RUN],
  });
  assembleArtifacts(PUBLISHED, true, derivation.record.derivedFrom);
  registerRun({
    runId: PUBLISHED,
    manifest,
    actor: 'jordan',
    evidence: 'reader fixture registered',
  });
  transitionRun({
    runId: PUBLISHED,
    to: 'audited',
    actor: 'jordan',
    evidence: 'reader fixture audited',
  });

  commitScratchRun(PUBLISHED, 'audited reader fixture');
  const preRelease = buildReleaseChecklist(PUBLISHED);
  expect(preRelease.items.filter((item) => item.verdict !== 'pass')).toEqual([]);
  transitionRun({
    runId: PUBLISHED,
    to: 'released',
    actor: 'jordan',
    evidence: 'reader fixture released',
    now: new Date('2026-07-31T00:00:00Z'),
  });
  commitScratchRun(PUBLISHED, 'released reader fixture');

  const pointer = setCurrentRun({
    runId: PUBLISHED,
    reviewedBy: 'jordan',
    reviewEvidence: 'reviewed the complete reader fixture',
    now: new Date('2026-07-31T00:00:00Z'),
  });
  expect(pointer.artifacts.map((artifact) => artifact.file).sort()).toEqual(
    [...PUBLISHED_ARTIFACTS].sort(),
  );
  expect(readCurrentRun().runId).toBe(PUBLISHED);
  return pointer;
}

/** The thrown refusal, or a loud failure. Never `expect(...).toThrow()` alone. */
function refusal(fn: () => unknown): { code: string; message: string; name: string } {
  try {
    fn();
  } catch (e) {
    const error = e as Error & { code?: string };
    return { code: error.code ?? '(none)', message: error.message, name: error.name };
  }
  throw new Error('expected a refusal, but the call succeeded');
}

async function asyncRefusal(fn: () => Promise<unknown>): Promise<{ code: string; message: string; name: string }> {
  try {
    await fn();
  } catch (e) {
    const error = e as Error & { code?: string };
    return { code: error.code ?? '(none)', message: error.message, name: error.name };
  }
  throw new Error('expected a refusal, but the call resolved');
}

// ===========================================================================
// THE HAPPY PATH
// ===========================================================================

describe('WP-0 lifecycle, end to end and offline', () => {
  it('carries one run from manifest to an approved, served release', async () => {
    // -- 1. THE MANIFEST EXISTS BEFORE ANY EXECUTION -----------------------
    //
    // The envelope has to be frozen first or there is nothing for an approval
    // to bind to: a permit signed after the fact authorises whatever happened.
    const manifest = seedManifest(RUN);
    const hash = manifestHash(manifest);
    expect(readFileSync(join(RUNS_DIR, RUN, 'manifest.sha256'), 'utf8').trim()).toBe(hash);
    expect(existsSync(join(RUNS_DIR, RUN, 'responses'))).toBe(false);
    // Proof the manifest PRECEDES the work: it already declares cells that do
    // not exist yet, and the completeness reading says so.
    const beforeExecution = verifyRunManifest(RUN, { expectComplete: true });
    expect(beforeExecution.ok).toBe(false);
    expect(beforeExecution.findings.map((f) => f.code)).toContain('CELL_MISSING');
    // Its own internal consistency already holds.
    expect(verifyRunManifest(RUN).ok).toBe(true);

    // -- 2/3. A SIGNED, NON-LIVE PERMIT, AND ITS VERIFICATION ---------------
    const grant = grantFor(manifest);
    expect(grant.runId).toBe(RUN);
    expect(grant.manifestHash).toBe(hash);
    expect(grant.keyId).toBe(KEY_ID);
    expect(grant.evidenceClass).toBe('development-probe');
    // A copy of a grant is not a grant: authority is membership of a registry
    // this process wrote to, not a shape a caller can reproduce.
    expect(refusal(() => assertGrantStillValid({ ...grant }, 'copied grant')).code).toBe('GRANT_NOT_MINTED');
    expect(assertGrantForRun(grant, RUN, 'happy path')).toBe(grant);

    // -- 4. REDEMPTION -----------------------------------------------------
    const redemption = redeemPermit(grant, 'lifecycle-e2e');
    expect(redemption.sequence).toBe(1);
    expect(JSON.parse(readFileSync(redemption.path, 'utf8'))).toMatchObject({
      permitId: grant.permitId,
      keyId: KEY_ID,
      manifestHash: hash,
      executionLimit: 1,
    });

    // -- 5. THE RESERVATION LEDGER -----------------------------------------
    //
    // The cap is the grant's. There is no constructor that takes a number a
    // caller chose, so the permit's budget is not advisory.
    const ledger = ledgerFor(grant, RUN);
    expect(ledger.capUsd).toBe(1);
    expect(ledger.committedUsd).toBe(0);

    // -- 6. THE CANDIDATE CALLS, AGAINST A STUBBED PROVIDER ----------------
    const candidateFetch = stubCompletion(answerBody('braise it low and slow', 0.02));
    const client = OpenRouterClient.forCandidates(grant, ledger);
    const stored: StoredResponse[] = [];
    for (const q of items()) {
      const result = await client.complete(CANDIDATE, [{ role: 'user', content: q.prompt }], {
        temperature: 0,
        maxTokens: 200,
        cell: { modelId: CANDIDATE, questionId: q.id },
        estimateUsd: 0.02,
      });
      expect(result.costBasis).toBe('provider');
      // -- 7. THE STORED ARTIFACT ------------------------------------------
      const response: StoredResponse = {
        runId: RUN,
        modelId: CANDIDATE,
        questionId: q.id,
        answerText: result.text,
        raw: result.raw,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        finishReason: result.finishReason,
      };
      writeResponse(response);
      expect(appendRawAnswer(response).appended).toBe(true);
      stored.push(response);
    }
    expect(candidateFetch).toHaveBeenCalledTimes(3);
    expect(ledger.settledUsd).toBeCloseTo(0.06, 10);
    expect(ledger.openReservations).toBe(0);
    expect(readResponses(RUN)).toHaveLength(3);
    // The journal is a chain, not a list: any deletion, reordering or edit
    // below the tail breaks it, so "append-only" is a check and not a habit.
    expect(verifyJournal(RUN, ANSWER_JOURNAL).ok).toBe(true);
    expect(readJournal(RUN, ANSWER_JOURNAL)).toHaveLength(3);

    // The answer of record is immutable in place. Losing an answer that was
    // paid for either way, loudly, beats rewriting published-shaped evidence.
    const overwrite = refusal(() =>
      writeResponse({ ...storedResponse(RUN, 'conv-001'), answerText: 'a completely different answer' }),
    );
    expect(overwrite.code).toBe('ANSWER_ALREADY_STORED');
    expect(overwrite.message).toMatch(/not replaceable in place/);

    // -- 8. RESUME UNDER AN IDENTICAL PROTOCOL: MUST SUCCEED ---------------
    //
    // The gate has to let the documented workflow through. A guard that also
    // refuses the legitimate case gets switched off within a week.
    mergeRunConfig(runConfig(RUN));
    const protocolBefore = readRunProtocol(RUN)!.protocolHash;
    mergeRunConfig(runConfig(RUN));
    expect(readRunProtocol(RUN)!.protocolHash).toBe(protocolBefore);
    // The identical envelope re-written is a no-op, not a second manifest.
    expect(writeRunManifest(RUN, manifest, items()).written).toBe(false);
    // And the identical answer re-stored books no second charge (see also the
    // duplicate-execution refusal below).
    const chargesBefore = readAttempts(RUN).filter((a) => a.settledAtIso).length;
    writeResponse(stored[0]!);
    expect(readAttempts(RUN).filter((a) => a.settledAtIso)).toHaveLength(chargesBefore);
    expect(readResponses(RUN)).toHaveLength(3);

    // -- 9. THE JUDGING FIXTURE --------------------------------------------
    const judgeFetch = stubCompletion(answerBody(JUDGE_BALLOT_TEXT, 0.01));
    const judgeClient = OpenRouterClient.forJudging(grant, ledger);
    const judged = items().find((q) => q.id === JUDGED_ITEM)!;
    expect(judgeModeOf(judged)).toBe('fault');
    const ballot = await judgeClient.complete(SEAT, [{ role: 'user', content: 'score this answer' }], {
      temperature: 0,
      maxTokens: 200,
      reasoning: { effort: 'low' },
      // The cell names the CANDIDATE whose answer is being scored, never the
      // seat: a permit authorises which answers may be bought and which may be
      // scored, and leaves seat selection to the panel.
      cell: { modelId: CANDIDATE, questionId: JUDGED_ITEM },
      estimateUsd: 0.01,
    });
    expect(judgeFetch).toHaveBeenCalledTimes(1);
    const verdict = parseJudgeResponse(judged, ballot.text);
    expect(verdict.score).toBe(95);
    expect(
      appendBallot(
        {
          runId: RUN,
          modelId: CANDIDATE,
          questionId: JUDGED_ITEM,
          judgeModelId: SEAT,
          promptVersion: JUDGE_PROMPT_VERSIONS.fault,
        },
        verdict,
      ).appended,
    ).toBe(true);
    writeScores(
      RUN,
      items().map((q) => scoreFor(RUN, q, q.id === JUDGED_ITEM)),
    );
    expect(verifyJournal(RUN, BALLOT_JOURNAL).ok).toBe(true);

    // -- 10. THE REPORT ----------------------------------------------------
    //
    // The board is written THROUGH the publication gate, which is what stamps
    // its provenance: an unstamped development board is the thing that gets
    // mistaken for a result.
    const artifactVerdict = assertPublicationAllowed('artifact', { requestedRunId: RUN });
    expect(artifactVerdict.nonScoringBanner).toBe(NON_SCORING_LABEL);
    const responses = readResponses(RUN);
    const scores = items().map((q) => scoreFor(RUN, q, q.id === JUDGED_ITEM));
    const board = buildLeaderboard(
      RUN,
      [{ id: CANDIDATE, displayName: 'E2E candidate', provider: 'mock', family: 'e2e' }],
      items(),
      responses,
      scores,
      'v3.0',
      {
        evidenceClass: artifactVerdict.manifest.evidenceClass,
        releaseState: artifactVerdict.manifest.releaseState,
        rankEligible: artifactVerdict.manifest.rankEligible,
        manifestHash: artifactVerdict.manifestHash,
        nonScoringBanner: artifactVerdict.nonScoringBanner,
      },
    );
    expect(board.rows.length).toBeGreaterThan(0);
    writeLeaderboard(RUN, board);
    writeRunFileAtomic(
      RUN,
      ADJUDICATION_QUEUE_FILE,
      `${JSON.stringify({ version: 1, runId: RUN, policy: {}, cases: [], population: [], queueHash: '' }, null, 2)}\n`,
    );
    writeAnalysis(RUN, analyzeRun(RUN, items(), responses, scores));
    expect(verifyRunManifest(RUN, { expectComplete: true }).ok).toBe(true);

    // -- 11. THE FIXED RELEASE CHECKLIST -----------------------------------
    //
    // Its scope is a constant. `buildReleaseChecklist` takes a run id and a
    // clock; there is no parameter that removes a check, and none that decides
    // what a check means.
    registerRun({ runId: RUN, manifest, actor: 'jordan', evidence: 'acceptance test' });
    transitionRun({ runId: RUN, to: 'audited', actor: 'jordan', evidence: 'reviewed the probe' });
    const probeChecklist = buildReleaseChecklist(RUN);
    expect(probeChecklist.items.map((i) => i.id)).toEqual([...REQUIRED_RELEASE_CHECK_IDS]);
    const probeFailures = probeChecklist.items.filter((i) => i.verdict !== 'pass').map((i) => i.id);
    // A probe is NOT publishable, and the checklist says so rather than
    // inventing a reason: that is the class check doing its job.
    expect(probeFailures).toContain('evidence-class-publishable');

    // -- 12. THE RELEASE ARTIFACT ------------------------------------------
    //
    // A separate run, because no permit kind may both buy inference and bind a
    // public-release manifest (see the header). Commit the executed source to a
    // real isolated HEAD, then cross that boundary through the production
    // derivation writer. Its copied responses retain RUN as their origin.
    useIsolatedGitForRelease();
    commitScratchRun(RUN, 'executed source for public derivation');
    const derivation = deriveRun({
      sourceRunId: RUN,
      targetRunId: PUBLISHED,
      reason: 'offline lifecycle acceptance release',
      now: new Date('2026-07-31T00:00:00Z'),
    });
    expect(derivation.record.derivedFrom.runId).toBe(RUN);
    expect(derivation.record.responses).toHaveLength(ITEMS.length);

    const published = seedManifest(PUBLISHED, { ...PUBLIC_RELEASE, parentArtifacts: [RUN] });
    const publishedHash = manifestHash(published);
    assembleArtifacts(PUBLISHED, true, derivation.record.derivedFrom);
    registerRun({ runId: PUBLISHED, manifest: published, actor: 'jordan', evidence: 'acceptance test' });
    transitionRun({ runId: PUBLISHED, to: 'audited', actor: 'jordan', evidence: 'audited the board' });

    // The production gate resolves this exact directory in git's HEAD. Use a
    // real, isolated git database over the real work-tree bytes: no mock, no
    // hand-written committed verdict, and no mutation of this checkout's HEAD.
    commitScratchRun(PUBLISHED, 'audited public-release candidate');
    const checklist = buildReleaseChecklist(PUBLISHED);
    const failures = checklist.items.filter((i) => i.verdict !== 'pass');
    expect(failures).toEqual([]);
    const releaseInput = {
      runId: PUBLISHED,
      to: 'released',
      actor: 'jordan',
      evidence: 'all fixed checks reviewed; ship it',
      now: new Date('2026-07-31T00:00:00Z'),
    } as const;

    // The immutable marker must land before the register says released. A
    // planted leaf link makes that final run-scoped write fail; the register
    // must remain audited, never released-but-writable.
    const markerPath = join(RUNS_DIR, PUBLISHED, 'RELEASED');
    const outsideMarker = join(scratch, 'outside-release-marker');
    writeFileSync(outsideMarker, 'must stay untouched');
    symlinkSync(outsideMarker, markerPath);
    commitScratchRun(PUBLISHED, 'plant failing release-marker leaf');
    expect(() => transitionRun(releaseInput)).toThrow(/historical|symlink/i);
    expect(runState(PUBLISHED)).toBe('audited');
    expect(readFileSync(outsideMarker, 'utf8')).toBe('must stay untouched');
    rmSync(markerPath);
    commitScratchRun(PUBLISHED, 'remove failing release-marker leaf');

    const release = transitionRun(releaseInput);
    expect(release.checklist?.complete).toBe(true);
    expect(runState(PUBLISHED)).toBe('released');
    expect(existsSync(join(RUNS_DIR, PUBLISHED, 'RELEASED'))).toBe(true);

    // Releasing records the decision, lifecycle transition and immutable marker
    // in the run. Commit that final envelope before asking the current-pointer
    // writer to re-evaluate the evidence it is about to expose publicly.
    commitScratchRun(PUBLISHED, 'released public artifact');
    const releasedChecklist = buildReleaseChecklist(PUBLISHED);
    expect(releasedChecklist.complete).toBe(true);
    expect(releasedChecklist.items.find((i) => i.id === 'lifecycle-audited')).toMatchObject({
      verdict: 'pass',
    });

    // -- 13. THE EXPLICIT PUBLIC-RELEASE POINTER ---------------------------
    //
    // This is the production writer. Its inputs identify the reviewer and the
    // evidence; they do not supply a lifecycle state, checklist or artifact
    // digest. Those are rebuilt and pinned from the released run.
    const pointer = setCurrentRun({
      runId: PUBLISHED,
      reviewedBy: 'jordan',
      reviewEvidence: 'read the board, the analysis and the checklist',
      now: new Date('2026-07-31T00:00:00Z'),
    });
    expect(pointer.manifestHash).toBe(publishedHash);
    expect(pointer.reviewedBy).toBe('jordan');

    // -- 14. THE READ PATH SERVES IT ---------------------------------------
    const current = readCurrentRun();
    expect(current.runId).toBe(PUBLISHED);
    expect(current.artifacts.map((a) => a.file).sort()).toEqual([...PUBLISHED_ARTIFACTS].sort());

    // The website's own resolver, against a copy of the tree: a board becomes
    // current because a named human approved pinned bytes, never because its
    // timestamp happens to lead.
    const tree = mkdtempSync(join(tmpdir(), 'cb-lifecycle-tree-'));
    tempTrees.push(tree);
    mkdirSync(join(tree, PUBLISHED), { recursive: true });
    for (const file of PUBLISHED_ARTIFACTS) {
      if (file === 'responses') {
        cpSync(join(RUNS_DIR, PUBLISHED, file), join(tree, PUBLISHED, file), { recursive: true });
      } else {
        writeFileSync(join(tree, PUBLISHED, file), readFileSync(join(RUNS_DIR, PUBLISHED, file)));
      }
    }
    writeFileSync(
      join(tree, 'REGISTER.json'),
      readFileSync(join(RUNS_DIR, REGISTER), 'utf8'),
    );
    const served = resolveApprovedRelease(tree);
    expect(served?.runId).toBe(PUBLISHED);
    expect(served?.approval.kind).toBe('register');
    expect(served?.report.rows.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// THE REFUSALS — each through the production call path, each failing closed
// ===========================================================================

describe('1 — a changed prompt refuses', () => {
  it('breaks the permit binding, and invalidates the answers it elicited', () => {
    // Through the PRODUCTION loader, against committed material: a permit
    // authorises one exact envelope, and a re-rendered prompt is a different
    // envelope even though every other field is identical.
    expect(
      refusal(() =>
        verifyPermitFile(
          fixture('expired-probe.permit.json'),
          fixtureBinding({ promptHash: 'f'.repeat(64) }),
        ),
      ).code,
    ).toBe('PERMIT_MANIFEST_MISMATCH');

    // And downstream: answers were ELICITED by the prompt, so a changed prompt
    // invalidates the candidate scope, which every score depends on.
    const manifest = seedManifest(RUN);
    const stale = staleScoresForRun(RUN, { manifest: { ...manifest, promptHash: 'f'.repeat(64) } });
    expect(stale.reasons.map((r) => r.code)).toContain('PROMPT_CHANGED');
    expect(stale.invalidated.candidate).toBe('all');
    const kept = retainableScores([scoreFor(RUN, items()[0]!, false)], stale);
    expect(kept.retained).toHaveLength(0);
    expect(kept.dropped).toHaveLength(1);
  });
});

describe('2 — a changed question bank refuses', () => {
  it('cannot be swapped under a run id, and drops the scores it produced', () => {
    const manifest = seedManifest(RUN);
    // A run may not revise its bank: the permit that authorised it is bound to
    // the existing hash, so the second envelope needs a new run id.
    const swapped = buildRunManifest(draft(RUN), items().slice(0, 2)).manifest;
    const refused = refusal(() => writeRunManifest(RUN, swapped, items().slice(0, 2)));
    expect(refused.code).toBe('MANIFEST_IMMUTABLE');
    expect(refused.message).toMatch(/already has a different manifest/);

    // An edited expected value or reference answer changes how an answer is
    // SCORED without changing the answer — so the answer survives and the score
    // does not. The asymmetry is the point.
    const stale = staleScoresForRun(RUN, { manifest: { ...manifest, bankHash: 'e'.repeat(64) } });
    expect(stale.reasons.map((r) => r.code)).toContain('BANK_CHANGED');
    expect(stale.invalidated.deterministic).toBe('all');
    expect(stale.invalidated.judge).toBe('all');
    expect(stale.invalidated.candidate).toEqual([]);

    expect(
      refusal(() =>
        verifyPermitFile(fixture('expired-probe.permit.json'), fixtureBinding({ bankHash: 'e'.repeat(64) })),
      ).code,
    ).toBe('PERMIT_MANIFEST_MISMATCH');
  });
});

describe('3 — a changed model route refuses', () => {
  it('breaks the binding, and a foreign answer never passes verification', () => {
    expect(
      refusal(() =>
        verifyPermitFile(
          fixture('expired-probe.permit.json'),
          fixtureBinding({
            candidateRoutes: [{ modelId: 'mock/swapped', provider: 'mock', baseModelFamily: 'fixture' }],
          }),
        ),
      ).code,
    ).toBe('PERMIT_MANIFEST_MISMATCH');

    // The other direction: an answer from a model the manifest never declared
    // is how a substituted route would enter a run unnoticed.
    seedManifest(RUN);
    writeRunFileAtomic(
      RUN,
      join('responses', 'undeclared.json'),
      JSON.stringify({ runId: RUN, modelId: 'mock/undeclared', questionId: 'conv-001' }),
    );
    expect(verifyRunManifest(RUN).findings.map((f) => f.code)).toContain('RESPONSE_UNDECLARED_MODEL');
    expect(refusal(() => assertPublicationAllowed('artifact', { requestedRunId: RUN })).message).toMatch(
      /RESPONSE_UNDECLARED_MODEL/,
    );

    // A permit may not reach outside its own envelope either: a cell naming a
    // model the manifest does not declare is refused at verification.
    const manifest = seedManifest(OTHER);
    expect(
      refusal(() => grantFor(manifest, { cells: [{ modelId: 'mock/not-declared', questionId: 'conv-001' }] }))
        .code,
    ).toBe('PERMIT_CELLS_INCOHERENT');
  });
});

describe('4 — a changed rank-affecting setting refuses', () => {
  it('refuses a temperature or token-cap change on resume, rather than warning', () => {
    seedManifest(RUN);
    mergeRunConfig(runConfig(RUN));

    // The defect this replaces printed "⚠ temperature changed within run" and
    // merged anyway, so one run id could hold two protocols and publish one
    // leaderboard over both.
    const temperature = refusal(() => mergeRunConfig(runConfig(RUN, { temperature: 0.7 })));
    expect(temperature.code).toBe('PROTOCOL_CHANGED');
    expect(temperature.message).toMatch(/temperature: 0 → 0\.7/);

    const cap = refusal(() => mergeRunConfig(runConfig(RUN, { maxTokens: 8000 })));
    expect(cap.code).toBe('PROTOCOL_CHANGED');
    // A cap that truncates one provider and not another measures token
    // accounting, not cooking — so it is rank-affecting, and it moves the
    // rendered-prompt hash too.
    expect(cap.message).toMatch(/maxTokens/);
    expect(cap.message).toMatch(/promptHash/);

    const manifest = readRunManifest(RUN);
    const stale = staleScoresForRun(RUN, {
      manifest: { ...manifest, generationSettings: { ...manifest.generationSettings, maxTokens: 8000 } },
    });
    expect(stale.reasons.map((r) => r.code)).toContain('GENERATION_SETTINGS_CHANGED');
    expect(stale.invalidated.candidate).toBe('all');
  });
});

describe('5 — a changed code/validator hash refuses', () => {
  it('invalidates every score, and breaks the permit binding', () => {
    const manifest = seedManifest(RUN);
    // The 2026-07 grader audit is the case for this: a fixed keyword grader
    // moved six of thirteen leaderboard positions, and nothing in the artifacts
    // recorded that the scoring code had changed underneath them.
    const stale = staleScoresForRun(RUN, { manifest: { ...manifest, validatorHash: '1'.repeat(64) } });
    expect(stale.reasons.map((r) => r.code)).toContain('VALIDATOR_CHANGED');
    expect(stale.invalidated.deterministic).toBe('all');
    const judgedScore = scoreFor(RUN, items().find((q) => q.id === JUDGED_ITEM)!, true);
    expect(retainableScores([judgedScore], stale).retained).toHaveLength(0);

    // '1'×64, not 'd'×64: the fixture manifest already declares 'd'×64, and a
    // "changed" value equal to the original would prove nothing.
    expect(
      refusal(() =>
        verifyPermitFile(
          fixture('expired-probe.permit.json'),
          fixtureBinding({ validatorHash: '1'.repeat(64) }),
        ),
      ).code,
    ).toBe('PERMIT_MANIFEST_MISMATCH');
  });
});

describe('6 — a changed methodology version refuses', () => {
  it('invalidates everything, and no signature buys past the frozen revision', () => {
    const manifest = seedManifest(RUN);
    const stale = staleScoresForRun(RUN, { manifest: { ...manifest, methodologyVersion: 'v4.0' } });
    expect(stale.reasons.map((r) => r.code)).toContain('METHODOLOGY_CHANGED');
    expect(stale.invalidatesEverything).toBe(true);

    mergeRunConfig(runConfig(RUN));
    const resumed = refusal(() => mergeRunConfig(runConfig(RUN, { methodologyVersion: 'v4.0' })));
    expect(resumed.code).toBe('PROTOCOL_CHANGED');
    expect(resumed.message).toMatch(/methodologyVersion/);

    // Approval was given against a specific protocol revision, and the permit
    // names its digest. A different frozen methodology is a different approval.
    const methodologyManifest = seedManifest(OTHER);
    const wrongMethodology = refusal(() =>
      grantFor(methodologyManifest, { methodologyHash: sha256Hex('some other methodology') }),
    );
    expect(wrongMethodology.code).toBe('PERMIT_METHODOLOGY_MISMATCH');
  });
});

describe('7 — a permit issued for another run refuses', () => {
  it('refuses at verification, at the point of use, and at publication', () => {
    // Production loader, committed fixture: the run-id check runs BEFORE the
    // validity window, so this is the refusal that fires, not expiry.
    const mismatched = refusal(() =>
      verifyPermitFile(fixture('expired-probe.permit.json'), {
        ...fixtureBinding(),
        expectedRunId: RUN,
      }),
    );
    expect(mismatched.code).toBe('PERMIT_RUN_MISMATCH');
    expect(mismatched.message).toMatch(/Authority issued for one run is not authority for another/);

    // And at the moment authority is exercised, which is where a long-running
    // command actually reaches for it.
    const grant = grantFor(seedManifest(RUN));
    const atUse = refusal(() => assertGrantForRun(grant, OTHER, 'sync'));
    expect(atUse.code).toBe('PERMIT_RUN_MISMATCH');

    // Publication compared these nowhere before RELEASE-002: an approval for
    // one run was spendable on another.
    const otherManifest = seedManifest(OTHER, PUBLIC_RELEASE);
    const otherPublicationGrant = mintTestGrant({
      permitId: 'permit-publish-other-run',
      kind: 'publication',
      capabilities: ['publication'],
      runId: OTHER,
      manifest: otherManifest,
    });
    const published = refusal(() =>
      assertPublicationAllowed('public', { requestedRunId: RUN, grant: otherPublicationGrant }),
    );
    expect(published.code).toBe('RUN_IDENTITY_MISMATCH');
    expect(published.message).toMatch(/run identity disagrees/);
  });
});

describe('8 — expired authority refuses', () => {
  it('refuses a committed expired permit, and stops a process outliving its permit', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    // The committed fixture, through the production entry point, against the
    // committed keyring and the real clock. Reaching the validity window means
    // everything before it passed: signature, key, revocation, binding.
    expect(
      refusal(() => verifyPermitFile(fixture('expired-probe.permit.json'), fixtureBinding())).code,
    ).toBe('PERMIT_EXPIRED');

    // Mid-run expiry. A run takes hours; verifying once at start-up and then
    // trusting the object means a permit that expires keeps spending.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-31T00:00:00Z'));
    const grant = grantFor(
      seedManifest(RUN),
      { notAfter: '2026-08-01T00:00:00Z' },
    );
    expect(assertGrantStillValid(grant, 'before expiry')).toBe(grant);
    vi.setSystemTime(new Date('2026-08-02T00:00:00Z'));
    const expired = refusal(() => assertGrantStillValid(grant, 'after expiry'));
    expect(expired.code).toBe('PERMIT_EXPIRED');
    expect(expired.message).toMatch(/may not outlive its permit/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('9 — revoked authority refuses', () => {
  it('refuses a committed revoked permit, and bites work already in flight', async () => {
    // Revocation is checked before the validity window, so this fixture — which
    // is BOTH revoked and expired — refuses as revoked.
    expect(
      refusal(() => verifyPermitFile(fixture('revoked-probe.permit.json'), fixtureBinding())).code,
    ).toBe('PERMIT_REVOKED');

    const manifest = seedManifest(RUN);
    const grant = grantFor(manifest);
    const ledger = ledgerFor(grant, RUN);
    const fetchSpy = stubCompletion(answerBody('braised', 0.01));
    const client = OpenRouterClient.forCandidates(grant, ledger);
    await client.complete(CANDIDATE, [{ role: 'user', content: 'hi' }], {
      temperature: 0,
      maxTokens: 200,
      cell: { modelId: CANDIDATE, questionId: 'conv-001' },
      estimateUsd: 0.01,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Withdrawn while the grant is still in hand. A check that ran only at load
    // time would never see this.
    await withTemporarilyRevokedPermit(grant.permitId, () => {
      const revoked = refusal(() => assertGrantStillValid(grant, 'next call'));
      expect(revoked.code).toBe('PERMIT_REVOKED');
      expect(revoked.message).toMatch(/at the moment authority is exercised/);
    });
  });
});

describe('10 — a missing trust input, and a caller choosing its own, refuse', () => {
  it('refuses an injected keyring, clock or revocation source rather than ignoring it', () => {
    const manifest = seedManifest(RUN);
    const envelope = signedPermit(manifest);
    const base = { signedPermit: envelope, manifest };

    // THE recorded RUN-001 bypass. A caller that can name the keyring can point
    // it at a key it just minted; every later check then passes honestly
    // against inputs the caller chose.
    for (const injected of [
      { keyringDir: join(scratch, 'attacker-keys') },
      { revocationListPath: join(scratch, 'attacker-revoked.json') },
      { expectedMethodologyHash: E2E_METHODOLOGY_HASH },
      { now: new Date('2020-01-01T00:00:00Z') },
      { clock: () => new Date() },
      { trustRoot: { keyringDir: join(scratch, 'attacker-keys') } },
    ]) {
      const refused = refusal(() => verifyPermit({ ...base, ...injected } as never));
      expect(refused.code).toBe('PERMIT_TRUST_INPUT_REJECTED');
      // Refused, not ignored: a silently-dropped option reads to its author as
      // if it took effect.
      expect(refused.message).toMatch(/does not accept a keyring/);
    }

    // Own keys are not the only way in. `Object.create` hides the property on
    // the prototype chain, where a plain own-key check would miss it.
    const smuggled = Object.create({ keyringDir: join(scratch, 'attacker-keys') }) as Record<string, unknown>;
    Object.assign(smuggled, base);
    expect(refusal(() => verifyPermit(smuggled as never)).code).toBe('PERMIT_TRUST_INPUT_REJECTED');

    // No methodology input is accepted or required: production derives it
    // from the fixed plan and checksum, then reaches this fixture's expiry.
    expect(refusal(() => verifyPermitFile(fixture('expired-probe.permit.json'), fixtureBinding())).code).toBe(
      'PERMIT_EXPIRED',
    );

  });

  it('closes the substitution seams outside a test process', () => {
    seedManifest(RUN);
    const vitest = process.env.VITEST;
    const nodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      // Both of these let a caller choose a trust input — the bank hashes are
      // recomputed against, and the register a lifecycle is read out of. They
      // exist for tests and fail closed anywhere else.
      expect(refusal(() => verifyRunManifestWithOverrides(RUN, {}, { recompute: false })).code).toBe(
        'TEST_SEAM_IN_PRODUCTION',
      );
      expect(refusal(() => useRegisterFileForTest('attacker.json')).code).toBe('TEST_SEAM_IN_PRODUCTION');
    } finally {
      if (vitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = vitest;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });
});

describe('11 — a retry that would exceed the remaining budget refuses', () => {
  it('reserves per billable attempt, and stops the retry before the socket', async () => {
    // BUDGET-001: concurrent requests AND RETRIES cannot exceed the cap. One
    // reservation used to sit outside the retry loop and fund up to five POSTs,
    // so a run could spend five times its ceiling with every check passing.
    const grant = mintTestGrant({
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: CANDIDATE, questionId: 'conv-001' }],
      // Enough for one attempt at 200 tokens (~$0.010) and not two.
      budgetCapUsd: 0.015,
      runId: RUN,
    });
    const ledger = ledgerFor(grant, RUN);
    // A 502 may have followed generation, so its reservation is RETAINED, not
    // refunded — which is what makes the second attempt unaffordable.
    const fetchSpy = stubCompletion({ error: 'bad gateway' }, 502);
    const client = OpenRouterClient.forCandidates(grant, ledger);

    const refused = await asyncRefusal(() =>
      client.complete(CANDIDATE, [{ role: 'user', content: 'hi' }], {
        temperature: 0,
        maxTokens: 200,
        cell: { modelId: CANDIDATE, questionId: 'conv-001' },
        estimateUsd: 0.01,
      }),
    );
    expect(refused.name).toBe('BudgetExceededError');
    expect(refused.message).toMatch(/Budget cap reached for total/);
    // One attempt was made; the retry never reached the provider.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ledger.chargedUsd).toBeGreaterThan(0);
    expect(ledger.unreconciledUsd).toBeGreaterThan(0);
    expect(ledger.openReservations).toBe(0);
  }, 20_000);
});

describe('12 — a missing or unknown provider cost refuses to be free', () => {
  it('charges an unpriced completion at its reservation, and refuses to settle at nothing', async () => {
    const grant = mintTestGrant({
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: CANDIDATE, questionId: 'conv-001' }],
      budgetCapUsd: 1,
      runId: RUN,
    });
    const ledger = ledgerFor(grant, RUN);
    // `costUsd: json.usage?.cost ?? 0` recorded an unpriced call as free. A
    // response we cannot price is not a free response.
    const fetchSpy = stubCompletion(answerBody('braised', undefined));
    const client = OpenRouterClient.forCandidates(grant, ledger);
    const result = await client.complete(CANDIDATE, [{ role: 'user', content: 'hi' }], {
      temperature: 0,
      maxTokens: 200,
      cell: { modelId: CANDIDATE, questionId: 'conv-001' },
      estimateUsd: 0.01,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.costBasis).toBe('reserved-unreconciled');
    expect(result.costUsd).toBeGreaterThan(0);
    expect(ledger.settledUsd).toBe(0);
    expect(ledger.unreconciledUsd).toBeCloseTo(result.costUsd, 10);
    const journal = readFileSync(join(RUNS_DIR, RUN, 'spend.ndjson'), 'utf8').trim().split('\n');
    expect(JSON.parse(journal.at(-1)!)).toMatchObject({ state: 'retained-unreconciled' });

    // And the ledger itself refuses to be handed a missing cost. `?? 0` here is
    // how money that has already left the account disappears from the books.
    const reservation = ledger.reserve(CANDIDATE, 0.01);
    const unpriced = refusal(() => ledger.settle(reservation, undefined as unknown as number));
    expect(unpriced.code).toBe('COST_UNKNOWN');
    expect(unpriced.message).toMatch(/Missing provider cost is not zero cost/);
    ledger.retainUnreconciled(reservation, 'closed by the acceptance test');
  });
});

describe('13 — a duplicate retry execution stores one answer and books one charge', () => {
  it('recognises the replay instead of paying for it twice', () => {
    seedManifest(RUN);
    const response = storedResponse(RUN, 'conv-001', 0.02);

    writeResponse(response);
    writeResponse(response); // the same unit of work, delivered twice
    writeResponse({ ...response }); // and again, through a different object

    expect(readResponses(RUN)).toHaveLength(1);
    const settled = readAttempts(RUN).filter((a) => a.settledAtIso);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.costUsd).toBeCloseTo(0.02, 10);

    // The journal id IS the retry key, so the second delivery adds no record.
    expect(appendRawAnswer(response).appended).toBe(true);
    expect(appendRawAnswer(response).appended).toBe(false);
    expect(readJournal(RUN, ANSWER_JOURNAL)).toHaveLength(1);

    // A replay must be IDENTICAL. A second, different charge at the same
    // coordinate is a duplicate purchase wearing a replay's id.
    const doubleCharge = refusal(() => writeResponse({ ...response, costUsd: 0.09 }));
    expect(doubleCharge.code).toBe('ATTEMPT_ALREADY_SETTLED');
    expect(doubleCharge.message).toMatch(/duplicate purchase/);
    expect(readAttempts(RUN).filter((a) => a.settledAtIso)).toHaveLength(1);

    // A single-use permit cannot be redeemed a second time either.
    const grant = mintTestGrant({
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: CANDIDATE, questionId: 'conv-001' }],
      runId: RUN,
      executionLimit: 1,
    });
    expect(redeemPermit(grant, 'first').sequence).toBe(1);
    const second = refusal(() => redeemPermit(grant, 'replay'));
    expect(second.code).toBe('PERMIT_EXHAUSTED');
  });
});

describe('14 — an incomplete or invented checklist refuses', () => {
  it('refuses a run whose evidence is missing, and a list that invents its own scope', () => {
    const manifest = seedManifest(PUBLISHED, PUBLIC_RELEASE);
    registerRun({ runId: PUBLISHED, manifest, actor: 'jordan', evidence: 'acceptance test' });
    transitionRun({ runId: PUBLISHED, to: 'audited', actor: 'jordan', evidence: 'audited' });

    // A bare run: no coverage, no journals, no board. Every one of those is a
    // named failure rather than a blank.
    const bare = refusal(() =>
      transitionRun({ runId: PUBLISHED, to: 'released', actor: 'jordan', evidence: 'ship it' }),
    );
    expect(bare.code).toBe('CHECKLIST_INCOMPLETE');
    for (const id of ['coverage-complete', 'journals-intact', 'board-present', 'adjudications-resolved']) {
      expect(bare.message).toMatch(new RegExp(id));
    }
    expect(runState(PUBLISHED)).toBe('audited');

    // The invented checklist. `checklistComplete` used to accept any non-empty
    // list of passing items, so `[{ verdict: 'pass' }]` released a run.
    const invented: ReleaseChecklist = {
      checklistVersion: 1,
      runId: PUBLISHED,
      generatedAt: new Date().toISOString(),
      manifestHash: manifestHash(manifest),
      items: [{ id: 'everything-is-fine', statement: 'trust me', verdict: 'pass', detail: 'ok' }],
      complete: true,
    };
    const shortfall = checklistShortfall(invented);
    expect(shortfall).toContain(
      "check 'everything-is-fine' is not one of the required checks and cannot stand in for one",
    );
    for (const id of REQUIRED_RELEASE_CHECK_IDS) {
      expect(shortfall).toContain(`required check '${id}' is missing`);
    }

    // And handing that list to the gate changes nothing: the gate rebuilds the
    // checklist from the run. A caller may supply an approver; never a result.
    const supplied = refusal(() =>
      transitionRun({
        runId: PUBLISHED,
        to: 'released',
        actor: 'jordan',
        evidence: 'ship it',
        checklist: invented,
      } as unknown as Parameters<typeof transitionRun>[0]),
    );
    expect(supplied.code).toBe('CHECKLIST_INCOMPLETE');
    expect(existsSync(join(RUNS_DIR, PUBLISHED, 'RELEASED'))).toBe(false);
  });
});

describe('15 — unapproved publication refuses', () => {
  it('refuses an unregistered run, an unreleased run, and a permit without the capability', () => {
    const manifest = seedManifest(PUBLISHED, PUBLIC_RELEASE);
    assembleArtifacts(PUBLISHED);
    const publicGrant = mintTestGrant({
      permitId: 'permit-publish-unapproved',
      kind: 'publication',
      capabilities: ['publication'],
      runId: PUBLISHED,
      manifest,
    });

    // A publishable CLASS is not an approval. Nothing has been reviewed.
    const unregistered = refusal(() =>
      assertPublicationAllowed('public', { requestedRunId: PUBLISHED, grant: publicGrant }),
    );
    expect(unregistered.code).toBe('RUN_NOT_REGISTERED');

    registerRun({ runId: PUBLISHED, manifest, actor: 'jordan', evidence: 'acceptance test' });
    const draftState = refusal(() =>
      assertPublicationAllowed('public', { requestedRunId: PUBLISHED, grant: publicGrant }),
    );
    expect(draftState.code).toBe('NOT_RELEASED');

    // "No permit" is not "any run".
    expect(refusal(() => assertPublicationAllowed('public', { requestedRunId: PUBLISHED })).code).toBe(
      'NOT_PUBLISHABLE',
    );

    // The pointer cannot be set from an unreleased run, whatever a caller says
    // about having reviewed it.
    const pointer = refusal(() =>
      setCurrentRun({ runId: PUBLISHED, reviewedBy: 'jordan', reviewEvidence: 'looks fine' }),
    );
    expect(pointer.code).toBe('NOT_RELEASED');

    // And a probe permit does not carry publication authority at all: the kind
    // matrix caps what a valid signature can ever grant.
    const probe = mintTestGrant({
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: CANDIDATE, questionId: 'conv-001' }],
      runId: RUN,
    });
    expect(probe.capabilities).not.toContain('publication');
    const overreach = refusal(() =>
      mintTestGrant({
        kind: 'development-probe',
        capabilities: ['publication'],
        cells: [],
        runId: RUN,
      }),
    );
    expect(overreach.code).toBe('PERMIT_KIND_FORBIDS_CAPABILITY');
  });
});

describe('16 — partial publication refuses: no reader sees a mixed version', () => {
  it('refuses a changed, missing or unpinned artifact under a live pointer', () => {
    const pointer = buildProductionReleaseFixture();
    const registerPath = join(RUNS_DIR, REGISTER);
    const baselineRegister = JSON.parse(readFileSync(registerPath, 'utf8')) as {
      currentRun: typeof pointer;
      [key: string]: unknown;
    };

    const registerWith = (artifacts: Array<{ file: string; sha256: string }>): void => {
      writeFileSync(
        registerPath,
        JSON.stringify({
          ...baselineRegister,
          currentRun: { ...pointer, artifacts },
        }),
      );
    };

    // The production writer pinned the whole set and the reader resolves it.
    expect(readCurrentRun().runId).toBe(PUBLISHED);

    // Half a release: one approved artifact has gone. Serving the rest would be
    // a board with no analysis behind it.
    const analysisPath = join(RUNS_DIR, PUBLISHED, 'analysis.json');
    const analysisBytes = readFileSync(analysisPath);
    rmSync(analysisPath);
    const missing = refusal(() => readCurrentRun());
    expect(missing.code).toBe('ARTIFACT_MISSING');
    expect(missing.message).toMatch(/no longer present/);
    writeFileSync(analysisPath, analysisBytes);
    expect(readCurrentRun().runId).toBe(PUBLISHED);

    // The response directory is one pinned set, not an unbounded collection of
    // individually trusted filenames. Changing one answer, removing one, or
    // adding a copied answer all change the set commitment.
    const responseDir = join(RUNS_DIR, PUBLISHED, 'responses');
    const responseName = readdirSync(responseDir).sort()[0]!;
    const responsePath = join(responseDir, responseName);
    const responseBytes = readFileSync(responsePath);
    writeFileSync(responsePath, Buffer.concat([responseBytes, Buffer.from('\n')]));
    expect(refusal(() => readCurrentRun()).code).toBe('ARTIFACT_CHANGED');
    writeFileSync(responsePath, responseBytes);

    rmSync(responsePath);
    expect(refusal(() => readCurrentRun()).code).toBe('ARTIFACT_CHANGED');
    writeFileSync(responsePath, responseBytes);

    const copied = join(responseDir, 'copied-extra.json');
    writeFileSync(copied, responseBytes);
    expect(refusal(() => readCurrentRun()).code).toBe('ARTIFACT_CHANGED');
    rmSync(copied);
    expect(readCurrentRun().runId).toBe(PUBLISHED);

    // One file REPLACED under a live pointer. The artifacts are written one at
    // a time, so this is exactly how a reader would catch a board from one
    // version beside an analysis from another.
    writeFileSync(
      join(RUNS_DIR, PUBLISHED, 'leaderboard.json'),
      JSON.stringify({ runId: PUBLISHED, rows: [{ modelId: 'tampered' }] }),
    );
    const changed = refusal(() => readCurrentRun());
    expect(changed.code).toBe('ARTIFACT_CHANGED');
    expect(changed.message).toMatch(/would show a mixture of two releases/);

    // A pointer that pins nothing covers nothing: the digest loop simply would
    // not run, which is the cheapest possible forgery of an approval.
    registerWith([]);
    const unpinned = refusal(() => readCurrentRun());
    expect(unpinned.code).toBe('ARTIFACT_MISSING');
    expect(unpinned.message).toMatch(/pins no digest for/);
  });
});

describe('17 — modifying the frozen historical corpus refuses', () => {
  it('refuses every writer that could reach a published run', () => {
    expect(isHistoricalRun(HISTORICAL)).toBe(true);
    const before = readFileSync(join(RUNS_DIR, HISTORICAL, 'leaderboard.json'), 'utf8');

    // The directory resolver is the choke point: nothing downstream can write
    // without passing through it.
    const dir = refusal(() => resolveRunDir(HISTORICAL, { write: true }));
    expect(dir.code).toBe('HISTORICAL_WRITE');
    expect(dir.message).toMatch(/historical and immutable \(DATA-001\)/);

    // A permit for a frozen run cannot even record its own redemption, and a
    // ledger for one refuses to construct — the write target is preflighted
    // before a single call is authorised, not discovered after the money has
    // gone.
    const frozenGrant = mintTestGrant({
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: CANDIDATE, questionId: 'conv-001' }],
      runId: HISTORICAL,
    });

    for (const attempt of [
      () => writeRunFileAtomic(HISTORICAL, 'scores.json', '[]'),
      () => writeScores(HISTORICAL, []),
      () => writeLeaderboard(HISTORICAL, { runId: HISTORICAL, rows: [] }),
      () => writeResponse(storedResponse(HISTORICAL, 'conv-001')),
      () => writeRunFileAtomic(HISTORICAL, join('responses', 'injected.json'), '{}'),
      () => appendRawAnswer(storedResponse(HISTORICAL, 'conv-001')),
      () => writeReleaseChecklist(HISTORICAL, buildReleaseChecklist(HISTORICAL)),
      () => redeemPermit(frozenGrant, 'attempted write into a frozen run'),
      () => ReservationLedger.forGrant(frozenGrant, HISTORICAL),
    ]) {
      expect(refusal(attempt).code).toBe('HISTORICAL_WRITE');
    }

    // `mergeRunConfig` refuses too, but for a different reason and BEFORE it
    // reaches the firewall: the published run is committed to a protocol this
    // config does not match. Asserted separately so a refusal for an unrelated
    // reason cannot stand in for the immutability one above.
    expect(refusal(() => mergeRunConfig(runConfig(HISTORICAL))).code).toBe('PROTOCOL_CHANGED');

    // Reads are fine, and the bytes are untouched — a refusal that quietly
    // half-wrote first would be worse than none.
    expect(readFileSync(join(RUNS_DIR, HISTORICAL, 'leaderboard.json'), 'utf8')).toBe(before);
    expect(existsSync(join(RUNS_DIR, HISTORICAL, 'responses', 'injected.json'))).toBe(false);
    expect(readResponses(HISTORICAL).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// WHAT THIS FILE DOES NOT PROVE
// ===========================================================================
//
// Recorded here rather than left for a reader to discover, because a lifecycle
// test that LOOKS complete is worth less than one that says where it stops.
//
//  1. Nothing in this file proves the pipeline COMMANDS (`bench run`,
//     `bench judge`, `bench report`) call these boundaries. It proves the
//     boundaries hold when they are called. `cli.ts` wiring is a separate claim
//     and needs its own test.
//  2. No real provider, database or key is contacted, so provider-side
//     behaviour — the actual billing of a retained 502, a genuine content
//     filter — is modelled, not observed.
