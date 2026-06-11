import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunConfig, Score, StoredResponse } from '@cookingbench/core';
import { RUNS_DIR } from './dataset.js';

function runDir(runId: string): string {
  return join(RUNS_DIR, runId);
}

function safeName(modelId: string): string {
  return modelId.replace(/[^\w.-]+/g, '__');
}

export function writeRunConfig(config: RunConfig): void {
  const dir = join(runDir(config.runId), 'responses');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(runDir(config.runId), 'config.json'), JSON.stringify(config, null, 2));
}

export function readRunConfig(runId: string): RunConfig {
  return JSON.parse(readFileSync(join(runDir(runId), 'config.json'), 'utf8')) as RunConfig;
}

export function responsePath(runId: string, modelId: string, questionId: string): string {
  return join(runDir(runId), 'responses', `${safeName(modelId)}__${questionId}.json`);
}

export function hasResponse(runId: string, modelId: string, questionId: string): boolean {
  return existsSync(responsePath(runId, modelId, questionId));
}

export function writeResponse(response: StoredResponse): void {
  writeFileSync(
    responsePath(response.runId, response.modelId, response.questionId),
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
  writeFileSync(join(runDir(runId), 'scores.json'), JSON.stringify(scores, null, 2));
}

export function readScores(runId: string): Score[] {
  const path = join(runDir(runId), 'scores.json');
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as Score[];
}

export function writeLeaderboard(runId: string, leaderboard: unknown): void {
  writeFileSync(join(runDir(runId), 'leaderboard.json'), JSON.stringify(leaderboard, null, 2));
}

export function listRuns(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR).filter((d) => existsSync(join(RUNS_DIR, d, 'config.json')));
}
