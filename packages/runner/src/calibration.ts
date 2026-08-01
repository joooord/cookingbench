import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { canonicalJson, type Question, type ValidatedRunManifest } from '@cookingbench/core';
import { DATA_DIR, loadQuestions } from './dataset.js';
import { isHistoricalRun, resolveRunFile, writeRunFileAtomic } from './firewall.js';
import { CALIBRATION_ANCHOR_MODEL, JUDGE_PROMPT_VERSION, judgeAnswer } from './judge.js';
import { ManifestError, readRunManifest, readRunManifestHash } from './manifest.js';
import type { CompletionClient } from './openrouter.js';
import { manifestHash, sha256Hex } from './permit.js';

const ANCHORS_PATH = join(DATA_DIR, 'calibration', 'anchors.yaml');
const MAE_LIMIT = 10;
const DEFAULT_TOLERANCE = 20;
const CALIBRATION_VERSION = 2 as const;
const CALIBRATION_EVIDENCE_VERSION = 1;
const SHA256_RE = /^[a-f0-9]{64}$/;

export type CalibrationErrorCode =
  | 'CALIBRATION_INVALID'
  | 'CALIBRATION_MANIFEST_MISMATCH'
  | 'CALIBRATION_ANCHOR_MISMATCH'
  | 'CALIBRATION_PANEL_MISMATCH'
  | 'CALIBRATION_RESULT_MISMATCH'
  | 'CALIBRATION_LEGACY_UNVERIFIED';

export class CalibrationError extends Error {
  constructor(
    message: string,
    readonly code: CalibrationErrorCode,
  ) {
    super(message);
    this.name = 'CalibrationError';
  }
}

export interface CalibrationAnchor {
  questionId: string;
  note?: string;
  expectedScore: number;
  toleranceAbs?: number;
  answerText: string;
}

export interface JudgeCalibration {
  judgeModel: string;
  mae: number;
  passed: boolean;
  anchors: Array<{
    questionId: string;
    note?: string;
    expected: number;
    got: number;
    pass: boolean;
  }>;
}

export interface CalibrationResult {
  calibrationVersion: typeof CALIBRATION_VERSION;
  runId: string;
  /** Exact persisted manifest identity under which the judge calls ran. */
  manifestHash: string;
  /** Manifested identity of the ordinary judge prompts used by this run. */
  judgePromptHash: string;
  /** Semantic digest of the complete committed calibration anchor bank. */
  anchorSetHash: string;
  anchorCount: number;
  /** Panel label or single judge id. */
  judgeModel: string;
  judgePanel: string[];
  judgePromptVersion: string;
  atIso: string;
  /** What this calibration pass cost across every seat and anchor. */
  costUsd: number;
  /** Worst per-judge MAE. */
  mae: number;
  passed: boolean;
  judges: JudgeCalibration[];
  /** Detects an accidental or partial edit to the evidence envelope. */
  evidenceHash: string;
}

/**
 * Published v2 artifacts predate the evidence envelope. They stay inspectable,
 * but their historical `passed` claim is never returned as present authority.
 */
export interface LegacyCalibrationResult {
  calibrationVersion: 0;
  verification: 'legacy-unverified';
  runId: string;
  manifestHash: null;
  judgePromptHash: null;
  anchorSetHash: null;
  anchorCount: number;
  judgeModel: string;
  judgePanel: string[];
  judgePromptVersion: string;
  atIso: string;
  costUsd: number | null;
  mae: number;
  /** Always false: this shape may not open the current paid judging gate. */
  passed: false;
  /** The archived claim, preserved for display and audit only. */
  recordedPassed: boolean;
  judges: JudgeCalibration[];
  evidenceHash: null;
}

