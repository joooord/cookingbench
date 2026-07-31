import { createHash } from 'node:crypto';
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
  /**
   * Candidate spend for THIS model's answers only. Not the cost of the run:
   * it excludes the judge panel and the calibration gate, which are run-level.
   * The board once labelled this column "Run cost" and so understated
   * 2026-07-v2.1 by $14.68. Anything showing a run total must use
   * `getRunCost`, never a sum of this field.
   */
  costUsd: number;
  /** v2.1+: judge-panel spend attributable to this model. Absent on older artifacts. */
  judgeCostUsd?: number;
}

/** What the runner stamps on a board about its own standing. */
export interface BoardProvenance {
  evidenceClass: string;
  releaseState: string;
  rankEligible: boolean;
  manifestHash: string;
  /** Set for legacy-shadow and development-probe. Any surface must show it. */
  nonScoringBanner: string | null;
}

export interface LeaderboardReport {
  runId: string;
  generatedAt: string;
  /** Missing on v1 artifacts. */
  methodologyVersion?: string;
  /** Missing on every artifact written before the evidence firewall. */
  provenance?: BoardProvenance;
  rows: LeaderboardRow[];
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/**
 * RELEASE-002 — which board the site serves is an APPROVAL, not a heuristic.
 *
 * What this replaces: the site read every `data/runs/*​/leaderboard.json`,
 * discarded the obviously wrong ones and served whichever had the newest
 * `generatedAt`. Three things were wrong with that, and two of them had already
 * been patched around rather than fixed:
 *
 *  - `bench report` restamps `generatedAt` on every rebuild, so regenerating any
 *    board — including a mock one, whose files are tracked — moved the homepage.
 *    The patch was "skip config.mock".
 *  - A ten-question canary is a real, non-mock run whose timestamp is by
 *    definition the newest. The patch was a 50% coverage floor.
 *  - Neither patch addresses the actual defect, which is that NOTHING in the
 *    selection expressed a human decision. A run became the public result by
 *    being written most recently.
 *
 * Now: `data/runs/REGISTER.json` carries a `currentRun` pointer, written by
 * `bench current` only for a run that is registered, released, and passing the
 * full fixed release checklist. The pointer pins every published artifact by
 * digest, so a file replaced underneath a live pointer is refused rather than
 * served beside the ones that were not replaced — the reader half of atomic
 * publication.
 */
export interface ApprovedRelease {
  report: LeaderboardReport;
  runId: string;
  /** How this run came to be the public result. */
  approval:
    | { kind: 'register'; reviewedBy: string; reviewedAt: string; checklistDigest: string }
    | { kind: 'pinned-historical'; note: string };
}

interface RegisterPointer {
  runId?: unknown;
  manifestHash?: unknown;
  reviewedBy?: unknown;
  reviewedAt?: unknown;
  checklistDigest?: unknown;
  artifacts?: Array<{ file?: unknown; sha256?: unknown }>;
}

interface RegisterShape {
  registerVersion?: unknown;
  entries?: Record<string, { state?: unknown; manifestHash?: unknown }>;
  currentRun?: RegisterPointer | null;
}

export const REGISTER_FILE = 'REGISTER.json';

/**
 * The one release approved before the register existed.
 *
 * `2026-07-v2.1` is published, `evidenceClass: historical`, `releaseState:
 * released`, and RELEASE-002 says in terms that it may remain publicly visible.
 * It predates the manifest and the register, so there is no pointer to read for
 * it and there never will be — its directory is immutable.
 *
 * This is a PIN, not a fallback rule: it names one run id and one digest of one
 * file. It cannot promote a newer board, a rebuilt board, or a board that has
 * been edited, because any of those changes the digest. The register overrides
 * it in both directions — a `currentRun` pointer wins, and an entry putting
 * this run in any state other than `released` withdraws it.
 */
const PINNED_HISTORICAL_RELEASE = {
  runId: '2026-07-v2.1',
  boardSha256: 'bf1ec6536daa12cf5d741e77c9e47ea04e1395df644ddef3709a32bd3bc39dde',
  note:
    'Released before the evidence register existed; pinned by content digest and reviewed in the ' +
    'published methodology. Any new release must go through data/runs/REGISTER.json.',
} as const;

const sha256Of = (path: string): string =>
  createHash('sha256').update(readFileSync(path, 'utf8')).digest('hex');

function readRegister(runsDir: string): RegisterShape | null {
  const path = join(runsDir, REGISTER_FILE);
  if (!existsSync(path)) return null;
  try {
    const parsed = readJson<RegisterShape>(path);
    // An unreadable or unversioned register is not an absent one. Falling back
    // to the pin on a MALFORMED register would let a corrupted file silently
    // restore a withdrawn board, so the caller is told nothing is approved.
    return parsed && parsed.registerVersion === 1 ? parsed : { registerVersion: 0 };
  } catch {
    return { registerVersion: 0 };
  }
}

/**
 * Resolve the approved release under `runsDir`. Root-parameterised so the
 * mechanism can be exercised offline against a scratch tree.
 */
export function resolveApprovedRelease(runsDir: string): ApprovedRelease | null {
  const register = readRegister(runsDir);
  if (register && register.registerVersion !== 1) return null;

  const pointer = register?.currentRun ?? null;
  if (pointer && typeof pointer.runId === 'string') {
    const entry = register?.entries?.[pointer.runId];
    // The pointer and the entry must agree. A pointer naming a run the register
    // does not show released is a register that has been half-edited.
    if (!entry || entry.state !== 'released' || entry.manifestHash !== pointer.manifestHash) return null;
    // The board this function is about to serve must itself be pinned. Without
    // this, a pointer carrying no `artifacts` array would skip the loop below
    // entirely and the digest check would be decorative.
    const pins = Array.isArray(pointer.artifacts) ? pointer.artifacts : [];
    if (!pins.some((a) => a?.file === 'leaderboard.json')) return null;
    for (const pinned of pins) {
      if (typeof pinned?.file !== 'string' || typeof pinned?.sha256 !== 'string') return null;
      const path = join(runsDir, pointer.runId, pinned.file);
      if (!existsSync(path) || sha256Of(path) !== pinned.sha256) return null;
    }
    const report = readBoard(runsDir, pointer.runId);
    if (!report) return null;
    return {
      report,
      runId: pointer.runId,
      approval: {
        kind: 'register',
        reviewedBy: String(pointer.reviewedBy ?? ''),
        reviewedAt: String(pointer.reviewedAt ?? ''),
        checklistDigest: String(pointer.checklistDigest ?? ''),
      },
    };
  }

  // No pointer. The pin applies unless the register has withdrawn it.
  const withdrawn =
    register?.entries?.[PINNED_HISTORICAL_RELEASE.runId] !== undefined &&
    register.entries[PINNED_HISTORICAL_RELEASE.runId]!.state !== 'released';
  if (withdrawn) return null;
  const boardPath = join(runsDir, PINNED_HISTORICAL_RELEASE.runId, 'leaderboard.json');
  if (!existsSync(boardPath) || sha256Of(boardPath) !== PINNED_HISTORICAL_RELEASE.boardSha256) return null;
  const report = readBoard(runsDir, PINNED_HISTORICAL_RELEASE.runId);
  if (!report) return null;
  return {
    report,
    runId: PINNED_HISTORICAL_RELEASE.runId,
    approval: { kind: 'pinned-historical', note: PINNED_HISTORICAL_RELEASE.note },
  };
}

function readBoard(runsDir: string, runId: string): LeaderboardReport | null {
  const path = join(runsDir, runId, 'leaderboard.json');
  if (!existsSync(path)) return null;
  try {
    const report = readJson<LeaderboardReport>(path);
    // The board must name the run it was approved as. A file copied in from
    // another run would otherwise be served under this run's approval.
    if (report.runId !== runId || !Array.isArray(report.rows) || report.rows.length === 0) return null;
    return report;
  } catch {
    return null;
  }
}

/** The approved release, with its approval. Null means nothing is approved. */
export function getApprovedRelease(): ApprovedRelease | null {
  return existsSync(RUNS_DIR) ? resolveApprovedRelease(RUNS_DIR) : null;
}

/**
 * The board every page renders.
 *
 * Kept under its old name so the pages do not each have to learn the new
 * vocabulary at once, but it is no longer "the latest report": it is the
 * approved one, and when nothing is approved it is null.
 */
export function getLatestReport(): LeaderboardReport | null {
  return getApprovedRelease()?.report ?? null;
}

/** The slice of analysis.json the site reads. Mirrors RunAnalysis in the runner. */
interface PairSeparation {
  a: string;
  b: string;
  scope: 'active' | 'frontier';
  gap: number;
  pAhead: number;
  separated: boolean;
  items: number;
}

export interface RunAnalysisSummary {
  activeQuestions: number;
  activeAllPerfect: number;
  activeWithSignal: number;
  effectiveItems: number;
  separation?: PairSeparation[];
}

export function getAnalysis(runId: string): RunAnalysisSummary | null {
  const path = join(RUNS_DIR, runId, 'analysis.json');
  if (!existsSync(path)) return null;
  try {
    return readJson<RunAnalysisSummary>(path);
  } catch {
    return null;
  }
}

/**
 * Competition ranks with statistically tied models sharing a place: a model's
 * rank is one plus the number of models *proven* better than it.
 *
 * The board used to number rows 1..n off the sorted order, which reads as a
 * strict ordering of fourteen models. In run 2026-07-v2.1 exactly one of
 * thirteen adjacent pairs is genuinely ordered: three models sit within 0.05
 * points at P≈0.52. Numbering them 1, 2, 3 states something the data does not
 * support, and the top row is the one people screenshot.
 *
 * Computed from the full pair matrix, never from a chain of adjacent verdicts.
 * Non-separation does not chain: in this run every adjacent pair from 1st to
 * 12th is tied, yet the ends are far apart, so following the chain would award
 * Qwen 3.7 Max a share of first place while the direct test has GPT-5.6 Sol Pro
 * beating it at P=1.000.
 *
 * Returns null when a run has no separation data (every pre-2026-07 artifact),
 * and callers fall back to positional ranks. Ties are never invented for a run
 * that was not tested for them.
 */
export function getTiedRanks(runId: string): Map<string, number> | null {
  const pairs = getAnalysis(runId)?.separation?.filter((p) => p.scope === 'active');
  if (!pairs || pairs.length === 0) return null;
  const models = new Set(pairs.flatMap((p) => [p.a, p.b]));
  const ranks = new Map<string, number>();
  for (const m of models) {
    ranks.set(m, pairs.filter((p) => p.b === m && p.separated).length + 1);
  }
  return ranks;
}

/**
 * A model's place on the board, from the one rank source.
 *
 * `sharedWith` is how many models hold this same place — 1 means the model
 * holds it alone. Anything rendering a rank must branch on this rather than
 * printing the number bare, or a joint first place reads as an outright win.
 */
export interface Standing {
  place: number;
  sharedWith: number;
}

export interface Standings {
  byModel: Map<string, Standing>;
  /**
   * True when places came from the paired bootstrap; false when the run was
   * never tested for separation and places are just row order.
   */
  tested: boolean;
  /** Model ids holding place 1. Length > 1 is a shared first place. */
  first: string[];
  outOf: number;
}

/**
 * THE rank source for every page. Do not derive a rank any other way.
 *
 * The board was taught about ties (`getTiedRanks`) but the model pages were
 * not, so they kept computing `rows.indexOf(row) + 1`: a model badged "=1st"
 * on the homepage was headed "rank #2" on its own page and in the description
 * Google indexed. Two derivations of the same number is the defect — this
 * function exists so there is only one.
 *
 * Falls back to row order when the run has no separation data, which is every
 * pre-2026-07 artifact. Ties are never invented for a run that was not tested
 * for them.
 */
export function getStandings(report: LeaderboardReport): Standings {
  const tied = getTiedRanks(report.runId);
  // Fail closed on a partial matrix. Competition places mean "models proven
  // better than me", which is only true if every row was tested against every
  // other; a row missing from analysis.json would otherwise be handed place 1
  // for the sole reason that nothing was measured against it.
  const trustworthy = tied !== null && report.rows.every((r) => tied.has(r.modelId));
  const placeOf = (row: LeaderboardRow, index: number): number =>
    trustworthy ? tied!.get(row.modelId)! : index + 1;

  const occupants = new Map<number, number>();
  report.rows.forEach((row, i) => {
    const place = placeOf(row, i);
    occupants.set(place, (occupants.get(place) ?? 0) + 1);
  });

  const byModel = new Map<string, Standing>();
  report.rows.forEach((row, i) => {
    const place = placeOf(row, i);
    byModel.set(row.modelId, { place, sharedWith: occupants.get(place)! });
  });

  return {
    byModel,
    tested: trustworthy,
    first: report.rows.filter((r) => byModel.get(r.modelId)!.place === 1).map((r) => r.modelId),
    outOf: report.rows.length,
  };
}

/**
 * Renders a Standing as an ordinal, carrying the board's "=" marker when the
 * place is shared: "=1st" for a joint first, "7th" for a place held alone.
 *
 * Lives next to `getStandings` on purpose. The rank contradiction this file
 * fixes was a rendering decision made far from the rank computation, and
 * splitting the two again is how it comes back.
 */
export function formatPlace(standing: Standing): string {
  const n = standing.place;
  // 11th/12th/13th are the exceptions to the last-digit rule.
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${standing.sharedWith > 1 ? '=' : ''}${n}${suffix}`;
}

/** The slice of a run's config.json the site reads. */
export interface RunConfig {
  runId: string;
  models?: string[];
  temperature?: number;
  maxTokens?: number;
  maxTokensRecipe?: number;
  judgeModel?: string;
  judgePanel?: string[];
  judgePromptVersion?: string;
  methodologyVersion?: string;
  mock?: boolean;
  /** Total judge-panel spend. Absent on runs that predate cost recording. */
  judgeCostUsd?: number;
}

export function getRunConfig(runId: string): RunConfig | null {
  const path = join(RUNS_DIR, runId, 'config.json');
  if (!existsSync(path)) return null;
  try {
    return readJson<RunConfig>(path);
  } catch {
    return null;
  }
}

/**
 * What a run actually cost, split by what the money bought.
 *
 * Unknown components are `null`, never 0: a run whose judge spend was never
 * recorded did not judge for free, and rendering it as $0.00 would repeat the
 * understatement in a new form. Callers must say "not recorded" and treat
 * `knownUsd` as a lower bound whenever `complete` is false.
 */
export interface RunCost {
  /** Candidate model spend — the sum of the board's per-model column. */
  candidateUsd: number;
  /** Judge panel spend for the whole run. */
  judgeUsd: number | null;
  /** Calibration gate spend — the anchor replay every seat runs before judging. */
  calibrationUsd: number | null;
  /** Sum of the components that are known. */
  knownUsd: number;
  /** False when any component is unknown. */
  complete: boolean;
}

const money = (n: number) => Math.round(n * 100) / 100;
const finite = (n: unknown): number | null =>
  typeof n === 'number' && Number.isFinite(n) ? n : null;

export function getRunCost(report: LeaderboardReport): RunCost {
  // Candidate spend is summed from the board's own rows rather than from the
  // responses, so the breakdown always reconciles with the column a reader can
  // add up by hand.
  const candidateUsd = report.rows.reduce((sum, r) => sum + (finite(r.costUsd) ?? 0), 0);

  const config = getRunConfig(report.runId);
  let judgeUsd = finite(config?.judgeCostUsd);
  if (judgeUsd === null) {
    // Fallback for artifacts written before the run config carried a judge
    // total: the per-model figures, but only if every row has one. A partial
    // sum would look authoritative while being too small.
    const perModel = report.rows.map((r) => finite(r.judgeCostUsd));
    if (perModel.length > 0 && perModel.every((v) => v !== null)) {
      judgeUsd = perModel.reduce((sum, v) => sum + v!, 0);
    }
  }

  let calibrationUsd: number | null = null;
  const calibrationPath = join(RUNS_DIR, report.runId, 'calibration.json');
  if (existsSync(calibrationPath)) {
    try {
      calibrationUsd = finite(readJson<{ costUsd?: number }>(calibrationPath).costUsd);
    } catch {
      calibrationUsd = null;
    }
  }

  return {
    candidateUsd: money(candidateUsd),
    judgeUsd: judgeUsd === null ? null : money(judgeUsd),
    calibrationUsd: calibrationUsd === null ? null : money(calibrationUsd),
    knownUsd: money(candidateUsd + (judgeUsd ?? 0) + (calibrationUsd ?? 0)),
    complete: judgeUsd !== null && calibrationUsd !== null,
  };
}

/**
 * id → display name for the roster, so pages can name a judge seat without
 * hardcoding it. The methodology page named the panel by hand and went stale
 * the moment the Qwen seat was replaced by Grok 4.5 — it went on claiming a
 * panel that had not judged the published run.
 *
 * Deliberately shape-checked rather than parsed through the core schema: this
 * only needs two fields, and a roster field the site does not read must never
 * be able to take the site down.
 */
export function getModelNames(): Map<string, string> {
  const names = new Map<string, string>();
  const path = join(DATA_DIR, 'models.yaml');
  if (!existsSync(path)) return names;
  try {
    const parsed: unknown = parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(parsed)) return names;
    for (const entry of parsed) {
      const { id, displayName } = (entry ?? {}) as { id?: unknown; displayName?: unknown };
      if (typeof id === 'string' && typeof displayName === 'string') names.set(id, displayName);
    }
  } catch {
    // An unreadable roster costs nice names, nothing else — callers fall back
    // to the slug, which is still true.
  }
  return names;
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
