import { generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, type RunConfig, type Score, type StoredResponse } from '@cookingbench/core';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNS_DIR } from '../src/dataset.js';
import { FirewallError } from '../src/firewall.js';
import { BudgetExceededError, ReservationLedger } from '../src/ledger.js';
import { OpenRouterClient } from '../src/openrouter.js';
import { PermitError, frozenMethodologyHash, manifestHash } from '../src/permit.js';
import { redeemPermit } from '../src/redemption.js';
import { serviceRoleClient } from '../src/supabase.js';
import { publishRun, syncRun } from '../src/sync.js';
import { verifyWithInstalledPublicKey, withTemporarilyRevokedPermit } from './support/production-trust.js';

/**
 * The permit chain, end to end, for the first time.
 *
 * Every link had unit tests and the CHAIN had none. `mintTestGrant` short-cuts
 * straight to a verified grant, so nothing anywhere proved that a permit file
 * written to disk verifies, redeems, opens a ledger, builds a client and gets a
 * call through — which is the only sequence that will ever run for real. The
 * pieces fitting individually is not the same claim.
 *
 * Offline, and provably so: `globalThis.fetch` is stubbed with a spy — both for
 * the model provider and, in the database section, for PostgREST, so sync and
 * publish run against a mock provider — the key is generated into a temp
 * directory, and the assertions include that no request is made on any refused
 * path. No socket is opened.
 *
 * The permit FILE is read here and its envelope is passed through the production
 * verifier. Its ephemeral public key is installed in the fixed keyring for that
 * synchronous verification only; no runtime test verifier or selectable trust
 * root exists.
 */

const RUN = '__test-permit-e2e-scratch';
const RUN_DIR = join(RUNS_DIR, RUN);
const KEY_ID = `e2e-ephemeral-${process.pid}-${randomUUID().slice(0, 12)}`;
const CANDIDATE = 'openai/gpt-5.5';
const SEAT = 'anthropic/claude-opus-4.8';
const METHODOLOGY_HASH = frozenMethodologyHash();

let scratch: string;
let signingKey: ReturnType<typeof generateKeyPairSync<'ed25519'>>['privateKey'];
let publicKeyPem: string;

beforeAll(() => {
  // The signing key exists only for the lifetime of this test and is never
  // written into the repository. Production has no signing key on disk at all:
  // a system that can mint its own permits approves itself.
  const pair = generateKeyPairSync('ed25519');
  signingKey = pair.privateKey;
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
});

beforeEach(() => {
  process.env.OPENROUTER_API_KEY ??= 'test-key-not-used-offline';
  scratch = mkdtempSync(join(tmpdir(), 'cb-permit-e2e-'));
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(scratch, { recursive: true, force: true });
  rmSync(RUN_DIR, { recursive: true, force: true });
});

function manifest(budgetCapUsd = 5) {
  return {
    manifestVersion: 1,
    runId: RUN,
    methodologyVersion: 'v3.0',
    schemaVersion: '1',
    gitCommit: '980dfcb5e3ff920fe1a3231121a6115e3fa48dcb',
    parentArtifacts: [],
    evidenceClass: 'development-probe',
    artifactOrigin: ['live-provider'],
    releaseState: 'draft',
    rankEligible: false,
    bankHash: 'a'.repeat(64),
    promptHash: 'b'.repeat(64),
    judgePromptHash: 'c'.repeat(64),
    validatorHash: 'd'.repeat(64),
    candidateRoutes: [
      { modelId: CANDIDATE, provider: 'openai', baseModelFamily: 'gpt-frontier' },
    ],
    judgeRoutes: [{ modelId: SEAT, provider: 'anthropic', baseModelFamily: 'claude-frontier' }],
    generationSettings: {
      temperature: 0,
      maxTokens: 16000,
      maxTokensRecipe: 32000,
      repeats: 1,
      repeatPolicy: 'single',
    },
    callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
    budgetCapUsd,
    outputRoot: `data/runs/${RUN}`,
  };
}

/**
 * The other kind of manifest a permit can bind: an already-released public
 * artifact, which is the only class `publication` may act on.
 */
function publicationManifest(releaseState = 'released', runId = RUN) {
  return {
    ...manifest(),
    runId,
    outputRoot: `data/runs/${runId}`,
    evidenceClass: 'public-release',
    releaseState,
    rankEligible: true,
    artifactOrigin: ['live-provider'],
  };
}

