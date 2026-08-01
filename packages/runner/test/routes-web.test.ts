import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalibrationError, loadAnchors, readCalibration } from '../src/calibration.js';
import { DATA_DIR, REPO_ROOT, RUNS_DIR, loadModels, loadQuestions } from '../src/dataset.js';
import {
  FirewallError,
  readHistoricalRegistry,
  readHistoricalRegistryForTests,
  type FirewallErrorCode,
} from '../src/firewall.js';
import { PermitError, type PermitErrorCode } from '../src/permit.js';
import {
  ProtocolViolationError,
  attemptChargesUsd,
  hasResponse,
  listRuns,
  readAttempts,
  readRunConfig,
  readScores,
  settleAttempt,
} from '../src/store.js';
import { publishRun } from '../src/sync.js';
import { archiveTasteVotes } from '../src/taste.js';
import { mintTestGrant } from './support/grant.js';

/**
 * Route-level proof for the READERS — the public site's eight filesystem
 * readers, the compatibility refusals that replaced its six anonymous
 * PostgREST routes, and the medium/low-severity readers in the runner that no
 * other area covers.
 *
 * `docs/wp-0/routes.yaml` makes the argument these tests exist to honour: READS
 * ARE ROUTES. A read is how untrusted content crosses the boundary and how a
 * traversal escapes a root, so "it only reads" is an argument to record, not a
 * reason to omit the route. Every risk below was open either because nothing
 * called the route at all, or because the evidence offered exercised a HELPER —
 * `resolveRunFile`, `resolveOutputPath`, `assertArchiveGrows`,
 * `serviceRoleClient` — which cannot fail if the route stops calling it. So
 * every test here calls the route's OWN exported function and asserts the
 * SPECIFIC refusal the risk names: a `FirewallError` code, a `PermitError`
 * code, or a distinctive fragment of the message. An unparseable fixture, an
 * absent file or a missing environment variable would all throw too, and none
 * of them is evidence about containment or authority.
 *
 * Strength is matched to the risk on purpose. A read of the committed dataset
 * is registered at LOW severity because the directory is a module constant with
 * no caller input; the claim proved for it is therefore the one recorded — that
 * it cannot be steered outside its root — and not some stronger guarantee it
 * does not have. Where the honest finding is that production does NOT enforce
 * the risk, the test says so in its own name rather than passing for an
 * unrelated reason; those are marked DEFECT and are the reason several of these
 * routes must stay open.
 *
 * Offline by construction. `globalThis.fetch` is replaced for the whole file
 * with a recorder whose default answer is a thrown error, so "no provider was
 * contacted" is an assertion rather than an assumption, and any regression
 * that restores one of the site's former PostgREST calls is caught before a
 * socket. `@supabase/supabase-js` is
 * mocked so that CONSTRUCTING a service-role client is itself an observable
 * event. Nothing under `data/runs` or `data/taste` is written: the only
 * filesystem writes are two scratch run directories, removed in `afterEach`,
 * and every test that touches a published artifact re-checks its bytes.
 */

/* -------------------------------------------------------------------------- */
/* Offline seams                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The service-role connection, replaced by a tripwire that can be armed.
 *
 * Two different claims need this seam. For the authorisation refusals, a
 * constructed client is a FAILURE — the service-role key bypasses RLS, so a
 * caller that reaches a live connection has already been handed the blast
 * radius whatever the next line does. For the taste-archive guard, the route
 * has to get PAST construction to reach the guard at all, so the tripwire also
 * has to be able to hand back a fixed answer.
 */
const supabaseModule = vi.hoisted(() => ({
  nextClient: null as unknown,
  createClient: vi.fn(() => {
    if (supabaseModule.nextClient) return supabaseModule.nextClient;
    throw new Error('SENTINEL: a service-role client was constructed');
  }),
}));
vi.mock('@supabase/supabase-js', () => supabaseModule);

/**
 * A pass-through recorder over the two filesystem reads these routes use.
 *
 * The containment claim for a no-argument reader — "it cannot be steered
 * outside its root" — is only checkable by observing the paths the route
 * actually opened. Asserting on the returned VALUE would prove the data came
 * from somewhere, never from where. The recorder delegates to the real
 * functions and only collects while armed, so no behaviour changes and no other
 * test in this file is affected.
 */
