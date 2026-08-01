import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  PUBLIC_RELEASE_ARTIFACTS,
  canonicalJson,
  canonicalResponseSet,
  publicResultMatchesManifest,
  questionFileSchema,
  runIdSchema,
  safeParseRunManifest,
} from '@cookingbench/core';
import type {
  CategoryId,
  Question,
  Score,
  StoredResponse,
  ValidatedRunManifest,
} from '@cookingbench/core';

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
    | {
        kind: 'register';
        reviewedBy: string;
        reviewedAt: string;
        manifestHash: string;
        checklistDigest: string;
      }
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
 * This is a PIN, not a fallback rule: it names one run id and fixed digests for
 * every byte from that run the site consumes. The response corpus is one
 * versioned tree-set commitment over all 2,576 filenames and content hashes.
 * It cannot promote a newer board, a rebuilt board, or a copied companion file.
 * The register overrides it in both directions — a `currentRun` pointer wins,
 * and an entry putting this run in any state other than `released` withdraws it.
 */
const PINNED_HISTORICAL_RELEASE = {
  runId: '2026-07-v2.1',
  artifacts: [
    { file: 'leaderboard.json', sha256: 'bf1ec6536daa12cf5d741e77c9e47ea04e1395df644ddef3709a32bd3bc39dde' },
    { file: 'analysis.json', sha256: '7107619ef9a91410221331dc9a1a0666a7904f50b1a2473f9aebf1f055a47a25' },
    { file: 'config.json', sha256: '958d00f3943a3c1bb0f832b4ec3c1437f4a5ce070ab0604c98374da413def9d8' },
    { file: 'calibration.json', sha256: '74949349735eb974f5e1b8b2c9261d303136561a2de3494756d50507b072c057' },
    { file: 'scores.json', sha256: '8ab6cd2d760ceea01202db8e52c52497a826ce9b12e1fb2b5aea547702f59745' },
    { file: 'responses', sha256: '973a8ae6346edb147bbf480480ee6b5259d739a73bbb645bd2e0226320864a05' },
  ],
  note:
    'Released before the evidence register existed; every site-consumed artifact is pinned by content digest and reviewed in the ' +
    'published methodology. Any new release must go through data/runs/REGISTER.json.',
} as const;