/** Write a real signed permit file, exactly as an approver would hand it over. */
function writePermit(
  overrides: Record<string, unknown> = {},
  boundManifest: { budgetCapUsd: number } & Record<string, unknown> = manifest(),
): string {
  const permit = {
    permitVersion: 1,
    permitId: 'permit-e2e-0001',
    kind: 'development-probe',
    manifestHash: manifestHash(boundManifest),
    methodologyHash: METHODOLOGY_HASH,
    capabilities: ['candidate-inference', 'judge-inference'],
    cells: [
      { modelId: CANDIDATE, questionId: 'conv-001' },
      { modelId: CANDIDATE, questionId: 'conv-002' },
    ],
    budgetCapUsd: boundManifest.budgetCapUsd,
    reservationScope: 'call',
    issuer: 'e2e-test',
    approver: 'e2e-test',
    approvalEvidence: 'permit chain end-to-end test',
    notBefore: '2020-01-01T00:00:00Z',
    notAfter: '2099-01-01T00:00:00Z',
    executionLimit: 1,
    ...overrides,
  };
  const path = join(scratch, 'permit.json');
  writeFileSync(
    path,
    JSON.stringify({
      permit,
      // Signed over the canonical JSON of the body as written, which is what
      // verifyPermit checks — before it parses a single field of it.
      signature: signBytes(null, Buffer.from(canonicalJson(permit), 'utf8'), signingKey).toString('base64'),
      keyId: KEY_ID,
    }),
  );
  return path;
}

function verify(permitPath: string, boundManifest: unknown = manifest()) {
  if (!existsSync(permitPath)) throw new Error(`no permit at ${permitPath}`);
  return verifyWithInstalledPublicKey(
    KEY_ID,
    publicKeyPem,
    {
      signedPermit: JSON.parse(readFileSync(permitPath, 'utf8')),
      manifest: boundManifest,
    },
  );
}