const fsRecorder = vi.hoisted(() => ({ armed: false, paths: [] as string[] }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const note = (p: unknown) => {
    if (fsRecorder.armed && typeof p === 'string') fsRecorder.paths.push(p);
  };
  return {
    ...actual,
    default: actual,
    readFileSync: (p: unknown, ...rest: unknown[]) => {
      note(p);
      return (actual.readFileSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
    readdirSync: (p: unknown, ...rest: unknown[]) => {
      note(p);
      return (actual.readdirSync as (...a: unknown[]) => unknown)(p, ...rest);
    },
  };
});

/** Every path the route opened while it ran, in order. */
function pathsReadBy(fn: () => unknown): string[] {
  fsRecorder.paths.length = 0;
  fsRecorder.armed = true;
  try {
    fn();
  } finally {
    fsRecorder.armed = false;
  }
  return [...fsRecorder.paths];
}

/**
 * True when `path` resolves inside `root`, or is `root` — the containment claim
 * itself. The root counts because listing a directory reads the directory: a
 * reader that enumerates its own bank has not left it.
 */
function inside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return !rel.startsWith('..') && !rel.startsWith(`..${sep}`);
}

interface RecordedCall {
  url: string;
  method: string;
  body: string | null;
}

let httpCalls: RecordedCall[] = [];
let respond: (url: string, init?: RequestInit) => Response = () => {
  throw new Error('a route test reached the network with no responder armed');
};
const realFetch = globalThis.fetch;

/* -------------------------------------------------------------------------- */
/* Fixtures and helpers                                                        */
/* -------------------------------------------------------------------------- */

const FROZEN = '2026-07-v2.1';
const SCRATCH = '__test-routes-web-scratch';
const OTHER = '__test-routes-web-other';
const TASTE_DIR = join(DATA_DIR, 'taste');

/** The two committed taste artifacts. Neither may move, ever. */
const TASTE_FILES = ['votes.ndjson', 'ratings.json'] as const;

function tasteFingerprint(): string {
  return TASTE_FILES.map((f) => `${f}:${readFileSync(join(TASTE_DIR, f), 'utf8')}`).join('\0');
}

function frozenFingerprint(): string {
  const dir = join(RUNS_DIR, FROZEN);
  return [
    readdirSync(dir).sort().join('\n'),
    readFileSync(join(dir, 'leaderboard.json'), 'utf8'),
    readFileSync(join(dir, 'scores.json'), 'utf8'),
  ].join('\0');
}

function expectFirewallRefusal(fn: () => unknown, code: FirewallErrorCode, fragment: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the route did not refuse at all').toBeInstanceOf(FirewallError);
  expect((caught as FirewallError).code).toBe(code);
  expect((caught as FirewallError).message).toMatch(fragment);
}

async function expectRefusal<E extends Error>(
  fn: () => Promise<unknown>,
  type: new (...args: never[]) => E,
  code: string,
  fragment: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the route did not refuse at all').toBeInstanceOf(type);
  expect((caught as { code: string }).code).toBe(code);
  expect((caught as Error).message).toMatch(fragment);
}

/* -------------------------------------------------------------------------- */
/* The site's modules, loaded the way Next.js loads them                       */
/* -------------------------------------------------------------------------- */

type WebData = typeof import('../../../apps/web/lib/data.js');
type WebSupabase = typeof import('../../../apps/web/lib/supabase.js');

let site: WebData;
let siteDb: WebSupabase;

beforeAll(async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String((input as { url?: string })?.url ?? input);
    httpCalls.push({
      url,
      method: String(init?.method ?? 'GET'),
      body: typeof init?.body === 'string' ? init.body : null,
    });
    return respond(url, init);
  }) as typeof globalThis.fetch;

  // `apps/web/lib/data.ts` derives its data root from `process.cwd()`, because
  // Next.js runs it with the app directory as the working directory. Loading it
  // from the runner's test process would otherwise resolve that root two levels
  // above the repository — so the seam is the working directory at IMPORT time,
  // and it is restored immediately. This is the real module, not a copy: the
  // route functions asserted below are the ones the site renders from.
  const cwd = vi.spyOn(process, 'cwd').mockReturnValue(join(REPO_ROOT, 'apps', 'web'));
  try {
    site = await import('../../../apps/web/lib/data.js');
    siteDb = await import('../../../apps/web/lib/supabase.js');
  } finally {
    cwd.mockRestore();
  }
});

afterAll(() => {
  globalThis.fetch = realFetch;
});

beforeEach(() => {
  httpCalls = [];
  respond = () => {
    throw new Error('a route test reached the network with no responder armed');
  };
  supabaseModule.createClient.mockClear();
  supabaseModule.nextClient = null;
  // Present and plausible on purpose: `openServiceRoleConnection` reads these
  // before it builds anything, so leaving them unset would let a missing-config
  // error masquerade as an authorisation refusal.
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'not-a-real-key';
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  supabaseModule.nextClient = null;
  rmSync(join(RUNS_DIR, SCRATCH), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, OTHER), { recursive: true, force: true });
});

/** A scratch run carrying whatever top-level artifacts a test needs. */
function scratchRun(runId: string, files: Record<string, string>): void {
  mkdirSync(join(RUNS_DIR, runId), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(RUNS_DIR, runId, name, '..'), { recursive: true });
    writeFileSync(join(RUNS_DIR, runId, name), body);
  }
}

