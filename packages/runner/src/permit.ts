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
  type ValidatedRunManifest,
} from '@cookingbench/core';
import { DATA_DIR } from './dataset.js';

/**
 * RUN-001 — permit verification, and the grant that verification mints.
 *
 * The point of this module is that authority is a RUNTIME fact.
 *
 * The previous attempt at an unforgeable value used `declare const brand: unique
 * symbol` and an intersection type. TypeScript erases that entirely, so a
 * hand-written object literal walked straight through the boundary at runtime —
 * and the code around it read as if it were guarded, which is worse than an
 * unguarded boundary because it stops people looking. A type-level brand is a
 * lint.
 *
 * So a `VerifiedGrant` here is not a shape. It is MEMBERSHIP of a module-private
 * WeakSet that only `verifyPermit` writes to. There is no exported way to add to
 * it, the set is never returned, and structural equality buys nothing: a copy of
 * a real grant — spread, `structuredClone`, `JSON.parse(JSON.stringify(...))` —
 * is a different object identity and therefore carries no authority. That check
 * behaves the same from TypeScript, from plain JavaScript, from a test using
 * `as any`, and across a package boundary, which is the actual requirement.
 *
 * Verification order matters and is deliberate: NOTHING in the permit body is
 * acted on before the signature over it is checked. Every field — kind,
 * capabilities, budget, validity window — is attacker-controlled input until
 * then.
 */

export type PermitErrorCode =
  | 'PERMIT_MALFORMED'
  | 'GRANT_NOT_MINTED'
  | 'PERMIT_KEYRING_UNAVAILABLE'
  | 'PERMIT_UNKNOWN_KEY'
  | 'PERMIT_BAD_KEY'
  | 'PERMIT_BAD_SIGNATURE'
  | 'PERMIT_MANIFEST_MISMATCH'
  | 'PERMIT_METHODOLOGY_MISMATCH'
  | 'PERMIT_NOT_YET_VALID'
  | 'PERMIT_EXPIRED'
  | 'PERMIT_KIND_FORBIDS_CAPABILITY'
  | 'PERMIT_KIND_FORBIDS_EVIDENCE_CLASS'
  | 'PERMIT_CELLS_INCOHERENT'
  | 'PERMIT_BUDGET_EXCEEDS_MANIFEST'
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
 * Proof that a permit was verified. Obtainable only from `verifyPermit`.
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
  readonly executionLimit: number;
  /** The one manifest this grant is bound to. */
  readonly manifestHash: string;
  readonly runId: string;
  readonly evidenceClass: EvidenceClass;
  /** Which committed public key verified the signature. */
  readonly keyId: string;
  readonly notAfterIso: string;
  readonly verifiedAtIso: string;
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
// Keyring
// ---------------------------------------------------------------------------

export const PERMITS_DIR = join(DATA_DIR, 'permits');
export const KEYRING_DIR = join(PERMITS_DIR, 'keys');
export const REVOCATION_LIST = join(PERMITS_DIR, 'revoked.json');

/**
 * Key ids are a filename component. Constrained rather than sanitised, so a
 * permit naming `../../../etc/something` is rejected as a bad id rather than
 * cleaned into a plausible one.
 */
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Load a committed Ed25519 public key.
 *
 * The repository holds public verification keys ONLY. The signing key must not
 * be reachable by Claude, Codex, the runner or CI: a system that can mint its
 * own permits is a system that approves itself, and the permit layer would then
 * be decoration.
 */
