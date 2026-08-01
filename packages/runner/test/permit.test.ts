import { generateKeyPairSync, randomUUID, sign as signBytes, type KeyObject } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { canonicalJson, type Capability } from '@cookingbench/core';
import { REPO_ROOT } from '../src/dataset.js';
import { Firewall } from '../src/firewall.js';
import {
  PERMIT_FIXTURES_DIR,
  KEYRING_DIR,
  PermitError,
  assertGrantForRun,
  assertGrantStillValid,
  assertVerifiedGrant,
  frozenMethodologyHash,
  isVerifiedGrant,
  manifestHash,
  sha256Hex,
  verifyPermit,
  verifyPermitFile,
  type VerifiedGrant,
} from '../src/permit.js';
import {
  verifyReceiptWithInstalledPublicKey,
  verifyWithInstalledPublicKey,
  withTemporarilyRevokedPermit,
} from './support/production-trust.js';

/**
 * RUN-001 permit verification.
 *
 * Offline by construction: the ephemeral keypair is generated in a temp
 * directory for the duration of the suite, the committed material that IS read
 * is three expired fixtures, and nothing here opens a socket or calls a model.
 *
 * The tests are written as bypass attempts rather than as feature checks,
 * because every defect found in WP-0 so far was a bypass that the feature tests
 * were happy with. The newest of those: `verifyPermit` used to accept
 * `keyringDir`, `revocationListPath` and `now` FROM PRODUCTION CALLERS, so the
 * thing being guarded could choose the guard's inputs. Everything below the
 * fixtures section exercises the seam; the fixtures section exercises the
 * production entry point, which now has no seam to reach.
 */

const KEY_ID = `test-permit-${process.pid}-${randomUUID().slice(0, 12)}`;
const METHODOLOGY_HASH = frozenMethodologyHash();
const NOW = new Date('2026-07-15T12:00:00Z');

let privateKey: KeyObject;
let scratch: string;
let publicKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync('ed25519');
  privateKey = pair.privateKey;
  scratch = mkdtempSync(join(tmpdir(), 'cb-permit-'));
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }) as string;
});

