import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunConfig } from '@cookingbench/core';
import type { RunAnalysis } from '../src/analyze.js';
import { writeAnalysis } from '../src/analyze.js';
import { runCalibration } from '../src/calibration.js';
import { RUNS_DIR } from '../src/dataset.js';
import { FirewallError, type FirewallErrorCode } from '../src/firewall.js';
import type { ChatMessage, CompletionClient, CompletionResult } from '../src/openrouter.js';
import { mergeRunConfig, readResponses, readRunConfig, writeRunConfig } from '../src/store.js';

/**
 * Route-level proof for the store, analyze and calibration writers.
 *
 * `docs/wp-0/routes.yaml` recorded these risks as open because the evidence
 * offered for them exercised a HELPER — `resolveRunFile`, `resolveRunDir` —
 * rather than the route. A test that calls `resolveRunFile` says nothing about
 * `writeRunConfig`: if `writeRunConfig` stopped routing through the firewall
 * tomorrow, that test would still be green. So every test below calls the
 * route's OWN exported function, and asserts the specific refusal the risk
 * names — the FirewallError CODE, not merely that something threw. A protocol
 * mismatch or an unparseable config would also throw, and neither is evidence
 * that published work is immutable.
 *
 * Offline by construction: no socket, no key, no model. `globalThis.fetch` is
 * replaced for the whole file so that a route which unexpectedly reached a
 * provider would fail loudly rather than quietly bill.
 */

const FROZEN = '2026-07-v2.1';
const SCRATCH = '__test-routes-store-scratch';
const ESCAPE_ALIAS = '__test-routes-store-escape';

/** Top-level artifacts of the frozen run, each of which a route here targets. */
const FROZEN_FILES = [
  'config.json',
  'scores.json',
  'leaderboard.json',
  'analysis.json',
  'calibration.json',
] as const;

/**
 * Byte identity of the published run.
 *
 * The refusal is only half the claim. DATA-001 is about the artifact, so each
 * test also proves the artifact did not move — including that no stray staging
 * file (`config.json.tmp-…`) was left behind, which a directory listing catches
 * and a per-file digest does not. Response BODIES are excluded on cost grounds:
 * the corpus is 2,576 files, and their names are enough to detect a write that
 * landed in the directory.
 */
function frozenFingerprint(): string {
  const dir = join(RUNS_DIR, FROZEN);
  const h = createHash('sha256');
  h.update(readdirSync(dir).sort().join('\n'));
  for (const name of FROZEN_FILES) {
    h.update(name);
    h.update(readFileSync(join(dir, name)));
  }
  h.update(readdirSync(join(dir, 'responses')).sort().join('\n'));
  return h.digest('hex');
}

function expectFirewallRefusal(fn: () => unknown, code: FirewallErrorCode, fragment: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the route did not refuse at all').toBeInstanceOf(FirewallError);
  expect((caught as FirewallError).code).toBe(code);
  expect((caught as FirewallError).message).toMatch(fragment);
}

async function expectAsyncFirewallRefusal(
  fn: () => Promise<unknown>,
  code: FirewallErrorCode,
  fragment: RegExp,
): Promise<void> {
  let caught: unknown;
  try {
    await fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, 'the route did not refuse at all').toBeInstanceOf(FirewallError);
  expect((caught as FirewallError).code).toBe(code);
  expect((caught as FirewallError).message).toMatch(fragment);
}

/** Where a redirected write would land if a leaf symlink were followed. */
let outsideDir: string;
const realFetch = globalThis.fetch;

