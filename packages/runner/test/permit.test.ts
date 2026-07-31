import { generateKeyPairSync, sign as signBytes, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, type Capability } from '@cookingbench/core';
import { Firewall } from '../src/firewall.js';
import {
  PermitError,
  assertVerifiedGrant,
  isVerifiedGrant,
  manifestHash,
  sha256Hex,
  verifyPermit,
  verifyPermitFile,
  type VerifiedGrant,
} from '../src/permit.js';

/**
 * RUN-001 permit verification.
 *
 * Offline by construction: the keypair is generated in a temp directory for the
 * duration of the suite, no repository key is read, and nothing here opens a
 * socket or calls a model.
 *
 * The tests are written as bypass attempts rather than as feature checks,
 * because every defect found in WP-0 so far was a bypass that the feature tests
 * were happy with.
 */

const KEY_ID = 'test-permit-key';
const METHODOLOGY_HASH = sha256Hex('methodology-revision-3');
const NOW = new Date('2026-07-15T12:00:00Z');

let privateKey: KeyObject;
let scratch: string;
let keyringDir: string;
let revocationPath: string;

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  scratch = mkdtempSync(join(tmpdir(), 'cb-permit-'));
  keyringDir = join(scratch, 'keys');
  mkdirSync(keyringDir, { recursive: true });
  writeFileSync(
    join(keyringDir, `${KEY_ID}.pub`),
    pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
  );
  revocationPath = join(scratch, 'revoked.json');
  writeFileSync(revocationPath, JSON.stringify({ permitIds: [] }));
});

afterEach(() => {
  writeFileSync(revocationPath, JSON.stringify({ permitIds: [] }));
});

// --- fixtures --------------------------------------------------------------

const JUDGE_MODEL = 'anthropic/claude-opus-4.8';
const CANDIDATE_MODEL = 'openai/gpt-5.4-mini';

function manifestFixture(overrides: Record<string, unknown> = {}) {
  const runId = (overrides.runId as string) ?? 'shadow-1';
  return {
    manifestVersion: 1,
    runId,
    methodologyVersion: 'v3.0',
    schemaVersion: '1',
    gitCommit: '980dfcb',
    parentArtifacts: ['2026-07-v2.1'],
    evidenceClass: 'legacy-shadow',
    artifactOrigin: ['archived'],
    releaseState: 'draft',
    rankEligible: false,
    bankHash: 'a'.repeat(64),
    promptHash: 'b'.repeat(64),
    judgePromptHash: 'c'.repeat(64),
    validatorHash: 'd'.repeat(64),
    candidateRoutes: [
      { modelId: CANDIDATE_MODEL, provider: 'openai', baseModelFamily: 'gpt-5.4' },
    ],
    judgeRoutes: [
      { modelId: JUDGE_MODEL, provider: 'anthropic', baseModelFamily: 'claude-opus-4.8' },
    ],
    generationSettings: {
      temperature: 0,
      maxTokens: 16000,
      maxTokensRecipe: 32000,
      repeats: 1,
      repeatPolicy: 'single',
    },
    callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
    budgetCapUsd: 40,
    outputRoot: `data/runs/${runId}`,
    ...overrides,
  };
}

function permitFixture(manifest: unknown, overrides: Record<string, unknown> = {}) {
  return {
    permitVersion: 1,
    permitId: 'permit-2026-07-a',
    kind: 'legacy-shadow',
    manifestHash: manifestHash(manifest),
    methodologyHash: METHODOLOGY_HASH,
    capabilities: ['judge-inference'],
    cells: [{ modelId: JUDGE_MODEL, questionId: 'flav-002' }],
    budgetCapUsd: 30,
    reservationScope: 'call',
    issuer: 'claude',
    approver: 'jordan',
    approvalEvidence: 'thread 2026-07-30, offline signature',
    notBefore: '2026-07-01T00:00:00Z',
    notAfter: '2026-08-01T00:00:00Z',
    executionLimit: 1,
    ...overrides,
  };
}

function envelope(permit: unknown, opts: { keyId?: string; signature?: string } = {}) {
  return {
    permit,
    signature:
      opts.signature ??
      signBytes(null, Buffer.from(canonicalJson(permit), 'utf8'), privateKey).toString('base64'),
    keyId: opts.keyId ?? KEY_ID,
  };
}

