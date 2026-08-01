import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Question } from '@cookingbench/core';
import {
  CalibrationError,
  calibrationAnchorSetHash,
  loadAnchors,
  readCalibration,
  runCalibration,
} from '../src/calibration.js';
import { RUNS_DIR, loadQuestions } from '../src/dataset.js';
import { buildRunManifest, writeRunManifest } from '../src/manifest.js';
import type {
  ChatMessage,
  CompletionClient,
  CompletionResult,
  GuardedCompletionOpts,
} from '../src/openrouter.js';

const PREFIX = '__test-calibration-evidence';
const SEAT = 'judge/seat-a';
let sequence = 0;

function scratchRun(): string {
  sequence += 1;
  return `${PREFIX}-${process.pid}-${sequence}`;
}

afterEach(() => {
  if (!existsSync(RUNS_DIR)) return;
  for (const name of readdirSync(RUNS_DIR).filter((entry) => entry.startsWith(PREFIX))) {
    rmSync(join(RUNS_DIR, name), { recursive: true, force: true });
  }
});

function seedManifest(runId: string, questions: Question[] = loadQuestions()): void {
  const { manifest } = buildRunManifest(
    {
      manifestVersion: 1,
      runId,
      methodologyVersion: 'v3.0',
      schemaVersion: '1',
      parentArtifacts: [],
      evidenceClass: 'development',
      artifactOrigin: ['agent-authored'],
      releaseState: 'draft',
      rankEligible: false,
      candidateRoutes: [
        { modelId: 'candidate/a', provider: 'candidate', baseModelFamily: 'candidate-a' },
      ],
      judgeRoutes: [
        { modelId: SEAT, provider: 'judge', baseModelFamily: 'judge-seat-a' },
      ],
      generationSettings: {
        temperature: 0,
        maxTokens: 16000,
        maxTokensRecipe: 32000,
        repeats: 1,
        repeatPolicy: 'single',
      },
      callPlan: { concurrency: 1, maxAttempts: 3, abortOn: [] },
      budgetCapUsd: 10,
    },
    questions,
  );
  writeRunManifest(runId, manifest, questions);
}

class OfflineJudge implements CompletionClient {
  calls = 0;

  async complete(
    _modelId: string,
    _messages: ChatMessage[],
    _opts: GuardedCompletionOpts,
  ): Promise<CompletionResult> {
    this.calls += 1;
    return {
      text: JSON.stringify({ findings: [], summary: 'offline calibration fixture' }),
      raw: {},
      tokensIn: 1,
      tokensOut: 1,
      costUsd: 0.001,
      latencyMs: 1,
    };
  }
}

function readRaw(runId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(RUNS_DIR, runId, 'calibration.json'), 'utf8')) as Record<string, unknown>;
}

function writeRaw(runId: string, value: unknown): void {
  writeFileSync(join(RUNS_DIR, runId, 'calibration.json'), JSON.stringify(value, null, 2));
}

async function produceCalibration(runId: string): Promise<void> {
  const questions = loadQuestions();
  seedManifest(runId, questions);
  const client = new OfflineJudge();
  await runCalibration(
    client,
    'panel-v1',
    [SEAT],
    'judge-v2',
    runId,
    new Map(questions.map((question) => [question.id, question])),
  );
  expect(client.calls).toBe(loadAnchors().length * 2);
}

describe('calibration evidence envelope', () => {
  it('round-trips a complete writer result through the same production reader used by the gate', async () => {
    const runId = scratchRun();
    await produceCalibration(runId);

    const result = readCalibration(runId);
    expect(result?.calibrationVersion).toBe(2);
    if (result?.calibrationVersion !== 2) throw new Error('expected verified calibration evidence');
    expect(result.runId).toBe(runId);
    expect(result.manifestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.anchorSetHash).toBe(calibrationAnchorSetHash());
    expect(result.anchorCount).toBe(loadAnchors().length);
    expect(result.judgePanel).toEqual([SEAT]);
    expect(result.judges).toHaveLength(1);
    expect(result.judges[0]!.anchors).toHaveLength(result.anchorCount);
    expect(result.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses vacuous, malformed or arithmetically invented judge evidence', async () => {
    const runId = scratchRun();
    await produceCalibration(runId);
    const valid = readRaw(runId);

    writeRaw(runId, { ...valid, passed: true, mae: 0, judges: [] });
    expect(() => readCalibration(runId)).toThrow(CalibrationError);

    writeRaw(runId, valid);
    const malformed = readRaw(runId);
    const judges = structuredClone(malformed.judges) as Array<Record<string, unknown>>;
    const rows = judges[0]!.anchors as Array<Record<string, unknown>>;
    rows[0] = { ...rows[0], got: '100' };
    writeRaw(runId, { ...malformed, judges });
    expect(() => readCalibration(runId)).toThrow(/score schema|malformed/i);

    writeRaw(runId, valid);
    const invented = readRaw(runId);
    const inventedJudges = structuredClone(invented.judges) as Array<Record<string, unknown>>;
    inventedJudges[0] = { ...inventedJudges[0], mae: 0, passed: true };
    writeRaw(runId, { ...invented, mae: 0, passed: true, judges: inventedJudges });
    expect(() => readCalibration(runId)).toThrow(/recomputed/i);

    writeRaw(runId, { ...valid, costUsd: Number(valid.costUsd) + 1 });
    expect(() => readCalibration(runId)).toThrow(/evidence hash/i);
  });

  it('refuses stale anchor, prompt, manifest and copied-run identities', async () => {
    const source = scratchRun();
    await produceCalibration(source);
    const valid = readRaw(source);

    writeRaw(source, { ...valid, anchorSetHash: 'a'.repeat(64) });
    expect(() => readCalibration(source)).toThrow(/committed bank/i);

    writeRaw(source, { ...valid, judgePromptHash: 'b'.repeat(64) });
    expect(() => readCalibration(source)).toThrow(/manifested prompt/i);

    writeRaw(source, { ...valid, manifestHash: 'c'.repeat(64) });
    expect(() => readCalibration(source)).toThrow(/run stores/i);

    const destination = scratchRun();
    seedManifest(destination);
    writeRaw(destination, valid);
    expect(() => readCalibration(destination)).toThrow(/claims version\/run/i);
  });

  it('refuses a caller-substituted calibration question before the first judge call', async () => {
    const runId = scratchRun();
    const questions = loadQuestions();
    seedManifest(runId, questions);
    const anchors = loadAnchors();
    const targetId = anchors[0]!.questionId;
    const substituted = new Map<string, Question>(
      questions.map((question) => [
        question.id,
        question.id === targetId ? { ...question, prompt: `${question.prompt}\nsubstituted` } : question,
      ]),
    );
    const client = new OfflineJudge();
    await expect(
      runCalibration(client, 'panel-v1', [SEAT], 'judge-v2', runId, substituted),
    ).rejects.toThrow(/differs from the committed question/i);
    expect(client.calls).toBe(0);
  });
});
