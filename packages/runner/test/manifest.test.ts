import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, type Question, type Score } from '@cookingbench/core';
import { RUNS_DIR, loadQuestions } from '../src/dataset.js';
import { FirewallError, writeRunFileAtomic } from '../src/firewall.js';
import { manifestHash, sha256Hex } from '../src/permit.js';
import {
  DeriveError,
  assertSourceCommitted,
  deriveRun,
  verifyDerivation,
} from '../src/derive.js';
import {
  ManifestError,
  assertRunArtifactsMatchManifest,
  buildRunManifest,
  computeContentDigest,
  itemHash,
  judgePromptHashFor,
  promptHashFor,
  readRunManifest,
  validatorDigest,
  verifyRunManifest,
  writeRunManifest,
} from '../src/manifest.js';
import {
  ANSWER_JOURNAL,
  GENESIS_LINK,
  LifecycleError,
  appendBallot,
  appendJournalEntry,
  appendRawAnswer,
  ballotIdentity,
  buildReleaseChecklist,
  candidateRetryKey,
  checklistComplete,
  detectStaleScores,
  itemIdentity,
  journalHead,
  readCurrentRun,
  readJournal,
  readReleaseRegister,
  registerRun,
  responseIdentity,
  retainableScores,
  runState,
  safeReadCurrentRun,
  scoreStatusReport,
  setCurrentRun,
  transitionRun,
  verifyJournal,
  type ReleaseChecklist,
} from '../src/lifecycle.js';

/**
 * DATA-002 / M4.1 / M4.7 / M4.8.
 *
 * Offline by construction: no socket, no secret, no model call. Everything is
 * hashing, filesystem scratch space under data/runs, and one `git status` on
 * an already-committed directory.
 *
 * These are written as attempts to BREAK the guarantees, not as demonstrations:
 * the interesting cases are the manifest that lies about its bank, the score
 * that survives a change it should not, the checklist that certifies its own
 * blind spots, and the pointer that keeps serving a withdrawn board.
 */

const SCRATCH = '__test-manifest-scratch';
const DERIVED = '__test-manifest-derived';
const REGISTER = '__test-manifest-register.json';

afterEach(() => {
  rmSync(join(RUNS_DIR, SCRATCH), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, DERIVED), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, REGISTER), { force: true });
});

const SETTINGS = { maxTokens: 16000, maxTokensRecipe: 32000 };

/** A small, stable slice of the real dataset. */
function slice(ids: string[]): Question[] {
  const byId = new Map(loadQuestions().map((q) => [q.id, q]));
  return ids.map((id) => {
    const q = byId.get(id);
    if (!q) throw new Error(`fixture item ${id} is no longer in the dataset`);
    return q;
  });
}

const CANARY_ITEMS = [
  'conv-001',
  'conv-002',
  'conv-003',
  'conv-004',
  'conv-005',
  'conv-006',
  'conv-007',
  'conv-008',
  'conv-009',
  'conv-010',
];

function draftManifest(runId: string, models: string[] = ['meta-llama/llama-4-maverick']) {
  return {
    manifestVersion: 1,
    runId,
    methodologyVersion: 'v3.0',
    schemaVersion: '1',
    gitCommit: '980dfcb',
    parentArtifacts: [],
    evidenceClass: 'development',
    artifactOrigin: ['archived'],
    releaseState: 'draft',
    rankEligible: false,
    candidateRoutes: models.map((modelId) => ({
      modelId,
      provider: modelId.split('/')[0] ?? 'unknown',
      baseModelFamily: modelId,
    })),
    judgeRoutes: [
      { modelId: 'x-ai/grok-4.5', provider: 'xai', baseModelFamily: 'grok-frontier' },
    ],
    generationSettings: {
      temperature: 0,
      maxTokens: SETTINGS.maxTokens,
      maxTokensRecipe: SETTINGS.maxTokensRecipe,
      repeats: 1,
      repeatPolicy: 'single',
    },
    callPlan: { concurrency: 4, maxAttempts: 3, abortOn: [] },
    budgetCapUsd: 10,
  } as Record<string, unknown>;
}

// ---------------------------------------------------------------------------

