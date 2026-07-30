import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunConfig, Score, StoredResponse } from '@cookingbench/core';
import { RUNS_DIR } from './dataset.js';
import { assertSafePathComponent, resolveRunDir } from './firewall.js';

/**
 * Every run-scoped path in this module resolves through the firewall
 * (WP-0, DATA-001). Reads may target a historical run; writes may not, and
 * neither may escape the runs directory.
 *
 * This replaced a bare `join(RUNS_DIR, runId)` on an unvalidated argv string.
 */
function runDir(runId: string): string {
  return resolveRunDir(runId, { write: false });
}

function runDirForWrite(runId: string): string {
  return resolveRunDir(runId, { write: true });
}

function safeName(modelId: string): string {
  return modelId.replace(/[^\w.-]+/g, '__');
}

export function writeRunConfig(config: RunConfig): void {
  const dir = join(runDirForWrite(config.runId), 'responses');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(runDirForWrite(config.runId), 'config.json'), JSON.stringify(config, null, 2));
}

/**
 * Record a `bench run` invocation, merging it into any config already written
 * for this run id instead of replacing it.
 *
 * A run is assembled from several batches on purpose — per-model budgets are
 * how the estimate gate stays tight — so the config a run publishes has to
 * describe the whole run, not whichever batch happened to go last. Fields that
 * must not vary within a run id (caps, temperature, methodology, mock) are
 * checked rather than silently overwritten; `models` becomes the union, and
 * `budgetUsdTotal` the sum of what each batch was authorised to spend.
 *
 * Judge state (`judgeCostUsd`) is written by `bench judge` and is deliberately
 * carried through untouched — re-running a candidate batch must not erase it.
 */
export function mergeRunConfig(config: RunConfig): RunConfig {
  const path = join(runDir(config.runId), 'config.json');
  if (!existsSync(path)) {
    writeRunConfig(config);
    return config;
  }
  const prior = readRunConfig(config.runId);

  if ((prior.mock ?? false) !== (config.mock ?? false)) {
    throw new Error(
      `Run ${config.runId} already has mock=${prior.mock ?? false} responses; refusing to mix mock and live batches in one run id. Use a different --run-id.`,
    );
  }
  for (const key of ['maxTokens', 'maxTokensRecipe', 'temperature', 'methodologyVersion'] as const) {
    if (prior[key] !== config[key]) {
      console.warn(
        `⚠ ${key} changed within run ${config.runId}: ${String(prior[key])} → ${String(config[key])}. ` +
          `Earlier models were measured under different settings; config.batches records which.`,
      );
    }
  }

  const priorBatches =
    prior.batches ??
    // Pre-existing config with no batch log: reconstruct the one batch we can
    // prove happened, so the union below does not drop those models.
    [
      {
        startedAt: 'unknown',
        models: prior.models,
        maxTokens: prior.maxTokens,
        maxTokensRecipe: prior.maxTokensRecipe,
        budgetUsdTotal: prior.budgetUsdTotal,
      },
    ];
  const batches = [...priorBatches, ...(config.batches ?? [])];

  const merged: RunConfig = {
    ...prior,
    ...config,
    models: [...new Set([...prior.models, ...config.models])].sort(),
    budgetUsdTotal: batches.reduce((sum, b) => sum + b.budgetUsdTotal, 0),
    judgeCostUsd: prior.judgeCostUsd ?? config.judgeCostUsd,
    batches,
  };
  writeRunConfig(merged);
  return merged;
}

export function readRunConfig(runId: string): RunConfig {
  return JSON.parse(readFileSync(join(runDir(runId), 'config.json'), 'utf8')) as RunConfig;
}

export function responsePath(runId: string, modelId: string, questionId: string): string {
  return join(
    runDir(runId),
    'responses',
    `${assertSafePathComponent(safeName(modelId), 'model id')}__${assertSafePathComponent(questionId, 'question id')}.json`,
  );
}

export function hasResponse(runId: string, modelId: string, questionId: string): boolean {
  return existsSync(responsePath(runId, modelId, questionId));
}

export function writeResponse(response: StoredResponse): void {
  // The write-guarded resolver, not responsePath: this is the highest-volume
  // writer in the pipeline (2,576 files in 2026-07-v2.1 alone) and is exactly
  // the path a mistargeted --run-id would use to overwrite published answers.
  // Both components validated here, at the writer boundary, rather than
  // trusting whichever caller got here.
  writeFileSync(
    join(
      runDirForWrite(response.runId),
      'responses',
      `${assertSafePathComponent(safeName(response.modelId), 'model id')}__${assertSafePathComponent(response.questionId, 'question id')}.json`,
    ),
    JSON.stringify(response, null, 2),
  );
}

export function readResponses(runId: string): StoredResponse[] {
  const dir = join(runDir(runId), 'responses');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as StoredResponse);
}

export function writeScores(runId: string, scores: Score[]): void {
  writeFileSync(join(runDirForWrite(runId), 'scores.json'), JSON.stringify(scores, null, 2));
}

export function readScores(runId: string): Score[] {
  const path = join(runDir(runId), 'scores.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as Score[];
}

export function writeLeaderboard(runId: string, leaderboard: unknown): void {
  writeFileSync(join(runDirForWrite(runId), 'leaderboard.json'), JSON.stringify(leaderboard, null, 2));
}

export function listRuns(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR).filter((d) => existsSync(join(RUNS_DIR, d, 'config.json')));
}
