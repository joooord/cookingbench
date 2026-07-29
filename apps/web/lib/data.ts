import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import type { CategoryId, Question, Score, StoredResponse } from '@cookingbench/core';

// Data source v1: committed run artifacts in the repo (fully reproducible from
// git). The Supabase-backed source slots in here once runs are synced.
const REPO_ROOT = resolve(process.cwd(), '../..');
const DATA_DIR = join(REPO_ROOT, 'data');
const RUNS_DIR = join(DATA_DIR, 'runs');

export interface LeaderboardRow {
  modelId: string;
  displayName: string;
  provider: string;
  family?: string;
  overall: number;
  /** v2: 95% bootstrap CI over questions. */
  overallCi?: [number, number];
  /** v2: saturated-item regression gate. */
  basics?: number | null;
  /** v2: mean over difficulty ≥ 4 items. */
  frontier?: number | null;
  /** v1 column. */
  hardSet?: number | null;
  categories: Partial<Record<CategoryId, number>>;
  questionsGraded: number;
  /** v2: transport-noise responses (empty/filtered after retries). */
  incidents?: number;
  costUsd: number;
}

export interface LeaderboardReport {
  runId: string;
  generatedAt: string;
  /** Missing on v1 artifacts. */
  methodologyVersion?: string;
  rows: LeaderboardRow[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * A run built with `--mock` must never reach the site. The site picks the
 * newest run by generatedAt, `bench report` restamps that on every rebuild,
 * and the README's own $0 dev loop targets run id `mock-run` — whose files are
 * tracked, so a rebuild shows up as modified files that `git add -A` sweeps
 * up. One commit after that and the homepage ranks mock personas.
 *
 * The discriminator is already in the artifact: config.json carries mock:true.
 */
function isPublishable(dir: string): boolean {
  const configPath = join(RUNS_DIR, dir, 'config.json');
  if (!existsSync(configPath)) return false;
  try {
    return readJson<{ mock?: boolean }>(configPath).mock !== true;
  } catch {
    return false;
  }
}

export function getLatestReport(): LeaderboardReport | null {
  if (!existsSync(RUNS_DIR)) return null;
  const reports = readdirSync(RUNS_DIR)
    .filter(isPublishable)
    .map((dir) => join(RUNS_DIR, dir, 'leaderboard.json'))
    .filter((p) => existsSync(p))
    .map((p) => readJson<LeaderboardReport>(p))
    // A malformed or missing timestamp sorts as NaN and would win or lose at
    // random, so drop those rather than let one decide the homepage.
    .filter((r) => Number.isFinite(Date.parse(r.generatedAt)));
  if (reports.length === 0) return null;
  reports.sort((a, b) => Date.parse(b.generatedAt) - Date.parse(a.generatedAt));
  return reports[0]!;
}

export function getQuestions(): Question[] {
  const dir = join(DATA_DIR, 'questions');
  const questions: Question[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    questions.push(...(parse(readFileSync(join(dir, file), 'utf8')) as Question[]));
  }
  return questions;
}

export function getPublicQuestions(): Question[] {
  return getQuestions().filter((q) => q.public);
}

export function getScores(runId: string): Score[] {
  const path = join(RUNS_DIR, runId, 'scores.json');
  if (!existsSync(path)) return [];
  return readJson<Score[]>(path);
}

export function getResponses(runId: string): StoredResponse[] {
  const dir = join(RUNS_DIR, runId, 'responses');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson<StoredResponse>(join(dir, f)));
}

export function modelSlug(modelId: string): string {
  return modelId.replace(/\//g, '--');
}

export function modelIdFromSlug(slug: string): string {
  return slug.replace(/--/g, '/');
}
