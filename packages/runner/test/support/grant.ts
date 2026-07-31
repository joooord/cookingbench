import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson, type Capability, type PermitKind } from '@cookingbench/core';
import { manifestHash, sha256Hex, verifyPermitForTests, type VerifiedGrant } from '../../src/permit.js';

/**
 * Mint a REAL verified grant for tests.
 *
 * Tests used to build `Firewall.fromVerifiedPermit({ ... })` from an object
 * literal, which is precisely the bypass the verified-permit work closed: the
 * suite was asserting behaviour of a boundary that did not exist. Every test
 * that needs a grant now goes through actual Ed25519 verification against an
 * ephemeral keypair, so the tests exercise the same path production does.
 *
 * The keypair lives in a temp directory for the process lifetime. No repository
 * key is read and no private key is ever written into the repo.
 */

const KEY_ID = 'ephemeral-test-key';
export const TEST_METHODOLOGY_HASH = sha256Hex('test-methodology');

const pair = generateKeyPairSync('ed25519');
const scratch = mkdtempSync(join(tmpdir(), 'cb-grant-'));
const keyringDir = join(scratch, 'keys');
mkdirSync(keyringDir, { recursive: true });
writeFileSync(
  join(keyringDir, `${KEY_ID}.pub`),
  pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
);
const revocationListPath = join(scratch, 'revoked.json');
writeFileSync(revocationListPath, JSON.stringify({ permitIds: [] }));

/** Evidence class each permit kind is allowed to bind, plus its lifecycle. */
const CLASS_FOR_KIND: Record<PermitKind, { evidenceClass: string; releaseState: string; rankEligible: boolean }> = {
  'legacy-shadow': { evidenceClass: 'legacy-shadow', releaseState: 'draft', rankEligible: false },
  'development-probe': { evidenceClass: 'development-probe', releaseState: 'draft', rankEligible: false },
  'confirmatory-pilot': { evidenceClass: 'confirmatory-pilot', releaseState: 'draft', rankEligible: true },
  'presentation-erratum': { evidenceClass: 'public-release', releaseState: 'released', rankEligible: true },
  publication: { evidenceClass: 'public-release', releaseState: 'released', rankEligible: true },
};

export interface MintOptions {
  permitId?: string;
  kind: PermitKind;
  capabilities: Capability[];
  cells?: Array<{ modelId: string; questionId: string }>;
  budgetCapUsd?: number;
  runId?: string;
  executionLimit?: number;
}

export function mintTestGrant(opts: MintOptions): VerifiedGrant {
  const cells = opts.cells ?? [];
  const runId = opts.runId ?? 'test-run';
  const budgetCapUsd = opts.budgetCapUsd ?? 10;
  const shape = CLASS_FOR_KIND[opts.kind];

  // The manifest must declare every model the permit names, so routes are
  // derived from the cells rather than hard-coded.
  const routes = [...new Set(cells.map((c) => c.modelId))].map((modelId) => ({
    modelId,
    provider: modelId.split('/')[0] || 'unknown',
    baseModelFamily: modelId.split('/')[1] || modelId,
  }));

  const manifest = {
    manifestVersion: 1,
    runId,
    methodologyVersion: 'v3.0',
    schemaVersion: '1',
    gitCommit: '980dfcb',
    parentArtifacts: [],
    evidenceClass: shape.evidenceClass,
    artifactOrigin: shape.rankEligible ? ['live-provider'] : ['archived'],
    releaseState: shape.releaseState,
    rankEligible: shape.rankEligible,
    bankHash: 'a'.repeat(64),
    promptHash: 'b'.repeat(64),
    judgePromptHash: 'c'.repeat(64),
    validatorHash: 'd'.repeat(64),
    candidateRoutes: routes,
    judgeRoutes: [],
    generationSettings: {
      temperature: 0,
      maxTokens: 16000,
      maxTokensRecipe: 32000,
      repeats: 1,
      repeatPolicy: 'single',
    },
    callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
    budgetCapUsd,
    outputRoot: `data/runs/${runId}`,
  };

  const permit = {
    permitVersion: 1,
    permitId: opts.permitId ?? 'permit-test-0001',
    kind: opts.kind,
    manifestHash: manifestHash(manifest),
    methodologyHash: TEST_METHODOLOGY_HASH,
    capabilities: opts.capabilities,
    cells,
    budgetCapUsd,
    reservationScope: 'call',
    issuer: 'test',
    approver: 'test',
    approvalEvidence: 'unit test',
    notBefore: '2020-01-01T00:00:00Z',
    notAfter: '2099-01-01T00:00:00Z',
    executionLimit: opts.executionLimit ?? 1,
  };

  // The TEST SEAM, not the production entry point. `verifyPermit` no longer
  // accepts a keyring or a revocation list from any caller — that parameter was
  // the RUN-001 bypass — so an ephemeral-key helper has to say out loud that it
  // is a test.
  const { grant } = verifyPermitForTests(
    { keyringDir, revocationListPath },
    {
      signedPermit: {
        permit,
        signature: signBytes(null, Buffer.from(canonicalJson(permit), 'utf8'), pair.privateKey).toString(
          'base64',
        ),
        keyId: KEY_ID,
      },
      manifest,
      expectedMethodologyHash: TEST_METHODOLOGY_HASH,
    },
  );
  return grant;
}
