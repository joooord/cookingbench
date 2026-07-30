import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { canonicalJson, type RunConfig } from '@cookingbench/core';
import { REPO_ROOT, RUNS_DIR } from './dataset.js';
import { resolveRunDir, resolveRunFile, writeRunFileAtomic } from './firewall.js';
import { MANIFEST_FILE } from './manifest.js';
import { sha256Hex } from './permit.js';

/**
 * DATA-001 — deriving a new run from an existing one.
 *
 * This is the only legitimate way to re-score published evidence. Run artifacts
 * are immutable once released, so a corrected grader, a new judge panel or a
 * re-analysis may not touch `2026-07-v2.1`; it inherits that run's ANSWERS under
 * a new run id, with its own manifest, its own scores and an explicit lineage
 * record pointing back. `parentArtifacts` in the manifest says which run; the
 * derivation record here says exactly which bytes.
 *
 * Three deliberate refusals, each of which was easy to get wrong:
 *
 *   1. **Answers are inherited; scores, boards and analyses are not.** Copying
 *      `scores.json` would silently carry forward numbers produced by the very
 *      grader or judge prompt the derivation exists to change — the stale-score
 *      class in M4.7. Only `responses/` crosses.
 *   2. **The source must be committed.** The lineage record names a git tree
 *      hash. If the source directory has uncommitted or untracked content, that
 *      hash describes something other than what was actually copied, and the
 *      whole trail becomes a plausible-looking fiction.
 *   3. **Copy is the default, not hard-link.** A hard link makes the derived
 *      run's response file the SAME INODE as a published artifact. Every writer
 *      in this repo replaces by rename (which is safe), but any future writer
 *      that opens a response for in-place modification would edit the published
 *      run through the alias — a DATA-001 breach with no write to the published
 *      path to detect it. Hard-linking is available (`mode: 'hardlink'`) because
 *      2,576 files per run is real disk, but it is opted into, not defaulted.
 */

export type DeriveErrorCode =
  | 'SOURCE_MISSING'
  | 'SOURCE_NOT_COMMITTED'
  | 'SOURCE_NOT_VERIFIABLE'
  | 'SOURCE_EMPTY'
  | 'TARGET_OCCUPIED'
  | 'SAME_RUN'
  | 'COPY_CORRUPT'
  | 'REASON_REQUIRED';

export class DeriveError extends Error {
  constructor(
    message: string,
    readonly code: DeriveErrorCode,
  ) {
    super(message);
    this.name = 'DeriveError';
  }
}

export const DERIVATION_FILE = 'derivation.json';

export type CopyMode = 'copy' | 'hardlink';

export interface InheritedResponse {
  file: string;
  sha256: string;
  modelId: string;
  questionId: string;
}

export interface DerivationRecord {
  derivationVersion: 1;
  runId: string;
  derivedFrom: {
    runId: string;
    /** `git rev-parse HEAD:data/runs/<id>` — the committed tree of the source. */
    treeHash: string;
    /** The source's manifest hash where it has one; null for a pre-DATA-002 run. */
    manifestFile: string | null;
    responseSetHash: string;
    responseCount: number;
    copyMode: CopyMode;
    reason: string;
    derivedAt: string;
  };
  responses: InheritedResponse[];
}

/**
 * The lineage fields a derived run's config carries.
 *
 * `RunConfig` lives in packages/core and is owned elsewhere, so this widens it
 * locally rather than editing the shared type. The per-response hash set stays
 * in `derivation.json`: 2,576 entries inside `config.json` would drown the file
 * every reader of this repo already opens first.
 */
export interface DerivedRunConfig extends RunConfig {
  derivedFrom: DerivationRecord['derivedFrom'];
  /**
   * Read by the firewall's `isReleasedOnDisk`. Stated explicitly so a derived
   * run starts writable and its lifecycle has a declared origin, rather than
   * inheriting whatever the source happened to say.
   */
  releaseState: 'draft';
}

export interface DeriveRunInput {
  sourceRunId: string;
  targetRunId: string;
  /** Why this derivation exists. Recorded in the lineage; required, non-empty. */
  reason: string;
  mode?: CopyMode;
  /** Fields to override on the inherited config, e.g. a new judge panel. */
  configOverrides?: Partial<RunConfig>;
  now?: Date;
}

export interface DeriveResult {
  record: DerivationRecord;
  config: DerivedRunConfig;
  targetDir: string;
}

// ---------------------------------------------------------------------------
// Git: the source must be committed
// ---------------------------------------------------------------------------

function git(args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // No shell, no fallback, no "assume clean". A lineage record that cannot be
    // anchored to a commit is not a lineage record.
    throw new DeriveError(
      `git ${args.join(' ')} failed (${(e as Error).message}). The source run's commit state cannot be established, so no derivation may be recorded.`,
      'SOURCE_NOT_VERIFIABLE',
    );
  }
}

