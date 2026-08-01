import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NON_SCORING_LABEL,
  canonicalJson,
  type Question,
  type RunConfig,
  type Score,
  type StoredResponse,
} from '@cookingbench/core';
import { analyzeRun, writeAnalysis, type RunAnalysis } from '../src/analyze.js';
import { ADJUDICATION_QUEUE_FILE } from '../src/adjudicate.js';
import { REPO_ROOT, RUNS_DIR, loadQuestions } from '../src/dataset.js';
import { deriveRun } from '../src/derive.js';
import { readProvenance, writeRunFileAtomic } from '../src/firewall.js';
import { manifestHash, sha256Hex } from '../src/permit.js';
import {
  ManifestError,
  assertRunIdentity,
  buildRunManifest,
  readRunManifest,
  validatorDigest,
  verifyRunManifest,
  verifyRunManifestWithOverrides,
  writeRunManifest,
} from '../src/manifest.js';
import {
  ANSWER_JOURNAL,
  BALLOT_JOURNAL,
  LifecycleError,
  PUBLISHED_ARTIFACTS,
  REQUIRED_RELEASE_CHECK_IDS,
  appendBallot,
  appendJournalEntry,
  assertPublicationAllowed,
  buildReleaseChecklist,
  checklistComplete,
  checklistShortfall,
  clearRegisterFileForTest,
  journalProblemsForRelease,
  readCurrentRun,
  readReleaseRegister,
  publishedArtifactDigest,
  registerRun,
  responseIdentity,
  runState,
  safeReadCurrentRun,
  setCurrentRun,
  transitionRun,
  useRegisterFileForTest,
  verifyJournal,
  type ReleaseChecklist,
} from '../src/lifecycle.js';
import { buildLeaderboard } from '../src/report.js';
import {
  mergeRunConfig,
  readResponses,
  writeLeaderboard,
  writeResponse,
  writeScores,
} from '../src/store.js';
import { resolveApprovedRelease } from '../../../apps/web/lib/data.js';
import { mintTestGrant } from './support/grant.js';

/**
 * RELEASE-002 and the DATA-002 gaps that hang off it.
 *
 * Offline by construction: filesystem scratch space under data/runs, a
 * throwaway tree under the OS temp dir for the website reader, hashing, and one
 * `git status` on a directory git already knows about. No socket, no secret, no
 * model call.
 *
 * Every test here is an attempt to BREAK a guard rather than a demonstration
 * that it works, and each one goes through the REAL production entry point. The
 * interesting cases are the checklist that certifies its own scope, the caller
 * that hands the gate a passing verdict, the empty journal that reads as an
 * intact one, the approval spent on a different run, and the board that becomes
 * public by having the newest timestamp.
 */

const RUN = '__test-release-run';
const OTHER = '__test-release-other';
const REGISTER = '__test-release-register.json';

const ITEMS = ['conv-001', 'conv-002', 'conv-003'];

function slice(ids: string[]): Question[] {
  const byId = new Map(loadQuestions().map((q) => [q.id, q]));
  return ids.map((id) => {
    const q = byId.get(id);
    if (!q) throw new Error(`fixture item ${id} is no longer in the dataset`);
    return q;
  });
}

function draft(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    runId,
    methodologyVersion: 'v3.0',
    schemaVersion: '1',
    parentArtifacts: [],
    evidenceClass: 'development',
    artifactOrigin: ['agent-authored'],
    releaseState: 'draft',
    rankEligible: false,
    candidateRoutes: [
      { modelId: 'meta-llama/llama-4-maverick', provider: 'meta', baseModelFamily: 'llama-4' },
    ],
    judgeRoutes: [{ modelId: 'x-ai/grok-4.5', provider: 'xai', baseModelFamily: 'grok-frontier' }],
    generationSettings: {
      temperature: 0,
      maxTokens: 16000,
      maxTokensRecipe: 32000,
      repeats: 1,
      repeatPolicy: 'single',
    },
    callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
    budgetCapUsd: 5,
    ...overrides,
  };
}

/** A run with a written manifest. Nothing else — every other check should fail. */
function seedRun(runId = RUN, overrides: Record<string, unknown> = {}): string {
  const items = slice(ITEMS);
  const { manifest } = buildRunManifest(draft(runId, overrides), items);
  writeRunManifest(runId, manifest, items);
  return manifestHash(manifest);
}

function publicationGrant(runId: string) {
  const manifest = readRunManifest(runId);
  return mintTestGrant({
    permitId: `permit-release-${runId}`,
    kind: 'publication',
    capabilities: ['publication'],
    runId,
    manifest,
  });
}

const PUBLIC_RELEASE = Object.freeze({
  evidenceClass: 'public-release',
  artifactOrigin: ['live-provider'],
  releaseState: 'released',
  rankEligible: true,
});

function seedPublicRelease(runId = RUN, overrides: Record<string, unknown> = {}): string {
  return seedRun(runId, { ...PUBLIC_RELEASE, ...overrides });
}

/** Both public artifact writers, called exactly as an importing production caller can call them. */
function publicArtifactWriters(runId: string, grant?: unknown) {
  return [
    {
      file: 'analysis.json',
      write: () => writeAnalysis(runId, { runId } as RunAnalysis, grant),
    },
    {
      file: 'leaderboard.json',
      write: () => writeLeaderboard(runId, { runId, rows: [] }, grant),
    },
  ] as const;
}

function writerRefusal(write: () => void): { code: string; message: string } {
  try {
    write();
  } catch (error) {
    const refusal = error as Error & { code?: string };
    return { code: refusal.code ?? '(none)', message: refusal.message };
  }
  throw new Error('expected the public artifact writer to refuse');
}

let fixtureGitState: { gitDir: string | undefined; gitWorkTree: string | undefined } | null = null;
let fixtureGitRoot: string | null = null;