/** A complete byte-identical historical release beneath an isolated runs root. */
function historicalResolverTree(): string {
  const tree = join(RUNS_DIR, SCRATCH);
  mkdirSync(tree, { recursive: true });
  cpSync(join(RUNS_DIR, FROZEN), join(tree, FROZEN), { recursive: true });
  return tree;
}

function board(runId: string, generatedAt: string): string {
  return JSON.stringify({
    runId,
    generatedAt,
    methodologyVersion: 'v9.9',
    rows: [
      {
        modelId: 'lab/alpha',
        displayName: 'Alpha',
        provider: 'Lab',
        overall: 100,
        categories: {},
        questionsGraded: 1,
        costUsd: 0,
      },
    ],
  });
}

/* ========================================================================== */
/* apps/web/lib/data.ts — the eight readers behind the public site             */
/* ========================================================================== */

describe('web:data:board:select — getLatestReport', () => {
  it('serves the approved release, and refuses to promote a newer board nobody approved', () => {
    const approved = site.getApprovedRelease();
    expect(approved?.runId).toBe(FROZEN);
    // The approval is the point. A board is public because a human decided it
    // was, recorded by digest, and this field is what records the decision.
    expect(approved?.approval.kind).toBe('pinned-historical');

    // The attack the risk names, in its simplest form: write a board. Under the
    // selection this replaced — newest `generatedAt` wins — this run takes the
    // homepage, and `bench report` restamps that field on every rebuild, so it
    // took nothing more than regenerating anything.
    scratchRun(SCRATCH, {
      'config.json': JSON.stringify({ runId: SCRATCH, methodologyVersion: 'v9.9' }),
      'leaderboard.json': board(SCRATCH, '2099-01-01T00:00:00Z'),
    });

    const served = site.getLatestReport();
    expect(served?.runId).toBe(FROZEN);
    // Control: the intruder really would have won a recency contest, so the
    // assertion above is the approval gate and not an artefact of ordering.
    expect(Date.parse('2099-01-01T00:00:00Z')).toBeGreaterThan(Date.parse(served!.generatedAt));
    expect(site.getApprovedRelease()?.runId).toBe(FROZEN);
  });

  it('serves nothing at all rather than an unapproved board when the register is unusable', () => {
    // Fail-closed is the whole claim: a corrupted register must not silently
    // fall back to whatever is on disk. Exercised through the exported
    // root-parameterised resolver against a scratch tree, because the real
    // `data/runs/REGISTER.json` is committed state this suite must not touch.
    const tree = join(RUNS_DIR, SCRATCH);
    mkdirSync(tree, { recursive: true });
    writeFileSync(join(tree, 'REGISTER.json'), '{ not json');
    mkdirSync(join(tree, FROZEN), { recursive: true });
    writeFileSync(
      join(tree, FROZEN, 'leaderboard.json'),
      readFileSync(join(RUNS_DIR, FROZEN, 'leaderboard.json')),
    );
    // The pinned board is present and its digest matches, so only the register
    // verdict can be what withholds it.
    expect(site.resolveApprovedRelease(tree)).toBeNull();
  });

  it('treats a versioned register missing currentRun as corrupt, not as permission to restore the pin', () => {
    const tree = historicalResolverTree();
    writeFileSync(
      join(tree, 'REGISTER.json'),
      JSON.stringify({ registerVersion: 1, entries: {} }),
    );
    expect(site.resolveApprovedRelease(tree)).toBeNull();

    // Control: an explicit null is a real register decision and permits the
    // one fixed pre-register historical release. Missing and null are not the
    // same state.
    writeFileSync(
      join(tree, 'REGISTER.json'),
      JSON.stringify({ registerVersion: 1, entries: {}, currentRun: null }),
    );
    expect(site.resolveApprovedRelease(tree)?.runId).toBe(FROZEN);
  });

  it('refuses a linked register and a linked run directory instead of following either identity', () => {
    const tree = historicalResolverTree();
    const validRegister = JSON.stringify({ registerVersion: 1, entries: {}, currentRun: null });
    const planted = join(tree, 'planted-register.json');
    writeFileSync(planted, validRegister);
    symlinkSync(planted, join(tree, 'REGISTER.json'));
    expect(site.resolveApprovedRelease(tree)).toBeNull();

    rmSync(join(tree, 'REGISTER.json'));
    writeFileSync(join(tree, 'REGISTER.json'), validRegister);
    rmSync(join(tree, FROZEN), { recursive: true, force: true });
    symlinkSync(join(RUNS_DIR, FROZEN), join(tree, FROZEN));
    expect(site.resolveApprovedRelease(tree)).toBeNull();
  });
});