function verify(signedPermit: unknown, manifest: unknown, extra: Record<string, unknown> = {}) {
  return verifyPermit({
    signedPermit,
    manifest,
    expectedMethodologyHash: METHODOLOGY_HASH,
    now: NOW,
    keyringDir,
    revocationListPath: revocationPath,
    ...extra,
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof PermitError) return e.code;
    return `${(e as Error).name}: ${(e as Error).message}`;
  }
  return 'DID NOT THROW';
}

// --- the happy path, so the negatives mean something -----------------------

describe('permit verification mints a grant', () => {
  it('accepts a correctly signed, correctly bound permit', () => {
    const manifest = manifestFixture();
    const { grant, permit } = verify(envelope(permitFixture(manifest)), manifest);
    expect(grant.permitId).toBe('permit-2026-07-a');
    expect(grant.kind).toBe('legacy-shadow');
    expect(grant.capabilities).toEqual(['judge-inference']);
    expect(grant.runId).toBe('shadow-1');
    expect(grant.keyId).toBe(KEY_ID);
    expect(grant.manifestHash).toBe(permit.manifestHash);
    expect(isVerifiedGrant(grant)).toBe(true);
  });

  it('binds the grant to the exact manifest bytes', () => {
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    expect(grant.manifestHash).toBe(manifestHash(manifest));
    // Canonical JSON, so a manifest built with keys in a different order is the
    // same manifest. Insertion-order hashing would make signatures a coin flip.
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());
    expect(manifestHash(reordered)).toBe(grant.manifestHash);
  });

  it('hashes a manifest by meaning, not by which defaults were spelled out', () => {
    // `parentArtifacts: []` and an omitted `parentArtifacts` are the same
    // envelope. If they hashed differently, a permit minted from a hand-written
    // manifest would silently fail to bind the identical one the runner emits.
    const manifest = manifestFixture({ parentArtifacts: [] });
    const terse = { ...manifest } as Record<string, unknown>;
    delete terse.parentArtifacts;
    expect(manifestHash(terse)).toBe(manifestHash(manifest));
    expect(() => manifestHash({ runId: 'r-1' })).toThrow(PermitError);
  });

  it('reads an envelope from disk', () => {
    const manifest = manifestFixture();
    const path = join(scratch, 'permit.json');
    writeFileSync(path, JSON.stringify(envelope(permitFixture(manifest))));
    const { grant } = verifyPermitFile(path, {
      manifest,
      expectedMethodologyHash: METHODOLOGY_HASH,
      now: NOW,
      keyringDir,
      revocationListPath: revocationPath,
    });
    expect(grant.permitId).toBe('permit-2026-07-a');
  });
});

// --- the erased-brand regression -------------------------------------------

