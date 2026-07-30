import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  expectedOutputRoot,
  safeParseRunManifest,
  type Question,
  type ValidatedRunManifest,
} from '@cookingbench/core';
import { REPO_ROOT, buildMessages, loadQuestions, maxTokensFor } from './dataset.js';
import { resolveRunFile, writeRunFileAtomic } from './firewall.js';
import {
  JUDGE_PROMPT_VERSIONS,
  buildDimensionJudgeMessages,
  buildJudgeMessages,
  buildPairwiseJudgeMessages,
  judgeModeOf,
} from './judge.js';
import { manifestHash, sha256Hex } from './permit.js';

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
 *   validatorHash   Grader SOURCE. A grader has no rendered form, so source is
 *                   the only honest level. The 2026-07 grader audit is the case
 *                   for it: a fixed keyword grader moved six of thirteen
 *                   positions, and nothing in the artifacts recorded that the
 *                   scoring code had changed underneath them.
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
  | 'DIGEST_ABSENT'
  | 'DIGEST_INVALID'
  | 'DATASET_INVALID'
  | 'JUDGE_PROMPT_UNRENDERABLE'
  | 'VALIDATOR_SOURCE_MISSING'
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

export const DIGEST_VERSION = 1;

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
 * Grader source that `validatorHash` covers.
 *
 * The graders directory is LISTED rather than enumerated by hand. A hard-coded
 * list is fail-open by construction: adding `graders/newthing.ts` would leave it
 * outside the hash, and the one thing this digest exists to catch is scoring
 * code changing without the artifacts noticing.
 */
const VALIDATOR_DIR = join('packages', 'core', 'src', 'graders');

/**
 * Validators outside the graders directory, named individually because they are
 * not discoverable by listing. Each is recorded with `present: true|false`, so
 * an absent file is a stated fact inside the digest rather than a silently
 * shorter list — deletion changes the hash either way, but the reader can see
 * which happened.
 */
const NAMED_VALIDATOR_FILES = [
  join('packages', 'core', 'src', 'kitchenplan.ts'),
  join('packages', 'core', 'src', 'graders.ts'),
];

// ---------------------------------------------------------------------------
// Content digests
// ---------------------------------------------------------------------------