describe('web:data:analysis:read — getAnalysis', () => {
  it('refuses a separation table from a run no approval ever named', () => {
    // The separation table makes the site's strongest public claim: which
    // model is proven better. A plausible file under a supplied run id is not
    // evidence; only bytes held by the approved release snapshot may cross.
    scratchRun(SCRATCH, {
      'analysis.json': JSON.stringify({
        activeQuestions: 1,
        activeAllPerfect: 0,
        activeWithSignal: 1,
        effectiveItems: 1,
        separation: [
          { a: 'lab/alpha', b: 'lab/beta', scope: 'active', gap: 50, pAhead: 1, separated: true, items: 1 },
        ],
      }),
    });
    expect(site.getAnalysis(SCRATCH)).toBeNull();
    expect(site.getTiedRanks(SCRATCH)).toBeNull();
    expect(site.getAnalysis(FROZEN)?.activeQuestions).toBeGreaterThan(0);
  });

  it('returns null on an unreadable analysis rather than a partial separation table', () => {
    // The one thing this reader does enforce. A half-parsed matrix would award
    // places to models that were never tested against anything, which is the
    // failure `getStandings` exists to refuse.
    scratchRun(SCRATCH, { 'analysis.json': '{ truncated' });
    expect(site.getAnalysis(SCRATCH)).toBeNull();
    expect(site.getTiedRanks(SCRATCH)).toBeNull();
  });
});

describe('web:data:run-config:read — getRunConfig', () => {
  it('refuses a copied config and serves only the one inside the approved envelope', () => {
    // A config copied from the historical directory looks plausible and even
    // names a real release, but it is neither part of SCRATCH's approval nor
    // consistent with that directory. The methodology labels the site prints
    // must come from the same verified snapshot as its board.
    scratchRun(SCRATCH, {
      'config.json': JSON.stringify({
        runId: FROZEN,
        judgePanel: ['lab/a-panel-that-never-judged-anything'],
        methodologyVersion: 'v99',
      }),
    });
    expect(site.getRunConfig(SCRATCH)).toBeNull();
    expect(site.getRunConfig(FROZEN)?.runId).toBe(FROZEN);
    expect(site.getRunConfig(FROZEN)?.judgePanel).not.toEqual([
      'lab/a-panel-that-never-judged-anything',
    ]);
  });
});

describe('web:data:run-cost:read — getRunCost', () => {
  it('never turns an absent or unreadable cost component into $0.00', () => {
    // The low-severity claim, stated as the route states it: an unknown
    // component is null, never zero. A run whose judge spend was never recorded
    // did not judge for free, and this column once understated a published run
    // by $14.68 by summing only the part it could see.
    scratchRun(SCRATCH, {});
    const report = JSON.parse(board(SCRATCH, '2026-07-30T00:00:00Z')) as Parameters<
      WebData['getRunCost']
    >[0];
    report.rows[0]!.costUsd = 3;

    const bare = site.getRunCost(report);
    expect(bare.candidateUsd).toBe(3);
    expect(bare.judgeUsd).toBeNull();
    expect(bare.calibrationUsd).toBeNull();
    expect(bare.complete).toBe(false);

    // An unparseable calibration file is an UNKNOWN cost, not a zero one.
    scratchRun(SCRATCH, { 'calibration.json': '{ truncated' });
    const corrupt = site.getRunCost(report);
    expect(corrupt.calibrationUsd).toBeNull();
    expect(corrupt.complete).toBe(false);
    expect(corrupt.knownUsd).toBe(3);
  });
});

describe('web:data:scores:read — getScores', () => {
  it('refuses hand-written scores and serves the complete approved score set', () => {
    scratchRun(SCRATCH, {
      'scores.json': JSON.stringify([
        { runId: SCRATCH, modelId: 'lab/alpha', questionId: 'tech-901', score: 100, graderType: 'keyword' },
      ]),
    });
    expect(site.getScores(SCRATCH)).toEqual([]);
    expect(site.getScores(OTHER)).toEqual([]);
    expect(site.getScores(FROZEN)).toHaveLength(2576);
    expect(site.getScores(FROZEN).every((score) => score.runId === FROZEN)).toBe(true);
  });
});

describe('web:data:responses:read — getResponses', () => {
  it('refuses a planted answer and serves the complete approved response set', () => {
    mkdirSync(join(RUNS_DIR, SCRATCH, 'responses'), { recursive: true });
    writeFileSync(
      join(RUNS_DIR, SCRATCH, 'responses', 'lab~2Falpha__tech-901.json'),
      JSON.stringify({
        runId: SCRATCH,
        modelId: 'lab/alpha',
        questionId: 'tech-901',
        answerText: 'planted, and never bought from any provider',
      }),
    );
    expect(site.getResponses(SCRATCH)).toEqual([]);
    const approved = site.getResponses(FROZEN);
    expect(approved).toHaveLength(2576);
    expect(approved.every((response) => response.runId === FROZEN)).toBe(true);
    expect(approved.every((response) => response.answerText.trim() !== '')).toBe(true);
  });
});