export type ReadCalibrationResult = CalibrationResult | LegacyCalibrationResult;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function validIso(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function failCalibration(code: CalibrationErrorCode, message: string): never {
  throw new CalibrationError(message, code);
}

function parseAnchor(value: unknown, index: number): CalibrationAnchor {
  if (!isPlainRecord(value)) {
    failCalibration('CALIBRATION_ANCHOR_MISMATCH', `Calibration anchor ${index + 1} is not an object.`);
  }
  if (!exactKeys(value, ['questionId', 'expectedScore', 'answerText'], ['note', 'toleranceAbs'])) {
    failCalibration(
      'CALIBRATION_ANCHOR_MISMATCH',
      `Calibration anchor ${index + 1} has missing or unknown fields.`,
    );
  }
  if (typeof value.questionId !== 'string' || value.questionId === '') {
    failCalibration('CALIBRATION_ANCHOR_MISMATCH', `Calibration anchor ${index + 1} has no questionId.`);
  }
  if (typeof value.answerText !== 'string' || value.answerText.trim() === '') {
    failCalibration('CALIBRATION_ANCHOR_MISMATCH', `Calibration anchor ${index + 1} has no answerText.`);
  }
  if (!isFiniteNumber(value.expectedScore) || value.expectedScore < 0 || value.expectedScore > 100) {
    failCalibration(
      'CALIBRATION_ANCHOR_MISMATCH',
      `Calibration anchor ${index + 1} has expectedScore outside 0-100.`,
    );
  }
  if (
    value.toleranceAbs !== undefined &&
    (!isFiniteNumber(value.toleranceAbs) || value.toleranceAbs < 0 || value.toleranceAbs > 100)
  ) {
    failCalibration(
      'CALIBRATION_ANCHOR_MISMATCH',
      `Calibration anchor ${index + 1} has toleranceAbs outside 0-100.`,
    );
  }
  if (value.note !== undefined && typeof value.note !== 'string') {
    failCalibration('CALIBRATION_ANCHOR_MISMATCH', `Calibration anchor ${index + 1} has a non-string note.`);
  }
  return value as unknown as CalibrationAnchor;
}

export function loadAnchors(): CalibrationAnchor[] {
  let raw: unknown;
  try {
    raw = parse(readFileSync(ANCHORS_PATH, 'utf8'));
  } catch (e) {
    throw new CalibrationError(
      `Calibration anchors are unreadable (${(e as Error).message}).`,
      'CALIBRATION_ANCHOR_MISMATCH',
    );
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new CalibrationError(
      'Calibration anchor bank must be a non-empty array.',
      'CALIBRATION_ANCHOR_MISMATCH',
    );
  }
  return raw.map(parseAnchor);
}

function anchorSetHashOf(anchors: CalibrationAnchor[]): string {
  const questions = new Map(loadQuestions().map((question) => [question.id, question]));
  const evidence = anchors.map((anchor, index) => {
    const question = questions.get(anchor.questionId);
    if (!question) {
      failCalibration(
        'CALIBRATION_ANCHOR_MISMATCH',
        `Calibration anchor ${index + 1} references missing committed question ${anchor.questionId}.`,
      );
    }
    // The anchor's expected score is meaningless without the exact prompt,
    // rubric, reference and judge mode it is scored against. Hash both halves.
    return { anchor, question };
  });
  return sha256Hex(
    canonicalJson({
      kind: 'cookingbench/calibration-anchors',
      version: 1,
      evidence,
    }),
  );
}

/** Fixed-input production identity of the committed calibration bank. */
export function calibrationAnchorSetHash(): string {
  return anchorSetHashOf(loadAnchors());
}

/**
 * Read and write paths are separate on purpose. Routing reads through the
 * write-guarded resolver made historical calibration artifacts unreadable — a
 * regression, since the whole pipeline reads prior calibration to decide
 * whether the gate has already passed.
 */
function calibrationReadPath(runId: string): string {
  return resolveRunFile(runId, 'calibration.json', { write: false });
}

/**
 * Resolve the WRITE TARGET, not merely the directory containing it.
 *
 * The previous form was `join(resolveRunDir(runId, { write: true }),
 * 'calibration.json')`: `join` validates nothing, so the leaf check happened
 * only inside the final `writeRunFileAtomic` — AFTER the judge loop below had
 * billed anchors x seats x two calls. Probed: with the target linked outside the
 * run, the client was called and the refusal arrived afterwards. A preflight
 * that does not check the thing that can refuse is not a preflight.
 */
function calibrationWritePath(runId: string): string {
  return resolveRunFile(runId, 'calibration.json', { write: true });
}

type CalibrationEvidenceBody = Omit<CalibrationResult, 'evidenceHash'>;

function calibrationEvidenceHash(body: CalibrationEvidenceBody): string {
  return sha256Hex(
    canonicalJson({
      kind: 'cookingbench/calibration-evidence',
      version: CALIBRATION_EVIDENCE_VERSION,
      body,
    }),
  );
}

function sealCalibration(body: CalibrationEvidenceBody): CalibrationResult {
  return { ...body, evidenceHash: calibrationEvidenceHash(body) };
}

interface CalibrationContext {
  manifest: ValidatedRunManifest;
  manifestHash: string;
  anchors: CalibrationAnchor[];
  anchorSetHash: string;
}

function storedCalibrationContext(runId: string, anchors: CalibrationAnchor[] = loadAnchors()): CalibrationContext {
  try {
    const manifest = readRunManifest(runId);
    const computed = manifestHash(manifest);
    const recorded = readRunManifestHash(runId);
    if (recorded.state !== 'present' || recorded.hash !== computed) {
      const identity =
        recorded.state === 'absent'
          ? 'absent'
          : recorded.state === 'malformed'
            ? `malformed (${JSON.stringify(recorded.raw)})`
            : `${recorded.hash.slice(0, 12)}...`;
      failCalibration(
        'CALIBRATION_MANIFEST_MISMATCH',
        `Calibration for run ${runId} cannot be verified: manifest ${computed.slice(0, 12)}... has recorded identity ${identity}.`,
      );
    }
    return {
      manifest,
      manifestHash: computed,
      anchors,
      anchorSetHash: anchorSetHashOf(anchors),
    };
  } catch (e) {
    if (e instanceof CalibrationError) throw e;
    if (e instanceof ManifestError) {
      throw new CalibrationError(
        `Calibration for run ${runId} has no verifiable stored manifest (${e.code}: ${e.message}).`,
        'CALIBRATION_MANIFEST_MISMATCH',
      );
    }
    throw e;
  }
}

function declaredJudgePanel(manifest: ValidatedRunManifest): string[] {
  return manifest.judgeRoutes.map((route) => route.modelId);
}

function assertCalibrationPanel(
  runId: string,
  judgePanel: string[],
  judgePromptVersion: string,
  context: CalibrationContext,
): void {
  if (
    judgePanel.length === 0 ||
    new Set(judgePanel).size !== judgePanel.length ||
    judgePanel.some((seat) => typeof seat !== 'string' || seat === '')
  ) {
    failCalibration(
      'CALIBRATION_PANEL_MISMATCH',
      `Calibration for run ${runId} names an empty, duplicate or malformed judge panel.`,
    );
  }
  const declared = declaredJudgePanel(context.manifest);
  if (canonicalJson(judgePanel) !== canonicalJson(declared)) {
    failCalibration(
      'CALIBRATION_PANEL_MISMATCH',
      `Calibration panel [${judgePanel.join(', ')}] does not equal run ${runId}'s manifested panel [${declared.join(', ')}].`,
    );
  }
  // `runCalibration` calls the v2 fault judge directly. A caller-supplied label
  // cannot rename that prompt and make stale output appear current.
  if (judgePromptVersion !== JUDGE_PROMPT_VERSION) {
    failCalibration(
      'CALIBRATION_PANEL_MISMATCH',
      `Calibration declares prompt ${JSON.stringify(judgePromptVersion)}, but the production calibration route executes ${JUDGE_PROMPT_VERSION}.`,
    );
  }
}

function roundOne(value: number): number {
  return Math.round(value * 10) / 10;
}

function parseLegacyJudges(value: unknown, runId: string): JudgeCalibration[] {
  if (!Array.isArray(value) || value.length === 0) {
    failCalibration(
      'CALIBRATION_INVALID',
      `Historical calibration for ${runId} has no judge evidence; it is unreadable even as legacy evidence.`,
    );
  }
  for (const [judgeIndex, judge] of value.entries()) {
    if (
      !isPlainRecord(judge) ||
      typeof judge.judgeModel !== 'string' ||
      !isFiniteNumber(judge.mae) ||
      typeof judge.passed !== 'boolean' ||
      !Array.isArray(judge.anchors)
    ) {
      failCalibration(
        'CALIBRATION_INVALID',
        `Historical calibration for ${runId} has malformed judge row ${judgeIndex + 1}.`,
      );
    }
    for (const [rowIndex, row] of judge.anchors.entries()) {
      if (
        !isPlainRecord(row) ||
        typeof row.questionId !== 'string' ||
        !isFiniteNumber(row.expected) ||
        !isFiniteNumber(row.got) ||
        typeof row.pass !== 'boolean' ||
        (row.note !== undefined && typeof row.note !== 'string')
      ) {
        failCalibration(
          'CALIBRATION_INVALID',
          `Historical calibration for ${runId} has malformed anchor row ${judgeIndex + 1}.${rowIndex + 1}.`,
        );
      }
    }
  }
  return value as JudgeCalibration[];
}

function readLegacyCalibration(runId: string, value: Record<string, unknown>): LegacyCalibrationResult {
  if (!isHistoricalRun(runId)) {
    failCalibration(
      'CALIBRATION_LEGACY_UNVERIFIED',
      `Run ${runId} carries a pre-envelope calibration record. Only committed historical runs may expose that shape, and it never opens the current judging gate.`,
    );
  }
  if (
    typeof value.judgeModel !== 'string' ||
    !Array.isArray(value.judgePanel) ||
    value.judgePanel.some((seat) => typeof seat !== 'string' || seat === '') ||
    typeof value.judgePromptVersion !== 'string' ||
    !validIso(value.atIso) ||
    !isFiniteNumber(value.mae) ||
    typeof value.passed !== 'boolean' ||
    (value.costUsd !== undefined && (!isFiniteNumber(value.costUsd) || value.costUsd < 0))
  ) {
    failCalibration('CALIBRATION_INVALID', `Historical calibration for ${runId} is malformed.`);
  }
  const judges = parseLegacyJudges(value.judges, runId);
  return {
    calibrationVersion: 0,
    verification: 'legacy-unverified',
    runId,
    manifestHash: null,
    judgePromptHash: null,
    anchorSetHash: null,
    anchorCount: judges[0]?.anchors.length ?? 0,
    judgeModel: value.judgeModel,
    judgePanel: value.judgePanel as string[],
    judgePromptVersion: value.judgePromptVersion,
    atIso: value.atIso,
    costUsd: value.costUsd === undefined ? null : value.costUsd,
    mae: value.mae,
    passed: false,
    recordedPassed: value.passed,
    judges,
    evidenceHash: null,
  };
}

const CALIBRATION_KEYS = [
  'calibrationVersion',
  'runId',
  'manifestHash',
  'judgePromptHash',
  'anchorSetHash',
  'anchorCount',
  'judgeModel',
  'judgePanel',
  'judgePromptVersion',
  'atIso',
  'costUsd',
  'mae',
  'passed',
  'judges',
  'evidenceHash',
] as const;

function validateCalibrationEnvelope(
  runId: string,
  value: Record<string, unknown>,
  context: CalibrationContext,
): CalibrationResult {
  if (!exactKeys(value, CALIBRATION_KEYS)) {
    failCalibration(
      'CALIBRATION_INVALID',
      `Calibration for ${runId} has missing or unknown envelope fields.`,
    );
  }
  if (value.calibrationVersion !== CALIBRATION_VERSION || value.runId !== runId) {
    failCalibration(
      'CALIBRATION_INVALID',
      `Calibration stored under ${runId} claims version/run ${JSON.stringify(value.calibrationVersion)}/${JSON.stringify(value.runId)}.`,
    );
  }
  if (value.manifestHash !== context.manifestHash || !SHA256_RE.test(String(value.manifestHash))) {
    failCalibration(
      'CALIBRATION_MANIFEST_MISMATCH',
      `Calibration for ${runId} names manifest ${JSON.stringify(value.manifestHash)}, but the run stores ${context.manifestHash}.`,
    );
  }
  if (value.judgePromptHash !== context.manifest.judgePromptHash) {
    failCalibration(
      'CALIBRATION_MANIFEST_MISMATCH',
      `Calibration for ${runId} is bound to judge prompt ${JSON.stringify(value.judgePromptHash)}, not manifested prompt ${context.manifest.judgePromptHash}.`,
    );
  }
  if (value.anchorSetHash !== context.anchorSetHash || value.anchorCount !== context.anchors.length) {
    failCalibration(
      'CALIBRATION_ANCHOR_MISMATCH',
      `Calibration for ${runId} names ${String(value.anchorCount)} anchors / ${String(value.anchorSetHash)}, but the committed bank is ${context.anchors.length} / ${context.anchorSetHash}.`,
    );
  }
  if (typeof value.judgeModel !== 'string' || value.judgeModel === '') {
    failCalibration('CALIBRATION_INVALID', `Calibration for ${runId} has no panel label.`);
  }
  if (!Array.isArray(value.judgePanel) || value.judgePanel.some((seat) => typeof seat !== 'string')) {
    failCalibration('CALIBRATION_PANEL_MISMATCH', `Calibration for ${runId} has a malformed judge panel.`);
  }
  if (typeof value.judgePromptVersion !== 'string') {
    failCalibration('CALIBRATION_PANEL_MISMATCH', `Calibration for ${runId} has no judge prompt identity.`);
  }
  const judgePanel = value.judgePanel as string[];
  assertCalibrationPanel(runId, judgePanel, value.judgePromptVersion, context);
  if (
    !validIso(value.atIso) ||
    !isFiniteNumber(value.costUsd) ||
    value.costUsd < 0 ||
    !isFiniteNumber(value.mae) ||
    value.mae < 0 ||
    typeof value.passed !== 'boolean' ||
    !Array.isArray(value.judges) ||
    value.judges.length !== judgePanel.length
  ) {
    failCalibration('CALIBRATION_INVALID', `Calibration for ${runId} has malformed summary evidence.`);
  }

  const judges: JudgeCalibration[] = [];
  for (const [judgeIndex, rawJudge] of value.judges.entries()) {
    if (!isPlainRecord(rawJudge) || !exactKeys(rawJudge, ['judgeModel', 'mae', 'passed', 'anchors'])) {
      failCalibration(
        'CALIBRATION_INVALID',
        `Calibration for ${runId} has malformed judge evidence at seat ${judgeIndex + 1}.`,
      );
    }
    if (
      typeof rawJudge.judgeModel !== 'string' ||
      rawJudge.judgeModel !== judgePanel[judgeIndex] ||
      !isFiniteNumber(rawJudge.mae) ||
      rawJudge.mae < 0 ||
      typeof rawJudge.passed !== 'boolean' ||
      !Array.isArray(rawJudge.anchors) ||
      rawJudge.anchors.length !== context.anchors.length
    ) {
      failCalibration(
        'CALIBRATION_PANEL_MISMATCH',
        `Calibration for ${runId} has missing, reordered or malformed evidence for seat ${judgePanel[judgeIndex]}.`,
      );
    }

    const rows: JudgeCalibration['anchors'] = [];
    for (const [anchorIndex, rawRow] of rawJudge.anchors.entries()) {
      const anchor = context.anchors[anchorIndex]!;
      if (!isPlainRecord(rawRow) || !exactKeys(rawRow, ['questionId', 'expected', 'got', 'pass'], ['note'])) {
        failCalibration(
          'CALIBRATION_INVALID',
          `Calibration for ${runId}, seat ${judgePanel[judgeIndex]}, anchor ${anchorIndex + 1} is malformed.`,
        );
      }
      if (
        rawRow.questionId !== anchor.questionId ||
        rawRow.expected !== anchor.expectedScore ||
        rawRow.note !== anchor.note ||
        !isFiniteNumber(rawRow.got) ||
        rawRow.got < 0 ||
        rawRow.got > 100 ||
        typeof rawRow.pass !== 'boolean'
      ) {
        failCalibration(
          'CALIBRATION_ANCHOR_MISMATCH',
          `Calibration for ${runId}, seat ${judgePanel[judgeIndex]}, anchor ${anchorIndex + 1} does not match the committed anchor and score schema.`,
        );
      }
      const recomputedPass = Math.abs(rawRow.got - anchor.expectedScore) <= (anchor.toleranceAbs ?? DEFAULT_TOLERANCE);
      if (rawRow.pass !== recomputedPass) {
        failCalibration(
          'CALIBRATION_RESULT_MISMATCH',
          `Calibration for ${runId}, seat ${judgePanel[judgeIndex]}, anchor ${anchorIndex + 1} records pass=${rawRow.pass}, recomputed ${recomputedPass}.`,
        );
      }
      rows.push(rawRow as unknown as JudgeCalibration['anchors'][number]);
    }

    const exactMae =
      rows.reduce((sum, row) => sum + Math.abs(row.got - row.expected), 0) / context.anchors.length;
    const recomputedMae = roundOne(exactMae);
    const recomputedPassed = exactMae <= MAE_LIMIT && rows.every((row) => row.pass);
    if (rawJudge.mae !== recomputedMae || rawJudge.passed !== recomputedPassed) {
      failCalibration(
        'CALIBRATION_RESULT_MISMATCH',
        `Calibration for ${runId}, seat ${judgePanel[judgeIndex]} records MAE/pass ${rawJudge.mae}/${rawJudge.passed}, recomputed ${recomputedMae}/${recomputedPassed}.`,
      );
    }
    judges.push({
      judgeModel: rawJudge.judgeModel,
      mae: rawJudge.mae,
      passed: rawJudge.passed,
      anchors: rows,
    });
  }

  const recomputedMae = Math.max(...judges.map((judge) => judge.mae));
  const recomputedPassed = judges.every((judge) => judge.passed);
  if (value.mae !== recomputedMae || value.passed !== recomputedPassed) {
    failCalibration(
      'CALIBRATION_RESULT_MISMATCH',
      `Calibration for ${runId} records summary MAE/pass ${value.mae}/${value.passed}, recomputed ${recomputedMae}/${recomputedPassed}.`,
    );
  }
  if (typeof value.evidenceHash !== 'string' || !SHA256_RE.test(value.evidenceHash)) {
    failCalibration('CALIBRATION_INVALID', `Calibration for ${runId} has no valid evidence hash.`);
  }
  const { evidenceHash, ...body } = value as unknown as CalibrationResult;
  const recomputedEvidenceHash = calibrationEvidenceHash(body);
  if (evidenceHash !== recomputedEvidenceHash) {
    failCalibration(
      'CALIBRATION_RESULT_MISMATCH',
      `Calibration for ${runId} evidence hash ${evidenceHash.slice(0, 12)}... does not match recomputed ${recomputedEvidenceHash.slice(0, 12)}....`,
    );
  }
  return value as unknown as CalibrationResult;
}

export function readCalibration(runId: string): ReadCalibrationResult | null {
  const path = calibrationReadPath(runId);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new CalibrationError(
      `Calibration for run ${runId} is not valid JSON (${(e as Error).message}).`,
      'CALIBRATION_INVALID',
    );
  }
  if (!isPlainRecord(parsed)) {
    throw new CalibrationError(`Calibration for run ${runId} is not an object.`, 'CALIBRATION_INVALID');
  }
  if (parsed.calibrationVersion === CALIBRATION_VERSION) {
    return validateCalibrationEnvelope(runId, parsed, storedCalibrationContext(runId));
  }
  return readLegacyCalibration(runId, parsed);
}

