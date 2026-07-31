import { existsSync, readFileSync } from 'node:fs';
import {
  RELEASE_STATES,
  canPublish,
  canonicalJson,
  safeParseRunManifest,
  type ReleaseState,
  type Score,
  type StoredResponse,
  type ValidatedRunManifest,
} from '@cookingbench/core';
import {
  ADJUDICATION_QUEUE_FILE,
  adjudicationStatus,
  readAdjudicationRecord,
  type AdjudicationQueue,
} from './adjudicate.js';
import { loadQuestions } from './dataset.js';
import {
  appendRunFileLine,
  assertPublishable,
  isHistoricalRun,
  nonScoringBanner,
  resolveOutputPath,
  resolveRunFile,
  writeOutputFileAtomic,
  writeRunFileAtomic,
} from './firewall.js';
import { assertSourceCommitted } from './derive.js';
import {
  MANIFEST_FILE,
  MANIFEST_HASH_FILE,
  ManifestError,
  assertRunIdentity,
  assertTestSeam,
  computeContentDigest,
  readRunDigest,
  readRunManifest,
  readRunManifestHash,
  verifyRunManifest,
  type ContentDigest,
  type RecordedManifestHash,
  type VerificationReport,
} from './manifest.js';
import { manifestHash, sha256Hex } from './permit.js';
import { readResponses, readScores } from './store.js';

/**
 * M4.7 and M4.8 — run lifecycle, stale-score invalidation, and the durable
 * identities everything else hangs off.
 *
 * Four things live here because they are one story: a run has an identity, its
 * evidence is written append-only under that identity, its scores are valid only
 * while the manifest that produced them still holds, and it moves through an
 * explicit reviewed lifecycle before anything it produced becomes "the current
 * result".
 *
 * The load-bearing one is the third. `bench grade` currently "preserves prior
 * judge results" — an optimisation that is correct only while nothing that
 * produced them has changed, and nothing checked. A changed judge prompt, an
 * edited reference answer, a re-seated panel or a fixed grader all leave the old
 * numbers in place looking exactly like fresh ones. `detectStaleScores` decides
 * that by hash comparison and `retainableScores` DROPS what no longer holds;
 * there is deliberately no "keep anyway" flag, because a flag like that is what
 * an operator reaches for at 2am.
 *
 * The site's newest-`generatedAt` heuristic is the other defect this closes. A
 * board becomes current because a human reviewed it and said so, recorded in
 * `data/runs/REGISTER.json` with the checklist digest that backed the decision —
 * not because its file happens to carry the latest timestamp.
 */

export type LifecycleErrorCode =
  | 'REGISTER_INVALID'
  | 'RUN_NOT_REGISTERED'
  | 'RUN_ALREADY_REGISTERED'
  | 'UNKNOWN_STATE'
  | 'ILLEGAL_TRANSITION'
  | 'EVIDENCE_REQUIRED'
  | 'CHECKLIST_INCOMPLETE'
  | 'CHECKLIST_MISMATCH'
  | 'NOT_RELEASED'
  | 'NO_CURRENT_RUN'
  | 'JOURNAL_CORRUPT'
  | 'JOURNAL_ID_REQUIRED'
  | 'ARTIFACT_MISSING'
  | 'ARTIFACT_CHANGED'
  | 'NOT_PUBLISHABLE';

export class LifecycleError extends Error {
  constructor(
    message: string,
    readonly code: LifecycleErrorCode,
  ) {
    super(message);
    this.name = 'LifecycleError';
  }
}

// ---------------------------------------------------------------------------
// M4.8 — deterministic ids and idempotent retry keys
// ---------------------------------------------------------------------------

/**
 * Namespace folded into every id.
 *
 * Without it, two id kinds that happen to carry the same fields would produce
 * the same digest, and a response id could be mistaken for a ballot id in any
 * store keyed by id alone. The kind is INSIDE the hashed structure, not merely
 * a prefix on the output, so the collision is impossible rather than unlikely.
 */
export const ID_NAMESPACE = 'cookingbench/id/1';

function identity(kind: string, parts: Record<string, unknown>): string {
  return `${kind}_${sha256Hex(canonicalJson({ ns: ID_NAMESPACE, kind, parts }))}`;
}

/**
 * A run's deterministic identity is its manifest hash.
 *
 * Not the run id: two runs could be given the same id in two checkouts, and the
 * point of a deterministic identity is that it is derived from content. The run
 * id remains the human-facing, path-bearing name.
 */
export function runIdentity(manifest: unknown): string {
  return `run_${manifestHash(manifest)}`;
}

/** An item's identity is its id plus its content hash: `subs-020` at one version. */
export function itemIdentity(questionId: string, itemHash: string): string {
  return identity('item', { questionId, itemHash });
}

export interface ResponseKey {
  runId: string;
  modelId: string;
  questionId: string;
  /** 0 for a single-response protocol; M4.2 repeats index from 0. */
  repeatIndex?: number;
}

export function responseIdentity(key: ResponseKey): string {
  return identity('resp', {
    runId: key.runId,
    modelId: key.modelId,
    questionId: key.questionId,
    repeatIndex: key.repeatIndex ?? 0,
  });
}

export interface BallotKey extends ResponseKey {
  judgeModelId: string;
  /** JUDGE_PROMPT_VERSIONS[mode]; a ballot is only comparable within its version. */
  promptVersion: string;
  /** Pairwise only: which answer was shown first. */
  presentationOrder?: string;
  /** Repeat judge calls on the same answer are separate evidence (M4.5). */
  judgeRepeatIndex?: number;
}

export function ballotIdentity(key: BallotKey): string {
  return identity('ballot', {
    runId: key.runId,
    modelId: key.modelId,
    questionId: key.questionId,
    repeatIndex: key.repeatIndex ?? 0,
    judgeModelId: key.judgeModelId,
    promptVersion: key.promptVersion,
    presentationOrder: key.presentationOrder ?? null,
    judgeRepeatIndex: key.judgeRepeatIndex ?? 0,
  });
}

/**
 * The idempotent retry key for a candidate call.
 *
 * It deliberately does NOT include the attempt number. A key that changed on
 * every retry would be unique per attempt and therefore idempotent for nothing —
 * the whole purpose is that attempt 2 of a cell is recognised as the same unit
 * of work as attempt 1, so a resumed process does not pay for it twice and a
 * duplicate delivery does not append a second answer. Attempts are recorded
 * AGAINST the key, not folded into it.
 */
export function candidateRetryKey(key: ResponseKey): string {
  return responseIdentity(key);
}

/** The same rule for a judge call: the seat and the answer, never the attempt. */
export function judgeRetryKey(key: BallotKey): string {
  return ballotIdentity(key);
}

// ---------------------------------------------------------------------------
// M4.8 — append-only, tamper-evident journals
// ---------------------------------------------------------------------------

export const ANSWER_JOURNAL = 'raw/answers.ndjson';
export const BALLOT_JOURNAL = 'raw/ballots.ndjson';
export const LIFECYCLE_JOURNAL = 'lifecycle.ndjson';

/**
 * Domain-separated genesis link.
 *
 * Not a run of zeroes: `0`×64 is a legal sha256 output, so a forged first line
 * claiming it could not be distinguished from the real start of a chain.
 */
export const GENESIS_LINK = sha256Hex('cookingbench/journal/genesis');

export interface JournalEntry {
  id: string;
  /** sha256 of the previous LINE's exact text, or GENESIS_LINK. */
  prev: string;
  recordedAt: string;
  body: unknown;
}

export interface JournalVerification {
  /** The hash chain is unbroken. TRUE for an absent journal — see `present`. */
  ok: boolean;
  /** The journal file exists at all. */
  present: boolean;
  entries: JournalEntry[];
  problems: string[];
}

function journalExists(runId: string, journal: string): boolean {
  return existsSync(resolveRunFile(runId, journal, { write: false }));
}

function journalLines(runId: string, journal: string): string[] {
  const path = resolveRunFile(runId, journal, { write: false });
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
}

/**
 * Walk a journal's hash chain.
 *
 * Append-only is a property of a FILE, and a file can be rewritten. Chaining
 * each record to the digest of the previous line makes any deletion, reordering
 * or edit visible: only the tail can be extended without breaking the chain.
 * That is what makes "append-only storage for raw answers and ballots" a check
 * rather than a convention.
 *
 * KNOWN LIMIT, stated rather than hidden: a chain cannot detect its own SUFFIX
 * being cut off. Removing the last k lines leaves a perfectly valid chain. Two
 * things close that from outside — `journalHead` pinned in an external record,
 * and the release checklist's `artifacts-committed` item, since git holds the
 * full file. Neither is inside this function, and it would be dishonest to
 * describe it as tamper-proof.
 */