describe('web:data:questions:read — getQuestions', () => {
  it('reads only the committed question bank, and takes no input that could steer it', () => {
    // LOW severity, and the claim is the one recorded: containment. The bank is
    // committed and the page filters to public items, so what matters is that
    // no caller can point this reader somewhere else.
    const paths = pathsReadBy(() => site.getQuestions());
    expect(paths.length).toBeGreaterThan(0);
    const root = join(DATA_DIR, 'questions');
    for (const p of paths) expect(inside(root, p), `${p} escaped ${root}`).toBe(true);

    // A supplied argument changes nothing, because there is nothing to supply:
    // the directory is a module constant. Asserting on the READ PATHS rather
    // than the return value is deliberate — an identical return value would
    // also be consistent with having read the right data from the wrong place.
    const steered = pathsReadBy(() =>
      (site.getQuestions as unknown as (d: string) => unknown)('../../../../etc'),
    );
    expect(steered).toEqual(paths);
  });
});

describe('web:data:models:read — getModelNames', () => {
  it('reads only the committed roster, and degrades to slugs rather than failing open', () => {
    const paths = pathsReadBy(() => site.getModelNames());
    expect(paths).toEqual([join(DATA_DIR, 'models.yaml')]);
    expect(site.getModelNames().size).toBeGreaterThan(0);
    // Display strings only, so an unreadable roster must cost nice names and
    // nothing else — a roster field the site does not read must never be able
    // to take the site down.
    expect(
      pathsReadBy(() => (site.getModelNames as unknown as (p: string) => unknown)('/etc/passwd')),
    ).toEqual(paths);
  });
});

/* ========================================================================== */
/* apps/web/lib/supabase.ts — six retired anonymous live-data routes           */
/* ========================================================================== */

describe('web anonymous live-data compatibility refusals', () => {
  it('returns refusal/null from all six public functions before fetch', async () => {
    // WP-0 has no shared permit/authority boundary for anonymous browser
    // access. A fixed URL and RLS are not that boundary, so these signatures
    // remain only as honest compatibility refusals on the no-live-data branch.
    // The recorder's default responder throws: any restored transport fails
    // this case before it can be mistaken for a successful sentinel.
    const ballot = {
      flight_id: 'f1', round: 1, ballot_nonce: 'n1', track: 'taste', item_id: 'i1',
      model_left: 'lab/alpha', model_right: 'lab/beta', choice: 'left', both_seen: true,
      dwell_ms: 10, left_words: 5, right_words: 6, control_kind: 'none', session_id: null,
    };

    expect(await siteDb.castTasteVote({
      run_id: 'r', question_id: 'q', model_a: 'a', model_b: 'b', winner: 'tie',
    })).toBe(false);
    expect(httpCalls).toEqual([]);

    expect(await siteDb.castFlightBallot(ballot)).toBe('unreachable');
    expect(httpCalls).toEqual([]);

    expect(await siteDb.castBallotReason('nonce-1', 3)).toBe('unreachable');
    expect(httpCalls).toEqual([]);

    expect(await siteDb.getAllTasteVotes()).toBeNull();
    expect(httpCalls).toEqual([]);

    expect(await siteDb.getTasteWinrates()).toBeNull();
    expect(httpCalls).toEqual([]);

    expect(await siteDb.getFlightBallots()).toBeNull();
    expect(httpCalls).toEqual([]);
  });
});

/* ========================================================================== */
/* packages/runner/src/store.ts — the medium and low severity readers          */
/* ========================================================================== */

describe('runner:store:config:read — readRunConfig', () => {
  it('refuses a run id that traverses out of the runs directory', () => {
    // The config carries the protocol binding every later stage checks against.
    // A traversing id would let a caller present an arbitrary file as the
    // protocol a published run was executed under.
    expectFirewallRefusal(() => readRunConfig('../../etc'), 'INVALID_RUN_ID', /Invalid run id/);
    expectFirewallRefusal(() => readRunConfig('a/../../b'), 'INVALID_RUN_ID', /Invalid run id/);
  });
});

describe('runner:store:attempts:read — readAttempts', () => {
  it('refuses a run id that traverses out of the runs directory', () => {
    expectFirewallRefusal(() => readAttempts('../../etc'), 'INVALID_RUN_ID', /Invalid run id/);
  });

  it('refuses an attempt record bound to no manifest before it can count as spend', () => {
    // Attempt records are the idempotency ledger: they decide whether a cell has
    // already been bought. A plausible JSON object is not evidence by itself:
    // the reader now requires the exact stored manifest/digest, declared cell,
    // deterministic filename/retry id and intact record checksum.
    mkdirSync(join(RUNS_DIR, SCRATCH, 'attempts'), { recursive: true });
    writeFileSync(
      join(RUNS_DIR, SCRATCH, 'attempts', 'planted.json'),
      JSON.stringify({
        runId: SCRATCH, modelId: 'lab/alpha', questionId: 'tech-901', cause: 'stored',
        retryId: 'not-even-the-filename', openedAtIso: '2026-01-01T00:00:00Z',
        settledAtIso: '2026-01-01T00:00:01Z', costUsd: 999, answerHash: null,
      }),
    );
    expect(() => readAttempts(SCRATCH)).toThrow(/verifiable stored manifest/i);
    expect(() => attemptChargesUsd(SCRATCH)).toThrow(ProtocolViolationError);
  });
});

