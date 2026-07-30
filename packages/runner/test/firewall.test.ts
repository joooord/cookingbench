import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertManifestCoherent,
  canPublish,
  canonicalId,
  canonicalJson,
  hasJudgeConflict,
  isRankEligible,
  validatedRunManifestSchema,
} from '@cookingbench/core';
import { RUNS_DIR } from '../src/dataset.js';
import * as firewallModule from '../src/firewall.js';
import {
  Firewall,
  FirewallError,
  assertPublishable,
  assertSafePathComponent,
  assertWritablePath,
  isHistoricalRun,
  nonScoringBanner,
  readHistoricalRegistry,
  resolveRunDir,
  undeclaredPublishedRuns,
} from '../src/firewall.js';
import { writeResponse, writeScores } from '../src/store.js';

/**
 * WP-0 mandatory tests. Offline by construction: nothing here opens a socket,
 * reads a secret, or calls a model.
 */

const SCRATCH = '__test-firewall-scratch';

afterEach(() => {
  rmSync(join(RUNS_DIR, SCRATCH), { recursive: true, force: true });
});

describe('DATA-001 — historical artifacts cannot be overwritten', () => {
  it('refuses writes to every published run id', () => {
    for (const runId of ['2026-06-v1', '2026-06-v2', '2026-07-v2.1', 'canary', 'canary2', 'mock-run']) {
      expect(isHistoricalRun(runId)).toBe(true);
      expect(() => resolveRunDir(runId, { write: true })).toThrow(FirewallError);
      try {
        resolveRunDir(runId, { write: true });
      } catch (e) {
        expect((e as FirewallError).code).toBe('HISTORICAL_WRITE');
      }
    }
  });

  it('still allows historical reads, which the pipeline depends on', () => {
    expect(() => resolveRunDir('2026-07-v2.1', { write: false })).not.toThrow();
  });

  it('blocks the real writers, not just the resolver', () => {
    expect(() => writeScores('2026-07-v2.1', [])).toThrow(FirewallError);
    expect(() =>
      writeResponse({
        runId: '2026-07-v2.1',
        modelId: 'anthropic/claude-opus-5',
        questionId: 'conv-001',
        answerText: 'overwritten',
        raw: {},
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: 0,
      }),
    ).toThrow(FirewallError);
  });

  it('leaves the published artifact byte-identical after a refused write', () => {
    const path = join(RUNS_DIR, '2026-07-v2.1', 'scores.json');
    const before = readFileSync(path);
    expect(() => writeScores('2026-07-v2.1', [])).toThrow();
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  it('fails closed when the registry is absent', () => {
    // A fresh checkout without data/historical-runs.json must not silently
    // permit overwrites; every existing run directory is treated as frozen.
    const frozen = readHistoricalRegistry(join(RUNS_DIR, '..', 'no-such-registry.json'));
    expect(frozen.has('2026-07-v2.1')).toBe(true);
    expect(frozen.has('2026-06-v2')).toBe(true);
  });

  it('refuses to operate on a malformed or unparseable registry', () => {
    // The first cut did `parsed.runIds ?? []`, so a malformed registry produced
    // an EMPTY frozen set and permitted writes to every published run — the
    // exact inverse of failing closed.
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    const bad = join(RUNS_DIR, SCRATCH, 'registry.json');
    for (const contents of ['{ not json', '{}', '{"runIds": "2026-07-v2.1"}', '[]', 'null', '{"runIds": [""]}']) {
      writeFileSync(bad, contents);
      expect(() => readHistoricalRegistry(bad)).toThrow(FirewallError);
    }
    // Only a well-formed registry is accepted.
    writeFileSync(bad, JSON.stringify({ runIds: ['a-run'] }));
    expect(readHistoricalRegistry(bad)).toEqual(new Set(['a-run']));
  });

  it('has no exported switch that can disable the guard', () => {
    // A guard with an off switch in its own public API is not a guard.
    const api = firewallModule as Record<string, unknown>;
    expect(Object.keys(api).some((k) => k.startsWith('__'))).toBe(false);
  });

  it('declares every run that has published a board', () => {
    // Guards registry omission without freezing in-progress runs.
    expect(undeclaredPublishedRuns()).toEqual([]);
  });
});

describe('path confinement — the traversal that WP-0 closed', () => {
  // `join(RUNS_DIR, '../..')` is the repo root, and store.ts used recursive
  // mkdir, so an unvalidated --run-id could plant artifacts anywhere writable.
  const escapes = [
    '../..',
    '../../apps/web/public',
    '../../../tmp/evil',
    'a/../../..',
    './2026-07-v2.1',
    '',
    '.',
    '..',
    '-rf', // an id that reads as a flag
    '.hidden', // a leading dot creates a hidden directory
    'run/../../..', // traversal after a legitimate-looking prefix
    'a'.repeat(65), // over the length bound
  ];

  it.each(escapes)('refuses run id %j', (runId) => {
    expect(() => resolveRunDir(runId, { write: true })).toThrow(FirewallError);
  });

  it('refuses traversal on read as well as write', () => {
    expect(() => resolveRunDir('../..', { write: false })).toThrow(FirewallError);
  });

  it('admits a legitimate new run id', () => {
    expect(resolveRunDir('2026-08-v2.2', { write: true })).toBe(join(RUNS_DIR, '2026-08-v2.2'));
  });

  it('guards arbitrary paths that resolve into a frozen run', () => {
    expect(() => assertWritablePath(join(RUNS_DIR, '2026-07-v2.1', 'anything.json'))).toThrow(
      FirewallError,
    );
    expect(() => assertWritablePath(join(RUNS_DIR, SCRATCH, 'ok.json'))).not.toThrow();
  });
});

describe('RUN-001 — deny by default', () => {
  it('grants nothing without a permit', () => {
    const fw = Firewall.denyAll();
    expect(fw.permitId).toBeNull();
    expect(fw.budgetCapUsd).toBe(0);
    for (const cap of ['candidate-inference', 'judge-inference', 'publication', 'live-db-write'] as const) {
      expect(fw.has(cap)).toBe(false);
      expect(() => fw.requireCapability(cap, 'test')).toThrow(FirewallError);
    }
  });

  it('grants only what the permit names', () => {
    const fw = Firewall.fromVerifiedPermit({
      permitId: 'p-1',
      kind: 'legacy-shadow',
      capabilities: ['judge-inference'],
      cells: [],
      budgetCapUsd: 30,
    });
    expect(() => fw.requireCapability('judge-inference', 'shadow')).not.toThrow();
    // Shadow cannot call candidates — mandatory test 2.
    expect(() => fw.requireCapability('candidate-inference', 'shadow')).toThrow(FirewallError);
    expect(() => fw.requireCapability('publication', 'shadow')).toThrow(FirewallError);
  });

  it('authorises inference per cell, and an empty cell list authorises nothing', () => {
    const fw = Firewall.fromVerifiedPermit({
      permitId: 'p-2',
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: 'openai/gpt-5.5', questionId: 'conv-001' }],
      budgetCapUsd: 5,
    });
    expect(() => fw.requireCell('openai/gpt-5.5', 'conv-001', 'probe')).not.toThrow();
    expect(() => fw.requireCell('openai/gpt-5.5', 'conv-002', 'probe')).toThrow(FirewallError);
    expect(() => fw.requireCell('anthropic/claude-opus-5', 'conv-001', 'probe')).toThrow(FirewallError);

    const empty = Firewall.fromVerifiedPermit({
      permitId: 'p-3',
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [],
      budgetCapUsd: 5,
    });
    expect(() => empty.requireCell('openai/gpt-5.5', 'conv-001', 'probe')).toThrow(FirewallError);
  });

  it('does not confuse cells whose concatenation collides', () => {
    const fw = Firewall.fromVerifiedPermit({
      permitId: 'p-4',
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: 'ab', questionId: 'c' }],
      budgetCapUsd: 1,
    });
    expect(() => fw.requireCell('ab', 'c', 'probe')).not.toThrow();
    expect(() => fw.requireCell('a', 'bc', 'probe')).toThrow(FirewallError);
  });
});

