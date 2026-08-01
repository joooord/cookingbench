import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunConfig, StoredResponse } from '@cookingbench/core';
import { RUNS_DIR, loadQuestions } from '../src/dataset.js';
import { FirewallError } from '../src/firewall.js';
import { buildRunManifest, writeRunManifest } from '../src/manifest.js';
import {
  ProtocolViolationError,
  attemptChargesUsd,
  beginAttempt,
  type BoundRunConfig,
  mergeRunConfig,
  readAttempts,
  readResponses,
  readRunConfig,
  retryIdFor,
  settleAttempt,
  writeResponse,
  writeRunConfig,
} from '../src/store.js';

/**
 * RUN-002 — protocol consistency.
 *
 * Every negative here goes through a REAL production writer. `bench run` calls
 * `mergeRunConfig`; `bench judge` calls `writeRunConfig` on a config it has just
 * mutated. There is no test-only seam into the gate, on purpose: a guard that
 * can only be reached from a test proves nothing about the path an operator
 * actually takes, and the second writer is exactly the one a check bolted onto
 * the merge function alone would have missed.
 *
 * Scratch runs live under data/runs because that is where store.ts writes. They
 * are namespaced `__test-protocol…`, never carry a leaderboard.json (so a leaked
 * directory cannot reach the site) and are removed after every test.
 */

const PREFIX = '__test-protocol';
let seq = 0;
function scratchRun(): string {
  seq += 1;
  return `${PREFIX}-${process.pid}-${seq}`;
}

afterEach(() => {
  if (!existsSync(RUNS_DIR)) return;
  for (const dir of readdirSync(RUNS_DIR).filter((d) => d.startsWith(PREFIX))) {
    rmSync(join(RUNS_DIR, dir), { recursive: true, force: true });
  }
});

const CAPS = { maxTokens: 16000, maxTokensRecipe: 32000 };

function seedAttemptManifest(runId: string): void {
  const questions = loadQuestions();
  const { manifest } = buildRunManifest(
    {
      manifestVersion: 1,
      runId,
      methodologyVersion: 'v3.0',
      schemaVersion: '1',
      parentArtifacts: [],
      evidenceClass: 'development',
      artifactOrigin: ['agent-authored'],
      releaseState: 'draft',
      rankEligible: false,
      candidateRoutes: [
        { modelId: 'a/one', provider: 'a', baseModelFamily: 'a-one' },
        { modelId: 'openai/gpt-5.5', provider: 'openai', baseModelFamily: 'gpt-frontier' },
        { modelId: 'x-ai/grok-4.5', provider: 'xai', baseModelFamily: 'grok-frontier' },
      ],
      judgeRoutes: [
        { modelId: 'anthropic/claude-opus-4.8', provider: 'anthropic', baseModelFamily: 'claude-opus' },
      ],
      generationSettings: {
        temperature: 0,
        maxTokens: CAPS.maxTokens,
        maxTokensRecipe: CAPS.maxTokensRecipe,
        repeats: 1,
        repeatPolicy: 'single',
      },
      callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
      budgetCapUsd: 10,
    },
    questions,
  );
  writeRunManifest(runId, manifest, questions);
}

function manifestedRun(): string {
  const runId = scratchRun();
  seedAttemptManifest(runId);
  return runId;
}

function batchConfig(runId: string, models: string[], overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId,
    models,
    temperature: 0,
    maxTokens: CAPS.maxTokens,
    maxTokensRecipe: CAPS.maxTokensRecipe,
    budgetUsdTotal: 10,
    budgetUsdPerModel: 4,
    concurrency: 4,
    judgeModel: 'panel-v1',
    judgePanel: ['anthropic/claude-opus-4.8', 'x-ai/grok-4.5'],
    judgePromptVersion: 'judge-v2',
    methodologyVersion: 'v2',
    mock: false,
    batches: [
      {
        startedAt: '2026-07-29T00:00:00Z',
        models,
        maxTokens: CAPS.maxTokens,
        maxTokensRecipe: CAPS.maxTokensRecipe,
        budgetUsdTotal: 10,
      },
    ],
    ...overrides,
  };
}

