import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  canonicalJson,
  type RunBatch,
  type RunConfig,
  type Score,
  type StoredResponse,
} from '@cookingbench/core';
import { RUNS_DIR, loadQuestions } from './dataset.js';
import {
  FirewallError,
  assertSafePathComponent,
  readRunFile,
  readRunFileOrNull,
  readRunJsonEntries,
  resolveRunDir,
  resolveRunFile,
  writeRunFileAtomic,
} from './firewall.js';
import { ManifestError, computeContentDigest, readRunManifest, type PromptSettings } from './manifest.js';
import { manifestHash, sha256Hex } from './permit.js';

/**
 * Every run-scoped path in this module resolves through the firewall
 * (WP-0, DATA-001). Reads may target a historical run; writes may not, and
 * neither may escape the runs directory.
 *
 * This replaced a bare `join(RUNS_DIR, runId)` on an unvalidated argv string.
 */
function runDir(runId: string): string {
  return resolveRunDir(runId, { write: false });
}

function runDirForWrite(runId: string): string {
  return resolveRunDir(runId, { write: true });
}

/**
 * The legacy, LOSSY filename encoding. Kept only to read artifacts written
 * before WP-0: it collapses every run of non-word characters to "__", so
 * `openai/gpt-5.5` and `openai:gpt-5.5` produce the same filename and one
 * response silently overwrites the other.
 */
function legacySafeName(modelId: string): string {
  return modelId.replace(/[^\w.-]+/g, '__');
}

/**
 * Injective, reversible component encoding: anything outside [A-Za-z0-9._-]
 * becomes ~XX hex, and "~" itself is escaped first so the mapping stays
 * one-to-one. Distinct model ids can no longer share a stored cell.
 */
const ALLOWED_FILENAME_CHAR = /^[A-Za-z0-9.-]$/;
/** ext4/APFS cap is 255 bytes; leave room for the ".json" suffix and staging. */
const MAX_FILENAME_BYTES = 200;

/**
 * Injective component encoding.
 *
 * Two defects in the previous version, both reproduced:
 *   - `_` was inside the allowed set while `__` was the field separator, so
 *     ("a/b", "c__d") and ("a/b__c", "d") produced the same filename. `_` is
 *     now encoded, which makes `__` unambiguously a separator.
 *   - the regex walked UTF-16 code UNITS, so each half of a surrogate pair was
 *     encoded separately and TextEncoder turned every lone surrogate into
 *     U+FFFD — 😀 and 🚀 both became ~EF~BF~BD~EF~BF~BD. Iterating with
 *     `for...of` yields whole code points.
 */
function encodeComponent(value: string): string {
  let out = '';
  for (const ch of value) {
    if (ch === '~') {
      out += '~7E';
    } else if (ALLOWED_FILENAME_CHAR.test(ch)) {
      out += ch;
    } else {
      for (const b of new TextEncoder().encode(ch)) {
        out += `~${b.toString(16).toUpperCase().padStart(2, '0')}`;
      }
    }
  }
  return out;
}

function responseFileName(modelId: string, questionId: string): string {
  // Validate the RAW values first. Encoding would happily turn
  // `../../../etc/passwd` into a safe-but-mangled filename, which hides bad
  // input rather than refusing it — a question id containing a separator is a
  // bug upstream, not something to silently rewrite. Model ids legitimately
  // contain "/", so only the question id is checked for separators.
  assertSafePathComponent(questionId, 'question id');
  if (modelId === '' || modelId.includes('\0') || modelId.length > 160) {
    throw new FirewallError(
      `Unsafe model id ${JSON.stringify(modelId)}.`,
      'INVALID_PATH_COMPONENT',
    );
  }
  const name = `${encodeComponent(modelId)}__${encodeComponent(questionId)}.json`;
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes > MAX_FILENAME_BYTES) {
    throw new FirewallError(
      `Encoded response filename is ${bytes} bytes, over the ${MAX_FILENAME_BYTES}-byte limit (${modelId} × ${questionId}). Escaping can expand an accepted input past the filesystem bound.`,
      'INVALID_PATH_COMPONENT',
    );
  }
  return name;
}

// ---------------------------------------------------------------------------
// RUN-002 — protocol consistency
// ---------------------------------------------------------------------------

/**
 * RUN-002: "A resumed run must preserve all rank-affecting settings and hashes.
 * Mixed routes, prompts, banks, settings or methodology versions fail rather
 * than warn. Retry IDs are deterministic and idempotent."
 *
 * What was here before was the exact inverse. `mergeRunConfig` printed
 *
 *     ⚠ temperature changed within run …: 0 → 0.7
 *
 * and then merged the new config over the old one, so a single run id could
 * hold two protocols and publish one leaderboard over both. A warning on a
 * non-interactive batch run is a line of scrollback; the scores it produces
 * outlive it and carry no memory of the change.
 *
 * Three things close it, and they are deliberately layered so that no single
 * omission reopens the hole:
 *
 *   1. Any change to a rank-affecting setting THROWS. The rank-affecting set is
 *      enumerated explicitly AND derived by exclusion — a field this file has
 *      never heard of is rank-affecting by default, because the failure mode we
 *      are designing against is somebody adding a field and forgetting to
 *      classify it.
 *   2. Every batch is bound to the full set of rank-affecting settings and to
 *      the four content hashes (bank, prompt, judge prompt, validator) as they
 *      stood when that batch ran, and the binding is persisted in config.json.
 *      A mid-run change therefore cannot be silent even in the cases the
 *      comparison cannot see (a change inside a single batch).
 *   3. Attempt identity is DERIVED from the coordinate it belongs to, never
 *      counted, so a replay lands on the same record instead of minting a
 *      second answer and a second charge.
 *
 * The hash helpers are imported from manifest.ts rather than reimplemented.
 * A second, subtly different canonicalisation of the same content would produce
 * digests that disagree with the ones permits are signed over — the failure
 * would look exactly like tampering, at the worst possible moment.
 */