const HISTORICAL_ARTIFACTS = PINNED_HISTORICAL_RELEASE.artifacts.map((artifact) => artifact.file);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const sha256 = (bytes: string | Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

interface FileSnapshot {
  kind: 'file';
  sha256: string;
  text: string;
}

interface ResponseSetSnapshot {
  kind: 'response-set';
  sha256: string;
  files: Array<{ file: string; sha256: string; text: string }>;
}

type ArtifactSnapshot = FileSnapshot | ResponseSetSnapshot;

interface ApprovedReleaseData {
  release: ApprovedRelease;
  analysis: RunAnalysisSummary;
  config: RunConfig;
  calibration: { costUsd?: unknown };
  scores: Score[];
  responses: StoredResponse[];
}

interface WebDerivationRecord {
  derivationVersion?: unknown;
  runId?: unknown;
  derivedFrom?: {
    runId?: unknown;
    responseSetHash?: unknown;
    responseCount?: unknown;
    copyMode?: unknown;
  };
  responses?: Array<{
    file?: unknown;
    sha256?: unknown;
    modelId?: unknown;
    questionId?: unknown;
  }>;
}

/** Verify the copied-response lineage using only the exact bytes held by this snapshot. */
function derivedResponses(
  targetRunId: string,
  manifest: ValidatedRunManifest,
  artifacts: Map<string, ArtifactSnapshot>,
): StoredResponse[] | null {
  const record = parsedFile<WebDerivationRecord>(artifacts, 'derivation.json');
  const responseSet = artifacts.get('responses');
  if (!record || !responseSet || responseSet.kind !== 'response-set') return null;
  const sourceRunId = record.derivedFrom?.runId;
  if (
    record.derivationVersion !== 1 ||
    record.runId !== targetRunId ||
    typeof sourceRunId !== 'string' ||
    !runIdSchema.safeParse(sourceRunId).success ||
    record.derivedFrom?.copyMode !== 'copy' ||
    record.derivedFrom?.responseCount !== responseSet.files.length ||
    !Array.isArray(record.responses) ||
    record.responses.length !== responseSet.files.length ||
    manifest.parentArtifacts.length !== 1 ||
    manifest.parentArtifacts[0] !== sourceRunId
  ) {
    return null;
  }

  const declared = new Map<string, NonNullable<WebDerivationRecord['responses']>[number]>();
  for (const response of record.responses) {
    if (
      typeof response.file !== 'string' ||
      !response.file.endsWith('.json') ||
      typeof response.sha256 !== 'string' ||
      !HASH_PATTERN.test(response.sha256) ||
      typeof response.modelId !== 'string' ||
      response.modelId === '' ||
      typeof response.questionId !== 'string' ||
      response.questionId === '' ||
      declared.has(response.file)
    ) {
      return null;
    }
    declared.set(response.file, response);
  }
  if (declared.size !== responseSet.files.length) return null;
  const members = [...declared.values()].map((entry) => ({
    file: entry.file as string,
    sha256: entry.sha256 as string,
  }));
  if (
    typeof record.derivedFrom?.responseSetHash !== 'string' ||
    record.derivedFrom.responseSetHash !== sha256(canonicalResponseSet(sourceRunId, members))
  ) {
    return null;
  }

  const responses: StoredResponse[] = [];
  try {
    for (const file of responseSet.files) {
      const expected = declared.get(file.file);
      if (!expected || expected.sha256 !== file.sha256) return null;
      const response = JSON.parse(file.text) as StoredResponse;
      if (
        response.runId !== sourceRunId ||
        response.modelId !== expected.modelId ||
        response.questionId !== expected.questionId
      ) {
        return null;
      }
      responses.push(response);
    }
  } catch {
    return null;
  }
  return responses;
}

/** Read once, then hash and parse these exact held bytes. Never check-then-reopen. */
function snapshotArtifact(
  runsDir: string,
  runId: string,
  file: string,
): ArtifactSnapshot | null {
  if (!runIdSchema.safeParse(runId).success) return null;
  const runDir = join(runsDir, runId);
  const path = join(runsDir, runId, file);
  if (!existsSync(path)) return null;
  try {
    // A lexical run id is not a filesystem identity. Refuse an alias planted
    // as the run directory before reading any of its children; otherwise a
    // symlink named for an approved run could redirect the whole snapshot.
    if (!lstatSync(runDir).isDirectory()) return null;
    const identity = lstatSync(path);
    if (file !== 'responses') {
      if (!identity.isFile()) return null;
      const text = readFileSync(path, 'utf8');
      return { kind: 'file', sha256: sha256(text), text };
    }

    if (!identity.isDirectory()) return null;
    const entries = readdirSync(path, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    // A release with no answers is not evidence. This also prevents an empty
    // tree from satisfying the pointer merely because its digest was supplied.
    if (entries.length === 0) return null;
    const files: ResponseSetSnapshot['files'] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) return null;
      const text = readFileSync(join(path, entry.name), 'utf8');
      files.push({ file: entry.name, sha256: sha256(text), text });
    }
    return {
      kind: 'response-set',
      sha256: sha256(canonicalResponseSet(runId, files)),
      files,
    };
  } catch {
    return null;
  }
}

/** Exact-set validation: missing, duplicate and unknown pins all refuse. */
function snapshotPinnedArtifacts(
  runsDir: string,
  runId: string,
  supplied: unknown,
  required: readonly string[],
): Map<string, ArtifactSnapshot> | null {
  if (!Array.isArray(supplied)) return null;
  const requiredSet = new Set(required);
  const pins = new Map<string, string>();
  for (const value of supplied) {
    const pin = value as { file?: unknown; sha256?: unknown };
    if (
      typeof pin?.file !== 'string' ||
      !requiredSet.has(pin.file) ||
      typeof pin.sha256 !== 'string' ||
      !HASH_PATTERN.test(pin.sha256) ||
      pins.has(pin.file)
    ) {
      return null;
    }
    pins.set(pin.file, pin.sha256);
  }
  if (pins.size !== required.length || required.some((file) => !pins.has(file))) return null;

  const snapshots = new Map<string, ArtifactSnapshot>();
  for (const file of required) {
    const snapshot = snapshotArtifact(runsDir, runId, file);
    if (!snapshot || snapshot.sha256 !== pins.get(file)) return null;
    snapshots.set(file, snapshot);
  }
  return snapshots;
}

