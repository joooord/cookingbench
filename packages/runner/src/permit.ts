import { createHash, createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  CAPABILITIES_FOR_PERMIT_KIND,
  EVIDENCE_CLASSES_FOR_PERMIT_KIND,
  INFERENCE_CAPABILITIES,
  canonicalJson,
  permitKindAllowsCapability,
  permitKindAllowsEvidenceClass,
  safeParseRunManifest,
  signedPermitSchema,
  type Capability,
  type EvidenceClass,
  type Permit,
  type PermitKind,
  type ReleaseState,
  type ValidatedRunManifest,
} from '@cookingbench/core';
import { DATA_DIR, REPO_ROOT } from './dataset.js';

/**
 * RUN-001 — permit verification, and the grant that verification mints.
 *
 * WHAT SIGNING IS HERE, AND WHAT IT IS NOT.
 *
 * A permit is APPROVAL and PROVENANCE. It records that a named human approved
 * one exact execution envelope, and it makes unattended, accidental or
 * over-reaching action fail closed instead of proceeding. That is the whole
 * claim.
 *
 * It is NOT a defence against an operator who controls this machine. Anyone who
 * can write to the repository can commit their own verification key, edit this
 * module, or replace the caller. Saying otherwise would be worse than saying
 * nothing, because it would stop people looking. The threat this closes is the
 * one that actually occurs: an agent or a script doing something expensive,
 * irreversible or public that nobody approved.
 *
 * THE POINT OF THE MODULE: authority is a RUNTIME fact.
 *
 * The previous attempt at an unforgeable value used `declare const brand: unique
 * symbol` and an intersection type. TypeScript erases that entirely, so a
 * hand-written object literal walked straight through the boundary at runtime —
 * and the code around it read as if it were guarded. A type-level brand is a
 * lint.
 *
 * So a `VerifiedGrant` here is not a shape. It is MEMBERSHIP of a module-private
 * WeakSet that only the verification core writes to. There is no exported way to
 * add to it, the set is never returned, and structural equality buys nothing: a
 * copy of a real grant — spread, `structuredClone`, `JSON.parse(JSON.stringify(
 * ...))` — is a different object identity and therefore carries no authority.
 *
 * THE TRUST ROOT IS NOT AN ARGUMENT.
 *
 * The earlier version of this module took `keyringDir`, `revocationListPath` and
 * `now` as optional parameters, defaulted to the committed ones, and let
 * production callers pass their own — "injectable for testability". That is not a boundary: unattended code
 * could point the keyring at a key it had just minted, or move the clock past an
 * expiry, and every downstream check would pass honestly against inputs the
 * caller chose. A safeguard is meaningless when the thing it guards picks the
 * safeguard's definition.
 *
 * `verifyPermit` / `verifyPermitFile` are the only verification entry points.
 * They take no trust inputs at all, and they REFUSE an options object carrying
 * any — refusing rather than ignoring, because a silently-dropped `keyringDir`
 * reads to the author as if it worked. There is no environment-enabled test
 * verifier in this runtime module: `NODE_ENV=test` is caller-controlled and
 * therefore cannot turn a trust parameter into a safe one.
 *
 * Verification order matters and is deliberate: NOTHING in the permit body is
 * acted on before the signature over it is checked. Every field — kind,
 * capabilities, budget, validity window — is attacker-controlled input until
 * then.
 */

export type PermitErrorCode =
  | 'PERMIT_MALFORMED'
  | 'GRANT_NOT_MINTED'
  | 'PERMIT_TRUST_INPUT_REJECTED'
  | 'PERMIT_KEYRING_UNAVAILABLE'
  | 'PERMIT_UNKNOWN_KEY'
  | 'PERMIT_BAD_KEY'
  | 'PERMIT_BAD_SIGNATURE'
  | 'PERMIT_CHOOSES_OWN_TRUST'
  | 'PERMIT_MANIFEST_MISMATCH'
  | 'PERMIT_METHODOLOGY_MISMATCH'
  | 'PERMIT_RUN_MISMATCH'
  | 'PERMIT_NOT_YET_VALID'
  | 'PERMIT_EXPIRED'
  | 'PERMIT_CAPABILITY_MISSING'
  | 'PERMIT_KIND_FORBIDS_CAPABILITY'
  | 'PERMIT_KIND_FORBIDS_EVIDENCE_CLASS'
  | 'PERMIT_CELLS_INCOHERENT'
  | 'PERMIT_BUDGET_EXCEEDS_MANIFEST'
  | 'PERMIT_RESERVATION_SCOPE_UNSUPPORTED'
  | 'PERMIT_REVOCATION_UNAVAILABLE'
  | 'PERMIT_REVOKED'
  | 'PERMIT_EXHAUSTED';

export class PermitError extends Error {
  constructor(
    message: string,
    readonly code: PermitErrorCode,
  ) {
    super(message);
    this.name = 'PermitError';
  }
}

// ---------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------

/**
 * Proof that a permit was verified. Obtainable only from the verification core.
 *
 * The fields are readable because callers need them for enforcement and for the
 * traceability record; the fields are not what makes it a grant.
 */