async function calibrateOne(
  client: CompletionClient,
  judgeModel: string,
  anchors: CalibrationAnchor[],
  questionsById: Map<string, Question>,
  spend: { costUsd: number },
): Promise<JudgeCalibration> {
  const results: JudgeCalibration['anchors'] = [];
  for (const anchor of anchors) {
    const question = questionsById.get(anchor.questionId);
    if (!question) throw new Error(`Calibration anchor references unknown question ${anchor.questionId}`);
    const verdict = await judgeAnswer(client, judgeModel, CALIBRATION_ANCHOR_MODEL, question, anchor.answerText, spend);
    const tolerance = anchor.toleranceAbs ?? DEFAULT_TOLERANCE;
    // The rounded score is the durable evidence, so every derived decision is
    // made from that same value. Computing `pass` from an unpersisted raw score
    // leaves the reader unable to reproduce a boundary decision.
    const got = roundOne(verdict.score);
    results.push({
      questionId: anchor.questionId,
      note: anchor.note,
      expected: anchor.expectedScore,
      got,
      pass: Math.abs(got - anchor.expectedScore) <= tolerance,
    });
  }
  const mae =
    results.reduce((sum, r) => sum + Math.abs(r.got - r.expected), 0) / Math.max(results.length, 1);
  return {
    judgeModel,
    mae: roundOne(mae),
    passed: mae <= MAE_LIMIT && results.every((r) => r.pass),
    anchors: results,
  };
}

