import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@cookingbench/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNS_DIR } from '../src/dataset.js';
import { FirewallError } from '../src/firewall.js';
import { BudgetExceededError, ReservationLedger } from '../src/ledger.js';
import { OpenRouterClient } from '../src/openrouter.js';
import { PermitError, manifestHash, sha256Hex, verifyPermitFile } from '../src/permit.js';
import { redeemPermit } from '../src/redemption.js';

/**
 * The permit chain, end to end, for the first time.
 *
 * Every link had unit tests and the CHAIN had none. `mintTestGrant` short-cuts
 * straight to a verified grant, so nothing anywhere proved that a permit file
 * written to disk verifies, redeems, opens a ledger, builds a client and gets a
 * call through — which is the only sequence that will ever run for real. The
 * pieces fitting individually is not the same claim.
 *
 * Offline, and provably so: `globalThis.fetch` is stubbed with a spy, the key
 * is generated into a temp directory, and the assertions include that no
 * request is made on any refused path. No socket is opened.
 */

const RUN = '__test-permit-e2e-scratch';
const RUN_DIR = join(RUNS_DIR, RUN);
const KEY_ID = 'e2e-ephemeral';
const CANDIDATE = 'openai/gpt-5.5';
const SEAT = 'anthropic/claude-opus-4.8';
const METHODOLOGY_HASH = sha256Hex('e2e-frozen-methodology');

let scratch: string;
let keyringDir: string;
let revocationListPath: string;
let signingKey: ReturnType<typeof generateKeyPairSync<'ed25519'>>['privateKey'];

beforeEach(() => {
  process.env.OPENROUTER_API_KEY ??= 'test-key-not-used-offline';
  scratch = mkdtempSync(join(tmpdir(), 'cb-permit-e2e-'));
  keyringDir = join(scratch, 'keys');
  mkdirSync(keyringDir, { recursive: true });
  // The signing key exists only for the lifetime of this test and is never
  // written into the repository. Production has no signing key on disk at all:
  // a system that can mint its own permits approves itself.
  const pair = generateKeyPairSync('ed25519');
  signingKey = pair.privateKey;
  writeFileSync(
    join(keyringDir, `${KEY_ID}.pub`),
    pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  );
  revocationListPath = join(scratch, 'revoked.json');
  writeFileSync(revocationListPath, JSON.stringify({ permitIds: [] }));
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
    gitCommit: '980dfcb',
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

/** Write a real signed permit file, exactly as an approver would hand it over. */
function writePermit(
  overrides: Record<string, unknown> = {},
  boundManifest: ReturnType<typeof manifest> = manifest(),
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

function verify(permitPath: string, boundManifest: ReturnType<typeof manifest> = manifest()) {
  return verifyPermitFile(permitPath, {
    manifest: boundManifest,
    expectedMethodologyHash: METHODOLOGY_HASH,
    keyringDir,
    revocationListPath,
  });
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