export type ProtocolErrorCode =
  | 'PROTOCOL_CHANGED'
  | 'PROTOCOL_UNCOMPUTABLE'
  | 'ANSWER_ALREADY_STORED'
  | 'ATTEMPT_ALREADY_SETTLED'
  | 'ATTEMPT_UNREADABLE'
  | 'UNKNOWN_ATTEMPT_CAUSE';

export class ProtocolViolationError extends Error {
  constructor(
    message: string,
    readonly code: ProtocolErrorCode,
  ) {
    super(message);
    this.name = 'ProtocolViolationError';
  }
}

/** Shape version of the stored binding. Bumped only for a breaking change. */
export const PROTOCOL_VERSION = 1;

/**
 * Fields that MUST be identical across every batch of a run, named one by one.
 *
 * Enumerated as well as derived by exclusion because the brief asks for them by
 * name, and because a named field that goes MISSING from a later config has to
 * read as a change rather than as an absence: every name here is projected even
 * when the config does not carry it (as `null`), so deleting a field is as loud
 * as editing one.
 *
 * The last four are not in `RunConfig` today. They are listed anyway, so that
 * the day a route table, a per-model revision pin, a separate candidate-prompt
 * version or a scoring-implementation version is added, it is rank-affecting
 * from its first commit rather than from whenever someone remembers.
 */
const RANK_AFFECTING_FIELDS = [
  'temperature',
  'maxTokens',
  'maxTokensRecipe',
  'judgeModel',
  'judgePanel',
  'judgePromptVersion',
  'methodologyVersion',
  'mock',
  'modelRoutes',
  'modelRevisions',
  'promptVersion',
  'scoringVersion',
] as const;

/**
 * The ONLY fields a resumed run may change, each with the reason it is safe.
 *
 * Everything not on this list is rank-affecting, including a field added
 * tomorrow. That direction matters: an allow-list of ignorable fields fails
 * closed when it is out of date, whereas a deny-list of rank-affecting fields
 * fails open in exactly the same circumstance.
 */
const OPERATIONAL_FIELDS: ReadonlySet<string> = new Set([
  // Identity of the run itself. It selects the directory being written; it is
  // not a setting the run could hold two values of.
  'runId',
  // The model set GROWS batch by batch on purpose — per-model batching is the
  // documented way to run this benchmark, and adding a fourteenth model does
  // not change how the first thirteen were measured. What may not vary is the
  // protocol each model was measured under, and that is exactly what the rest
  // of this projection pins. A model's ROUTE (as opposed to the set) is
  // rank-affecting and is reserved above as `modelRoutes`/`modelRevisions`.
  'models',
  // Per-batch spend authorisations, summed for the audit trail. A budget can
  // only stop a run early; it cannot change an answer. The real financial
  // ceiling is enforced against actual spend by the reservation ledger
  // (BUDGET-001), not by this record.
  'budgetUsdTotal',
  // Same reasoning, and additionally clamped below: a later batch may LOWER the
  // recorded per-model cap but never raise it.
  'budgetUsdPerModel',
  // Throughput only. It can influence how often a provider rate-limits, which
  // is transport noise already surfaced as an incident, not a scored quantity.
  'concurrency',
  // Accounting written by `bench judge` after the fact.
  'judgeCostUsd',
  // The audit trail itself, and the binding this module writes into it.
  'batches',
  'protocol',
  // Lifecycle state (draft/audited/…), governed by DATA-001 and RELEASE-002.
  // It says whether the artifact may be written or published, not how anything
  // in it was measured.
  'releaseState',
]);

export interface ProtocolContent {
  /** Parsed item content of the bank, per manifest.ts. */
  bankHash: string;
  /** Rendered candidate prompts, including the token caps they resolve to. */
  promptHash: string;
  /** Rendered judge prompts, including reference answers and attention hints. */
  judgePromptHash: string;
  /** Grader source — the scoring implementation. */
  validatorHash: string;
  /** The run's manifest, when it has one. Null before DATA-002's writer runs. */
  manifestHash: string | null;
}

export interface ProtocolBinding {
  protocolVersion: number;
  /** The rank-affecting projection of the config, normalised and sorted. */
  settings: Record<string, unknown>;
  content: ProtocolContent;
  /**
   * Digest of `{protocolVersion, settings, content}`.
   *
   * `source` is deliberately OUTSIDE the hash: a binding reconstructed for a
   * pre-RUN-002 config must be able to compare equal to a freshly computed one,
   * or every legacy run would be unresumable for a reason that has nothing to
   * do with its protocol.
   */
  protocolHash: string;
  /**
   * `working-tree` — computed from the code and data present when this batch
   * ran. `reconstructed` — inferred from a config written before bindings
   * existed, whose content hashes at the time are unknowable. The distinction is
   * recorded rather than smoothed over: reconstruction cannot invent history,
   * and an auditor must be able to see which entries are evidence and which are
   * inference.
   */
  source: 'working-tree' | 'reconstructed';
  boundAtIso: string;
}

export interface BoundRunBatch extends RunBatch {
  /** Derived from the batch's own content — see `batchIdFor`. */
  batchId: string;
  protocol: ProtocolBinding;
}