function parsedFile<T>(artifacts: Map<string, ArtifactSnapshot>, file: string): T | null {
  const snapshot = artifacts.get(file);
  if (!snapshot || snapshot.kind !== 'file') return null;
  try {
    return JSON.parse(snapshot.text) as T;
  } catch {
    return null;
  }
}

function buildApprovedData(
  runId: string,
  approval: ApprovedRelease['approval'],
  artifacts: Map<string, ArtifactSnapshot>,
): ApprovedReleaseData | null {
  const report = parsedFile<LeaderboardReport>(artifacts, 'leaderboard.json');
  if (!report || report.runId !== runId || !Array.isArray(report.rows) || report.rows.length === 0) return null;

  const analysis = parsedFile<RunAnalysisSummary & { runId?: unknown }>(artifacts, 'analysis.json');
  if (!analysis || analysis.runId !== runId) return null;
  const config = parsedFile<RunConfig>(artifacts, 'config.json');
  if (!config || config.runId !== runId) return null;
  const calibration = parsedFile<{ costUsd?: unknown }>(artifacts, 'calibration.json');
  if (!calibration || typeof calibration !== 'object' || Array.isArray(calibration)) return null;
  const scores = parsedFile<Score[]>(artifacts, 'scores.json');
  if (!Array.isArray(scores) || scores.length === 0 || scores.some((score) => score.runId !== runId)) return null;

  let responses: StoredResponse[];
  if (approval.kind === 'register') {
    if (!HASH_PATTERN.test(approval.manifestHash) || !HASH_PATTERN.test(approval.checklistDigest)) return null;
    const rawManifest = parsedFile<unknown>(artifacts, 'manifest.json');
    const parsedManifest = safeParseRunManifest(rawManifest);
    if (!parsedManifest.ok) return null;
    const manifest = parsedManifest.manifest;
    const computedManifestHash = sha256(canonicalJson(manifest));
    if (
      manifest.runId !== runId ||
      computedManifestHash !== approval.manifestHash ||
      manifest.evidenceClass !== 'public-release' ||
      manifest.releaseState !== 'released' ||
      manifest.rankEligible !== true
    ) {
      return null;
    }

    const persistedHash = artifacts.get('manifest.sha256');
    if (
      !persistedHash ||
      persistedHash.kind !== 'file' ||
      persistedHash.text.trim() !== computedManifestHash
    ) {
      return null;
    }
    const digest = parsedFile<Record<string, unknown>>(artifacts, 'manifest-digest.json');
    if (
      !digest ||
      digest.bankHash !== manifest.bankHash ||
      digest.promptHash !== manifest.promptHash ||
      digest.judgePromptHash !== manifest.judgePromptHash ||
      digest.validatorHash !== manifest.validatorHash ||
      !Array.isArray(digest.itemIds) ||
      digest.itemIds.length === 0
    ) {
      return null;
    }

    const checklist = parsedFile<{
      checklistVersion?: unknown;
      runId?: unknown;
      manifestHash?: unknown;
      complete?: unknown;
      items?: Array<{ id?: unknown; verdict?: unknown }>;
    }>(artifacts, 'release-checklist.json');
    if (
      !checklist ||
      checklist.checklistVersion !== 1 ||
      checklist.runId !== runId ||
      checklist.manifestHash !== computedManifestHash ||
      checklist.complete !== true ||
      !Array.isArray(checklist.items) ||
      checklist.items.length === 0 ||
      checklist.items.some((item) => typeof item.id !== 'string' || item.verdict !== 'pass') ||
      new Set(checklist.items.map((item) => item.id)).size !== checklist.items.length ||
      sha256(canonicalJson(checklist)) !== approval.checklistDigest
    ) {
      return null;
    }

    if (
      !publicResultMatchesManifest(report, manifest, computedManifestHash) ||
      !publicResultMatchesManifest(analysis, manifest, computedManifestHash)
    ) {
      return null;
    }

    const provenance = artifacts.get('provenance.ndjson');
    if (!provenance || provenance.kind !== 'file') return null;
    let entries: Array<{
      receiptVersion?: unknown;
      runId?: unknown;
      manifestHash?: unknown;
      signedPermitHash?: unknown;
      capabilities?: unknown;
      command?: unknown;
      artifact?: { file?: unknown; sha256?: unknown } | null;
    }>;
    try {
      entries = provenance.text
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line));
    } catch {
      return null;
    }
    const receiptFor = (command: string, file: string): boolean => {
      const snapshot = artifacts.get(file);
      if (!snapshot || snapshot.kind !== 'file') return false;
      return entries.some(
        (entry) =>
          entry.receiptVersion === 1 &&
          entry.runId === runId &&
          entry.manifestHash === computedManifestHash &&
          typeof entry.signedPermitHash === 'string' &&
          HASH_PATTERN.test(entry.signedPermitHash) &&
          Array.isArray(entry.capabilities) &&
          entry.capabilities.includes('publication') &&
          entry.command === command &&
          entry.artifact?.file === file &&
          entry.artifact.sha256 === snapshot.sha256,
      );
    };
    if (!receiptFor('bench report', 'leaderboard.json') || !receiptFor('bench analyze', 'analysis.json')) {
      return null;
    }

    const inherited = derivedResponses(runId, manifest, artifacts);
    if (!inherited) return null;
    responses = inherited;
  } else {
    const responseSet = artifacts.get('responses');
    if (!responseSet || responseSet.kind !== 'response-set' || responseSet.files.length === 0) return null;
    responses = [];
    try {
      for (const file of responseSet.files) {
        const response = JSON.parse(file.text) as StoredResponse;
        if (response.runId !== runId) return null;
        responses.push(response);
      }
    } catch {
      return null;
    }
  }

  return {
    release: { report, runId, approval },
    analysis,
    config,
    calibration,
    scores,
    responses,
  };
}