/**
 * Refuse unless the source run directory is fully committed.
 *
 * `--porcelain -uall` reports staged changes, unstaged changes AND individual
 * untracked files under the path. An entirely untracked run directory shows up
 * here too, which is the case that matters most: deriving from a run that has
 * never been committed produces a record whose `treeHash` lookup fails.
 */
export function assertSourceCommitted(sourceRunId: string): string {
  const relPath = relative(REPO_ROOT, join(RUNS_DIR, sourceRunId));
  const status = git(['status', '--porcelain', '-uall', '--', relPath]).trim();
  if (status !== '') {
    const lines = status.split('\n');
    throw new DeriveError(
      `Source run ${sourceRunId} has ${lines.length} uncommitted change(s):\n` +
        lines.slice(0, 10).map((l) => `  ${l}`).join('\n') +
        (lines.length > 10 ? `\n  … and ${lines.length - 10} more` : '') +
        `\nCommit the source before deriving from it — the derivation record names a git tree that must actually contain these bytes.`,
      'SOURCE_NOT_COMMITTED',
    );
  }
  const treeHash = git(['rev-parse', `HEAD:${relPath}`]).trim();
  if (!/^[a-f0-9]{40}$/.test(treeHash)) {
    throw new DeriveError(
      `Could not resolve a committed tree for ${relPath} (got ${JSON.stringify(treeHash)}).`,
      'SOURCE_NOT_COMMITTED',
    );
  }
  return treeHash;
}

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

export function deriveRun(input: DeriveRunInput): DeriveResult {
  const { sourceRunId, targetRunId } = input;
  const mode: CopyMode = input.mode ?? 'copy';
  const now = input.now ?? new Date();

  if (input.reason.trim() === '') {
    throw new DeriveError(
      'A derivation must state why it exists. An unexplained lineage edge is the thing an audit cannot follow.',
      'REASON_REQUIRED',
    );
  }
  if (sourceRunId === targetRunId) {
    throw new DeriveError(
      `Cannot derive ${targetRunId} from itself. Re-scoring in place is exactly what DATA-001 forbids.`,
      'SAME_RUN',
    );
  }

  // Read-mode resolution for the source (a historical run is a legal source),
  // write-mode for the target (which refuses if the target is frozen).
  const sourceDir = resolveRunDir(sourceRunId, { write: false });
  if (!existsSync(sourceDir)) {
    throw new DeriveError(`Source run ${sourceRunId} does not exist.`, 'SOURCE_MISSING');
  }
  const targetDir = resolveRunDir(targetRunId, { write: true });

  // No clobber. A target that already carries answers or a config is a run in
  // its own right; overwriting it would destroy evidence just as surely as
  // writing into the source.
  for (const occupied of ['responses', 'config.json', DERIVATION_FILE, MANIFEST_FILE]) {
    if (existsSync(join(targetDir, occupied))) {
      throw new DeriveError(
        `Target run ${targetRunId} already has ${occupied}. Derive into a fresh run id.`,
        'TARGET_OCCUPIED',
      );
    }
  }

  const treeHash = assertSourceCommitted(sourceRunId);

  const sourceResponses = resolveRunFile(sourceRunId, 'responses', { write: false });
  if (!existsSync(sourceResponses)) {
    throw new DeriveError(
      `Source run ${sourceRunId} has no responses/ directory. There is nothing to inherit.`,
      'SOURCE_EMPTY',
    );
  }
  const files = readdirSync(sourceResponses)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    throw new DeriveError(`Source run ${sourceRunId} has no stored responses.`, 'SOURCE_EMPTY');
  }

  const responses: InheritedResponse[] = [];
  for (const file of files) {
    const from = resolveRunFile(sourceRunId, join('responses', file), { write: false });
    const to = resolveRunFile(targetRunId, join('responses', file), { write: true });
    const bytes = readFileSync(from);
    const sourceHash = sha256Hex(bytes.toString('utf8'));

    mkdirSync(dirname(to), { recursive: true });
    if (mode === 'hardlink') {
      // linkSync refuses an existing destination, which is the fail-closed
      // behaviour we want: a half-derived target is never silently completed.
      linkSync(from, to);
    } else {
      copyFileSync(from, to);
    }

    // Re-read and re-hash the destination. A copy that silently truncated, or a
    // link that landed somewhere unexpected, must not produce a lineage record
    // asserting the bytes match.
    const copiedHash = sha256Hex(readFileSync(to, 'utf8'));
    if (copiedHash !== sourceHash) {
      throw new DeriveError(
        `Inherited response ${file} does not match its source after ${mode} (${sourceHash.slice(0, 12)}… vs ${copiedHash.slice(0, 12)}…).`,
        'COPY_CORRUPT',
      );
    }

    const parsed = JSON.parse(bytes.toString('utf8')) as { modelId?: unknown; questionId?: unknown };
    responses.push({
      file,
      sha256: sourceHash,
      modelId: typeof parsed.modelId === 'string' ? parsed.modelId : '',
      questionId: typeof parsed.questionId === 'string' ? parsed.questionId : '',
    });
  }

  const responseSetHash = sha256Hex(
    canonicalJson({
      kind: 'cookingbench/response-set',
      sourceRunId,
      responses: responses.map((r) => [r.file, r.sha256]),
    }),
  );

  const derivedFrom: DerivationRecord['derivedFrom'] = {
    runId: sourceRunId,
    treeHash,
    manifestFile: existsSync(join(sourceDir, MANIFEST_FILE)) ? MANIFEST_FILE : null,
    responseSetHash,
    responseCount: responses.length,
    copyMode: mode,
    reason: input.reason.trim(),
    derivedAt: now.toISOString(),
  };

  const record: DerivationRecord = {
    derivationVersion: 1,
    runId: targetRunId,
    derivedFrom,
    responses,
  };

  const config = deriveConfig(sourceRunId, targetRunId, derivedFrom, input.configOverrides);

  writeRunFileAtomic(targetRunId, DERIVATION_FILE, `${JSON.stringify(record, null, 2)}\n`);
  writeRunFileAtomic(targetRunId, 'config.json', `${JSON.stringify(config, null, 2)}\n`);

  return { record, config, targetDir };
}