describe('RELEASE-002 — publication eligibility', () => {
  const classes = [
    'historical',
    'legacy-shadow',
    'development',
    'development-probe',
    'confirmatory-pilot',
    'public-release',
  ] as const;

  it('permits publication only from an approved public-release manifest', () => {
    for (const evidenceClass of classes) {
      const eligible = evidenceClass === 'public-release';
      expect(canPublish({ evidenceClass, releaseState: 'released' })).toBe(eligible);
      // Even the right class fails in the wrong lifecycle state.
      expect(canPublish({ evidenceClass, releaseState: 'draft' })).toBe(false);
      expect(canPublish({ evidenceClass, releaseState: 'quarantined' })).toBe(false);
    }
  });

  it('fails closed with a clear error for every ineligible class', () => {
    for (const evidenceClass of classes.filter((c) => c !== 'public-release')) {
      expect(() =>
        assertPublishable({ runId: 'r', evidenceClass, releaseState: 'released' }, 'sync'),
      ).toThrow(FirewallError);
    }
  });

  it('marks shadow and probe surfaces non-scoring', () => {
    expect(nonScoringBanner('legacy-shadow')).toBe('NON-SCORING — NOT FOR LEADERBOARD');
    expect(nonScoringBanner('development-probe')).toBe('NON-SCORING — NOT FOR LEADERBOARD');
    expect(nonScoringBanner('public-release')).toBeNull();
    expect(nonScoringBanner('historical')).toBeNull();
  });

  it('keeps rank eligibility tied to evidence class', () => {
    expect(isRankEligible('confirmatory-pilot')).toBe(true);
    expect(isRankEligible('public-release')).toBe(true);
    for (const c of ['historical', 'legacy-shadow', 'development', 'development-probe'] as const) {
      expect(isRankEligible(c)).toBe(false);
    }
  });
});