function readRegister(runsDir: string): RegisterShape | null {
  const path = join(runsDir, REGISTER_FILE);
  if (!existsSync(path)) return null;
  try {
    if (!lstatSync(path).isFile()) return { registerVersion: 0 };
    const parsed = readJson<RegisterShape>(path);
    // An unreadable or unversioned register is not an absent one. Falling back
    // to the pin on a MALFORMED register would let a corrupted file silently
    // restore a withdrawn board, so the caller is told nothing is approved.
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      parsed.registerVersion !== 1 ||
      !Object.prototype.hasOwnProperty.call(parsed, 'currentRun') ||
      !parsed.entries ||
      typeof parsed.entries !== 'object' ||
      Array.isArray(parsed.entries) ||
      !(parsed.currentRun === null ||
        (typeof parsed.currentRun === 'object' && !Array.isArray(parsed.currentRun)))
    ) {
      return { registerVersion: 0 };
    }
    return parsed;
  } catch {
    return { registerVersion: 0 };
  }
}

/**
 * Resolve the approved release under `runsDir`. Root-parameterised so the
 * mechanism can be exercised offline against a scratch tree.
 */
function resolveApprovedReleaseData(runsDir: string): ApprovedReleaseData | null {
  const register = readRegister(runsDir);
  if (register && register.registerVersion !== 1) return null;

  const pointer = register?.currentRun ?? null;
  if (pointer !== null) {
    if (
      typeof pointer.runId !== 'string' ||
      typeof pointer.manifestHash !== 'string' ||
      !HASH_PATTERN.test(pointer.manifestHash) ||
      typeof pointer.reviewedBy !== 'string' ||
      pointer.reviewedBy.trim() === '' ||
      typeof pointer.reviewedAt !== 'string' ||
      !Number.isFinite(Date.parse(pointer.reviewedAt)) ||
      typeof pointer.checklistDigest !== 'string' ||
      !HASH_PATTERN.test(pointer.checklistDigest)
    ) {
      return null;
    }
    const entry = register?.entries?.[pointer.runId];
    // The pointer and the entry must agree. A pointer naming a run the register
    // does not show released is a register that has been half-edited.
    if (!entry || entry.state !== 'released' || entry.manifestHash !== pointer.manifestHash) return null;
    const artifacts = snapshotPinnedArtifacts(
      runsDir,
      pointer.runId,
      pointer.artifacts,
      PUBLIC_RELEASE_ARTIFACTS,
    );
    if (!artifacts) return null;
    return buildApprovedData(
      pointer.runId,
      {
        kind: 'register',
        reviewedBy: String(pointer.reviewedBy ?? ''),
        reviewedAt: String(pointer.reviewedAt ?? ''),
        manifestHash: String(pointer.manifestHash ?? ''),
        checklistDigest: String(pointer.checklistDigest ?? ''),
      },
      artifacts,
    );
  }

  // No pointer. The pin applies unless the register has withdrawn it.
  const withdrawn =
    register?.entries?.[PINNED_HISTORICAL_RELEASE.runId] !== undefined &&
    register.entries[PINNED_HISTORICAL_RELEASE.runId]!.state !== 'released';
  if (withdrawn) return null;
  const artifacts = snapshotPinnedArtifacts(
    runsDir,
    PINNED_HISTORICAL_RELEASE.runId,
    PINNED_HISTORICAL_RELEASE.artifacts,
    HISTORICAL_ARTIFACTS,
  );
  return artifacts
    ? buildApprovedData(
        PINNED_HISTORICAL_RELEASE.runId,
        { kind: 'pinned-historical', note: PINNED_HISTORICAL_RELEASE.note },
        artifacts,
      )
    : null;
}