function stubOk(costUsd: number) {
  const spy = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'braise it low and slow' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 12, completion_tokens: 34, cost: costUsd },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('the permit chain works end to end', () => {
  it('carries a signed file through verify, redeem, ledger, client and a call', async () => {
    const fetchSpy = stubOk(0.11);
    const permitPath = writePermit();

    // 1. Verify. Nothing before this point may be acted on.
    const { grant, permit } = verify(permitPath);
    expect(grant.permitId).toBe('permit-e2e-0001');
    expect(grant.keyId).toBe(KEY_ID);
    expect(grant.manifestHash).toBe(permit.manifestHash);
    expect(grant.runId).toBe(RUN);

    // 2. Redeem, at the point of no return, and prove it is durable.
    const redemption = redeemPermit(grant, 'permit-e2e');
    expect(redemption.sequence).toBe(1);
    expect(existsSync(redemption.path)).toBe(true);
    const record = JSON.parse(readFileSync(redemption.path, 'utf8'));
    expect(record).toMatchObject({
      permitId: 'permit-e2e-0001',
      keyId: KEY_ID,
      manifestHash: grant.manifestHash,
      context: 'permit-e2e',
      sequence: 1,
      executionLimit: 1,
    });

    // 3. Ledger. The cap comes from the grant, not from an argument.
    const ledger = ReservationLedger.forGrant(grant, RUN, { lock: false });
    expect(ledger.capUsd).toBe(5);

    // 4. Client, then a call that is authorised, priced and settled.
    const client = OpenRouterClient.forCandidates(grant, ledger);
    const result = await client.complete(CANDIDATE, [{ role: 'user', content: 'how do I braise?' }], {
      temperature: 0,
      maxTokens: 100,
      cell: { modelId: CANDIDATE, questionId: 'conv-001' },
      estimateUsd: 2,
    });

    expect(result.text).toContain('braise');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ledger.settledUsd).toBeCloseTo(0.11, 10);
    expect(ledger.openReservations).toBe(0);

    // 5. And the spend is on disk, so a resumed run inherits it.
    const journal = readFileSync(join(RUN_DIR, 'spend.ndjson'), 'utf8').trim().split('\n');
    expect(journal).toHaveLength(1);
    expect(JSON.parse(journal[0]!)).toMatchObject({
      permitId: 'permit-e2e-0001',
      modelId: CANDIDATE,
      actualUsd: 0.11,
    });
  });

  it('judges an authorised answer with a seat the permit never names', async () => {
    // The seat is not a cell and must not need to be — the permit authorises
    // which ANSWERS may be scored, and the panel decides who scores them.
    const fetchSpy = stubOk(0.03);
    const { grant } = verify(writePermit());
    const ledger = ReservationLedger.forGrant(grant, RUN, { lock: false });
    const judge = OpenRouterClient.forJudging(grant, ledger);

    await judge.complete(SEAT, [{ role: 'user', content: 'score this' }], {
      temperature: 0,
      maxTokens: 100,
      reasoning: { effort: 'low' },
      cell: { modelId: CANDIDATE, questionId: 'conv-002' },
      estimateUsd: 0.5,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ledger.settledByModel()[SEAT]).toBeCloseTo(0.03, 10);

    // An answer the permit does not authorise is refused, seat or no seat.
    await expect(
      judge.complete(SEAT, [{ role: 'user', content: 'score this' }], {
        temperature: 0,
        maxTokens: 100,
        cell: { modelId: CANDIDATE, questionId: 'conv-404' },
        estimateUsd: 0.5,
      }),
    ).rejects.toThrow(FirewallError);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // still one: refused before the socket
  });

  it('refuses the second redemption of a single-use permit, after the first has spent', async () => {
    stubOk(0.11);
    const { grant } = verify(writePermit());
    expect(redeemPermit(grant, 'first').sequence).toBe(1);
    expect(() => redeemPermit(grant, 'second')).toThrow(PermitError);
    expect(() => redeemPermit(grant, 'second')).toThrow(/execution limit/);
  });

  it('stops the chain at the permit budget even though the manifest allows more', async () => {
    // A permit may spend LESS than its manifest, never more, and the ledger is
    // what makes that a property of the actual spend rather than of an estimate.
    const boundManifest = manifest(5);
    const permitPath = writePermit({ budgetCapUsd: 1 }, boundManifest);
    const { grant } = verify(permitPath, boundManifest);
    expect(grant.budgetCapUsd).toBe(1);

    const fetchSpy = stubOk(0.6);
    const ledger = ReservationLedger.forGrant(grant, RUN, { lock: false });
    const client = OpenRouterClient.forCandidates(grant, ledger);
    const call = (questionId: string) =>
      client.complete(CANDIDATE, [{ role: 'user', content: 'hi' }], {
        temperature: 0,
        maxTokens: 100,
        cell: { modelId: CANDIDATE, questionId },
        estimateUsd: 0.6,
      });
    await call('conv-001');
    await expect(call('conv-002')).rejects.toThrow(BudgetExceededError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ledger.settledUsd).toBeCloseTo(0.6, 10);
  });

  it('breaks the chain at the first link when the permit file is tampered with', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const permitPath = writePermit();
    const envelope = JSON.parse(readFileSync(permitPath, 'utf8'));

    // Raising the budget after signing: the classic edit, and the one the
    // signature exists to catch. Nothing downstream is reached.
    envelope.permit.budgetCapUsd = 5000;
    writeFileSync(permitPath, JSON.stringify(envelope));
    expect(() => verify(permitPath)).toThrow(/valid Ed25519 signature/);

    // Adding a cell after signing, likewise.
    const clean = JSON.parse(readFileSync(writePermit(), 'utf8'));
    clean.permit.cells.push({ modelId: CANDIDATE, questionId: 'conv-003' });
    writeFileSync(permitPath, JSON.stringify(clean));
    expect(() => verify(permitPath)).toThrow(/valid Ed25519 signature/);

    // And a permit bound to a different envelope than the one presented.
    expect(() => verify(writePermit(), manifest(4))).toThrow(/authorises manifest/);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(RUN_DIR)).toBe(false); // nothing was written for a refused permit
  });
});

// ---------------------------------------------------------------------------
// The live-data half of the chain, against a mock provider
// ---------------------------------------------------------------------------

/**
 * A mock PostgREST. Records every request and answers plausibly, so the sync
 * and publish path can be exercised without a database — and so the tests can
 * assert what was NOT sent, which is the more important half.
 */
function stubPostgrest(idRows: Array<{ id: number; model_id: string; question_id: string }> = []) {
  const seen: Array<{ url: string; method: string; body: string | null }> = [];
  const spy = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    seen.push({ url, method, body: init?.body === undefined ? null : String(init.body) });
    const payload = method === 'GET' && url.includes('/responses') ? idRows : [];
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', spy);
  return { seen, spy };
}

function syncPermit(runId = RUN, releaseState = 'released') {
  const boundManifest = publicationManifest(releaseState, runId);
  const path = writePermit(
    {
      permitId: 'permit-e2e-sync01',
      kind: 'publication',
      capabilities: ['publication', 'result-sync', 'live-db-write'],
      cells: [],
    },
    boundManifest,
  );
  return verify(path, boundManifest).grant;
}

function runConfig(runId: string): RunConfig {
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
    judgePromptVersion: 'v3',
    methodologyVersion: 'v3.0',
  } as RunConfig;
}