describe('a grant is identity, not shape', () => {
  /**
   * The defect this replaces: `ValidatedRunManifest` was a TypeScript
   * intersection with a `unique symbol` brand, which erases at compile time, so
   * a three-field object literal passed `assertPublishable` at runtime. If the
   * grant repeated that pattern, every capability check below would be
   * decoration.
   */
  it('refuses a hand-built object with the right shape', () => {
    const forged = {
      permitId: 'permit-forged',
      kind: 'publication',
      capabilities: ['publication', 'candidate-inference'],
      cells: [],
      budgetCapUsd: 1_000_000,
      executionLimit: 99,
      manifestHash: 'f'.repeat(64),
      runId: 'shadow-1',
      evidenceClass: 'public-release',
      keyId: KEY_ID,
      notAfterIso: '2099-01-01T00:00:00Z',
      verifiedAtIso: NOW.toISOString(),
    } as unknown as VerifiedGrant;

    expect(isVerifiedGrant(forged)).toBe(false);
    expect(codeOf(() => assertVerifiedGrant(forged, 'test'))).toBe('GRANT_NOT_MINTED');
    expect(codeOf(() => Firewall.fromVerifiedPermit(forged))).toBe('GRANT_NOT_MINTED');
  });

  it.each([
    ['spread copy', (g: VerifiedGrant) => ({ ...g })],
    ['JSON round trip', (g: VerifiedGrant) => JSON.parse(JSON.stringify(g))],
    ['structuredClone', (g: VerifiedGrant) => structuredClone(g)],
  ])('refuses a %s of a real grant', (_label, copy) => {
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    const clone = copy(grant) as VerifiedGrant;
    expect(clone).toEqual(grant); // structurally identical...
    expect(isVerifiedGrant(clone)).toBe(false); // ...and carries no authority
  });

  it('refuses a forged grant pushed through the erased private constructor', () => {
    // `private constructor` is a TypeScript convention, not a runtime one:
    // Reflect.construct and `new (Firewall as any)(...)` both reach it. If only
    // the static factory checked, this would be the way past every capability
    // check in the class.
    const forged = { permitId: 'x', capabilities: ['publication'], cells: [] } as unknown;
    expect(codeOf(() => Reflect.construct(Firewall, [forged]))).toBe('GRANT_NOT_MINTED');
    expect(codeOf(() => new (Firewall as unknown as new (g: unknown) => unknown)(forged))).toBe(
      'GRANT_NOT_MINTED',
    );
    // null is the legitimate deny-all case and must still work.
    expect(() => Reflect.construct(Firewall, [null])).not.toThrow();
  });

  it('keeps its internals unreachable from outside the class', () => {
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    const firewall = Firewall.fromVerifiedPermit(grant) as unknown as Record<string, unknown>;
    // `#private` fields, so no amount of casting exposes the cell index or the
    // grant for editing. TypeScript `private` would leave both writable here.
    expect(Object.keys(firewall)).toEqual([]);
    expect(firewall.grant).toBeUndefined();
    expect(firewall.cellIndex).toBeUndefined();
  });

  it('does not let a copy widen its own capabilities', () => {
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    const escalated = { ...grant, capabilities: ['publication'] } as unknown as VerifiedGrant;
    expect(codeOf(() => Firewall.fromVerifiedPermit(escalated))).toBe('GRANT_NOT_MINTED');
    // And the real grant is frozen, so it cannot be edited in place either.
    expect(() => {
      (grant as { budgetCapUsd: number }).budgetCapUsd = 999;
    }).toThrow();
    expect(grant.budgetCapUsd).toBe(30);
  });

  it('exports no way to add to the minted set', async () => {
    // If the module exported the registry, or any setter over it, every check
    // above would be a formality — the frozen-run cache made exactly this
    // mistake in an earlier draft of the firewall by returning its own Set.
    const mod = (await import('../src/permit.js')) as Record<string, unknown>;
    const collections = Object.entries(mod)
      .filter(([, v]) => v instanceof WeakSet || v instanceof Set || v instanceof WeakMap)
      .map(([k]) => k);
    expect(collections, 'the minted-grant registry must not be reachable').toEqual([]);

    // And no exported function other than the verifiers mints a grant from an
    // object it was simply handed.
    for (const [name, value] of Object.entries(mod)) {
      if (typeof value !== 'function' || name.startsWith('verify')) continue;
      let result: unknown;
      try {
        result = (value as (...args: unknown[]) => unknown)({});
      } catch {
        continue; // refusing the input is the correct behaviour
      }
      expect(isVerifiedGrant(result), `${name}({}) returned something minted`).toBe(false);
    }

    expect(isVerifiedGrant(Object.create(null))).toBe(false);
    expect(isVerifiedGrant(null)).toBe(false);
    expect(isVerifiedGrant('grant')).toBe(false);
  });
});

// --- the signature is the authority ----------------------------------------

