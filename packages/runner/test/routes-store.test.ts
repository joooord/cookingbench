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
import {
  FirewallError,
  readProvenance,
  recordProvenance,
  type FirewallErrorCode,
} from '../src/firewall.js';
import { ReservationLedger } from '../src/ledger.js';
import type { ChatMessage, CompletionClient, CompletionResult } from '../src/openrouter.js';
import {
  mergeRunConfig,
  readAttempts,
  readResponses,
  readRunConfig,
  readScores,
  writeRunConfig,
} from '../src/store.js';
import { mintTestGrant } from './support/grant.js';

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

describe('runner:store:responses:read — readResponses resolves its LEAF', () => {
  // The defect these two cover, verified before it was fixed: `readResponses`
  // was `readdirSync(join(runDir(runId), 'responses'))` — the DIRECTORY was
  // firewall-resolved and the leaf was not. A scratch run containing
  // `responses -> data/runs/2026-07-v2.1/responses` returned all 2,576 frozen
  // answers with no error, attributed to the scratch run. That is provenance
  // laundering: a run with no manifest, no permit and no candidate spend can
  // present another run's corpus as its own evidence and be scored on it.

  it('refuses a responses directory symlinked at a run that is not this one', () => {
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    symlinkSync(join(RUNS_DIR, FROZEN, 'responses'), join(RUNS_DIR, SCRATCH, 'responses'));

    // Everything about this path is contained: the run directory is real and
    // unfrozen, the link stays inside data/runs, and the target is a directory
    // full of perfectly valid StoredResponse JSON. Only leaf resolution sees it.
    expectFirewallRefusal(
      () => readResponses(SCRATCH),
      'SYMLINK_COMPONENT',
      /Refusing to traverse symlink component/,
    );

    // The claim is that the frozen corpus did not come back, not merely that
    // something threw: before the fix this returned the full 2,576.
    let borrowed = -1;
    try {
      borrowed = readResponses(SCRATCH).length;
    } catch {
      borrowed = -1;
    }
    expect(borrowed, 'the scratch run served the frozen corpus as its own').toBe(-1);
    // …and the frozen run itself still reads, so the guard refuses the link
    // rather than the corpus.
    expect(readResponses(FROZEN).length).toBeGreaterThan(2000);
  });

  it('refuses a single response file symlinked into another run', () => {
    // Resolving only the directory would pass this: `responses/` is a real
    // directory this run owns, and exactly one answer inside it is borrowed.
    // One substituted cell is the cheaper attack and the harder one to notice.
    const dir = join(RUNS_DIR, SCRATCH, 'responses');
    mkdirSync(dir, { recursive: true });
    const own = join(dir, 'a__q.json');
    writeFileSync(
      own,
      JSON.stringify({ runId: SCRATCH, modelId: 'a/one', questionId: 'q', answerText: 'mine' }),
    );
    const borrowed = readdirSync(join(RUNS_DIR, FROZEN, 'responses'))[0]!;
    symlinkSync(join(RUNS_DIR, FROZEN, 'responses', borrowed), join(dir, 'zz__borrowed.json'));

    expectFirewallRefusal(
      () => readResponses(SCRATCH),
      'SYMLINK_COMPONENT',
      /Refusing to read responses\/zz__borrowed\.json/,
    );

    // Control, and it is what makes the refusal above meaningful: with the
    // borrowed entry removed the route reads the run's own answer happily, so
    // the refusal is about the link and not about the fixture.
    rmSync(join(dir, 'zz__borrowed.json'), { force: true });
    expect(readResponses(SCRATCH).map((r) => r.answerText)).toEqual(['mine']);
    expect(readFileSync(own, 'utf8')).toContain('mine');
  });
});