export interface BoundRunConfig extends RunConfig {
  /** The run's protocol, frozen at the first batch. */
  protocol?: ProtocolBinding;
  batches?: BoundRunBatch[];
}

/**
 * Identity versions, pinned SEPARATELY from `PROTOCOL_VERSION`.
 *
 * A derived id is a promise that the same input yields the same id forever. If
 * batch, attempt and answer ids were versioned by the binding's shape version,
 * then bumping that shape — a purely cosmetic change to what the binding
 * records — would re-mint every id, orphan every existing attempt record and
 * licence a second charge for work already paid for. The shape may move; the
 * identities may not, and these constants say so.
 */
const BATCH_ID_VERSION = 1;
const ATTEMPT_ID_VERSION = 1;
const ANSWER_HASH_VERSION = 1;

function digest(kind: string, version: number, payload: unknown): string {
  // The kind and version are inside the hashed structure rather than merely
  // prefixed, so two different kinds of record cannot collide by carrying the
  // same fields.
  return sha256Hex(canonicalJson({ kind, version, payload }));
}

/**
 * Normalise one projected value so that "absent", "undefined" and "null" are
 * one value, and so that an ordering that carries no meaning cannot read as a
 * change.
 *
 * `judgePanel` is sorted because seat selection is by FNV-1a hash of the ids,
 * not by position: `[a, b]` and `[b, a]` are the same panel and must not fail a
 * resume. Nothing else is reordered — for an unknown field we do not know
 * whether order is meaningful, and the fail-closed reading is that it is.
 */
function normaliseSetting(key: string, value: unknown): unknown {
  if (key === 'mock') return value === true;
  if (key === 'judgePanel') {
    return Array.isArray(value) ? [...value].map(String).sort() : null;
  }
  return value ?? null;
}

/**
 * The rank-affecting projection of a config.
 *
 * Union of the named fields and every field the config carries that is not on
 * the operational allow-list, so an unrecognised field is included by default.
 */
function rankAffectingProjection(config: Record<string, unknown>): Record<string, unknown> {
  const keys = new Set<string>(RANK_AFFECTING_FIELDS);
  for (const key of Object.keys(config)) {
    if (!OPERATIONAL_FIELDS.has(key)) keys.add(key);
  }
  const out: Record<string, unknown> = {};
  for (const key of [...keys].sort()) out[key] = normaliseSetting(key, config[key]);
  return out;
}

/**
 * The four content hashes as the working tree stands right now, plus the run's
 * manifest hash if it has one.
 *
 * Computed from the WORKING TREE rather than read out of the manifest on
 * purpose. A frozen manifest cannot notice that the bank changed underneath it;
 * the whole point of binding a batch is to record what that batch actually ran
 * against. (manifest.ts verifies the other direction — that the run's declared
 * hashes still reproduce — and the two checks are complementary.)
 *
 * The prompt hashes depend on the token caps, which is why the caps are an
 * input: the measured lesson on this roster is that the cap changes the answer.
 */
function contentHashesNow(runId: string, settings: PromptSettings): ProtocolContent {
  let bankHash: string;
  let promptHash: string;
  let judgePromptHash: string;
  let validatorHash: string;
  try {
    const computed = computeContentDigest(loadQuestions(), settings);
    ({ bankHash, promptHash, judgePromptHash, validatorHash } = computed);
  } catch (e) {
    // Fail closed. A run whose content cannot be hashed cannot be bound to
    // anything, and an unbound batch is precisely what RUN-002 forbids.
    throw new ProtocolViolationError(
      `Cannot compute the content hashes that bind run ${runId} to its protocol: ${(e as Error).message}`,
      'PROTOCOL_UNCOMPUTABLE',
    );
  }
  return { bankHash, promptHash, judgePromptHash, validatorHash, manifestHash: manifestHashOf(runId) };
}

/**
 * The run's manifest hash, or null when it has none.
 *
 * Only ABSENCE is tolerated. A manifest that exists but does not validate is an
 * incident: refusing here stops a batch from running under an envelope nobody
 * can read, rather than recording `null` and carrying on as though the run were
 * unmanifested.
 */
function manifestHashOf(runId: string): string | null {
  try {
    return manifestHash(readRunManifest(runId));
  } catch (e) {
    if (e instanceof ManifestError && e.code === 'MANIFEST_ABSENT') return null;
    throw e;
  }
}

/**
 * Bind a config to a content snapshot.
 *
 * The snapshot is taken ONCE per command call and passed in, rather than being
 * recomputed per binding: the prior and the incoming binding must be compared
 * against the same working tree, or a bank edit landing between two reads would
 * read as a protocol change that neither config asked for.
 */
function bindingFor(config: Record<string, unknown>, content: ProtocolContent): ProtocolBinding {
  const projection = rankAffectingProjection(config);
  return {
    protocolVersion: PROTOCOL_VERSION,
    settings: projection,
    content,
    protocolHash: digest('cookingbench/protocol', PROTOCOL_VERSION, {
      settings: projection,
      content,
    }),
    source: 'working-tree',
    boundAtIso: new Date().toISOString(),
  };
}

/**
 * The protocol a run is already committed to.
 *
 * Preference order is strongest evidence first: the run's own declared binding,
 * then the most recent batch that carries one, then a reconstruction from the
 * config's fields. Reconstruction fills the content hashes with today's values
 * and marks itself `reconstructed`, because what the earlier batch hashed to is
 * genuinely unknown — inventing a hash there would be worse than admitting it.
 */