/**
 * The derived run's config: the source's execution settings, the new identity,
 * and nothing that was earned by the source.
 *
 * `judgeCostUsd` and `batches` are deliberately dropped. A derived run has spent
 * nothing yet, and carrying the source's spend forward would make the budget
 * ledger replay a cost that this run never incurred — the same class of error as
 * carrying its scores.
 */
function deriveConfig(
  sourceRunId: string,
  targetRunId: string,
  derivedFrom: DerivationRecord['derivedFrom'],
  overrides: Partial<RunConfig> | undefined,
): DerivedRunConfig {
  const path = resolveRunFile(sourceRunId, 'config.json', { write: false });
  const prior = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as Partial<RunConfig>)
    : {};

  const inherited: RunConfig = {
    runId: targetRunId,
    models: prior.models ?? [],
    temperature: prior.temperature ?? 0,
    maxTokens: prior.maxTokens ?? 0,
    maxTokensRecipe: prior.maxTokensRecipe ?? 0,
    // A derived run authorises no new spend by default. The permit and the
    // ledger set the real ceiling; inheriting the source's total would present
    // an already-spent budget as available.
    budgetUsdTotal: 0,
    budgetUsdPerModel: 0,
    concurrency: prior.concurrency ?? 1,
    judgeModel: prior.judgeModel ?? '',
    judgePanel: prior.judgePanel,
    judgePromptVersion: prior.judgePromptVersion ?? '',
    methodologyVersion: prior.methodologyVersion ?? '',
    mock: prior.mock ?? false,
  };

  // Identity is applied last and is not overridable: a derived config naming
  // another run id would sit in this run's directory under a false name.
  const base: RunConfig = { ...inherited, ...overrides, runId: targetRunId };
  return { ...base, derivedFrom, releaseState: 'draft' };
}

/**
 * Re-verify a derived run against its own lineage record.
 *
 * Cheap, and the only thing that makes the record worth keeping: without it,
 * `derivation.json` is a claim about bytes rather than a check on them.
 */
export function verifyDerivation(runId: string): { ok: boolean; problems: string[] } {
  const path = resolveRunFile(runId, DERIVATION_FILE, { write: false });
  if (!existsSync(path)) {
    return { ok: false, problems: [`Run ${runId} has no ${DERIVATION_FILE}.`] };
  }
  let record: DerivationRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf8')) as DerivationRecord;
  } catch (e) {
    return { ok: false, problems: [`${DERIVATION_FILE} is not valid JSON (${(e as Error).message}).`] };
  }
  if (!Array.isArray(record.responses) || record.derivedFrom === undefined) {
    return { ok: false, problems: [`${DERIVATION_FILE} is malformed.`] };
  }

  const problems: string[] = [];
  for (const entry of record.responses) {
    const file = resolveRunFile(runId, join('responses', entry.file), { write: false });
    if (!existsSync(file)) {
      problems.push(`inherited response ${entry.file} is missing`);
      continue;
    }
    const actual = sha256Hex(readFileSync(file, 'utf8'));
    if (actual !== entry.sha256) {
      problems.push(
        `inherited response ${entry.file} has changed (${entry.sha256.slice(0, 12)}… → ${actual.slice(0, 12)}…)`,
      );
    }
  }
  const recomputed = sha256Hex(
    canonicalJson({
      kind: 'cookingbench/response-set',
      sourceRunId: record.derivedFrom.runId,
      responses: record.responses.map((r) => [r.file, r.sha256]),
    }),
  );
  if (recomputed !== record.derivedFrom.responseSetHash) {
    problems.push(
      `responseSetHash does not summarise the recorded response list (${record.derivedFrom.responseSetHash.slice(0, 12)}… vs ${recomputed.slice(0, 12)}…)`,
    );
  }
  return { ok: problems.length === 0, problems };
}