afterEach(() => {
  vi.useRealTimers();
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
    gitCommit: '980dfcb5e3ff920fe1a3231121a6115e3fa48dcb',
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
    notBefore: '2020-01-01T00:00:00Z',
    notAfter: '2099-01-01T00:00:00Z',
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

/**
 * Tests install only the ephemeral PUBLIC key into the fixed repository
 * keyring, then exercise the real production verifier. The private signing key
 * remains memory-only and is never an input to runtime verification.
 */
function verify(
  signedPermit: unknown,
  manifest: unknown,
  extra: {
    expectedRunId?: string;
  } = {},
) {
  return verifyWithInstalledPublicKey(
    KEY_ID,
    publicKeyPem,
    {
      signedPermit,
      manifest,
      expectedRunId: extra.expectedRunId,
    },
  );
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

// --- the committed fixtures ------------------------------------------------

const fixture = (name: string) => join(PERMIT_FIXTURES_DIR, name);

/** What a production caller is allowed to say: a manifest and a methodology. */
function fixtureBinding() {
  return {
    manifest: JSON.parse(readFileSync(fixture('expired-probe.manifest.json'), 'utf8')),
  };
}

describe('the frozen methodology identity is derived from committed bytes', () => {
  it('reads the fixed plan and sidecar through permit.frozenMethodologyHash', () => {
    const plan = readFileSync(
      join(REPO_ROOT, 'docs/methodology/CookingBench-methodology-first-master-plan.md'),
      'utf8',
    );
    const recorded = readFileSync(
      join(REPO_ROOT, 'docs/methodology/CookingBench-methodology-first-master-plan.sha256'),
      'utf8',
    ).trim().split(/\s+/)[0];

    expect(frozenMethodologyHash()).toBe(sha256Hex(plan));
    expect(frozenMethodologyHash()).toBe(recorded);
    expect(frozenMethodologyHash.length).toBe(0);
  });
});

// --- the happy path, so the negatives mean something -----------------------

describe('permit verification mints a grant', () => {
  it('accepts a correctly signed, correctly bound permit', () => {
    const manifest = manifestFixture();
    const { grant, permit } = verify(envelope(permitFixture(manifest)), manifest);
    expect(grant.permitId).toBe('permit-2026-07-a');
    expect(grant.kind).toBe('legacy-shadow');
    expect(grant.capabilities).toEqual(['judge-inference']);
    expect(grant.reservationScope).toBe('call');
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
    // Through the PRODUCTION entry point, against COMMITTED material: the
    // committed keyring, the committed revocation list and the real clock.
    // Nothing here is supplied by the test but the paths of the fixture files.
    //
    // The assertion is `PERMIT_EXPIRED`, and that is the strongest one
    // available: reaching the validity window means the file parsed, the key id
    // resolved to a committed `.pub`, an Ed25519 signature made off this machine
    // verified against it, the revocation list was read, and both the manifest
    // hash and the frozen methodology hash matched. An expired fixture proves
    // the loader without authorising anything.
    expect(codeOf(() => verifyPermitFile(fixture('expired-probe.permit.json'), fixtureBinding()))).toBe(
      'PERMIT_EXPIRED',
    );
  });
});

describe('retrospective permit verification does not mint authority', () => {
  it('re-authenticates the recorded envelope and returns only frozen provenance', () => {
    const manifest = manifestFixture();
    const signedPermit = envelope(permitFixture(manifest));
    const receipt = verifyReceiptWithInstalledPublicKey(KEY_ID, publicKeyPem, {
      signedPermit,
      manifest,
    });

    expect(receipt.permitId).toBe('permit-2026-07-a');
    expect(receipt.runId).toBe('shadow-1');
    expect(receipt.reservationScope).toBe('call');
    expect(receipt.signedPermitHash).toBe(sha256Hex(canonicalJson(signedPermit)));
    expect(receipt.signedPermit).toEqual(signedPermit);
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(Object.isFrozen(receipt.signedPermit)).toBe(true);
    expect(isVerifiedGrant(receipt)).toBe(false);
    expect(codeOf(() => assertVerifiedGrant(receipt, 'retrospective receipt'))).toBe(
      'GRANT_NOT_MINTED',
    );
  });

  it('can narrow to a signed capability but cannot invent one', () => {
    const manifest = manifestFixture();
    const signedPermit = envelope(permitFixture(manifest));
    expect(
      verifyReceiptWithInstalledPublicKey(KEY_ID, publicKeyPem, {
        signedPermit,
        manifest,
        requiredCapability: 'judge-inference',
      }).capabilities,
    ).toEqual(['judge-inference']);
    expect(
      codeOf(() =>
        verifyReceiptWithInstalledPublicKey(KEY_ID, publicKeyPem, {
          signedPermit,
          manifest,
          requiredCapability: 'publication',
        }),
      ),
    ).toBe('PERMIT_CAPABILITY_MISSING');
  });

  it('authenticates completed work after expiry while executable authority remains expired', () => {
    const manifest = manifestFixture();
    const signedPermit = envelope(
      permitFixture(manifest, {
        notBefore: '2026-07-01T00:00:00Z',
        notAfter: '2026-08-01T00:00:00Z',
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));

    expect(codeOf(() => verify(signedPermit, manifest))).toBe('PERMIT_EXPIRED');
    const receipt = verifyReceiptWithInstalledPublicKey(KEY_ID, publicKeyPem, {
      signedPermit,
      manifest,
      requiredCapability: 'judge-inference',
    });
    expect(receipt.notAfterIso).toBe('2026-08-01T00:00:00Z');
    expect(isVerifiedGrant(receipt)).toBe(false);
  });
});

// --- the bypass this whole revision exists to close -------------------------

describe('the production boundary does not let a caller choose the trust root', () => {
  /**
   * The recorded RUN-001 gap, reproduced as an attack.
   *
   * A caller that can name the keyring can point it at a key it just generated
   * and mint itself any permit it likes; a caller that can name the clock can
   * step past an expiry; a caller that can name the revocation list can
   * un-revoke itself. Each of those was a plain optional parameter of
   * `verifyPermit`, defaulted to the committed values and reachable by every
   * production call site.
   *
   * The attack is written through the REAL production API, in the shape a
   * JavaScript caller would use it — `as never` here is not a cheat, it is the
   * point: TypeScript is not present at runtime, so the type is not the guard.
   */
  it('refuses a keyring, a revocation list or a clock supplied through the production API', () => {
    const manifest = manifestFixture();
    const signed = envelope(permitFixture(manifest));
    const attacker = mkdtempSync(join(tmpdir(), 'cb-attacker-'));
    mkdirSync(join(attacker, 'keys'), { recursive: true });
    const own = generateKeyPairSync('ed25519');
    writeFileSync(
      join(attacker, 'keys', `${KEY_ID}.pub`),
      own.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    );
    writeFileSync(join(attacker, 'revoked.json'), JSON.stringify({ permitIds: [] }));

    for (const injection of [
      { expectedMethodologyHash: METHODOLOGY_HASH },
      { keyringDir: join(attacker, 'keys') },
      { revocationListPath: join(attacker, 'revoked.json') },
      { now: new Date('2026-07-15T12:00:00Z') },
      { clock: () => new Date() },
      { trustRoot: { keyringDir: join(attacker, 'keys') } },
      // All three at once, which is what an attacker would actually pass.
      {
        keyringDir: join(attacker, 'keys'),
        revocationListPath: join(attacker, 'revoked.json'),
        now: new Date('2026-07-15T12:00:00Z'),
      },
    ]) {
      expect(
        codeOf(() =>
          verifyPermit({
            signedPermit: signed,
            manifest,
            ...injection,
          } as never),
        ),
        `injection ${JSON.stringify(Object.keys(injection))} was not refused`,
      ).toBe('PERMIT_TRUST_INPUT_REJECTED');
    }
    rmSync(attacker, { recursive: true, force: true });
  });

  it('refuses trust inputs on the file entry point too, before it reads anything', () => {
    // verifyPermitFile is what the CLI actually calls, so a boundary that only
    // held on verifyPermit would hold nowhere that matters.
    expect(
      codeOf(() =>
        verifyPermitFile(fixture('expired-probe.permit.json'), {
          ...fixtureBinding(),
          keyringDir: '/tmp/nope',
        } as never),
      ),
    ).toBe('PERMIT_TRUST_INPUT_REJECTED');
    // A path that does not exist: the refusal must come from the options, not
    // from the missing file, i.e. the check happens before any read.
    expect(
      codeOf(() =>
        verifyPermitFile('/nonexistent/permit.json', { ...fixtureBinding(), now: NOW } as never),
      ),
    ).toBe('PERMIT_TRUST_INPUT_REJECTED');
  });

  it('refuses a trust input smuggled through a prototype', () => {
    // `Object.create({ keyringDir })` has no OWN keyringDir, so an own-key
    // check would miss it while a destructure would still read it.
    const manifest = manifestFixture();
    const hostile = Object.create({ keyringDir: '/tmp/attacker/keys' }) as Record<string, unknown>;
    hostile.signedPermit = envelope(permitFixture(manifest));
    hostile.manifest = manifest;
    expect(codeOf(() => verifyPermit(hostile as never))).toBe('PERMIT_TRUST_INPUT_REJECTED');
  });

  it('refuses unknown options rather than ignoring them', () => {
    const manifest = manifestFixture();
    expect(
      codeOf(() =>
        verifyPermit({
          signedPermit: envelope(permitFixture(manifest)),
          manifest,
          skipRevocationCheck: true,
        } as never),
      ),
    ).toBe('PERMIT_MALFORMED');
  });

  it('exports no environment-enabled test verifier', async () => {
    const mod = (await import('../src/permit.js')) as Record<string, unknown>;
    expect(mod.verifyPermitForTests).toBeUndefined();
    expect(Object.keys(mod).filter((name) => /permit.*forTests/i.test(name))).toEqual([]);
  });
});

// --- the committed material -------------------------------------------------

describe('the committed keyring and revocation list are the production trust root', () => {
  /**
   * Before this, no verification key, permit or manifest existed in the
   * repository at all: every end-to-end test minted an ephemeral keypair, so the
   * chain had never once run against committed authority. These fixtures are
   * expired by construction, so they prove the loader without authorising
   * anything — see data/permits/fixtures/README.md.
   */
  it('verifies a signature made off this machine, then refuses it for being expired', () => {
    expect(codeOf(() => verifyPermitFile(fixture('expired-probe.permit.json'), fixtureBinding()))).toBe(
      'PERMIT_EXPIRED',
    );
  });

  it('reads the committed revocation list, before it looks at the clock', () => {
    // The revoked fixture is ALSO expired. It reports REVOKED, which is only
    // possible if data/permits/revoked.json was genuinely consulted.
    expect(codeOf(() => verifyPermitFile(fixture('revoked-probe.permit.json'), fixtureBinding()))).toBe(
      'PERMIT_REVOKED',
    );
  });

  it('catches a committed permit whose body was edited after signing', () => {
    expect(codeOf(() => verifyPermitFile(fixture('tampered-probe.permit.json'), fixtureBinding()))).toBe(
      'PERMIT_BAD_SIGNATURE',
    );
  });

  it('binds the committed permit to its own manifest and refuses a caller methodology', () => {
    const binding = fixtureBinding();
    const otherManifest = { ...(binding.manifest as Record<string, unknown>), budgetCapUsd: 999 };
    expect(
      codeOf(() =>
        verifyPermitFile(fixture('expired-probe.permit.json'), { ...binding, manifest: otherManifest }),
      ),
    ).toBe('PERMIT_MANIFEST_MISMATCH');
    expect(
      codeOf(() =>
        verifyPermitFile(fixture('expired-probe.permit.json'), {
          ...binding,
          expectedMethodologyHash: sha256Hex('some other plan'),
        } as never),
      ),
    ).toBe('PERMIT_TRUST_INPUT_REJECTED');
  });

  it('resolves key ids against the committed keyring, and says so when it cannot', () => {
    // Proof of WHICH directory the production entry point reads: the refusal
    // names the committed keyring and lists what is actually in it. A test that
    // only asserted "it threw" would pass just as happily against a keyring the
    // caller had chosen, which is the bypass this replaces.
    const envelope = JSON.parse(readFileSync(fixture('expired-probe.permit.json'), 'utf8'));
    envelope.keyId = 'never-committed';
    const path = join(scratch, 'unknown-key.permit.json');
    writeFileSync(path, JSON.stringify(envelope));
    try {
      verifyPermitFile(path, fixtureBinding());
      throw new Error('DID NOT THROW');
    } catch (e) {
      expect((e as PermitError).code).toBe('PERMIT_UNKNOWN_KEY');
      expect((e as Error).message).toContain(join('data', 'permits', 'keys'));
      expect((e as Error).message).toContain('wp0-fixture-2026-07');
    }
  });

  it('uses the same committed trust root from both production entry points', () => {
    // verifyPermit and verifyPermitFile must not be able to drift apart: the
    // CLI calls one, everything else would reach for the other.
    const envelope = JSON.parse(readFileSync(fixture('expired-probe.permit.json'), 'utf8'));
    expect(codeOf(() => verifyPermit({ ...fixtureBinding(), signedPermit: envelope }))).toBe(
      'PERMIT_EXPIRED',
    );
  });

  it('holds no private key anywhere in the committed permit material', () => {
    // The one thing that must never be committed. A signing key in the repo
    // would mean the system that enforces approval can approve itself.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
      );
    for (const file of walk(join(REPO_ROOT, 'data/permits'))) {
      const text = readFileSync(file, 'utf8');
      expect(/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text), `${file} contains a private key`).toBe(
        false,
      );
    }
  });
});

// --- validity at the moment of use ------------------------------------------

describe('authority is re-checked when it is exercised', () => {
  /**
   * A run takes hours. Verifying once at start-up and trusting the resulting
   * object afterwards means a permit that expires mid-run keeps spending, and a
   * permit revoked because something has gone wrong keeps going until a human
   * notices. Validity is a property of the moment of USE.
   */
  it('stops honouring a permit that expires while the process is still running', () => {
    const manifest = manifestFixture();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));
    const bounded = permitFixture(manifest, {
      notBefore: '2026-07-01T00:00:00Z',
      notAfter: '2026-08-01T00:00:00Z',
    });
    const { grant } = verify(envelope(bounded), manifest);
    expect(() => assertGrantStillValid(grant, 'spend')).not.toThrow();

    vi.setSystemTime(new Date('2026-08-02T00:00:00Z')); // one day past notAfter
    expect(codeOf(() => assertGrantStillValid(grant, 'spend'))).toBe('PERMIT_EXPIRED');
    // And a backwards clock correction is refused too, rather than read as
    // "before the window, so probably fine".
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    expect(codeOf(() => assertGrantStillValid(grant, 'spend'))).toBe('PERMIT_NOT_YET_VALID');
  });

  it('honours a revocation published after the permit was loaded', async () => {
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    expect(() => assertGrantStillValid(grant, 'publish')).not.toThrow();

    await withTemporarilyRevokedPermit(grant.permitId, () => {
      expect(codeOf(() => assertGrantStillValid(grant, 'publish'))).toBe('PERMIT_REVOKED');
    });
  });

  it('re-checks a test grant against the same fixed production trust root', () => {
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    expect(grant.keyId).toBe(KEY_ID);
    expect(() => assertGrantStillValid(grant, 'spend')).not.toThrow();
  });

  it('refuses a hand-built grant at the re-check, not just at minting', () => {
    const forged = { permitId: 'x', runId: 'shadow-1', notAfterIso: '2099-01-01T00:00:00Z' };
    expect(codeOf(() => assertGrantStillValid(forged as never, 'spend'))).toBe('GRANT_NOT_MINTED');
    expect(codeOf(() => assertGrantForRun(forged as never, 'shadow-1', 'sync'))).toBe('GRANT_NOT_MINTED');
  });
});