/** A second batch, distinct from the first in nothing but its models and clock. */
function secondBatch(runId: string, overrides: Partial<RunConfig> = {}): RunConfig {
  return batchConfig(runId, ['b/two'], {
    batches: [
      {
        startedAt: '2026-07-29T02:00:00Z',
        models: ['b/two'],
        maxTokens: CAPS.maxTokens,
        maxTokensRecipe: CAPS.maxTokensRecipe,
        budgetUsdTotal: 10,
      },
    ],
    ...overrides,
  });
}

/** Rewrite the stored config, so a test can simulate what an earlier batch recorded. */
function patchStoredConfig(runId: string, mutate: (config: BoundRunConfig) => void): void {
  const config = readRunConfig(runId);
  mutate(config);
  writeFileSync(join(RUNS_DIR, runId, 'config.json'), JSON.stringify(config, null, 2));
}

function expectProtocolRefusal(fn: () => unknown, matching: RegExp): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ProtocolViolationError);
    expect((e as ProtocolViolationError).code).toBe('PROTOCOL_CHANGED');
    expect((e as Error).message).toMatch(matching);
    return;
  }
  throw new Error('expected the resume to be refused');
}

// ---------------------------------------------------------------------------

describe('RUN-002 — a changed rank-affecting setting fails rather than warns', () => {
  // One case per rank-affecting field the config actually carries. Before this
  // work, the first four of these printed "⚠ … changed within run …" and merged
  // anyway, so one run id could hold two protocols and publish one board over
  // both.
  const changes: Array<[string, Partial<RunConfig>, RegExp]> = [
    ['temperature', { temperature: 0.7 }, /temperature/],
    ['maxTokens', { maxTokens: 8000 }, /maxTokens/],
    ['maxTokensRecipe', { maxTokensRecipe: 64000 }, /maxTokensRecipe/],
    ['judgeModel', { judgeModel: 'panel-v2' }, /judgeModel/],
    ['judgePanel', { judgePanel: ['openai/gpt-5.5'] }, /judgePanel/],
    ['judgePromptVersion', { judgePromptVersion: 'judge-v3' }, /judgePromptVersion/],
    ['methodologyVersion', { methodologyVersion: 'v3' }, /methodologyVersion/],
    ['mock', { mock: true }, /mock/],
  ];

  it.each(changes)('refuses a resumed batch that changes %s', (_field, override, matching) => {
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    expectProtocolRefusal(() => mergeRunConfig(secondBatch(runId, override)), matching);
    // And nothing of the second batch survives: a refusal that had already
    // written half the config would leave the artifact describing a protocol
    // the run never agreed to.
    const stored = readRunConfig(runId);
    expect(stored.models).toEqual(['a/one']);
    expect(stored.batches).toHaveLength(1);
  });

  it('refuses a model route table that changes, and one that appears', () => {
    // `models` grows by design (per-model batching), but a ROUTE is rank
    // affecting. `modelRoutes` is a reserved name in the rank-affecting list, so
    // it is bound from the first commit that uses it rather than from whenever
    // someone remembers to classify it.
    const runId = scratchRun();
    mergeRunConfig(
      batchConfig(runId, ['a/one'], { modelRoutes: { 'a/one': 'a/one@2026-07' } } as Partial<RunConfig>),
    );
    expectProtocolRefusal(
      () =>
        mergeRunConfig(
          secondBatch(runId, { modelRoutes: { 'a/one': 'a/one@2026-08' } } as Partial<RunConfig>),
        ),
      /modelRoutes/,
    );
    // Dropping the pin entirely is also a change, not an absence.
    expectProtocolRefusal(() => mergeRunConfig(secondBatch(runId)), /modelRoutes/);
  });

  it('treats a field this build has never seen as rank-affecting', () => {
    // The failure mode being designed against is somebody adding a config field
    // and forgetting to classify it. An allow-list of ignorable fields fails
    // CLOSED when it is out of date; a deny-list of rank-affecting ones fails
    // open in the very same circumstance.
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    expectProtocolRefusal(
      () => mergeRunConfig(secondBatch(runId, { samplingTopP: 0.9 } as Partial<RunConfig>)),
      /samplingTopP/,
    );
  });

  it('refuses a rank-affecting field that disappears on resume', () => {
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    const next = secondBatch(runId) as Partial<RunConfig>;
    delete next.methodologyVersion;
    expectProtocolRefusal(() => mergeRunConfig(next as RunConfig), /methodologyVersion/);
  });

  it('refuses through the judge writer as well as the run writer', () => {
    // `bench judge` reassigns judgeModel/judgePanel/judgePromptVersion on the
    // stored config and calls writeRunConfig — a whole second production path
    // into the same artifact. Editing the judge prompt between running and
    // judging is the "mixed prompts" case RUN-002 names.
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    const stored = readRunConfig(runId);
    stored.judgePromptVersion = 'judge-v9';
    expectProtocolRefusal(() => writeRunConfig(stored), /judgePromptVersion/);
  });
});