describe('RELEASE-001 — origin never upgrades eligibility', () => {
  const base = {
    manifestVersion: 1 as const,
    runId: 'r-1',
    methodologyVersion: 'v3.0',
    schemaVersion: '1',
    gitCommit: '980dfcb',
    parentArtifacts: [],
    evidenceClass: 'confirmatory-pilot' as const,
    artifactOrigin: ['live-provider' as const],
    releaseState: 'draft' as const,
    rankEligible: true,
    bankHash: 'a'.repeat(64),
    promptHash: 'b'.repeat(64),
    judgePromptHash: 'c'.repeat(64),
    validatorHash: 'd'.repeat(64),
    candidateRoutes: [],
    judgeRoutes: [],
    generationSettings: {
      temperature: 0,
      maxTokens: 16000,
      maxTokensRecipe: 32000,
      repeats: 1,
      repeatPolicy: 'single' as const,
    },
    callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
    budgetCapUsd: 10,
    outputRoot: 'data/runs/r-1',
  };

  it('accepts a coherent manifest', () => {
    expect(() => assertManifestCoherent(base)).not.toThrow();
  });

  it('rejects a rank-eligible manifest built from synthetic or mock material', () => {
    expect(() =>
      assertManifestCoherent({ ...base, artifactOrigin: ['synthetic'] }),
    ).toThrow(/never upgrades eligibility/);
    expect(() =>
      assertManifestCoherent({ ...base, artifactOrigin: ['live-provider', 'mock'] }),
    ).toThrow(/never upgrades eligibility/);
  });

  it('rejects a manifest that asserts rank eligibility its class does not carry', () => {
    expect(() =>
      assertManifestCoherent({ ...base, evidenceClass: 'development', rankEligible: true }),
    ).toThrow(/implies false/);
    expect(() =>
      assertManifestCoherent({ ...base, evidenceClass: 'public-release', rankEligible: false }),
    ).toThrow(/implies true/);
  });
});

describe('JUDGE-001 — conflict covers provider and base-model family', () => {
  const anthropic = { provider: 'Anthropic', baseModelFamily: 'claude' };
  const openai = { provider: 'OpenAI', baseModelFamily: 'gpt' };

  it('detects a same-provider conflict', () => {
    expect(hasJudgeConflict(anthropic, { ...anthropic })).toBe(true);
  });

  it('detects a shared base model behind different providers', () => {
    // The case a provider-only check misses: a reseller rebadging a base model
    // would otherwise be treated as an independent seat grading its own family.
    expect(
      hasJudgeConflict({ provider: 'Reseller', baseModelFamily: 'claude' }, anthropic),
    ).toBe(true);
  });

  it('allows a genuinely independent seat', () => {
    expect(hasJudgeConflict(openai, anthropic)).toBe(false);
  });

  it('fails closed when family identity is missing', () => {
    expect(hasJudgeConflict({ provider: 'OpenAI' }, anthropic)).toBe(true);
    expect(hasJudgeConflict(openai, { provider: 'Anthropic' })).toBe(true);
    expect(hasJudgeConflict({}, {})).toBe(true);
  });
});

describe('offline guarantee', () => {
  it('runs with no API key present', () => {
    // The suite must pass in CI with no secrets — mandatory test 12. Nothing in
    // this file constructs a network client, so the key is irrelevant here and
    // this asserts we have not accidentally introduced a dependency on one.
    const saved = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      expect(() => resolveRunDir('2026-07-v2.1', { write: true })).toThrow(FirewallError);
      expect(Firewall.denyAll().has('candidate-inference')).toBe(false);
    } finally {
      if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved;
    }
  });
});