/**
 * The judge gate (README Phase 3): before any paid judging, EVERY panel seat
 * must independently reproduce the hand-scored anchors within tolerance.
 * Catches a drifted judge model, a broken prompt, or a severity scheme that
 * stopped biting.
 */
export async function runCalibration(
  client: CompletionClient,
  judgeLabel: string,
  judgePanel: string[],
  judgePromptVersion: string,
  runId: string,
  questionsById: Map<string, Question>,
): Promise<CalibrationResult> {
  // Preflight the WRITE TARGET before any paid work: discovering a historical
  // write refusal after the judge calls have been billed is the wrong order.
  // The result is deliberately NOT reused for the write — see below.
  calibrationWritePath(runId);
  const anchors = loadAnchors();
  const context = storedCalibrationContext(runId, anchors);
  assertCalibrationPanel(runId, judgePanel, judgePromptVersion, context);
  if (typeof judgeLabel !== 'string' || judgeLabel === '') {
    failCalibration('CALIBRATION_PANEL_MISMATCH', `Calibration for run ${runId} has no panel label.`);
  }
  const committedQuestionsById = new Map(loadQuestions().map((question) => [question.id, question]));
  for (const anchor of anchors) {
    const committed = committedQuestionsById.get(anchor.questionId);
    const supplied = questionsById.get(anchor.questionId);
    if (!committed || !supplied || canonicalJson(supplied) !== canonicalJson(committed)) {
      failCalibration(
        'CALIBRATION_ANCHOR_MISMATCH',
        `Calibration question ${anchor.questionId} is missing or differs from the committed question bound into the anchor digest. Refusing before any judge call.`,
      );
    }
  }
  // Anchors x seats x two calls each — real money, and previously unrecorded.
  const spend = { costUsd: 0 };
  const judges: JudgeCalibration[] = [];
  for (const judgeModel of judgePanel) {
    judges.push(await calibrateOne(client, judgeModel, anchors, committedQuestionsById, spend));
  }
  const result = sealCalibration({
    calibrationVersion: CALIBRATION_VERSION,
    runId,
    manifestHash: context.manifestHash,
    judgePromptHash: context.manifest.judgePromptHash,
    anchorSetHash: context.anchorSetHash,
    anchorCount: anchors.length,
    judgeModel: judgeLabel,
    judgePanel,
    judgePromptVersion,
    atIso: new Date().toISOString(),
    mae: Math.max(...judges.map((j) => j.mae)),
    passed: judges.every((j) => j.passed),
    costUsd: Math.round(spend.costUsd * 10000) / 10000,
    judges,
  });
  // A long calibration can straddle an operator action. Re-read all identities
  // after the paid calls and before persisting their result; a result may be
  // bound to one manifest and one anchor bank, never whichever values existed
  // at opposite ends of the loop.
  const finalContext = storedCalibrationContext(runId);
  if (
    finalContext.manifestHash !== context.manifestHash ||
    finalContext.anchorSetHash !== context.anchorSetHash ||
    finalContext.manifest.judgePromptHash !== context.manifest.judgePromptHash
  ) {
    failCalibration(
      'CALIBRATION_MANIFEST_MISMATCH',
      `Run ${runId}'s manifest, judge prompt or calibration anchors changed while calibration was executing. The result is not written.`,
    );
  }
  assertCalibrationPanel(runId, judgePanel, judgePromptVersion, finalContext);
  // Re-resolve immediately before writing rather than trusting the preflight
  // path: the model-call loop above takes minutes, and a release transition or
  // a newly planted symlink during that window would not be caught by a path
  // resolved before it.
  writeRunFileAtomic(runId, 'calibration.json', JSON.stringify(result, null, 2));
  // Exercise the same production reader that later decides whether judging may
  // resume. The writer does not get a private, weaker interpretation.
  const verified = readCalibration(runId);
  if (verified?.calibrationVersion !== CALIBRATION_VERSION) {
    failCalibration('CALIBRATION_RESULT_MISMATCH', `Calibration for run ${runId} did not round-trip as verified evidence.`);
  }
  return verified;
}