describe('RUN-002 — a changed content hash fails rather than warns', () => {
  // Each case rewrites what the FIRST batch recorded, then resumes against the
  // real working tree — which is exactly the shape of "the bank/prompt/judge
  // prompt/grader moved between batch one and batch two", without touching the
  // committed dataset.
  const hashes: Array<[string, RegExp]> = [
    ['bankHash', /question bank/],
    ['promptHash', /candidate prompts/],
    ['judgePromptHash', /judge prompt/],
    ['validatorHash', /grader\/scoring source/],
  ];

  it.each(hashes)('refuses a resumed batch whose %s has moved', (field, matching) => {
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    patchStoredConfig(runId, (config) => {
      const content = config.protocol?.content as Record<string, string>;
      content[field] = 'f'.repeat(64);
    });
    expectProtocolRefusal(() => mergeRunConfig(secondBatch(runId)), matching);
  });

  it('refuses a run whose manifest changed or vanished', () => {
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    patchStoredConfig(runId, (config) => {
      // The first batch ran under a manifest; the run now has none.
      (config.protocol as { content: { manifestHash: string | null } }).content.manifestHash =
        'a'.repeat(64);
    });
    expectProtocolRefusal(() => mergeRunConfig(secondBatch(runId)), /run manifest/);
  });

  it('accepts a manifest appearing on a previously unmanifested run', () => {
    // The single permissive carve-out, and therefore the one that must be
    // tested: nothing was declared before, so nothing has been contradicted.
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    expect(readRunConfig(runId).protocol?.content.manifestHash).toBeNull();

    seedAttemptManifest(runId);

    expect(() => mergeRunConfig(secondBatch(runId))).not.toThrow();
    const stored = readRunConfig(runId);
    // The run's declared protocol stays frozen at the first batch, while the
    // batch that ran under the manifest records it.
    expect(stored.protocol?.content.manifestHash).toBeNull();
    expect(stored.batches?.[1]?.protocol.content.manifestHash).toMatch(/^[a-f0-9]{64}$/);

    // …and once declared, it is fixed.
    patchStoredConfig(runId, (config) => {
      (config.protocol as { content: { manifestHash: string | null } }).content.manifestHash =
        'b'.repeat(64);
    });
    expectProtocolRefusal(
      () => mergeRunConfig(batchConfig(runId, ['c/three'], { batches: [
        { startedAt: '2026-07-29T03:00:00Z', models: ['c/three'], ...CAPS, budgetUsdTotal: 1 },
      ] })),
      /run manifest/,
    );
  });

  it('refuses bindings that disagree in a way it cannot itemise', () => {
    // The field-by-field diff is the explanation; the hash is the authority. If
    // the binding shape ever gains a field the diff does not enumerate, or a
    // stored binding is edited by hand, the comparison has NOT proved sameness
    // and must refuse rather than shrug.
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    patchStoredConfig(runId, (config) => {
      (config.protocol as { protocolHash: string }).protocolHash = 'd'.repeat(64);
    });
    expectProtocolRefusal(() => mergeRunConfig(secondBatch(runId)), /protocolHash/);
  });
});