export function verifyJournal(runId: string, journal: string): JournalVerification {
  const lines = journalLines(runId, journal);
  const entries: JournalEntry[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  let expectedPrev = GENESIS_LINK;

  lines.forEach((line, index) => {
    let entry: JournalEntry;
    try {
      entry = JSON.parse(line) as JournalEntry;
    } catch (e) {
      problems.push(`line ${index + 1} is not valid JSON (${(e as Error).message})`);
      return;
    }
    if (typeof entry.id !== 'string' || entry.id === '' || typeof entry.prev !== 'string') {
      problems.push(`line ${index + 1} is missing a string id or prev link`);
      return;
    }
    if (seen.has(entry.id)) {
      problems.push(`line ${index + 1} repeats id ${entry.id}; a journal id is the idempotency key and must be unique`);
    }
    seen.add(entry.id);
    if (entry.prev !== expectedPrev) {
      problems.push(
        `line ${index + 1} links to ${entry.prev.slice(0, 12)}… but the previous line hashes to ${expectedPrev.slice(0, 12)}…`,
      );
    }
    expectedPrev = sha256Hex(line);
    entries.push(entry);
  });

  return { ok: problems.length === 0, present: journalExists(runId, journal), entries, problems };
}

/**
 * The release-grade reading of a journal: present, non-empty AND unbroken.
 *
 * `verifyJournal` deliberately calls an absent journal's chain intact, because
 * `appendJournalEntry` has to be able to write the first line. For a RELEASE
 * that reading is wrong in the most dangerous direction: a run that journalled
 * nothing at all — because the writer was never wired up, or because the file
 * was deleted — produced an empty problem list and read as "journals intact".
 * An empty journal is not an intact journal; it is an absent record of the
 * evidence the run is supposed to be made of.
 */
export function journalProblemsForRelease(runId: string, journal: string): string[] {
  const result = verifyJournal(runId, journal);
  if (!result.present) {
    return [`${journal} does not exist; the run has no append-only record of this evidence`];
  }
  if (result.entries.length === 0 && result.problems.length === 0) {
    return [`${journal} exists but holds no entries; an empty journal is not an intact journal`];
  }
  return result.problems.map((p) => `${journal}: ${p}`);
}

/**
 * The chain head: sha256 of the last line, or GENESIS_LINK for an empty
 * journal. Pin this somewhere outside the run to make suffix truncation
 * detectable — inside the file it never can be.
 */
export function journalHead(runId: string, journal: string): string {
  const last = journalLines(runId, journal).at(-1);
  return last === undefined ? GENESIS_LINK : sha256Hex(last);
}

/** Entries, or a refusal. A caller must never read evidence off a broken chain. */
export function readJournal(runId: string, journal: string): JournalEntry[] {
  const verification = verifyJournal(runId, journal);
  if (!verification.ok) {
    throw new LifecycleError(
      `Journal ${journal} in run ${runId} is not intact:\n${verification.problems.map((p) => `  - ${p}`).join('\n')}`,
      'JOURNAL_CORRUPT',
    );
  }
  return verification.entries;
}

export interface AppendResult {
  appended: boolean;
  id: string;
  index: number;
}

/**
 * Append one record, idempotently.
 *
 * Re-appending an id already present is a no-op, which is what makes a retried
 * or resumed command safe: the retry key IS the journal id, so the second
 * delivery of the same unit of work adds nothing. Appending onto a journal whose
 * chain is already broken is refused outright — extending a corrupt record makes
 * the corruption harder to find and gives it a valid-looking tail.
 */
export function appendJournalEntry(
  runId: string,
  journal: string,
  id: string,
  body: unknown,
  now: Date = new Date(),
): AppendResult {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new LifecycleError(
      `A journal entry needs a deterministic id (see responseIdentity / ballotIdentity); got ${JSON.stringify(id)}.`,
      'JOURNAL_ID_REQUIRED',
    );
  }
  const lines = journalLines(runId, journal);
  const verification = verifyJournal(runId, journal);
  if (!verification.ok) {
    throw new LifecycleError(
      `Refusing to append to ${journal} in run ${runId}: the existing chain is broken.\n${verification.problems.map((p) => `  - ${p}`).join('\n')}`,
      'JOURNAL_CORRUPT',
    );
  }
  const existing = verification.entries.findIndex((e) => e.id === id);
  if (existing >= 0) return { appended: false, id, index: existing };

  const last = lines.at(-1);
  const prev = last === undefined ? GENESIS_LINK : sha256Hex(last);
  const line = canonicalJson({ id, prev, recordedAt: now.toISOString(), body } satisfies JournalEntry);
  appendRunFileLine(runId, journal, line);
  return { appended: true, id, index: lines.length };
}

/** The raw answer record. Written in addition to responses/, never instead of it. */
export function appendRawAnswer(
  response: Pick<
    StoredResponse,
    'runId' | 'modelId' | 'questionId' | 'answerText' | 'finishReason' | 'transportFailure' | 'costUsd' | 'tokensIn' | 'tokensOut'
  > & { repeatIndex?: number },
  now?: Date,
): AppendResult {
  const id = responseIdentity(response);
  return appendJournalEntry(response.runId, ANSWER_JOURNAL, id, { ...response, responseId: id }, now);
}

export function appendBallot(key: BallotKey, ballot: unknown, now?: Date): AppendResult {
  const id = ballotIdentity(key);
  return appendJournalEntry(key.runId, BALLOT_JOURNAL, id, { ...key, ballotId: id, ballot }, now);
}

// ---------------------------------------------------------------------------
// M4.7 — no preservation of stale judge scores
// ---------------------------------------------------------------------------

export type InvalidationScope = 'candidate' | 'deterministic' | 'judge';

export const INVALIDATION_CODES = [
  'MANIFEST_UNREADABLE',
  'METHODOLOGY_CHANGED',
  'GENERATION_SETTINGS_CHANGED',
  'PROMPT_CHANGED',
  'BANK_CHANGED',
  'JUDGE_PROMPT_CHANGED',
  'PANEL_CHANGED',
  'VALIDATOR_CHANGED',
] as const;
export type InvalidationCode = (typeof INVALIDATION_CODES)[number];

export interface InvalidationReason {
  code: InvalidationCode;
  scopes: InvalidationScope[];
  detail: string;
  /** Item ids affected, or null for "every item". */
  items: string[] | null;
}

export interface StaleScoreVerdict {
  reasons: InvalidationReason[];
  /** Per scope: 'all', or the item ids invalidated. */
  invalidated: Record<InvalidationScope, 'all' | string[]>;
  invalidatesEverything: boolean;
}

export interface ManifestSnapshot {
  manifest: unknown;
  /** The component digests, where available. Only used to LOCALISE a change. */
  digest?: unknown;
}

const ALL_SCOPES: InvalidationScope[] = ['candidate', 'deterministic', 'judge'];

/**
 * Decide what a manifest change invalidates.
 *
 * Fails closed at every unknown. An unreadable prior manifest invalidates
 * everything, because "we cannot tell what produced these scores" and "these
 * scores are fine" are not the same sentence — and the second one is how stale
 * numbers survive a methodology change.
 *
 * The scope decomposition is deliberate and is not symmetric:
 *
 *   promptHash    → CANDIDATE. The answers were elicited differently, so
 *                   everything downstream of them goes.
 *   bankHash      → DETERMINISTIC + JUDGE, but NOT candidate. An edited expected
 *                   value or reference answer changes how an answer is scored
 *                   without changing the answer, so the answer survives and the
 *                   score does not.
 *   judgePromptHash → JUDGE.
 *   judgeRoutes   → JUDGE. A re-seated panel is a different measuring
 *                   instrument; the run that seated grok in the qwen seat found
 *                   96.20 against 88.16 on the same answers.
 *   validatorHash → DETERMINISTIC, which by the dependency rule below reaches
 *                   every score. The graders module also owns blending and
 *                   cascade routing, and the 2026-07 audit's grader fix moved
 *                   six of thirteen leaderboard positions.
 */
export function detectStaleScores(prior: ManifestSnapshot, current: ManifestSnapshot): StaleScoreVerdict {
  const reasons: InvalidationReason[] = [];

  const before = safeParseRunManifest(prior.manifest);
  if (!before.ok) {
    reasons.push({
      code: 'MANIFEST_UNREADABLE',
      scopes: [...ALL_SCOPES],
      detail: `The manifest that produced these scores does not validate (${before.error}). "We cannot tell what produced these" is not "these are fine".`,
      items: null,
    });
    return summarise(reasons);
  }
  const after = safeParseRunManifest(current.manifest);
  if (!after.ok) {
    reasons.push({
      code: 'MANIFEST_UNREADABLE',
      scopes: [...ALL_SCOPES],
      detail: `The manifest they would be reused under does not validate (${after.error}).`,
      items: null,
    });
    return summarise(reasons);
  }

  const priorDigest = readDigestSnapshot(prior.digest);
  const currentDigest = readDigestSnapshot(current.digest);

  if (before.manifest.methodologyVersion !== after.manifest.methodologyVersion) {
    reasons.push({
      code: 'METHODOLOGY_CHANGED',
      scopes: [...ALL_SCOPES],
      detail: `methodologyVersion ${before.manifest.methodologyVersion} → ${after.manifest.methodologyVersion}.`,
      items: null,
    });
  }
  if (
    canonicalJson(before.manifest.generationSettings) !== canonicalJson(after.manifest.generationSettings)
  ) {
    reasons.push({
      code: 'GENERATION_SETTINGS_CHANGED',
      scopes: ['candidate'],
      detail:
        'generationSettings changed. Token caps and repeat policy are not neutral — a cap that truncates one provider and not another measures token accounting, not cooking.',
      items: null,
    });
  }
  if (canonicalJson(sortRoutes(before.manifest.judgeRoutes)) !== canonicalJson(sortRoutes(after.manifest.judgeRoutes))) {
    reasons.push({
      code: 'PANEL_CHANGED',
      scopes: ['judge'],
      detail: 'The judge panel changed. Ballots are not comparable across seats.',
      items: null,
    });
  }
  if (before.manifest.validatorHash !== after.manifest.validatorHash) {
    reasons.push({
      code: 'VALIDATOR_CHANGED',
      scopes: ['deterministic'],
      detail: `validatorHash ${before.manifest.validatorHash.slice(0, 12)}… → ${after.manifest.validatorHash.slice(0, 12)}….`,
      items: null,
    });
  }

  addContentReason(
    reasons,
    'PROMPT_CHANGED',
    ['candidate'],
    'promptHash',
    before.manifest,
    after.manifest,
    priorDigest,
    currentDigest,
    (item) => item.prompt,
  );
  addContentReason(
    reasons,
    'BANK_CHANGED',
    ['deterministic', 'judge'],
    'bankHash',
    before.manifest,
    after.manifest,
    priorDigest,
    currentDigest,
    (item) => item.item,
  );
  addContentReason(
    reasons,
    'JUDGE_PROMPT_CHANGED',
    ['judge'],
    'judgePromptHash',
    before.manifest,
    after.manifest,
    priorDigest,
    currentDigest,
    (item) => item.judgePrompt,
  );

  return summarise(reasons);
}