describe('runner:store:scores:read — readScores', () => {
  it('refuses a run id that traverses out of the runs directory', () => {
    // scores.json is the input to both report and analyze, so a steered read
    // decides a leaderboard.
    expectFirewallRefusal(() => readScores('../../etc'), 'INVALID_RUN_ID', /Invalid run id/);
    // Control: the reader is otherwise perfectly willing, so the refusal above
    // is containment and not an unreadable fixture.
    scratchRun(SCRATCH, { 'scores.json': JSON.stringify([{ score: 1 }]) });
    expect(readScores(SCRATCH)).toHaveLength(1);
  });
});

describe('runner:store:response:probe — hasResponse', () => {
  it('answers for exactly one cell, so a resume neither re-buys nor drops one', () => {
    // The budget consequence is two-sided and this is the only thing standing
    // between them: a false negative re-buys an answer that already exists, a
    // false positive silently drops a cell from the run.
    mkdirSync(join(RUNS_DIR, SCRATCH, 'responses'), { recursive: true });
    expect(hasResponse(SCRATCH, 'lab/alpha', 'tech-901')).toBe(false);
    writeFileSync(
      join(RUNS_DIR, SCRATCH, 'responses', 'lab~2Falpha__tech-901.json'),
      JSON.stringify({ runId: SCRATCH, modelId: 'lab/alpha', questionId: 'tech-901', answerText: 'a' }),
    );
    expect(hasResponse(SCRATCH, 'lab/alpha', 'tech-901')).toBe(true);
    // The neighbouring cells the lossy legacy encoding used to collapse
    // together: `lab/alpha` and `lab:alpha` shared a filename, so one model's
    // answer read as another's and the second was never bought.
    expect(hasResponse(SCRATCH, 'lab:alpha', 'tech-901')).toBe(false);
    expect(hasResponse(SCRATCH, 'lab/alpha', 'tech-902')).toBe(false);
    expect(hasResponse(OTHER, 'lab/alpha', 'tech-901')).toBe(false);
  });

  it('refuses a run id that traverses out of the runs directory', () => {
    expectFirewallRefusal(
      () => hasResponse('../../etc', 'lab/alpha', 'tech-901'),
      'INVALID_RUN_ID',
      /Invalid run id/,
    );
  });
});

describe('runner:store:runs:list — listRuns', () => {
  it('returns bare directory names from the one runs root, and no path that leaves it', () => {
    // Registered because "it only lists" is an argument to record, not a reason
    // to omit the route. The low-severity claim is exactly this: names, from a
    // fixed root, none of which can be joined into an escape.
    scratchRun(SCRATCH, { 'config.json': '{}' });
    mkdirSync(join(RUNS_DIR, OTHER), { recursive: true });

    const runs = listRuns();
    expect(runs).toContain(SCRATCH);
    // A directory with no config.json is not a run, so listing is not a bare
    // directory dump either.
    expect(runs).not.toContain(OTHER);
    for (const name of runs) {
      expect(name).not.toContain(sep);
      expect(name).not.toContain('..');
      expect(inside(RUNS_DIR, join(RUNS_DIR, name))).toBe(true);
    }
  });
});

describe('runner:store:attempt:settle — settleAttempt', () => {
  it('books no charge against a published run, and leaves it byte-identical', () => {
    // `beginAttempt` is proved against a frozen run; this entry point was not,
    // and it is the one that writes the settled record. An attempt record
    // appearing inside a published run would rewrite what that run is on record
    // as having bought.
    const before = frozenFingerprint();
    expectFirewallRefusal(
      () => settleAttempt(
        { runId: FROZEN, modelId: 'lab/alpha', questionId: 'tech-901', cause: 'stored' },
        { costUsd: 1 },
      ),
      'HISTORICAL_WRITE',
      /historical|immutable|published/i,
    );
    expect(frozenFingerprint()).toBe(before);
    expect(existsSync(join(RUNS_DIR, FROZEN, 'attempts'))).toBe(false);
  });
});

/* ========================================================================== */
/* dataset.ts and calibration.ts — the committed inputs                        */
/* ========================================================================== */

