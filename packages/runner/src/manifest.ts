import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  NON_SCORING_LABEL,
  canonicalJson,
  expectedOutputRoot,
  safeParseRunManifest,
  type Question,
  type ValidatedRunManifest,
  type ValidatedRunManifestV2,
} from '@cookingbench/core';
import { REPO_ROOT, buildMessages, loadModels, loadQuestions, maxTokensFor } from './dataset.js';
import { DERIVATION_FILE, verifyDerivationForManifest } from './derive.js';
import { Firewall, resolveRunFile, writeRunFileAtomic } from './firewall.js';
import {
  JUDGE_PROMPT_VERSIONS,
  buildDimensionJudgeMessages,
  buildJudgeMessages,
  buildPairwiseJudgeMessages,
  judgeModeOf,
} from './judge.js';
import {
  assertGrantForRun,
  assertVerifiedGrant,
  frozenMethodologyHash,
  manifestHash,
  sha256Hex,
  type VerifiedGrant,
} from './permit.js';

/**
 * M4.1 / DATA-002 — writing an immutable run manifest, and proving a run's
 * artifacts are the ones it declares.
 *
 * The traceability matrix recorded two gaps against DATA-002: *no command
 * writes a manifest*, and *nothing verifies that a run's stored artifacts match
 * the hashes its manifest declares*. `validatedRunManifestSchema` (core) and
 * `manifestHash` (permit.ts) already define what a manifest IS and how it is
 * bound to an approval; this module is the part that computes the four content
 * hashes from the real dataset, prompt builder, judge prompts and grader code,
 * writes the envelope, and refuses when the two have drifted apart.
 *
 * Neither of those existing pieces is re-implemented here. `manifestHash` is
 * imported and used verbatim, because the golden digests in
 * `test/golden-hashes.test.ts` pin the exact canonical form every issued permit
 * signed against; a second, subtly different canonicalisation in this file would
 * invalidate approvals at the worst possible moment.
 *
 * ## What each hash is a hash OF, and why the levels differ
 *
 * The choice of what to hash is the whole design, because a digest that is too
 * sensitive is worse than none: it fires on a reformat, everyone learns to
 * override it, and then it fires on a real change and is overridden too.
 *
 *   bankHash        PARSED item content, not YAML bytes. A comment or a
 *                   reflowed block does not change what was asked, and should
 *                   not invalidate a run's scores. A changed number, tolerance,
 *                   forbidden term or reference answer does, and does.
 *   promptHash      The RENDERED candidate messages, per item, plus the token
 *                   cap the item resolves to. Behaviour, not source — so a
 *                   comment in dataset.ts cannot trip it, while a change to the
 *                   base system prompt or to the recipe/general cap split
 *                   (which measurably changed answers on this roster) does.
 *   judgePromptHash The RENDERED judge messages against a fixed probe answer.
 *                   This deliberately covers the reference answer and the
 *                   attention hints, because both are pasted into the judge
 *                   prompt: editing a reference answer changes how every
 *                   candidate was graded, and that must invalidate judge scores.
 *   validatorHash   SOURCE of every result-changing module. A grader has no
 *                   rendered form, so source is the only honest level. The
 *                   2026-07 grader audit is the case for it: a fixed keyword
 *                   grader moved six of thirteen positions, and nothing in the
 *                   artifacts recorded that the scoring code had changed
 *                   underneath them.
 *
 * Source hashing normalises CRLF to LF. A Windows checkout must not produce a
 * different validatorHash for identical code — that is a reproducibility bug
 * that looks exactly like tampering.
 */

export type ManifestErrorCode =
  | 'MANIFEST_ABSENT'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_RUN_ID_MISMATCH'
  | 'MANIFEST_IMMUTABLE'
  | 'MANIFEST_HASH_MISMATCH'
  | 'MANIFEST_CLAIM_MISMATCH'
  | 'MANIFEST_GRANT_MISMATCH'
  | 'MANIFEST_ROUTE_IDENTITY_MISMATCH'
  | 'SOURCE_COMMIT_MISMATCH'
  | 'SOURCE_TREE_DIRTY'
  | 'DIGEST_ABSENT'
  | 'DIGEST_INVALID'
  | 'DATASET_INVALID'
  | 'JUDGE_PROMPT_UNRENDERABLE'
  | 'VALIDATOR_SOURCE_MISSING'
  | 'RUN_IDENTITY_MISMATCH'
  | 'TEST_SEAM_IN_PRODUCTION'
  | 'ARTIFACTS_DO_NOT_MATCH';

export class ManifestError extends Error {
  constructor(
    message: string,
    readonly code: ManifestErrorCode,
  ) {
    super(message);
    this.name = 'ManifestError';
  }
}

/** The envelope itself. Immutable once written for a run id. */
export const MANIFEST_FILE = 'manifest.json';
/**
 * The component digests that back the manifest's four summary hashes.
 *
 * These do not live in the manifest because the manifest's canonical form is
 * what permits are signed over and what `golden-hashes.test.ts` freezes; a
 * per-item map of 184 digests inside it would be both enormous and a moving
 * target. Keeping them beside it means the summary hash stays signable while
 * the item-level detail — which is what makes "only these three items changed"
 * expressible — is still committed and auditable.
 */
export const MANIFEST_DIGEST_FILE = 'manifest-digest.json';

/**
 * The manifest's own digest, persisted beside it (DATA-002: "persist the exact
 * manifest AND its digest with the run").
 *
 * Not decoration. `manifestHash` is what a permit signs and what the release
 * register binds a lifecycle to, and until now it existed only in memory: the
 * run recorded the envelope but not the identity everything else refers to it
 * by. Written as a separate one-line file rather than a field inside
 * manifest.json, because a manifest that contains its own hash cannot be hashed
 * without a fixed-point rule, and every such rule is a place to hide a
 * mismatch.
 */
export const MANIFEST_HASH_FILE = 'manifest.sha256';

export const DIGEST_VERSION = 2;

/**
 * Refuse a test-only seam outside a test process.
 *
 * The rule this enforces: a safeguard is meaningless when the thing it guards
 * can choose the safeguard's inputs. Every function in this codebase that lets
 * a caller substitute a trust input — the dataset a hash is recomputed from,
 * the register file a lifecycle is read out of — is reachable from production
 * the moment it is exported, and "only tests call it" is a convention, not a
 * boundary. Production entry points therefore take FIXED inputs, the injectable
 * form is named so a production call site is obvious in review, and this check
 * makes the call fail closed if one ever lands.
 *
 * `VITEST` is set by the runner in every worker; `NODE_ENV=test` covers a
 * non-vitest harness. Neither is a security control against an operator who
 * controls the environment — that operator can edit the source anyway — and the
 * threat this addresses is unattended code quietly selecting its own inputs.
 */
export function assertTestSeam(name: string): void {
  if (process.env.VITEST === undefined && process.env.NODE_ENV !== 'test') {
    throw new ManifestError(
      `${name} is a test-only seam and was called outside a test process. ` +
        `It exists so tests can substitute a trust input; production must use the fixed entry point, which takes none.`,
      'TEST_SEAM_IN_PRODUCTION',
    );
  }
}

/**
 * The fixed candidate answer used to render judge prompts for hashing.
 *
 * A judge prompt is a template plus an answer; the answer varies per response,
 * so hashing the template requires holding it constant. It must survive
 * `assertPromptBlind` (which the builders run), so it names no vendor, no model
 * and no dish that could collide with the blinding lexicon.
 */
const JUDGE_PROBE_ANSWER =
  'PROBE ANSWER: a fixed placeholder used only to render this prompt for hashing.';
const JUDGE_PROBE_ANSWER_B =
  'PROBE ANSWER TWO: a second fixed placeholder used only to render this prompt for hashing.';