describe('signature verification', () => {
  it('refuses a permit whose body was edited after signing', () => {
    const manifest = manifestFixture();
    const permit = permitFixture(manifest);
    const signed = envelope(permit);
    // The classic escalation: sign a modest permit, then widen it on disk.
    signed.permit = { ...permit, budgetCapUsd: 5000 };
    expect(codeOf(() => verify(signed, manifest))).toBe('PERMIT_BAD_SIGNATURE');
  });

  it('covers the body as written, not the body after schema normalisation', () => {
    // The signer signs the file. Verifying the zod-PARSED body instead would
    // break here — `executionLimit` and `cells` are schema defaults, absent
    // from what was actually signed.
    const manifest = manifestFixture({ evidenceClass: 'public-release', releaseState: 'released', rankEligible: true });
    const permit = permitFixture(manifest, {
      kind: 'publication',
      capabilities: ['publication'],
    }) as Record<string, unknown>;
    delete permit.executionLimit;
    delete permit.cells;
    const { grant } = verify(envelope(permit), manifest);
    expect(grant.executionLimit).toBe(1); // default applied AFTER verification
    expect(grant.cells).toEqual([]);
  });

  it('refuses an extra field bolted on after signing', () => {
    // Fields the schema would strip must still be inside the signature's
    // coverage, or an envelope could carry unsigned payload.
    const manifest = manifestFixture();
    const permit = permitFixture(manifest);
    const signed = envelope(permit);
    signed.permit = { ...permit, note: 'added later' };
    expect(codeOf(() => verify(signed, manifest))).toBe('PERMIT_BAD_SIGNATURE');
  });

  it('refuses an unsigned or empty signature', () => {
    const manifest = manifestFixture();
    expect(
      codeOf(() => verify(envelope(permitFixture(manifest), { signature: 'AAAA' }), manifest)),
    ).toBe('PERMIT_BAD_SIGNATURE');
  });

  it('refuses a signature from a key the repository does not hold', () => {
    const manifest = manifestFixture();
    const other = generateKeyPairSync('ed25519');
    const permit = permitFixture(manifest);
    const signed = {
      permit,
      signature: signBytes(null, Buffer.from(canonicalJson(permit), 'utf8'), other.privateKey).toString(
        'base64',
      ),
      keyId: KEY_ID,
    };
    expect(codeOf(() => verify(signed, manifest))).toBe('PERMIT_BAD_SIGNATURE');
  });

  it('refuses an unknown key id, and a key id that traverses', () => {
    const manifest = manifestFixture();
    expect(codeOf(() => verify(envelope(permitFixture(manifest), { keyId: 'nope' }), manifest))).toBe(
      'PERMIT_UNKNOWN_KEY',
    );
    expect(
      codeOf(() => verify(envelope(permitFixture(manifest), { keyId: '../../etc/passwd' }), manifest)),
    ).toBe('PERMIT_UNKNOWN_KEY');
  });

  it('refuses a committed key that is not Ed25519', () => {
    // A substituted key file must not be able to downgrade the scheme.
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(
      join(keyringDir, 'rsa-key.pub'),
      rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    );
    const manifest = manifestFixture();
    expect(codeOf(() => verify(envelope(permitFixture(manifest), { keyId: 'rsa-key' }), manifest))).toBe(
      'PERMIT_BAD_KEY',
    );
    rmSync(join(keyringDir, 'rsa-key.pub'));
  });

  it('refuses when the keyring is absent', () => {
    const manifest = manifestFixture();
    expect(
      codeOf(() => verify(envelope(permitFixture(manifest)), manifest, { keyringDir: join(scratch, 'gone') })),
    ).toBe('PERMIT_KEYRING_UNAVAILABLE');
  });
});

// --- revocation -------------------------------------------------------------

describe('revocation fails closed', () => {
  it('refuses a revoked permit even with a valid signature', () => {
    writeFileSync(revocationPath, JSON.stringify({ permitIds: ['permit-2026-07-a'] }));
    const manifest = manifestFixture();
    expect(codeOf(() => verify(envelope(permitFixture(manifest)), manifest))).toBe('PERMIT_REVOKED');
  });

  it('refuses when the revocation list is absent, rather than assuming nothing is revoked', () => {
    const manifest = manifestFixture();
    expect(
      codeOf(() =>
        verify(envelope(permitFixture(manifest)), manifest, {
          revocationListPath: join(scratch, 'no-such-list.json'),
        }),
      ),
    ).toBe('PERMIT_REVOCATION_UNAVAILABLE');
  });

  it('refuses a malformed revocation list', () => {
    const bad = join(scratch, 'bad-revoked.json');
    writeFileSync(bad, '{"permitIds": "all of them"}');
    const manifest = manifestFixture();
    expect(
      codeOf(() => verify(envelope(permitFixture(manifest)), manifest, { revocationListPath: bad })),
    ).toBe('PERMIT_REVOCATION_UNAVAILABLE');
  });
});