export interface VerifiedGrant {
  readonly permitId: string;
  readonly kind: PermitKind;
  readonly capabilities: readonly Capability[];
  readonly cells: ReadonlyArray<{ readonly modelId: string; readonly questionId: string }>;
  readonly budgetCapUsd: number;
  /** WP-0 implements one reservation per billable provider call. */
  readonly reservationScope: Permit['reservationScope'];
  readonly executionLimit: number;
  /** Retry ceiling copied from the verified manifest, never from a call site. */
  readonly maxAttempts: number;
  /** The one manifest this grant is bound to. */
  readonly manifestHash: string;
  /** The ONE run this authority is for. Everything downstream binds to it. */
  readonly runId: string;
  readonly evidenceClass: EvidenceClass;
  /** Carried so publication can check the artifact, not only the capability. */
  readonly releaseState: ReleaseState;
  /** Which committed public key verified the signature. */
  readonly keyId: string;
  /** Digest of the complete signed permit envelope that minted this grant. */
  readonly signedPermitHash: string;
  /** Exact signed envelope, deep-frozen for later provenance re-verification. */
  readonly signedPermit: Readonly<{
    readonly permit: Readonly<Record<string, unknown>>;
    readonly signature: string;
    readonly keyId: string;
  }>;
  readonly notBeforeIso: string;
  readonly notAfterIso: string;
  readonly verifiedAtIso: string;
}

function deepFreezeJson<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreezeJson(child);
  return Object.freeze(value);
}

/**
 * The registry of grants this process actually minted.
 *
 * Weak so a grant does not outlive its holder. Module-private, with no exported
 * `add`, and never handed out — a reachable authority set is an off switch, the
 * same mistake the frozen-run cache made in an earlier draft of the firewall.
 */
const MINTED = new WeakSet<object>();

/**
 * Which trust root minted each grant.
 *
 * Re-validation at exercise time (`assertGrantStillValid`) must consult the
 * SAME revocation source and the SAME clock that the grant was minted against,
 * or a test grant would be re-checked against the repository's list and a
 * production grant could be re-checked against a temp file. Module-private and
 * weak, for the same reasons as MINTED.
 */
const TRUST_ROOT_FOR_GRANT = new WeakMap<object, TrustRoot>();

/**
 * The runtime authority check. Everything that consumes a grant must call this
 * (or a helper that does) rather than trusting the static type.
 */
export function isVerifiedGrant(value: unknown): value is VerifiedGrant {
  return typeof value === 'object' && value !== null && MINTED.has(value as object);
}

/** Throwing form, for boundaries that should refuse rather than branch. */
export function assertVerifiedGrant(value: unknown, context: string): VerifiedGrant {
  if (!isVerifiedGrant(value)) {
    throw new PermitError(
      `${context} was given an object that this process did not mint by verifying a signed permit. ` +
        `A grant is proved by identity, not by shape — a copied, cloned or hand-built grant carries no authority (RUN-001).`,
      'GRANT_NOT_MINTED',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// The trust root
// ---------------------------------------------------------------------------

export const PERMITS_DIR = join(DATA_DIR, 'permits');
export const KEYRING_DIR = join(PERMITS_DIR, 'keys');
export const REVOCATION_LIST = join(PERMITS_DIR, 'revoked.json');
/** Committed, deliberately unusable permits that prove the production loader. */
export const PERMIT_FIXTURES_DIR = join(PERMITS_DIR, 'fixtures');
const METHODOLOGY_PLAN = join(
  REPO_ROOT,
  'docs/methodology/CookingBench-methodology-first-master-plan.md',
);
const METHODOLOGY_SIDECAR = join(
  REPO_ROOT,
  'docs/methodology/CookingBench-methodology-first-master-plan.sha256',
);

/**
 * The methodology identity production verification uses.
 *
 * Both paths are fixed. The sidecar is evidence rather than the definition, so
 * its digest must equal the actual plan bytes. A caller cannot nominate a
 * convenient methodology hash that merely agrees with the permit it presents.
 */
export function frozenMethodologyHash(): string {
  if (!existsSync(METHODOLOGY_PLAN) || !existsSync(METHODOLOGY_SIDECAR)) {
    throw new PermitError(
      'The frozen methodology plan or its checksum sidecar is absent; permit methodology cannot be established.',
      'PERMIT_METHODOLOGY_MISMATCH',
    );
  }
  const recorded = /^([a-f0-9]{64})(?:\s|$)/.exec(
    readFileSync(METHODOLOGY_SIDECAR, 'utf8').trim(),
  )?.[1];
  if (recorded === undefined) {
    throw new PermitError(
      `The methodology sidecar ${METHODOLOGY_SIDECAR} does not start with a sha256 digest.`,
      'PERMIT_METHODOLOGY_MISMATCH',
    );
  }
  const actual = sha256Hex(readFileSync(METHODOLOGY_PLAN, 'utf8'));
  if (actual !== recorded) {
    throw new PermitError(
      `Frozen methodology checksum mismatch: the sidecar records ${recorded.slice(0, 12)}… but the plan hashes to ${actual.slice(0, 12)}….`,
      'PERMIT_METHODOLOGY_MISMATCH',
    );
  }
  return actual;
}

/**
 * Where verification gets its answers from. Never a parameter of the production
 * API; see the module header.
 */
interface TrustRoot {
  readonly keyringDir: string;
  readonly revocationListPath: string;
  readonly clock: () => Date;
  /** Named in errors, so a refusal says which world it was judged against. */
  readonly label: string;
}

/**
 * The only trust root production ever uses: the committed keyring, the
 * committed revocation list, and the machine's real clock.
 */
const PRODUCTION_TRUST_ROOT: TrustRoot = Object.freeze({
  keyringDir: KEYRING_DIR,
  revocationListPath: REVOCATION_LIST,
  clock: () => new Date(),
  label: 'the committed repository trust root',
});

/**
 * Load a committed Ed25519 public key.
 *
 * The repository holds public verification keys ONLY. The signing key must not
 * be reachable by Claude, Codex, the runner or CI: a system that can mint its
 * own permits is a system that approves itself, and the permit layer would then
 * be decoration.
 */
function loadPublicKey(keyId: string, keyringDir: string): KeyObject {
  // Key ids are a filename component. Constrained rather than sanitised, so a
  // permit naming `../../../etc/something` is rejected as a bad id rather than
  // cleaned into a plausible one.
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyId)) {
    throw new PermitError(
      `Permit names key id ${JSON.stringify(keyId)}, which is not a valid key identifier.`,
      'PERMIT_UNKNOWN_KEY',
    );
  }
  if (!existsSync(keyringDir) || lstatSync(keyringDir).isSymbolicLink()) {
    throw new PermitError(
      `Permit keyring ${keyringDir} is missing or is a symlink. Refusing to verify against an unknown or redirectable key set.`,
      'PERMIT_KEYRING_UNAVAILABLE',
    );
  }
  const keyPath = join(keyringDir, `${keyId}.pub`);
  if (!existsSync(keyPath) || lstatSync(keyPath).isSymbolicLink()) {
    const known = readdirSync(keyringDir)
      .filter((f) => f.endsWith('.pub'))
      .map((f) => f.slice(0, -4));
    throw new PermitError(
      `No committed public key '${keyId}' in ${keyringDir}. Known keys: [${known.join(', ') || 'none'}].`,
      'PERMIT_UNKNOWN_KEY',
    );
  }
  let key: KeyObject;
  try {
    key = createPublicKey({ key: readFileSync(keyPath, 'utf8'), format: 'pem' });
  } catch (e) {
    throw new PermitError(
      `Public key '${keyId}' is not a readable PEM key: ${(e as Error).message}`,
      'PERMIT_BAD_KEY',
    );
  }
  // Pin the algorithm at the key, not just at the call. Accepting whatever type
  // the committed file happens to be would let a substituted key downgrade the
  // scheme, and `crypto.verify(null, ...)` is only Ed25519 by convention here.
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new PermitError(
      `Public key '${keyId}' is ${key.asymmetricKeyType ?? 'of unknown type'}, not ed25519. Permits are Ed25519-signed only.`,
      'PERMIT_BAD_KEY',
    );
  }
  return key;
}

