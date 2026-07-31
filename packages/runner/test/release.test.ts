import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NON_SCORING_LABEL, canonicalJson, type Question } from '@cookingbench/core';
import { RUNS_DIR, loadQuestions } from '../src/dataset.js';
import { writeRunFileAtomic } from '../src/firewall.js';
import { manifestHash, sha256Hex } from '../src/permit.js';
import {
  ManifestError,
  assertRunIdentity,
  buildRunManifest,
  validatorDigest,
  verifyRunManifest,
  verifyRunManifestWithOverrides,
  writeRunManifest,
} from '../src/manifest.js';
import {
  ANSWER_JOURNAL,
  BALLOT_JOURNAL,
  LifecycleError,
  REQUIRED_RELEASE_CHECK_IDS,
  appendJournalEntry,
  assertPublicationAllowed,
  buildReleaseChecklist,
  checklistComplete,
  checklistShortfall,
  clearRegisterFileForTest,
  journalProblemsForRelease,
  readCurrentRun,
  readReleaseRegister,
  registerRun,
  runState,
  safeReadCurrentRun,
  setCurrentRun,
  transitionRun,
  useRegisterFileForTest,
  verifyJournal,
  type ReleaseChecklist,
} from '../src/lifecycle.js';
import { resolveApprovedRelease } from '../../../apps/web/lib/data.js';

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
    gitCommit: '980dfcb',
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

beforeEach(() => {
  useRegisterFileForTest(REGISTER);
});