// --- binding ----------------------------------------------------------------

describe('a permit authorises one exact envelope', () => {
  it('refuses a manifest that is not the one the permit names', () => {
    const manifest = manifestFixture();
    const signed = envelope(permitFixture(manifest));
    // One field changed — a bigger budget on the run this permit was for.
    const swapped = manifestFixture({ budgetCapUsd: 400 });
    expect(codeOf(() => verify(signed, swapped))).toBe('PERMIT_MANIFEST_MISMATCH');
  });

  it('refuses a manifest that does not validate', () => {
    const manifest = manifestFixture();
    const signed = envelope(permitFixture(manifest));
    // rankEligible is derived; asserting it is the incoherence the schema binds.
    expect(codeOf(() => verify(signed, { ...manifest, rankEligible: true }))).toBe(
      'PERMIT_MANIFEST_MISMATCH',
    );
  });

  it('refuses a permit issued against a different methodology revision', () => {
    const manifest = manifestFixture();
    const permit = permitFixture(manifest, { methodologyHash: sha256Hex('methodology-revision-2') });
    expect(codeOf(() => verify(envelope(permit), manifest))).toBe('PERMIT_METHODOLOGY_MISMATCH');
  });

  it('refuses outside its validity window, in both directions', () => {
    const manifest = manifestFixture();
    const signed = envelope(permitFixture(manifest));
    expect(codeOf(() => verify(signed, manifest, { now: new Date('2026-06-01T00:00:00Z') }))).toBe(
      'PERMIT_NOT_YET_VALID',
    );
    expect(codeOf(() => verify(signed, manifest, { now: new Date('2026-09-01T00:00:00Z') }))).toBe(
      'PERMIT_EXPIRED',
    );
  });
});

// --- the kind matrix --------------------------------------------------------

describe('permit kind bounds what a signature can buy', () => {
  /**
   * Codex's named case. A shadow re-analysis of archived answers needs judging
   * and nothing else; if a validly signed `legacy-shadow` permit could request
   * `candidate-inference`, an approval to "re-score what we already paid for"
   * would silently authorise a new paid run.
   */
  it('refuses a legacy-shadow permit that explicitly requests candidate-inference', () => {
    const manifest = manifestFixture();
    const permit = permitFixture(manifest, {
      capabilities: ['judge-inference', 'candidate-inference'],
      cells: [
        { modelId: JUDGE_MODEL, questionId: 'flav-002' },
        { modelId: CANDIDATE_MODEL, questionId: 'flav-002' },
      ],
    });
    const signed = envelope(permit);
    // The signature is genuine — this is not a forgery test.
    expect(codeOf(() => verify(signed, manifest))).toBe('PERMIT_KIND_FORBIDS_CAPABILITY');
  });

  it.each([
    ['legacy-shadow', 'publication'],
    ['legacy-shadow', 'live-db-write'],
    ['presentation-erratum', 'publication'],
    ['presentation-erratum', 'judge-inference'],
    ['publication', 'candidate-inference'],
    ['confirmatory-pilot', 'publication'],
    ['confirmatory-pilot', 'live-db-write'],
  ])('refuses a %s permit requesting %s', (kind, capability) => {
    const evidenceClass = { 'legacy-shadow': 'legacy-shadow', 'presentation-erratum': 'public-release', publication: 'public-release', 'confirmatory-pilot': 'confirmatory-pilot' }[kind]!;
    const manifest = manifestFixture(
      evidenceClass === 'public-release'
        ? { evidenceClass, releaseState: 'released', rankEligible: true }
        : evidenceClass === 'confirmatory-pilot'
          ? { evidenceClass, rankEligible: true }
          : { evidenceClass },
    );
    const permit = permitFixture(manifest, {
      kind,
      capabilities: [capability as Capability],
      cells: [],
    });
    expect(codeOf(() => verify(envelope(permit), manifest))).toBe('PERMIT_KIND_FORBIDS_CAPABILITY');
  });

  it('refuses a shadow permit that binds a rank-bearing manifest', () => {
    // Laundering: keep the modest capability, swap the artifact it applies to.
    const manifest = manifestFixture({ evidenceClass: 'confirmatory-pilot', rankEligible: true });
    const permit = permitFixture(manifest);
    expect(codeOf(() => verify(envelope(permit), manifest))).toBe(
      'PERMIT_KIND_FORBIDS_EVIDENCE_CLASS',
    );
  });

  it('allows each kind its own declared capabilities', () => {
    const manifest = manifestFixture({
      evidenceClass: 'public-release',
      releaseState: 'released',
      rankEligible: true,
      artifactOrigin: ['live-provider'],
    });
    const permit = permitFixture(manifest, {
      kind: 'publication',
      capabilities: ['publication', 'result-sync', 'live-db-write'],
      cells: [],
    });
    const { grant } = verify(envelope(permit), manifest);
    expect(grant.capabilities).toEqual(['publication', 'result-sync', 'live-db-write']);
  });
});