function priorBinding(prior: BoundRunConfig, content: ProtocolContent): ProtocolBinding {
  if (prior.protocol && typeof prior.protocol.protocolHash === 'string') return prior.protocol;
  const fromBatch = [...(prior.batches ?? [])]
    .reverse()
    .find((b) => b?.protocol && typeof b.protocol.protocolHash === 'string');
  if (fromBatch) return fromBatch.protocol;
  return {
    ...bindingFor(prior as unknown as Record<string, unknown>, content),
    source: 'reconstructed',
  };
}

const HASH_LABELS: Record<keyof ProtocolContent, string> = {
  bankHash: 'the question bank',
  promptHash: 'the rendered candidate prompts (or their token caps)',
  judgePromptHash: 'the judge prompt (or a reference answer inside it)',
  validatorHash: 'the grader/scoring source',
  manifestHash: 'the run manifest',
};

function short(value: string | null): string {
  if (value === null) return 'none';
  return value.length > 20 ? `${value.slice(0, 12)}…` : value;
}

/** Every difference between two bindings, in reader-facing terms. */
function protocolDifferences(prior: ProtocolBinding, next: ProtocolBinding): string[] {
  const diffs: string[] = [];
  const keys = new Set([...Object.keys(prior.settings ?? {}), ...Object.keys(next.settings ?? {})]);
  for (const key of [...keys].sort()) {
    const a = canonicalJson(prior.settings?.[key] ?? null);
    const b = canonicalJson(next.settings?.[key] ?? null);
    if (a !== b) diffs.push(`${key}: ${short(a)} → ${short(b)}`);
  }
  for (const key of Object.keys(HASH_LABELS) as Array<keyof ProtocolContent>) {
    const a = prior.content?.[key] ?? null;
    const b = next.content?.[key] ?? null;
    if (a === b) continue;
    // A run that had no manifest and now has one has been STRENGTHENED, not
    // changed: nothing was declared before, so nothing was contradicted. Every
    // other transition — a different manifest, or a manifest disappearing — is
    // a change of the envelope the run executes under.
    if (key === 'manifestHash' && a === null) continue;
    diffs.push(`${key} (${HASH_LABELS[key]}): ${short(a)} → ${short(b)}`);
  }
  return diffs;
}

/**
 * The RUN-002 gate. Refuses rather than warns.
 *
 * Called by both writers in this module, so there is no config-writing path
 * that can skip it: `bench run` reaches it through `mergeRunConfig`, and
 * `bench judge` — which rewrites judgeModel, judgePanel and judgePromptVersion
 * on an existing run — reaches it through `writeRunConfig`. That second path is
 * the one a check bolted onto the merge function alone would have missed.
 */
function assertProtocolPreserved(
  prior: BoundRunConfig,
  next: Record<string, unknown>,
  content: ProtocolContent,
): ProtocolBinding {
  const nextBinding = bindingFor(next, content);
  const priorB = priorBinding(prior, content);
  const diffs = protocolDifferences(priorB, nextBinding);
  if (diffs.length === 0) {
    // The field-level comparison is the EXPLANATION; the hash is the authority.
    // If every field this build knows how to compare agrees and the hashes still
    // disagree, then either the binding shape has gained a field that
    // `protocolDifferences` does not enumerate, or a stored binding was edited
    // by hand. A comparison that cannot account for a difference has not proved
    // sameness, so it refuses. The single legitimate exception is the one the
    // difference list already allows: an unmanifested run acquiring a manifest.
    if (
      priorB.protocolHash === nextBinding.protocolHash ||
      (priorB.content?.manifestHash === null && nextBinding.content.manifestHash !== null)
    ) {
      return nextBinding;
    }
    diffs.push(
      `protocolHash: ${short(priorB.protocolHash ?? null)} → ${short(nextBinding.protocolHash)} ` +
        `(the bindings differ in a way this build cannot itemise — treat it as a protocol change)`,
    );
  }
  const runId = String(next.runId ?? prior.runId);
  throw new ProtocolViolationError(
    `Run ${runId} is already committed to a protocol and ${diffs.length} rank-affecting item(s) changed:\n` +
      diffs.map((d) => `  - ${d}`).join('\n') +
      `\nA resumed run must preserve every rank-affecting setting and hash (RUN-002): answers measured under ` +
      `different settings are not comparable, and one leaderboard cannot describe two protocols. ` +
      `Use a new --run-id for the new protocol.` +
      (priorB.source === 'reconstructed'
        ? `\n(The prior protocol was reconstructed from a config written before bindings existed; its content hashes at the time are unknown.)`
        : ''),
    'PROTOCOL_CHANGED',
  );
}

/**
 * Identity of one batch, derived from what the batch IS.
 *
 * Derived rather than counted for the same reason retry ids are: a replayed
 * invocation — the same config object handed to `mergeRunConfig` twice, a
 * crashed command re-run from a shell history — must land on the same batch
 * record instead of appending a second one and double-counting its authorised
 * budget.
 */
export function batchIdFor(runId: string, batch: RunBatch, protocolHash: string): string {
  return `bat_${digest('cookingbench/batch', BATCH_ID_VERSION, {
    runId,
    startedAt: batch.startedAt,
    models: [...batch.models].sort(),
    maxTokens: batch.maxTokens,
    maxTokensRecipe: batch.maxTokensRecipe,
    budgetUsdTotal: batch.budgetUsdTotal,
    protocolHash,
  }).slice(0, 32)}`;
}