function loadPublicKey(keyId: string, keyringDir: string): KeyObject {
  if (!KEY_ID_PATTERN.test(keyId)) {
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
// Verification
// ---------------------------------------------------------------------------

export interface VerifyPermitInput {
  /** The signed permit envelope, as read from disk. Treated as untrusted. */
  signedPermit: unknown;
  /** The manifest this permit must be bound to. Treated as untrusted; re-parsed. */
  manifest: unknown;
  /** Hash of the frozen methodology revision the permit must name. */
  expectedMethodologyHash: string;
  now?: Date;
  keyringDir?: string;
  revocationListPath?: string;
}

export interface VerifiedPermit {
  grant: VerifiedGrant;
  permit: Permit;
  manifest: ValidatedRunManifest;
}

/**
 * Verify a signed permit against a manifest and mint a grant.
 *
 * Every failure is a throw, never a falsy return: a verification function whose
 * failure can be ignored by not reading the result is not a gate.
 */
export function verifyPermit(input: VerifyPermitInput): VerifiedPermit {
  const keyringDir = input.keyringDir ?? KEYRING_DIR;
  const revocationListPath = input.revocationListPath ?? REVOCATION_LIST;
  const now = input.now ?? new Date();

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
  const key = loadPublicKey(keyId, keyringDir);
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

  // 4. Revocation. A validly signed permit can still have been withdrawn.
  if (revokedPermitIds(revocationListPath).has(permit.permitId)) {
    throw new PermitError(`Permit ${permit.permitId} has been revoked.`, 'PERMIT_REVOKED');
  }

  // 5. Manifest binding. The manifest is re-parsed here rather than trusted from
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
  if (permit.methodologyHash !== input.expectedMethodologyHash) {
    throw new PermitError(
      `Permit ${permit.permitId} names methodology ${permit.methodologyHash.slice(0, 12)}… but the frozen methodology is ${input.expectedMethodologyHash.slice(0, 12)}…. ` +
        `Approval was given against a specific protocol revision.`,
      'PERMIT_METHODOLOGY_MISMATCH',
    );
  }

  // 6. Validity window.
  const notBefore = new Date(permit.notBefore);
  const notAfter = new Date(permit.notAfter);
  if (now < notBefore) {
    throw new PermitError(
      `Permit ${permit.permitId} is not valid until ${permit.notBefore} (now ${now.toISOString()}).`,
      'PERMIT_NOT_YET_VALID',
    );
  }
  if (now > notAfter) {
    throw new PermitError(
      `Permit ${permit.permitId} expired at ${permit.notAfter} (now ${now.toISOString()}).`,
      'PERMIT_EXPIRED',
    );
  }

  // 7. Kind × capability. This is the check a valid signature must not buy past:
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

  // 8. Kind × evidence class, so a permit cannot launder a non-ranking
  // re-analysis into rank-bearing evidence by binding a different manifest.
  if (!permitKindAllowsEvidenceClass(permit.kind, manifest.evidenceClass)) {
    throw new PermitError(
      `Permit ${permit.permitId} is kind '${permit.kind}' but binds a '${manifest.evidenceClass}' manifest (run ${manifest.runId}). ` +
        `Allowed: [${EVIDENCE_CLASSES_FOR_PERMIT_KIND[permit.kind].join(', ')}].`,
      'PERMIT_KIND_FORBIDS_EVIDENCE_CLASS',
    );
  }

  // 9. Cells. Deny-by-default means an empty cell list authorises nothing, so an
  // inference permit with no cells is an authoring mistake that would otherwise
  // fail confusingly at the first call. And a cell naming a model the manifest
  // does not declare is a permit reaching outside its own envelope.
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

  // 10. Budget. The manifest is the envelope; a permit may spend less than it,
  // never more. Both are still ceilings on ESTIMATES — the reservation ledger
  // (BUDGET-001) is what enforces actual spend, and it is not built yet.
  if (permit.budgetCapUsd > manifest.budgetCapUsd) {
    throw new PermitError(
      `Permit ${permit.permitId} caps spend at $${permit.budgetCapUsd} but run ${manifest.runId} declares $${manifest.budgetCapUsd}. A permit cannot raise the manifest's budget.`,
      'PERMIT_BUDGET_EXCEEDS_MANIFEST',
    );
  }

  const grant: VerifiedGrant = Object.freeze({
    permitId: permit.permitId,
    kind: permit.kind,
    capabilities: Object.freeze([...permit.capabilities]),
    cells: Object.freeze(
      permit.cells.map((c) => Object.freeze({ modelId: c.modelId, questionId: c.questionId })),
    ),
    budgetCapUsd: permit.budgetCapUsd,
    executionLimit: permit.executionLimit,
    manifestHash: actualManifestHash,
    runId: manifest.runId,
    evidenceClass: manifest.evidenceClass,
    keyId,
    notAfterIso: permit.notAfter,
    verifiedAtIso: now.toISOString(),
  });
  MINTED.add(grant);
  return { grant, permit, manifest };
}

/** Convenience for the CLI: read the envelope from disk, then verify it. */
export function verifyPermitFile(
  permitPath: string,
  rest: Omit<VerifyPermitInput, 'signedPermit'>,
): VerifiedPermit {
  if (!existsSync(permitPath)) {
    throw new PermitError(`No permit at ${permitPath}.`, 'PERMIT_MALFORMED');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(permitPath, 'utf8'));
  } catch (e) {
    throw new PermitError(`Permit ${permitPath} is not valid JSON (${(e as Error).message}).`, 'PERMIT_MALFORMED');
  }
  return verifyPermit({ ...rest, signedPermit: parsed });
}