/**
 * The committed revocation list.
 *
 * Fail-closed in the same shape as the historical registry: an ABSENT list is
 * refused rather than treated as "nothing is revoked". An empty list is a
 * statement someone committed; a missing file is an unknown, and an unknown
 * revocation state is not a basis for spending money or publishing.
 *
 * Re-read on every call rather than cached, because revocation has to bite
 * while a long-running process is still exercising its authority — a list read
 * once at start-up cannot revoke anything after start-up.
 */
function revokedPermitIds(listPath: string): ReadonlySet<string> {
  if (!existsSync(listPath)) {
    throw new PermitError(
      `Revocation list ${listPath} is absent. Commit an explicit list (an empty one is fine) — an unknown revocation state is not the same as "nothing is revoked".`,
      'PERMIT_REVOCATION_UNAVAILABLE',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(listPath, 'utf8'));
  } catch (e) {
    throw new PermitError(
      `Revocation list ${listPath} is not valid JSON (${(e as Error).message}).`,
      'PERMIT_REVOCATION_UNAVAILABLE',
    );
  }
  const ids = (parsed as { permitIds?: unknown } | null)?.permitIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
    throw new PermitError(
      `Revocation list ${listPath} must be {"permitIds": string[]}.`,
      'PERMIT_REVOCATION_UNAVAILABLE',
    );
  }
  return new Set(ids as string[]);
}

// ---------------------------------------------------------------------------
// Hashing — TRACE-001
// ---------------------------------------------------------------------------

export function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/**
 * The hash a permit binds to.
 *
 * Two normalisations, both load-bearing:
 *
 *   - Canonical JSON, so key order cannot change the digest. `JSON.stringify`
 *     uses insertion order, which would make the same manifest hash differently
 *     depending on how it was built and every binding check a coin flip.
 *   - PARSED first, so schema defaults are applied before hashing. A manifest
 *     that omits `parentArtifacts` and one that writes `[]` are the same
 *     envelope, and must not be two different hashes — otherwise a permit
 *     minted from a hand-written manifest silently fails to bind the identical
 *     manifest the runner produces.
 *
 * Throws on an invalid manifest rather than hashing nonsense: there is no
 * meaningful digest of an envelope that is not a legal envelope.
 */
export function manifestHash(manifest: unknown): string {
  const parsed = safeParseRunManifest(manifest);
  if (!parsed.ok) {
    throw new PermitError(
      `Cannot hash an invalid manifest: ${parsed.error}`,
      'PERMIT_MANIFEST_MISMATCH',
    );
  }
  return sha256Hex(canonicalJson(parsed.manifest));
}