/** A batch's identity as an operator states it, before any binding is attached. */
function batchKey(batch: RunBatch): string {
  return canonicalJson({
    startedAt: batch.startedAt,
    models: [...batch.models].sort(),
    maxTokens: batch.maxTokens,
    maxTokensRecipe: batch.maxTokensRecipe,
    budgetUsdTotal: batch.budgetUsdTotal,
  });
}

/**
 * Give every batch its derived id and the protocol it ran under.
 *
 * A binding is only ever kept when it is already ON DISK for that batch. A
 * binding arriving on the incoming config is ignored and recomputed, because a
 * caller that can hand in its own binding chooses the standard it is judged
 * against — which is the failure this requirement exists to prevent. Recorded
 * history still wins over recomputation, so an earlier batch is never restamped
 * with today's hashes.
 *
 * The fallback is a thunk because reconstructing a binding costs a full
 * working-tree hash, and the common case must not pay for it.
 */
function bindBatches(
  runId: string,
  batches: RunBatch[] | undefined,
  stored: BoundRunBatch[] | undefined,
  fallback: () => ProtocolBinding,
): BoundRunBatch[] {
  const recorded = new Map<string, BoundRunBatch>();
  for (const batch of stored ?? []) {
    if (batch?.protocol?.protocolHash) recorded.set(batchKey(batch), batch);
  }
  return (batches ?? []).map((batch) => {
    const known = recorded.get(batchKey(batch));
    if (known) return known;
    const protocol = fallback();
    return {
      // Any `protocol` or `batchId` the caller attached is spread in here and
      // then overwritten by the two keys below. Both are derived, never taken.
      ...(batch as RunBatch),
      batchId: batchIdFor(runId, batch, protocol.protocolHash),
      protocol,
    };
  });
}

function settingsOf(config: Record<string, unknown>): PromptSettings {
  const maxTokens = config.maxTokens;
  const maxTokensRecipe = config.maxTokensRecipe;
  if (typeof maxTokens !== 'number' || typeof maxTokensRecipe !== 'number') {
    // The prompt hash is rendered at these caps. Guessing a default would hash
    // prompts nobody ran.
    throw new ProtocolViolationError(
      `Run config for ${String(config.runId)} must declare numeric maxTokens and maxTokensRecipe before its protocol can be bound.`,
      'PROTOCOL_UNCOMPUTABLE',
    );
  }
  return { maxTokens, maxTokensRecipe };
}

/** The raw write. Both public writers reach it only after the gate above. */
function persistRunConfig(config: BoundRunConfig): BoundRunConfig {
  mkdirSync(join(runDirForWrite(config.runId), 'responses'), { recursive: true });
  writeRunFileAtomic(config.runId, 'config.json', JSON.stringify(config, null, 2));
  return config;
}

/**
 * Write a run's config, stamping its protocol binding.
 *
 * On an existing run this is a gate, not a replacement: `bench judge` overwrites
 * judgeModel/judgePanel/judgePromptVersion here, and a judge prompt that has
 * moved since the candidates ran is exactly the "mixed prompts" case RUN-002
 * names.
 */
export function writeRunConfig(config: RunConfig): BoundRunConfig {
  const incoming = config as unknown as Record<string, unknown>;
  const content = contentHashesNow(config.runId, settingsOf(incoming));
  const path = resolveRunFile(config.runId, 'config.json', { write: false });
  const prior = existsSync(path) ? readRunConfig(config.runId) : undefined;
  const binding = prior
    ? assertProtocolPreserved(prior, incoming, content)
    : bindingFor(incoming, content);
  return persistRunConfig({
    ...(config as BoundRunConfig),
    // The run's protocol is frozen at the first batch; a later write records it
    // rather than restating it.
    protocol: prior?.protocol ?? binding,
    batches: bindBatches(config.runId, config.batches, prior?.batches, () => binding),
  });
}

/**
 * Record a `bench run` invocation, merging it into any config already written
 * for this run id instead of replacing it.
 *
 * A run is assembled from several batches on purpose — per-model budgets are
 * how the estimate gate stays tight — so the config a run publishes has to
 * describe the whole run, not whichever batch happened to go last.
 *
 * Rank-affecting settings and content hashes are CHECKED and refused on change
 * (RUN-002); `models` becomes the union, and `budgetUsdTotal` the sum of what
 * each distinct batch was authorised to spend.
 *
 * Judge state (`judgeCostUsd`) is written by `bench judge` and is deliberately
 * carried through untouched — re-running a candidate batch must not erase it.
 */