export function resolveApprovedRelease(runsDir: string): ApprovedRelease | null {
  return resolveApprovedReleaseData(runsDir)?.release ?? null;
}

let cachedSiteData: { registerRevision: string; data: ApprovedReleaseData } | null = null;

function registerRevision(runsDir: string): string {
  const path = join(runsDir, REGISTER_FILE);
  if (!existsSync(path)) return 'no-register';
  try {
    return lstatSync(path).isFile() ? sha256(readFileSync(path)) : 'invalid-register';
  } catch {
    return 'invalid-register';
  }
}

/**
 * One immutable snapshot per register revision. If files underneath a pointer
 * are later replaced, these held approved bytes remain what pages serve; the
 * replacement is never read. A pointer change invalidates the snapshot.
 */
function getApprovedReleaseData(): ApprovedReleaseData | null {
  if (!existsSync(RUNS_DIR)) return null;
  const revision = registerRevision(RUNS_DIR);
  if (cachedSiteData?.registerRevision === revision) return cachedSiteData.data;
  const data = resolveApprovedReleaseData(RUNS_DIR);
  if (data) cachedSiteData = { registerRevision: revision, data };
  return data;
}

/** The approved release, with its approval. Null means nothing is approved. */
export function getApprovedRelease(): ApprovedRelease | null {
  return getApprovedReleaseData()?.release ?? null;
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
  const approved = getApprovedReleaseData();
  return approved?.release.runId === runId ? approved.analysis : null;
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
  const approved = getApprovedReleaseData();
  return approved?.release.runId === runId ? approved.config : null;
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

  const approved = getApprovedReleaseData();
  const releaseData = approved?.release.runId === report.runId ? approved : null;
  const config = releaseData?.config ?? null;
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

  const calibrationUsd = finite(releaseData?.calibration.costUsd);

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
  const approved = getApprovedReleaseData();
  return approved?.release.runId === runId ? [...approved.scores] : [];
}

export function getResponses(runId: string): StoredResponse[] {
  const approved = getApprovedReleaseData();
  return approved?.release.runId === runId ? [...approved.responses] : [];
}

export function modelSlug(modelId: string): string {
  return modelId.replace(/\//g, '--');
}

export function modelIdFromSlug(slug: string): string {
  return slug.replace(/--/g, '/');
}