describe('runner:dataset:questions:read — loadQuestions', () => {
  it('reads only the committed bank, and takes no input that could steer it', () => {
    // LOW severity, and the recorded argument is honest about why: the
    // directory is a module constant with no caller input, and the residual
    // risk is downstream — nothing here binds what was read to the manifest's
    // bankHash. So the claim proved is containment, not integrity.
    const paths = pathsReadBy(() => loadQuestions());
    const root = join(DATA_DIR, 'questions');
    expect(paths.length).toBeGreaterThan(0);
    for (const p of paths) expect(inside(root, p), `${p} escaped ${root}`).toBe(true);
    expect(
      pathsReadBy(() => (loadQuestions as unknown as (d: string) => unknown)('/etc')),
    ).toEqual(paths);
  });
});

describe('runner:dataset:models:read — loadModels', () => {
  it('reads only the committed roster that supplies judge conflict identity', () => {
    // MEDIUM rather than low because JUDGE-001 reads its provider and base-model
    // identities from this file: an edited roster re-seats the panel. Nothing
    // here binds the file to a manifest — that half of the risk is not enforced
    // — but no caller can point it at a different roster.
    const paths = pathsReadBy(() => loadModels());
    expect(paths).toEqual([join(DATA_DIR, 'models.yaml')]);
    expect(
      pathsReadBy(() => (loadModels as unknown as (p: string) => unknown)('/tmp/roster.yaml')),
    ).toEqual(paths);
  });
});

describe('runner:calibration:anchors:read — loadAnchors', () => {
  it('reads only the committed anchors, which decide which judges may be paid', () => {
    const paths = pathsReadBy(() => loadAnchors());
    expect(paths).toEqual([join(DATA_DIR, 'calibration', 'anchors.yaml')]);
    expect(loadAnchors().length).toBeGreaterThan(0);
    expect(
      pathsReadBy(() => (loadAnchors as unknown as (p: string) => unknown)('/tmp/anchors.yaml')),
    ).toEqual(paths);
  });
});

describe('runner:calibration:result:read — readCalibration', () => {
  it('refuses a run id that traverses out of the runs directory', () => {
    expectFirewallRefusal(() => readCalibration('../../etc'), 'INVALID_RUN_ID', /Invalid run id/);
  });

  it('refuses a hand-written pre-envelope calibration as gate evidence', () => {
    // The gate decides whether paid judging may start. This is the sparse shape
    // that used to pass by assertion alone; it now lacks every required binding
    // and cannot be upgraded merely because it says `passed: true`.
    scratchRun(SCRATCH, {
      'calibration.json': JSON.stringify({
        judgeModel: 'panel-v1', judgePromptVersion: 'judge-v2',
        atIso: '2026-07-30T00:00:00Z', mae: 0, passed: true, judges: [],
      }),
    });
    expect(() => readCalibration(SCRATCH)).toThrow(CalibrationError);
    try {
      readCalibration(SCRATCH);
    } catch (error) {
      expect((error as CalibrationError).code).toBe('CALIBRATION_LEGACY_UNVERIFIED');
    }
  });

  it('keeps published pre-envelope evidence readable but never gate-passing', () => {
    const legacy = readCalibration('2026-07-v2.1');
    expect(legacy?.calibrationVersion).toBe(0);
    if (legacy?.calibrationVersion !== 0) throw new Error('expected legacy calibration evidence');
    expect(legacy.verification).toBe('legacy-unverified');
    expect(legacy.recordedPassed).toBe(true);
    expect(legacy.passed).toBe(false);
    expect(legacy.judges.length).toBeGreaterThan(0);
  });
});

/* ========================================================================== */
/* taste.ts and sync.ts — the live-database routes nothing else drives         */
/* ========================================================================== */

/** A publication-kind grant: the only kind whose matrix allows `result-sync`. */
let permitSeq = 0;
function grantFor(capabilities: Array<'publication' | 'result-sync' | 'live-db-write'>, runId: string) {
  return mintTestGrant({
    permitId: `permit-web-${++permitSeq}`,
    kind: 'publication',
    capabilities,
    cells: [],
    runId,
  });
}

describe('runner:taste:votes:read — archiveTasteVotes', () => {
  it('refuses to read the live ballot table without result-sync, before a client exists', async () => {
    // The citation this replaces exercised `serviceRoleClient` and was doing
    // duty for four separate database routes. A shared helper is not evidence
    // about a function: what has to be true is that THIS route consults it
    // before any privileged connection is opened.
    const before = tasteFingerprint();
    await expectRefusal(
      () => archiveTasteVotes(grantFor(['publication'], 'test-run')),
      FirewallError,
      'CAPABILITY_DENIED',
      /does not grant 'result-sync'.*archiveTasteVotes/s,
    );
    expect(supabaseModule.createClient).not.toHaveBeenCalled();
    expect(tasteFingerprint()).toBe(before);
  });
});