// --- one run id -------------------------------------------------------------

describe('authority is issued for exactly one run', () => {
  it('refuses a permit whose manifest names a different run than the command', () => {
    const manifest = manifestFixture();
    const signed = envelope(permitFixture(manifest));
    expect(codeOf(() => verify(signed, manifest, { expectedRunId: 'some-other-run' }))).toBe(
      'PERMIT_RUN_MISMATCH',
    );
    expect(() => verify(signed, manifest, { expectedRunId: 'shadow-1' })).not.toThrow();
  });

  it('refuses to act on another run at the point of use', () => {
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    expect(grant.runId).toBe('shadow-1');
    expect(codeOf(() => assertGrantForRun(grant, '2026-07-v2.1', 'publishRun'))).toBe(
      'PERMIT_RUN_MISMATCH',
    );
    expect(() => assertGrantForRun(grant, 'shadow-1', 'publishRun')).not.toThrow();
  });

  it('will not let a stale permit through the run check either', async () => {
    // assertGrantForRun re-validates, so a caller cannot get the cheap check
    // without the fresh one.
    const manifest = manifestFixture();
    const { grant } = verify(envelope(permitFixture(manifest)), manifest);
    await withTemporarilyRevokedPermit(grant.permitId, () => {
      expect(codeOf(() => assertGrantForRun(grant, 'shadow-1', 'syncRun'))).toBe('PERMIT_REVOKED');
    });
  });
});

