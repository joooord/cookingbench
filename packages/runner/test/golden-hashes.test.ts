import { describe, expect, it } from 'vitest';
import { canonicalJson } from '@cookingbench/core';
import { manifestHash, sha256Hex } from '../src/permit.js';

/**
 * TRACE-001 — golden hashes for the canonical forms a signature covers.
 *
 * These digests are not tested for their own sake. A permit's authority comes
 * from an Ed25519 signature over `canonicalJson(permit)` and from a binding to
 * `manifestHash(manifest)`, so anything that changes either canonical form —
 * a reordered key, a new schema default, a tweak to the walk in `canonicalJson`
 * — silently invalidates every permit already issued, and does so at the worst
 * possible moment: when someone tries to use one.
 *
 * If a change here is deliberate, update the constant AND re-issue the permits.
 * Both, in that order. A failing digest is the system telling you that the
 * approvals on file no longer verify, which is a release event, not a lint.
 *
 * Offline: pure arithmetic over literals.
 */

const GOLDEN_MANIFEST_V1 = {
  manifestVersion: 1,
  runId: 'golden-1',
  methodologyVersion: 'v3.0',
  schemaVersion: '1',
  gitCommit: '980dfcb',
  parentArtifacts: [],
  evidenceClass: 'legacy-shadow',
  artifactOrigin: ['archived'],
  releaseState: 'draft',
  rankEligible: false,
  bankHash: 'a'.repeat(64),
  promptHash: 'b'.repeat(64),
  judgePromptHash: 'c'.repeat(64),
  validatorHash: 'd'.repeat(64),
  candidateRoutes: [{ modelId: 'openai/gpt-5.5', provider: 'openai', baseModelFamily: 'gpt-frontier' }],
  judgeRoutes: [{ modelId: 'x-ai/grok-4.5', provider: 'xai', baseModelFamily: 'grok-frontier' }],
  generationSettings: {
    temperature: 0,
    maxTokens: 16000,
    maxTokensRecipe: 32000,
    repeats: 1,
    repeatPolicy: 'single',
  },
  callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
  budgetCapUsd: 40,
  outputRoot: 'data/runs/golden-1',
};

const GOLDEN_MANIFEST = {
  ...GOLDEN_MANIFEST_V1,
  manifestVersion: 2,
  gitCommit: '980dfcb5e3ff920fe1a3231121a6115e3fa48dcb',
  methodologyHash: 'e'.repeat(64),
  traceabilityVersion: 'f'.repeat(64),
};

const GOLDEN_PERMIT = {
  permitVersion: 1,
  permitId: 'permit-golden-0001',
  kind: 'legacy-shadow',
  manifestHash: 'eb1366ae2cffd7dbce63e7d7fde1d5b2d860df25cd583a96dc915d56b9048a9f',
  methodologyHash: 'a7536af86893a477938b8f055b56324be1af9de9b16f7efd51f47bbfb5f79ec7',
  capabilities: ['judge-inference'],
  cells: [{ modelId: 'x-ai/grok-4.5', questionId: 'flav-002' }],
  budgetCapUsd: 30,
  reservationScope: 'call',
  issuer: 'claude',
  approver: 'jordan',
  approvalEvidence: 'golden fixture',
  notBefore: '2026-07-01T00:00:00Z',
  notAfter: '2026-08-01T00:00:00Z',
  executionLimit: 1,
};

const MANIFEST_V1_DIGEST = 'b76aa27b0d5dcbc653407d928b60b4794a417a4ec51b3d4478fc8828ac7702f6';
const MANIFEST_DIGEST = 'eb1366ae2cffd7dbce63e7d7fde1d5b2d860df25cd583a96dc915d56b9048a9f';
const PERMIT_DIGEST = '61d44f7ff84fb0aef1b1acacfae5656db1845508515dcd6768ad0d48a70f85c8';