function useIsolatedFixtureGit(): void {
  if (fixtureGitState !== null) throw new Error('fixture git is already active');
  fixtureGitState = {
    gitDir: process.env.GIT_DIR,
    gitWorkTree: process.env.GIT_WORK_TREE,
  };
  fixtureGitRoot = mkdtempSync(join(tmpdir(), 'cookingbench-release-git-'));
  const env = { ...process.env };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  execFileSync('git', ['init', '--quiet', fixtureGitRoot], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.env.GIT_DIR = join(fixtureGitRoot, '.git');
  process.env.GIT_WORK_TREE = REPO_ROOT;
  execFileSync('git', ['config', 'user.name', 'CookingBench release fixture'], { cwd: REPO_ROOT });
  execFileSync('git', ['config', 'user.email', 'release-fixture@invalid.local'], {
    cwd: REPO_ROOT,
  });
}

function commitFixtureRun(runId: string, message: string): void {
  execFileSync('git', ['add', '-f', '--', `data/runs/${runId}`], { cwd: REPO_ROOT });
  execFileSync('git', ['commit', '--quiet', '-m', message], { cwd: REPO_ROOT });
}

function fixtureRunConfig(runId: string, derivedFrom?: unknown): RunConfig {
  return {
    runId,
    models: ['meta-llama/llama-4-maverick'],
    temperature: 0,
    maxTokens: 16000,
    maxTokensRecipe: 32000,
    budgetUsdTotal: 5,
    budgetUsdPerModel: 5,
    concurrency: 1,
    judgeModel: 'x-ai/grok-4.5',
    judgePanel: ['x-ai/grok-4.5'],
    judgePromptVersion: 'judge-v2',
    methodologyVersion: 'v3.0',
    releaseState: 'draft',
    ...(derivedFrom === undefined ? {} : { derivedFrom }),
  } as unknown as RunConfig;
}

function fixtureResponse(runId: string): StoredResponse {
  return {
    runId,
    modelId: 'meta-llama/llama-4-maverick',
    questionId: 'tech-001',
    answerText: 'Use a controlled low heat and verify the texture before serving.',
    raw: { choices: [{ finish_reason: 'stop' }] },
    tokensIn: 12,
    tokensOut: 14,
    costUsd: 0.01,
    latencyMs: 5,
    finishReason: 'stop',
  };
}

/** Build a real released/current run through production writers for reader tests. */
function buildProductionReleaseFixture(): ReturnType<typeof setCurrentRun> {
  const questions = slice(['tech-001']);
  const { manifest: sourceManifest } = buildRunManifest(
    draft(OTHER, {
      candidateRoutes: [
        {
          modelId: 'meta-llama/llama-4-maverick',
          provider: 'meta',
          baseModelFamily: 'llama-4',
        },
      ],
    }),
    questions,
  );
  writeRunManifest(OTHER, sourceManifest, questions);
  mergeRunConfig(fixtureRunConfig(OTHER));
  writeResponse(fixtureResponse(OTHER));

  useIsolatedFixtureGit();
  commitFixtureRun(OTHER, 'committed release-fixture source');
  const derivation = deriveRun({
    sourceRunId: OTHER,
    targetRunId: RUN,
    reason: 'release reader fixture',
    now: new Date('2026-07-31T00:00:00Z'),
  });

  const { manifest } = buildRunManifest(
    draft(RUN, { ...PUBLIC_RELEASE, parentArtifacts: [OTHER] }),
    questions,
  );
  writeRunManifest(RUN, manifest, questions);
  mergeRunConfig(fixtureRunConfig(RUN, derivation.record.derivedFrom));
  writeRunFileAtomic(
    RUN,
    'calibration.json',
    `${JSON.stringify({ atIso: '2026-07-31T00:00:00Z', costUsd: 0, passed: true }, null, 2)}\n`,
  );

  const inherited = readResponses(RUN);
  for (const response of inherited) {
    const id = responseIdentity(response);
    appendJournalEntry(
      RUN,
      ANSWER_JOURNAL,
      id,
      { ...response, responseId: id, inheritedFrom: response.runId },
      new Date('2026-07-31T00:00:00Z'),
    );
  }
  appendBallot(
    {
      runId: RUN,
      modelId: 'meta-llama/llama-4-maverick',
      questionId: 'tech-001',
      judgeModelId: 'x-ai/grok-4.5',
      promptVersion: 'judge-v2',
    },
    { score: 90, findings: [] },
  );

  const scores: Score[] = [
    {
      runId: RUN,
      modelId: 'meta-llama/llama-4-maverick',
      questionId: 'tech-001',
      score: 90,
      graderType: questions[0]!.grader.type,
      detail: { fixture: true },
      judgeModel: 'x-ai/grok-4.5',
    },
  ];
  writeScores(RUN, scores);
  writeRunFileAtomic(
    RUN,
    ADJUDICATION_QUEUE_FILE,
    `${JSON.stringify({ version: 1, runId: RUN, policy: {}, cases: [], population: [], queueHash: '' }, null, 2)}\n`,
  );
  const grant = publicationGrant(RUN);
  writeAnalysis(RUN, analyzeRun(RUN, questions, inherited, scores), grant);
  writeLeaderboard(
    RUN,
    buildLeaderboard(
      RUN,
      [
        {
          id: 'meta-llama/llama-4-maverick',
          displayName: 'Fixture model',
          provider: 'meta',
          family: 'llama-4',
        },
      ],
      questions,
      inherited,
      scores,
      manifest.methodologyVersion,
    ),
    grant,
  );

  registerRun({ runId: RUN, manifest, actor: 'jordan', evidence: 'registered reader fixture' });
  transitionRun({
    runId: RUN,
    to: 'audited',
    actor: 'jordan',
    evidence: 'audited reader fixture',
  });
  commitFixtureRun(RUN, 'audited release reader fixture');
  const preRelease = buildReleaseChecklist(RUN);
  expect(preRelease.items.filter((item) => item.verdict !== 'pass')).toEqual([]);
  transitionRun({
    runId: RUN,
    to: 'released',
    actor: 'jordan',
    evidence: 'released reader fixture',
    now: new Date('2026-07-31T00:00:00Z'),
  });
  commitFixtureRun(RUN, 'released reader fixture');
  const pointer = setCurrentRun({
    runId: RUN,
    reviewedBy: 'jordan',
    reviewEvidence: 'reviewed the full release envelope',
    now: new Date('2026-07-31T00:00:00Z'),
  });
  expect(pointer.artifacts.map((artifact) => artifact.file).sort()).toEqual(
    [...PUBLISHED_ARTIFACTS].sort(),
  );
  expect(readCurrentRun().runId).toBe(RUN);
  return pointer;
}

beforeEach(() => {
  useRegisterFileForTest(REGISTER);
});

afterEach(() => {
  clearRegisterFileForTest();
  rmSync(join(RUNS_DIR, RUN), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, OTHER), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, REGISTER), { force: true });
  if (fixtureGitState !== null) {
    if (fixtureGitState.gitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = fixtureGitState.gitDir;
    if (fixtureGitState.gitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
    else process.env.GIT_WORK_TREE = fixtureGitState.gitWorkTree;
    fixtureGitState = null;
  }
  if (fixtureGitRoot !== null) {
    rmSync(fixtureGitRoot, { recursive: true, force: true });
    fixtureGitRoot = null;
  }
});

// ---------------------------------------------------------------------------

describe('RELEASE-002 — the checklist scope is fixed, not chosen by the caller', () => {
  it('runs every enumerated check from the run itself, with no parameter that removes one', () => {
    seedRun();
    const checklist = buildReleaseChecklist(RUN);
    // The whole list, in the declared order, every time. There is no argument
    // that could have shortened it: `buildReleaseChecklist` takes a run id.
    expect(checklist.items.map((i) => i.id)).toEqual([...REQUIRED_RELEASE_CHECK_IDS]);
    expect(checklist.items.every((i) => typeof i.detail === 'string' && i.detail !== '')).toBe(true);
  });

  it('derives the checks that used to be supplied, and fails them on a bare run', () => {
    seedRun();
    const byId = new Map(buildReleaseChecklist(RUN).items.map((i) => [i.id, i]));
    // Each of these was previously `not-checked` because nothing was passed in,
    // and a caller that passed nothing got a checklist full of blanks. They are
    // now read from the run, and on a run with no scores they FAIL.
    expect(byId.get('coverage-complete')?.verdict).not.toBe('not-checked');
    expect(byId.get('no-stale-scores')?.verdict).toBe('pass'); // nothing has drifted yet
    expect(byId.get('lifecycle-audited')?.verdict).toBe('fail');
    expect(byId.get('journals-intact')?.verdict).toBe('fail');
    expect(byId.get('adjudications-resolved')?.verdict).toBe('fail');
    expect(byId.get('board-present')?.verdict).toBe('fail');
    expect(byId.get('evidence-class-publishable')?.verdict).toBe('fail');
    expect(checklistComplete(buildReleaseChecklist(RUN))).toBe(false);
  });

  it('refuses a hand-built checklist: one passing item can no longer stand in for the list', () => {
    // This is the exact bypass the requirement names. Before the fix,
    // `checklistComplete` accepted any non-empty list of passing items.
    const invented: ReleaseChecklist = {
      checklistVersion: 1,
      runId: RUN,
      generatedAt: new Date().toISOString(),
      manifestHash: 'a'.repeat(64),
      items: [{ id: 'everything-is-fine', statement: 'trust me', verdict: 'pass', detail: 'ok' }],
      complete: true,
    };
    expect(checklistComplete(invented)).toBe(false);
    const shortfall = checklistShortfall(invented);
    expect(shortfall.some((p) => p.includes("'everything-is-fine' is not one of the required checks"))).toBe(true);
    // …and every real check is reported missing, by name.
    for (const id of REQUIRED_RELEASE_CHECK_IDS) {
      expect(shortfall.some((p) => p.includes(`required check '${id}' is missing`))).toBe(true);
    }
  });

  it('refuses a checklist that omits a single check, or repeats one to pad the list', () => {
    seedRun();
    const real = buildReleaseChecklist(RUN);
    const allPass = real.items.map((i) => ({ ...i, verdict: 'pass' as const }));

    const omitted = { ...real, items: allPass.filter((i) => i.id !== 'artifacts-committed') };
    expect(checklistShortfall(omitted)).toEqual([`required check 'artifacts-committed' is missing`]);

    const duplicated = { ...real, items: [...allPass, allPass[0]!] };
    expect(checklistShortfall(duplicated).some((p) => p.includes('appears twice'))).toBe(true);

    // The honest baseline: with every required id present and passing, and
    // nothing invented, it is accepted. Otherwise the test above proves nothing.
    expect(checklistComplete({ ...real, items: allPass })).toBe(true);
  });

  it('never trusts the stored complete flag', () => {
    const lying = {
      checklistVersion: 1,
      runId: RUN,
      generatedAt: 'now',
      manifestHash: null,
      complete: true,
      items: [{ id: 'manifest-present', statement: 'y', verdict: 'fail', detail: 'd' }],
    } as unknown as ReleaseChecklist;
    expect(checklistComplete(lying)).toBe(false);
    expect(checklistComplete({ ...lying, items: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('RELEASE-002 — a release cannot be bought with a supplied verdict', () => {
  it('refuses to release even when handed a complete-looking checklist through the real call', () => {
    const hash = seedRun();
    registerRun({ runId: RUN, manifestHash: hash, actor: 'test', evidence: 'unit test' });
    transitionRun({ runId: RUN, to: 'audited', actor: 'jordan', evidence: 'audited' });

    const fabricated: ReleaseChecklist = {
      checklistVersion: 1,
      runId: RUN,
      generatedAt: new Date().toISOString(),
      manifestHash: hash,
      items: REQUIRED_RELEASE_CHECK_IDS.map((id) => ({
        id,
        statement: 'fabricated',
        verdict: 'pass' as const,
        detail: 'fabricated',
      })),
      complete: true,
    };

    // TypeScript no longer offers the parameter; JavaScript can still pass it,
    // which is the version of this that matters. The extra property is ignored
    // and the gate rebuilds the checklist from the run.
    expect(() =>
      transitionRun({
        runId: RUN,
        to: 'released',
        actor: 'jordan',
        evidence: 'ship it',
        checklist: fabricated,
      } as unknown as Parameters<typeof transitionRun>[0]),
    ).toThrow(/not complete/);
    expect(runState(RUN)).toBe('audited');
    expect(existsSync(join(RUNS_DIR, RUN, 'RELEASED'))).toBe(false);
  });

  it('still refuses to skip the audited state, and never reopens a released run', () => {
    const hash = seedRun();
    registerRun({ runId: RUN, manifestHash: hash, actor: 'test', evidence: 'unit test' });
    expect(() => transitionRun({ runId: RUN, to: 'released', actor: 'j', evidence: 'go' })).toThrow(
      /cannot go 'draft' → 'released'/,
    );
    expect(() => transitionRun({ runId: RUN, to: 'audited', actor: '', evidence: 'x' })).toThrow(LifecycleError);
  });

  it('refuses when the run has swapped its envelope since it was registered', () => {
    const hash = seedRun();
    registerRun({ runId: RUN, manifestHash: hash, actor: 'test', evidence: 'unit test' });
    transitionRun({ runId: RUN, to: 'audited', actor: 'jordan', evidence: 'audited' });
    // A different manifest under the same run id inherits the old lifecycle
    // unless the register's binding is checked against the run on disk.
    const swapped = buildRunManifest(draft(RUN, { budgetCapUsd: 9 }), slice(ITEMS)).manifest;
    writeRunFileAtomic(RUN, 'manifest.json', `${JSON.stringify(swapped, null, 2)}\n`);
    writeRunFileAtomic(RUN, 'manifest.sha256', `${manifestHash(swapped)}\n`);
    expect(() => transitionRun({ runId: RUN, to: 'released', actor: 'j', evidence: 'go' })).toThrow(
      /the register binds/,
    );
  });

  it('ignores a caller-supplied register file on the production path', () => {
    // `file` used to be a parameter on every one of these, so a caller could
    // point the lifecycle at a register it had written itself. Passing it now
    // does nothing: the write lands in the register the test seam selected.
    const hash = seedRun();
    registerRun({
      runId: RUN,
      manifestHash: hash,
      actor: 'test',
      evidence: 'unit test',
      file: '__test-release-attacker.json',
    } as unknown as Parameters<typeof registerRun>[0]);
    expect(existsSync(join(RUNS_DIR, '__test-release-attacker.json'))).toBe(false);
    expect(readReleaseRegister().entries[RUN]?.state).toBe('draft');
  });
});

// ---------------------------------------------------------------------------

describe('RELEASE-002 — an empty journal is not an intact journal', () => {
  it('passes a chain check on an absent journal but fails the release reading', () => {
    seedRun();
    // The chain walker must call an absent journal intact — otherwise the first
    // append could never happen. That is exactly why the release gate needs its
    // own reading, and why the old checklist reported "journals intact" for a
    // run that had journalled nothing at all.
    expect(verifyJournal(RUN, ANSWER_JOURNAL).ok).toBe(true);
    expect(verifyJournal(RUN, ANSWER_JOURNAL).present).toBe(false);
    expect(journalProblemsForRelease(RUN, ANSWER_JOURNAL)[0]).toMatch(/does not exist/);

    // A file that exists but holds nothing is the same absence with a fig leaf.
    writeRunFileAtomic(RUN, ANSWER_JOURNAL, '\n');
    expect(verifyJournal(RUN, ANSWER_JOURNAL).problems).toEqual([]);
    expect(journalProblemsForRelease(RUN, ANSWER_JOURNAL)[0]).toMatch(/empty journal is not an intact journal/);

    appendJournalEntry(RUN, ANSWER_JOURNAL, 'resp_x', { a: 1 });
    expect(journalProblemsForRelease(RUN, ANSWER_JOURNAL)).toEqual([]);
  });

  it('reports a truncated or edited chain through the release reading too', () => {
    seedRun();
    appendJournalEntry(RUN, BALLOT_JOURNAL, 'ballot_1', { seat: 'a' });
    appendJournalEntry(RUN, BALLOT_JOURNAL, 'ballot_2', { seat: 'b' });
    const path = join(RUNS_DIR, RUN, BALLOT_JOURNAL);
    const lines = readFileSync(path, 'utf8').trim().split('\n');
    writeFileSync(path, `${lines[1]}\n`);
    expect(journalProblemsForRelease(RUN, BALLOT_JOURNAL)[0]).toMatch(/links to/);
  });
});

// ---------------------------------------------------------------------------

describe('RELEASE-002 — publication validation is applied, and the run does not choose it', () => {
  it('refuses a development artifact at every public path', () => {
    const hash = seedRun();
    registerRun({ runId: RUN, manifestHash: hash, actor: 'test', evidence: 'unit test' });
    const probe = mintTestGrant({
      permitId: 'permit-development-cannot-publish',
      kind: 'development-probe',
      capabilities: ['catalog-read'],
      cells: [],
      runId: RUN,
      manifest: readRunManifest(RUN),
    });
    expect(() =>
      assertPublicationAllowed('public', { requestedRunId: RUN, grant: probe }),
    ).toThrow(/stored manifest|neither publication nor result-sync|evidenceClass/);
  });

  it('refuses to act on one run under another run’s approval', () => {
    seedRun(RUN, {
      evidenceClass: 'public-release',
      artifactOrigin: ['live-provider'],
      releaseState: 'released',
      rankEligible: true,
    });
    seedRun(OTHER, {
      evidenceClass: 'public-release',
      artifactOrigin: ['live-provider'],
      releaseState: 'released',
      rankEligible: true,
    });
    const otherGrant = publicationGrant(OTHER);
    // The permit says OTHER, the request says RUN. Neither `sync` nor `publish`
    // compared these before; an approval for one run acted on another.
    expect(() =>
      assertPublicationAllowed('public', { requestedRunId: RUN, grant: otherGrant }),
    ).toThrow(/run identity disagrees/);
    // And "no permit" is not "any run".
    expect(() => assertPublicationAllowed('public', { requestedRunId: RUN })).toThrow(
      /no verified grant was established/,
    );
  });

  it('refuses an artifact write when the stored artifacts do not match the manifest', () => {
    seedRun();
    expect(() => assertPublicationAllowed('artifact', { requestedRunId: RUN })).not.toThrow();
    // A response from a model the manifest never declared.
    writeRunFileAtomic(
      RUN,
      join('responses', 'x.json'),
      JSON.stringify({ runId: RUN, modelId: 'evil/undeclared', questionId: 'conv-001' }),
    );
    expect(() => assertPublicationAllowed('artifact', { requestedRunId: RUN })).toThrow(
      /RESPONSE_UNDECLARED_MODEL/,
    );
  });

  it('refuses a run with no manifest at all, rather than treating it as legacy', () => {
    mkdirSync(join(RUNS_DIR, RUN), { recursive: true });
    expect(() => assertPublicationAllowed('artifact', { requestedRunId: RUN })).toThrow(ManifestError);
  });

  it('returns the NON-SCORING banner for the classes RELEASE-002 names', () => {
    seedRun(RUN, { evidenceClass: 'legacy-shadow', artifactOrigin: ['transformed-archive'] });
    const verdict = assertPublicationAllowed('artifact', { requestedRunId: RUN });
    expect(verdict.nonScoringBanner).toBe(NON_SCORING_LABEL);
    expect(verdict.manifestHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------

describe('RELEASE-002 — public artifact writers exercise exact authority themselves', () => {
  it('makes approval provenance a release gate, not an optional note', () => {
    const approvalCheck = () =>
      buildReleaseChecklist(RUN).items.find((item) => item.id === 'approval-provenance')!;

    seedPublicRelease();
    expect(approvalCheck()).toMatchObject({ verdict: 'fail' });
    expect(approvalCheck().detail).toMatch(/absent or empty/);

    // One authorised derived artifact does not imply approval for the other.
    const grant = publicationGrant(RUN);
    writeAnalysis(RUN, { runId: RUN } as RunAnalysis, grant);
    const validEntry = readProvenance(RUN)[0]!;
    expect(approvalCheck()).toMatchObject({ verdict: 'fail' });
    expect(approvalCheck().detail).toMatch(/bench report/);

    // A syntactically corrupt trail is an unknown approval state, never an
    // empty-but-acceptable one.
    writeRunFileAtomic(RUN, 'provenance.ndjson', '{ truncated\n');
    expect(approvalCheck()).toMatchObject({ verdict: 'fail' });
    expect(approvalCheck().detail).toMatch(/corrupt at line 1/);

    // Parse-valid provenance for another manifest is equally ineligible.
    writeRunFileAtomic(
      RUN,
      'provenance.ndjson',
      `${canonicalJson({ ...validEntry, manifestHash: 'f'.repeat(64) })}\n`,
    );
    expect(approvalCheck()).toMatchObject({ verdict: 'fail' });
    expect(approvalCheck().detail).toMatch(/bound to another run or manifest/);
  });

  it('refuses writeAnalysis and writeLeaderboard when no grant is supplied', () => {
    seedPublicRelease();

    for (const writer of publicArtifactWriters(RUN)) {
      const refusal = writerRefusal(writer.write);
      expect(refusal.code, writer.file).toBe('GRANT_NOT_MINTED');
      expect(refusal.message, writer.file).toMatch(/did not mint by verifying a signed permit/);
      expect(existsSync(join(RUNS_DIR, RUN, writer.file)), writer.file).toBe(false);
    }
    expect(readProvenance(RUN)).toEqual([]);
  });

  it('refuses copied lookalike authority at both writer boundaries', () => {
    seedPublicRelease();
    const minted = publicationGrant(RUN);
    const copied = Object.freeze({ ...minted });
    expect(copied).toEqual(minted); // same shape is deliberately not authority

    for (const writer of publicArtifactWriters(RUN, copied)) {
      const refusal = writerRefusal(writer.write);
      expect(refusal.code, writer.file).toBe('GRANT_NOT_MINTED');
      expect(refusal.message, writer.file).toMatch(/identity, not by shape/);
      expect(existsSync(join(RUNS_DIR, RUN, writer.file)), writer.file).toBe(false);
    }
    expect(readProvenance(RUN)).toEqual([]);
  });

  it('refuses another run’s minted publication grant at both writer boundaries', () => {
    seedPublicRelease(RUN);
    seedPublicRelease(OTHER);
    const otherGrant = publicationGrant(OTHER);

    for (const writer of publicArtifactWriters(RUN, otherGrant)) {
      const refusal = writerRefusal(writer.write);
      expect(refusal.code, writer.file).toBe('PERMIT_RUN_MISMATCH');
      expect(refusal.message, writer.file).toMatch(/does not carry across to another/);
      expect(existsSync(join(RUNS_DIR, RUN, writer.file)), writer.file).toBe(false);
    }
    expect(readProvenance(RUN)).toEqual([]);
  });

  it('refuses a same-run grant bound to different manifest bytes', () => {
    const storedHash = seedPublicRelease();
    const differentManifest = buildRunManifest(
      draft(RUN, { ...PUBLIC_RELEASE, budgetCapUsd: 4 }),
      slice(ITEMS),
    ).manifest;
    const differentGrant = mintTestGrant({
      permitId: 'permit-release-different-envelope',
      kind: 'publication',
      capabilities: ['publication'],
      runId: RUN,
      manifest: differentManifest,
    });
    expect(differentGrant.runId).toBe(RUN); // isolate manifest binding from run binding
    expect(differentGrant.manifestHash).not.toBe(storedHash);

    for (const writer of publicArtifactWriters(RUN, differentGrant)) {
      const refusal = writerRefusal(writer.write);
      expect(refusal.code, writer.file).toBe('MANIFEST_GRANT_MISMATCH');
      expect(refusal.message, writer.file).toMatch(/binds .* but the stored manifest is/);
      expect(existsSync(join(RUNS_DIR, RUN, writer.file)), writer.file).toBe(false);
    }
    expect(readProvenance(RUN)).toEqual([]);
  });

  it('stamps both artifacts from the stored manifest and records analyze/report provenance', () => {
    const storedHash = seedPublicRelease();
    const grant = publicationGrant(RUN);
    expect(grant.manifestHash).toBe(storedHash);

    // Hostile caller-supplied stamps are overwritten by the stored envelope.
    writeAnalysis(
      RUN,
      {
        runId: RUN,
        evidenceClass: 'development',
        releaseState: 'draft',
        rankEligible: false,
        manifestHash: 'caller-chosen',
        nonScoringBanner: NON_SCORING_LABEL,
      } as unknown as RunAnalysis,
      grant,
    );
    writeLeaderboard(
      RUN,
      {
        runId: RUN,
        rows: [],
        evidenceClass: 'development',
        releaseState: 'draft',
        rankEligible: false,
        manifestHash: 'caller-chosen',
        nonScoringBanner: NON_SCORING_LABEL,
      },
      grant,
    );

    const expectedStamp = {
      runId: RUN,
      evidenceClass: 'public-release',
      releaseState: 'released',
      rankEligible: true,
      manifestHash: storedHash,
      nonScoringBanner: null,
    };
    expect(JSON.parse(readFileSync(join(RUNS_DIR, RUN, 'analysis.json'), 'utf8'))).toMatchObject(
      expectedStamp,
    );
    expect(JSON.parse(readFileSync(join(RUNS_DIR, RUN, 'leaderboard.json'), 'utf8'))).toMatchObject(
      expectedStamp,
    );

    const provenance = readProvenance(RUN);
    expect(provenance.map((entry) => entry.command)).toEqual(['bench analyze', 'bench report']);
    for (const entry of provenance) {
      expect(entry).toMatchObject({
        receiptVersion: 1,
        permitId: grant.permitId,
        kind: 'publication',
        runId: RUN,
        manifestHash: storedHash,
        signedPermit: grant.signedPermit,
        signedPermitHash: grant.signedPermitHash,
      });
      expect(entry.capabilities).toContain('publication');
      expect(entry.signedPermitHash).toBe(sha256Hex(canonicalJson(entry.signedPermit)));
    }
    expect(buildReleaseChecklist(RUN).items.find((item) => item.id === 'approval-provenance')).toMatchObject({
      verdict: 'pass',
    });
  });

  it('refuses a plausible hand-written receipt whose envelope was never signed', () => {
    seedPublicRelease();
    const grant = publicationGrant(RUN);
    writeAnalysis(RUN, { runId: RUN } as RunAnalysis, grant);
    writeLeaderboard(RUN, { runId: RUN, rows: [] }, grant);

    const entries = readProvenance(RUN);
    const forgedEnvelope = {
      ...entries[0]!.signedPermit,
      // Correct length and encoding, real permit body and real key id: only
      // production signature verification distinguishes this from approval.
      signature: Buffer.alloc(64, 7).toString('base64'),
    };
    const forgedHash = sha256Hex(canonicalJson(forgedEnvelope));
    writeFileSync(
      join(RUNS_DIR, RUN, 'provenance.ndjson'),
      `${entries
        .map((entry) => canonicalJson({ ...entry, signedPermit: forgedEnvelope, signedPermitHash: forgedHash }))
        .join('\n')}\n`,
    );

    const check = buildReleaseChecklist(RUN).items.find((item) => item.id === 'approval-provenance')!;
    expect(check.verdict).toBe('fail');
    expect(check.detail).toMatch(/not authenticated.*PERMIT_BAD_SIGNATURE/);
  });

  it('refuses an authentic envelope signed for another run and manifest', () => {
    seedPublicRelease(RUN);
    seedPublicRelease(OTHER);
    const grant = publicationGrant(RUN);
    const wrongGrant = publicationGrant(OTHER);
    writeAnalysis(RUN, { runId: RUN } as RunAnalysis, grant);
    writeLeaderboard(RUN, { runId: RUN, rows: [] }, grant);

    const entries = readProvenance(RUN);
    writeFileSync(
      join(RUNS_DIR, RUN, 'provenance.ndjson'),
      `${entries
        .map((entry) =>
          canonicalJson({
            ...entry,
            signedPermit: wrongGrant.signedPermit,
            signedPermitHash: wrongGrant.signedPermitHash,
          }),
        )
        .join('\n')}\n`,
    );

    const check = buildReleaseChecklist(RUN).items.find((item) => item.id === 'approval-provenance')!;
    expect(check.verdict).toBe('fail');
    expect(check.detail).toMatch(/not authenticated.*PERMIT_MANIFEST_MISMATCH/);
  });

  it('refuses an authenticated receipt after the artifact bytes change', () => {
    seedPublicRelease();
    const grant = publicationGrant(RUN);
    writeAnalysis(RUN, { runId: RUN } as RunAnalysis, grant);
    writeLeaderboard(RUN, { runId: RUN, rows: [] }, grant);
    expect(buildReleaseChecklist(RUN).items.find((item) => item.id === 'approval-provenance')).toMatchObject({
      verdict: 'pass',
    });

    const analysisPath = join(RUNS_DIR, RUN, 'analysis.json');
    writeFileSync(analysisPath, `${readFileSync(analysisPath, 'utf8')}\n`);
    const check = buildReleaseChecklist(RUN).items.find((item) => item.id === 'approval-provenance')!;
    expect(check.verdict).toBe('fail');
    expect(check.detail).toMatch(/exact current bytes of analysis\.json/);
  });
});

// ---------------------------------------------------------------------------

describe('RELEASE-002 — every name for the run must be the same name', () => {
  it('refuses any disagreement, and refuses an identity that was never established', () => {
    expect(() =>
      assertRunIdentity({ requested: 'a', permit: 'a', manifest: 'a', artifact: 'a' }, 'ctx'),
    ).not.toThrow();
    for (const field of ['requested', 'permit', 'manifest', 'artifact'] as const) {
      const claims = { requested: 'a', permit: 'a', manifest: 'a', artifact: 'a', [field]: 'b' };
      expect(() => assertRunIdentity(claims, 'ctx')).toThrow(/run identity disagrees/);
    }
    // Blank is not agreement. An unestablished id used to read as "matches".
    expect(() =>
      assertRunIdentity({ requested: 'a', permit: '', manifest: 'a', artifact: 'a' }, 'ctx'),
    ).toThrow(/is not a matching one/);
    expect(() =>
      assertRunIdentity(
        { requested: 'a', permit: undefined as unknown as string, manifest: 'a', artifact: 'a' },
        'ctx',
      ),
    ).toThrow(ManifestError);
  });
});

// ---------------------------------------------------------------------------

describe('DATA-002 — the manifest digest is persisted, and checked', () => {
  it('writes the digest beside the manifest and refuses a run that lost it', () => {
    const hash = seedRun();
    expect(readFileSync(join(RUNS_DIR, RUN, 'manifest.sha256'), 'utf8').trim()).toBe(hash);
    expect(verifyRunManifest(RUN).ok).toBe(true);

    rmSync(join(RUNS_DIR, RUN, 'manifest.sha256'));
    const absent = verifyRunManifest(RUN);
    expect(absent.ok).toBe(false);
    expect(absent.findings.map((f) => f.code)).toContain('MANIFEST_HASH_ABSENT');
  });

  it('refuses a digest that no longer matches the manifest it sits beside', () => {
    seedRun();
    writeRunFileAtomic(RUN, 'manifest.sha256', `${'b'.repeat(64)}\n`);
    expect(verifyRunManifest(RUN).findings.map((f) => f.code)).toContain('MANIFEST_HASH_MISMATCH');
    // A truncated or garbled sidecar is a mismatch, never a "pre-sidecar run".
    writeRunFileAtomic(RUN, 'manifest.sha256', 'not-a-digest\n');
    expect(verifyRunManifest(RUN).findings.map((f) => f.code)).toContain('MANIFEST_HASH_MISMATCH');
  });
});

// ---------------------------------------------------------------------------

describe('DATA-002 — validatorHash covers every module that can change a score', () => {
  const covered = () => new Set(validatorDigest().files.map((f) => f.path));
  const excluded = () => new Map(validatorDigest().exclusions.map((e) => [e.path, e.reason]));

  it('covers the judge, the adjudicator, the statistics and the analysis, not just the graders', () => {
    const paths = covered();
    for (const module of [
      'packages/core/src/graders/keyword.ts',
      'packages/core/src/graders/numeric.ts',
      'packages/core/src/stats.ts',
      'packages/core/src/agreement.ts',
      'packages/core/src/kitchenplan.ts',
      'packages/runner/src/judge.ts',
      'packages/runner/src/adjudicate.ts',
      'packages/runner/src/analyze.ts',
      'packages/runner/src/report.ts',
      'packages/runner/src/calibration.ts',
      // The CLI blends the judge score with the deterministic one and decides
      // that an empty answer scores 0. It changes scores; it is covered.
      'packages/runner/src/cli.ts',
    ]) {
      expect(paths.has(module), `${module} must be inside validatorHash`).toBe(true);
      expect(excluded().has(module)).toBe(false);
    }
  });

  it('accounts for every source file exactly once, as covered or as excluded with a reason', () => {
    const digest = validatorDigest();
    const all = [...digest.files.map((f) => f.path), ...digest.exclusions.map((e) => e.path)];
    expect(new Set(all).size).toBe(all.length);
    // Discovery includes by default, so a module added by anyone is covered
    // without them remembering to list it. Exclusion is the deliberate act, and
    // every exclusion states its grounds.
    expect(digest.exclusions.every((e) => e.reason.trim().length > 10)).toBe(true);
    expect(digest.files.every((f) => f.present && /^[a-f0-9]{64}$/.test(f.sha256 ?? ''))).toBe(true);
  });

  it('folds the exclusion list into the hash, so moving a module out of coverage is visible', () => {
    const { validatorHash, files, exclusions } = validatorDigest();
    // Recomputing the same payload reproduces the hash; recomputing it with one
    // module quietly moved from covered to excluded does not. (Computed here
    // rather than by editing the tree, which other tests share.)
    const recompute = (f: typeof files, e: typeof exclusions) =>
      sha256Hex(
        canonicalJson({
          kind: 'cookingbench/validator',
          digestVersion: 2,
          payload: { files: f, exclusions: e },
        }),
      );
    expect(recompute(files, exclusions)).toBe(validatorHash);
    const [moved, ...rest] = files;
    expect(
      recompute(rest, [...exclusions, { path: moved!.path, reason: 'quietly reclassified' }].sort((a, b) => (a.path < b.path ? -1 : 1))),
    ).not.toBe(validatorHash);
  });
});

// ---------------------------------------------------------------------------

describe('the verification boundary does not take its inputs from its caller', () => {
  it('ignores a bank substituted through the production entry point', () => {
    seedRun();
    const mutated = slice(ITEMS).map((q) => ({ ...q, referenceAnswer: 'something else entirely' }));
    // Through the test seam the substitution works, and drift is reported.
    expect(verifyRunManifestWithOverrides(RUN, {}, { dataset: mutated }).ok).toBe(false);
    // Through the production entry point the same property is simply not read:
    // the verifier loads the repository's dataset and the run still verifies.
    const production = verifyRunManifest(RUN, { dataset: mutated } as never);
    expect(production.ok).toBe(true);
  });

  it('refuses the injectable form outside a test process', () => {
    seedRun();
    const vitest = process.env.VITEST;
    const nodeEnv = process.env.NODE_ENV;
    try {
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      expect(() => verifyRunManifestWithOverrides(RUN, {}, { recompute: false })).toThrow(
        /test-only seam/,
      );
      expect(() => useRegisterFileForTest('anything.json')).toThrow(/test-only seam/);
    } finally {
      if (vitest === undefined) delete process.env.VITEST;
      else process.env.VITEST = vitest;
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
    }
  });
});

// ---------------------------------------------------------------------------

describe('RELEASE-002 — the pointer, and publication that no reader sees half of', () => {
  /**
   * A register written directly.
   *
   * The writer path (`setCurrentRun`) demands a fully green checklist, which
   * includes `artifacts-committed` — impossible for a scratch run by
   * construction, and correctly so. The READER half is what atomicity depends
   * on, so it is tested against a register fixture, which is exactly the shape
   * the writer produces.
   */
  function writeRegisterFixture(
    runId: string,
    hash: string,
    artifacts: Array<[string, string]>,
    checklistDigest = 'c'.repeat(64),
  ): void {
    const registeredAt = '2026-07-30T00:00:00Z';
    const auditedAt = '2026-07-30T12:00:00Z';
    const releasedAt = '2026-07-31T00:00:00Z';
    writeFileSync(
      join(RUNS_DIR, REGISTER),
      JSON.stringify({
        registerVersion: 1,
        entries: {
          [runId]: {
            runId,
            state: 'released',
            manifestHash: hash,
            updatedAt: releasedAt,
            history: [
              { from: null, to: 'draft', at: registeredAt, actor: 'jordan', evidence: 'registered fixture', journalled: true },
              { from: 'draft', to: 'audited', at: auditedAt, actor: 'jordan', evidence: 'audited fixture', journalled: true },
              { from: 'audited', to: 'released', at: releasedAt, actor: 'jordan', evidence: 'released fixture', journalled: true },
            ],
          },
        },
        currentRun: {
          runId,
          manifestHash: hash,
          reviewedBy: 'jordan',
          reviewedAt: '2026-07-31T00:00:00Z',
          reviewEvidence: 'read the board and the analysis',
          checklistDigest,
          artifacts: artifacts.map(([file, sha256]) => ({ file, sha256 })),
        },
      }),
    );
  }

  it('refuses to read a current run that nobody set', () => {
    expect(() => readCurrentRun()).toThrow(LifecycleError);
    expect(safeReadCurrentRun().ok).toBe(false);
  });

  it('refuses a pointer whose pinned artifact has changed underneath it', () => {
    buildProductionReleaseFixture();
    const board = join(RUNS_DIR, RUN, 'leaderboard.json');
    expect(readCurrentRun().runId).toBe(RUN);

    // Mutate exactly the board after a genuinely resolvable baseline.
    writeFileSync(board, JSON.stringify({ runId: RUN, rows: [{ modelId: 'tampered' }] }));
    expect(() => readCurrentRun()).toThrow(/has changed since it was approved/);
    rmSync(board);
    expect(() => readCurrentRun()).toThrow(/no longer present/);
  });

  it('refuses a pointer that pins nothing, rather than vacuously approving it', () => {
    const hash = seedRun();
    writeRegisterFixture(RUN, hash, []);
    // An empty `artifacts` array skips the digest loop, so without this the
    // cheapest forgery of an approval is one that covers no files at all.
    expect(() => readCurrentRun()).toThrow(/pins no digest for/);
  });

  it('refuses a pointer the register does not corroborate', () => {
    const hash = seedRun();
    writeRegisterFixture(RUN, hash, []);
    const register = JSON.parse(readFileSync(join(RUNS_DIR, REGISTER), 'utf8')) as {
      entries: Record<string, { state: string }>;
    };
    register.entries[RUN]!.state = 'quarantined';
    writeFileSync(join(RUNS_DIR, REGISTER), JSON.stringify(register));
    expect(() => readCurrentRun()).toThrow(/does not show it released/);
  });

  it('refuses to point at a run that is not released, and cannot be handed a verdict', () => {
    const hash = seedRun();
    registerRun({ runId: RUN, manifestHash: hash, actor: 'test', evidence: 'unit test' });
    expect(() =>
      setCurrentRun({
        runId: RUN,
        reviewedBy: 'jordan',
        reviewEvidence: 'looks fine',
        checklist: { complete: true, items: [] },
      } as unknown as Parameters<typeof setCurrentRun>[0]),
    ).toThrow(/not 'released'/);
  });
});

// ---------------------------------------------------------------------------

describe('the website serves an approved release, not the newest timestamp', () => {
  let tree: string;

  beforeEach(() => {
    tree = mkdtempSync(join(tmpdir(), 'cookingbench-release-'));
  });

  afterEach(() => {
    rmSync(tree, { recursive: true, force: true });
  });

  function board(runId: string, generatedAt: string, rows = [{ modelId: 'm', overall: 90 }]): void {
    const dir = join(tree, runId);
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({ runId, generatedAt, rows });
    writeFileSync(join(dir, 'leaderboard.json'), body);
  }

  function completeRelease(): ReturnType<typeof setCurrentRun> {
    const pointer = buildProductionReleaseFixture();
    cpSync(join(RUNS_DIR, RUN), join(tree, RUN), { recursive: true });
    return pointer;
  }

  function approvedPointer(
    pointer: ReturnType<typeof setCurrentRun>,
    artifacts: Array<{ file: string; sha256: string }> = pointer.artifacts,
  ): unknown {
    return { ...pointer, artifacts };
  }

  function copyHistoricalRelease(): string {
    const runId = '2026-07-v2.1';
    cpSync(join(RUNS_DIR, runId), join(tree, runId), { recursive: true });
    return runId;
  }

  function register(entries: unknown, currentRun: unknown): void {
    writeFileSync(join(tree, 'REGISTER.json'), JSON.stringify({ registerVersion: 1, entries, currentRun }));
  }

  it('serves the run the pointer names, even when another board is newer', () => {
    const fixture = completeRelease();
    board('newer-but-unapproved', '2099-01-01T00:00:00Z');
    register(
      { [RUN]: { state: 'released', manifestHash: fixture.manifestHash } },
      approvedPointer(fixture),
    );
    const release = resolveApprovedRelease(tree);
    expect(release?.runId).toBe(RUN);
    expect(release?.approval.kind).toBe('register');
  });

  it('serves nothing when the pinned artifact has been rebuilt under the pointer', () => {
    const fixture = completeRelease();
    register(
      { [RUN]: { state: 'released', manifestHash: fixture.manifestHash } },
      approvedPointer(fixture),
    );
    board(RUN, '2026-02-02T00:00:00Z'); // rebuilt: same run, new bytes
    expect(resolveApprovedRelease(tree)).toBeNull();
  });

  it('serves nothing when the register and the pointer disagree', () => {
    const fixture = completeRelease();
    const pointer = approvedPointer(fixture);
    register(
      { [RUN]: { state: 'audited', manifestHash: fixture.manifestHash } },
      pointer,
    );
    expect(resolveApprovedRelease(tree)).toBeNull();
    register({ [RUN]: { state: 'released', manifestHash: 'different' } }, pointer);
    expect(resolveApprovedRelease(tree)).toBeNull();
    register({}, pointer);
    expect(resolveApprovedRelease(tree)).toBeNull();
  });

  it('serves nothing from a malformed register rather than falling back to a guess', () => {
    board('anything', '2099-01-01T00:00:00Z');
    writeFileSync(join(tree, 'REGISTER.json'), '{ not json');
    expect(resolveApprovedRelease(tree)).toBeNull();
    writeFileSync(join(tree, 'REGISTER.json'), JSON.stringify({ entries: {}, currentRun: null }));
    expect(resolveApprovedRelease(tree)).toBeNull();
  });

  it('never promotes a board just because it is newest, mock, or partial', () => {
    // The three shapes the old heuristic mis-served: a rebuilt mock run, a
    // ten-question canary, and any board written most recently. With no
    // register and no pinned historical run present, none of them is served.
    board('mock-run', '2099-01-01T00:00:00Z');
    board('canary', '2098-01-01T00:00:00Z');
    expect(resolveApprovedRelease(tree)).toBeNull();
  });

  it('refuses a board-only or empty pointer rather than approving a vacuous envelope', () => {
    const fixture = completeRelease();
    const entries = {
      [RUN]: { state: 'released', manifestHash: fixture.manifestHash },
    };
    register(entries, approvedPointer(fixture, fixture.artifacts.slice(0, 1)));
    expect(resolveApprovedRelease(tree)).toBeNull();
    register(entries, approvedPointer(fixture, []));
    expect(resolveApprovedRelease(tree)).toBeNull();

    const responseDir = join(tree, RUN, 'responses');
    rmSync(join(responseDir, readdirSync(responseDir).sort()[0]!));
    register(entries, approvedPointer(fixture));
    expect(resolveApprovedRelease(tree)).toBeNull();
  });

  it('refuses a copied companion even when the pointer pins the copied bytes', () => {
    const fixture = completeRelease();
    const copiedConfig = join(tree, RUN, 'config.json');
    writeFileSync(
      copiedConfig,
      readFileSync(join(RUNS_DIR, '2026-07-v2.1', 'config.json')),
    );
    const artifacts = fixture.artifacts.map((artifact) =>
      artifact.file === 'config.json'
        ? { ...artifact, sha256: sha256Hex(readFileSync(copiedConfig, 'utf8')) }
        : artifact,
    );
    register(
      { [RUN]: { state: 'released', manifestHash: fixture.manifestHash } },
      approvedPointer(fixture, artifacts),
    );
    // The digest is valid, but config.json still names its source run.
    expect(resolveApprovedRelease(tree)).toBeNull();
  });

  it('serves the one pinned historical release, by content, when no register exists', () => {
    // The real tree: 2026-07-v2.1 is the published board and stays published,
    // and it is selected by a pinned digest rather than by being newest.
    const release = resolveApprovedRelease(RUNS_DIR);
    expect(release?.runId).toBe('2026-07-v2.1');
    expect(release?.approval.kind).toBe('pinned-historical');
    expect(release?.report.rows.length).toBe(14);
  });

  it('lets the register withdraw the pinned historical release', () => {
    const runId = copyHistoricalRelease();
    expect(resolveApprovedRelease(tree)?.runId).toBe(runId);
    register({ [runId]: { state: 'quarantined', manifestHash: 'h' } }, null);
    expect(resolveApprovedRelease(tree)).toBeNull();
  });

  it('refuses any changed historical companion or response-set membership', () => {
    const runId = copyHistoricalRelease();
    const dir = join(tree, runId);
    for (const file of ['leaderboard.json', 'analysis.json', 'config.json', 'calibration.json', 'scores.json']) {
      const path = join(dir, file);
      const approved = readFileSync(path);
      writeFileSync(path, Buffer.concat([approved, Buffer.from('\n')]));
      expect(resolveApprovedRelease(tree), `${file} changed but the release still resolved`).toBeNull();
      writeFileSync(path, approved);
    }

    const responses = join(dir, 'responses');
    const first = readdirSync(responses).sort()[0]!;
    const firstPath = join(responses, first);
    const approvedResponse = readFileSync(firstPath);
    writeFileSync(firstPath, Buffer.concat([approvedResponse, Buffer.from('\n')]));
    expect(resolveApprovedRelease(tree)).toBeNull();
    writeFileSync(firstPath, approvedResponse);

    writeFileSync(join(responses, 'copied-extra.json'), approvedResponse);
    expect(resolveApprovedRelease(tree)).toBeNull();
  });
});