describe('RUN-002 — an identical protocol resumes cleanly', () => {
  it('accepts a second batch under the same protocol and unions the models', () => {
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    const merged = mergeRunConfig(secondBatch(runId));
    expect(merged.models).toEqual(['a/one', 'b/two']);
    expect(merged.batches).toHaveLength(2);
    expect(merged.budgetUsdTotal).toBe(20);
    expect(merged.protocol?.protocolHash).toBe(readRunConfig(runId).batches?.[0]?.protocol.protocolHash);
  });

  it('does not mistake a reordered judge panel for a different panel', () => {
    // Seat selection is by FNV-1a hash of the ids, not by position. A false
    // refusal here would be as damaging as a missed one: operators learn to
    // work around a gate that cries wolf.
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    expect(() =>
      mergeRunConfig(secondBatch(runId, { judgePanel: ['x-ai/grok-4.5', 'anthropic/claude-opus-4.8'] })),
    ).not.toThrow();
  });

  it('lets operational fields move, and never lets a per-model cap rise', () => {
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    const merged = mergeRunConfig(
      secondBatch(runId, { concurrency: 1, budgetUsdPerModel: 2, budgetUsdTotal: 3 }),
    );
    expect(merged.concurrency).toBe(1);
    expect(merged.budgetUsdPerModel).toBe(2);

    const raised = mergeRunConfig(
      batchConfig(runId, ['c/three'], {
        budgetUsdPerModel: 99,
        batches: [
          { startedAt: '2026-07-29T04:00:00Z', models: ['c/three'], ...CAPS, budgetUsdTotal: 1 },
        ],
      }),
    );
    expect(raised.budgetUsdPerModel).toBe(2);
  });
});

describe('RUN-002 — every batch is bound to what it ran under', () => {
  it('writes a binding per batch that survives a round trip', () => {
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    mergeRunConfig(secondBatch(runId));

    // Read from DISK, not from the returned object: the requirement is that the
    // artifact carries the trace, not that the function returned one.
    const raw = JSON.parse(
      readFileSync(join(RUNS_DIR, runId, 'config.json'), 'utf8'),
    ) as BoundRunConfig;
    expect(raw.batches).toHaveLength(2);
    for (const batch of raw.batches ?? []) {
      expect(batch.batchId).toMatch(/^bat_[a-f0-9]{32}$/);
      expect(batch.protocol.protocolHash).toMatch(/^[a-f0-9]{64}$/);
      expect(batch.protocol.source).toBe('working-tree');
      expect(batch.protocol.settings.methodologyVersion).toBe('v2');
      expect(batch.protocol.settings.temperature).toBe(0);
      for (const field of ['bankHash', 'promptHash', 'judgePromptHash', 'validatorHash'] as const) {
        expect(batch.protocol.content[field]).toMatch(/^[a-f0-9]{64}$/);
      }
    }
    expect(raw.batches?.[0]?.batchId).not.toBe(raw.batches?.[1]?.batchId);
  });

  it('does not append a second record for a replayed batch', () => {
    // The same invocation replayed — a crashed command re-run, a config handed
    // back to the merge — is the same batch. Appending it again would double the
    // authorised budget in the published artifact.
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    const merged = mergeRunConfig(batchConfig(runId, ['a/one']));
    expect(merged.batches).toHaveLength(1);
    expect(merged.budgetUsdTotal).toBe(10);
  });

  it('ignores a binding the caller attached to its own batch', () => {
    // A caller that can hand in its own binding chooses the standard it is
    // judged against. The binding is derived from the working tree here, and
    // only a binding already ON DISK for that batch is preserved.
    const runId = scratchRun();
    const forged = {
      protocolVersion: 1,
      settings: { methodologyVersion: 'anything-goes' },
      content: {
        bankHash: '0'.repeat(64),
        promptHash: '0'.repeat(64),
        judgePromptHash: '0'.repeat(64),
        validatorHash: '0'.repeat(64),
        manifestHash: null,
      },
      protocolHash: '0'.repeat(64),
      source: 'working-tree',
      boundAtIso: '2000-01-01T00:00:00Z',
    };
    const config = batchConfig(runId, ['a/one']);
    (config.batches?.[0] as unknown as Record<string, unknown>).protocol = forged;
    (config.batches?.[0] as unknown as Record<string, unknown>).batchId = 'bat_forged';

    const merged = mergeRunConfig(config);
    expect(merged.batches?.[0]?.protocol.protocolHash).not.toBe('0'.repeat(64));
    expect(merged.batches?.[0]?.protocol.content.bankHash).toMatch(/^[a-f0-9]{64}$/);
    expect(merged.batches?.[0]?.batchId).not.toBe('bat_forged');
    expect(merged.batches?.[0]?.protocol.settings.methodologyVersion).toBe('v2');
  });

  it('marks a binding it had to infer as inference, not as evidence', () => {
    // A config written before bindings existed cannot say what it hashed to.
    // Recording today's hashes as though they had been measured then would be a
    // fabricated audit trail.
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    patchStoredConfig(runId, (config) => {
      delete config.protocol;
      delete config.batches;
    });
    const merged = mergeRunConfig(secondBatch(runId));
    expect(merged.batches?.[0]?.protocol.source).toBe('reconstructed');
    expect(merged.batches?.[0]?.startedAt).toBe('unknown');
    expect(merged.batches?.[1]?.protocol.source).toBe('working-tree');
    expect(merged.models).toEqual(['a/one', 'b/two']);
  });

  it('still refuses a legacy config whose settings differ', () => {
    // Reconstruction must not become an amnesty: the settings a legacy config
    // does carry are real evidence and are compared strictly.
    const runId = scratchRun();
    mergeRunConfig(batchConfig(runId, ['a/one']));
    patchStoredConfig(runId, (config) => {
      delete config.protocol;
      delete config.batches;
    });
    expectProtocolRefusal(() => mergeRunConfig(secondBatch(runId, { temperature: 1 })), /temperature/);
  });
});

