import { generateKeyPairSync, randomUUID, sign as signBytes } from 'node:crypto';
import {
  canonicalJson,
  type Capability,
  type PermitKind,
  type ValidatedRunManifest,
} from '@cookingbench/core';
import { frozenMethodologyHash, manifestHash, type VerifiedGrant } from '../../src/permit.js';
import { verifyWithInstalledPublicKey } from './production-trust.js';

/**
 * Mint a REAL verified grant for tests.
 *
 * Tests used to build `Firewall.fromVerifiedPermit({ ... })` from an object
 * literal, which is precisely the bypass the verified-permit work closed: the
 * suite was asserting behaviour of a boundary that did not exist. Every test
 * that needs a grant now goes through actual Ed25519 verification against an
 * ephemeral keypair, so the tests exercise the same path production does.
 *
 * The private key exists in memory only. For one synchronous production
 * verification its public half is installed in the fixed repository keyring,
 * then removed in `finally`. No caller chooses a trust root or clock.
 */

const KEY_ID = `ephemeral-test-${process.pid}-${randomUUID().slice(0, 12)}`;
export const TEST_METHODOLOGY_HASH = frozenMethodologyHash();

const pair = generateKeyPairSync('ed25519');
const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;

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
  /** Signed-manifest retry ceiling exercised by the production client. */
  maxAttempts?: number;
  /** Validity controls for exercise-time expiry checks. */
  notBefore?: string;
  notAfter?: string;
  /** Bind the grant to an exact stored-manifest fixture instead of synthesising one. */
  manifest?: ValidatedRunManifest;
}

export function mintTestGrantWithManifest(opts: MintOptions) {
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

  const generatedManifest = {
    manifestVersion: 1,
    runId,
    methodologyVersion: 'v3.0',
    schemaVersion: '1',
    gitCommit: '980dfcb5e3ff920fe1a3231121a6115e3fa48dcb',
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
    callPlan: { concurrency: 4, maxAttempts: opts.maxAttempts ?? 3, abortOn: [] },
    budgetCapUsd,
    outputRoot: `data/runs/${runId}`,
  } as const;
  const manifest = opts.manifest ?? generatedManifest;
  const manifestBudget = manifest.budgetCapUsd;

  const permit = {
    permitVersion: 1,
    permitId: opts.permitId ?? 'permit-test-0001',
    kind: opts.kind,
    manifestHash: manifestHash(manifest),
    methodologyHash: TEST_METHODOLOGY_HASH,
    capabilities: opts.capabilities,
    cells,
    budgetCapUsd: Math.min(budgetCapUsd, manifestBudget),
    reservationScope: 'call',
    issuer: 'test',
    approver: 'test',
    approvalEvidence: 'unit test',
    notBefore: opts.notBefore ?? '2020-01-01T00:00:00Z',
    notAfter: opts.notAfter ?? '2099-01-01T00:00:00Z',
    executionLimit: opts.executionLimit ?? 1,
  };

  const verified = verifyWithInstalledPublicKey(
    KEY_ID,
    publicKeyPem,
    {
      signedPermit: {
        permit,
        signature: signBytes(null, Buffer.from(canonicalJson(permit), 'utf8'), pair.privateKey).toString(
          'base64',
        ),
        keyId: KEY_ID,
      },
      manifest,
    },
  );
  return { grant: verified.grant, manifest: verified.manifest };
}

export function mintTestGrant(opts: MintOptions): VerifiedGrant {
  return mintTestGrantWithManifest(opts).grant;
}