function sortRoutes<T extends { modelId: string }>(routes: readonly T[]): T[] {
  return [...routes].sort((a, b) => (a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0));
}

function readDigestSnapshot(value: unknown): ContentDigest | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as Partial<ContentDigest>;
  if (!Array.isArray(candidate.itemIds) || typeof candidate.items !== 'object' || candidate.items === null) {
    return null;
  }
  return candidate as ContentDigest;
}

/**
 * One content-hash comparison, localised to items where both digests are known.
 *
 * Without digests the change cannot be attributed to particular items, and the
 * only safe answer is "all of them". Guessing a smaller blast radius from a
 * summary hash is not possible, and pretending otherwise would retain scores for
 * items that did change.
 */
function addContentReason(
  reasons: InvalidationReason[],
  code: InvalidationCode,
  scopes: InvalidationScope[],
  field: 'promptHash' | 'bankHash' | 'judgePromptHash',
  before: ValidatedRunManifest,
  after: ValidatedRunManifest,
  priorDigest: ContentDigest | null,
  currentDigest: ContentDigest | null,
  component: (item: ContentDigest['items'][string]) => string | null,
): void {
  if (before[field] === after[field]) return;
  let items: string[] | null = null;
  if (priorDigest && currentDigest) {
    const ids = new Set([...priorDigest.itemIds, ...currentDigest.itemIds]);
    items = [...ids]
      .filter((id) => {
        const a = priorDigest.items[id];
        const b = currentDigest.items[id];
        // An item present in only one digest has changed by definition.
        if (!a || !b) return true;
        return component(a) !== component(b);
      })
      .sort();
  }
  reasons.push({
    code,
    scopes,
    detail:
      `${field} ${before[field].slice(0, 12)}… → ${after[field].slice(0, 12)}…` +
      (items === null
        ? '. No component digests were available, so the change cannot be attributed to particular items.'
        : ` (${items.length} item(s) differ).`),
    items,
  });
}

function summarise(reasons: InvalidationReason[]): StaleScoreVerdict {
  const invalidated: Record<InvalidationScope, 'all' | string[]> = {
    candidate: [],
    deterministic: [],
    judge: [],
  };
  for (const reason of reasons) {
    for (const scope of reason.scopes) {
      if (invalidated[scope] === 'all') continue;
      if (reason.items === null) {
        invalidated[scope] = 'all';
      } else {
        invalidated[scope] = [...new Set([...(invalidated[scope] as string[]), ...reason.items])].sort();
      }
    }
  }
  return {
    reasons,
    invalidated,
    invalidatesEverything: ALL_SCOPES.every((s) => invalidated[s] === 'all'),
  };
}

/**
 * Which scopes a stored score depends on.
 *
 * Every score depends on the candidate answer AND on the grading code, because
 * the graders module owns blending and cascade routing as well as the individual
 * graders — a "keyword grader fix" is not confined to keyword-graded items.
 * Only judge dependence is conditional.
 */
function scopesFor(score: Pick<Score, 'graderType' | 'judgeModel'>): InvalidationScope[] {
  const scopes: InvalidationScope[] = ['candidate', 'deterministic'];
  if (score.judgeModel !== undefined || score.graderType === 'llm-judge') scopes.push('judge');
  return scopes;
}

export interface RetentionResult<T> {
  retained: T[];
  dropped: T[];
}

/**
 * Split stored scores into what still holds and what does not.
 *
 * There is no option to keep the dropped ones. `bench grade`'s "preserves prior
 * judge results" is correct only while the thing that produced them has not
 * changed; when it has, the preserved number is indistinguishable from a fresh
 * one on the board and there is nothing downstream that could catch it.
 */
export function retainableScores<T extends Pick<Score, 'questionId' | 'graderType' | 'judgeModel'>>(
  scores: readonly T[],
  verdict: StaleScoreVerdict,
): RetentionResult<T> {
  const retained: T[] = [];
  const dropped: T[] = [];
  const hits = (scope: InvalidationScope, questionId: string): boolean => {
    const invalid = verdict.invalidated[scope];
    return invalid === 'all' || invalid.includes(questionId);
  };
  for (const score of scores) {
    const stale = scopesFor(score).some((scope) => hits(scope, score.questionId));
    (stale ? dropped : retained).push(score);
  }
  return { retained, dropped };
}

// ---------------------------------------------------------------------------
// M4.7 — complete score / adjudication status tracking
// ---------------------------------------------------------------------------

export const CELL_STATUSES = [
  'not-attempted',
  'answered',
  'judge-pending',
  'graded',
  'judged',
  'flagged',
  'adjudicated',
  'invalidated',
  'incident',
] as const;
export type CellStatus = (typeof CELL_STATUSES)[number];

/**
 * States a cell may be in at release.
 *
 * `incident` is terminal on purpose: a reproducible content filter is a fact
 * about the model, scored 0 and reported as an incident, and blocking release on
 * it would mean no run with a refusing model could ever ship. `flagged` is NOT
 * terminal — an unadjudicated cross-judge disagreement is unfinished work.
 */
export const TERMINAL_CELL_STATUSES: readonly CellStatus[] = Object.freeze([
  'graded',
  'judged',
  'adjudicated',
  'incident',
]);

export interface CellRef {
  modelId: string;
  questionId: string;
}

export interface StatusInput {
  runId: string;
  models: readonly string[];
  questionIds: readonly string[];
  responses: ReadonlyArray<Pick<StoredResponse, 'modelId' | 'questionId' | 'answerText' | 'transportFailure'>>;
  scores: ReadonlyArray<Pick<Score, 'modelId' | 'questionId' | 'graderType' | 'judgeModel'>>;
  /** Items that require a judge verdict; a score without one is judge-pending. */
  judgedItemIds?: readonly string[];
  /** Cross-judge disagreements awaiting human review. */
  flagged?: readonly CellRef[];
  adjudicated?: readonly CellRef[];
  /** Cells whose scores were dropped by retainableScores and not yet redone. */
  invalidated?: readonly CellRef[];
}

export interface StatusReport {
  runId: string;
  total: number;
  counts: Record<CellStatus, number>;
  cells: Array<CellRef & { status: CellStatus }>;
  /** Cells that are not in a terminal state. */
  incomplete: Array<CellRef & { status: CellStatus }>;
  complete: boolean;
}

const cellKey = (c: CellRef): string => JSON.stringify([c.modelId, c.questionId]);

/**
 * Status of every declared cell, including the ones with nothing in them.
 *
 * Built from the declared model × item grid rather than from what happens to be
 * on disk. A report assembled from stored files can only ever describe what
 * exists, so a cell that was never attempted is invisible in it — which is the
 * one status that most needs to block a release.
 */
export function scoreStatusReport(input: StatusInput): StatusReport {
  const responses = new Map(input.responses.map((r) => [cellKey(r), r]));
  const scores = new Map(input.scores.map((s) => [cellKey(s), s]));
  const judged = input.judgedItemIds ? new Set(input.judgedItemIds) : null;
  const flagged = new Set((input.flagged ?? []).map(cellKey));
  const adjudicated = new Set((input.adjudicated ?? []).map(cellKey));
  const invalidated = new Set((input.invalidated ?? []).map(cellKey));

  const counts = Object.fromEntries(CELL_STATUSES.map((s) => [s, 0])) as Record<CellStatus, number>;
  const cells: Array<CellRef & { status: CellStatus }> = [];

  for (const modelId of input.models) {
    for (const questionId of input.questionIds) {
      const ref: CellRef = { modelId, questionId };
      const key = cellKey(ref);
      const status = statusOf({
        response: responses.get(key),
        score: scores.get(key),
        needsJudge: judged === null ? null : judged.has(questionId),
        flagged: flagged.has(key),
        adjudicated: adjudicated.has(key),
        invalidated: invalidated.has(key),
      });
      counts[status] += 1;
      cells.push({ ...ref, status });
    }
  }

  const incomplete = cells.filter((c) => !TERMINAL_CELL_STATUSES.includes(c.status));
  return {
    runId: input.runId,
    total: cells.length,
    counts,
    cells,
    incomplete,
    complete: incomplete.length === 0,
  };
}

function statusOf(ctx: {
  response?: Pick<StoredResponse, 'answerText' | 'transportFailure'>;
  score?: Pick<Score, 'graderType' | 'judgeModel'>;
  needsJudge: boolean | null;
  flagged: boolean;
  adjudicated: boolean;
  invalidated: boolean;
}): CellStatus {
  // Invalidation outranks everything: a dropped score is work to redo, whatever
  // state the cell reached before it was dropped.
  if (ctx.invalidated) return 'invalidated';
  if (!ctx.response) return 'not-attempted';
  if (ctx.response.transportFailure) return 'incident';
  if (!ctx.score) return 'answered';
  if (ctx.adjudicated) return 'adjudicated';
  if (ctx.flagged) return 'flagged';
  // `needsJudge: null` means the caller did not say which items are judged. That
  // is missing information, not a licence to call the cell finished, so a score
  // with no judge on an unknown item reads as pending rather than graded.
  if (ctx.score.judgeModel === undefined) {
    if (ctx.needsJudge === null) return ctx.score.graderType === 'llm-judge' ? 'judge-pending' : 'graded';
    return ctx.needsJudge ? 'judge-pending' : 'graded';
  }
  return 'judged';
}

// ---------------------------------------------------------------------------
// M4.7 — the release checklist, as data
// ---------------------------------------------------------------------------

export type ChecklistVerdict = 'pass' | 'fail' | 'not-checked';