describe('the canonical forms a signature covers are frozen', () => {
  it('keeps the historical v1 manifest canonical identity stable', () => {
    expect(manifestHash(GOLDEN_MANIFEST_V1)).toBe(MANIFEST_V1_DIGEST);
  });

  it('hashes the golden manifest to its recorded digest', () => {
    expect(manifestHash(GOLDEN_MANIFEST)).toBe(MANIFEST_DIGEST);
  });

  it('hashes the golden permit body to its recorded digest', () => {
    expect(sha256Hex(canonicalJson(GOLDEN_PERMIT))).toBe(PERMIT_DIGEST);
  });

  it('is independent of key order, at every depth', () => {
    const shuffle = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(shuffle)
        : v && typeof v === 'object'
          ? Object.fromEntries(
              Object.entries(v as Record<string, unknown>)
                .reverse()
                .map(([k, x]) => [k, shuffle(x)]),
            )
          : v;
    expect(manifestHash(shuffle(GOLDEN_MANIFEST))).toBe(MANIFEST_DIGEST);
    expect(sha256Hex(canonicalJson(shuffle(GOLDEN_PERMIT)))).toBe(PERMIT_DIGEST);
  });

  it('is sensitive to every field it claims to cover', () => {
    // A canonicalisation that dropped a field would produce a stable digest
    // that fails to bind it, which is worse than an unstable one.
    for (const key of Object.keys(GOLDEN_PERMIT)) {
      const mutated: Record<string, unknown> = { ...GOLDEN_PERMIT };
      const value = mutated[key];
      mutated[key] =
        typeof value === 'number' ? value + 1 : typeof value === 'string' ? `${value}!` : ['mutated'];
      expect(sha256Hex(canonicalJson(mutated)), `permit.${key} is outside the signature`).not.toBe(
        PERMIT_DIGEST,
      );
    }
    // Several manifest fields are constrained enums or bounded arrays, so a
    // single blunt mutation is either rejected by the schema or — for an array
    // that was already empty — no mutation at all. Each field gets a few
    // candidates and has to fail on at least one that the schema accepts.
    //
    // Nested objects are mutated through a field the SCHEMA knows about, not by
    // bolting an unknown key on. `manifestHash` parses before hashing, and zod
    // strips unknown keys — so `{...generationSettings, changed: true}` hashes
    // identically to the original. That is the intended behaviour (the envelope
    // is defined by its schema, which is what makes two equivalent
    // serialisations agree), but it does mean an extra key is not covered, and
    // a mutation test that relied on one would prove nothing.
    const candidatesFor = (value: unknown): unknown[] => {
      if (typeof value === 'number') return [value + 1];
      if (typeof value === 'string') return [`${value}-x`];
      if (typeof value === 'boolean') return [!value];
      if (Array.isArray(value)) return [[], ['golden-mutant'], [...value, ...value], value.slice(1)];
      const entries = Object.entries(value as Record<string, unknown>);
      return entries.flatMap(([k, v]) =>
        candidatesFor(v).map((mutated) => ({ ...(value as object), [k]: mutated })),
      );
    };

    // Format-constrained fields need a candidate that is DIFFERENT but still
    // legal — `${value}-x` breaks a 64-hex digest or a closed enum, so the
    // schema refuses it and the field never gets varied at all.
    const LEGAL_ALTERNATIVES: Record<string, unknown[]> = {
      manifestVersion: [1],
      gitCommit: ['0'.repeat(40)],
      evidenceClass: ['development'], // still rankEligible:false, so still coherent
      releaseState: ['audited'],
      methodologyHash: ['0'.repeat(64)],
      traceabilityVersion: ['0'.repeat(64)],
      bankHash: ['0'.repeat(64)],
      promptHash: ['0'.repeat(64)],
      judgePromptHash: ['0'.repeat(64)],
      validatorHash: ['0'.repeat(64)],
    };

    const schemaPinned: string[] = [];
    for (const key of Object.keys(GOLDEN_MANIFEST)) {
      if (key === 'runId' || key === 'outputRoot') continue; // bound to each other; covered below
      const original = (GOLDEN_MANIFEST as Record<string, unknown>)[key];
      let accepted = 0;
      for (const candidate of [...candidatesFor(original), ...(LEGAL_ALTERNATIVES[key] ?? [])]) {
        if (JSON.stringify(candidate) === JSON.stringify(original)) continue;
        let digest: string;
        try {
          digest = manifestHash({ ...GOLDEN_MANIFEST, [key]: candidate });
        } catch {
          continue; // the schema refused it outright, which is stronger still
        }
        accepted++;
        expect(digest, `manifest.${key} is outside the hash`).not.toBe(MANIFEST_DIGEST);
      }
      // If every candidate was refused, the field is pinned by the schema
      // rather than by the digest. That is fine — but it has to be a KNOWN
      // case, or the test silently passes on a field it never varied.
      if (accepted === 0) schemaPinned.push(key);
    }
    // `rankEligible` is derived from `evidenceClass`, so flipping it produces
    // an incoherent manifest the schema refuses outright. It is pinned harder
    // than hashing can pin it. Anything else appearing here means a field
    // stopped being varied and needs a look.
    expect(schemaPinned).toEqual(['rankEligible']);
    expect(
      manifestHash({ ...GOLDEN_MANIFEST, runId: 'golden-2', outputRoot: 'data/runs/golden-2' }),
    ).not.toBe(MANIFEST_DIGEST);
  });
});