export interface ValidatorFileDigest {
  path: string;
  present: boolean;
  sha256: string | null;
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

/** Grader source, discovered rather than enumerated. */
export function validatorDigest(): { validatorHash: string; files: ValidatorFileDigest[] } {
  const graderDir = join(REPO_ROOT, VALIDATOR_DIR);
  if (!existsSync(graderDir)) {
    throw new ManifestError(
      `Grader source directory ${VALIDATOR_DIR} is missing. Refusing to hash a validator set that cannot be read.`,
      'VALIDATOR_SOURCE_MISSING',
    );
  }
  const discovered = readdirSync(graderDir)
    .filter((f) => f.endsWith('.ts'))
    .sort()
    .map((f) => join(VALIDATOR_DIR, f));
  const files: ValidatorFileDigest[] = [...discovered, ...NAMED_VALIDATOR_FILES]
    .map((path) => ({ path, present: existsSync(join(REPO_ROOT, path)), sha256: readSourceHash(path) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (discovered.length === 0) {
    throw new ManifestError(
      `No grader sources found in ${VALIDATOR_DIR}. An empty validator set hashes to a stable value that binds nothing.`,
      'VALIDATOR_SOURCE_MISSING',
    );
  }
  return { validatorHash: digest('cookingbench/validator', files), files };
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

  const items: Record<string, ItemDigest> = {};
  for (const q of sorted) {
    const judge = judgePromptHashFor(q);
    items[q.id] = {
      item: itemHash(q),
      prompt: promptHashFor(q, settings),
      judgePrompt: judge.hash,
      judgeMode: judge.mode,
    };
  }
  const ids = sorted.map((q) => q.id);
  const validator = validatorDigest();

  return {
    digestVersion: DIGEST_VERSION,
    itemIds: ids,
    bankHash: digest(
      'cookingbench/bank',
      ids.map((id) => [id, items[id].item]),
    ),
    promptHash: digest(
      'cookingbench/prompt-set',
      ids.map((id) => [id, items[id].prompt]),
    ),
    judgePromptHash: digest(
      'cookingbench/judge-prompt-set',
      ids.map((id) => [id, items[id].judgePrompt]),
    ),
    validatorHash: validator.validatorHash,
    items,
    validatorFiles: validator.files,
  };
}

// ---------------------------------------------------------------------------
// Building and writing the envelope
// ---------------------------------------------------------------------------

const HASH_FIELDS = ['bankHash', 'promptHash', 'judgePromptHash', 'validatorHash'] as const;
type HashField = (typeof HASH_FIELDS)[number];

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
): { manifest: ValidatedRunManifest; digest: ContentDigest; manifestHash: string } {
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
  manifest: ValidatedRunManifest;
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
  return { manifest, manifestHash: hash, digest: computed, written: true };
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
  | 'DIGEST_ABSENT'
  | 'DIGEST_INVALID'
  | 'DIGEST_DOES_NOT_BACK_MANIFEST'
  | 'ITEM_MISSING_FROM_DATASET'
  | 'BANK_DRIFT'
  | 'PROMPT_DRIFT'
  | 'JUDGE_PROMPT_DRIFT'
  | 'VALIDATOR_DRIFT'
  | 'RESPONSE_UNREADABLE'
  | 'RESPONSE_UNDECLARED_MODEL'
  | 'RESPONSE_UNDECLARED_ITEM'
  | 'RESPONSE_WRONG_RUN'
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

export interface VerifyOptions {
  /**
   * Recompute the four hashes from the current working tree and compare.
   * Default true. Set false to audit a frozen run whose bank has legitimately
   * moved on, in which case only the run's own internal consistency is checked.
   */
  recompute?: boolean;
  /** Require a stored response for every declared (model, item) cell. */
  expectComplete?: boolean;
  /** Override the dataset used for recomputation. Defaults to the repository's. */
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
  const findings: VerificationFinding[] = [];
  const recompute = opts.recompute ?? true;

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
      const dataset = new Map((opts.dataset ?? loadDatasetSafely(findings)).map((q) => [q.id, q]));
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
    manifestHash: manifestHash(manifest),
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
  if (!existsSync(dir)) return;

  const declaredModels = new Set(manifest.candidateRoutes.map((r) => r.modelId));
  const declaredItems = digest ? new Set(digest.itemIds) : null;
  const seen = new Set<string>();

  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let stored: { runId?: unknown; modelId?: unknown; questionId?: unknown };
    try {
      stored = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch (e) {
      findings.push({
        code: 'RESPONSE_UNREADABLE',
        severity: 'error',
        detail: `responses/${file} is not valid JSON (${(e as Error).message}).`,
      });
      continue;
    }
    const modelId = typeof stored.modelId === 'string' ? stored.modelId : null;
    const questionId = typeof stored.questionId === 'string' ? stored.questionId : null;
    if (!modelId || !questionId) {
      findings.push({
        code: 'RESPONSE_UNREADABLE',
        severity: 'error',
        detail: `responses/${file} does not carry a modelId and questionId.`,
      });
      continue;
    }
    if (stored.runId !== runId) {
      // A response stamped with another run's id inside this run's directory is
      // how copied evidence would enter a run unnoticed. derive.ts restamps.
      findings.push({
        code: 'RESPONSE_WRONG_RUN',
        severity: 'error',
        detail: `responses/${file} is stamped runId '${String(stored.runId)}' but stored under '${runId}'.`,
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
    seen.add(`${modelId} ${questionId}`);
  }

  if (expectComplete && digest) {
    const missing: string[] = [];
    for (const modelId of declaredModels) {
      for (const questionId of digest.itemIds) {
        if (!seen.has(`${modelId} ${questionId}`)) missing.push(`${modelId} × ${questionId}`);
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