// --- a permit may not nominate its own trust sources -------------------------

describe('a permit cannot choose where it is checked', () => {
  it('refuses a permit that names its own revocation source', () => {
    // `revocationListUrl` is an optional field of the permit schema. Honouring
    // it would hand the revocation decision to the document being revoked.
    const manifest = manifestFixture();
    const permit = permitFixture(manifest, { revocationListUrl: 'https://example.invalid/never-revoked.json' });
    expect(codeOf(() => verify(envelope(permit), manifest))).toBe('PERMIT_CHOOSES_OWN_TRUST');
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
    const rsaKeyId = `rsa-test-${process.pid}`;
    const rsaPath = join(KEYRING_DIR, `${rsaKeyId}.pub`);
    writeFileSync(
      rsaPath,
      rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    );
    const manifest = manifestFixture();
    expect(codeOf(() => verify(envelope(permitFixture(manifest), { keyId: rsaKeyId }), manifest))).toBe(
      'PERMIT_BAD_KEY',
    );
    rmSync(rsaPath);
  });
});

// --- revocation -------------------------------------------------------------

describe('revocation fails closed', () => {
  it('refuses a revoked permit even with a valid signature', async () => {
    const manifest = manifestFixture();
    await withTemporarilyRevokedPermit('permit-2026-07-a', () => {
      expect(codeOf(() => verify(envelope(permitFixture(manifest)), manifest))).toBe('PERMIT_REVOKED');
    });
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
    const signed = envelope(
      permitFixture(manifest, {
        notBefore: '2026-07-01T00:00:00Z',
        notAfter: '2026-08-01T00:00:00Z',
      }),
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    expect(codeOf(() => verify(signed, manifest))).toBe('PERMIT_NOT_YET_VALID');
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
    expect(codeOf(() => verify(signed, manifest))).toBe('PERMIT_EXPIRED');
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
  it.each(['run', 'model'] as const)(
    "refuses signed reservationScope '%s' while only per-call reservations are implemented",
    (reservationScope) => {
      const manifest = manifestFixture();
      const permit = permitFixture(manifest, { reservationScope });
      expect(codeOf(() => verify(envelope(permit), manifest))).toBe(
        'PERMIT_RESERVATION_SCOPE_UNSUPPORTED',
      );
    },
  );

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
      reservationScope: 'call',
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
