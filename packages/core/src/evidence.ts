import { z } from 'zod';

/**
 * WP-0 evidence firewall vocabulary — RELEASE-001 and DATA-002 of the
 * methodology-first master plan, Revision 3.
 *
 * This module is deliberately pure: types, schemas and predicates, no I/O. The
 * bypass-path inventory confirmed packages/core currently performs zero
 * filesystem or network operations, and keeping it that way means the rules can
 * be imported anywhere — including the web app — without dragging an
 * enforcement surface along with them. Enforcement lives in
 * packages/runner/src/firewall.ts.
 *
 * Three orthogonal axes describe every artifact. Collapsing any two of them is
 * the mistake this vocabulary exists to prevent:
 *
 *   evidenceClass  what the evidence is eligible to SUPPORT
 *   releaseState   where it sits in its lifecycle
 *   artifactOrigin where it CAME FROM
 *
 * Origin never upgrades eligibility. A synthetic or mock artifact stays
 * `development` however it is labelled downstream.
 */

/** RELEASE-001. Exactly one per run and per derived artifact. */
export const EVIDENCE_CLASSES = [
  /** Immutable released candidate answers, ballots, scores and reports (v1/v2). */
  'historical',
  /** Archived-answer re-analysis under a frozen shadow manifest. Never ranks. */
  'legacy-shadow',
  /** Non-rank-bearing authored, human, synthetic, mock or transformed evidence. */
  'development',
  /** Fresh outputs from predeclared sacrificial models/items. Never ranks. */
  'development-probe',
  /** First rank-bearing candidate evidence under the frozen protocol. */
  'confirmatory-pilot',
  /** An explicitly approved immutable result. The only publishable class. */
  'public-release',
] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

/** RELEASE-001. Provenance, with lineage where more than one applies. */
export const ARTIFACT_ORIGINS = [
  'archived',
  'human',
  'agent-authored',
  'transformed-archive',
  'synthetic',
  'mock',
  'live-provider',
] as const;
export type ArtifactOrigin = (typeof ARTIFACT_ORIGINS)[number];

/** RELEASE-001. Lifecycle: draft → audited → released, with two branches. */
export const RELEASE_STATES = ['draft', 'audited', 'released', 'quarantined', 'retired'] as const;
export type ReleaseState = (typeof RELEASE_STATES)[number];

/**
 * RUN-001. Capabilities a permit may grant. Deny-by-default means the absence
 * of a capability is a denial, so this list is exhaustive by construction —
 * anything not named here cannot be authorised at all.
 */
export const CAPABILITIES = [
  'catalog-read',
  'candidate-inference',
  'judge-inference',
  'development-db-write',
  'live-db-write',
  'presentation-erratum',
  'result-sync',
  'publication',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** The permanent label required on every non-scoring surface. */
export const NON_SCORING_LABEL = 'NON-SCORING — NOT FOR LEADERBOARD' as const;

/**
 * Run ids are a path component, so they are constrained here rather than
 * trusted. Before WP-0 this was the single largest hole in the system: `runId`
 * went from argv into `join(RUNS_DIR, runId)` unvalidated, so `--run-id ../..`
 * escaped the runs directory entirely and recursive mkdir built the tree.
 * Question ids and model slugs were already constrained in schema.ts; run ids
 * were the one component that was not.
 */
export const RUN_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;

/**
 * A leading `.` is excluded because it creates hidden directories and is the
 * first character of every traversal; a leading `-` is excluded because an id
 * that looks like a flag invites argument-parsing confusion. A leading `_` is
 * harmless and is allowed — test fixtures use it.
 */
export const runIdSchema = z
  .string()
  .regex(RUN_ID_PATTERN, 'run id must be 1–64 chars of [A-Za-z0-9._-] and may not begin with "." or "-"')
  // Belt and braces: the pattern already excludes '/' and the leading dot, but
  // traversal is the failure that matters most, so it is rejected by name too.
  .refine((v) => !v.includes('..'), 'run id may not contain ".."');

export const evidenceClassSchema = z.enum(EVIDENCE_CLASSES);
export const artifactOriginSchema = z.enum(ARTIFACT_ORIGINS);
export const releaseStateSchema = z.enum(RELEASE_STATES);
export const capabilitySchema = z.enum(CAPABILITIES);

/** A SHA-256 hex digest. */
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'expected a sha256 hex digest');