/**
 * THE release checklist. Fixed, enumerated, and not negotiable by a caller.
 *
 * The defect this replaces: `buildReleaseChecklist` took the status report, the
 * stale-score verdict, the lifecycle state, the journal list and the
 * verification options FROM ITS CALLER, and `checklistComplete` accepted any
 * non-empty list of passing items. A caller could therefore omit every check it
 * expected to fail, or hand `transitionRun` a one-item checklist reading
 * `[{ id: 'stub', verdict: 'pass' }]` and release on it. That is the
 * architectural failure this whole work package exists to close: the thing
 * being guarded chose the guard's scope.
 *
 * So the scope lives here, as a constant, and the evidence for every item is
 * read from the run's own artifacts. There is no parameter that removes a check
 * and no parameter that decides what a check means.
 */
export const RELEASE_CHECKS = Object.freeze([
  {
    id: 'manifest-present',
    statement: 'The run carries a valid, coherent manifest naming its evidence class and content hashes.',
  },
  {
    id: 'manifest-digest-persisted',
    statement: "The manifest's own digest is recorded with the run and matches the manifest on disk.",
  },
  {
    id: 'artifacts-match-manifest',
    statement:
      'Stored artifacts reproduce the bank, prompt, judge-prompt and validator hashes the manifest declares, with no missing cell.',
  },
  {
    id: 'run-identity-consistent',
    statement: 'The manifest, config, board, analysis and stored scores all name this same run.',
  },
  {
    id: 'evidence-class-publishable',
    statement: "Only a 'public-release' artifact in 'released' may become a public result (RELEASE-002).",
  },
  {
    id: 'lifecycle-audited',
    statement: 'Release happens from the audited state, never straight from draft.',
  },
  {
    id: 'coverage-complete',
    statement: 'Every declared model × item cell is in a terminal score/adjudication state.',
  },
  {
    id: 'no-unadjudicated-flags',
    statement: 'No cross-judge disagreement is still waiting for human review.',
  },
  {
    id: 'adjudications-resolved',
    statement: 'An adjudication queue was built and every case in it has an admissible decision.',
  },
  {
    id: 'no-stale-scores',
    statement: 'No score was produced under a prompt, item, panel or grader that has since changed.',
  },
  {
    id: 'journals-intact',
    statement: 'The append-only answer and ballot journals exist, hold entries, and verify end to end.',
  },
  { id: 'board-present', statement: 'A leaderboard exists for this run and names it.' },
  { id: 'analysis-present', statement: 'An analysis exists for this run and names it.' },
  {
    id: 'artifacts-committed',
    statement: 'The run directory is committed, so the released artifacts are the ones in git.',
  },
] as const);

export type ReleaseCheckId = (typeof RELEASE_CHECKS)[number]['id'];

export const REQUIRED_RELEASE_CHECK_IDS: readonly ReleaseCheckId[] = Object.freeze(
  RELEASE_CHECKS.map((c) => c.id),
);

export interface ChecklistItem {
  id: string;
  statement: string;
  verdict: ChecklistVerdict;
  detail: string;
}

export interface ReleaseChecklist {
  checklistVersion: 1;
  runId: string;
  generatedAt: string;
  manifestHash: string | null;
  items: ChecklistItem[];
  /** Derived from `items`, never asserted. `checklistComplete` recomputes it. */
  complete: boolean;
}

export const RELEASE_CHECKLIST_FILE = 'release-checklist.json';

/**
 * Build the checklist for a run, from the run.
 *
 * `now` is the only parameter beyond the run id, and it is a timestamp rather
 * than a gate input — it cannot make a failing check pass. Everything else is
 * read: the manifest, its persisted digest, the register, the stored responses
 * and scores, the journals, the adjudication queue and record, the board, the
 * analysis and git.
 *
 * `not-checked` remains a FAILURE. Every check that could not run is a check
 * that did not run, and a checklist whose unknown items read as green is a
 * checklist that certifies its own blind spots.
 */
export function buildReleaseChecklist(runId: string, now: Date = new Date()): ReleaseChecklist {
  const evidence = gatherReleaseEvidence(runId);
  const items: ChecklistItem[] = RELEASE_CHECKS.map((check) => ({
    ...check,
    ...judgeCheck(check.id, evidence),
  }));
  return {
    checklistVersion: 1,
    runId,
    generatedAt: now.toISOString(),
    manifestHash: evidence.manifestHash,
    items,
    complete: items.every((i) => i.verdict === 'pass'),
  };
}

interface ReleaseEvidence {
  runId: string;
  manifest: ValidatedRunManifest | null;
  manifestProblem: string | null;
  manifestHash: string | null;
  recordedHash: RecordedManifestHash;
  verification: VerificationReport;
  digest: ContentDigest | null;
  registerState: ReleaseState | null;
  identity: { ok: boolean; detail: string };
  status: StatusReport | null;
  statusProblem: string | null;
  stale: StaleScoreVerdict | null;
  staleProblem: string | null;
  journalProblems: string[];
  adjudication: AdjudicationEvidence;
  board: { ok: boolean; detail: string };
  analysis: { ok: boolean; detail: string };
  committed: { ok: boolean; detail: string };
}

/** Read once; every check is then a pure function of this. */
function gatherReleaseEvidence(runId: string): ReleaseEvidence {
  let manifest: ValidatedRunManifest | null = null;
  let manifestProblem: string | null = null;
  try {
    manifest = readRunManifest(runId);
  } catch (e) {
    manifestProblem = (e as Error).message;
  }

  let digest: ContentDigest | null = null;
  try {
    digest = readRunDigest(runId);
  } catch {
    // Reported through `artifacts-match-manifest`, which reads the same file
    // and says so in its own finding; duplicating the message here would make
    // one absence look like two independent failures.
    digest = null;
  }

  const adjudication = readAdjudicationEvidence(runId);
  const scores = readScoresSafely(runId);
  const status = deriveStatusReport(runId, manifest, digest, scores, adjudication);
  const stale = workingTreeStaleVerdict(runId, manifest, digest);

  return {
    runId,
    manifest,
    manifestProblem,
    manifestHash: manifest === null ? null : manifestHash(manifest),
    recordedHash: readRunManifestHash(runId),
    // `expectComplete` is forced, not defaulted: the release reading of
    // "complete" is the only one that matters here, and a caller must not be
    // able to soften it into an in-progress audit.
    verification: verifyRunManifest(runId, { expectComplete: true }),
    digest,
    registerState: registerEntry(runId)?.state ?? null,
    identity: checkArtifactIdentity(runId, manifest, scores.scores),
    status: status.report,
    statusProblem: status.problem,
    stale: stale.verdict,
    staleProblem: stale.problem,
    // The journal list is FIXED. It used to be a parameter, so a caller could
    // pass `journals: []` and collect a green "journals intact" over nothing.
    journalProblems: [ANSWER_JOURNAL, BALLOT_JOURNAL].flatMap((j) => journalProblemsForRelease(runId, j)),
    adjudication,
    board: checkArtifactNamesRun(runId, 'leaderboard.json', 'rows'),
    analysis: checkArtifactNamesRun(runId, 'analysis.json', null),
    committed: committedEvidence(runId),
  };
}

function verdict(pass: boolean, detail: string): { verdict: ChecklistVerdict; detail: string } {
  return { verdict: pass ? 'pass' : 'fail', detail };
}

const NOT_CHECKED = (detail: string): { verdict: ChecklistVerdict; detail: string } => ({
  verdict: 'not-checked',
  detail,
});

function judgeCheck(id: ReleaseCheckId, e: ReleaseEvidence): { verdict: ChecklistVerdict; detail: string } {
  switch (id) {
    case 'manifest-present':
      return e.manifest === null
        ? verdict(false, e.manifestProblem ?? 'No readable manifest.')
        : verdict(true, `manifest ${e.manifestHash!.slice(0, 12)}…, evidenceClass '${e.manifest.evidenceClass}'.`);

    case 'manifest-digest-persisted':
      if (e.manifestHash === null) return NOT_CHECKED('No readable manifest to compare a digest against.');
      if (e.recordedHash.state === 'absent') {
        return verdict(false, `Run carries no ${MANIFEST_HASH_FILE}; nothing records which envelope it ran under.`);
      }
      if (e.recordedHash.state === 'malformed') {
        return verdict(false, `${MANIFEST_HASH_FILE} does not hold a sha256 digest.`);
      }
      return verdict(
        e.recordedHash.hash === e.manifestHash,
        `recorded ${e.recordedHash.hash.slice(0, 12)}… vs manifest ${e.manifestHash.slice(0, 12)}….`,
      );

    case 'artifacts-match-manifest':
      return verdict(
        e.verification.ok,
        e.verification.ok
          ? 'No drift, no undeclared artifacts, no missing cell.'
          : e.verification.findings
              .filter((f) => f.severity === 'error')
              .map((f) => `[${f.code}] ${f.detail}`)
              .join(' '),
      );

    case 'run-identity-consistent':
      return verdict(e.identity.ok, e.identity.detail);

    case 'evidence-class-publishable':
      if (e.manifest === null) return NOT_CHECKED('No readable manifest, so the evidence class is unknown.');
      return verdict(
        canPublish(e.manifest),
        `evidenceClass '${e.manifest.evidenceClass}', releaseState '${e.manifest.releaseState}', rankEligible ${e.manifest.rankEligible}.`,
      );

    case 'lifecycle-audited':
      if (e.registerState === null) {
        return verdict(false, 'The run is not in the release register, so no review has been recorded for it.');
      }
      return verdict(e.registerState === 'audited', `register state '${e.registerState}'.`);

    case 'coverage-complete':
      if (e.status === null) return NOT_CHECKED(e.statusProblem ?? 'Coverage could not be established.');
      return verdict(
        e.status.complete,
        `${e.status.total - e.status.incomplete.length}/${e.status.total} terminal; outstanding: ${summariseCounts(e.status)}.`,
      );

    case 'no-unadjudicated-flags':
      if (e.status === null) return NOT_CHECKED(e.statusProblem ?? 'Coverage could not be established.');
      return verdict(
        e.status.counts.flagged === 0,
        `${e.status.counts.flagged} flagged cell(s) with no admissible adjudication.`,
      );

    case 'adjudications-resolved':
      return verdict(e.adjudication.complete, e.adjudication.detail);

    case 'no-stale-scores':
      if (e.stale === null) return NOT_CHECKED(e.staleProblem ?? 'Staleness could not be established.');
      return verdict(
        e.stale.reasons.length === 0,
        e.stale.reasons.map((r) => `[${r.code}] ${r.detail}`).join(' ') || 'No invalidating change.',
      );

    case 'journals-intact':
      return verdict(
        e.journalProblems.length === 0,
        e.journalProblems.length === 0
          ? `${ANSWER_JOURNAL}, ${BALLOT_JOURNAL} present and intact.`
          : e.journalProblems.join(' '),
      );

    case 'board-present':
      return verdict(e.board.ok, e.board.detail);

    case 'analysis-present':
      return verdict(e.analysis.ok, e.analysis.detail);

    case 'artifacts-committed':
      return verdict(e.committed.ok, e.committed.detail);
  }
}