// ---------------------------------------------------------------------------
// The production boundary
// ---------------------------------------------------------------------------

/**
 * What a production caller may say. Nothing here selects a trust input: the
 * keyring, the revocation list and the clock are fixed, and `expectedRunId` can
 * only ever NARROW what an already-signed permit authorises.
 */
export interface VerifyPermitInput {
  /** The signed permit envelope, as read from disk. Treated as untrusted. */
  signedPermit: unknown;
  /** The manifest this permit must be bound to. Treated as untrusted; re-parsed. */
  manifest: unknown;
  /**
   * The run the invoking command is acting on, when it knows it.
   *
   * Optional because not every command has a run id in hand at verification
   * time, and because it cannot widen anything: a permit still authorises
   * exactly one manifest, and therefore exactly one run. `assertGrantForRun` is
   * the mandatory check at the point of use.
   */
  expectedRunId?: string;
}

export interface VerifiedPermit {
  grant: VerifiedGrant;
  permit: Permit;
  manifest: ValidatedRunManifest;
}

/**
 * Authenticated permit facts for retrospective provenance checks.
 *
 * This is deliberately NOT a grant and is never added to `MINTED`: proving
 * what authorised a historical artifact must not recreate authority to spend,
 * write or publish now.
 */
export interface VerifiedPermitReceipt {
  readonly permitId: string;
  readonly kind: PermitKind;
  readonly capabilities: readonly Capability[];
  readonly reservationScope: Permit['reservationScope'];
  readonly manifestHash: string;
  readonly runId: string;
  readonly evidenceClass: EvidenceClass;
  readonly releaseState: ReleaseState;
  readonly keyId: string;
  readonly signedPermitHash: string;
  readonly signedPermit: VerifiedGrant['signedPermit'];
  readonly notBeforeIso: string;
  readonly notAfterIso: string;
  readonly verifiedAtIso: string;
}

export interface VerifySignedPermitReceiptInput extends VerifyPermitInput {
  /** Optional narrowing check; it can never add a capability to the permit. */
  readonly requiredCapability?: Capability;
}

/** Exactly the keys a production caller may pass. Anything else is refused. */
const PRODUCTION_INPUT_KEYS: ReadonlySet<string> = new Set([
  'signedPermit',
  'manifest',
  'expectedRunId',
]);

/**
 * Trust inputs, named individually so the refusal can explain itself. These are
 * the parameters the previous version accepted from production callers.
 */
const TRUST_INPUT_KEYS: ReadonlySet<string> = new Set([
  'expectedMethodologyHash',
  'keyringDir',
  'revocationListPath',
  'revocationList',
  'now',
  'clock',
  'trustRoot',
  'keyring',
  'publicKey',
]);

/**
 * PARSE the options object rather than destructuring it.
 *
 * TypeScript is not present at runtime: `verifyPermit({ ...opts, keyringDir } as
 * any)` and a plain JavaScript caller are the same call. Ignoring the extra key
 * would be quieter but worse — the author would believe the injection worked.
 * Refusing names the architectural rule at the exact moment someone tries to
 * break it.
 */
function parseProductionInput(input: unknown, entry: string): VerifyPermitInput {
  if (typeof input !== 'object' || input === null) {
    throw new PermitError(`${entry} requires an options object.`, 'PERMIT_MALFORMED');
  }
  // Own keys AND inherited ones: `Object.create({ keyringDir })` is an own-key
  // check away from passing, and `for...in` over a prototype chain is how this
  // would be smuggled in.
  const keys = new Set<string>();
  for (const key in input as Record<string, unknown>) keys.add(key);
  for (const key of Object.getOwnPropertyNames(input)) keys.add(key);

  const trustKeys = [...keys].filter((k) => TRUST_INPUT_KEYS.has(k));
  if (trustKeys.length > 0) {
    throw new PermitError(
      `${entry} was given trust input(s) [${trustKeys.join(', ')}]. The production boundary does not accept a keyring, ` +
        `a revocation source or a clock: a caller that can choose where trust comes from can point it at a key it minted ` +
        `or move it past an expiry, and every later check would pass honestly against inputs the caller chose. ` +
        `Verification always uses ${PRODUCTION_TRUST_ROOT.label} (RUN-001).`,
      'PERMIT_TRUST_INPUT_REJECTED',
    );
  }
  const unknown = [...keys].filter((k) => !PRODUCTION_INPUT_KEYS.has(k));
  if (unknown.length > 0) {
    throw new PermitError(
      `${entry} was given unknown option(s) [${unknown.join(', ')}]. Refusing rather than ignoring them, ` +
        `because a silently-dropped option reads to its author as if it took effect.`,
      'PERMIT_MALFORMED',
    );
  }

  const o = input as Record<string, unknown>;
  if (o.expectedRunId !== undefined && typeof o.expectedRunId !== 'string') {
    throw new PermitError(`${entry} was given a non-string expectedRunId.`, 'PERMIT_MALFORMED');
  }
  return {
    signedPermit: o.signedPermit,
    manifest: o.manifest,
    expectedRunId: o.expectedRunId as string | undefined,
  };
}

/**
 * Verify a signed permit against a manifest and mint a grant. THE production
 * entry point.
 *
 * Every failure is a throw, never a falsy return: a verification function whose
 * failure can be ignored by not reading the result is not a gate.
 */
