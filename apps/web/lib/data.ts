import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { questionFileSchema } from '@cookingbench/core';
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
/**
 * Smallest share of the current question set a run must cover before its
 * leaderboard is allowed to be the published one.
 *
 * A canary is a real (non-mock) run over `--limit 10`, so the mock flag does
 * not catch it, and its `generatedAt` is by definition newer than anything
 * already published. A board built from ten questions is not comparable to one
 * built from all of them and must never outrank it.
 *
 * Deliberately a share rather than an exact match: the dataset grows, and a
 * genuine past run measured over slightly fewer questions than exist today is
 * still a real board. Only a fraction of the set is disqualifying.
 */
const MIN_COVERAGE = 0.5;

function isPublishable(dir: string): boolean {
  const configPath = join(RUNS_DIR, dir, 'config.json');
  if (!existsSync(configPath)) return false;
  try {
    if (readJson<{ mock?: boolean }>(configPath).mock === true) return false;
    const boardPath = join(RUNS_DIR, dir, 'leaderboard.json');
    if (!existsSync(boardPath)) return false;
    const rows = readJson<LeaderboardReport>(boardPath).rows;
    if (rows.length === 0) return false;
    const covered = Math.max(...rows.map((r) => r.questionsGraded));
    return covered >= getQuestions().length * MIN_COVERAGE;
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
    // Parse through the schema rather than casting. `status`, `trap` and
    // `addedIn` are zod defaults, so a bare cast leaves them undefined on every
    // item that relies on the default — the site only reads `status` to test
    // for 'basics', which is always written explicitly, so it happens to work.
    // That is luck, not design, and the next field with a default would break
    // silently. The runner already loads questions this way.
    const parsed = questionFileSchema.safeParse(parse(readFileSync(join(dir, file), 'utf8')));
    if (!parsed.success) throw new Error(`Invalid questions in ${file}: ${parsed.error.message}`);
    questions.push(...(parsed.data as Question[]));
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