describe('M4.1 — content hashes describe what actually runs', () => {
  it('is stable under item order and unstable under item content', () => {
    const items = slice(CANARY_ITEMS);
    const a = computeContentDigest(items, SETTINGS);
    const b = computeContentDigest([...items].reverse(), SETTINGS);
    expect(b.bankHash).toBe(a.bankHash);
    expect(b.promptHash).toBe(a.promptHash);
    expect(b.judgePromptHash).toBe(a.judgePromptHash);

    // A digest that survives an edited item is a digest that binds nothing.
    const first = items[0] as Question;
    const edited = { ...first, referenceAnswer: `${first.referenceAnswer} (edited)` } as Question;
    const c = computeContentDigest([edited, ...items.slice(1)], SETTINGS);
    expect(c.bankHash).not.toBe(a.bankHash);
  });

  it('separates a scoring-key change from a prompt change', () => {
    // The whole point of four hashes rather than one: an edited expected value
    // invalidates the SCORE and not the answer, and the digests have to say so.
    const items = slice(['conv-001']);
    const original = items[0] as Question;
    const base = computeContentDigest(items, SETTINGS);

    const rewordedPrompt = { ...original, prompt: `${original.prompt} Please show your working.` } as Question;
    const prompted = computeContentDigest([rewordedPrompt], SETTINGS);
    expect(prompted.promptHash).not.toBe(base.promptHash);
    expect(prompted.bankHash).not.toBe(base.bankHash);

    const rekeyed = {
      ...original,
      grader: { ...original.grader, tolerancePct: 99 },
    } as unknown as Question;
    const scored = computeContentDigest([rekeyed], SETTINGS);
    expect(scored.bankHash).not.toBe(base.bankHash);
    expect(scored.promptHash, 'a grader-key edit must not read as a prompt change').toBe(base.promptHash);
  });

  it('makes an edited reference answer invalidate the judge prompt', () => {
    // The reference answer is pasted into the judge prompt. Editing it changes
    // how every candidate was graded, and that must be visible as such.
    const judged = loadQuestions().find((q) => q.grader.type === 'llm-judge');
    expect(judged, 'the dataset has judge-graded items').toBeDefined();
    const q = judged as Question;
    const before = judgePromptHashFor(q).hash;
    const after = judgePromptHashFor({ ...q, referenceAnswer: `${q.referenceAnswer} Also, rest it.` } as Question).hash;
    expect(before).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it('gives a deterministically graded item no judge prompt, rather than a fake one', () => {
    const deterministic = loadQuestions().find((q) => q.grader.type !== 'llm-judge') as Question;
    expect(judgePromptHashFor(deterministic)).toEqual({ hash: null, mode: null });
  });

  it('refuses an item whose judge prompt does not build', () => {
    // Fail closed at manifest time, not mid-spend: a dimension item with no
    // anchors would ask the judge to invent the scale.
    const q = slice(['conv-001'])[0] as Question;
    const broken = {
      ...q,
      grader: { type: 'llm-judge', judgeMode: 'dimension', rubric: [] },
      anchors: [],
    } as unknown as Question;
    expect(() => judgePromptHashFor(broken)).toThrow(ManifestError);
    try {
      judgePromptHashFor(broken);
    } catch (e) {
      expect((e as ManifestError).code).toBe('JUDGE_PROMPT_UNRENDERABLE');
    }
  });

  it('refuses an empty or duplicated item set', () => {
    // An empty set hashes to a fixed value that binds no content at all — the
    // most dangerous kind of stable digest.
    expect(() => computeContentDigest([], SETTINGS)).toThrow(ManifestError);
    const q = slice(['conv-001'])[0] as Question;
    expect(() => computeContentDigest([q, q], SETTINGS)).toThrow(ManifestError);
  });

  it('covers every grader source by listing the directory, not a hand-written list', () => {
    const { files } = validatorDigest();
    const onDisk = readdirSync(join(RUNS_DIR, '..', '..', 'packages', 'core', 'src', 'graders'))
      .filter((f) => f.endsWith('.ts'))
      .sort();
    const covered = files
      .filter((f) => f.path.includes('graders') && f.present)
      .map((f) => f.path.split('/').pop());
    expect(covered.sort()).toEqual(onDisk);
  });

  it('changes the token cap and sees it, because the cap is not provider-neutral', () => {
    const recipe = loadQuestions().find((q) => q.category === 'recipe-generation') as Question;
    expect(promptHashFor(recipe, SETTINGS)).not.toBe(
      promptHashFor(recipe, { ...SETTINGS, maxTokensRecipe: 8000 }),
    );
  });
});

// ---------------------------------------------------------------------------

describe('DATA-002 — a command writes the manifest, and it must be true', () => {
  it('fills the content hashes and produces a manifest that parses', () => {
    const items = slice(CANARY_ITEMS);
    const { manifest, digest } = buildRunManifest(draftManifest(SCRATCH), items);
    expect(manifest.bankHash).toBe(digest.bankHash);
    expect(manifest.outputRoot).toBe(`data/runs/${SCRATCH}`);
    expect(manifestHash(manifest)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('checks a declared hash instead of correcting it', () => {
    // Silently overwriting an operator's declaration turns a wrong belief about
    // which bank is running into a run that quietly runs a different one.
    const draft = { ...draftManifest(SCRATCH), bankHash: 'f'.repeat(64) };
    expect(() => buildRunManifest(draft, slice(CANARY_ITEMS))).toThrow(ManifestError);
  });

  it('refuses a draft whose token caps are unstated', () => {
    const draft = draftManifest(SCRATCH);
    delete draft.generationSettings;
    expect(() => buildRunManifest(draft, slice(CANARY_ITEMS))).toThrow(/maxTokens/);
  });

  it('refuses a manifest written into the wrong run, and a manifest that moved', () => {
    const items = slice(CANARY_ITEMS);
    const { manifest } = buildRunManifest(draftManifest('__test-other-run'), items);
    expect(() => writeRunManifest(SCRATCH, manifest, items)).toThrow(ManifestError);

    const mine = buildRunManifest(draftManifest(SCRATCH), items).manifest;
    writeRunManifest(SCRATCH, mine, items);
    // A manifest copied from another run into this one carries no authority.
    writeRunFileAtomic(SCRATCH, 'manifest.json', JSON.stringify({ ...mine, runId: '__test-other-run', outputRoot: 'data/runs/__test-other-run' }));
    expect(() => readRunManifest(SCRATCH)).toThrow(ManifestError);
  });

  it('is idempotent for the same envelope and immutable for a different one', () => {
    const items = slice(CANARY_ITEMS);
    const { manifest } = buildRunManifest(draftManifest(SCRATCH), items);
    expect(writeRunManifest(SCRATCH, manifest, items).written).toBe(true);
    expect(writeRunManifest(SCRATCH, manifest, items).written).toBe(false);

    const other = buildRunManifest({ ...draftManifest(SCRATCH), budgetCapUsd: 11 }, items).manifest;
    try {
      writeRunManifest(SCRATCH, other, items);
      throw new Error('expected a refusal');
    } catch (e) {
      expect((e as ManifestError).code).toBe('MANIFEST_IMMUTABLE');
    }
  });

  it('refuses a manifest whose declared hashes do not describe the supplied items', () => {
    const items = slice(CANARY_ITEMS);
    const { manifest } = buildRunManifest(draftManifest(SCRATCH), items);
    // Same manifest, different bank. This is the masquerade.
    expect(() => writeRunManifest(SCRATCH, manifest, slice(['conv-011']))).toThrow(ManifestError);
    expect(existsSync(join(RUNS_DIR, SCRATCH, 'manifest.json'))).toBe(false);
  });

  it('cannot be written into a published run', () => {
    const items = slice(CANARY_ITEMS);
    const { manifest } = buildRunManifest(draftManifest('canary'), items);
    expect(() => writeRunManifest('canary', manifest, items)).toThrow(FirewallError);
  });
});

// ---------------------------------------------------------------------------

describe('DATA-002 — a changed bank cannot masquerade as the manifested one', () => {
  function seed(): Question[] {
    const items = slice(CANARY_ITEMS);
    const { manifest } = buildRunManifest(draftManifest(SCRATCH), items);
    writeRunManifest(SCRATCH, manifest, items);
    return items;
  }

  it('verifies a run that matches its manifest', () => {
    seed();
    const report = verifyRunManifest(SCRATCH);
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reports drift, and names the items that moved', () => {
    const items = seed();
    const first = items[0] as Question;
    const mutated = [{ ...first, referenceAnswer: 'something else entirely' } as Question, ...items.slice(1)];
    const report = verifyRunManifest(SCRATCH, { dataset: mutated });
    expect(report.ok).toBe(false);
    const bank = report.findings.find((f) => f.code === 'BANK_DRIFT');
    expect(bank?.items).toEqual([first.id]);
    // The reference answer is inside the judge prompt too.
    expect(report.findings.some((f) => f.code === 'JUDGE_PROMPT_DRIFT' || f.code === 'BANK_DRIFT')).toBe(true);
  });

  it('refuses when a manifested item has left the dataset, rather than passing', () => {
    seed();
    const report = verifyRunManifest(SCRATCH, { dataset: slice(CANARY_ITEMS.slice(1)) });
    expect(report.ok).toBe(false);
    expect(report.findings.map((f) => f.code)).toContain('ITEM_MISSING_FROM_DATASET');
  });

  it('catches a hand-edited manifest whose digest no longer backs it', () => {
    const items = seed();
    const tampered = { ...readRunManifest(SCRATCH), bankHash: 'f'.repeat(64) };
    writeRunFileAtomic(SCRATCH, 'manifest.json', JSON.stringify(tampered));
    const report = verifyRunManifest(SCRATCH, { dataset: items });
    expect(report.findings.map((f) => f.code)).toContain('DIGEST_DOES_NOT_BACK_MANIFEST');
    expect(report.ok).toBe(false);
  });

  it('never reports ok when it could not check', () => {
    // An absent manifest is a refusal, not an empty pass.
    mkdirSync(join(RUNS_DIR, SCRATCH), { recursive: true });
    const report = verifyRunManifest(SCRATCH);
    expect(report.ok).toBe(false);
    expect(report.findings[0]?.code).toBe('MANIFEST_ABSENT');

    // A manifest with no digest beside it cannot be reconciled with any item set.
    const items = slice(CANARY_ITEMS);
    const { manifest } = buildRunManifest(draftManifest(SCRATCH), items);
    writeRunFileAtomic(SCRATCH, 'manifest.json', JSON.stringify(manifest));
    expect(verifyRunManifest(SCRATCH).findings.map((f) => f.code)).toContain('DIGEST_ABSENT');
  });

  it('rejects responses the manifest does not account for', () => {
    seed();
    const write = (name: string, body: Record<string, unknown>) =>
      writeRunFileAtomic(SCRATCH, join('responses', name), JSON.stringify(body));

    write('a.json', { runId: SCRATCH, modelId: 'evil/undeclared', questionId: 'conv-001' });
    write('b.json', { runId: SCRATCH, modelId: 'meta-llama/llama-4-maverick', questionId: 'conv-099' });
    write('c.json', { runId: 'some-other-run', modelId: 'meta-llama/llama-4-maverick', questionId: 'conv-001' });
    write('d.json', { runId: SCRATCH, modelId: 'meta-llama/llama-4-maverick' });

    const codes = verifyRunManifest(SCRATCH).findings.map((f) => f.code);
    expect(codes).toContain('RESPONSE_UNDECLARED_MODEL');
    expect(codes).toContain('RESPONSE_UNDECLARED_ITEM');
    expect(codes).toContain('RESPONSE_WRONG_RUN');
    expect(codes).toContain('RESPONSE_UNREADABLE');
  });

  it('reports missing cells only when completeness was asked for', () => {
    seed();
    expect(verifyRunManifest(SCRATCH).ok).toBe(true);
    const strict = verifyRunManifest(SCRATCH, { expectComplete: true });
    expect(strict.findings.map((f) => f.code)).toContain('CELL_MISSING');
    expect(() => assertRunArtifactsMatchManifest(SCRATCH, { expectComplete: true })).toThrow(ManifestError);
  });
});

// ---------------------------------------------------------------------------

describe('DATA-001 — a re-scoring run inherits answers instead of overwriting them', () => {
  it('refuses the shortcuts that would break immutability', () => {
    expect(() => deriveRun({ sourceRunId: 'canary', targetRunId: 'canary', reason: 'x' })).toThrow(DeriveError);
    expect(() => deriveRun({ sourceRunId: 'canary', targetRunId: DERIVED, reason: '  ' })).toThrow(DeriveError);
    // The target must be fresh: a half-derived or occupied target is not resumed.
    mkdirSync(join(RUNS_DIR, DERIVED, 'responses'), { recursive: true });
    expect(() => deriveRun({ sourceRunId: 'canary', targetRunId: DERIVED, reason: 'x' })).toThrow(DeriveError);
  });

  it('refuses a source with uncommitted content', () => {
    // The lineage record names a git tree. If the source is not committed, that
    // tree does not contain the bytes the record claims.
    mkdirSync(join(RUNS_DIR, SCRATCH, 'responses'), { recursive: true });
    writeFileSync(join(RUNS_DIR, SCRATCH, 'responses', 'x.json'), '{}');
    expect(() => assertSourceCommitted(SCRATCH)).toThrow(DeriveError);
    try {
      assertSourceCommitted(SCRATCH);
    } catch (e) {
      expect((e as DeriveError).code).toBe('SOURCE_NOT_COMMITTED');
    }
  });

  it('carries the answers, the lineage and nothing that was earned', () => {
    const result = deriveRun({
      sourceRunId: 'canary',
      targetRunId: DERIVED,
      reason: 'regrade under the corrected keyword grader',
    });
    expect(result.record.responses).toHaveLength(10);
    expect(result.record.derivedFrom.treeHash).toMatch(/^[a-f0-9]{40}$/);
    expect(result.config.derivedFrom.runId).toBe('canary');
    expect(result.config.releaseState).toBe('draft');
    // Scores, boards and analyses are NOT inherited: reusing them would carry
    // forward numbers from the very grader the derivation exists to change.
    for (const earned of ['scores.json', 'leaderboard.json', 'analysis.json']) {
      expect(existsSync(join(RUNS_DIR, DERIVED, earned))).toBe(false);
    }
    // And the spend does not come with them.
    expect(result.config.budgetUsdTotal).toBe(0);

    expect(verifyDerivation(DERIVED)).toEqual({ ok: true, problems: [] });
  });

  it('notices when an inherited answer is altered afterwards', () => {
    deriveRun({ sourceRunId: 'canary', targetRunId: DERIVED, reason: 'regrade' });
    const dir = join(RUNS_DIR, DERIVED, 'responses');
    const victim = join(dir, readdirSync(dir)[0] as string);
    // Rewrite through the copy, NOT through a hard link: with mode 'copy' the
    // derived file has its own inode, so this cannot reach the published run.
    writeFileSync(victim, JSON.stringify({ tampered: true }));
    const result = verifyDerivation(DERIVED);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/has changed/);
    // The published source is untouched.
    expect(readFileSync(join(RUNS_DIR, 'canary', 'responses', readdirSync(dir)[0] as string), 'utf8')).not.toContain(
      'tampered',
    );
  });

  it('lets a derived run verify against its own manifest despite the inherited stamp', () => {
    // The copied answers legitimately carry `runId: canary`. Rewriting the stamp
    // would break the hash check that proves the copy is faithful, so the
    // verifier reads the lineage instead of demanding a rewrite.
    deriveRun({ sourceRunId: 'canary', targetRunId: DERIVED, reason: 'regrade' });
    const items = slice(CANARY_ITEMS);
    const { manifest } = buildRunManifest(
      { ...draftManifest(DERIVED), parentArtifacts: ['canary'] },
      items,
    );
    writeRunManifest(DERIVED, manifest, items);
    const report = verifyRunManifest(DERIVED, { expectComplete: true });
    expect(report.findings.map((f) => f.code)).toEqual([]);
  });

  it('hard-links on request, and the link is byte-identical', () => {
    const result = deriveRun({
      sourceRunId: 'canary',
      targetRunId: DERIVED,
      reason: 'space-constrained regrade',
      mode: 'hardlink',
    });
    expect(result.record.derivedFrom.copyMode).toBe('hardlink');
    expect(verifyDerivation(DERIVED).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('M4.8 — deterministic ids and idempotent retry keys', () => {
  it('is a pure function of content, and never collides across kinds', () => {
    const key = { runId: 'r', modelId: 'm', questionId: 'q' };
    expect(responseIdentity(key)).toBe(responseIdentity({ ...key, repeatIndex: 0 }));
    expect(responseIdentity(key)).not.toBe(responseIdentity({ ...key, repeatIndex: 1 }));
    expect(itemIdentity('r', 'm')).not.toBe(responseIdentity({ runId: 'r', modelId: 'm', questionId: '' }));
    expect(
      ballotIdentity({ ...key, judgeModelId: 'j', promptVersion: 'judge-v2' }),
    ).not.toBe(ballotIdentity({ ...key, judgeModelId: 'j', promptVersion: 'judge-v3-dimension' }));
  });

  it('gives every attempt of one cell the SAME retry key', () => {
    // A key that changed per attempt would be idempotent for nothing: the whole
    // point is that attempt 2 is recognised as attempt 1's unit of work.
    const key = { runId: 'r', modelId: 'm', questionId: 'q' };
    expect(candidateRetryKey(key)).toBe(candidateRetryKey({ ...key }));
    expect(candidateRetryKey(key)).toBe(responseIdentity(key));
  });
});

describe('M4.8 — raw answers and ballots are append-only and tamper-evident', () => {
  it('is idempotent on the retry key and chains every line', () => {
    const answer = {
      runId: SCRATCH,
      modelId: 'meta-llama/llama-4-maverick',
      questionId: 'conv-001',
      answerText: 'about 240 ml',
      costUsd: 0.01,
      tokensIn: 10,
      tokensOut: 20,
    };
    expect(appendRawAnswer(answer).appended).toBe(true);
    expect(appendRawAnswer(answer).appended, 'a retried delivery must add nothing').toBe(false);
    appendRawAnswer({ ...answer, questionId: 'conv-002' });
    appendBallot(
      { runId: SCRATCH, modelId: answer.modelId, questionId: 'conv-001', judgeModelId: 'x-ai/grok-4.5', promptVersion: 'judge-v2' },
      { findings: [] },
    );

    const entries = readJournal(SCRATCH, ANSWER_JOURNAL);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.prev).toBe(GENESIS_LINK);
    expect(verifyJournal(SCRATCH, ANSWER_JOURNAL).ok).toBe(true);
    expect(journalHead(SCRATCH, ANSWER_JOURNAL)).not.toBe(GENESIS_LINK);
  });

  it('detects an edited or reordered record, and refuses to extend a broken chain', () => {
    for (const q of ['conv-001', 'conv-002', 'conv-003']) {
      appendRawAnswer({
        runId: SCRATCH,
        modelId: 'm',
        questionId: q,
        answerText: q,
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      });
    }
    const path = join(RUNS_DIR, SCRATCH, 'raw', 'answers.ndjson');
    const lines = readFileSync(path, 'utf8').trim().split('\n');

    // Remove a MIDDLE record: the chain notices.
    writeFileSync(path, `${[lines[0], lines[2]].join('\n')}\n`);
    const broken = verifyJournal(SCRATCH, ANSWER_JOURNAL);
    expect(broken.ok).toBe(false);
    expect(broken.problems[0]).toMatch(/links to/);
    expect(() => readJournal(SCRATCH, ANSWER_JOURNAL)).toThrow(LifecycleError);
    expect(() =>
      appendRawAnswer({
        runId: SCRATCH,
        modelId: 'm',
        questionId: 'conv-004',
        answerText: 'x',
        costUsd: 0,
        tokensIn: 0,
        tokensOut: 0,
      }),
    ).toThrow(LifecycleError);
  });

  it('reports a duplicated id rather than trusting the file', () => {
    appendJournalEntry(SCRATCH, ANSWER_JOURNAL, 'resp_dup', { a: 1 });
    const path = join(RUNS_DIR, SCRATCH, 'raw', 'answers.ndjson');
    const line = readFileSync(path, 'utf8').trim();
    // Forge a second entry with the same id but a correct chain link.
    const forged = canonicalJson({ id: 'resp_dup', prev: sha256Hex(line), recordedAt: 'x', body: { a: 2 } });
    writeFileSync(path, `${line}\n${forged}\n`);
    expect(verifyJournal(SCRATCH, ANSWER_JOURNAL).problems.join(' ')).toMatch(/repeats id/);
  });

  it('refuses an entry with no deterministic id', () => {
    expect(() => appendJournalEntry(SCRATCH, ANSWER_JOURNAL, '   ', {})).toThrow(LifecycleError);
  });
});

// ---------------------------------------------------------------------------

describe('M4.7 — no preservation of stale judge scores', () => {
  const items = () => slice(CANARY_ITEMS);

  function snapshot(runId: string, questions: Question[], overrides: Record<string, unknown> = {}) {
    const built = buildRunManifest({ ...draftManifest(runId), ...overrides }, questions);
    return { manifest: built.manifest as unknown, digest: built.digest as unknown };
  }

  it('invalidates everything when the prior manifest cannot be read', () => {
    // "We cannot tell what produced these scores" is not "these scores are fine".
    const verdict = detectStaleScores({ manifest: { nonsense: true } }, snapshot(SCRATCH, items()));
    expect(verdict.invalidatesEverything).toBe(true);
    expect(verdict.reasons[0]?.code).toBe('MANIFEST_UNREADABLE');
  });

  it('keeps everything when nothing changed', () => {
    const a = snapshot(SCRATCH, items());
    const verdict = detectStaleScores(a, snapshot(SCRATCH, items()));
    expect(verdict.reasons).toEqual([]);
    expect(verdict.invalidated).toEqual({ candidate: [], deterministic: [], judge: [] });
  });

  it('drops judge scores when the panel is re-seated, and keeps deterministic ones', () => {
    const before = snapshot(SCRATCH, items());
    const after = snapshot(SCRATCH, items(), {
      judgeRoutes: [
        { modelId: 'openai/gpt-5.5', provider: 'openai', baseModelFamily: 'gpt-frontier' },
      ],
    });
    const verdict = detectStaleScores(before, after);
    expect(verdict.reasons.map((r) => r.code)).toEqual(['PANEL_CHANGED']);
    expect(verdict.invalidated.judge).toBe('all');
    expect(verdict.invalidated.deterministic).toEqual([]);

    const scores: Score[] = [
      { runId: SCRATCH, modelId: 'm', questionId: 'conv-001', score: 90, graderType: 'llm-judge', detail: {}, judgeModel: 'x-ai/grok-4.5' },
      { runId: SCRATCH, modelId: 'm', questionId: 'conv-002', score: 100, graderType: 'numeric', detail: {} },
    ];
    const { retained, dropped } = retainableScores(scores, verdict);
    expect(dropped.map((s) => s.questionId)).toEqual(['conv-001']);
    expect(retained.map((s) => s.questionId)).toEqual(['conv-002']);
  });

  it('localises a bank change to the items that actually changed', () => {
    const original = items();
    const first = original[0] as Question;
    const edited = [{ ...first, referenceAnswer: 'quite different' } as Question, ...original.slice(1)];
    const verdict = detectStaleScores(snapshot(SCRATCH, original), snapshot(SCRATCH, edited));
    expect(verdict.invalidated.judge).toEqual([first.id]);
    expect(verdict.invalidated.candidate, 'the answer itself is unaffected').toEqual([]);

    const scores: Score[] = original.map((q) => ({
      runId: SCRATCH,
      modelId: 'm',
      questionId: q.id,
      score: 100,
      graderType: 'llm-judge' as const,
      detail: {},
      judgeModel: 'j',
    }));
    expect(retainableScores(scores, verdict).dropped.map((s) => s.questionId)).toEqual([first.id]);
  });

  it('invalidates every item when it cannot tell which one moved', () => {
    // Without component digests a summary hash says only "something changed",
    // and guessing a smaller blast radius would retain scores for changed items.
    const original = items();
    const first = original[0] as Question;
    const edited = [{ ...first, referenceAnswer: 'quite different' } as Question, ...original.slice(1)];
    const before = buildRunManifest(draftManifest(SCRATCH), original).manifest as unknown;
    const after = buildRunManifest(draftManifest(SCRATCH), edited).manifest as unknown;
    const verdict = detectStaleScores({ manifest: before }, { manifest: after });
    expect(verdict.invalidated.judge).toBe('all');
  });

  it('lets a grader change reach judged scores too', () => {
    // The graders module owns blending and cascade routing, not just individual
    // graders — the 2026-07 audit's fix moved six of thirteen positions.
    const before = snapshot(SCRATCH, items());
    const after = {
      manifest: { ...(before.manifest as Record<string, unknown>), validatorHash: 'e'.repeat(64) },
      digest: before.digest,
    };
    const verdict = detectStaleScores(before, after);
    expect(verdict.invalidated.deterministic).toBe('all');
    const scores: Score[] = [
      { runId: SCRATCH, modelId: 'm', questionId: 'conv-001', score: 90, graderType: 'llm-judge', detail: {}, judgeModel: 'j' },
    ];
    expect(retainableScores(scores, verdict).retained).toEqual([]);
  });

  it('treats a token-cap change as invalidating the answers themselves', () => {
    const before = snapshot(SCRATCH, items());
    const after = snapshot(SCRATCH, items(), {
      generationSettings: {
        temperature: 0,
        maxTokens: 8000,
        maxTokensRecipe: 8000,
        repeats: 1,
        repeatPolicy: 'single',
      },
    });
    const verdict = detectStaleScores(before, after);
    expect(verdict.reasons.map((r) => r.code)).toContain('GENERATION_SETTINGS_CHANGED');
    expect(verdict.invalidated.candidate).toBe('all');
  });
});

// ---------------------------------------------------------------------------

describe('M4.7 — score and adjudication status is complete, not just what is on disk', () => {
  const cell = (modelId: string, questionId: string) => ({ modelId, questionId });

  it('counts cells that were never attempted', () => {
    const report = scoreStatusReport({
      runId: SCRATCH,
      models: ['a', 'b'],
      questionIds: ['q1', 'q2'],
      responses: [{ modelId: 'a', questionId: 'q1', answerText: 'x' }],
      scores: [],
    });
    expect(report.total).toBe(4);
    expect(report.counts['not-attempted']).toBe(3);
    expect(report.counts.answered).toBe(1);
    expect(report.complete).toBe(false);
  });

  it('keeps an unadjudicated flag out of the terminal set, but an incident inside it', () => {
    const report = scoreStatusReport({
      runId: SCRATCH,
      models: ['a'],
      questionIds: ['q1', 'q2', 'q3'],
      responses: [
        { modelId: 'a', questionId: 'q1', answerText: 'x' },
        { modelId: 'a', questionId: 'q2', answerText: '', transportFailure: true },
        { modelId: 'a', questionId: 'q3', answerText: 'x' },
      ],
      scores: [
        { modelId: 'a', questionId: 'q1', graderType: 'llm-judge', judgeModel: 'j' },
        { modelId: 'a', questionId: 'q3', graderType: 'numeric' },
      ],
      judgedItemIds: ['q1'],
      flagged: [cell('a', 'q1')],
    });
    expect(report.counts.flagged).toBe(1);
    expect(report.counts.incident).toBe(1);
    expect(report.counts.graded).toBe(1);
    expect(report.incomplete.map((c) => c.questionId)).toEqual(['q1']);

    const adjudicated = scoreStatusReport({
      runId: SCRATCH,
      models: ['a'],
      questionIds: ['q1'],
      responses: [{ modelId: 'a', questionId: 'q1', answerText: 'x' }],
      scores: [{ modelId: 'a', questionId: 'q1', graderType: 'llm-judge', judgeModel: 'j' }],
      flagged: [cell('a', 'q1')],
      adjudicated: [cell('a', 'q1')],
    });
    expect(adjudicated.complete).toBe(true);
  });

  it('reads a judged item with no judge as pending, not as graded', () => {
    const report = scoreStatusReport({
      runId: SCRATCH,
      models: ['a'],
      questionIds: ['q1'],
      responses: [{ modelId: 'a', questionId: 'q1', answerText: 'x' }],
      scores: [{ modelId: 'a', questionId: 'q1', graderType: 'llm-judge' }],
    });
    expect(report.counts['judge-pending']).toBe(1);
    expect(report.complete).toBe(false);
  });

  it('puts an invalidated cell above everything else it had reached', () => {
    const report = scoreStatusReport({
      runId: SCRATCH,
      models: ['a'],
      questionIds: ['q1'],
      responses: [{ modelId: 'a', questionId: 'q1', answerText: 'x' }],
      scores: [{ modelId: 'a', questionId: 'q1', graderType: 'numeric' }],
      invalidated: [cell('a', 'q1')],
    });
    expect(report.counts.invalidated).toBe(1);
    expect(report.complete).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('M4.7 — the release checklist certifies nothing it did not check', () => {
  function seeded(): void {
    const items = slice(CANARY_ITEMS);
    const { manifest } = buildRunManifest(draftManifest(SCRATCH), items);
    writeRunManifest(SCRATCH, manifest, items);
  }

  it('marks an unsupplied check not-checked, and not-checked is not complete', () => {
    seeded();
    const checklist = buildReleaseChecklist({ runId: SCRATCH });
    const unchecked = checklist.items.filter((i) => i.verdict === 'not-checked').map((i) => i.id);
    expect(unchecked).toContain('lifecycle-audited');
    expect(unchecked).toContain('coverage-complete');
    expect(unchecked).toContain('no-stale-scores');
    expect(checklist.complete).toBe(false);
    expect(checklistComplete(checklist)).toBe(false);
  });

  it('recomputes completeness rather than believing the flag', () => {
    // A checklist that asserts its own completeness is a checklist that can lie.
    const lying = {
      checklistVersion: 1,
      runId: SCRATCH,
      generatedAt: 'now',
      manifestHash: null,
      complete: true,
      items: [{ id: 'x', statement: 'y', verdict: 'fail', detail: '' }],
    } as unknown as ReleaseChecklist;
    expect(checklistComplete(lying)).toBe(false);
    expect(checklistComplete({ ...lying, items: [] })).toBe(false);
  });

  it('fails the evidence-class item for a development artifact', () => {
    seeded();
    const checklist = buildReleaseChecklist({ runId: SCRATCH });
    expect(checklist.items.find((i) => i.id === 'evidence-class-publishable')?.verdict).toBe('fail');
  });
});

// ---------------------------------------------------------------------------

describe('M4.7 — an explicit reviewed pointer, not the newest timestamp', () => {
  function pass(runId: string, hash: string): ReleaseChecklist {
    return {
      checklistVersion: 1,
      runId,
      generatedAt: new Date().toISOString(),
      manifestHash: hash,
      items: [{ id: 'stub', statement: 'every gate passed', verdict: 'pass', detail: '' }],
      complete: true,
    };
  }

  function registered(): string {
    const items = slice(CANARY_ITEMS);
    const { manifest } = buildRunManifest(draftManifest(SCRATCH), items);
    writeRunManifest(SCRATCH, manifest, items);
    const hash = manifestHash(manifest);
    registerRun({ runId: SCRATCH, manifestHash: hash, actor: 'test', evidence: 'unit test', file: REGISTER });
    return hash;
  }

  it('refuses to read a current run that nobody set', () => {
    expect(() => readCurrentRun(REGISTER)).toThrow(LifecycleError);
    expect(safeReadCurrentRun(REGISTER).ok).toBe(false);
  });

  it('refuses a lifecycle move nobody signed', () => {
    registered();
    expect(() =>
      transitionRun({ runId: SCRATCH, to: 'audited', actor: '', evidence: 'x', file: REGISTER }),
    ).toThrow(LifecycleError);
  });

  it('refuses to skip audit, and refuses to reopen a released run', () => {
    const hash = registered();
    expect(() =>
      transitionRun({ runId: SCRATCH, to: 'released', actor: 'jordan', evidence: 'ship it', file: REGISTER, checklist: pass(SCRATCH, hash) }),
    ).toThrow(/cannot go 'draft' → 'released'/);

    transitionRun({ runId: SCRATCH, to: 'audited', actor: 'jordan', evidence: 'audited', file: REGISTER });
    transitionRun({ runId: SCRATCH, to: 'released', actor: 'jordan', evidence: 'approved', file: REGISTER, checklist: pass(SCRATCH, hash) });
    expect(runState(SCRATCH, REGISTER)).toBe('released');
    expect(existsSync(join(RUNS_DIR, SCRATCH, 'RELEASED'))).toBe(true);
    expect(() =>
      transitionRun({ runId: SCRATCH, to: 'draft', actor: 'jordan', evidence: 'oops', file: REGISTER }),
    ).toThrow(LifecycleError);
  });

  it('refuses to release on a checklist that is incomplete, foreign or bound to another manifest', () => {
    const hash = registered();
    transitionRun({ runId: SCRATCH, to: 'audited', actor: 'jordan', evidence: 'audited', file: REGISTER });
    const release = (checklist?: ReleaseChecklist) =>
      transitionRun({ runId: SCRATCH, to: 'released', actor: 'jordan', evidence: 'go', file: REGISTER, checklist });

    expect(() => release(undefined)).toThrow(/requires a release checklist/);
    expect(() => release({ ...pass(SCRATCH, hash), items: [{ id: 'x', statement: 'y', verdict: 'fail', detail: 'd' }] })).toThrow(
      /not complete/,
    );
    expect(() => release(pass('another-run', hash))).toThrow(/names run/);
    expect(() => release(pass(SCRATCH, 'a'.repeat(64)))).toThrow(/built against manifest/);
    expect(runState(SCRATCH, REGISTER)).toBe('audited');
  });

  it('only points at a released run, and stops pointing when it is withdrawn', () => {
    const hash = registered();
    const checklist = pass(SCRATCH, hash);
    expect(() =>
      setCurrentRun({ runId: SCRATCH, reviewedBy: 'jordan', reviewEvidence: 'reviewed', checklist, file: REGISTER }),
    ).toThrow(/not 'released'/);

    transitionRun({ runId: SCRATCH, to: 'audited', actor: 'jordan', evidence: 'audited', file: REGISTER });
    transitionRun({ runId: SCRATCH, to: 'released', actor: 'jordan', evidence: 'approved', file: REGISTER, checklist });
    const pointer = setCurrentRun({
      runId: SCRATCH,
      reviewedBy: 'jordan',
      reviewEvidence: 'read the board and the analysis',
      checklist,
      file: REGISTER,
    });
    expect(pointer.checklistDigest).toBe(sha256Hex(canonicalJson(checklist)));
    expect(readCurrentRun(REGISTER).runId).toBe(SCRATCH);

    // A withdrawn board must stop being current the moment it is quarantined.
    transitionRun({ runId: SCRATCH, to: 'quarantined', actor: 'jordan', evidence: 'bad grader found', file: REGISTER });
    expect(readReleaseRegister(REGISTER).currentRun).toBeNull();
    expect(safeReadCurrentRun(REGISTER).ok).toBe(false);
    // And it can never be un-quarantined in place.
    expect(() =>
      transitionRun({ runId: SCRATCH, to: 'released', actor: 'jordan', evidence: 'false alarm', file: REGISTER, checklist }),
    ).toThrow(LifecycleError);
  });

  it('refuses to re-register a run against a different envelope', () => {
    registered();
    expect(() =>
      registerRun({ runId: SCRATCH, manifestHash: 'b'.repeat(64), actor: 'test', evidence: 'x', file: REGISTER }),
    ).toThrow(LifecycleError);
    // And a run cannot be entered straight into a later state.
    expect(() =>
      registerRun({ runId: '__test-other', manifestHash: 'c'.repeat(64), actor: 't', evidence: 'x', initialState: 'released', file: REGISTER }),
    ).toThrow(LifecycleError);
  });

  it('refuses an unregistered run and an unparseable or unknown-state register', () => {
    expect(() =>
      transitionRun({ runId: SCRATCH, to: 'audited', actor: 'jordan', evidence: 'x', file: REGISTER }),
    ).toThrow(/not in the release register/);

    writeFileSync(join(RUNS_DIR, REGISTER), '{ not json');
    expect(() => readReleaseRegister(REGISTER)).toThrow(LifecycleError);

    writeFileSync(
      join(RUNS_DIR, REGISTER),
      JSON.stringify({ registerVersion: 1, entries: { r: { runId: 'r', state: 'shipped', manifestHash: 'x', updatedAt: '', history: [] } }, currentRun: null }),
    );
    expect(() => readReleaseRegister(REGISTER)).toThrow(/not a known release state/);
  });

  it('treats an absent register as "nothing is released", not as "anything goes"', () => {
    const register = readReleaseRegister(REGISTER);
    expect(register.entries).toEqual({});
    expect(register.currentRun).toBeNull();
    expect(runState('canary', REGISTER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('the hashing this module reuses is the hashing permits are signed over', () => {
  it('takes manifestHash from permit.ts rather than re-deriving it', () => {
    // A second canonicalisation here would invalidate every issued permit at the
    // moment someone tried to use one. The golden digests pin the first.
    const { manifest } = buildRunManifest(draftManifest(SCRATCH), slice(CANARY_ITEMS));
    expect(manifestHash(manifest)).toBe(sha256Hex(canonicalJson(manifest)));
  });

  it('keeps item identity independent of YAML formatting but bound to content', () => {
    const q = slice(['conv-001'])[0] as Question;
    expect(itemHash(q)).toBe(itemHash(JSON.parse(JSON.stringify(q)) as Question));
    expect(itemHash(q)).not.toBe(itemHash({ ...q, difficulty: (q.difficulty ?? 1) + 1 } as Question));
  });
});
