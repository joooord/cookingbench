import { existsSync, readFileSync } from 'node:fs';
import {
  RELEASE_STATES,
  canonicalJson,
  safeParseRunManifest,
  type ReleaseState,
  type Score,
  type StoredResponse,
  type ValidatedRunManifest,
} from '@cookingbench/core';
import {
  appendRunFileLine,
  isHistoricalRun,
  resolveOutputPath,
  resolveRunFile,
  writeOutputFileAtomic,
  writeRunFileAtomic,
} from './firewall.js';
import { assertSourceCommitted } from './derive.js';
import {
  readRunDigest,
  readRunManifest,
  verifyRunManifest,
  type ContentDigest,
  type VerifyOptions,
} from './manifest.js';
import { manifestHash, sha256Hex } from './permit.js';

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
  | 'JOURNAL_ID_REQUIRED';

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
  ok: boolean;
  entries: JournalEntry[];
  problems: string[];
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

  return { ok: problems.length === 0, entries, problems };
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

export interface ChecklistInput {
  runId: string;
  now?: Date;
  status?: StatusReport;
  /** Verdict comparing the manifest that produced the scores to the current one. */
  stale?: StaleScoreVerdict;
  /** The lifecycle state the run is transitioning FROM. */
  state?: ReleaseState;
  journals?: readonly string[];
  verify?: VerifyOptions;
}

/**
 * The release gate, expressed as data so it can be committed and rendered.
 *
 * `not-checked` is a FAILURE for release purposes, never a pass. Every check
 * that could not run is a check that did not run, and a checklist whose unknown
 * items read as green is a checklist that certifies its own blind spots.
 */
export function buildReleaseChecklist(input: ChecklistInput): ReleaseChecklist {
  const now = input.now ?? new Date();
  const items: ChecklistItem[] = [];
  let hash: string | null = null;
  let manifest: ValidatedRunManifest | null = null;

  try {
    manifest = readRunManifest(input.runId);
    hash = manifestHash(manifest);
    items.push({
      id: 'manifest-present',
      statement: 'The run carries a valid, coherent manifest naming its evidence class and content hashes.',
      verdict: 'pass',
      detail: `manifest ${hash.slice(0, 12)}…, evidenceClass '${manifest.evidenceClass}'.`,
    });
  } catch (e) {
    items.push({
      id: 'manifest-present',
      statement: 'The run carries a valid, coherent manifest naming its evidence class and content hashes.',
      verdict: 'fail',
      detail: (e as Error).message,
    });
  }

  // `expectComplete` is applied last so a caller's options cannot weaken the
  // release gate into an in-progress audit.
  const verification = verifyRunManifest(input.runId, { ...input.verify, expectComplete: true });
  items.push({
    id: 'artifacts-match-manifest',
    statement: 'Stored artifacts reproduce the bank, prompt, judge-prompt and validator hashes the manifest declares.',
    verdict: verification.ok ? 'pass' : 'fail',
    detail: verification.ok
      ? 'No drift and no undeclared artifacts.'
      : verification.findings
          .filter((f) => f.severity === 'error')
          .map((f) => `[${f.code}] ${f.detail}`)
          .join(' '),
  });

  items.push({
    id: 'evidence-class-publishable',
    statement: "Only a 'public-release' artifact may become a public result (RELEASE-002).",
    verdict: manifest === null ? 'not-checked' : manifest.evidenceClass === 'public-release' ? 'pass' : 'fail',
    detail:
      manifest === null
        ? 'No readable manifest, so the evidence class is unknown.'
        : `evidenceClass '${manifest.evidenceClass}', rankEligible ${manifest.rankEligible}.`,
  });

  items.push({
    id: 'lifecycle-audited',
    statement: 'Release happens from the audited state, never straight from draft.',
    verdict: input.state === undefined ? 'not-checked' : input.state === 'audited' ? 'pass' : 'fail',
    detail: input.state === undefined ? 'No lifecycle state supplied.' : `state '${input.state}'.`,
  });

  items.push({
    id: 'coverage-complete',
    statement: 'Every declared model × item cell is in a terminal score/adjudication state.',
    verdict: input.status === undefined ? 'not-checked' : input.status.complete ? 'pass' : 'fail',
    detail:
      input.status === undefined
        ? 'No status report supplied.'
        : `${input.status.total - input.status.incomplete.length}/${input.status.total} terminal; ` +
          `outstanding: ${summariseCounts(input.status)}.`,
  });

  items.push({
    id: 'no-unadjudicated-flags',
    statement: 'No cross-judge disagreement is still waiting for human review.',
    verdict: input.status === undefined ? 'not-checked' : input.status.counts.flagged === 0 ? 'pass' : 'fail',
    detail:
      input.status === undefined
        ? 'No status report supplied.'
        : `${input.status.counts.flagged} flagged cell(s) unadjudicated.`,
  });

  items.push({
    id: 'no-stale-scores',
    statement: 'No score was produced under a prompt, item, panel or grader that has since changed.',
    verdict: input.stale === undefined ? 'not-checked' : input.stale.reasons.length === 0 ? 'pass' : 'fail',
    detail:
      input.stale === undefined
        ? 'No stale-score verdict supplied; supply one comparing the manifest the scores were produced under.'
        : input.stale.reasons.map((r) => `[${r.code}] ${r.detail}`).join(' ') || 'No invalidating change.',
  });

  const journals = input.journals ?? [ANSWER_JOURNAL, BALLOT_JOURNAL];
  const journalProblems = journals.flatMap((journal) => {
    const result = verifyJournal(input.runId, journal);
    return result.problems.map((p) => `${journal}: ${p}`);
  });
  items.push({
    id: 'journals-intact',
    statement: 'The append-only answer and ballot journals verify end to end.',
    verdict: journalProblems.length === 0 ? 'pass' : 'fail',
    detail: journalProblems.length === 0 ? `${journals.join(', ')} intact.` : journalProblems.join(' '),
  });

  items.push(committedCheck(input.runId));

  const checklist: ReleaseChecklist = {
    checklistVersion: 1,
    runId: input.runId,
    generatedAt: now.toISOString(),
    manifestHash: hash,
    items,
    complete: items.every((i) => i.verdict === 'pass'),
  };
  return checklist;
}