describe('RUN-002 — attempt ids are derived, never counted', () => {
  const coord = {
    runId: 'r',
    modelId: 'openai/gpt-5.5',
    questionId: 'conv-001',
    cause: 'empty-response',
  } as const;

  it('derives the same id for the same coordinate every time', () => {
    // Pure: no state is read, so a crashed-and-resumed process lands on the same
    // id as the process it replaced. A counter cannot promise that.
    expect(retryIdFor(coord)).toBe(retryIdFor({ ...coord }));
    expect(retryIdFor(coord)).toMatch(/^atr_[a-f0-9]{40}$/);
  });

  it('separates every coordinate it is supposed to separate', () => {
    const ids = new Set([
      retryIdFor(coord),
      retryIdFor({ ...coord, runId: 'r2' }),
      retryIdFor({ ...coord, modelId: 'openai/gpt-5.6' }),
      retryIdFor({ ...coord, questionId: 'conv-002' }),
      retryIdFor({ ...coord, cause: 'empty-response-headroom' }),
      retryIdFor({ ...coord, cause: 'stored' }),
    ]);
    expect(ids.size).toBe(6);
  });

  it('refuses an unknown cause and an incomplete coordinate', () => {
    // An unrecognised cause would mint a fresh id — and therefore a second
    // answer and a second charge — for work already on the books.
    expect(() => retryIdFor({ ...coord, cause: 'retry-2' as never })).toThrow(ProtocolViolationError);
    expect(() => retryIdFor({ ...coord, modelId: '' })).toThrow(/modelId/);
    expect(() => retryIdFor({ ...coord, questionId: undefined as never })).toThrow(/questionId/);
  });

  it('recognises a replay of the same attempt across processes', () => {
    const runId = manifestedRun();
    const here = { ...coord, runId };
    const first = beginAttempt(here);
    expect(first.replay).toBe(false);
    const second = beginAttempt(here);
    expect(second.replay).toBe(true);
    expect(second.retryId).toBe(first.retryId);
    expect(readAttempts(runId)).toHaveLength(1);
  });

  it('books one charge, and refuses a second, different one', () => {
    const runId = manifestedRun();
    const here = { ...coord, runId };
    settleAttempt(here, { costUsd: 0.25 });
    settleAttempt(here, { costUsd: 0.25 }); // identical settlement is a no-op
    expect(attemptChargesUsd(runId)).toBeCloseTo(0.25, 10);
    // A second settlement at a different price is not a replay; it is a second
    // purchase wearing a replay's id.
    expect(() => settleAttempt(here, { costUsd: 0.4 })).toThrow(ProtocolViolationError);
    expect(attemptChargesUsd(runId)).toBeCloseTo(0.25, 10);
  });

  it('refuses a corrupt or mis-filed attempt record rather than reopening it', () => {
    // "Unreadable" must never collapse into "absent": that is the one reading
    // that licences a second charge for work already done, and it is reachable
    // by corrupting a single file.
    const runId = manifestedRun();
    const here = { ...coord, runId };
    const id = retryIdFor(here);
    beginAttempt(here);
    const valid = JSON.parse(readFileSync(join(RUNS_DIR, runId, 'attempts', `${id}.json`), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(RUNS_DIR, runId, 'attempts', `${id}.json`), '{not json');
    expect(() => beginAttempt(here)).toThrow(ProtocolViolationError);
    expect(() => settleAttempt(here, { costUsd: 1 })).toThrow(/unreadable/i);

    writeFileSync(
      join(RUNS_DIR, runId, 'attempts', `${id}.json`),
      JSON.stringify({ ...valid, retryId: 'atr_someone-elses' }),
    );
    expect(() => beginAttempt(here)).toThrow(/retryId/);
  });

  it('refuses copied, stale or edited journal rows before any spend is counted', () => {
    const runId = manifestedRun();
    const here = { ...coord, runId };
    settleAttempt(here, { costUsd: 0.25 });
    const id = retryIdFor(here);
    const path = join(RUNS_DIR, runId, 'attempts', `${id}.json`);
    const valid = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

    writeFileSync(path, JSON.stringify({ ...valid, modelId: 'unmanifested/model' }));
    try {
      readAttempts(runId);
      throw new Error('expected an undeclared coordinate to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolViolationError);
      expect((error as ProtocolViolationError).code).toBe('ATTEMPT_COORDINATE_MISMATCH');
    }

    writeFileSync(path, JSON.stringify(valid));
    const digestPath = join(RUNS_DIR, runId, 'manifest-digest.json');
    const validDigest = JSON.parse(readFileSync(digestPath, 'utf8')) as {
      itemIds: string[];
      items: Record<string, unknown>;
    };
    const injectedDigest = structuredClone(validDigest);
    injectedDigest.itemIds.push('zz-invented-item');
    injectedDigest.items['zz-invented-item'] = injectedDigest.items[injectedDigest.itemIds[0]!]!;
    writeFileSync(digestPath, JSON.stringify(injectedDigest));
    expect(() => readAttempts(runId)).toThrow(/recomputes|item index/i);
    writeFileSync(digestPath, JSON.stringify(validDigest));

    // A row copied from a different manifest is not evidence for this run.
    writeFileSync(path, JSON.stringify({ ...valid, manifestHash: 'f'.repeat(64) }));
    expect(() => readAttempts(runId)).toThrow(/stale record|names manifest/i);
    expect(() => attemptChargesUsd(runId)).toThrow(ProtocolViolationError);

    // Restore the genuine row, then edit only its booked cost. The record's
    // checksum makes a partial hand edit refuse rather than inflate spend.
    writeFileSync(path, JSON.stringify(valid));
    const edited = { ...valid, costUsd: 999 };
    writeFileSync(path, JSON.stringify(edited));
    expect(() => readAttempts(runId)).toThrow(/recordHash/);
    expect(() => attemptChargesUsd(runId)).toThrow(ProtocolViolationError);

    // Renaming a settled row out of the normal extension must not turn money
    // already spent back into an empty journal.
    writeFileSync(`${path}.bak`, JSON.stringify(valid));
    rmSync(path);
    expect(() => readAttempts(runId)).toThrow(/unexpected non-record/i);
    expect(() => beginAttempt(here)).toThrow(ProtocolViolationError);
  });

  it('opens no attempt record inside a frozen historical run', () => {
    // The attempt ledger lives inside the run, so it inherits DATA-001. A guard
    // that wrote its own bookkeeping into a published run would be a new writer
    // into immutable evidence.
    expect(() =>
      beginAttempt({ ...coord, runId: '2026-07-v2.1' }),
    ).toThrow(FirewallError);
    expect(existsSync(join(RUNS_DIR, '2026-07-v2.1', 'attempts'))).toBe(false);
  });
});

describe('RUN-002 — a replayed retry stores one answer and books one charge', () => {
  function response(runId: string, overrides: Partial<StoredResponse> = {}): StoredResponse {
    return {
      runId,
      modelId: 'openai/gpt-5.5',
      questionId: 'conv-001',
      answerText: 'Reduce the stock by half, then mount the butter off the heat.',
      raw: { id: 'gen-1' },
      tokensIn: 120,
      tokensOut: 240,
      costUsd: 0.42,
      latencyMs: 1800,
      ...overrides,
    };
  }

  it('stores one answer and one charge when the same retry lands twice', () => {
    const runId = manifestedRun();
    writeResponse(response(runId));
    // The replay: same cell, same answer, same price. A duplicate delivery, a
    // resumed process, a re-run batch — all of them arrive here.
    writeResponse(response(runId, { latencyMs: 2400 }));

    expect(readResponses(runId)).toHaveLength(1);
    const settled = readAttempts(runId).filter((a) => a.settledAtIso !== null);
    expect(settled).toHaveLength(1);
    expect(settled[0]?.cause).toBe('stored');
    expect(attemptChargesUsd(runId)).toBeCloseTo(0.42, 10);
  });

  it('refuses to overwrite a stored answer with a different one', () => {
    const runId = manifestedRun();
    writeResponse(response(runId));
    try {
      writeResponse(response(runId, { answerText: 'Something else entirely.' }));
      throw new Error('expected the second answer to be refused');
    } catch (e) {
      expect(e).toBeInstanceOf(ProtocolViolationError);
      expect((e as ProtocolViolationError).code).toBe('ANSWER_ALREADY_STORED');
    }
    expect(readResponses(runId)[0]?.answerText).toMatch(/Reduce the stock/);
    expect(attemptChargesUsd(runId)).toBeCloseTo(0.42, 10);
  });

  it('refuses a replay that charges a different price for the same answer', () => {
    const runId = manifestedRun();
    writeResponse(response(runId));
    expect(() => writeResponse(response(runId, { costUsd: 0.9 }))).toThrow(ProtocolViolationError);
    expect(attemptChargesUsd(runId)).toBeCloseTo(0.42, 10);
  });

  it('keeps distinct cells distinct', () => {
    const runId = manifestedRun();
    writeResponse(response(runId));
    writeResponse(response(runId, { questionId: 'conv-002', costUsd: 0.1 }));
    writeResponse(response(runId, { modelId: 'x-ai/grok-4.5', costUsd: 0.2 }));
    expect(readResponses(runId)).toHaveLength(3);
    expect(attemptChargesUsd(runId)).toBeCloseTo(0.72, 10);
  });

  it('re-writes an answer whose file was lost but whose attempt survived', () => {
    // Crash between the response write and the settlement, then resume: the
    // record must not become a tombstone that blocks the answer it is missing.
    const runId = manifestedRun();
    writeResponse(response(runId));
    rmSync(join(RUNS_DIR, runId, 'responses'), { recursive: true, force: true });
    mkdirSync(join(RUNS_DIR, runId, 'responses'), { recursive: true });
    expect(() => writeResponse(response(runId))).not.toThrow();
    expect(readResponses(runId)).toHaveLength(1);
    expect(attemptChargesUsd(runId)).toBeCloseTo(0.42, 10);
  });
});
