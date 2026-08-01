import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelEntry, Question, RunConfig, StoredResponse } from '@cookingbench/core';
import {
  AdjudicationError,
  readAdjudicationRecord,
  writeAdjudicationRecord,
  type AdjudicationRecord,
} from '../src/adjudicate.js';
import { DATA_DIR, RUNS_DIR } from '../src/dataset.js';
import { assertFreshEstimate, estimateHash, runEstimate } from '../src/estimate.js';
import { FirewallError, type FirewallErrorCode } from '../src/firewall.js';
import { LifecycleError, writeReleaseChecklist, type ReleaseChecklist } from '../src/lifecycle.js';
import { PermitError, type PermitErrorCode } from '../src/permit.js';
import { syncDataset, syncRun } from '../src/sync.js';
import { mintTestGrant } from './support/grant.js';

/**
 * Route-level proof for the publication surfaces: the two Supabase upserts, the
 * release checklist, the cost-estimate gate and the adjudication record.
 *
 * `docs/wp-0/routes.yaml` recorded every risk below as open for one reason: the
 * evidence offered for it exercised a HELPER — `serviceRoleClient`,
 * `writeRunFileAtomic`, `parseAdjudicationRecord` — rather than the route. A
 * test that calls `serviceRoleClient('result-sync', 'syncRun')` proves nothing
 * about `syncRun`; the string 'syncRun' in it is a context argument, not a call.
 * If `syncRun` stopped going through the guard tomorrow, that test would still
 * be green. So every test here calls the route's OWN exported function and
 * asserts the SPECIFIC refusal the risk names — an error code plus a
 * distinctive message fragment — because a refusal for an unrelated reason
 * (a malformed payload, an absent file, a protocol mismatch) must never be able
 * to stand in for the authorisation refusal being claimed.
 *
 * Offline by construction. `@supabase/supabase-js` is mocked so that
 * CONSTRUCTING a database client is itself an observable, failing event: the
 * database risks are not "it threw" but "it refused before a privileged
 * connection existed", and that is only assertable if construction is visible.
 * `globalThis.fetch` is stubbed for the whole file, so a route that reached a
 * provider fails loudly rather than quietly billing.
 */

/**
 * The service-role client, replaced by a tripwire.
 *
 * `openServiceRoleConnection` is module-private, so the seam is the package it
 * imports. A refusal is only worth recording if it happened BEFORE this ran:
 * the service-role key bypasses RLS entirely, so an unauthorised caller that
 * gets as far as a constructed client has already been handed the blast radius,
 * whatever the next line does with it.
 */
const supabaseModule = vi.hoisted(() => ({
  createClient: vi.fn(() => {
    throw new Error('SENTINEL: a service-role client was constructed');
  }),
}));
vi.mock('@supabase/supabase-js', () => supabaseModule);

const FROZEN = '2026-07-v2.1';
const SCRATCH = '__test-routes-publication-scratch';
const OTHER_RUN = '__test-routes-publication-other';

const ESTIMATE_PATH = join(DATA_DIR, '.estimate.json');

/** Top-level artifacts of the published run, all of which must not move. */
const FROZEN_FILES = ['config.json', 'scores.json', 'leaderboard.json', 'analysis.json'] as const;

/**
 * Byte identity of the published run, plus its directory listing.
 *
 * The listing is load-bearing: both writers under test create a file that does
 * not exist in the frozen run at all, so a successful write would be invisible
 * to per-file digests and shows up only as a new name in the directory.
 */
function frozenFingerprint(): string {
  const dir = join(RUNS_DIR, FROZEN);
  const h = createHash('sha256');
  h.update(readdirSync(dir).sort().join('\n'));
  for (const name of FROZEN_FILES) {
    h.update(name);
    h.update(readFileSync(join(dir, name)));
  }
  return h.digest('hex');
}

function firewallRefusal(fn: () => unknown, code: FirewallErrorCode, fragment: RegExp): FirewallError {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the route did not refuse at all').toBeInstanceOf(FirewallError);
  expect((caught as FirewallError).code).toBe(code);
  expect((caught as FirewallError).message).toMatch(fragment);
  return caught as FirewallError;
}