export function mergeRunConfig(config: RunConfig): BoundRunConfig {
  const path = resolveRunFile(config.runId, 'config.json', { write: false });
  if (!existsSync(path)) return writeRunConfig(config);

  const prior = readRunConfig(config.runId);
  const incoming = config as unknown as Record<string, unknown>;
  const content = contentHashesNow(config.runId, settingsOf(incoming));

  if ((prior.mock ?? false) !== (config.mock ?? false)) {
    // Checked ahead of the general comparison purely for the clearer message;
    // `mock` is in the rank-affecting projection and would be caught anyway.
    throw new ProtocolViolationError(
      `Run ${config.runId} already has mock=${prior.mock ?? false} responses; refusing to mix mock and live batches in one run id. Use a different --run-id.`,
      'PROTOCOL_CHANGED',
    );
  }
  const binding = assertProtocolPreserved(prior, incoming, content);
  // Batches inherited from a config written before bindings existed are marked
  // as the inference they are: what those batches actually hashed to is
  // unknowable, and recording today's hashes as though they were measured then
  // would be a fabricated audit trail.
  const inferred = (): ProtocolBinding => ({ ...priorBinding(prior, content), source: 'reconstructed' });

  const priorBatches: BoundRunBatch[] = prior.batches?.length
    ? bindBatches(config.runId, prior.batches, prior.batches, inferred)
    : // Pre-existing config with no batch log: reconstruct the one batch we can
      // prove happened, so the union below does not drop those models.
      bindBatches(
        config.runId,
        [
          {
            startedAt: 'unknown',
            models: prior.models,
            maxTokens: prior.maxTokens,
            maxTokensRecipe: prior.maxTokensRecipe,
            budgetUsdTotal: prior.budgetUsdTotal,
          },
        ],
        undefined,
        inferred,
      );

  // Deduplicate by derived batch id. An identical invocation replayed — the
  // same config handed back to this function, a command re-run after a crash —
  // is the SAME batch, and must not be counted, or budgeted, twice.
  const batches: BoundRunBatch[] = [];
  const seen = new Set<string>();
  for (const batch of [
    ...priorBatches,
    ...bindBatches(config.runId, config.batches, prior.batches, () => binding),
  ]) {
    if (seen.has(batch.batchId)) continue;
    seen.add(batch.batchId);
    batches.push(batch);
  }

  const merged: BoundRunConfig = {
    ...prior,
    ...config,
    models: [...new Set([...prior.models, ...config.models])].sort(),
    budgetUsdTotal: batches.reduce((sum, b) => sum + b.budgetUsdTotal, 0),
    // A per-model cap may only ever be tightened on resume. Zero means "unset"
    // (the CLI's default when the flag is absent) and is not a tightening.
    budgetUsdPerModel: lowerCap(prior.budgetUsdPerModel, config.budgetUsdPerModel),
    judgeCostUsd: prior.judgeCostUsd ?? config.judgeCostUsd,
    protocol: prior.protocol ?? binding,
    batches,
  };
  return persistRunConfig(merged);
}

function lowerCap(prior: number, next: number): number {
  if (!Number.isFinite(next) || next <= 0) return prior;
  if (!Number.isFinite(prior) || prior <= 0) return next;
  return Math.min(prior, next);
}

export function readRunConfig(runId: string): BoundRunConfig {
  return JSON.parse(readRunFile(runId, 'config.json')) as BoundRunConfig;
}

/** The protocol a run is committed to, or null if it has never been bound. */
export function readRunProtocol(runId: string): ProtocolBinding | null {
  return readRunConfig(runId).protocol ?? null;
}

// ---------------------------------------------------------------------------
// RUN-002 — deterministic, idempotent attempt identity
// ---------------------------------------------------------------------------

/**
 * Why an attempt was made. SEMANTIC, not ordinal.
 *
 * The id is derived from the coordinate plus this cause and nothing else, which
 * is what makes a replay recognisable: re-issuing the same cause at the same
 * coordinate IS the same attempt. Two attempts that do materially different
 * things must therefore carry different causes — which is why the CLI's two
 * empty-answer retries are distinguishable: the second one doubles the token
 * headroom, so it is a different attempt, not a second go at the same one.
 *
 * A counter would defeat the whole property. `attempt-3` is only stable if
 * every process counts the same way from the same starting point, and a
 * crashed-and-resumed process by definition does not.
 *
 * NOTE for integration: `lifecycle.ts` carries a related `candidateRetryKey`,
 * which is the identity of a response CELL (and deliberately carries no cause)
 * for the v3 journals. The two agree at the `stored` cause, which is 1:1 with a
 * cell. They should be reconciled into one scheme when the v3 lifecycle is
 * wired into the runner; until then this is the one with a durable, atomic
 * record behind it, and store.ts must not depend on an unwired contract.
 */
export const ATTEMPT_CAUSES = [
  /** The first call for a cell. */
  'initial',
  /** Retry after an empty completion, at the same token cap. */
  'empty-response',
  /** Retry after an empty completion, with doubled token headroom. */
  'empty-response-headroom',
  /** Retry after a transport-level failure (network error, 5xx). */
  'transport-error',
  /** Retry after a 429. */
  'rate-limit',
  /** Retry after a provider content filter stopped the completion. */
  'content-filter',
  /** Retry after a provider error body. */
  'provider-error',
  /**
   * The terminal attempt for a cell: the one whose answer is stored and whose
   * cost is booked against the cell. `writeResponse` uses this.
   */
  'stored',
] as const;

export type AttemptCause = (typeof ATTEMPT_CAUSES)[number];

export interface AttemptCoordinate {
  runId: string;
  modelId: string;
  questionId: string;
  cause: AttemptCause;
}

export interface AttemptRecord extends AttemptCoordinate {
  retryId: string;
  openedAtIso: string;
  settledAtIso: string | null;
  /** Booked exactly once, at settlement. */
  costUsd: number | null;
  /** Content identity of the answer this attempt produced, when it produced one. */
  answerHash: string | null;
}

const ATTEMPT_DIR = 'attempts';

/**
 * Deterministic attempt id.
 *
 * Pure: the same coordinate always yields the same id, in any process, on any
 * machine, with no state read. That is the property a replay guard needs — an
 * id that depends on how many attempts a process has already made cannot tell a
 * replay from a new purchase.
 */
