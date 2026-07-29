import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { RunConfig } from '@cookingbench/core';
import { RUNS_DIR } from '../src/dataset.js';
import { mergeRunConfig, readRunConfig } from '../src/store.js';

// A real directory under data/runs, because that is where store.ts writes. The
// id is namespaced and removed after each test; it never carries a
// leaderboard.json, so even a leaked directory cannot reach the site.
const RUN_ID = '__test-merge-config';

afterEach(() => {
  rmSync(join(RUNS_DIR, RUN_ID), { recursive: true, force: true });
});

function batchConfig(models: string[], overrides: Partial<RunConfig> = {}): RunConfig {
  return {
    runId: RUN_ID,
    models,
    temperature: 0,
    maxTokens: 16000,
    maxTokensRecipe: 32000,
    budgetUsdTotal: 10,
    budgetUsdPerModel: 0,
    concurrency: 4,
    judgeModel: 'panel-v1',
    judgePanel: ['anthropic/claude-opus-4.8'],
    judgePromptVersion: 'judge-v2',
    methodologyVersion: 'v2',
    mock: false,
    batches: [
      {
        startedAt: '2026-07-29T00:00:00Z',
        models,
        maxTokens: 16000,
        maxTokensRecipe: 32000,
        budgetUsdTotal: 10,
      },
    ],
    ...overrides,
  };
}

describe('mergeRunConfig', () => {
  it('writes the config unchanged when the run is new', () => {
    const merged = mergeRunConfig(batchConfig(['a/one']));
    expect(merged.models).toEqual(['a/one']);
    expect(existsSync(join(RUNS_DIR, RUN_ID, 'config.json'))).toBe(true);
  });

  it('unions models across batches instead of replacing them', () => {
    mergeRunConfig(batchConfig(['a/one', 'b/two']));
    mergeRunConfig(batchConfig(['c/three']));
    // The bug this exists to prevent: 2026-06-v2 published one model against a
    // leaderboard of thirteen, because the last batch overwrote the file.
    expect(readRunConfig(RUN_ID).models).toEqual(['a/one', 'b/two', 'c/three']);
  });

  it('does not duplicate a model that is re-run', () => {
    mergeRunConfig(batchConfig(['a/one']));
    mergeRunConfig(batchConfig(['a/one']));
    expect(readRunConfig(RUN_ID).models).toEqual(['a/one']);
  });

  it('sums the authorised budget and keeps one batch record per invocation', () => {
    mergeRunConfig(batchConfig(['a/one']));
    mergeRunConfig(batchConfig(['b/two'], { budgetUsdTotal: 5, batches: [
      { startedAt: '2026-07-29T01:00:00Z', models: ['b/two'], maxTokens: 16000, maxTokensRecipe: 32000, budgetUsdTotal: 5 },
    ] }));
    const cfg = readRunConfig(RUN_ID);
    expect(cfg.budgetUsdTotal).toBe(15);
    expect(cfg.batches).toHaveLength(2);
    expect(cfg.batches?.map((b) => b.models)).toEqual([['a/one'], ['b/two']]);
  });

  it('preserves judgeCostUsd written by a previous judge pass', () => {
    mergeRunConfig(batchConfig(['a/one']));
    // bench judge writes this after calibration passes; a later candidate batch
    // must not erase what judging already cost.
    const withJudge = { ...readRunConfig(RUN_ID), judgeCostUsd: 4.2 };
    mergeRunConfig({ ...withJudge, runId: RUN_ID });
    mergeRunConfig(batchConfig(['b/two']));
    expect(readRunConfig(RUN_ID).judgeCostUsd).toBe(4.2);
  });

  it('reconstructs a batch record for a config written before batches existed', () => {
    const legacy = batchConfig(['a/one']);
    delete legacy.batches;
    mergeRunConfig(legacy);
    mergeRunConfig(batchConfig(['b/two']));
    const cfg = readRunConfig(RUN_ID);
    expect(cfg.models).toEqual(['a/one', 'b/two']);
    expect(cfg.batches?.[0]).toMatchObject({ startedAt: 'unknown', models: ['a/one'] });
  });

  it('refuses to mix mock and live batches in one run id', () => {
    mergeRunConfig(batchConfig(['a/one'], { mock: true }));
    // A mock batch scores personas, not models; letting one share a run id with
    // real responses would put invented numbers in a published leaderboard.
    expect(() => mergeRunConfig(batchConfig(['b/two'], { mock: false }))).toThrow(/mock/);
  });
});