/**
 * Source trees that `validatorHash` covers.
 *
 * LISTED rather than enumerated by hand, and the default is INCLUSION. A
 * hand-written include list is fail-open by construction: adding
 * `graders/newthing.ts`, or a whole new statistics module, would leave it
 * outside the hash, and the one thing this digest exists to catch is scoring
 * code changing without the artifacts noticing.
 *
 * The previous version of this covered `packages/core/src/graders` plus one
 * named file. That was the defect: the judge, the adjudicator, the statistics
 * and the analysis all change scores and all sat outside the hash, so a
 * re-seated deduction map or a changed bootstrap could move the board without
 * invalidating a single artifact.
 */
const VALIDATOR_ROOTS = [join('packages', 'core', 'src'), join('packages', 'runner', 'src')];

/**
 * The only files inside those trees that are NOT result-changing, each with the
 * reason it is out.
 *
 * Exclusion is explicit, auditable and INSIDE the hashed payload, so quietly
 * adding `judge.ts` to this list to stop a digest moving changes the digest.
 * The test for the property is the important one: a new module is covered
 * without anyone remembering to add it, and removing coverage is visible.
 *
 * The line drawn is "can this module change what a given answer scores?", not
 * "is this module important". Transport, authorisation, budget and path code
 * can refuse work or move bytes; none of them can turn a 40 into a 90.
 */
const NOT_RESULT_CHANGING: ReadonlyMap<string, string> = new Map([
  [join('packages', 'runner', 'src', 'openrouter.ts'), 'transport: issues the call, never scores it'],
  [join('packages', 'runner', 'src', 'ledger.ts'), 'budget accounting: can stop a call, cannot change a score'],
  [join('packages', 'runner', 'src', 'permit.ts'), 'authorisation: admits or refuses work'],
  [join('packages', 'runner', 'src', 'firewall.ts'), 'path and capability enforcement'],
  [join('packages', 'runner', 'src', 'redemption.ts'), 'permit accounting'],
  [join('packages', 'runner', 'src', 'supabase.ts'), 'transport: database client construction'],
  [join('packages', 'runner', 'src', 'sync.ts'), 'transport: copies finished artifacts outwards'],
  [join('packages', 'runner', 'src', 'taste.ts'), 'transport: archives ballots, computes no benchmark score'],
  [join('packages', 'runner', 'src', 'estimate.ts'), 'cost projection only'],
  [join('packages', 'runner', 'src', 'derive.ts'), 'copies bytes and records lineage'],
  [join('packages', 'runner', 'src', 'lifecycle.ts'), 'gating and lifecycle state; scores nothing'],
  [
    join('packages', 'runner', 'src', 'manifest.ts'),
    'computes this very digest; including it would make every comment in this file a scoring change',
  ],
]);

// ---------------------------------------------------------------------------
// Content digests
// ---------------------------------------------------------------------------

export interface ValidatorFileDigest {
  path: string;
  present: boolean;
  sha256: string | null;
}

/** A source file deliberately left outside the hash, and why. */
export interface ValidatorExclusion {
  path: string;
  reason: string;
}

export interface ItemDigest {
  /** Parsed item content. */
  item: string;
  /** Rendered candidate prompt plus resolved token cap. */
  prompt: string;
  /** Rendered judge prompt; null for a deterministically graded item. */
  judgePrompt: string | null;
  /** Which judge route rendered it, for the stale-score comparison. */
  judgeMode: string | null;
}

export interface ContentDigest {
  digestVersion: number;
  /** The exact item set this run covers, sorted. Not "the dataset". */
  itemIds: string[];
  bankHash: string;
  promptHash: string;
  judgePromptHash: string;
  validatorHash: string;
  items: Record<string, ItemDigest>;
  validatorFiles: ValidatorFileDigest[];
  /** Stated, not silent: what was left out of validatorHash and on what grounds. */
  validatorExclusions: ValidatorExclusion[];
}

export interface PromptSettings {
  maxTokens: number;
  maxTokensRecipe: number;
}

function digest(kind: string, payload: unknown): string {
  // The kind is inside the hashed structure, not merely a prefix, so two
  // different kinds of record can never produce the same digest by carrying the
  // same fields.
  return sha256Hex(canonicalJson({ kind, digestVersion: DIGEST_VERSION, payload }));
}

/** Content identity of one item, independent of YAML formatting. */
export function itemHash(question: Question): string {
  return digest('cookingbench/item', question);
}

/** Rendered candidate prompt for one item, with the cap it resolves to. */
export function promptHashFor(question: Question, settings: PromptSettings): string {
  return digest('cookingbench/prompt', {
    id: question.id,
    messages: buildMessages(question),
    maxTokens: maxTokensFor(question, settings),
  });
}

/**
 * Rendered judge prompt for one item, or null where the item is not judged.
 *
 * A builder that throws is NOT swallowed into null. "This item cannot be
 * judged" and "this item is not judged" are different facts, and collapsing
 * them would let an item that the judge route refuses sail into a manifest and
 * fail later, mid-spend.
 */
export function judgePromptHashFor(question: Question): { hash: string | null; mode: string | null } {
  if (question.grader.type !== 'llm-judge') return { hash: null, mode: null };
  const mode = judgeModeOf(question);
  let messages: ReadonlyArray<{ role: string; content: string }>;
  try {
    messages =
      mode === 'dimension'
        ? buildDimensionJudgeMessages(question, JUDGE_PROBE_ANSWER)
        : mode === 'pairwise'
          ? buildPairwiseJudgeMessages(question, JUDGE_PROBE_ANSWER, JUDGE_PROBE_ANSWER_B)
          : buildJudgeMessages(question, JUDGE_PROBE_ANSWER);
  } catch (e) {
    throw new ManifestError(
      `Cannot render the judge prompt for ${question.id} (mode '${mode}'): ${(e as Error).message}. ` +
        `An item whose judge prompt does not build cannot be manifested — it would fail after the run had already been paid for.`,
      'JUDGE_PROMPT_UNRENDERABLE',
    );
  }
  return {
    hash: digest('cookingbench/judge-prompt', {
      id: question.id,
      mode,
      promptVersion: JUDGE_PROMPT_VERSIONS[mode],
      messages,
    }),
    mode,
  };
}

function readSourceHash(relativePath: string): string | null {
  const absolute = join(REPO_ROOT, relativePath);
  if (!existsSync(absolute)) return null;
  // Normalise line endings: identical code checked out on Windows must not hash
  // differently, or every CRLF working copy reads as a tampered grader.
  return sha256Hex(readFileSync(absolute, 'utf8').replace(/\r\n/g, '\n'));
}

/** Every `.ts` under `root`, repository-relative and depth-first, sorted. */
function listSources(root: string): string[] {
  const absolute = join(REPO_ROOT, root);
  if (!existsSync(absolute)) {
    throw new ManifestError(
      `Source directory ${root} is missing. Refusing to hash a validator set that cannot be read.`,
      'VALIDATOR_SOURCE_MISSING',
    );
  }
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const relative = join(root, entry.name);
    // Symlinks are neither followed nor hashed: a link could point the digest
    // at source outside the repository, which is drift the hash would report as
    // stability. Directories are walked; anything else is ignored.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) found.push(...listSources(relative));
    else if (entry.isFile() && entry.name.endsWith('.ts')) found.push(relative);
  }
  return found;
}

/**
 * Result-changing source, discovered rather than enumerated.
 *
 * Fails closed twice over: an unreadable root throws, and an empty discovered
 * set throws, because an empty validator set hashes to a perfectly stable value
 * that binds no code at all — the most dangerous kind of green.
 */