function summariseCounts(status: StatusReport): string {
  const outstanding = CELL_STATUSES.filter(
    (s) => !TERMINAL_CELL_STATUSES.includes(s) && status.counts[s] > 0,
  ).map((s) => `${s}=${status.counts[s]}`);
  return outstanding.length === 0 ? 'none' : outstanding.join(', ');
}

function committedCheck(runId: string): ChecklistItem {
  const statement = 'The run directory is committed, so the released artifacts are the ones in git.';
  try {
    const treeHash = assertSourceCommitted(runId);
    return { id: 'artifacts-committed', statement, verdict: 'pass', detail: `tree ${treeHash.slice(0, 12)}….` };
  } catch (e) {
    return { id: 'artifacts-committed', statement, verdict: 'fail', detail: (e as Error).message };
  }
}

/** Recomputed from the items. The stored `complete` flag is never trusted. */
export function checklistComplete(checklist: ReleaseChecklist): boolean {
  return (
    Array.isArray(checklist.items) &&
    checklist.items.length > 0 &&
    checklist.items.every((i) => i.verdict === 'pass')
  );
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

export interface CurrentRunPointer {
  runId: string;
  manifestHash: string;
  reviewedBy: string;
  reviewedAt: string;
  reviewEvidence: string;
  /** sha256 of the canonical checklist that backed the decision. */
  checklistDigest: string;
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
export function readReleaseRegister(file: string = REGISTER_FILE): ReleaseRegister {
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

function writeRegister(register: ReleaseRegister, file: string): string {
  return writeOutputFileAtomic('runs', file, `${JSON.stringify(register, null, 2)}\n`);
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
  file?: string;
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
  const file = input.file ?? REGISTER_FILE;
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

  const register = readReleaseRegister(file);
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
  writeRegister(register, file);
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
  /** Required for a transition to `released`. */
  checklist?: ReleaseChecklist;
  now?: Date;
  file?: string;
}

/**
 * Move a run through the lifecycle.
 *
 * Preconditions, not conventions: releasing requires a COMPLETE checklist bound
 * to this run and this manifest hash, and the pointer is cleared automatically
 * when the run it names is quarantined or retired — a current-run pointer that
 * survives its own run's quarantine would keep serving the withdrawn board.
 */
export function transitionRun(input: TransitionInput): RegisterEntry {
  const file = input.file ?? REGISTER_FILE;
  const now = input.now ?? new Date();
  requireEvidence(input.actor, input.evidence, `transitioning ${input.runId} to '${input.to}'`);
  if (!isReleaseState(input.to)) {
    throw new LifecycleError(`Unknown target state ${JSON.stringify(input.to)}.`, 'UNKNOWN_STATE');
  }

  const register = readReleaseRegister(file);
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

  if (input.to === 'released') {
    const checklist = input.checklist;
    if (!checklist) {
      throw new LifecycleError(
        `Releasing ${input.runId} requires a release checklist. Build one with buildReleaseChecklist.`,
        'CHECKLIST_INCOMPLETE',
      );
    }
    if (checklist.runId !== input.runId) {
      throw new LifecycleError(
        `Checklist names run '${checklist.runId}', not '${input.runId}'.`,
        'CHECKLIST_MISMATCH',
      );
    }
    if (checklist.manifestHash !== entry.manifestHash) {
      throw new LifecycleError(
        `Checklist was built against manifest ${String(checklist.manifestHash).slice(0, 12)}… but the register binds ${entry.manifestHash.slice(0, 12)}….`,
        'CHECKLIST_MISMATCH',
      );
    }
    if (!checklistComplete(checklist)) {
      const failing = checklist.items.filter((i) => i.verdict !== 'pass');
      throw new LifecycleError(
        `Release checklist for ${input.runId} is not complete:\n` +
          failing.map((i) => `  - [${i.verdict}] ${i.id}: ${i.detail}`).join('\n'),
        'CHECKLIST_INCOMPLETE',
      );
    }
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

  writeRegister(register, file);

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

  return entry;
}

export function runState(runId: string, file: string = REGISTER_FILE): ReleaseState | null {
  return readReleaseRegister(file).entries[runId]?.state ?? null;
}

export interface SetCurrentRunInput {
  runId: string;
  reviewedBy: string;
  reviewEvidence: string;
  checklist: ReleaseChecklist;
  now?: Date;
  file?: string;
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
 */
export function setCurrentRun(input: SetCurrentRunInput): CurrentRunPointer {
  const file = input.file ?? REGISTER_FILE;
  const now = input.now ?? new Date();
  requireEvidence(input.reviewedBy, input.reviewEvidence, `setting the current run to ${input.runId}`);

  const register = readReleaseRegister(file);
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
  if (input.checklist.runId !== input.runId || input.checklist.manifestHash !== entry.manifestHash) {
    throw new LifecycleError(
      `The checklist supplied does not belong to run ${input.runId} at manifest ${entry.manifestHash.slice(0, 12)}….`,
      'CHECKLIST_MISMATCH',
    );
  }
  if (!checklistComplete(input.checklist)) {
    throw new LifecycleError(
      `Refusing to make ${input.runId} current: its release checklist is not complete.`,
      'CHECKLIST_INCOMPLETE',
    );
  }

  const pointer: CurrentRunPointer = {
    runId: input.runId,
    manifestHash: entry.manifestHash,
    reviewedBy: input.reviewedBy,
    reviewedAt: now.toISOString(),
    reviewEvidence: input.reviewEvidence,
    checklistDigest: sha256Hex(canonicalJson(input.checklist)),
  };
  register.currentRun = pointer;
  writeRegister(register, file);
  return pointer;
}

/** Throws when no run has been reviewed as current. Absence is a refusal. */
export function readCurrentRun(file: string = REGISTER_FILE): CurrentRunPointer {
  const register = readReleaseRegister(file);
  const pointer = register.currentRun;
  if (!pointer) {
    throw new LifecycleError(
      `No reviewed current run is recorded in ${file}. A board becomes current by review, not by having the newest timestamp.`,
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
  return pointer;
}

export function safeReadCurrentRun(
  file: string = REGISTER_FILE,
): { ok: true; pointer: CurrentRunPointer } | { ok: false; error: string } {
  try {
    return { ok: true, pointer: readCurrentRun(file) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
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