describe('filesystem boundary, not just lexical paths', () => {
  it('rejects a run directory that is a symlink out of RUNS_DIR', () => {
    // resolve() never touches the disk, so a link planted at data/runs/<id>
    // satisfies every lexical check while writing somewhere else entirely.
    const linkName = `${SCRATCH}-link`;
    const link = join(RUNS_DIR, linkName);
    rmSync(link, { recursive: true, force: true });
    symlinkSync(tmpdir(), link);
    try {
      expect(() => resolveRunDir(linkName, { write: true })).toThrow(FirewallError);
      try {
        resolveRunDir(linkName, { write: true });
      } catch (e) {
        expect((e as FirewallError).code).toBe('SYMLINK_ESCAPE');
      }
    } finally {
      rmSync(link, { recursive: true, force: true });
    }
  });

  it('allows a real directory inside RUNS_DIR', () => {
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    expect(() => resolveRunDir(SCRATCH, { write: true })).not.toThrow();
  });
});

describe('filename components are validated at the writer boundary', () => {
  it.each(['', '.', '..', 'a/b', 'a\\b', 'x'.repeat(129)])('rejects %j', (bad) => {
    expect(() => assertSafePathComponent(bad, 'question id')).toThrow(FirewallError);
  });

  it('accepts a normal question id', () => {
    expect(assertSafePathComponent('conv-001', 'question id')).toBe('conv-001');
  });

  it('refuses a traversing question id through the real writer', () => {
    // The CLI schema constrains question ids today, but shared enforcement must
    // not depend on an upstream caller remembering to validate.
    expect(() =>
      writeResponse({
        runId: SCRATCH,
        modelId: 'openai/gpt-5.5',
        questionId: '../../../etc/passwd',
        answerText: 'x',
        raw: {},
        tokensIn: 0,
        tokensOut: 0,
        costUsd: 0,
        latencyMs: 0,
      }),
    ).toThrow(FirewallError);
  });
});

describe('JUDGE-001 identity is case-folded', () => {
  it('treats display-case variants as the same identity', () => {
    // Free-text provider labels would otherwise make "Anthropic" and
    // "anthropic" look like independent seats.
    expect(
      hasJudgeConflict(
        { provider: 'anthropic', baseModelFamily: 'CLAUDE' },
        { provider: ' Anthropic ', baseModelFamily: 'claude' },
      ),
    ).toBe(true);
    expect(canonicalId(' Anthropic ')).toBe('anthropic');
  });
});

describe('DATA-002 — coherence is enforced at parse, not by an optional call', () => {
  const ok = {
    manifestVersion: 1,
    runId: 'r-1',
    methodologyVersion: 'v3.0',
    schemaVersion: '1',
    gitCommit: '980dfcb',
    parentArtifacts: [],
    evidenceClass: 'development',
    artifactOrigin: ['synthetic'],
    releaseState: 'draft',
    rankEligible: false,
    bankHash: 'a'.repeat(64),
    promptHash: 'b'.repeat(64),
    judgePromptHash: 'c'.repeat(64),
    validatorHash: 'd'.repeat(64),
    candidateRoutes: [],
    judgeRoutes: [],
    generationSettings: {
      temperature: 0,
      maxTokens: 16000,
      maxTokensRecipe: 32000,
      repeats: 1,
      repeatPolicy: 'single',
    },
    callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
    budgetCapUsd: 10,
    outputRoot: 'data/runs/r-1',
  };

  it('accepts a coherent manifest', () => {
    expect(validatedRunManifestSchema.safeParse(ok).success).toBe(true);
  });

  it('rejects an incoherent rankEligible at parse time', () => {
    expect(validatedRunManifestSchema.safeParse({ ...ok, rankEligible: true }).success).toBe(false);
  });

  it('rejects a rank-eligible manifest built from mock material at parse time', () => {
    const cheat = { ...ok, evidenceClass: 'public-release', releaseState: 'released', rankEligible: true };
    expect(validatedRunManifestSchema.safeParse(cheat).success).toBe(false);
  });

  it('rejects an outputRoot that could escape', () => {
    for (const outputRoot of ['../../etc', '/etc/passwd', 'data/runs/../../x']) {
      expect(validatedRunManifestSchema.safeParse({ ...ok, outputRoot }).success).toBe(false);
    }
  });

  it('hashes deterministically regardless of key order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});