export function retryIdFor(coord: AttemptCoordinate): string {
  for (const [field, value] of [
    ['runId', coord.runId],
    ['modelId', coord.modelId],
    ['questionId', coord.questionId],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      throw new ProtocolViolationError(
        `Attempt coordinate is missing ${field}; an id derived from an incomplete coordinate would collide across cells.`,
        'PROTOCOL_UNCOMPUTABLE',
      );
    }
  }
  // Validated rather than trusted. An unrecognised cause would otherwise mint a
  // fresh id — and therefore a second answer and a second charge — for work the
  // ledger already knows about, which is the exact failure this exists to stop.
  if (!(ATTEMPT_CAUSES as readonly string[]).includes(coord.cause)) {
    throw new ProtocolViolationError(
      `Unknown attempt cause ${JSON.stringify(coord.cause)}. Known causes: [${ATTEMPT_CAUSES.join(', ')}].`,
      'UNKNOWN_ATTEMPT_CAUSE',
    );
  }
  return `atr_${digest('cookingbench/attempt', ATTEMPT_ID_VERSION, [
    coord.runId,
    coord.modelId,
    coord.questionId,
    coord.cause,
  ]).slice(0, 40)}`;
}

function attemptPath(runId: string, retryId: string): string {
  return resolveRunFile(runId, join(ATTEMPT_DIR, `${retryId}.json`), { write: true });
}

/**
 * Read one attempt record. Null means ABSENT; anything else that goes wrong
 * throws.
 *
 * An unreadable or mis-filed record must not read as "no attempt yet": that is
 * the one interpretation that licences a second charge for work already done,
 * and it is reachable by corrupting a single file.
 */
function readAttempt(runId: string, retryId: string): AttemptRecord | null {
  const path = resolveRunFile(runId, join(ATTEMPT_DIR, `${retryId}.json`), { write: false });
  if (!existsSync(path)) return null;
  let parsed: AttemptRecord;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as AttemptRecord;
  } catch (e) {
    throw new ProtocolViolationError(
      `Attempt record ${retryId} in run ${runId} is unreadable (${(e as Error).message}). Refusing to treat it as absent.`,
      'ATTEMPT_UNREADABLE',
    );
  }
  if (parsed?.retryId !== retryId) {
    throw new ProtocolViolationError(
      `Attempt record filed as ${retryId} in run ${runId} claims to be ${JSON.stringify(parsed?.retryId)}. A record under the wrong id is a copy, not evidence.`,
      'ATTEMPT_UNREADABLE',
    );
  }
  return parsed;
}

/**
 * Open an attempt, or recognise that it has already been opened.
 *
 * The record is created with `open(..., 'wx')`, which fails atomically at the
 * filesystem level when the file exists — the same reasoning as permit
 * redemption: counting records and then writing the next one leaves a window in
 * which two processes both see N and both write N+1.
 */
export function beginAttempt(coord: AttemptCoordinate): {
  retryId: string;
  replay: boolean;
  record: AttemptRecord;
} {
  const retryId = retryIdFor(coord);
  const target = attemptPath(coord.runId, retryId);
  const record: AttemptRecord = {
    ...coord,
    retryId,
    openedAtIso: new Date().toISOString(),
    settledAtIso: null,
    costUsd: null,
    answerHash: null,
  };
  mkdirSync(join(runDirForWrite(coord.runId), ATTEMPT_DIR), { recursive: true });
  try {
    const fd = openSync(target, 'wx');
    writeSync(fd, JSON.stringify(record, null, 2));
    closeSync(fd);
    return { retryId, replay: false, record };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
  }
  const existing = readAttempt(coord.runId, retryId);
  if (!existing) {
    // It existed a moment ago and does not now. Something else is deleting
    // attempt records underneath us, which is not a state to carry on from:
    // proceeding would mean opening a second attempt for the same work.
    throw new ProtocolViolationError(
      `Attempt ${retryId} in run ${coord.runId} existed and then vanished mid-open. Refusing to reopen it.`,
      'ATTEMPT_UNREADABLE',
    );
  }
  return { retryId, replay: true, record: existing };
}

const COST_EPSILON = 1e-9;

/**
 * Book an attempt's cost, exactly once.
 *
 * Idempotent for an identical settlement, and refuses a conflicting one. A
 * second settlement with a DIFFERENT cost is not a replay — it is a second
 * purchase wearing a replay's id — and silently keeping either number would
 * misstate spend in one direction or the other.
 *
 * This ledger is an idempotency record, not the money. Actual spend is reserved
 * and settled by the reservation ledger (BUDGET-001); what this proves is that
 * one coordinate books one charge.
 */
export function settleAttempt(
  coord: AttemptCoordinate,
  outcome: { costUsd: number; answerHash?: string | null },
): AttemptRecord {
  const retryId = retryIdFor(coord);
  const existing = readAttempt(coord.runId, retryId);
  const answerHash = outcome.answerHash ?? null;
  if (existing?.settledAtIso) {
    if (
      Math.abs((existing.costUsd ?? 0) - outcome.costUsd) > COST_EPSILON ||
      existing.answerHash !== answerHash
    ) {
      throw new ProtocolViolationError(
        `Attempt ${retryId} (${coord.modelId} × ${coord.questionId}, cause '${coord.cause}') is already settled at ` +
          `$${(existing.costUsd ?? 0).toFixed(6)} and is being settled again at $${outcome.costUsd.toFixed(6)}. ` +
          `A replay must be identical; a second, different charge at the same coordinate is a duplicate purchase.`,
        'ATTEMPT_ALREADY_SETTLED',
      );
    }
    return existing;
  }
  const record: AttemptRecord = {
    ...(existing ?? { ...coord, retryId, openedAtIso: new Date().toISOString() }),
    ...coord,
    retryId,
    settledAtIso: new Date().toISOString(),
    costUsd: outcome.costUsd,
    answerHash,
  };
  writeRunFileAtomic(coord.runId, join(ATTEMPT_DIR, `${retryId}.json`), JSON.stringify(record, null, 2));
  return record;
}