export function verifyPermit(input: VerifyPermitInput): VerifiedPermit {
  const evidence = verifyEvidenceAgainst(
    PRODUCTION_TRUST_ROOT,
    parseProductionInput(input, 'verifyPermit'),
  );
  return mintVerifiedGrant(evidence, PRODUCTION_TRUST_ROOT);
}

/** Convenience for the CLI: read the envelope from disk, then verify it. */
export function verifyPermitFile(
  permitPath: string,
  rest: Omit<VerifyPermitInput, 'signedPermit'>,
): VerifiedPermit {
  const parsed = parseProductionInput({ ...rest, signedPermit: null }, 'verifyPermitFile');
  const evidence = verifyEvidenceAgainst(PRODUCTION_TRUST_ROOT, {
    ...parsed,
    signedPermit: readPermitEnvelope(permitPath),
  });
  return mintVerifiedGrant(evidence, PRODUCTION_TRUST_ROOT);
}

/**
 * Re-authenticate the exact signed envelope recorded beside a historical
 * artifact without minting executable authority.
 *
 * The keyring, revocation list, clock and frozen methodology are the same fixed
 * repository trust root used by `verifyPermit`; none is caller-selectable.
 */
export function verifySignedPermitReceipt(
  input: VerifySignedPermitReceiptInput,
): VerifiedPermitReceipt {
  const { permitInput, requiredCapability } = parseReceiptInput(input);
  const evidence = verifyEvidenceAgainst(PRODUCTION_TRUST_ROOT, permitInput, {
    requireCurrentValidity: false,
  });
  if (
    requiredCapability !== undefined &&
    !evidence.permit.capabilities.includes(requiredCapability)
  ) {
    throw new PermitError(
      `Permit ${evidence.permit.permitId} does not carry required capability '${requiredCapability}'. ` +
        `A retrospective check may narrow signed authority; it cannot add authority the approver did not sign.`,
      'PERMIT_CAPABILITY_MISSING',
    );
  }
  return Object.freeze({
    permitId: evidence.permit.permitId,
    kind: evidence.permit.kind,
    capabilities: Object.freeze([...evidence.permit.capabilities]),
    reservationScope: evidence.permit.reservationScope,
    manifestHash: evidence.actualManifestHash,
    runId: evidence.manifest.runId,
    evidenceClass: evidence.manifest.evidenceClass,
    releaseState: evidence.manifest.releaseState,
    keyId: evidence.keyId,
    signedPermitHash: sha256Hex(evidence.signedPermitJson),
    signedPermit: evidence.signedPermit,
    notBeforeIso: evidence.permit.notBefore,
    notAfterIso: evidence.permit.notAfter,
    verifiedAtIso: evidence.now.toISOString(),
  });
}

const RECEIPT_INPUT_KEYS: ReadonlySet<string> = new Set([
  ...PRODUCTION_INPUT_KEYS,
  'requiredCapability',
]);

function parseReceiptInput(input: unknown): {
  permitInput: VerifyPermitInput;
  requiredCapability?: Capability;
} {
  if (typeof input !== 'object' || input === null) {
    throw new PermitError(
      'verifySignedPermitReceipt requires an options object.',
      'PERMIT_MALFORMED',
    );
  }
  const keys = new Set<string>();
  for (const key in input as Record<string, unknown>) keys.add(key);
  for (const key of Object.getOwnPropertyNames(input)) keys.add(key);
  const trustKeys = [...keys].filter((key) => TRUST_INPUT_KEYS.has(key));
  if (trustKeys.length > 0) {
    throw new PermitError(
      `verifySignedPermitReceipt was given trust input(s) [${trustKeys.join(', ')}]. ` +
        `Retrospective verification uses ${PRODUCTION_TRUST_ROOT.label}; callers cannot select its keyring, revocation source, clock or methodology.`,
      'PERMIT_TRUST_INPUT_REJECTED',
    );
  }
  const unknown = [...keys].filter((key) => !RECEIPT_INPUT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new PermitError(
      `verifySignedPermitReceipt was given unknown option(s) [${unknown.join(', ')}].`,
      'PERMIT_MALFORMED',
    );
  }
  const o = input as Record<string, unknown>;
  const allCapabilities = new Set<unknown>(Object.values(CAPABILITIES_FOR_PERMIT_KIND).flat());
  if (
    o.requiredCapability !== undefined &&
    (typeof o.requiredCapability !== 'string' || !allCapabilities.has(o.requiredCapability))
  ) {
    throw new PermitError(
      'verifySignedPermitReceipt was given an invalid requiredCapability.',
      'PERMIT_MALFORMED',
    );
  }
  return {
    permitInput: parseProductionInput(
      {
        signedPermit: o.signedPermit,
        manifest: o.manifest,
        expectedRunId: o.expectedRunId,
      },
      'verifySignedPermitReceipt',
    ),
    requiredCapability: o.requiredCapability as Capability | undefined,
  };
}

function readPermitEnvelope(permitPath: string): unknown {
  if (!existsSync(permitPath)) {
    throw new PermitError(`No permit at ${permitPath}.`, 'PERMIT_MALFORMED');
  }
  try {
    return JSON.parse(readFileSync(permitPath, 'utf8'));
  } catch (e) {
    throw new PermitError(
      `Permit ${permitPath} is not valid JSON (${(e as Error).message}).`,
      'PERMIT_MALFORMED',
    );
  }
}

