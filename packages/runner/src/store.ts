import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunConfig, Score, StoredResponse } from '@cookingbench/core';
import { RUNS_DIR } from './dataset.js';
import {
  FirewallError,
  assertSafePathComponent,
  resolveRunDir,
  resolveRunFile,
  writeRunFileAtomic,
} from './firewall.js';

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

/**
 * The legacy, LOSSY filename encoding. Kept only to read artifacts written
 * before WP-0: it collapses every run of non-word characters to "__", so
 * `openai/gpt-5.5` and `openai:gpt-5.5` produce the same filename and one
 * response silently overwrites the other.
 */
function legacySafeName(modelId: string): string {
  return modelId.replace(/[^\w.-]+/g, '__');
}

/**
 * Injective, reversible component encoding: anything outside [A-Za-z0-9._-]
 * becomes ~XX hex, and "~" itself is escaped first so the mapping stays
 * one-to-one. Distinct model ids can no longer share a stored cell.
 */
const ALLOWED_FILENAME_CHAR = /^[A-Za-z0-9.-]$/;
/** ext4/APFS cap is 255 bytes; leave room for the ".json" suffix and staging. */
const MAX_FILENAME_BYTES = 200;

/**
 * Injective component encoding.
 *
 * Two defects in the previous version, both reproduced:
 *   - `_` was inside the allowed set while `__` was the field separator, so
 *     ("a/b", "c__d") and ("a/b__c", "d") produced the same filename. `_` is
 *     now encoded, which makes `__` unambiguously a separator.
 *   - the regex walked UTF-16 code UNITS, so each half of a surrogate pair was
 *     encoded separately and TextEncoder turned every lone surrogate into
 *     U+FFFD — 😀 and 🚀 both became ~EF~BF~BD~EF~BF~BD. Iterating with
 *     `for...of` yields whole code points.
 */
function encodeComponent(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '~') {
      out += '~7E';
    } else if (ALLOWED_FILENAME_CHAR.test(ch)) {
      out += ch;
    } else {
      for (const b of new TextEncoder().encode(ch)) {
        out += `~${b.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

function responseFileName(modelId: string, questionId: string): string {
  // Validate the RAW values first. Encoding would happily turn
  // `../../../etc/passwd` into a safe-but-mangled filename, which hides bad
  // input rather than refusing it — a question id containing a separator is a
  // bug upstream, not something to silently rewrite. Model ids legitimately
  // contain "/", so only the question id is checked for separators.
  assertSafePathComponent(questionId, 'question id');
  if (modelId === '' || modelId.includes('\0') || modelId.length > 160) {
    throw new FirewallError(
      `Unsafe model id ${JSON.stringify(modelId)}.`,
      'INVALID_PATH_COMPONENT',
    );
  }
  const name = `${encodeComponent(modelId)}__${encodeComponent(questionId)}.json`;
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > MAX_FILENAME_BYTES) {
    throw new FirewallError(
      `Encoded response filename is ${bytes} bytes, over the ${MAX_FILENAME_BYTES}-byte limit (${modelId} × ${questionId}). Escaping can expand an accepted input past the filesystem bound.`,
      'INVALID_PATH_COMPONENT',
    );
  }
  return name;
}

export function writeRunConfig(config: RunConfig): void {
  mkdirSync(join(runDirForWrite(config.runId), 'responses'), { recursive: true });
  writeRunFileAtomic(config.runId, 'config.json', JSON.stringify(config, null, 2));
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

/**
 * Read path. Prefers the injective encoding and falls back to the legacy name
 * so historical runs — which are frozen and will never be rewritten — stay
 * readable.
 */
export function responsePath(runId: string, modelId: string, questionId: string): string {
  const dir = join(runDir(runId), 'responses');
  const current = join(dir, responseFileName(modelId, questionId));
  if (existsSync(current)) return current;
  const legacy = join(dir, `${legacySafeName(modelId)}__${questionId}.json`);
  return existsSync(legacy) ? legacy : current;
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
  writeRunFileAtomic(
    response.runId,
    join('responses', responseFileName(response.modelId, response.questionId)),
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
  writeRunFileAtomic(runId, 'scores.json', JSON.stringify(scores, null, 2));
}

export function readScores(runId: string): Score[] {
  const path = join(runDir(runId), 'scores.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as Score[];
}

export function writeLeaderboard(runId: string, leaderboard: unknown): void {
  writeRunFileAtomic(runId, 'leaderboard.json', JSON.stringify(leaderboard, null, 2));
}

export function listRuns(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR).filter((d) => existsSync(join(RUNS_DIR, d, 'config.json')));
}