export function validatorDigest(): {
  validatorHash: string;
  files: ValidatorFileDigest[];
  exclusions: ValidatorExclusion[];
} {
  const discovered = VALIDATOR_ROOTS.flatMap((root) => listSources(root));
  const exclusions: ValidatorExclusion[] = [];
  const included: string[] = [];
  for (const path of discovered) {
    const reason = NOT_RESULT_CHANGING.get(path);
    if (reason === undefined) included.push(path);
    else exclusions.push({ path, reason });
  }
  // An exclusion naming a file that no longer exists is a stale licence to omit
  // something: the next file to take that path would be silently uncovered.
  for (const [path, reason] of NOT_RESULT_CHANGING) {
    if (!discovered.includes(path)) {
      throw new ManifestError(
        `${path} is excluded from validatorHash ("${reason}") but is not in [${VALIDATOR_ROOTS.join(', ')}]. ` +
          `A stale exclusion is a hole waiting for a file to fall into it.`,
        'VALIDATOR_SOURCE_MISSING',
      );
    }
  }
  if (included.length === 0) {
    throw new ManifestError(
      `No result-changing sources found in [${VALIDATOR_ROOTS.join(', ')}]. An empty validator set hashes to a stable value that binds nothing.`,
      'VALIDATOR_SOURCE_MISSING',
    );
  }
  const files: ValidatorFileDigest[] = included
    .map((path) => ({ path, present: existsSync(join(REPO_ROOT, path)), sha256: readSourceHash(path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  exclusions.sort((a, b) => (a.path < b.path ? -1 : 1));
  // Exclusions are hashed alongside the files, so moving a module out of
  // coverage moves the digest instead of quietly shrinking it.
  return { validatorHash: digest('cookingbench/validator', { files, exclusions }), files, exclusions };
}

/**
 * The four manifest hashes, plus the per-item detail behind them.
 *
 * Takes the EXACT item set the run will execute, not "the dataset". A run over
 * `--limit 5` covers five items, and a manifest claiming the whole bank would be
 * a false declaration that the verifier could never reconcile.
 */
export function computeContentDigest(questions: Question[], settings: PromptSettings): ContentDigest {
  const sorted = [...questions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Set<string>();
  for (const q of sorted) {
    if (seen.has(q.id)) {
      throw new ManifestError(
        `Item ${q.id} appears twice in the manifested set. A duplicated item would be hashed once and executed twice.`,
        'DATASET_INVALID',
      );
    }
    seen.add(q.id);
  }
  if (sorted.length === 0) {
    throw new ManifestError(
      'Refusing to manifest an empty item set: it hashes to a fixed value that binds no content at all.',
      'DATASET_INVALID',
    );
  }

  // Parallel arrays rather than re-reading `items[id]`: the set digests are
  // over ORDERED (id, hash) pairs, so building them in the same pass keeps the
  // order provably the sorted one.
  const items: Record<string, ItemDigest> = {};
  const bankPairs: Array<[string, string]> = [];
  const promptPairs: Array<[string, string]> = [];
  const judgePairs: Array<[string, string | null]> = [];
  for (const q of sorted) {
    const judge = judgePromptHashFor(q);
    const entry: ItemDigest = {
      item: itemHash(q),
      prompt: promptHashFor(q, settings),
      judgePrompt: judge.hash,
      judgeMode: judge.mode,
    };
    items[q.id] = entry;
    bankPairs.push([q.id, entry.item]);
    promptPairs.push([q.id, entry.prompt]);
    judgePairs.push([q.id, entry.judgePrompt]);
  }
  const validator = validatorDigest();

  return {
    digestVersion: DIGEST_VERSION,
    itemIds: sorted.map((q) => q.id),
    bankHash: digest('cookingbench/bank', bankPairs),
    promptHash: digest('cookingbench/prompt-set', promptPairs),
    judgePromptHash: digest('cookingbench/judge-prompt-set', judgePairs),
    validatorHash: validator.validatorHash,
    items,
    validatorFiles: validator.files,
    validatorExclusions: validator.exclusions,
  };
}

// ---------------------------------------------------------------------------
// Building and writing the envelope
// ---------------------------------------------------------------------------

const HASH_FIELDS = ['bankHash', 'promptHash', 'judgePromptHash', 'validatorHash'] as const;
type HashField = (typeof HASH_FIELDS)[number];

const TRACEABILITY_FILE = join(REPO_ROOT, 'docs', 'wp-0', 'traceability.yaml');
const DOCUMENT_IDENTITY_FIELDS = ['methodologyHash', 'traceabilityVersion'] as const;
type DocumentIdentityField = (typeof DOCUMENT_IDENTITY_FIELDS)[number];

/**
 * The two fixed document identities carried by every v2 manifest.
 *
 * Methodology uses the existing trust-root helper, which checks the committed
 * checksum sidecar against the actual master-plan bytes before returning the
 * digest. Traceability has no sidecar: its exact YAML bytes are the version.
 * Production freeze already requires both fixed paths to be clean relative to
 * the manifest's full git commit.
 */
function fixedDocumentIdentities(): Record<DocumentIdentityField, string> {
  let methodologyHash: string;
  try {
    methodologyHash = frozenMethodologyHash();
  } catch (error) {
    throw new ManifestError(
      `Cannot derive the manifest methodologyHash from the fixed master plan (${(error as Error).message}).`,
      'MANIFEST_HASH_MISMATCH',
    );
  }
  if (!existsSync(TRACEABILITY_FILE)) {
    throw new ManifestError(
      `Cannot derive traceabilityVersion because the fixed traceability matrix ${TRACEABILITY_FILE} is absent.`,
      'MANIFEST_HASH_MISMATCH',
    );
  }
  return {
    methodologyHash,
    traceabilityVersion: sha256Hex(readFileSync(TRACEABILITY_FILE, 'utf8')),
  };
}

function assertFixedDocumentIdentities(
  manifest: Pick<ValidatedRunManifestV2, 'methodologyHash' | 'traceabilityVersion'>,
  context: string,
): void {
  const expected = fixedDocumentIdentities();
  for (const field of DOCUMENT_IDENTITY_FIELDS) {
    if (manifest[field] !== expected[field]) {
      throw new ManifestError(
        `${context} declares ${field} ${manifest[field].slice(0, 12)}… but the fixed repository document hashes to ${expected[field].slice(0, 12)}…. ` +
          'Document identities are checked, never corrected.',
        'MANIFEST_HASH_MISMATCH',
      );
    }
  }
}

/**
 * Bytes whose git identity must be reproducible before freezing or spending.
 *
 * This is intentionally wider than validatorHash: transport and boundary code
 * may not change a score, but uncommitted code can still change what is sent,
 * stored or authorised. Questions and methodology are separate because they
 * live outside the package source trees. The model roster is rank-affecting
 * too: judging reads provider and base-model identity from it when excluding
 * conflicted seats.
 */
const REPRODUCIBLE_SOURCE_PATHS = Object.freeze([
  join('packages', 'core', 'src'),
  join('packages', 'runner', 'src'),
  join('data', 'questions'),
  join('data', 'models.yaml'),
  join('data', 'calibration'),
  join('data', 'historical-runs.json'),
  join('data', 'permits', 'keys'),
  join('data', 'permits', 'revoked.json'),
  join('docs', 'methodology'),
  join('docs', 'wp-0', 'traceability.yaml'),
]);

function repositoryHead(repoRoot: string): string {
  let commit: string;
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new ManifestError(
      `Cannot resolve the repository's current commit (${(error as Error).message}).`,
      'SOURCE_COMMIT_MISMATCH',
    );
  }
  if (!/^[a-f0-9]{40}$/.test(commit)) {
    throw new ManifestError(
      `git rev-parse HEAD returned ${JSON.stringify(commit)}, not a full commit identity.`,
      'SOURCE_COMMIT_MISMATCH',
    );
  }
  return commit;
}

/** The exact committed source revision a newly built envelope describes. */
export function currentSourceCommit(): string {
  return repositoryHead(REPO_ROOT);
}

/**
 * Production reproducibility gate for manifest freeze and paid authority.
 *
 * A digest of working-tree bytes plus a HEAD label is not a reproducible source
 * identity when those bytes are dirty: checking out the recorded commit would
 * produce different questions, methodology or executable code. The declared
 * object must therefore exist, be the exact current HEAD, and have no tracked
 * or untracked changes beneath the fixed relevant paths.
 */
export function assertReproducibleGitIdentity(declaredCommit: string): string {
  return assertReproducibleGitIdentityAt(declaredCommit, REPO_ROOT);
}

/**
 * Bind the conflict identities declared by an inference manifest to the fixed,
 * committed roster. Judging consumes the signed manifest values; this check
 * prevents a draft from inventing different provider/base-model facts simply
 * because both fields happen to be non-empty strings.
 */
export function assertManifestRouteIdentityMatchesRoster(
  manifest: Pick<ValidatedRunManifest, 'candidateRoutes' | 'judgeRoutes'>,
): void {
  const roster = new Map(loadModels().map((model) => [model.id, model]));
  for (const [kind, routes] of [
    ['candidate', manifest.candidateRoutes],
    ['judge', manifest.judgeRoutes],
  ] as const) {
    for (const route of routes) {
      const declared = roster.get(route.modelId);
      if (!declared) {
        throw new ManifestError(
          `${kind} route ${route.modelId} is absent from the committed model roster.`,
          'MANIFEST_ROUTE_IDENTITY_MISMATCH',
        );
      }
      if (route.provider !== declared.provider || route.baseModelFamily !== declared.baseModel) {
        throw new ManifestError(
          `${kind} route ${route.modelId} declares provider/base identity ` +
            `${JSON.stringify(route.provider)}/${JSON.stringify(route.baseModelFamily)}, but the committed roster declares ` +
            `${JSON.stringify(declared.provider)}/${JSON.stringify(declared.baseModel)}.`,
          'MANIFEST_ROUTE_IDENTITY_MISMATCH',
        );
      }
    }
  }
}

/** Isolated-repository seam for adversarial tests; production uses fixed paths. */
export function assertReproducibleGitIdentityForTests(
  declaredCommit: string,
  repoRoot: string,
): string {
  assertTestSeam('assertReproducibleGitIdentityForTests');
  return assertReproducibleGitIdentityAt(declaredCommit, repoRoot);
}

function assertReproducibleGitIdentityAt(declaredCommit: string, repoRoot: string): string {
  if (!/^[a-f0-9]{40}$/.test(declaredCommit)) {
    throw new ManifestError(
      `Manifest gitCommit ${JSON.stringify(declaredCommit)} is not a full 40-character commit identity.`,
      'SOURCE_COMMIT_MISMATCH',
    );
  }

  try {
    execFileSync('git', ['cat-file', '-e', `${declaredCommit}^{commit}`], {
      cwd: repoRoot,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  } catch {
    throw new ManifestError(
      `Manifest gitCommit ${declaredCommit} does not identify an existing commit in this repository.`,
      'SOURCE_COMMIT_MISMATCH',
    );
  }

  const current = repositoryHead(repoRoot);
  if (declaredCommit !== current) {
    throw new ManifestError(
      `Manifest gitCommit ${declaredCommit} is not the current source commit ${current}. ` +
        'Paid work and newly frozen manifests must execute from the exact revision they declare.',
      'SOURCE_COMMIT_MISMATCH',
    );
  }

  let status: string;
  try {
    status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all', '--', ...REPRODUCIBLE_SOURCE_PATHS],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  } catch (error) {
    throw new ManifestError(
      `Cannot establish whether source, question and methodology bytes match ${current} (${(error as Error).message}).`,
      'SOURCE_COMMIT_MISMATCH',
    );
  }
  if (status !== '') {
    const changes = status.split('\n');
    throw new ManifestError(
      `Relevant source tree is dirty relative to ${current}:\n` +
        changes.slice(0, 12).map((line) => `  ${line}`).join('\n') +
        (changes.length > 12 ? `\n  … and ${changes.length - 12} more` : '') +
        '\nCommit or remove every tracked/untracked source, question and methodology change before freezing a manifest or exercising paid authority.',
      'SOURCE_TREE_DIRTY',
    );
  }
  return current;
}

/**
 * Fill a draft manifest's content hashes from the real dataset and code.
 *
 * A draft that already declares one of the four is CHECKED, never overwritten.
 * Silently correcting an operator's declaration would turn a wrong belief about
 * which bank is being run into a run that quietly runs a different one — which
 * is precisely the masquerade this module exists to prevent.
 */
export function buildRunManifest(
  draft: unknown,
  questions: Question[],
): { manifest: ValidatedRunManifestV2; digest: ContentDigest; manifestHash: string } {
  if (typeof draft !== 'object' || draft === null || Array.isArray(draft)) {
    throw new ManifestError(
      `Manifest draft must be an object; got ${draft === null ? 'null' : Array.isArray(draft) ? 'array' : typeof draft}.`,
      'MANIFEST_INVALID',
    );
  }
  const source = draft as Record<string, unknown>;
  const settings = readSettings(source);
  const computed = computeContentDigest(questions, settings);

  const merged: Record<string, unknown> = { ...source };
  const draftVersion = source.manifestVersion;
  if (draftVersion !== undefined && draftVersion !== 1 && draftVersion !== 2) {
    throw new ManifestError(
      `Manifest draft requests unsupported manifestVersion ${JSON.stringify(draftVersion)}; new manifests are version 2.`,
      'MANIFEST_INVALID',
    );
  }
  // Version 1 remains a read format and a tolerated legacy draft template, but
  // the builder owns the output wire version: no newly built envelope is v1.
  merged.manifestVersion = 2;

  const documents = fixedDocumentIdentities();
  for (const field of DOCUMENT_IDENTITY_FIELDS) {
    const declared = source[field];
    if (declared !== undefined && declared !== documents[field]) {
      throw new ManifestError(
        `Draft manifest declares ${field} ${String(declared).slice(0, 12)}… but the fixed repository document hashes to ${documents[field].slice(0, 12)}…. ` +
          'Declared document identities are checked, never corrected.',
        'MANIFEST_HASH_MISMATCH',
      );
    }
    merged[field] = documents[field];
  }

  const sourceCommit = currentSourceCommit();
  const declaredCommit = source.gitCommit;
  if (
    declaredCommit !== undefined &&
    (typeof declaredCommit !== 'string' ||
      !/^[a-f0-9]{40}$/.test(declaredCommit) ||
      declaredCommit !== sourceCommit)
  ) {
    throw new ManifestError(
      `Draft manifest declares gitCommit ${JSON.stringify(declaredCommit)}, but the source being frozen is ${sourceCommit}. ` +
        'Source identity is derived from git; when a draft names it, it must use that exact full 40-character commit id.',
      'SOURCE_COMMIT_MISMATCH',
    );
  }
  // A manifest field that merely looks commit-shaped is not source evidence.
  merged.gitCommit = sourceCommit;
  for (const field of HASH_FIELDS) {
    const declared = source[field];
    if (declared !== undefined && declared !== computed[field]) {
      throw new ManifestError(
        `Draft manifest declares ${field} ${String(declared).slice(0, 12)}… but the working tree computes ${computed[field].slice(0, 12)}…. ` +
          `Declared content hashes are checked, never corrected.`,
        'MANIFEST_HASH_MISMATCH',
      );
    }
    merged[field] = computed[field];
  }
  // outputRoot is derived from run identity by the schema's own rule; filling it
  // here saves the caller restating a value it is not free to choose.
  if (merged.outputRoot === undefined && typeof merged.runId === 'string') {
    merged.outputRoot = expectedOutputRoot(merged.runId);
  }

  const parsed = safeParseRunManifest(merged);
  if (!parsed.ok) {
    throw new ManifestError(`Manifest draft is not a valid manifest: ${parsed.error}`, 'MANIFEST_INVALID');
  }
  if (parsed.manifest.manifestVersion !== 2) {
    throw new ManifestError(
      'Manifest builder produced a historical v1 envelope; new manifests must be version 2.',
      'MANIFEST_INVALID',
    );
  }
  return { manifest: parsed.manifest, digest: computed, manifestHash: manifestHash(parsed.manifest) };
}

/**
 * Token caps for prompt rendering, taken from the draft's generationSettings.
 *
 * Fails closed rather than defaulting: a manifest whose caps cannot be read
 * would otherwise hash prompts rendered at some assumed budget, and the measured
 * lesson on this roster is that the cap changes the answer (a flat 8k truncated
 * one frontier model at 1,323 characters where another wrote 8,409).
 */
function readSettings(source: Record<string, unknown>): PromptSettings {
  const settings = source.generationSettings as { maxTokens?: unknown; maxTokensRecipe?: unknown } | undefined;
  const maxTokens = settings?.maxTokens;
  const maxTokensRecipe = settings?.maxTokensRecipe;
  if (typeof maxTokens !== 'number' || typeof maxTokensRecipe !== 'number') {
    throw new ManifestError(
      'Manifest draft must declare generationSettings.maxTokens and generationSettings.maxTokensRecipe before its prompts can be hashed.',
      'MANIFEST_INVALID',
    );
  }
  return { maxTokens, maxTokensRecipe };
}

export interface WrittenManifest {
  manifest: ValidatedRunManifestV2;
  manifestHash: string;
  digest: ContentDigest;
  /** False when an identical manifest was already on disk. */
  written: boolean;
}

/**
 * Write a run's manifest and its component digests.
 *
 * Idempotent by hash: re-writing the identical envelope is a no-op, so a
 * resumed or retried command does not need to know whether it already ran. A
 * DIFFERENT envelope for the same run id is refused — the manifest is the one
 * artifact a run may not revise, because the permit that authorised the run is
 * bound to its hash.
 */
export function writeRunManifest(
  runId: string,
  manifestLike: unknown,
  questions: Question[],
): WrittenManifest {
  const parsed = safeParseRunManifest(manifestLike);
  if (!parsed.ok) {
    throw new ManifestError(`Refusing to write an invalid manifest: ${parsed.error}`, 'MANIFEST_INVALID');
  }
  const manifest = parsed.manifest;
  if (manifest.manifestVersion !== 2) {
    throw new ManifestError(
      `Refusing to write historical manifestVersion ${manifest.manifestVersion}; v1 remains readable, but every newly written manifest must be version 2.`,
      'MANIFEST_INVALID',
    );
  }
  assertFixedDocumentIdentities(manifest, `Manifest for ${runId}`);
  if (manifest.runId !== runId) {
    throw new ManifestError(
      `Manifest names run '${manifest.runId}' but is being written into run '${runId}'. A manifest is not transferable between runs.`,
      'MANIFEST_RUN_ID_MISMATCH',
    );
  }
  const computed = computeContentDigest(questions, {
    maxTokens: manifest.generationSettings.maxTokens,
    maxTokensRecipe: manifest.generationSettings.maxTokensRecipe,
  });
  for (const field of HASH_FIELDS) {
    if (manifest[field] !== computed[field]) {
      throw new ManifestError(
        `Manifest for ${runId} declares ${field} ${manifest[field].slice(0, 12)}… but the supplied item set and working tree compute ${computed[field].slice(0, 12)}…. ` +
          `A manifest that does not describe what will actually run is worse than none.`,
        'MANIFEST_HASH_MISMATCH',
      );
    }
  }

  const hash = manifestHash(manifest);
  const existingPath = resolveRunFile(runId, MANIFEST_FILE, { write: false });
  if (existsSync(existingPath)) {
    const existing = safeParseRunManifest(readJson(existingPath, 'MANIFEST_INVALID'));
    if (!existing.ok) {
      throw new ManifestError(
        `Run ${runId} already carries a manifest that no longer validates (${existing.error}). Refusing to replace it: an unreadable envelope is an incident, not something to overwrite.`,
        'MANIFEST_INVALID',
      );
    }
    if (manifestHash(existing.manifest) !== hash) {
      throw new ManifestError(
        `Run ${runId} already has a different manifest (${manifestHash(existing.manifest).slice(0, 12)}… vs ${hash.slice(0, 12)}…). ` +
          `Derive a new run id instead — the permit that authorised this run is bound to the existing hash.`,
        'MANIFEST_IMMUTABLE',
      );
    }
    return { manifest, manifestHash: hash, digest: computed, written: false };
  }

  writeRunFileAtomic(runId, MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`);
  writeRunFileAtomic(runId, MANIFEST_DIGEST_FILE, `${JSON.stringify(computed, null, 2)}\n`);
  // Written LAST. The sidecar is what every later gate compares against, so a
  // crash between the three writes leaves a run with no recorded identity —
  // which verification refuses — rather than an identity for a manifest that
  // was never finished.
  writeRunFileAtomic(runId, MANIFEST_HASH_FILE, `${hash}\n`);
  return { manifest, manifestHash: hash, digest: computed, written: true };
}

/**
 * The manifest identity recorded with the run.
 *
 * Three outcomes, kept distinct: no sidecar, an unreadable one, and a digest.
 * Collapsing the first two into null would let a truncated sidecar read as "a
 * pre-sidecar run", which is exactly the direction that turns an incident into
 * a shrug. Reported rather than thrown so verification can gather findings.
 */
export type RecordedManifestHash =
  | { state: 'absent' }
  | { state: 'malformed'; raw: string }
  | { state: 'present'; hash: string };

export function readRunManifestHash(runId: string): RecordedManifestHash {
  const path = resolveRunFile(runId, MANIFEST_HASH_FILE, { write: false });
  if (!existsSync(path)) return { state: 'absent' };
  const recorded = readFileSync(path, 'utf8').trim();
  return /^[a-f0-9]{64}$/.test(recorded)
    ? { state: 'present', hash: recorded }
    : { state: 'malformed', raw: recorded.slice(0, 64) };
}

function readJson(path: string, code: ManifestErrorCode): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new ManifestError(`${path} is not valid JSON (${(e as Error).message}).`, code);
  }
}

/** Read a run's manifest. Throws rather than returning null — absence is a refusal. */
export function readRunManifest(runId: string): ValidatedRunManifest {
  const path = resolveRunFile(runId, MANIFEST_FILE, { write: false });
  if (!existsSync(path)) {
    throw new ManifestError(
      `Run ${runId} has no ${MANIFEST_FILE}. A run without a manifest has no declared evidence class, lineage or content hashes (DATA-002).`,
      'MANIFEST_ABSENT',
    );
  }
  const parsed = safeParseRunManifest(readJson(path, 'MANIFEST_INVALID'));
  if (!parsed.ok) {
    throw new ManifestError(`Manifest for ${runId} failed validation: ${parsed.error}`, 'MANIFEST_INVALID');
  }
  if (parsed.manifest.runId !== runId) {
    throw new ManifestError(
      `Manifest stored in run ${runId} names run '${parsed.manifest.runId}'. A copied manifest does not carry its origin's authorisation.`,
      'MANIFEST_RUN_ID_MISMATCH',
    );
  }
  return parsed.manifest;
}

function storedManifestIdentity(
  runId: string,
  context: string,
): { manifest: ValidatedRunManifest; hash: string } {
  const manifest = readRunManifest(runId);
  const hash = manifestHash(manifest);
  const recorded = readRunManifestHash(runId);
  if (recorded.state !== 'present' || recorded.hash !== hash) {
    const identity =
      recorded.state === 'absent'
        ? 'absent'
        : recorded.state === 'malformed'
          ? `malformed (${JSON.stringify(recorded.raw)})`
          : `${recorded.hash.slice(0, 12)}…`;
    throw new ManifestError(
      `${context} refused: run ${runId} stores manifest ${hash.slice(0, 12)}… but its ` +
        `${MANIFEST_HASH_FILE} identity is ${identity}. The stored envelope and its recorded identity must agree before any authority is exercised.`,
      'MANIFEST_HASH_MISMATCH',
    );
  }
  return { manifest, hash };
}

/**
 * Resolve untrusted CLI manifest input to the run's own recorded envelope.
 *
 * The caller-supplied file is a claim about WHICH stored run is intended, not
 * the envelope against which authority is verified. Its complete canonical
 * identity must equal the stored file and sidecar; the stored manifest is what
 * the verifier receives and what this function returns.
 */
export function resolveStoredManifestClaim(
  claimedManifest: unknown,
  context: string,
): ValidatedRunManifest {
  const parsed = safeParseRunManifest(claimedManifest);
  if (!parsed.ok) {
    throw new ManifestError(
      `${context} refused: caller manifest is invalid (${parsed.error}).`,
      'MANIFEST_INVALID',
    );
  }
  const stored = storedManifestIdentity(parsed.manifest.runId, context);
  const claimedHash = manifestHash(parsed.manifest);
  if (claimedHash !== stored.hash) {
    throw new ManifestError(
      `${context} refused: caller manifest for run ${parsed.manifest.runId} hashes to ${claimedHash.slice(0, 12)}… ` +
        `but that run stores ${stored.hash.slice(0, 12)}…. A parallel envelope cannot select what a permit is verified against.`,
      'MANIFEST_CLAIM_MISMATCH',
    );
  }
  return stored.manifest;
}

/**
 * Bind exercised authority to the exact manifest stored under its run.
 *
 * Permit verification necessarily starts with untrusted input from a file, but
 * a command must not execute a parallel envelope supplied with `--manifest`
 * merely because it carries the same run id. This boundary re-reads the run's
 * own manifest, reconciles its persisted identity sidecar, and compares that
 * canonical identity with the hash the verified permit signed.
 *
 * It is intentionally one production function used by the CLI's sole grant
 * loader. No paid/live command gets a grant back until this returns.
 */
export function assertGrantMatchesStoredManifest(
  grant: VerifiedGrant,
  context: string,
  executingManifest?: unknown,
): ValidatedRunManifest {
  assertGrantForRun(grant, grant.runId, `${context} stored-manifest binding`);
  const stored = storedManifestIdentity(grant.runId, context);
  if (grant.manifestHash !== stored.hash) {
    throw new ManifestError(
      `${context} refused: permit ${grant.permitId} authorises manifest ${grant.manifestHash.slice(0, 12)}… ` +
        `but run ${grant.runId} stores ${stored.hash.slice(0, 12)}…. A caller-supplied parallel manifest, even with the same run id, cannot substitute for the envelope the command executes.`,
      'MANIFEST_GRANT_MISMATCH',
    );
  }
  if (executingManifest !== undefined) {
    const executingHash = manifestHash(executingManifest);
    if (executingHash !== stored.hash) {
      throw new ManifestError(
        `${context} refused: the in-memory execution envelope hashes to ${executingHash.slice(0, 12)}… but ` +
          `the verified stored manifest is ${stored.hash.slice(0, 12)}…. Authority must bind the exact object the command will execute, not only a matching run id.`,
        'MANIFEST_GRANT_MISMATCH',
      );
    }
  }
  return stored.manifest;
}

/** Runtime result of the writer-owned RELEASE-002 check. */
export interface ArtifactWriteVerdict {
  runId: string;
  manifest: ValidatedRunManifest;
  manifestHash: string;
  nonScoringBanner: string | null;
  /** Present only when the writer required and verified publication authority. */
  grant: VerifiedGrant | null;
}

/**
 * Authorise one result-artifact write at the writer boundary.
 *
 * A CLI preflight is useful feedback, but it is not a boundary: another caller
 * can import `writeLeaderboard` or `writeAnalysis` directly. Those writers call
 * this themselves. Public-release artifacts require a runtime-minted grant for
 * this exact stored manifest and the `publication` capability. Other classes
 * may create review artifacts, but their evidential class and NON-SCORING stamp
 * are returned from the stored manifest rather than chosen by the caller.
 */
export function assertArtifactWriteAllowed(
  runId: string,
  artifact: 'leaderboard.json' | 'analysis.json',
  candidateGrant?: unknown,
): ArtifactWriteVerdict {
  const context = `${artifact} write for run ${runId}`;
  // Preserve the filesystem boundary as the first refusal: a frozen run or a
  // linked target is unwritable regardless of whether it predates manifests.
  resolveRunFile(runId, artifact, { write: true });
  const stored = storedManifestIdentity(runId, context);
  const verification = verifyRunManifest(runId, { expectComplete: false });
  if (!verification.ok) {
    throw new ManifestError(
      `${context} refused: the run's artifacts do not match its manifest:\n` +
        verification.findings
          .filter((finding) => finding.severity === 'error')
          .map((finding) => `  - [${finding.code}] ${finding.detail}`)
          .join('\n'),
      'ARTIFACTS_DO_NOT_MATCH',
    );
  }

  let grant: VerifiedGrant | null = null;
  if (stored.manifest.evidenceClass === 'public-release') {
    grant = assertVerifiedGrant(candidateGrant, context);
    assertGrantForRun(grant, runId, context);
    if (grant.manifestHash !== stored.hash) {
      throw new ManifestError(
        `${context} refused: permit ${grant.permitId} binds ${grant.manifestHash.slice(0, 12)}… but the stored manifest is ${stored.hash.slice(0, 12)}….`,
        'MANIFEST_GRANT_MISMATCH',
      );
    }
    Firewall.fromVerifiedPermit(grant).requireCapability('publication', context);
  } else if (candidateGrant !== undefined) {
    grant = assertVerifiedGrant(candidateGrant, context);
    assertGrantForRun(grant, runId, context);
    if (grant.manifestHash !== stored.hash) {
      throw new ManifestError(
        `${context} refused: supplied authority belongs to another manifest.`,
        'MANIFEST_GRANT_MISMATCH',
      );
    }
  }

  return {
    runId,
    manifest: stored.manifest,
    manifestHash: stored.hash,
    nonScoringBanner: stored.manifest.rankEligible ? null : NON_SCORING_LABEL,
    grant,
  };
}

export function readRunDigest(runId: string): ContentDigest {
  const path = resolveRunFile(runId, MANIFEST_DIGEST_FILE, { write: false });
  if (!existsSync(path)) {
    throw new ManifestError(
      `Run ${runId} has no ${MANIFEST_DIGEST_FILE}; its manifest's content hashes cannot be reconciled with any item set.`,
      'DIGEST_ABSENT',
    );
  }
  const raw = readJson(path, 'DIGEST_INVALID') as Partial<ContentDigest>;
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !Array.isArray(raw.itemIds) ||
    raw.itemIds.some((id) => typeof id !== 'string') ||
    typeof raw.items !== 'object' ||
    raw.items === null
  ) {
    throw new ManifestError(`Digest for ${runId} is malformed.`, 'DIGEST_INVALID');
  }
  return raw as ContentDigest;
}

// ---------------------------------------------------------------------------
// Verification — the second DATA-002 gap
// ---------------------------------------------------------------------------

export type VerificationCode =
  | 'MANIFEST_ABSENT'
  | 'MANIFEST_INVALID'
  | 'MANIFEST_HASH_ABSENT'
  | 'MANIFEST_HASH_MISMATCH'
  | 'DIGEST_ABSENT'
  | 'DIGEST_INVALID'
  | 'DIGEST_DOES_NOT_BACK_MANIFEST'
  | 'ITEM_MISSING_FROM_DATASET'
  | 'BANK_DRIFT'
  | 'PROMPT_DRIFT'
  | 'JUDGE_PROMPT_DRIFT'
  | 'VALIDATOR_DRIFT'
  | 'DERIVATION_INVALID'
  | 'RESPONSE_UNREADABLE'
  | 'RESPONSE_UNDECLARED_MODEL'
  | 'RESPONSE_UNDECLARED_ITEM'
  | 'RESPONSE_WRONG_RUN'
  | 'RESPONSE_DUPLICATE_CELL'
  | 'CELL_MISSING';

export interface VerificationFinding {
  code: VerificationCode;
  severity: 'error' | 'warning';
  detail: string;
  /** Item ids the finding concerns, where it is item-scoped. */
  items?: string[];
}

export interface VerificationReport {
  runId: string;
  manifestHash: string | null;
  ok: boolean;
  findings: VerificationFinding[];
}

/**
 * What a PRODUCTION caller may ask for.
 *
 * Exactly one switch, and it can only ever make the check stricter. Everything
 * that decides what "correct" means — which dataset the hashes are recomputed
 * from, whether they are recomputed at all — used to live here too, and that was
 * the defect: the run being verified could choose the verifier's inputs. Those
 * moved to `verifyRunManifestWithOverrides`, which refuses outside a test
 * process.
 */
export interface VerifyOptions {
  /** Require a stored response for every declared (model, item) cell. */
  expectComplete?: boolean;
}

/**
 * Trust inputs a TEST may substitute. Unreachable from the production entry
 * point, by construction rather than by convention.
 */
export interface VerifyOverrides {
  /**
   * Recompute the four hashes from the current working tree and compare.
   * Default true. False audits a frozen run whose bank has legitimately moved
   * on, checking only the run's own internal consistency.
   */
  recompute?: boolean;
  /** Substitute the dataset used for recomputation, to simulate drift. */
  dataset?: Question[];
}

/**
 * Verify that a run's stored artifacts are the ones its manifest declares.
 *
 * Two independent questions, deliberately kept apart:
 *
 *   1. Does the CURRENT working tree still produce the hashes this manifest
 *      declares? A "no" is drift — the bank, a prompt or a grader has changed
 *      since the manifest was frozen, and executing anything further under that
 *      manifest would let the changed bank masquerade as the manifested one.
 *   2. Do the run's OWN stored artifacts agree with the manifest — responses
 *      from undeclared models, answers to items outside the manifested set,
 *      responses stamped with another run's id?
 *
 * Never throws for a finding. Refusal is the caller's decision, made from
 * `ok`; `assertRunArtifactsMatchManifest` is the throwing form. What it does
 * refuse to do is return `ok: true` when it could not check something — an
 * unverifiable component is an error finding, not a silent pass.
 */
export function verifyRunManifest(runId: string, opts: VerifyOptions = {}): VerificationReport {
  return verify(runId, opts, {});
}

/**
 * The injectable form. Test-only: it lets the caller choose the bank the hashes
 * are recomputed against, which is precisely the authority a production caller
 * must not have.
 */
export function verifyRunManifestWithOverrides(
  runId: string,
  opts: VerifyOptions,
  overrides: VerifyOverrides,
): VerificationReport {
  assertTestSeam('verifyRunManifestWithOverrides');
  return verify(runId, opts, overrides);
}

function verify(runId: string, opts: VerifyOptions, overrides: VerifyOverrides): VerificationReport {
  const findings: VerificationFinding[] = [];
  const recompute = overrides.recompute ?? true;

  let manifest: ValidatedRunManifest;
  try {
    manifest = readRunManifest(runId);
  } catch (e) {
    const code = e instanceof ManifestError ? e.code : 'MANIFEST_INVALID';
    return {
      runId,
      manifestHash: null,
      ok: false,
      findings: [
        {
          code: code === 'MANIFEST_ABSENT' ? 'MANIFEST_ABSENT' : 'MANIFEST_INVALID',
          severity: 'error',
          detail: (e as Error).message,
        },
      ],
    };
  }

  // DATA-002: the run must carry the identity everything else refers to it by.
  // An absent sidecar is a refusal, not a "pre-sidecar run" — there is no such
  // thing under this methodology, and treating absence as legacy is how a
  // hand-assembled run directory would pass.
  const declaredHash = manifestHash(manifest);
  const recorded = readRunManifestHash(runId);
  if (recorded.state === 'absent') {
    findings.push({
      code: 'MANIFEST_HASH_ABSENT',
      severity: 'error',
      detail: `Run ${runId} has no ${MANIFEST_HASH_FILE}. The manifest's own digest is what a permit signs and what the release register binds; a run that does not record it cannot be tied to any approval.`,
    });
  } else if (recorded.state === 'malformed' || recorded.hash !== declaredHash) {
    findings.push({
      code: 'MANIFEST_HASH_MISMATCH',
      severity: 'error',
      detail:
        `${MANIFEST_HASH_FILE} records ${recorded.state === 'malformed' ? JSON.stringify(recorded.raw) : `${recorded.hash.slice(0, 12)}…`} ` +
        `but ${MANIFEST_FILE} hashes to ${declaredHash.slice(0, 12)}…. One of the two was edited after the fact.`,
    });
  }

  let digest: ContentDigest | null = null;
  try {
    digest = readRunDigest(runId);
  } catch (e) {
    findings.push({
      code: e instanceof ManifestError && e.code === 'DIGEST_ABSENT' ? 'DIGEST_ABSENT' : 'DIGEST_INVALID',
      severity: 'error',
      detail: (e as Error).message,
    });
  }

  if (digest) {
    // The digest is the manifest's own working: if it does not reproduce the
    // manifest's four hashes, one of the two files has been edited by hand and
    // neither can be trusted as the record of what ran.
    for (const field of HASH_FIELDS) {
      if (digest[field] !== manifest[field]) {
        findings.push({
          code: 'DIGEST_DOES_NOT_BACK_MANIFEST',
          severity: 'error',
          detail: `${MANIFEST_DIGEST_FILE} records ${field} ${String(digest[field]).slice(0, 12)}… but ${MANIFEST_FILE} declares ${manifest[field].slice(0, 12)}….`,
        });
      }
    }

    if (recompute) {
      const dataset = new Map((overrides.dataset ?? loadDatasetSafely(findings)).map((q) => [q.id, q]));
      const missing = digest.itemIds.filter((id) => !dataset.has(id));
      if (missing.length > 0) {
        findings.push({
          code: 'ITEM_MISSING_FROM_DATASET',
          severity: 'error',
          detail: `${missing.length} manifested item(s) are no longer in the dataset, so the declared hashes cannot be reproduced: ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ', …' : ''}.`,
          items: missing,
        });
      } else {
        const questions = digest.itemIds.map((id) => dataset.get(id) as Question);
        let current: ContentDigest | null = null;
        try {
          current = computeContentDigest(questions, {
            maxTokens: manifest.generationSettings.maxTokens,
            maxTokensRecipe: manifest.generationSettings.maxTokensRecipe,
          });
        } catch (e) {
          findings.push({
            code: 'BANK_DRIFT',
            severity: 'error',
            detail: `The manifested item set no longer produces a digest at all: ${(e as Error).message}`,
          });
        }
        if (current) {
          // Bound to a const: control-flow narrowing of a mutable `let` does not
          // survive into the callbacks below.
          const now = current;
          const driftCode: Record<HashField, VerificationCode> = {
            bankHash: 'BANK_DRIFT',
            promptHash: 'PROMPT_DRIFT',
            judgePromptHash: 'JUDGE_PROMPT_DRIFT',
            validatorHash: 'VALIDATOR_DRIFT',
          };
          const declared = digest;
          for (const field of HASH_FIELDS) {
            if (now[field] !== manifest[field]) {
              const changed = declared.itemIds.filter(
                (id) => componentOf(declared.items[id], field) !== componentOf(now.items[id], field),
              );
              findings.push({
                code: driftCode[field],
                severity: 'error',
                detail:
                  `${field} declared ${manifest[field].slice(0, 12)}… but the working tree now computes ${now[field].slice(0, 12)}…` +
                  (field === 'validatorHash'
                    ? ' (grader source changed).'
                    : ` (${changed.length} item(s) differ).`),
                ...(changed.length > 0 ? { items: changed } : {}),
              });
            }
          }
        }
      }
    }
  }

  verifyStoredResponses(runId, manifest, digest, opts.expectComplete ?? false, findings);

  return {
    runId,
    manifestHash: declaredHash,
    ok: !findings.some((f) => f.severity === 'error'),
    findings,
  };
}

function componentOf(item: ItemDigest | undefined, field: HashField): string | null | undefined {
  if (!item) return undefined;
  if (field === 'bankHash') return item.item;
  if (field === 'promptHash') return item.prompt;
  if (field === 'judgePromptHash') return item.judgePrompt;
  return undefined; // validatorHash is not item-scoped
}

/**
 * Run ids whose responses this run legitimately carries.
 *
 * A source id inside derivation.json is attacker-controlled input until the
 * complete lineage has been verified. It is accepted only when the record's
 * source is the manifest's exact parent, both response directories are the
 * exact recorded set, and every response still matches the committed source.
 */
function inheritedSourceRuns(
  runId: string,
  manifest: ValidatedRunManifest,
  findings: VerificationFinding[],
): string[] {
  const path = resolveRunFile(runId, DERIVATION_FILE, { write: false });
  if (!existsSync(path)) return [];

  const verification = verifyDerivationForManifest(runId, manifest.parentArtifacts);
  if (!verification.ok || verification.sourceRunId === null) {
    findings.push({
      code: 'DERIVATION_INVALID',
      severity: 'error',
      detail: `Run ${runId} has invalid derivation lineage: ${verification.problems.join('; ')}`,
    });
    return [];
  }
  return [verification.sourceRunId];
}

function loadDatasetSafely(findings: VerificationFinding[]): Question[] {
  try {
    return loadQuestions();
  } catch (e) {
    findings.push({
      code: 'BANK_DRIFT',
      severity: 'error',
      detail: `The dataset does not load, so no declared hash can be reproduced: ${(e as Error).message}`,
    });
    return [];
  }
}

/**
 * Cross-check the run's stored answers against its declared envelope.
 *
 * Responses are read for their `runId`, `modelId` and `questionId` only, so
 * this does not depend on the filename encoding in store.ts — a response that
 * was written under the legacy lossy encoding is still checked on its contents.
 */
function verifyStoredResponses(
  runId: string,
  manifest: ValidatedRunManifest,
  digest: ContentDigest | null,
  expectComplete: boolean,
  findings: VerificationFinding[],
): void {
  const dir = resolveRunFile(runId, 'responses', { write: false });
  // An ABSENT responses directory is zero responses, not "nothing to check".
  // Returning early here made a run with no answers at all pass `expectComplete`
  // — the one state where the completeness check matters most.
  const stored = existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )
    : [];

  const declaredModels = new Set(manifest.candidateRoutes.map((r) => r.modelId));
  const declaredItems = digest ? new Set(digest.itemIds) : null;
  const seen = new Set<string>();
  // A derived run's answers legitimately carry the SOURCE run's id: they are
  // byte-for-byte copies, and rewriting the stamp would destroy that evidence.
  // A claimed lineage does not create this exemption by itself; exact lineage
  // verification above must succeed before the source stamp becomes acceptable.
  const acceptableRunIds = new Set<string>([
    runId,
    ...inheritedSourceRuns(runId, manifest, findings),
  ]);

  for (const entry of stored) {
    const file = entry.name;
    // The response set is exact. Ignoring a linked, nested or differently
    // named entry would let bytes live inside the evidence directory without
    // being checked or committed by the same interpretation as publication.
    if (!entry.isFile() || !file.endsWith('.json')) {
      findings.push({
        code: 'RESPONSE_UNREADABLE',
        severity: 'error',
        detail: `responses/${file} is not a regular JSON response file.`,
      });
      continue;
    }
    let response: { runId?: unknown; modelId?: unknown; questionId?: unknown };
    try {
      response = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      findings.push({
        code: 'RESPONSE_UNREADABLE',
        severity: 'error',
        detail: `responses/${file} is not valid JSON (${(e as Error).message}).`,
      });
      continue;
    }
    const modelId = typeof response.modelId === 'string' ? response.modelId : null;
    const questionId = typeof response.questionId === 'string' ? response.questionId : null;
    if (!modelId || !questionId) {
      findings.push({
        code: 'RESPONSE_UNREADABLE',
        severity: 'error',
        detail: `responses/${file} does not carry a modelId and questionId.`,
      });
      continue;
    }
    if (typeof response.runId !== 'string' || !acceptableRunIds.has(response.runId)) {
      // A response stamped with an id this run neither owns nor inherits is how
      // copied evidence would enter a run unnoticed.
      findings.push({
        code: 'RESPONSE_WRONG_RUN',
        severity: 'error',
        detail:
          `responses/${file} is stamped runId ${JSON.stringify(response.runId)} but stored under '${runId}', ` +
          `which inherits from [${[...acceptableRunIds].filter((r) => r !== runId).join(', ') || 'nothing'}].`,
      });
    }
    if (!declaredModels.has(modelId)) {
      findings.push({
        code: 'RESPONSE_UNDECLARED_MODEL',
        severity: 'error',
        detail: `responses/${file} is from '${modelId}', which the manifest does not declare as a candidate route.`,
      });
    }
    if (declaredItems && !declaredItems.has(questionId)) {
      findings.push({
        code: 'RESPONSE_UNDECLARED_ITEM',
        severity: 'error',
        detail: `responses/${file} answers '${questionId}', which is outside the manifested item set.`,
        items: [questionId],
      });
    }
    const cell = `${modelId}\u0000${questionId}`;
    if (seen.has(cell)) {
      findings.push({
        code: 'RESPONSE_DUPLICATE_CELL',
        severity: 'error',
        detail: `responses/${file} duplicates the declared cell ${modelId} × ${questionId}. A manifest authorises one response per cell under the supported single-repeat protocol.`,
        items: [questionId],
      });
    }
    seen.add(cell);
  }

  if (expectComplete && digest) {
    const missing: string[] = [];
    for (const modelId of declaredModels) {
      for (const questionId of digest.itemIds) {
        if (!seen.has(`${modelId}\u0000${questionId}`)) missing.push(`${modelId} × ${questionId}`);
      }
    }
    if (missing.length > 0) {
      findings.push({
        code: 'CELL_MISSING',
        severity: 'error',
        detail: `${missing.length} declared cell(s) have no stored response: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}.`,
      });
    }
  }
}

/**
 * Every name for "this run" must be the same name (RELEASE-002).
 *
 * Four independent strings claim to identify one run: the id the operator asked
 * for, the id the permit authorises, the id inside the manifest the permit was
 * signed against, and the id stamped on the artifacts. Any one of them differing
 * means an approval for one run is being spent on another, and each of the four
 * was previously checked in a different place, or not at all — `publish` never
 * compared the permit's run id with the run it published.
 *
 * Undefined is not "agrees". A caller that cannot supply one of these has not
 * established it, so it must not be passed; the fields are required.
 */
export interface RunIdentityClaims {
  /** What the operator asked for on the command line. */
  requested: string;
  /** `grant.runId` — the run the signature authorises. */
  permit: string;
  /** `manifest.runId` from the manifest the permit is bound to by hash. */
  manifest: string;
  /** The id stamped inside the run's own artifacts (config, board, responses). */
  artifact: string;
}

export function assertRunIdentity(claims: RunIdentityClaims, context: string): string {
  const entries = Object.entries(claims) as Array<[keyof RunIdentityClaims, string]>;
  for (const [source, value] of entries) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ManifestError(
        `${context}: the ${source} run id is ${JSON.stringify(value)}. An unestablished identity is not a matching one.`,
        'RUN_IDENTITY_MISMATCH',
      );
    }
  }
  const distinct = [...new Set(entries.map(([, value]) => value))];
  if (distinct.length > 1) {
    throw new ManifestError(
      `${context}: run identity disagrees — ` +
        entries.map(([source, value]) => `${source}='${value}'`).join(', ') +
        `. An approval binds one run; spending it on another is the whole failure mode.`,
      'RUN_IDENTITY_MISMATCH',
    );
  }
  return distinct[0]!;
}

/** Throwing form, for gates that should refuse rather than branch. */
export function assertRunArtifactsMatchManifest(
  runId: string,
  opts: VerifyOptions = {},
): VerificationReport {
  const report = verifyRunManifest(runId, opts);
  if (!report.ok) {
    const errors = report.findings.filter((f) => f.severity === 'error');
    throw new ManifestError(
      `Run ${runId} does not match its manifest (${errors.length} error(s)):\n` +
        errors.map((f) => `  - [${f.code}] ${f.detail}`).join('\n'),
      'ARTIFACTS_DO_NOT_MATCH',
    );
  }
  return report;
}