// ---------------------------------------------------------------------------
// Verification core — reached only through the fixed-trust entry points above
// ---------------------------------------------------------------------------

interface VerifiedEvidence {
  readonly permit: Permit;
  readonly manifest: ValidatedRunManifest;
  readonly keyId: string;
  readonly actualManifestHash: string;
  readonly now: Date;
  readonly signedPermitJson: string;
  readonly signedPermit: VerifiedGrant['signedPermit'];
}

function verifyEvidenceAgainst(
  trustRoot: TrustRoot,
  input: VerifyPermitInput,
  policy: { requireCurrentValidity?: boolean } = {},
): VerifiedEvidence {
  const now = trustRoot.clock();

  // 1. Enough envelope structure to find the signature. Deliberately NOT the
  // full zod parse — see step 2 for why the order matters.
  const raw = input.signedPermit as { permit?: unknown; signature?: unknown; keyId?: unknown } | null;
  if (typeof raw !== 'object' || raw === null || typeof raw.permit !== 'object' || raw.permit === null) {
    throw new PermitError(
      `Permit envelope must be { permit, signature, keyId }; got ${raw === null ? 'null' : typeof raw}.`,
      'PERMIT_MALFORMED',
    );
  }
  if (typeof raw.signature !== 'string' || typeof raw.keyId !== 'string') {
    throw new PermitError(`Permit envelope is missing a string signature or keyId.`, 'PERMIT_MALFORMED');
  }
  const keyId = raw.keyId;

  // 2. Signature FIRST, over the RAW body as it sits on disk.
  //
  // Verifying the zod-PARSED body would be subtly wrong in both directions:
  // parsing applies defaults (`executionLimit`, `cells`) and strips unknown
  // keys, so a permit signed as written would fail against its own normalised
  // form, and any field the schema drops would sit outside the signature's
  // coverage. Signing the bytes the approver actually signed keeps the
  // signature over everything in the file.
  //
  // Until this passes, `kind`, `capabilities` and `budgetCapUsd` are just
  // strings and numbers someone sent us, and nothing may be acted on.
  const key = loadPublicKey(keyId, trustRoot.keyringDir);
  // Buffer.from(_, 'base64') is lenient — it ignores invalid characters rather
  // than throwing — so the length check, not a try/catch, is what rejects junk.
  const signatureBytes = Buffer.from(raw.signature, 'base64');
  const signedBytes = Buffer.from(canonicalJson(raw.permit), 'utf8');
  if (signatureBytes.length !== 64 || !verifySignature(null, signedBytes, key, signatureBytes)) {
    throw new PermitError(
      `Permit does not carry a valid Ed25519 signature from key '${keyId}'. ` +
        `Minting a permit requires the offline signing key, which is deliberately not available to this process (RUN-001).`,
      'PERMIT_BAD_SIGNATURE',
    );
  }

  // 3. Now that the body is authenticated, give it its full shape.
  const envelope = signedPermitSchema.safeParse(input.signedPermit);
  if (!envelope.success) {
    throw new PermitError(
      `Permit envelope failed validation: ${envelope.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`,
      'PERMIT_MALFORMED',
    );
  }
  const { permit } = envelope.data;

  // 4. A permit may not nominate its own trust sources.
  //
  // `revocationListUrl` is an optional field of the permit schema, and honouring
  // it would hand the revocation decision to the document being revoked — the
  // same defect as a caller-supplied keyring, one indirection further out. It is
  // refused rather than ignored so nobody signs one believing it does something.
  if (permit.revocationListUrl !== undefined) {
    throw new PermitError(
      `Permit ${permit.permitId} names its own revocation source (${permit.revocationListUrl}). ` +
        `Revocation is read from ${trustRoot.label}; a permit that chooses where its own revocation is checked cannot be revoked.`,
      'PERMIT_CHOOSES_OWN_TRUST',
    );
  }

  // 5. Revocation. A validly signed permit can still have been withdrawn.
  if (revokedPermitIds(trustRoot.revocationListPath).has(permit.permitId)) {
    throw new PermitError(`Permit ${permit.permitId} has been revoked.`, 'PERMIT_REVOKED');
  }

  // 6. Manifest binding. The manifest is re-parsed here rather than trusted from
  // the caller — assertPublishable learned this lesson the hard way.
  const parsedManifest = safeParseRunManifest(input.manifest);
  if (!parsedManifest.ok) {
    throw new PermitError(
      `Permit ${permit.permitId} cannot be bound: the manifest failed validation (${parsedManifest.error}).`,
      'PERMIT_MANIFEST_MISMATCH',
    );
  }
  const manifest = parsedManifest.manifest;
  const actualManifestHash = manifestHash(manifest);
  if (actualManifestHash !== permit.manifestHash) {
    throw new PermitError(
      `Permit ${permit.permitId} authorises manifest ${permit.manifestHash.slice(0, 12)}… but was presented with ${actualManifestHash.slice(0, 12)}… (run ${manifest.runId}). ` +
        `A permit authorises one exact execution envelope; changing any field of the manifest invalidates it.`,
      'PERMIT_MANIFEST_MISMATCH',
    );
  }
  const expectedMethodologyHash = frozenMethodologyHash();
  if (permit.methodologyHash !== expectedMethodologyHash) {
    throw new PermitError(
      `Permit ${permit.permitId} names methodology ${permit.methodologyHash.slice(0, 12)}… but the frozen methodology is ${expectedMethodologyHash.slice(0, 12)}…. ` +
        `Approval was given against a specific protocol revision.`,
      'PERMIT_METHODOLOGY_MISMATCH',
    );
  }

  // 7. One run id, everywhere. The permit binds a manifest, the manifest names
  // exactly one run, and a command that already knows which run it is acting on
  // says so here. An approval for run A acting on run B is the whole point of
  // binding, and it was previously checked nowhere.
  if (input.expectedRunId !== undefined && input.expectedRunId !== manifest.runId) {
    throw new PermitError(
      `Permit ${permit.permitId} authorises run '${manifest.runId}', but the command is acting on run '${input.expectedRunId}'. ` +
        `Authority issued for one run is not authority for another.`,
      'PERMIT_RUN_MISMATCH',
    );
  }

  // 8. Validity window.
  const notBefore = new Date(permit.notBefore);
  const notAfter = new Date(permit.notAfter);
  if ((policy.requireCurrentValidity ?? true) && now < notBefore) {
    throw new PermitError(
      `Permit ${permit.permitId} is not valid until ${permit.notBefore} (now ${now.toISOString()}).`,
      'PERMIT_NOT_YET_VALID',
    );
  }
  if ((policy.requireCurrentValidity ?? true) && now > notAfter) {
    throw new PermitError(
      `Permit ${permit.permitId} expired at ${permit.notAfter} (now ${now.toISOString()}).`,
      'PERMIT_EXPIRED',
    );
  }

  // 9. Kind × capability. This is the check a valid signature must not buy past:
  // the approver signed a KIND of work, and the capability list has to stay
  // inside what that kind means.
  for (const capability of permit.capabilities) {
    if (!permitKindAllowsCapability(permit.kind, capability)) {
      throw new PermitError(
        `Permit ${permit.permitId} is kind '${permit.kind}' but requests capability '${capability}'. ` +
          `A '${permit.kind}' permit may grant at most [${CAPABILITIES_FOR_PERMIT_KIND[permit.kind].join(', ')}]. ` +
          `A valid signature proves who approved the work, not that the work was allowed to be this.`,
        'PERMIT_KIND_FORBIDS_CAPABILITY',
      );
    }
  }

  // 10. Kind × evidence class, so a permit cannot launder a non-ranking
  // re-analysis into rank-bearing evidence by binding a different manifest.
  if (!permitKindAllowsEvidenceClass(permit.kind, manifest.evidenceClass)) {
    throw new PermitError(
      `Permit ${permit.permitId} is kind '${permit.kind}' but binds a '${manifest.evidenceClass}' manifest (run ${manifest.runId}). ` +
        `Allowed: [${EVIDENCE_CLASSES_FOR_PERMIT_KIND[permit.kind].join(', ')}].`,
      'PERMIT_KIND_FORBIDS_EVIDENCE_CLASS',
    );
  }

  // 11. Cells. Deny-by-default means an empty cell list authorises nothing, so
  // an inference permit with no cells is an authoring mistake that would
  // otherwise fail confusingly at the first call. And a cell naming a model the
  // manifest does not declare is a permit reaching outside its own envelope.
  const grantsInference = permit.capabilities.some((c) => INFERENCE_CAPABILITIES.includes(c));
  if (grantsInference && permit.cells.length === 0) {
    throw new PermitError(
      `Permit ${permit.permitId} grants inference but authorises no cells. An empty cell list authorises nothing; state the cells explicitly.`,
      'PERMIT_CELLS_INCOHERENT',
    );
  }
  if (!grantsInference && permit.cells.length > 0) {
    throw new PermitError(
      `Permit ${permit.permitId} authorises ${permit.cells.length} inference cell(s) but grants no inference capability.`,
      'PERMIT_CELLS_INCOHERENT',
    );
  }
  const declaredModels = new Set(
    [...manifest.candidateRoutes, ...manifest.judgeRoutes].map((r) => r.modelId),
  );
  for (const cell of permit.cells) {
    if (!declaredModels.has(cell.modelId)) {
      throw new PermitError(
        `Permit ${permit.permitId} authorises model '${cell.modelId}', which run ${manifest.runId} does not declare as a candidate or judge route.`,
        'PERMIT_CELLS_INCOHERENT',
      );
    }
  }

  // 12. Budget. The manifest is the envelope; a permit may spend less than it,
  // never more. Both are still ceilings on ESTIMATES — the reservation ledger
  // (BUDGET-001) is what enforces actual spend.
  // Only call-scoped reservations are implemented: the ledger reserves once
  // around every potentially billable provider request. Accepting `run` or
  // `model` while enforcing the same behaviour would make a signed control
  // decorative, so unsupported scopes fail closed until they have distinct,
  // specified semantics.
  if (permit.reservationScope !== 'call') {
    throw new PermitError(
      `Permit ${permit.permitId} requests reservationScope '${permit.reservationScope}', but this runner implements only 'call'.`,
      'PERMIT_RESERVATION_SCOPE_UNSUPPORTED',
    );
  }
  if (permit.budgetCapUsd > manifest.budgetCapUsd) {
    throw new PermitError(
      `Permit ${permit.permitId} caps spend at $${permit.budgetCapUsd} but run ${manifest.runId} declares $${manifest.budgetCapUsd}. A permit cannot raise the manifest's budget.`,
      'PERMIT_BUDGET_EXCEEDS_MANIFEST',
    );
  }

  const signedPermitJson = canonicalJson(input.signedPermit);
  const signedPermit = deepFreezeJson(
    JSON.parse(signedPermitJson) as {
      permit: Record<string, unknown>;
      signature: string;
      keyId: string;
    },
  );
  return {
    permit,
    manifest,
    keyId,
    actualManifestHash,
    now,
    signedPermitJson,
    signedPermit,
  };
}

