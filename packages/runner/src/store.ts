import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PanelTasteVote, RunConfig, Score, StoredResponse } from '@cookingbench/core';
import type { PairVerdictRecord, TastePanelSummary } from './tastejudge.js';
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

// ── LLM taste panel artifacts (committed; kept separate from human votes) ──

function tastePanelDir(runId: string): string {
  return join(runDir(runId), 'taste-panel');
}

function verdictName(questionId: string, modelA: string, modelB: string): string {
  return `${questionId}__${safeName(modelA)}__${safeName(modelB)}.json`;
}

export function hasTasteVerdict(runId: string, questionId: string, modelA: string, modelB: string): boolean {
  return existsSync(join(tastePanelDir(runId), 'verdicts', verdictName(questionId, modelA, modelB)));
}

export function writeTasteVerdict(record: PairVerdictRecord): void {
  const dir = join(tastePanelDir(record.runId), 'verdicts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, verdictName(record.questionId, record.modelA, record.modelB)),
    JSON.stringify(record, null, 2),
  );
}

export function readTasteVerdicts(runId: string): PairVerdictRecord[] {
  const dir = join(tastePanelDir(runId), 'verdicts');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as PairVerdictRecord);
}

/**
 * Rewrite the derived taste-panel artifacts from all stored verdicts: an
 * append-friendly ndjson of votes (stable key order and sort → clean diffs) and
 * a ratings summary. Regenerated wholesale so resumed runs stay consistent.
 */
export function writeTastePanelArtifacts(
  runId: string,
  votes: PanelTasteVote[],
  summary: TastePanelSummary,
): void {
  const dir = tastePanelDir(runId);
  mkdirSync(dir, { recursive: true });
  const ordered = [...votes].sort(
    (x, y) =>
      x.question_id.localeCompare(y.question_id) ||
      x.model_a.localeCompare(y.model_a) ||
      x.model_b.localeCompare(y.model_b) ||
      x.judge_model.localeCompare(y.judge_model),
  );
  const ndjson = ordered
    .map((v) =>
      JSON.stringify({
        run_id: v.run_id,
        question_id: v.question_id,
        model_a: v.model_a,
        model_b: v.model_b,
        winner: v.winner,
        judge_model: v.judge_model,
        position_consistent: v.position_consistent,
      }),
    )
    .join('\n');
  writeFileSync(join(dir, 'panel-votes.ndjson'), ndjson ? `${ndjson}\n` : '');
  writeFileSync(join(dir, 'summary.json'), JSON.stringify(summary, null, 2));
}