// --- cells and budget -------------------------------------------------------

describe('cell and budget coherence', () => {
  it('refuses an inference permit with no cells', () => {
    const manifest = manifestFixture();
    const permit = permitFixture(manifest, { cells: [] });
    expect(codeOf(() => verify(envelope(permit), manifest))).toBe('PERMIT_CELLS_INCOHERENT');
  });

  it('refuses cells on a permit that grants no inference', () => {
    const manifest = manifestFixture({
      evidenceClass: 'public-release',
      releaseState: 'released',
      rankEligible: true,
      artifactOrigin: ['live-provider'],
    });
    const permit = permitFixture(manifest, {
      kind: 'publication',
      capabilities: ['publication'],
      cells: [{ modelId: JUDGE_MODEL, questionId: 'flav-002' }],
    });
    expect(codeOf(() => verify(envelope(permit), manifest))).toBe('PERMIT_CELLS_INCOHERENT');
  });

  it('refuses a cell naming a model the manifest does not declare', () => {
    const manifest = manifestFixture();
    const permit = permitFixture(manifest, {
      cells: [{ modelId: 'google/gemini-3.6-flash', questionId: 'flav-002' }],
    });
    expect(codeOf(() => verify(envelope(permit), manifest))).toBe('PERMIT_CELLS_INCOHERENT');
  });

  it('refuses a permit that raises the manifest budget', () => {
    const manifest = manifestFixture();
    const permit = permitFixture(manifest, { budgetCapUsd: 41 });
    expect(codeOf(() => verify(envelope(permit), manifest))).toBe('PERMIT_BUDGET_EXCEEDS_MANIFEST');
  });
});

// --- what the grant then permits -------------------------------------------

describe('the firewall enforces exactly what the grant carries', () => {
  it('grants only the listed capability and the listed cells', () => {
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    const firewall = Firewall.fromVerifiedPermit(grant);

    expect(() => firewall.requireCapability('judge-inference', 'judging')).not.toThrow();
    expect(() => firewall.requireCapability('candidate-inference', 'running')).toThrow(
      /does not grant 'candidate-inference'/,
    );
    expect(() => firewall.requireCell({ kind: 'judge', modelId: JUDGE_MODEL, questionId: 'flav-002' }, 'judging')).not.toThrow();
    expect(() => firewall.requireCell({ kind: 'judge', modelId: JUDGE_MODEL, questionId: 'flav-003' }, 'judging')).toThrow(
      /does not authorise/,
    );
    expect(firewall.budgetCapUsd).toBe(30);
  });

  it('records provenance for the run artifact', () => {
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    const provenance = Firewall.fromVerifiedPermit(grant).provenance()!;
    expect(provenance).toMatchObject({
      permitId: 'permit-2026-07-a',
      kind: 'legacy-shadow',
      keyId: KEY_ID,
      runId: 'shadow-1',
      manifestHash: manifestHash(manifest),
    });
  });

  it('denies everything with no permit, and reports no provenance', () => {
    const firewall = Firewall.denyAll();
    expect(firewall.permitId).toBeNull();
    expect(firewall.budgetCapUsd).toBe(0);
    expect(firewall.provenance()).toBeNull();
    expect(() => firewall.requireCapability('judge-inference', 'judging')).toThrow(
      /deny-by-default/,
    );
    expect(() => firewall.requireCell({ kind: 'judge', modelId: JUDGE_MODEL, questionId: 'flav-002' }, 'judging')).toThrow(/no permit/);
  });
});