describe('runner:store:artifacts:read — every run-scoped reader resolves its leaf', () => {
  it('refuses a linked config.json, scores.json or attempts directory', () => {
    // Same defect class as the two above, at the three other readers that decide
    // what a run IS. config.json carries the protocol binding a resumed batch is
    // checked against, scores.json is what `report` ranks, and attempts/ is what
    // `attemptChargesUsd` bills the budget cap against — a borrowed attempt
    // ledger makes another run's spend satisfy this run's cap.
    const dir = join(RUNS_DIR, SCRATCH);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(RUNS_DIR, FROZEN, 'config.json'), join(dir, 'config.json'));
    symlinkSync(join(RUNS_DIR, FROZEN, 'scores.json'), join(dir, 'scores.json'));
    symlinkSync(join(RUNS_DIR, FROZEN), join(dir, 'attempts'));

    for (const [label, call] of [
      ['config', () => readRunConfig(SCRATCH)],
      ['scores', () => readScores(SCRATCH)],
      ['attempts', () => readAttempts(SCRATCH)],
    ] as const) {
      expectFirewallRefusal(call, 'SYMLINK_COMPONENT', /Refusing to traverse symlink component/);
      expect(label).toBeTruthy();
    }

    // Absence is still absence, not a refusal: a run with no scores yet reads as
    // empty, which is the behaviour the pipeline depends on before grading.
    rmSync(join(dir, 'scores.json'), { force: true });
    rmSync(join(dir, 'attempts'), { force: true });
    expect(readScores(SCRATCH)).toEqual([]);
    expect(readAttempts(SCRATCH)).toEqual([]);
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

  it('refuses an analysis.json leaf symlink out of the runs tree', () => {
    // The verified defect. `writeAnalysis` was a bare `writeFileSync(join(
    // resolveRunDir(runId, { write: true }), 'analysis.json'), …)`: the
    // directory check passed, and `writeFileSync` FOLLOWED the leaf. Probed
    // against a target outside the repository, the write succeeded and
    // overwrote it. Every other writer here already went through
    // `writeRunFileAtomic`, which stages and renames so the entry is replaced
    // rather than followed — this one route did not, and DATA-001 was recorded
    // as closed while it was open.
    const dir = join(RUNS_DIR, SCRATCH);
    mkdirSync(dir, { recursive: true });
    const decoy = join(outsideDir, 'analysis-target.json');
    writeFileSync(decoy, 'untouched');
    symlinkSync(decoy, join(dir, 'analysis.json'));

    expectFirewallRefusal(
      () => writeAnalysis(SCRATCH, { runId: SCRATCH } as unknown as RunAnalysis),
      'SYMLINK_COMPONENT',
      /Refusing to traverse symlink component/,
    );
    expect(readFileSync(decoy, 'utf8'), 'the write followed the link out of the tree').toBe('untouched');
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

  it('preflights the write TARGET, not its directory, before the first paid call', async () => {
    // The verified defect, and the reason the preceding test was not enough: the
    // preflight was `join(resolveRunDir(runId, { write: true }),
    // 'calibration.json')`, and `join` validates nothing. On an UNFROZEN run the
    // directory check passed, so the preflight cleared a target that only the
    // final `writeRunFileAtomic` would reject. Probed: the judge loop started —
    // the client was called — and the refusal arrived after the spend.
    const dir = join(RUNS_DIR, SCRATCH);
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(outsideDir, 'calibration-target.json'), join(dir, 'calibration.json'));

    const client = new RecordingClient();
    await expectAsyncFirewallRefusal(
      () => runCalibration(client, 'panel-v1', ['anthropic/claude-opus-4.8'], 'judge-v2', SCRATCH, new Map()),
      'SYMLINK_COMPONENT',
      /Refusing to traverse symlink component/,
    );
    expect(client.calls, 'the judge loop ran against a target that was never writable').toBe(0);
    // A dangling link is the sharper case: following it would have CREATED the
    // outside file, so its absence is the proof the bytes never left the tree.
    expect(existsSync(join(outsideDir, 'calibration-target.json'))).toBe(false);
  });
});

describe('runner:firewall:provenance:append — the approval trail lives in the run', () => {
  const TRAIL_RUN = '__test-routes-store-trail';
  afterEach(() => rmSync(join(RUNS_DIR, TRAIL_RUN), { recursive: true, force: true }));

  it('appends one line per authorisation, and refuses to write into a published run', () => {
    // TRACE-001 asks that every ARTIFACT can be traced to the approval that
    // authorised it. `Firewall.provenance()` had existed since the permit layer
    // landed and nothing that writes ever called it: the only durable trail was
    // the redemption record, which lives in data/permits beside the PERMIT.
    // That is traceable only by someone who already knows to look there.
    const grant = mintTestGrant({
      kind: 'development-probe',
      capabilities: ['candidate-inference', 'judge-inference'],
      cells: [{ modelId: 'a/one', questionId: 'q' }],
      runId: TRAIL_RUN,
    });

    const first = recordProvenance(TRAIL_RUN, grant, 'bench run');
    expect(first).toMatchObject({ permitId: 'permit-test-0001', runId: TRAIL_RUN, command: 'bench run' });

    // APPEND, not replace. A run is assembled from several batches and judged
    // in a separate pass; a file keeping only the last authorisation would
    // describe the run as though one approval covered all of it.
    recordProvenance(TRAIL_RUN, grant, 'bench judge');
    const trail = readProvenance(TRAIL_RUN);
    expect(trail.map((e) => e.command)).toEqual(['bench run', 'bench judge']);
    expect(trail.every((e) => e.manifestHash === first.manifestHash)).toBe(true);

    // A corrupt trail refuses rather than reporting an unknown approval as
    // none — "no provenance" and "provenance we cannot read" must not look the
    // same to a release check.
    writeFileSync(join(RUNS_DIR, TRAIL_RUN, 'provenance.ndjson'), '{ truncated\n');
    expectFirewallRefusal(() => readProvenance(TRAIL_RUN), 'REGISTRY_INVALID', /trail for run .* is corrupt/);

    // And the trail cannot be retro-fitted into published work: appendRunFileLine
    // is the writer, so the frozen-run guard applies to it like every other.
    const before = frozenFingerprint();
    const frozenGrant = mintTestGrant({
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: 'a/one', questionId: 'q' }],
      runId: FROZEN,
    });
    expectFirewallRefusal(
      () => recordProvenance(FROZEN, frozenGrant, 'bench run'),
      'HISTORICAL_WRITE',
      /historical and immutable \(DATA-001\)/,
    );
    expect(frozenFingerprint()).toBe(before);

    // A run nothing has authorised reports an empty trail, not a missing file
    // error — the pipeline reads this before anything has written it.
    expect(readProvenance(SCRATCH)).toEqual([]);
  });
});