function storedResponse(runId: string): StoredResponse {
  return {
    runId,
    modelId: CANDIDATE,
    questionId: 'conv-001',
    answerText: 'braise it',
    raw: {},
    tokensIn: 1,
    tokensOut: 2,
    costUsd: 0.01,
    latencyMs: 10,
  };
}

function score(runId: string): Score {
  return {
    runId,
    modelId: CANDIDATE,
    questionId: 'conv-001',
    score: 100,
    graderType: 'keyword',
    detail: {},
  };
}

describe('the live-data chain refuses authority meant for another run', () => {
  beforeEach(() => {
    // Not a real project. Every request is answered by the stub above.
    process.env.SUPABASE_URL = 'https://mock.invalid';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
  });
  afterEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it('syncs a run through fixed operations, and never hands out a client', async () => {
    const { seen } = stubPostgrest([{ id: 7, model_id: CANDIDATE, question_id: 'conv-001' }]);
    const grant = syncPermit();

    // The capability check no longer buys an unrestricted service-role client.
    // If it did, every check above it would be a turnstile in front of an open
    // door: `.from('taste_votes').delete()` was reachable from a result-sync
    // permit for the whole of the previous revision.
    const ops = serviceRoleClient(grant, 'result-sync', 'assert') as unknown as Record<string, unknown>;
    for (const escape of ['from', 'rpc', 'auth', 'storage', 'schema', 'realtime', 'functions']) {
      expect(ops[escape], `operations expose ${escape}`).toBeUndefined();
    }
    expect(Object.keys(ops).sort()).toEqual([
      'readResponseIds',
      'readTasteVotes',
      'runId',
      'upsertModels',
      'upsertQuestions',
      'upsertResponses',
      'upsertRun',
      'upsertScores',
    ]);

    await syncRun(grant, runConfig(RUN), [storedResponse(RUN)], [score(RUN)]);
    const tables = seen.map((r) => `${r.method} ${new URL(r.url).pathname}`);
    expect(tables).toContain('POST /rest/v1/runs');
    expect(tables).toContain('POST /rest/v1/responses');
    expect(tables).toContain('GET /rest/v1/responses');
    expect(tables).toContain('POST /rest/v1/scores');
    // Every row went out under the GRANT's run id, not the caller's string.
    for (const body of seen.map((r) => r.body).filter(Boolean)) {
      expect(body).not.toContain('some-other-run');
    }
  });

  it('refuses to sync a run the permit was not issued for, before opening a connection', async () => {
    const { spy } = stubPostgrest();
    const grant = syncPermit(RUN);
    // The approval is for RUN; the command is acting on another run. This is
    // the gap RUN-001 recorded: neither sync nor publish compared them.
    await expect(
      syncRun(grant, runConfig('some-other-run'), [storedResponse('some-other-run')], []),
    ).rejects.toThrow(/authorises run/);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a payload carrying rows from another run under an approved run id', async () => {
    const { spy } = stubPostgrest();
    const grant = syncPermit(RUN);
    // The config says the approved run, the rows say something else — and the
    // rows are what reaches the table, because run_id is rewritten on the way
    // out. Checking only the config would launder them.
    await expect(
      syncRun(grant, runConfig(RUN), [storedResponse('another-run')], [score(RUN)]),
    ).rejects.toThrow(PermitError);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses to publish another run, and refuses to publish an unreleased one', async () => {
    const { spy } = stubPostgrest();
    await expect(publishRun(syncPermit(RUN), '2026-07-v2.1')).rejects.toThrow(/authorises run/);

    // RELEASE-002 at the live boundary: a public-release manifest that is still
    // a draft carries the publication capability but is not publishable.
    await expect(publishRun(syncPermit(RUN, 'draft'), RUN)).rejects.toThrow(/release state/);
    expect(spy).not.toHaveBeenCalled();

    await expect(publishRun(syncPermit(RUN), RUN)).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stops mid-sync when the permit is revoked while it is being used', async () => {
    const { seen } = stubPostgrest();
    const grant = syncPermit();
    const ops = serviceRoleClient(grant, 'result-sync', 'archive');
    await ops.upsertModels([]);
    expect(seen).toHaveLength(1);

    // Revocation while the operations object is still in hand. A check that ran
    // only when the permit was loaded would never see this.
    await withTemporarilyRevokedPermit(grant.permitId, async () => {
      await expect(ops.upsertQuestions([])).rejects.toThrow(/revoked/);
      await expect(ops.readTasteVotes({ from: 0, to: 999 })).rejects.toThrow(/revoked/);
    });
    expect(seen, 'a revoked permit still reached the database').toHaveLength(1);
  });
});