function mintVerifiedGrant(
  evidence: VerifiedEvidence,
  trustRoot: TrustRoot,
): VerifiedPermit {
  const {
    permit,
    manifest,
    keyId,
    actualManifestHash,
    now,
    signedPermitJson,
    signedPermit,
  } = evidence;
  const grant: VerifiedGrant = Object.freeze({
    permitId: permit.permitId,
    kind: permit.kind,
    capabilities: Object.freeze([...permit.capabilities]),
    cells: Object.freeze(
      permit.cells.map((c) => Object.freeze({ modelId: c.modelId, questionId: c.questionId })),
    ),
    budgetCapUsd: permit.budgetCapUsd,
    reservationScope: permit.reservationScope,
    executionLimit: permit.executionLimit,
    maxAttempts: manifest.callPlan.maxAttempts,
    manifestHash: actualManifestHash,
    runId: manifest.runId,
    evidenceClass: manifest.evidenceClass,
    releaseState: manifest.releaseState,
    keyId,
    signedPermitHash: sha256Hex(signedPermitJson),
    signedPermit,
    notBeforeIso: permit.notBefore,
    notAfterIso: permit.notAfter,
    verifiedAtIso: now.toISOString(),
  });
  MINTED.add(grant);
  TRUST_ROOT_FOR_GRANT.set(grant, trustRoot);
  return { grant, permit, manifest };
}