/**
 * DATA-002. The immutable execution envelope.
 *
 * WP-0 owns this. WP-1 may add referenced v3 domain-contract hashes and
 * schemas, but must not redefine the firewall, permit or release fields.
 */
export const runManifestSchema = z.object({
  manifestVersion: z.literal(1),

  // Identity and lineage
  runId: runIdSchema,
  methodologyVersion: z.string().min(1),
  schemaVersion: z.string().min(1),
  gitCommit: z.string().regex(/^[a-f0-9]{7,40}$/),
  /** Run ids this artifact derives from. Empty for a fresh run. */
  parentArtifacts: z.array(runIdSchema).default([]),

  // The three orthogonal axes
  evidenceClass: evidenceClassSchema,
  artifactOrigin: z.array(artifactOriginSchema).min(1),
  releaseState: releaseStateSchema,
  /**
   * Whether this artifact may contribute to a public ranking. Derived from
   * evidenceClass, never set independently — see assertManifestCoherent.
   */
  rankEligible: z.boolean(),

  // Content hashes: what was actually asked and how it was scored
  bankHash: hashSchema,
  promptHash: hashSchema,
  judgePromptHash: hashSchema,
  validatorHash: hashSchema,

  // Routes and settings
  candidateRoutes: z.array(
    z.object({
      modelId: z.string().min(1),
      provider: z.string().min(1),
      /** JUDGE-001: distinct from provider. A rebadged base model shares this. */
      baseModelFamily: z.string().min(1),
    }),
  ),
  judgeRoutes: z.array(
    z.object({
      modelId: z.string().min(1),
      provider: z.string().min(1),
      baseModelFamily: z.string().min(1),
    }),
  ),
  generationSettings: z.object({
    temperature: z.number(),
    maxTokens: z.number().int().positive(),
    maxTokensRecipe: z.number().int().positive(),
    /** How many independent responses per (model, item). */
    repeats: z.number().int().positive().default(1),
    repeatPolicy: z.enum(['single', 'fixed-repeats', 'creative-sampling']).default('single'),
  }),

  // Execution policy
  callPlan: z.object({
    concurrency: z.number().int().positive(),
    maxAttempts: z.number().int().positive(),
    abortOn: z.array(z.string()).default([]),
  }),
  budgetCapUsd: z.number().nonnegative(),
  /** Isolated root for this run's outputs. Never a historical run directory. */
  outputRoot: z.string().min(1),
});
export type RunManifest = z.infer<typeof runManifestSchema>;

/** RUN-001. A signed, single-use authorisation to do something dangerous. */
export const permitSchema = z.object({
  permitVersion: z.literal(1),
  permitId: z.string().min(8),
  kind: z.enum(['legacy-shadow', 'development-probe', 'confirmatory-pilot', 'presentation-erratum', 'publication']),

  /** Binds the permit to exactly one manifest and one methodology revision. */
  manifestHash: hashSchema,
  methodologyHash: hashSchema,

  capabilities: z.array(capabilitySchema).min(1),
  /**
   * Exact model–item or judge–answer cells where inference is allowed.
   * An empty array means no inference cell is authorised, which is not the
   * same as "all cells" — absence is denial everywhere in this contract.
   */
  cells: z
    .array(z.object({ modelId: z.string().min(1), questionId: z.string().min(1) }))
    .default([]),

  budgetCapUsd: z.number().nonnegative(),
  reservationScope: z.enum(['run', 'model', 'call']),

  issuer: z.string().min(1),
  approver: z.string().min(1),
  approvalEvidence: z.string().min(1),

  /** ISO 8601. The permit is invalid outside this window. */
  notBefore: z.string().datetime(),
  notAfter: z.string().datetime(),
  /** How many times this permit may be redeemed. Single-use is the default. */
  executionLimit: z.number().int().positive().default(1),
  revocationListUrl: z.string().optional(),
});
export type Permit = z.infer<typeof permitSchema>;