export function readAttempts(runId: string): AttemptRecord[] {
  // Same guard as `readResponses`: attempt records are what `attemptChargesUsd`
  // bills against, so a linked attempt directory would import another run's
  // spend and satisfy this run's budget with it.
  return readRunJsonEntries(runId, ATTEMPT_DIR).map((e) => JSON.parse(e.text) as AttemptRecord);
}

/** Total booked against this run's attempts. One charge per settled attempt. */
export function attemptChargesUsd(runId: string): number {
  return readAttempts(runId).reduce((sum, a) => sum + (a.settledAtIso ? (a.costUsd ?? 0) : 0), 0);
}

/**
 * Content identity of a stored answer.
 *
 * Covers what was ANSWERED, not what it cost or how long it took: a replay must
 * be recognisable across a restart, and latency never repeats.
 */
function answerHashOf(response: StoredResponse): string {
  return digest('cookingbench/answer', ANSWER_HASH_VERSION, {
    answerText: response.answerText,
    finishReason: response.finishReason ?? null,
    transportFailure: response.transportFailure === true,
  });
}

/**
 * Read path. Prefers the injective encoding and falls back to the legacy name
 * so historical runs — which are frozen and will never be rewritten — stay
 * readable.
 */
export function responsePath(runId: string, modelId: string, questionId: string): string {
  const current = resolveRunFile(runId, join('responses', responseFileName(modelId, questionId)), {
    write: false,
  });
  if (existsSync(current)) return current;
  const legacy = resolveRunFile(
    runId,
    join('responses', `${legacySafeName(modelId)}__${questionId}.json`),
    { write: false },
  );
  return existsSync(legacy) ? legacy : current;
}

export function hasResponse(runId: string, modelId: string, questionId: string): boolean {
  return existsSync(responsePath(runId, modelId, questionId));
}

/**
 * Store the answer of record for one cell, idempotently.
 *
 * The write-guarded resolver, not responsePath: this is the highest-volume
 * writer in the pipeline (2,576 files in 2026-07-v2.1 alone) and is exactly
 * the path a mistargeted --run-id would use to overwrite published answers.
 * Both components are validated here, at the writer boundary, rather than
 * trusting whichever caller got here.
 *
 * RUN-002: the cell's terminal attempt id is DERIVED from the cell, so a
 * replayed store lands on the same record — one stored answer, one charge. A
 * store of a DIFFERENT answer over a settled cell is refused rather than
 * overwritten. That direction is deliberate: the alternative loses an answer
 * that has already been paid for either way, and losing the newer one at least
 * fails loudly instead of quietly rewriting published-shaped evidence. In
 * ordinary operation it cannot happen — `bench run` skips a cell that already
 * has a response — so reaching it means two writers raced on one coordinate,
 * which is worth stopping for.
 */
export function writeResponse(response: StoredResponse): void {
  // Validate the filename components before anything is created on disk, so an
  // unsafe cell refuses without leaving an attempt record behind.
  const relative = join('responses', responseFileName(response.modelId, response.questionId));
  const coord: AttemptCoordinate = {
    runId: response.runId,
    modelId: response.modelId,
    questionId: response.questionId,
    cause: 'stored',
  };
  const answerHash = answerHashOf(response);
  const { record } = beginAttempt(coord);
  if (record.settledAtIso) {
    if (record.answerHash !== answerHash) {
      throw new ProtocolViolationError(
        `Run ${response.runId} already stores a different answer for ${response.modelId} × ${response.questionId} ` +
          `(attempt ${record.retryId}). An answer of record is not replaceable in place; derive a new run id.`,
        'ANSWER_ALREADY_STORED',
      );
    }
    // Same answer, so the only remaining question is the price. `settleAttempt`
    // is a no-op for an identical settlement and refuses a conflicting one, so
    // a replay carrying a DIFFERENT cost is stopped here rather than quietly
    // keeping whichever number happened to land first.
    settleAttempt(coord, { costUsd: response.costUsd, answerHash });
    // Identical answer already on disk: a true replay, with nothing to write and
    // nothing to charge again.
    if (existsSync(responsePath(response.runId, response.modelId, response.questionId))) return;
  }
  writeRunFileAtomic(response.runId, relative, JSON.stringify(response, null, 2));
  settleAttempt(coord, { costUsd: response.costUsd, answerHash });
}

export function readResponses(runId: string): StoredResponse[] {
  // Guarded per entry, not per directory: this is the function that decides what
  // a run's answers ARE, so a linked `responses/` or a linked single file lets a
  // scratch run claim another run's corpus. See `readRunJsonEntries`.
  return readRunJsonEntries(runId, 'responses').map((e) => JSON.parse(e.text) as StoredResponse);
}

export function writeScores(runId: string, scores: Score[]): void {
  writeRunFileAtomic(runId, 'scores.json', JSON.stringify(scores, null, 2));
}

export function readScores(runId: string): Score[] {
  const text = readRunFileOrNull(runId, 'scores.json');
  return text === null ? [] : (JSON.parse(text) as Score[]);
}

export function writeLeaderboard(runId: string, leaderboard: unknown): void {
  writeRunFileAtomic(runId, 'leaderboard.json', JSON.stringify(leaderboard, null, 2));
}

export function listRuns(): string[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR).filter((d) => existsSync(join(RUNS_DIR, d, 'config.json')));
}