// ---------------------------------------------------------------------------
// Authority at the moment it is EXERCISED
// ---------------------------------------------------------------------------

/**
 * Re-check expiry and revocation now, not at load time.
 *
 * A run takes hours. Verifying once at start-up and then trusting the resulting
 * object for the rest of the process means a permit that expires mid-run keeps
 * spending, and a permit revoked because something went wrong keeps going until
 * someone notices. Validity is a property of the MOMENT OF USE, so every
 * boundary that spends money, writes to the live database or publishes calls
 * this immediately before acting.
 *
 * It re-reads the revocation list from the same trust root that minted the
 * grant. That is a file read per exercised capability, which is nothing next to
 * a provider round trip, and caching it would reintroduce exactly the staleness
 * this exists to remove.
 */
export function assertGrantStillValid(grant: VerifiedGrant, context: string): VerifiedGrant {
  assertVerifiedGrant(grant, context);
  const trustRoot = TRUST_ROOT_FOR_GRANT.get(grant);
  if (!trustRoot) {
    // Unreachable unless someone mints a grant without recording its root.
    // Fail closed rather than silently falling back to the production root.
    throw new PermitError(
      `${context}: grant ${grant.permitId} has no recorded trust root, so its revocation state cannot be re-checked.`,
      'GRANT_NOT_MINTED',
    );
  }
  if (revokedPermitIds(trustRoot.revocationListPath).has(grant.permitId)) {
    throw new PermitError(
      `${context} refused: permit ${grant.permitId} has been revoked since it was verified. ` +
        `Revocation is checked at the moment authority is exercised, not only when it was loaded.`,
      'PERMIT_REVOKED',
    );
  }
  const now = trustRoot.clock();
  if (now > new Date(grant.notAfterIso)) {
    throw new PermitError(
      `${context} refused: permit ${grant.permitId} expired at ${grant.notAfterIso} (now ${now.toISOString()}). ` +
        `A process may not outlive its permit.`,
      'PERMIT_EXPIRED',
    );
  }
  if (now < new Date(grant.notBeforeIso)) {
    // Reachable if the clock is corrected backwards mid-process. Refusing is
    // the only reading that stays inside the approved window.
    throw new PermitError(
      `${context} refused: permit ${grant.permitId} is not valid until ${grant.notBeforeIso} (now ${now.toISOString()}).`,
      'PERMIT_NOT_YET_VALID',
    );
  }
  return grant;
}

/**
 * The one-run-id binder. Use at every boundary that names a run: sync,
 * publication, and any command that takes `--run`.
 *
 * Also re-validates, so a caller cannot get the run check without the freshness
 * check — the two failures they prevent (wrong run, stale authority) are both
 * failures of "is this authority good for what I am about to do".
 */
export function assertGrantForRun(grant: VerifiedGrant, runId: string, context: string): VerifiedGrant {
  assertGrantStillValid(grant, context);
  if (grant.runId !== runId) {
    throw new PermitError(
      `${context} refused: permit ${grant.permitId} authorises run '${grant.runId}', not '${runId}'. ` +
        `Authority is issued for one run; it does not carry across to another.`,
      'PERMIT_RUN_MISMATCH',
    );
  }
  return grant;
}