function summariseCounts(status: StatusReport): string {
  const outstanding = CELL_STATUSES.filter(
    (s) => !TERMINAL_CELL_STATUSES.includes(s) && status.counts[s] > 0,
  ).map((s) => `${s}=${status.counts[s]}`);
  return outstanding.length === 0 ? 'none' : outstanding.join(', ');
}

function committedEvidence(runId: string): { ok: boolean; detail: string } {
  try {
    return { ok: true, detail: `tree ${assertSourceCommitted(runId).slice(0, 12)}….` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

/** A run-scoped JSON artifact that must exist, parse, and name this run. */
function checkArtifactNamesRun(
  runId: string,
  file: string,
  requiredArrayField: string | null,
): { ok: boolean; detail: string } {
  const path = resolveRunFile(runId, file, { write: false });
  if (!existsSync(path)) return { ok: false, detail: `${file} does not exist.` };
  let parsed: { runId?: unknown } & Record<string, unknown>;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, detail: `${file} is not valid JSON (${(e as Error).message}).` };
  }
  if (parsed?.runId !== runId) {
    return { ok: false, detail: `${file} names run ${JSON.stringify(parsed?.runId)}, not '${runId}'.` };
  }
  if (requiredArrayField !== null) {
    const rows = parsed[requiredArrayField];
    if (!Array.isArray(rows) || rows.length === 0) {
      return { ok: false, detail: `${file} has no ${requiredArrayField}; an empty board is not a result.` };
    }
  }
  return { ok: true, detail: `${file} present and names '${runId}'.` };
}

interface LoadedScores {
  scores: Score[];
  problem: string | null;
}

function readScoresSafely(runId: string): LoadedScores {
  try {
    return { scores: readScores(runId), problem: null };
  } catch (e) {
    // Unreadable is not empty. An empty score list would make every cell
    // 'answered' and the coverage check would fail anyway, but it would fail
    // with the wrong reason, and the wrong reason is what gets waved through.
    return { scores: [], problem: `scores.json could not be read (${(e as Error).message}).` };
  }
}

/**
 * Every id inside the run's own artifacts must be this run's id (RELEASE-002).
 *
 * Cheap, and it catches the case a copied artifact creates: a board or a score
 * set lifted from another run sitting inside this directory, carrying that
 * run's numbers under this run's approval. `verifyRunManifest` already checks
 * the responses; this covers the derived artifacts it does not read.
 */
function checkArtifactIdentity(
  runId: string,
  manifest: ValidatedRunManifest | null,
  scores: readonly Score[],
): { ok: boolean; detail: string } {
  const problems: string[] = [];
  if (manifest !== null && manifest.runId !== runId) {
    problems.push(`manifest names '${manifest.runId}'`);
  }
  const configPath = resolveRunFile(runId, 'config.json', { write: false });
  if (!existsSync(configPath)) {
    problems.push('config.json is absent');
  } else {
    try {
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as { runId?: unknown };
      if (config.runId !== runId) problems.push(`config.json names ${JSON.stringify(config.runId)}`);
    } catch (e) {
      problems.push(`config.json is unreadable (${(e as Error).message})`);
    }
  }
  const foreign = [...new Set(scores.map((s) => s.runId).filter((id) => id !== runId))];
  if (foreign.length > 0) problems.push(`scores stamped [${foreign.slice(0, 3).join(', ')}]`);
  return problems.length === 0
    ? { ok: true, detail: `manifest, config, scores and artifacts all name '${runId}'.` }
    : { ok: false, detail: problems.join('; ') };
}

interface AdjudicationEvidence {
  complete: boolean;
  detail: string;
  /** Question ids whose disputes carry an admissible decision. */
  resolvedQuestionIds: ReadonlySet<string>;
}

/**
 * Read the adjudication queue and record, and ask M2.6's own gate about them.
 *
 * `adjudicate.ts` owns the semantics — a queue that was never built is not an
 * empty queue, and a critical safety case signed off by someone who did not
 * declare independence is not decided — so its `adjudicationStatus` is called
 * rather than reimplemented. What is done here is the reading, because that
 * module exports a writer for the queue but no reader.
 *
 * The queue is shape-checked before it is passed on. A blind cast would let a
 * hand-written `{"cases": []}` clear every dispute in the run, which is the
 * cheapest possible forgery of a review.
 */
function readAdjudicationEvidence(runId: string): AdjudicationEvidence {
  const queuePath = resolveRunFile(runId, ADJUDICATION_QUEUE_FILE, { write: false });
  if (!existsSync(queuePath)) {
    return {
      complete: false,
      detail: `${ADJUDICATION_QUEUE_FILE} was never built for this run; an unbuilt queue is not an empty one.`,
      resolvedQuestionIds: new Set(),
    };
  }
  let queue: AdjudicationQueue;
  try {
    const parsed = JSON.parse(readFileSync(queuePath, 'utf8')) as Partial<AdjudicationQueue>;
    if (
      parsed?.runId !== runId ||
      !Array.isArray(parsed.cases) ||
      parsed.cases.some((c) => typeof c?.caseId !== 'string' || typeof c?.questionId !== 'string')
    ) {
      return {
        complete: false,
        detail: `${ADJUDICATION_QUEUE_FILE} is malformed or names another run.`,
        resolvedQuestionIds: new Set(),
      };
    }
    queue = parsed as AdjudicationQueue;
  } catch (e) {
    return {
      complete: false,
      detail: `${ADJUDICATION_QUEUE_FILE} is not valid JSON (${(e as Error).message}).`,
      resolvedQuestionIds: new Set(),
    };
  }

  let status: ReturnType<typeof adjudicationStatus>;
  try {
    status = adjudicationStatus(queue, readAdjudicationRecord(runId));
  } catch (e) {
    return { complete: false, detail: (e as Error).message, resolvedQuestionIds: new Set() };
  }
  const pendingIds = new Set(status.pending.map((p) => p.questionId));
  const resolvedQuestionIds = new Set(
    queue.cases.map((c) => c.questionId).filter((id) => !pendingIds.has(id)),
  );
  return {
    complete: status.complete,
    detail: status.complete
      ? `${status.decided}/${status.total} case(s) decided.`
      : `${status.pending.length} of ${status.total} case(s) unresolved` +
        (status.queueMismatch ? ' (the record binds to a different queue)' : '') +
        (status.pending.length > 0 ? `: ${status.pending.slice(0, 3).map((p) => `${p.questionId} — ${p.why}`).join('; ')}` : '') +
        '.',
    resolvedQuestionIds,
  };
}

/**
 * The status of every declared cell, built from the run's own evidence.
 *
 * Previously the caller passed this in, which meant the caller decided how many
 * cells there were — and a caller that under-reports the grid gets a complete
 * coverage check for free. The grid comes from the manifest's candidate routes
 * crossed with the digest's item ids, both of which are frozen at manifest time.
 */
function deriveStatusReport(
  runId: string,
  manifest: ValidatedRunManifest | null,
  digest: ContentDigest | null,
  scores: LoadedScores,
  adjudication: AdjudicationEvidence,
): { report: StatusReport | null; problem: string | null } {
  if (manifest === null) return { report: null, problem: 'No readable manifest, so the cell grid is unknown.' };
  if (digest === null) return { report: null, problem: 'No readable digest, so the item set is unknown.' };
  if (scores.problem !== null) return { report: null, problem: scores.problem };

  let responses: StoredResponse[];
  try {
    responses = readResponses(runId);
  } catch (e) {
    return { report: null, problem: `responses/ could not be read (${(e as Error).message}).` };
  }

  let judgedItemIds: string[];
  try {
    const byId = new Map(loadQuestions().map((q) => [q.id, q]));
    const missing = digest.itemIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return {
        report: null,
        problem: `${missing.length} manifested item(s) are no longer in the dataset, so which cells need a judge cannot be established.`,
      };
    }
    judgedItemIds = digest.itemIds.filter((id) => byId.get(id)!.grader.type === 'llm-judge');
  } catch (e) {
    return { report: null, problem: `The dataset does not load (${(e as Error).message}).` };
  }

  // A flag is cleared by an admissible adjudication decision, never by the run
  // deciding it does not matter. Everything still flagged is unfinished work.
  const flaggedCells = scores.scores
    .filter((s) => (s.detail as { flagged?: unknown }).flagged === true)
    .map((s) => ({ modelId: s.modelId, questionId: s.questionId }));
  const adjudicated = flaggedCells.filter((c) => adjudication.resolvedQuestionIds.has(c.questionId));
  const stillFlagged = flaggedCells.filter((c) => !adjudication.resolvedQuestionIds.has(c.questionId));

  return {
    report: scoreStatusReport({
      runId,
      models: manifest.candidateRoutes.map((r) => r.modelId),
      questionIds: digest.itemIds,
      responses,
      scores: scores.scores,
      judgedItemIds,
      flagged: stillFlagged,
      adjudicated,
    }),
    problem: null,
  };
}