async function asyncRefusal<E extends Error>(
  fn: () => Promise<unknown>,
  type: new (...args: never[]) => E,
  code: string,
  fragment: RegExp,
): Promise<E> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the route did not refuse at all').toBeInstanceOf(type);
  expect((caught as { code: string }).code).toBe(code);
  expect((caught as Error).message).toMatch(fragment);
  return caught as E;
}

/** What the estimate file looked like before this suite touched it. */
let estimateBefore: string | null = null;
const realFetch = globalThis.fetch;

beforeAll(() => {
  estimateBefore = existsSync(ESTIMATE_PATH) ? readFileSync(ESTIMATE_PATH, 'utf8') : null;
  globalThis.fetch = (async () => {
    throw new Error('a route test opened the network; these routes must refuse before any outbound call');
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  // The gate record is a real, gitignored file in data/. Restore it exactly,
  // including having been absent — a leftover estimate would authorise a spend.
  if (estimateBefore === null) rmSync(ESTIMATE_PATH, { force: true });
  else writeFileSync(ESTIMATE_PATH, estimateBefore);
});

beforeEach(() => {
  supabaseModule.createClient.mockClear();
  // Present and plausible on purpose. `openServiceRoleConnection` reads these
  // before it builds anything, so leaving them unset would let a missing-config
  // error masquerade as an authorisation refusal.
  process.env.SUPABASE_URL = 'https://example.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'not-a-real-key';
});

afterEach(() => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  vi.useRealTimers();
  rmSync(join(RUNS_DIR, SCRATCH), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, OTHER_RUN), { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A live publication permit for `runId` carrying exactly `capabilities`.
 *
 * `publication` is the only kind whose matrix allows `result-sync`, so the
 * permits below are genuinely powerful ones — the refusals are about a specific
 * missing capability or a different subject, never about a toy permit that
 * could do nothing anyway.
 */
let permitSeq = 0;
function publicationGrant(capabilities: Array<'publication' | 'result-sync' | 'live-db-write'>, runId: string) {
  // Short by necessity: permitId is capped at 64 characters, and the scratch
  // run ids here are long enough to blow that on their own.
  return mintTestGrant({
    permitId: `permit-pub-${++permitSeq}`,
    kind: 'publication',
    capabilities,
    cells: [],
    runId,
  });
}

const MODELS: ModelEntry[] = [
  { id: 'lab/alpha', displayName: 'Alpha', provider: 'Lab', family: 'alpha', active: true },
];

function question(id: string, prompt: string): Question {
  return {
    id,
    category: 'technique',
    difficulty: 3,
    status: 'active',
    addedIn: 'v3',
    trap: false,
    prompt,
    grader: { type: 'keyword', required: [['rest']], forbidden: [] },
    referenceAnswer: 'Rest it before slicing.',
    public: true,
  } as Question;
}

const QUESTIONS: Question[] = [
  question('tech-901', 'How long should a 2 kg brisket rest?'),
  question('tech-902', 'Why does a steak need to rest at all?'),
];

function runConfig(runId: string): RunConfig {
  return {
    runId,
    models: ['lab/alpha'],
    temperature: 0,
    maxTokens: 16000,
    maxTokensRecipe: 32000,
    budgetUsdTotal: 1,
    budgetUsdPerModel: 0,
    concurrency: 4,
    judgeModel: 'panel-v1',
    judgePanel: ['anthropic/claude-opus-4.8'],
    judgePromptVersion: 'judge-v2',
    methodologyVersion: 'v3.0',
    mock: false,
    batches: [
      {
        startedAt: '2026-07-30T00:00:00Z',
        models: ['lab/alpha'],
        maxTokens: 16000,
        maxTokensRecipe: 32000,
        budgetUsdTotal: 1,
      },
    ],
  };
}

function storedResponse(runId: string): StoredResponse {
  return {
    runId,
    modelId: 'lab/alpha',
    questionId: 'tech-901',
    answerText: 'Rest it for an hour.',
    raw: {},
    tokensIn: 10,
    tokensOut: 20,
    costUsd: 0.01,
    latencyMs: 100,
  };
}

/* -------------------------------------------------------------------------- */
/* runner:sync:dataset:upsert — unauthorised-publish                           */
/* -------------------------------------------------------------------------- */

describe('runner:sync:dataset:upsert — syncDataset', () => {
  it('refuses to upsert the dataset without result-sync, before any client is constructed', async () => {
    // The permit is real, live and holds `publication` — the strongest thing
    // the matrix issues — and still may not write the models and questions
    // tables. The rows this route pushes are what the DB-side leaderboard view
    // reproduces Overall from, so writing them is a publication act in its own
    // right and needs the capability that was actually approved for it.
    const grant = publicationGrant(['publication'], SCRATCH);
    expect(grant.capabilities).not.toContain('result-sync');

    await asyncRefusal(
      () => syncDataset(grant, MODELS, QUESTIONS),
      FirewallError,
      'CAPABILITY_DENIED',
      /does not grant 'result-sync', required by syncDataset/,
    );
    expect(
      supabaseModule.createClient,
      'a privileged connection was opened before the capability was checked',
    ).not.toHaveBeenCalled();

    // Vacuity guard. The identical call with the capability added gets all the
    // way to the connection — so the refusal above is the authorisation check
    // and not a boundary that rejects every dataset put in front of it.
    const authorised = publicationGrant(['publication', 'result-sync'], SCRATCH);
    await expect(syncDataset(authorised, MODELS, QUESTIONS)).rejects.toThrow(/SENTINEL/);
    expect(supabaseModule.createClient).toHaveBeenCalledTimes(1);
  });

  it('refuses a permit revoked since it was verified, at the moment of the write', async () => {
    // The dataset is not run-scoped, so there is no run id to bind here and a
    // grant issued for another run is legitimately accepted (sync.ts:24-26).
    // What must still hold is that authority is checked WHEN the write happens
    // rather than when the process started: a sync takes minutes, and a permit
    // withdrawn mid-flight must stop working mid-flight. An expired permit is
    // the observable form of that.
    const grant = mintTestGrant({
      permitId: 'permit-pub-expired',
      kind: 'publication',
      capabilities: ['publication', 'result-sync'],
      cells: [],
      runId: SCRATCH,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2099-01-02T00:00:00Z'));
    await asyncRefusal(
      () => syncDataset(grant, MODELS, QUESTIONS),
      PermitError,
      'PERMIT_EXPIRED' satisfies PermitErrorCode,
      /A process may not outlive its permit/,
    );
    expect(supabaseModule.createClient).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* runner:sync:run:upsert — unauthorised-publish x2                            */
/* -------------------------------------------------------------------------- */

describe('runner:sync:run:upsert — syncRun', () => {
  it('refuses a run the permit does not name, before any client is constructed', async () => {
    // The subject, not the capability. A permit approved for a cheap
    // development probe used to be able to sync the historical board, because
    // `syncRun` took whatever config the CLI had loaded: the capability was
    // checked and the SUBJECT was not. One permit, one manifest, one run.
    const grant = publicationGrant(['publication', 'result-sync'], OTHER_RUN);
    expect(grant.capabilities).toContain('result-sync');

    await asyncRefusal(
      () => syncRun(grant, runConfig(FROZEN), [], []),
      PermitError,
      'PERMIT_RUN_MISMATCH' satisfies PermitErrorCode,
      new RegExp(`authorises run '${OTHER_RUN}', not '${FROZEN}'`),
    );
    expect(
      supabaseModule.createClient,
      'a privileged connection was opened for a run the permit never named',
    ).not.toHaveBeenCalled();

    // Vacuity guard: the same permit, pointed at its own run, reaches the
    // connection. Only the run id differs between the two calls.
    await expect(syncRun(grant, runConfig(OTHER_RUN), [], [])).rejects.toThrow(/SENTINEL/);
    expect(supabaseModule.createClient).toHaveBeenCalledTimes(1);
  });

  it('refuses to upsert a run without result-sync, before any client is constructed', async () => {
    const grant = publicationGrant(['publication'], SCRATCH);
    await asyncRefusal(
      () => syncRun(grant, runConfig(SCRATCH), [], []),
      FirewallError,
      'CAPABILITY_DENIED',
      /does not grant 'result-sync', required by syncRun/,
    );
    expect(supabaseModule.createClient).not.toHaveBeenCalled();
  });

  it('refuses a payload carrying rows from another run, before any client is constructed', async () => {
    // The second half of the binding, and the half a run-id check alone misses:
    // every row's `run_id` is REWRITTEN to the grant's on the way out
    // (supabase.ts:215), so a mixed batch would file another run's answers under
    // an approved run's id and the published artifact would be a splice of two
    // runs. The payload is what reaches the live table, so the payload is what
    // has to be checked.
    const grant = publicationGrant(['publication', 'result-sync'], SCRATCH);
    await asyncRefusal(
      () => syncRun(grant, runConfig(SCRATCH), [storedResponse(FROZEN)], []),
      PermitError,
      'PERMIT_RUN_MISMATCH' satisfies PermitErrorCode,
      /1 row\(s\) belong to another run/,
    );
    expect(supabaseModule.createClient).not.toHaveBeenCalled();

    // Vacuity guard: the same row, re-addressed to the approved run, passes the
    // check and the call proceeds to the connection.
    await expect(syncRun(grant, runConfig(SCRATCH), [storedResponse(SCRATCH)], [])).rejects.toThrow(
      /SENTINEL/,
    );
    expect(supabaseModule.createClient).toHaveBeenCalledTimes(1);
  });
});

/* -------------------------------------------------------------------------- */
/* runner:lifecycle:checklist:write — unauthorised-publish                     */
/* -------------------------------------------------------------------------- */

function checklist(runId: string, complete: boolean): ReleaseChecklist {
  return {
    checklistVersion: 1,
    runId,
    generatedAt: '2026-07-31T00:00:00Z',
    manifestHash: null,
    items: [{ id: 'board-present', statement: 'A leaderboard exists.', verdict: 'pass', detail: 'ok' }],
    complete,
  };
}

describe('runner:lifecycle:checklist:write — writeReleaseChecklist', () => {
  it('refuses to certify a published run for release', () => {
    // The checklist is the artifact that says a run was reviewed and may be
    // published. Writing a fresh one into a frozen run would re-certify work
    // that was already released, under a review nobody performed — and it would
    // do so by ADDING a file the published directory does not contain, which is
    // why the fingerprint below covers the directory listing.
    const before = frozenFingerprint();
    firewallRefusal(
      () => writeReleaseChecklist(FROZEN, checklist(FROZEN, true)),
      'HISTORICAL_WRITE',
      /historical and immutable \(DATA-001\)/,
    );
    expect(frozenFingerprint()).toBe(before);

    // Control: the identical payload at an unpublished id is written normally,
    // so the refusal is about the run being published and nothing else.
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    const path = writeReleaseChecklist(SCRATCH, checklist(SCRATCH, true));
    expect(existsSync(path)).toBe(true);
  });

  it('refuses a checklist that certifies a different run', () => {
    // A checklist carries the run it was computed for. Writing run A's passing
    // checklist into run B's directory would certify B on evidence gathered
    // about A — the release gate reads the id, and the id would agree with the
    // directory it was found in. Refused at the writer, where the two are still
    // distinguishable.
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    let caught: unknown;
    try {
      writeReleaseChecklist(SCRATCH, checklist(OTHER_RUN, true));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LifecycleError);
    expect((caught as LifecycleError).code).toBe('CHECKLIST_MISMATCH');
    expect((caught as LifecycleError).message).toMatch(
      new RegExp(`names run '${OTHER_RUN}' but is being written into '${SCRATCH}'`),
    );
    expect(existsSync(join(RUNS_DIR, SCRATCH, 'release-checklist.json'))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* runner:estimate:record:write / :read — budget-bypass                        */
/* -------------------------------------------------------------------------- */

const CAPS = { maxTokens: 16000, maxTokensRecipe: 32000 };
const MODEL_IDS = ['lab/alpha'];

/** A catalog reply priced high enough that the gate would notice the cost. */
function stubCatalog(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'lab/alpha',
              name: 'Alpha',
              created: 0,
              pricing: { prompt: '0.00001', completion: '0.0005' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('runner:estimate:record:write — runEstimate', () => {
  it('refuses to mint the gate record without catalog-read, before the catalog is fetched', async () => {
    // `.estimate.json` is the record `bench run` gates a paid batch on. Minting
    // one is therefore a budget act, and the permit that authorises the SPEND
    // does not thereby authorise writing the gate that approves it: this grant
    // holds `candidate-inference` and is still refused.
    rmSync(ESTIMATE_PATH, { force: true });
    const fetchSpy = stubCatalog();
    const grant = mintTestGrant({
      permitId: 'permit-estimate-nocatalog',
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: QUESTIONS.map((q) => ({ modelId: 'lab/alpha', questionId: q.id })),
      runId: SCRATCH,
    });

    await asyncRefusal(
      () => runEstimate(grant, MODEL_IDS, QUESTIONS, CAPS),
      FirewallError,
      'CAPABILITY_DENIED',
      /does not grant 'catalog-read', required by fetchCatalog/,
    );
    expect(fetchSpy, 'the catalog was fetched before the capability was checked').not.toHaveBeenCalled();
    expect(existsSync(ESTIMATE_PATH), 'a refused estimate still wrote the gate record').toBe(false);

    // Vacuity guard: the same call with catalog-read mints the record.
    const authorised = mintTestGrant({
      permitId: 'permit-estimate-catalog',
      kind: 'development-probe',
      capabilities: ['catalog-read'],
      cells: [],
      runId: SCRATCH,
    });
    const record = await runEstimate(authorised, MODEL_IDS, QUESTIONS, CAPS);
    expect(record.totalExpectedUsd).toBeGreaterThan(0);
    expect(existsSync(ESTIMATE_PATH)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe('runner:estimate:record:read — assertFreshEstimate', () => {
  /** Mint a genuine record through the writer, so the reader reads real work. */
  async function mintRecord() {
    stubCatalog();
    const grant = mintTestGrant({
      permitId: 'permit-estimate-mint',
      kind: 'development-probe',
      capabilities: ['catalog-read'],
      cells: [],
      runId: SCRATCH,
    });
    const record = await runEstimate(grant, MODEL_IDS, QUESTIONS, CAPS);
    vi.unstubAllGlobals();
    return { record, grant };
  }

  it('refuses to authorise a run with no estimate on file', async () => {
    // Deny-by-default at the money boundary: an absent gate record is not a
    // free run, and deleting the file must not be a way to skip the gate.
    rmSync(ESTIMATE_PATH, { force: true });
    const grant = mintTestGrant({
      permitId: 'permit-estimate-absent',
      kind: 'development-probe',
      capabilities: ['catalog-read'],
      cells: [],
      runId: SCRATCH,
    });
    await expect(assertFreshEstimate(grant, MODEL_IDS, QUESTIONS, CAPS)).rejects.toThrow(
      /No cost estimate found\. Run `pnpm bench estimate` first\./,
    );
  });

  it('refuses an estimate minted for a different model set or token cap', async () => {
    // The estimate gate exists because the priced set and the run set can
    // silently diverge: estimating one model and running three, or estimating
    // at an 8k cap and running at 32k, is how a batch costs several times what
    // was approved. The hash covers models, items and both caps.
    const { record, grant } = await mintRecord();
    stubCatalog();
    await expect(assertFreshEstimate(grant, MODEL_IDS, QUESTIONS, CAPS)).resolves.toMatchObject({
      hash: record.hash,
    });
    vi.unstubAllGlobals();

    await expect(assertFreshEstimate(grant, [...MODEL_IDS, 'lab/beta'], QUESTIONS, CAPS)).rejects.toThrow(
      /The saved estimate does not match this run/,
    );
    await expect(assertFreshEstimate(grant, MODEL_IDS, [QUESTIONS[0]!], CAPS)).rejects.toThrow(
      /The saved estimate does not match this run/,
    );
    await expect(
      assertFreshEstimate(grant, MODEL_IDS, QUESTIONS, { ...CAPS, maxTokensRecipe: 64000 }),
    ).rejects.toThrow(/The saved estimate does not match this run/);
  });

  it('refuses to re-price the gate without catalog-read, before making a request', async () => {
    await mintRecord();
    const candidateOnly = mintTestGrant({
      permitId: 'permit-estimate-read-nocatalog',
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: QUESTIONS.map((q) => ({ modelId: 'lab/alpha', questionId: q.id })),
      runId: SCRATCH,
    });
    const fetchSpy = stubCatalog();
    await asyncRefusal(
      () => assertFreshEstimate(candidateOnly, MODEL_IDS, QUESTIONS, CAPS),
      FirewallError,
      'CAPABILITY_DENIED',
      /does not grant 'catalog-read', required by fetchCatalog/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('refuses an estimate that has gone stale', async () => {
    // Prices move and rosters move. A record minted a week ago describes a run
    // that no longer exists; accepting it would gate today's spend on last
    // week's arithmetic. The clock is moved rather than the file, so this is a
    // genuine record ageing, not a doctored one.
    const { record, grant } = await mintRecord();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.parse(record.atIso) + 25 * 60 * 60 * 1000));
    await expect(assertFreshEstimate(grant, MODEL_IDS, QUESTIONS, CAPS)).rejects.toThrow(
      /The saved estimate is older than 24h/,
    );
    // And it is the age, not the identity: one hour earlier the same file passes.
    vi.setSystemTime(new Date(Date.parse(record.atIso) + 23 * 60 * 60 * 1000));
    stubCatalog();
    await expect(assertFreshEstimate(grant, MODEL_IDS, QUESTIONS, CAPS)).resolves.toMatchObject({
      hash: record.hash,
    });
    vi.unstubAllGlobals();
  });

  it('refuses a hand-written low estimate after recomputing the priced work from the live catalogue', async () => {
    // The saved file is a convenience record, never the authority for its own
    // money fields. The run re-fetches the catalogue under its verified grant
    // and recomputes the exact model/question/token-cap work before it can
    // redeem a permit or create a candidate client.
    const { record: honest, grant } = await mintRecord();
    expect(honest.totalExpectedUsd).toBeGreaterThan(1);

    writeFileSync(
      ESTIMATE_PATH,
      JSON.stringify({
        hash: estimateHash(MODEL_IDS, QUESTIONS, CAPS.maxTokens, CAPS.maxTokensRecipe),
        atIso: new Date().toISOString(),
        totalWorstCaseUsd: 0.01,
        totalExpectedUsd: 0.01,
        perModel: [],
      }),
    );

    const fetchSpy = stubCatalog();
    await expect(assertFreshEstimate(grant, MODEL_IDS, QUESTIONS, CAPS)).rejects.toThrow(
      /no longer matches live catalogue pricing or its priced work/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

/* -------------------------------------------------------------------------- */
/* runner:adjudicate:record:write — historical-overwrite                       */
/* -------------------------------------------------------------------------- */

function record(runId: string): AdjudicationRecord {
  return { version: 1, runId, queueHash: 'a'.repeat(64), decisions: [] };
}

describe('runner:adjudicate:record:write — writeAdjudicationRecord', () => {
  it('refuses to write a decision record into a published run', () => {
    // The record holds the reviewer decisions that gate whether a run may
    // report. Writing one into a frozen run would retro-clear disputes on a
    // board that has already been published — the queue writer is guarded and
    // this one shares its helper, but sharing a helper is not evidence, so the
    // route is called here directly.
    const before = frozenFingerprint();
    firewallRefusal(
      () => writeAdjudicationRecord(record(FROZEN), 'runs'),
      'HISTORICAL_WRITE',
      /historical and immutable \(DATA-001\)/,
    );
    expect(frozenFingerprint()).toBe(before);

    // Control: the identical record at an unpublished id is written normally.
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    const path = writeAdjudicationRecord(record(SCRATCH), 'runs');
    expect(JSON.parse(readFileSync(path, 'utf8')).runId).toBe(SCRATCH);
  });

  it('refuses a run id that traverses out of the runs directory', () => {
    // The record's target is derived from the id it carries, so a traversing id
    // would place reviewer decisions anywhere on disk — and, read back, would
    // present arbitrary JSON as a run's cleared disputes.
    firewallRefusal(
      () => writeAdjudicationRecord(record('../../etc'), 'runs'),
      'INVALID_RUN_ID',
      /Invalid run id/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* runner:adjudicate:record:read — unverified-input                            */
/* -------------------------------------------------------------------------- */

describe('runner:adjudicate:record:read — readAdjudicationRecord', () => {
  function plant(body: string): void {
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    writeFileSync(join(RUNS_DIR, SCRATCH, 'adjudication.json'), body);
  }

  it('refuses an unparseable record rather than reading it as "no disputes"', () => {
    // The distinction the whole route exists for. `null` from this reader means
    // "no decisions yet" and blocks a report while the queue holds a case; an
    // unreadable file must not collapse into that same answer, because the
    // failure mode is silent and points the wrong way — a truncated write would
    // read as a clean bill of health. Same equivalence `readHistoricalRegistry`
    // was fixed for, asserted here through the reader rather than the parser.
    plant('{"version": 1, "runId": "');
    let caught: unknown;
    try {
      readAdjudicationRecord(SCRATCH, 'runs');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AdjudicationError);
    expect((caught as AdjudicationError).code).toBe('INVALID_RECORD');
    expect((caught as AdjudicationError).message).toMatch(
      /refusing to treat an unreadable record as an empty one/,
    );

    // Both controls, because the claim is a three-way distinction and two of
    // the three outcomes are indistinguishable without them: a well-formed
    // record parses, and a genuinely absent one is null rather than an error.
    plant(JSON.stringify(record(SCRATCH)));
    expect(readAdjudicationRecord(SCRATCH, 'runs')?.runId).toBe(SCRATCH);
    rmSync(join(RUNS_DIR, SCRATCH, 'adjudication.json'));
    expect(readAdjudicationRecord(SCRATCH, 'runs')).toBeNull();
  });

  it('refuses a record whose decisions do not validate, through the reader', () => {
    // Valid JSON is not a valid record. A decision resolved by a model is the
    // panel grading its own dispute, and it reaches this boundary as a
    // perfectly well-formed file — so the reader has to run the validator, not
    // merely parse. The whole file is refused; a bad decision is never dropped
    // quietly, which would leave a partial record reading as a complete one.
    plant(
      JSON.stringify({
        version: 1,
        runId: SCRATCH,
        queueHash: 'a'.repeat(64),
        decisions: [
          {
            caseId: 'case-1',
            decision: 'uphold',
            evidence: 'Both seats cite the same passage and the reference agrees.',
            confidence: 0.8,
            reviewer: {
              id: 'reviewer-1',
              role: 'chef',
              qualification: 'twelve years professional kitchens',
              independent: true,
              provenance: 'model',
            },
            decidedAt: '2026-08-01T10:00:00Z',
            itemChangeRequired: false,
            judgePromptChangeRequired: false,
          },
        ],
      }),
    );
    let caught: unknown;
    try {
      readAdjudicationRecord(SCRATCH, 'runs');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AdjudicationError);
    expect((caught as AdjudicationError).code).toBe('INVALID_RECORD');
    expect((caught as AdjudicationError).message).toMatch(
      /an adjudication resolved by a model is the panel grading its own dispute/,
    );
  });

  it('refuses a run id that traverses out of the runs directory', () => {
    // A read is how untrusted content crosses the boundary. A traversing id
    // would let any JSON on the machine present itself as this run's cleared
    // disputes, and the report gate would believe it.
    firewallRefusal(() => readAdjudicationRecord('../../etc', 'runs'), 'INVALID_RUN_ID', /Invalid run id/);
  });
});