describe('runner:taste:archive:replace — archiveTasteVotes', () => {
  it('refuses to replace the ballot record with a set that loses committed ballots', async () => {
    // The guard is well tested; what was never tested is that the WRITER calls
    // it. This drives the whole route with a database that answers with one
    // ballot the committed archive has never seen — the shape a short or
    // filtered query produces — and the archive must survive untouched.
    const before = tasteFingerprint();
    const query = {
      select: () => query,
      order: () => query,
      range: () =>
        Promise.resolve({
          data: [
            {
              id: 'planted-ballot', created_at: '2099-01-01T00:00:00Z', run_id: 'r',
              question_id: 'q', model_a: 'lab/alpha', model_b: 'lab/beta', winner: 'a',
              session_id: null, vote_ms: null,
            },
          ],
          error: null,
        }),
    };
    supabaseModule.nextClient = { from: () => query };

    let caught: unknown;
    try {
      await archiveTasteVotes(grantFor(['result-sync'], 'test-run'));
    } catch (e) {
      caught = e;
    }
    expect(caught, 'the route replaced the ballot record without checking it').toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/not a superset of the committed archive/);
    expect((caught as Error).message).toMatch(/Refusing to shrink or rewrite the permanent ballot record/);
    // The ballots are the permanent record; the board is derived. Both files
    // must be exactly as committed.
    expect(tasteFingerprint()).toBe(before);
  });
});

describe('runner:sync:run:publish — publishRun', () => {
  it('refuses to publish without the publication capability, before a client exists', async () => {
    // `publishRun` is never called by the citation that certified it — the
    // string 'publishRun' appeared there only as a context argument to
    // `serviceRoleClient`, which is why the registry now matches a CALL.
    await expectRefusal(
      () => publishRun(grantFor(['result-sync'], SCRATCH), SCRATCH),
      FirewallError,
      'CAPABILITY_DENIED',
      /does not grant 'publication'.*publishRun/s,
    );
    expect(supabaseModule.createClient).not.toHaveBeenCalled();
  });

  it('refuses to publish a run the permit does not name', async () => {
    // Authority is issued for one run. Before this binding, a permit approved
    // for a cheap development probe could publish the historical board.
    await expectRefusal(
      () => publishRun(grantFor(['publication'], OTHER), SCRATCH),
      PermitError,
      'PERMIT_RUN_MISMATCH' satisfies PermitErrorCode,
      /authorises run '.*', not '.*'/,
    );
    expect(supabaseModule.createClient).not.toHaveBeenCalled();
  });
});

/* ========================================================================== */
/* firewall.ts — the guard's own reader                                        */
/* ========================================================================== */

describe('runner:firewall:registry:read — readHistoricalRegistry', () => {
  it('takes no path, so no caller can name the file that decides what is frozen', () => {
    // Registered rather than exempt, on the argument that a guard which leaves
    // itself out of the register of dangerous routes is choosing its own scope.
    //
    // The defect this replaces, verified before it was fixed: the signature was
    // `readHistoricalRegistry(registryPath = HISTORICAL_REGISTRY)` — "exported
    // with an explicit path parameter so the failure modes are testable against
    // fixtures", which is the same sentence that used to defend the injectable
    // keyring. `{"runIds": []}` is a structurally valid registry, so a caller
    // handing over that file emptied the frozen set and made every published
    // run writable. Third instance of one defect; the permit keyring and the
    // revocation list were the first two.
    const committed = readHistoricalRegistry();
    expect(committed.has(FROZEN)).toBe(true);

    const planted = join(RUNS_DIR, SCRATCH, 'nothing-is-frozen.json');
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    writeFileSync(planted, JSON.stringify({ runIds: [] }));

    // Unreachable rather than merely refused: there is no parameter, and a
    // JavaScript caller passing one anyway is IGNORED — the committed registry
    // is still what answers, and the frozen run is still frozen.
    expect(readHistoricalRegistry.length, 'the reader grew a path parameter again').toBe(0);
    const asIfInjectable = readHistoricalRegistry as unknown as (p: string) => ReadonlySet<string>;
    expect(asIfInjectable(planted).has(FROZEN), 'a supplied registry took effect').toBe(true);

    // And the seam that CAN name a file refuses outside a test process, so the
    // fix is not one indirection deep. `UNDER_TEST` is true here, so the
    // guard is asserted by reading it rather than by tripping it.
    expect(readHistoricalRegistryForTests(planted).size).toBe(0);
    expect(
      readFileSync(join(REPO_ROOT, 'packages/runner/src/firewall.ts'), 'utf8'),
      'the seam lost its test-process guard',
    ).toContain('readHistoricalRegistryForTests is a test seam');
  });

  it('refuses a malformed registry rather than defaulting to nothing frozen', () => {
    // The half that was already enforced, asserted by its code so an unrelated
    // throw cannot stand in for it.
    const broken = join(RUNS_DIR, SCRATCH, 'broken.json');
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    writeFileSync(broken, '{ not json');
    expectFirewallRefusal(
      () => readHistoricalRegistryForTests(broken),
      'REGISTRY_INVALID',
      /Refusing to operate with an unknown immutability policy/,
    );
  });
});