/**
 * Is anything that produced these scores different in the working tree now?
 *
 * The comparison is the run's stored manifest against the same manifest with
 * its four content hashes recomputed from the current dataset and code. Both
 * sides are derived here; neither is supplied. `staleScoresForRun` takes the
 * "current" side from its caller, which is right for `grade`/`judge` (the
 * caller genuinely holds the new envelope) and wrong for a release gate, where
 * the caller would be choosing what counts as unchanged.
 */
function workingTreeStaleVerdict(
  runId: string,
  manifest: ValidatedRunManifest | null,
  digest: ContentDigest | null,
): { verdict: StaleScoreVerdict | null; problem: string | null } {
  if (manifest === null || digest === null) {
    return { verdict: null, problem: 'No readable manifest or digest to compare the working tree against.' };
  }
  try {
    const byId = new Map(loadQuestions().map((q) => [q.id, q]));
    const missing = digest.itemIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      return {
        verdict: null,
        problem: `${missing.length} manifested item(s) have left the dataset, so the scores cannot be shown to be current.`,
      };
    }
    const current = computeContentDigest(
      digest.itemIds.map((id) => byId.get(id)!),
      {
        maxTokens: manifest.generationSettings.maxTokens,
        maxTokensRecipe: manifest.generationSettings.maxTokensRecipe,
      },
    );
    return {
      verdict: detectStaleScores(
        { manifest, digest },
        {
          manifest: {
            ...manifest,
            bankHash: current.bankHash,
            promptHash: current.promptHash,
            judgePromptHash: current.judgePromptHash,
            validatorHash: current.validatorHash,
          },
          digest: current,
        },
      ),
      problem: null,
    };
  } catch (e) {
    return { verdict: null, problem: `The working tree could not be re-hashed (${(e as Error).message}).` };
  }
}

/**
 * Recomputed from the items, and from the FIXED list of required checks.
 *
 * Two separate lies this refuses. The stored `complete` flag is never trusted —
 * a checklist can assert its own completeness. And a checklist that simply does
 * not contain a check cannot pass on the ones it does contain: the old version
 * accepted any non-empty list of passing items, so `[{ verdict: 'pass' }]`
 * released a run. Membership is checked against `REQUIRED_RELEASE_CHECK_IDS`,
 * in both directions, so neither omitting a check nor inventing one works.
 */
export function checklistComplete(checklist: ReleaseChecklist): boolean {
  return checklistShortfall(checklist).length === 0;
}

/** Why a checklist is not complete, in publishable form. Empty iff complete. */
export function checklistShortfall(checklist: ReleaseChecklist): string[] {
  if (!checklist || !Array.isArray(checklist.items)) return ['the checklist has no items array'];
  const problems: string[] = [];
  const seen = new Map<string, ChecklistItem>();
  for (const item of checklist.items) {
    if (!item || typeof item.id !== 'string') {
      problems.push('an item has no id');
      continue;
    }
    if (seen.has(item.id)) problems.push(`check '${item.id}' appears twice`);
    seen.set(item.id, item);
  }
  for (const id of REQUIRED_RELEASE_CHECK_IDS) {
    const item = seen.get(id);
    if (!item) problems.push(`required check '${id}' is missing`);
    else if (item.verdict !== 'pass') problems.push(`${id}: [${item.verdict}] ${item.detail}`);
  }
  for (const id of seen.keys()) {
    if (!(REQUIRED_RELEASE_CHECK_IDS as readonly string[]).includes(id)) {
      problems.push(`check '${id}' is not one of the required checks and cannot stand in for one`);
    }
  }
  return problems;
}