describe('runner:ledger:journal — the spend record is this run\'s own', () => {
  const LEDGER_RUN = '__test-routes-store-ledger';
  afterEach(() => rmSync(join(RUNS_DIR, LEDGER_RUN), { recursive: true, force: true }));

  it('refuses a symlinked spend journal at construction, before any call is authorised', () => {
    // Two leaf defects in one route. The constructor preflighted
    // `resolveRunDir(runId, { write: true })` while the journal is written by
    // `appendRunFileLine`, which refuses a linked leaf — so a linked journal
    // cleared the preflight and failed at the first settlement, i.e. after the
    // money had left. And `#replayJournal` read through the link, so a resumed
    // run would inherit ANOTHER run's spend as its prior: the number the entire
    // cap is computed from.
    const dir = join(RUNS_DIR, LEDGER_RUN);
    mkdirSync(dir, { recursive: true });
    const decoy = join(outsideDir, 'foreign-spend.ndjson');
    writeFileSync(decoy, `${JSON.stringify({ atIso: '2026-07-30T00:00:00Z', permitId: 'p', modelId: 'a/one', actualUsd: 0 })}\n`);
    symlinkSync(decoy, join(dir, 'spend.ndjson'));

    const grant = mintTestGrant({
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: 'a/one', questionId: 'q' }],
      runId: LEDGER_RUN,
      budgetCapUsd: 5,
    });
    expectFirewallRefusal(
      () => ReservationLedger.forGrant(grant, LEDGER_RUN),
      'SYMLINK_COMPONENT',
      /Refusing to traverse symlink component/,
    );

    // Control: with the link removed the same grant opens a ledger normally, so
    // the refusal is the leaf guard and not the grant, the cap or the lock.
    rmSync(join(dir, 'spend.ndjson'), { force: true });
    const ledger = ReservationLedger.forGrant(grant, LEDGER_RUN);
    expect(ledger.committedUsd).toBe(0);
    ledger.close();
  });
});