afterEach(() => {
  clearRegisterFileForTest();
  rmSync(join(RUNS_DIR, RUN), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, OTHER), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, REGISTER), { force: true });
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
    expect(() =>
      assertPublicationAllowed('public', { requestedRunId: RUN, permitRunId: RUN }),
    ).toThrow(/do not match its manifest|evidenceClass/);
  });

  it('refuses to act on one run under another run’s approval', () => {
    seedRun();
    // The permit says OTHER, the request says RUN. Neither `sync` nor `publish`
    // compared these before; an approval for one run acted on another.
    expect(() =>
      assertPublicationAllowed('public', { requestedRunId: RUN, permitRunId: OTHER }),
    ).toThrow(/run identity disagrees/);
    // And "no permit" is not "any run".
    expect(() => assertPublicationAllowed('public', { requestedRunId: RUN })).toThrow(
      /no permit run id was established/,
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
  function writeRegisterFixture(runId: string, hash: string, artifacts: Array<[string, string]>): void {
    writeFileSync(
      join(RUNS_DIR, REGISTER),
      JSON.stringify({
        registerVersion: 1,
        entries: {
          [runId]: { runId, state: 'released', manifestHash: hash, updatedAt: '2026-07-31T00:00:00Z', history: [] },
        },
        currentRun: {
          runId,
          manifestHash: hash,
          reviewedBy: 'jordan',
          reviewedAt: '2026-07-31T00:00:00Z',
          reviewEvidence: 'read the board and the analysis',
          checklistDigest: 'c'.repeat(64),
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
    const hash = seedRun();
    const board = join(RUNS_DIR, RUN, 'leaderboard.json');
    // Written with plain fs, deliberately. The firewall freezes a directory the
    // moment it holds a board, which is the DATA-001 guard doing its job; the
    // scenario under test is a file replaced OUTSIDE the writers, which is how
    // a mixed version would really arise.
    writeFileSync(board, JSON.stringify({ runId: RUN, rows: [{ modelId: 'm' }] }));
    // Every published artifact has to be pinned before any of them is checked,
    // so the fixture pins the full set; only the board's bytes matter here.
    writeRegisterFixture(RUN, hash, [
      ['leaderboard.json', sha256Hex(readFileSync(board, 'utf8'))],
      ...(['analysis.json', 'scores.json', 'manifest.json', 'release-checklist.json'] as const).map(
        (file) => [file, 'unchecked-because-the-board-fails-first'] as [string, string],
      ),
    ]);
    expect(() => readCurrentRun()).toThrow(/no longer present/);
    for (const file of ['analysis.json', 'scores.json', 'release-checklist.json']) {
      writeFileSync(join(RUNS_DIR, RUN, file), '{}');
    }
    // manifest.json is already there; pin the real digests for the rest.
    writeRegisterFixture(
      RUN,
      hash,
      (['leaderboard.json', 'analysis.json', 'scores.json', 'manifest.json', 'release-checklist.json'] as const).map(
        (file) => [file, sha256Hex(readFileSync(join(RUNS_DIR, RUN, file), 'utf8'))] as [string, string],
      ),
    );
    expect(readCurrentRun().runId).toBe(RUN);

    // Replacing one published file under a live pointer is precisely the mixed
    // version a reader must never see.
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

  function board(runId: string, generatedAt: string, rows = [{ modelId: 'm', overall: 90 }]): string {
    const dir = join(tree, runId);
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({ runId, generatedAt, rows });
    writeFileSync(join(dir, 'leaderboard.json'), body);
    return sha256Hex(body);
  }

  function register(entries: unknown, currentRun: unknown): void {
    writeFileSync(join(tree, 'REGISTER.json'), JSON.stringify({ registerVersion: 1, entries, currentRun }));
  }

  it('serves the run the pointer names, even when another board is newer', () => {
    const approved = board('approved-run', '2026-01-01T00:00:00Z');
    board('newer-but-unapproved', '2099-01-01T00:00:00Z');
    register(
      { 'approved-run': { state: 'released', manifestHash: 'h' } },
      {
        runId: 'approved-run',
        manifestHash: 'h',
        reviewedBy: 'jordan',
        reviewedAt: '2026-01-02T00:00:00Z',
        checklistDigest: 'd',
        artifacts: [{ file: 'leaderboard.json', sha256: approved }],
      },
    );
    const release = resolveApprovedRelease(tree);
    expect(release?.runId).toBe('approved-run');
    expect(release?.approval.kind).toBe('register');
  });

  it('serves nothing when the pinned artifact has been rebuilt under the pointer', () => {
    const approved = board('approved-run', '2026-01-01T00:00:00Z');
    register(
      { 'approved-run': { state: 'released', manifestHash: 'h' } },
      {
        runId: 'approved-run',
        manifestHash: 'h',
        reviewedBy: 'j',
        reviewedAt: 'x',
        checklistDigest: 'd',
        artifacts: [{ file: 'leaderboard.json', sha256: approved }],
      },
    );
    board('approved-run', '2026-02-02T00:00:00Z'); // rebuilt: same run, new bytes
    expect(resolveApprovedRelease(tree)).toBeNull();
  });

  it('serves nothing when the register and the pointer disagree', () => {
    const approved = board('approved-run', '2026-01-01T00:00:00Z');
    const pointer = {
      runId: 'approved-run',
      manifestHash: 'h',
      reviewedBy: 'j',
      reviewedAt: 'x',
      checklistDigest: 'd',
      artifacts: [{ file: 'leaderboard.json', sha256: approved }],
    };
    register({ 'approved-run': { state: 'audited', manifestHash: 'h' } }, pointer);
    expect(resolveApprovedRelease(tree)).toBeNull();
    register({ 'approved-run': { state: 'released', manifestHash: 'different' } }, pointer);
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

  it('serves the one pinned historical release, by content, when no register exists', () => {
    // The real tree: 2026-07-v2.1 is the published board and stays published,
    // and it is selected by a pinned digest rather than by being newest.
    const release = resolveApprovedRelease(RUNS_DIR);
    expect(release?.runId).toBe('2026-07-v2.1');
    expect(release?.approval.kind).toBe('pinned-historical');
    expect(release?.report.rows.length).toBe(14);
  });

  it('lets the register withdraw the pinned historical release', () => {
    const dir = join(tree, '2026-07-v2.1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leaderboard.json'), readFileSync(join(RUNS_DIR, '2026-07-v2.1', 'leaderboard.json')));
    expect(resolveApprovedRelease(tree)?.runId).toBe('2026-07-v2.1');
    register({ '2026-07-v2.1': { state: 'quarantined', manifestHash: 'h' } }, null);
    expect(resolveApprovedRelease(tree)).toBeNull();
  });

  it('refuses a pinned board whose bytes are not the ones that were approved', () => {
    const dir = join(tree, '2026-07-v2.1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'leaderboard.json'), JSON.stringify({ runId: '2026-07-v2.1', rows: [{ modelId: 'x' }] }));
    expect(resolveApprovedRelease(tree)).toBeNull();
  });
});