beforeAll(() => {
  outsideDir = mkdtempSync(join(tmpdir(), 'cb-routes-store-'));
  globalThis.fetch = (async () => {
    throw new Error('a route test opened the network; these routes must refuse before any provider call');
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(outsideDir, { recursive: true, force: true });
});

afterEach(() => {
  rmSync(join(RUNS_DIR, SCRATCH), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, ESCAPE_ALIAS), { recursive: true, force: true });
});

function scratchConfig(): RunConfig {
  return {
    runId: SCRATCH,
    models: ['a/one'],
    temperature: 0,
    maxTokens: 16000,
    maxTokensRecipe: 32000,
    budgetUsdTotal: 1,
    budgetUsdPerModel: 0,
    concurrency: 4,
    judgeModel: 'panel-v1',
    judgePanel: ['anthropic/claude-opus-4.8'],
    judgePromptVersion: 'judge-v2',
    methodologyVersion: 'v3.0',
    mock: false,
    batches: [
      {
        startedAt: '2026-07-30T00:00:00Z',
        models: ['a/one'],
        maxTokens: 16000,
        maxTokensRecipe: 32000,
        budgetUsdTotal: 1,
      },
    ],
  };
}

/**
 * The same payload, re-addressed to the scratch run.
 *
 * Every frozen-run test below pairs its refusal with this control. Without one,
 * a test proves only that the call threw — and a call that throws because its
 * input was malformed would pass just as green after the immutability check was
 * deleted. The control shows the payload is one the route accepts, so the
 * refusal is about the run being published and nothing else.
 */
function asScratch<T extends { runId: string }>(config: T): T {
  return { ...config, runId: SCRATCH };
}

/**
 * A live scratch run whose `config.json` is a symlink OUT of the runs tree.
 *
 * The link target is a real, protocol-identical config, so the RUN-002 gate
 * passes and the call reaches the writer: the point is to prove the refusal
 * comes from the path guard at the write, not from an incidental protocol
 * mismatch earlier. If the leaf were followed, `bench run --run-id` on a run
 * somebody had prepared would rewrite a file outside `data/` entirely.
 */
function plantLinkedConfig(): { plantedPath: string; config: RunConfig } {
  const dir = join(RUNS_DIR, SCRATCH);
  mkdirSync(dir, { recursive: true });
  const config = scratchConfig();
  const plantedPath = join(outsideDir, 'planted-config.json');
  writeFileSync(plantedPath, JSON.stringify(config, null, 2));
  symlinkSync(plantedPath, join(dir, 'config.json'));
  return { plantedPath, config };
}

describe('runner:store:config:write — writeRunConfig', () => {
  it('refuses to write config.json into a published run', () => {
    const before = frozenFingerprint();
    // The run's own config, handed straight back: this is what `bench judge`
    // does when it rewrites judgeModel/judgePanel on an existing run, and the
    // reason it must be refused here is that the run id is published, not that
    // anything about the protocol changed. Feeding back an IDENTICAL config
    // takes the RUN-002 gate out of the picture, so the only refusal left to
    // observe is immutability.
    expectFirewallRefusal(
      () => writeRunConfig(readRunConfig(FROZEN)),
      'HISTORICAL_WRITE',
      /historical and immutable \(DATA-001\)/,
    );
    expect(frozenFingerprint()).toBe(before);
    // Control: the identical payload at an unpublished id writes normally.
    expect(writeRunConfig(asScratch(readRunConfig(FROZEN))).runId).toBe(SCRATCH);
    expect(existsSync(join(RUNS_DIR, SCRATCH, 'config.json'))).toBe(true);
  });

  it('refuses a config.json leaf symlink out of the runs tree', () => {
    const { plantedPath, config } = plantLinkedConfig();
    const planted = readFileSync(plantedPath, 'utf8');
    expectFirewallRefusal(
      () => writeRunConfig(config),
      'SYMLINK_COMPONENT',
      /Refusing to traverse symlink component/,
    );
    // Containment is not enough on its own: the run directory is legitimate and
    // unfrozen, and only leaf resolution stops the bytes leaving the tree.
    expect(readFileSync(plantedPath, 'utf8')).toBe(planted);
  });
});

describe('runner:store:config:merge — mergeRunConfig', () => {
  it('refuses to merge a resumed batch into a published run', () => {
    const before = frozenFingerprint();
    // `bench run --run-id 2026-07-v2.1` after the run was published: the merge
    // path is the one an operator actually reaches, and it must refuse for the
    // immutability reason rather than by luck of a protocol difference.
    expectFirewallRefusal(
      () => mergeRunConfig(readRunConfig(FROZEN)),
      'HISTORICAL_WRITE',
      /historical and immutable \(DATA-001\)/,
    );
    expect(frozenFingerprint()).toBe(before);
    // Control, and it also drives the true MERGE branch: the second call finds
    // a config already on disk, so the refusal above cannot be dismissed as the
    // new-run path in disguise.
    mergeRunConfig(asScratch(readRunConfig(FROZEN)));
    expect(mergeRunConfig(asScratch(readRunConfig(FROZEN))).runId).toBe(SCRATCH);
  });

  it('refuses a config.json leaf symlink out of the runs tree', () => {
    const { plantedPath, config } = plantLinkedConfig();
    const planted = readFileSync(plantedPath, 'utf8');
    // The merge reads the prior config through the link and still refuses at
    // the write — a merged config carries the union of every batch, so a
    // redirected write here loses the audit trail of the whole run.
    expectFirewallRefusal(
      () => mergeRunConfig(config),
      'SYMLINK_COMPONENT',
      /Refusing to traverse symlink component/,
    );
    expect(readFileSync(plantedPath, 'utf8')).toBe(planted);
  });
});

describe('runner:store:responses:read — readResponses', () => {
  it('refuses a run id that traverses out of the runs directory', () => {
    // Reads are how a scoring or analysis pass acquires evidence. A traversing
    // id would let a caller present arbitrary JSON as a run's answers.
    expectFirewallRefusal(
      () => readResponses('../../etc'),
      'INVALID_RUN_ID',
      /Invalid run id/,
    );
  });

  it('refuses a run directory symlinked outside the runs tree', () => {
    // Lexical containment passes here — the alias sits under data/runs — so
    // only real-path resolution catches it. Answers pulled in from outside the
    // tree carry no manifest, no permit and no provenance, and would be scored
    // as though they did.
    const foreign = join(outsideDir, 'foreign-run');
    mkdirSync(join(foreign, 'responses'), { recursive: true });
    writeFileSync(
      join(foreign, 'responses', 'a__q.json'),
      JSON.stringify({ runId: ESCAPE_ALIAS, modelId: 'a/one', questionId: 'q', answerText: 'planted' }),
    );
    symlinkSync(foreign, join(RUNS_DIR, ESCAPE_ALIAS));
    expectFirewallRefusal(
      () => readResponses(ESCAPE_ALIAS),
      'SYMLINK_ESCAPE',
      /outside the runs root|outside the runs directory/,
    );
    // Control: the planted answer is in a shape this route reads happily, so
    // the refusal above is the guard and not an unreadable fixture.
    mkdirSync(join(RUNS_DIR, SCRATCH, 'responses'), { recursive: true });
    writeFileSync(
      join(RUNS_DIR, SCRATCH, 'responses', 'a__q.json'),
      readFileSync(join(foreign, 'responses', 'a__q.json')),
    );
    expect(readResponses(SCRATCH).map((r) => r.answerText)).toEqual(['planted']);
  });
});

describe('runner:analyze:analysis:write — writeAnalysis', () => {
  it('refuses to write analysis.json into a published run', () => {
    const before = frozenFingerprint();
    // analysis.json is what the site reads for the separation table, so a
    // mistargeted --run-id here rewrites the published claim about which model
    // actually separates from which.
    expectFirewallRefusal(
      () => writeAnalysis(FROZEN, { runId: FROZEN } as unknown as RunAnalysis),
      'HISTORICAL_WRITE',
      /historical and immutable \(DATA-001\)/,
    );
    expect(frozenFingerprint()).toBe(before);
    // Control: the same object at an unpublished id is written without protest.
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    writeAnalysis(SCRATCH, { runId: SCRATCH } as unknown as RunAnalysis);
    expect(existsSync(join(RUNS_DIR, SCRATCH, 'analysis.json'))).toBe(true);
  });
});

/** A judge client that cannot call anything, and remembers being asked. */
class RecordingClient implements CompletionClient {
  calls = 0;
  async complete(_modelId: string, _messages: ChatMessage[]): Promise<CompletionResult> {
    this.calls++;
    throw new Error('calibration reached a provider; the write target had not been proved writable');
  }
}

describe('runner:calibration:result:write — runCalibration', () => {
  it('refuses to write calibration.json into a published run', async () => {
    const before = frozenFingerprint();
    await expectAsyncFirewallRefusal(
      () =>
        runCalibration(new RecordingClient(), 'panel-v1', ['anthropic/claude-opus-4.8'], 'judge-v2', FROZEN, new Map()),
      'HISTORICAL_WRITE',
      /historical and immutable \(DATA-001\)/,
    );
    expect(frozenFingerprint()).toBe(before);
  });

  it('refuses before the first paid judge call, so a refused run costs nothing', async () => {
    // The budget risk is one of ORDER, not of arithmetic: anchors x seats x two
    // calls each is real money, and discovering the write refusal afterwards
    // means the spend has already happened and cannot be recovered. The client
    // counter is the whole assertion — a preflight that runs after the loop
    // would still throw the same error and still be wrong.
    const client = new RecordingClient();
    await expectAsyncFirewallRefusal(
      () => runCalibration(client, 'panel-v1', ['anthropic/claude-opus-4.8'], 'judge-v2', FROZEN, new Map()),
      'HISTORICAL_WRITE',
      /historical and immutable \(DATA-001\)/,
    );
    expect(client.calls, 'a judge seat was called before the write target was checked').toBe(0);
  });
});