/**
 * A permit as stored on disk: body plus detached signature. Verification is
 * cryptographic on purpose — RUN-001 requires that it "cannot be replaced by a
 * local boolean", so there is deliberately no `approved: true` field anywhere
 * in this contract. Minting a permit requires the private key.
 */
export const signedPermitSchema = z.object({
  permit: permitSchema,
  /** Ed25519 signature over the canonical JSON of `permit`, base64. */
  signature: z.string().min(1),
  /** Which committed public key signed it. */
  keyId: z.string().min(1),
});
export type SignedPermit = z.infer<typeof signedPermitSchema>;

/** RELEASE-002. Only one class may ever create a public result. */
export function isRankEligible(evidenceClass: EvidenceClass): boolean {
  return evidenceClass === 'confirmatory-pilot' || evidenceClass === 'public-release';
}

/**
 * RELEASE-002. The publication predicate. Historical artifacts stay visible
 * because they are already published, but they may not create a NEW result —
 * hence this is about minting a board, not about rendering one.
 */
export function canPublish(manifest: Pick<RunManifest, 'evidenceClass' | 'releaseState'>): boolean {
  return manifest.evidenceClass === 'public-release' && manifest.releaseState === 'released';
}

/** Surfaces built from these classes must carry NON_SCORING_LABEL. */
export function requiresNonScoringLabel(evidenceClass: EvidenceClass): boolean {
  return evidenceClass === 'legacy-shadow' || evidenceClass === 'development-probe';
}

/**
 * Guards the one field an author could otherwise set inconsistently.
 * `rankEligible` is a derived fact; letting it be asserted independently would
 * make a development run claim rank eligibility by typo.
 */
export function assertManifestCoherent(manifest: RunManifest): void {
  const expected = isRankEligible(manifest.evidenceClass);
  if (manifest.rankEligible !== expected) {
    throw new Error(
      `Manifest for ${manifest.runId} claims rankEligible=${manifest.rankEligible} but evidenceClass '${manifest.evidenceClass}' implies ${expected}.`,
    );
  }
  if (manifest.evidenceClass === 'historical' && manifest.releaseState !== 'released') {
    throw new Error(
      `Historical artifacts are already released; ${manifest.runId} claims releaseState '${manifest.releaseState}'.`,
    );
  }
  // Origin never upgrades eligibility: a rank-bearing run cannot be built from
  // synthetic or mock material.
  const nonEvidential = manifest.artifactOrigin.filter((o) => o === 'synthetic' || o === 'mock');
  if (expected && nonEvidential.length > 0) {
    throw new Error(
      `Run ${manifest.runId} is rank-eligible but has origin [${nonEvidential.join(', ')}]. Origin never upgrades eligibility.`,
    );
  }
}

/**
 * JUDGE-001. A judge conflicts with a candidate if they share EITHER the
 * provider or the underlying base-model family.
 *
 * Fails closed on missing identity: an unknown family is treated as a conflict
 * rather than as conflict-free, because the failure mode we care about is a
 * rebadged model quietly grading itself.
 */
export function hasJudgeConflict(
  judge: { provider?: string; baseModelFamily?: string },
  candidate: { provider?: string; baseModelFamily?: string },
): boolean {
  if (!judge.provider || !judge.baseModelFamily || !candidate.provider || !candidate.baseModelFamily) {
    return true;
  }
  return (
    judge.provider === candidate.provider || judge.baseModelFamily === candidate.baseModelFamily
  );
}