export function writeReleaseChecklist(runId: string, checklist: ReleaseChecklist): string {
  if (checklist.runId !== runId) {
    throw new LifecycleError(
      `Checklist names run '${checklist.runId}' but is being written into '${runId}'.`,
      'CHECKLIST_MISMATCH',
    );
  }
  return writeRunFileAtomic(runId, RELEASE_CHECKLIST_FILE, `${JSON.stringify(checklist, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// M4.7 — the release register: lifecycle state and the reviewed current-run pointer
// ---------------------------------------------------------------------------

/**
 * The register lives beside the runs, not inside one.
 *
 * A run's own directory freezes the moment it is released, so it cannot record
 * anything that happens to it afterwards — quarantine and retirement are exactly
 * those events. Keeping the authoritative state outside the frozen artifact is
 * what makes an erratum possible without editing the thing the erratum is about.
 */
export const REGISTER_FILE = 'REGISTER.json';

/**
 * The register file every production path uses. Not a parameter.
 *
 * It was one, on every function below, which meant a caller could point the
 * lifecycle at a register it had written itself — its own approvals, its own
 * released states, its own current-run pointer. That is the same class of
 * defect as a permit verifier accepting a caller-supplied keyring: injectable
 * for testability, reachable in production, therefore not a boundary. Tests
 * substitute one through `useRegisterFileForTest`, which refuses outside a test
 * process.
 */
let registerFileOverride: string | null = null;

function registerFile(): string {
  return registerFileOverride ?? REGISTER_FILE;
}

/** Test-only. Redirects the register so a test never touches the real one. */
export function useRegisterFileForTest(file: string): void {
  assertTestSeam('useRegisterFileForTest');
  registerFileOverride = file;
}

/** Test-only. Restores the production register. */
export function clearRegisterFileForTest(): void {
  assertTestSeam('clearRegisterFileForTest');
  registerFileOverride = null;
}

/**
 * Legal transitions.
 *
 * `released → draft` is absent by construction: a published artifact never
 * returns to work in progress; it is quarantined or retired and a DERIVED run
 * carries the corrected work (see derive.ts). `quarantined → released` is also
 * absent — lifting a quarantine in place would erase the reason it was imposed
 * from the record, so a quarantined run is retired and its replacement is a new
 * artifact with its own review.
 */
export const LIFECYCLE_TRANSITIONS: Readonly<Record<ReleaseState, readonly ReleaseState[]>> = Object.freeze({
  draft: Object.freeze(['audited', 'quarantined', 'retired'] as const),
  audited: Object.freeze(['draft', 'released', 'quarantined', 'retired'] as const),
  released: Object.freeze(['quarantined', 'retired'] as const),
  quarantined: Object.freeze(['retired'] as const),
  retired: Object.freeze([] as const),
});

export interface LifecycleTransitionRecord {
  from: ReleaseState | null;
  to: ReleaseState;
  at: string;
  actor: string;
  evidence: string;
  /** False when the run was already frozen and could not carry its own journal. */
  journalled: boolean;
}

export interface RegisterEntry {
  runId: string;
  state: ReleaseState;
  manifestHash: string;
  updatedAt: string;
  history: LifecycleTransitionRecord[];
}

/** One published artifact, pinned by content at the moment of approval. */
export interface PinnedArtifact {
  file: string;
  sha256: string;
}

export interface CurrentRunPointer {
  runId: string;
  manifestHash: string;
  reviewedBy: string;
  reviewedAt: string;
  reviewEvidence: string;
  /** sha256 of the canonical checklist that backed the decision. */
  checklistDigest: string;
  /**
   * The exact bytes this approval covers.
   *
   * This is what makes publication ATOMIC for a reader. The artifacts
   * themselves live in a per-run directory and are written one file at a time,
   * so a reader that walked the directory could catch a board from one version
   * beside an analysis from another. Here the pointer is swapped by a single
   * atomic rename, it names one run, and it pins every file's digest — so a
   * reader either resolves the whole previous release or the whole new one, and
   * a mixed set fails the digest check rather than rendering.
   */
  artifacts: PinnedArtifact[];
}

/**
 * The artifacts a public release consists of. Fixed, and required.
 *
 * A shorter list would mean an unpinned file could change under a live pointer;
 * a caller-supplied list would mean the run being published chose which of its
 * own files were covered.
 */
export const PUBLISHED_ARTIFACTS: readonly string[] = Object.freeze([
  'leaderboard.json',
  'analysis.json',
  'scores.json',
  MANIFEST_FILE,
  RELEASE_CHECKLIST_FILE,
]);

function pinArtifacts(runId: string): PinnedArtifact[] {
  return PUBLISHED_ARTIFACTS.map((file) => {
    const path = resolveRunFile(runId, file, { write: false });
    if (!existsSync(path)) {
      throw new LifecycleError(
        `Run ${runId} has no ${file}. A release pins every published artifact by digest; one that does not exist cannot be pinned, and an unpinned file can change under a live pointer.`,
        'ARTIFACT_MISSING',
      );
    }
    return { file, sha256: sha256Hex(readFileSync(path, 'utf8')) };
  });
}

export interface ReleaseRegister {
  registerVersion: 1;
  entries: Record<string, RegisterEntry>;
  currentRun: CurrentRunPointer | null;
}

function isReleaseState(value: unknown): value is ReleaseState {
  return typeof value === 'string' && (RELEASE_STATES as readonly string[]).includes(value);
}

const EMPTY_REGISTER: ReleaseRegister = { registerVersion: 1, entries: {}, currentRun: null };

/**
 * Read the register.
 *
 * An ABSENT register is the empty one: no run is released and no run is
 * current. That is the fail-closed reading — every gate below refuses on an
 * unregistered run — whereas a MALFORMED register throws, because an unknown
 * lifecycle policy is not something to guess at.
 */
export function readReleaseRegister(): ReleaseRegister {
  const file = registerFile();
  const path = resolveOutputPath('runs', file, { write: false });
  if (!existsSync(path)) return { ...EMPTY_REGISTER, entries: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new LifecycleError(
      `Release register ${file} is not valid JSON (${(e as Error).message}). Refusing to operate with an unknown lifecycle state.`,
      'REGISTER_INVALID',
    );
  }
  const register = parsed as Partial<ReleaseRegister>;
  if (
    typeof register !== 'object' ||
    register === null ||
    register.registerVersion !== 1 ||
    typeof register.entries !== 'object' ||
    register.entries === null ||
    Array.isArray(register.entries)
  ) {
    throw new LifecycleError(`Release register ${file} is malformed.`, 'REGISTER_INVALID');
  }
  for (const [runId, entry] of Object.entries(register.entries)) {
    if (!isReleaseState((entry as RegisterEntry)?.state)) {
      throw new LifecycleError(
        `Release register ${file} gives run '${runId}' state ${JSON.stringify((entry as RegisterEntry)?.state)}, which is not a known release state.`,
        'UNKNOWN_STATE',
      );
    }
  }
  return {
    registerVersion: 1,
    entries: register.entries as Record<string, RegisterEntry>,
    currentRun: (register.currentRun as CurrentRunPointer | null) ?? null,
  };
}

/**
 * One atomic rename. The register is the publication transaction: every reader
 * sees the pointer and the states as they were before the write, or as they are
 * after, and never a half-applied release.
 */
function writeRegister(register: ReleaseRegister): string {
  return writeOutputFileAtomic('runs', registerFile(), `${JSON.stringify(register, null, 2)}\n`);
}

/** The register entry for a run, or null when it has never been registered. */
export function registerEntry(runId: string): RegisterEntry | null {
  return readReleaseRegister().entries[runId] ?? null;
}

export interface RegisterRunInput {
  runId: string;
  /** The run's manifest, or its hash. The hash pins the entry to one envelope. */
  manifest?: unknown;
  manifestHash?: string;
  actor: string;
  evidence: string;
  initialState?: ReleaseState;
  now?: Date;
}

/**
 * Put a run into the register at its declared starting state.
 *
 * Idempotent for an identical registration; refuses to re-register the same run
 * id against a different manifest hash, because the register is what ties a
 * lifecycle to one execution envelope and a swapped envelope under the same id
 * would inherit that lifecycle's approvals.
 */
export function registerRun(input: RegisterRunInput): RegisterEntry {
  const now = input.now ?? new Date();
  const hash = input.manifestHash ?? (input.manifest !== undefined ? manifestHash(input.manifest) : undefined);
  if (hash === undefined) {
    throw new LifecycleError(
      `Registering ${input.runId} requires its manifest or manifest hash — the entry binds a lifecycle to one envelope.`,
      'EVIDENCE_REQUIRED',
    );
  }
  requireEvidence(input.actor, input.evidence, `registering ${input.runId}`);

  const state = input.initialState ?? 'draft';
  if (!isReleaseState(state)) {
    throw new LifecycleError(`Unknown initial state ${JSON.stringify(state)}.`, 'UNKNOWN_STATE');
  }
  if (state !== 'draft') {
    // Registering straight into a later state would skip every precondition the
    // transitions enforce, which is the whole gate.
    throw new LifecycleError(
      `A run enters the register as 'draft'; got '${state}'. Use transitionRun to move it.`,
      'ILLEGAL_TRANSITION',
    );
  }

  const register = readReleaseRegister();
  const existing = register.entries[input.runId];
  if (existing) {
    if (existing.manifestHash !== hash) {
      throw new LifecycleError(
        `Run ${input.runId} is already registered against manifest ${existing.manifestHash.slice(0, 12)}…, not ${hash.slice(0, 12)}….`,
        'RUN_ALREADY_REGISTERED',
      );
    }
    return existing;
  }

  const journalled = appendLifecycle(
    input.runId,
    { from: null, to: state, actor: input.actor, evidence: input.evidence },
    now,
  );
  const entry: RegisterEntry = {
    runId: input.runId,
    state,
    manifestHash: hash,
    updatedAt: now.toISOString(),
    history: [
      {
        from: null,
        to: state,
        at: now.toISOString(),
        actor: input.actor,
        evidence: input.evidence,
        journalled,
      },
    ],
  };
  register.entries[input.runId] = entry;
  writeRegister(register);
  return entry;
}

function requireEvidence(actor: string, evidence: string, context: string): void {
  if (actor.trim() === '' || evidence.trim() === '') {
    throw new LifecycleError(
      `${context} requires a named actor and written evidence. A lifecycle move nobody signed is not a review.`,
      'EVIDENCE_REQUIRED',
    );
  }
}

/**
 * Mirror a transition into the run's own append-only journal.
 *
 * Returns false when the run is already frozen. That is not a swallowed error:
 * the register is the durable record precisely so that a released run's
 * quarantine can be recorded at all, and refusing to quarantine a published run
 * because its directory is immutable would be the wrong failure.
 */
function appendLifecycle(
  runId: string,
  body: { from: ReleaseState | null; to: ReleaseState; actor: string; evidence: string },
  now: Date,
): boolean {
  if (isHistoricalRun(runId)) return false;
  const id = identity('life', { runId, from: body.from, to: body.to, at: now.toISOString() });
  appendJournalEntry(runId, LIFECYCLE_JOURNAL, id, body, now);
  return true;
}

export interface TransitionInput {
  runId: string;
  to: ReleaseState;
  actor: string;
  evidence: string;
  now?: Date;
}

export interface TransitionResult {
  entry: RegisterEntry;
  /** Built and written for a release; null for every other transition. */
  checklist: ReleaseChecklist | null;
}

/**
 * Move a run through the lifecycle.
 *
 * Preconditions, not conventions. Releasing BUILDS the checklist from the run's
 * evidence and requires it to be complete — it no longer accepts one. The
 * caller-supplied form was the bypass: `transitionRun` verified that the object
 * it was handed named the right run and the right manifest hash, and then
 * trusted its verdicts, so a one-item list reading `pass` released the run.
 * A caller can now supply an approver and a reason; it cannot supply a result.
 *
 * The pointer is cleared automatically when the run it names is quarantined or
 * retired — a current-run pointer that survives its own run's quarantine would
 * keep serving the withdrawn board.
 */
export function transitionRun(input: TransitionInput): TransitionResult {
  const now = input.now ?? new Date();
  requireEvidence(input.actor, input.evidence, `transitioning ${input.runId} to '${input.to}'`);
  if (!isReleaseState(input.to)) {
    throw new LifecycleError(`Unknown target state ${JSON.stringify(input.to)}.`, 'UNKNOWN_STATE');
  }

  const register = readReleaseRegister();
  const entry = register.entries[input.runId];
  if (!entry) {
    throw new LifecycleError(
      `Run ${input.runId} is not in the release register. Register it before moving it through the lifecycle.`,
      'RUN_NOT_REGISTERED',
    );
  }
  const from = entry.state;
  if (!LIFECYCLE_TRANSITIONS[from].includes(input.to)) {
    throw new LifecycleError(
      `Run ${input.runId} cannot go '${from}' → '${input.to}'. Legal from '${from}': [${LIFECYCLE_TRANSITIONS[from].join(', ') || 'none — terminal'}].`,
      'ILLEGAL_TRANSITION',
    );
  }

  let checklist: ReleaseChecklist | null = null;
  if (input.to === 'released') {
    checklist = buildReleaseChecklist(input.runId, now);
    // The register's binding is the authority on which envelope this lifecycle
    // belongs to. A checklist built against a different manifest describes a
    // different run, whatever its runId field says.
    if (checklist.manifestHash !== entry.manifestHash) {
      throw new LifecycleError(
        `Run ${input.runId} now carries manifest ${String(checklist.manifestHash).slice(0, 12)}… but the register binds ${entry.manifestHash.slice(0, 12)}…. ` +
          `Re-register, or derive a new run — an approval does not follow a swapped envelope.`,
        'CHECKLIST_MISMATCH',
      );
    }
    const shortfall = checklistShortfall(checklist);
    if (shortfall.length > 0) {
      throw new LifecycleError(
        `Release checklist for ${input.runId} is not complete:\n` +
          shortfall.map((p) => `  - ${p}`).join('\n'),
        'CHECKLIST_INCOMPLETE',
      );
    }
    // Written before the state moves, so the evidence for the decision is on
    // disk even if the register write fails.
    writeReleaseChecklist(input.runId, checklist);
  }

  const journalled = appendLifecycle(
    input.runId,
    { from, to: input.to, actor: input.actor, evidence: input.evidence },
    now,
  );

  entry.state = input.to;
  entry.updatedAt = now.toISOString();
  entry.history.push({
    from,
    to: input.to,
    at: now.toISOString(),
    actor: input.actor,
    evidence: input.evidence,
    journalled,
  });

  if ((input.to === 'quarantined' || input.to === 'retired') && register.currentRun?.runId === input.runId) {
    register.currentRun = null;
  }

  writeRegister(register);

  if (input.to === 'released') {
    // Written LAST, and only after the register says released: this marker is
    // what the firewall reads to freeze the directory, so writing it earlier
    // would lock the run out of recording its own transition.
    writeRunFileAtomic(
      input.runId,
      'RELEASED',
      `${JSON.stringify({ runId: input.runId, manifestHash: entry.manifestHash, releasedAt: entry.updatedAt, actor: input.actor }, null, 2)}\n`,
    );
  }

  return { entry, checklist };
}

export function runState(runId: string): ReleaseState | null {
  return readReleaseRegister().entries[runId]?.state ?? null;
}

export interface SetCurrentRunInput {
  runId: string;
  reviewedBy: string;
  reviewEvidence: string;
  now?: Date;
}

/**
 * Point the site at a reviewed run.
 *
 * This replaces "newest generatedAt across data/runs/*", which is a heuristic
 * and not an approval: committing a regenerated mock run would hijack the
 * homepage, and a run that was still being assembled would take the board the
 * moment its timestamp led. Here a board becomes current because a named human
 * reviewed a complete checklist against a released artifact, and the digest of
 * that checklist is recorded next to the decision.
 *
 * The checklist is REBUILT here rather than accepted, for the same reason
 * `transitionRun` rebuilds it: a supplied checklist is a claim about a run made
 * by whatever is publishing that run. Rebuilding also means the pointer cannot
 * be set from a checklist that was true an hour ago and is not true now.
 */
export function setCurrentRun(input: SetCurrentRunInput): CurrentRunPointer {
  const now = input.now ?? new Date();
  requireEvidence(input.reviewedBy, input.reviewEvidence, `setting the current run to ${input.runId}`);

  const register = readReleaseRegister();
  const entry = register.entries[input.runId];
  if (!entry) {
    throw new LifecycleError(`Run ${input.runId} is not in the release register.`, 'RUN_NOT_REGISTERED');
  }
  if (entry.state !== 'released') {
    throw new LifecycleError(
      `Run ${input.runId} is '${entry.state}', not 'released'. Only a released artifact may be the current result.`,
      'NOT_RELEASED',
    );
  }
  const checklist = buildReleaseChecklist(input.runId, now);
  if (checklist.manifestHash !== entry.manifestHash) {
    throw new LifecycleError(
      `Run ${input.runId} now carries manifest ${String(checklist.manifestHash).slice(0, 12)}… but the register binds ${entry.manifestHash.slice(0, 12)}….`,
      'CHECKLIST_MISMATCH',
    );
  }
  const shortfall = checklistShortfall(checklist);
  if (shortfall.length > 0) {
    throw new LifecycleError(
      `Refusing to make ${input.runId} current — its release checklist is not complete:\n` +
        shortfall.map((p) => `  - ${p}`).join('\n'),
      'CHECKLIST_INCOMPLETE',
    );
  }
  // Only a manifest that is itself publishable may be pointed at. The register
  // state and the manifest are two different assertions and both must hold: a
  // 'released' entry over a 'development' manifest is a register that has been
  // edited, not a run that was approved.
  assertPublishable(readRunManifest(input.runId), `setCurrentRun(${input.runId})`);

  const pointer: CurrentRunPointer = {
    runId: input.runId,
    manifestHash: entry.manifestHash,
    reviewedBy: input.reviewedBy,
    reviewedAt: now.toISOString(),
    reviewEvidence: input.reviewEvidence,
    checklistDigest: sha256Hex(canonicalJson(checklist)),
    artifacts: pinArtifacts(input.runId),
  };
  register.currentRun = pointer;
  // The single atomic act of publication: one rename, after which every reader
  // resolves the new release in full or the old one in full.
  writeRegister(register);
  return pointer;
}

/** Throws when no run has been reviewed as current. Absence is a refusal. */
export function readCurrentRun(): CurrentRunPointer {
  const register = readReleaseRegister();
  const pointer = register.currentRun;
  if (!pointer) {
    throw new LifecycleError(
      `No reviewed current run is recorded in ${registerFile()}. A board becomes current by review, not by having the newest timestamp.`,
      'NO_CURRENT_RUN',
    );
  }
  const entry = register.entries[pointer.runId];
  if (!entry || entry.state !== 'released' || entry.manifestHash !== pointer.manifestHash) {
    throw new LifecycleError(
      `The current-run pointer names ${pointer.runId}, but the register does not show it released under manifest ${pointer.manifestHash.slice(0, 12)}….`,
      'NOT_RELEASED',
    );
  }
  // A pointer that pins nothing covers nothing. `?? []` here would have made an
  // absent or emptied `artifacts` array the easiest possible bypass of the
  // check below — the loop simply would not run — so the pin set is required to
  // name every published artifact before any of them is compared.
  const pinnedFiles = new Set((pointer.artifacts ?? []).map((a) => a?.file));
  const unpinned = PUBLISHED_ARTIFACTS.filter((f) => !pinnedFiles.has(f));
  if (unpinned.length > 0) {
    throw new LifecycleError(
      `The current-run pointer for ${pointer.runId} pins no digest for [${unpinned.join(', ')}]. ` +
        `An unpinned artifact can change under a live pointer without any reader noticing.`,
      'ARTIFACT_MISSING',
    );
  }
  // Every pinned artifact must still hash to what was approved. This is the
  // reader half of atomicity: a file replaced under a live pointer is refused
  // rather than served beside the ones that were not replaced.
  for (const pinned of pointer.artifacts) {
    const path = resolveRunFile(pointer.runId, pinned.file, { write: false });
    if (!existsSync(path)) {
      throw new LifecycleError(
        `The approved release names ${pinned.file}, which is no longer present in ${pointer.runId}.`,
        'ARTIFACT_MISSING',
      );
    }
    const actual = sha256Hex(readFileSync(path, 'utf8'));
    if (actual !== pinned.sha256) {
      throw new LifecycleError(
        `${pointer.runId}/${pinned.file} has changed since it was approved (${pinned.sha256.slice(0, 12)}… → ${actual.slice(0, 12)}…). ` +
          `Serving it would show a mixture of two releases.`,
        'ARTIFACT_CHANGED',
      );
    }
  }
  return pointer;
}

export function safeReadCurrentRun():
  | { ok: true; pointer: CurrentRunPointer }
  | { ok: false; error: string } {
  try {
    return { ok: true, pointer: readCurrentRun() };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/**
 * THE publication gate (RELEASE-002 point 5).
 *
 * Every path that creates or updates a public result calls this: writing a
 * board, writing an analysis, syncing a run outwards, publishing it. Previously
 * `assertPublishable` existed and none of them called it, so the capability was
 * checked and the artifact never was.
 *
 * `stage` separates the two honest readings of "publication":
 *
 *   'artifact'  — writing a board or an analysis INTO a run directory. A draft
 *                 must be able to do this; that is how the artifacts the review
 *                 reads come to exist. What is enforced is that the run has a
 *                 manifest, that its artifacts match it, and that the run is
 *                 not frozen. The evidence class is not required to be
 *                 public-release, but it is returned so the caller can STAMP
 *                 it — an unstamped development board is the thing that gets
 *                 mistaken for a result.
 *   'public'    — sync, publish, or pointing the site at a run. Here the full
 *                 RELEASE-002 test applies: an approved public-release manifest
 *                 in 'released', registered as released, with a complete
 *                 checklist.
 */
export interface PublicationClaims {
  /** The run id the caller was asked to act on. */
  requestedRunId: string;
  /** `grant.runId`, where a permit is in play. Required for stage 'public'. */
  permitRunId?: string;
}

export interface PublicationVerdict {
  runId: string;
  manifest: ValidatedRunManifest;
  manifestHash: string;
  /** Non-null for a class that must be labelled NON-SCORING on any surface. */
  nonScoringBanner: string | null;
}

export function assertPublicationAllowed(
  stage: 'artifact' | 'public',
  claims: PublicationClaims,
): PublicationVerdict {
  const runId = claims.requestedRunId;
  const context = `${stage === 'public' ? 'publication' : 'artifact write'} for run ${runId}`;
  // PARSE, never trust: the manifest is read off disk and re-validated here
  // rather than taken from a caller, so no branded object and no `as any` can
  // reach this decision.
  const manifest = readRunManifest(runId);
  const hash = manifestHash(manifest);
  assertRunIdentity(
    {
      requested: runId,
      permit: claims.permitRunId ?? runId,
      manifest: manifest.runId,
      artifact: runId,
    },
    context,
  );
  if (stage === 'public' && claims.permitRunId === undefined) {
    throw new LifecycleError(
      `${context} refused: no permit run id was established. Publication is authorised for one run, and "no permit" is not "any run".`,
      'NOT_PUBLISHABLE',
    );
  }

  const verification = verifyRunManifest(runId, { expectComplete: stage === 'public' });
  if (!verification.ok) {
    throw new LifecycleError(
      `${context} refused: the run's artifacts do not match its manifest:\n` +
        verification.findings
          .filter((f) => f.severity === 'error')
          .map((f) => `  - [${f.code}] ${f.detail}`)
          .join('\n'),
      'NOT_PUBLISHABLE',
    );
  }

  if (stage === 'public') {
    assertPublishable(manifest, context);
    const entry = registerEntry(runId);
    if (!entry) {
      throw new LifecycleError(
        `${context} refused: run ${runId} is not in the release register, so no review has been recorded for it.`,
        'RUN_NOT_REGISTERED',
      );
    }
    if (entry.state !== 'released') {
      throw new LifecycleError(
        `${context} refused: run ${runId} is '${entry.state}', not 'released'.`,
        'NOT_RELEASED',
      );
    }
    if (entry.manifestHash !== hash) {
      throw new LifecycleError(
        `${context} refused: the register binds manifest ${entry.manifestHash.slice(0, 12)}… but the run now carries ${hash.slice(0, 12)}….`,
        'CHECKLIST_MISMATCH',
      );
    }
    const shortfall = checklistShortfall(buildReleaseChecklist(runId));
    if (shortfall.length > 0) {
      throw new LifecycleError(
        `${context} refused: the release checklist does not hold:\n` + shortfall.map((p) => `  - ${p}`).join('\n'),
        'CHECKLIST_INCOMPLETE',
      );
    }
  }

  return { runId, manifest, manifestHash: hash, nonScoringBanner: nonScoringBanner(manifest.evidenceClass) };
}

/**
 * Convenience for the grade/judge path: the stale-score verdict for a run
 * whose stored manifest is compared against the working tree it would rerun in.
 *
 * Both sides come from the run's own artifacts; the digest supplies item-level
 * localisation so an unchanged item's judge score survives an edit to a
 * different item.
 */
export function staleScoresForRun(runId: string, current: ManifestSnapshot): StaleScoreVerdict {
  let digest: ContentDigest | undefined;
  try {
    digest = readRunDigest(runId);
  } catch {
    // No digest means no item-level localisation; detectStaleScores then treats
    // any content change as covering every item, which is the safe direction.
    digest = undefined;
  }
  return detectStaleScores({ manifest: readRunManifest(runId), digest }, current);
}
