import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blendJudgeScore,
  gradeDeterministic,
  type Question,
  type RunConfig,
  type Score,
  type StoredResponse,
} from '@cookingbench/core';
import { analyzeRun, tiedRanks, writeAnalysis } from './analyze.js';
import { BudgetExceededError, ReservationLedger } from './ledger.js';
import {
  PermitError,
  frozenMethodologyHash as permitMethodologyHash,
  verifyPermitFile,
  type VerifiedGrant,
} from './permit.js';
import { redeemPermit } from './redemption.js';
import {
  ManifestError,
  assertManifestRouteIdentityMatchesRoster,
  assertReproducibleGitIdentity,
  assertRunArtifactsMatchManifest,
  assertGrantMatchesStoredManifest,
  assertRunIdentity,
  buildRunManifest,
  readRunDigest,
  readRunManifest,
  resolveStoredManifestClaim,
  writeRunManifest,
} from './manifest.js';
import {
  appendBallot,
  appendRawAnswer,
  assertPublicationAllowed,
  buildReleaseChecklist,
  checklistShortfall,
  readReleaseRegister,
  registerRun,
  safeReadCurrentRun,
  setCurrentRun,
  transitionRun,
  writeReleaseChecklist,
} from './lifecycle.js';
import { DATA_DIR, REPO_ROOT, RUNS_DIR, buildMessages, loadModels, loadQuestions, maxTokensFor, runnableQuestions } from './dataset.js';
import { assertFreshEstimate, runEstimate } from './estimate.js';
import { recordProvenance } from './firewall.js';
import { JUDGE_PROMPT_VERSION, identityIndex, judgeAnswerPanel } from './judge.js';
import { MOCK_MODELS, MockClient, mockJudgeScore } from './mock.js';
import { OpenRouterClient, fetchCatalog, type CompletionClient } from './openrouter.js';
import { buildLeaderboard } from './report.js';
import {
  beginAttempt,
  readAttempts,
  settleAttempt,
  type AttemptCause,
  type AttemptCoordinate,
  hasResponse,
  listRuns,
  mergeRunConfig,
  readResponses,
  readRunConfig,
  readScores,
  writeLeaderboard,
  writeResponse,
  writeRunConfig,
  writeScores,
} from './store.js';

const DEFAULTS = {
  temperature: 0,
  // v1's 2000/4000 caps starved hidden-reasoning models into empty answers.
  // v2's flat 8000 fixed that for short answers but still truncated Opus 5 on
  // recipe generation, where it spends thousands of tokens reasoning before it
  // writes anything — see maxTokensFor for the measurements. Headroom is cheap
  // (you pay for tokens emitted, not for the cap); truncation is not.
  maxTokens: 16000,
  maxTokensRecipe: 32000,
  concurrency: 4,
  // Panel judging: two non-conflicted seats score each answer (a judge never
  // scores its own provider). Seat rotation is deterministic — see panelSeats.
  judgeModel: 'panel-v1',
  // Panel refreshed 2026-07-29, and the refresh is deliberately conservative.
  //
  // The problem being fixed is real: over the 244 answers scored by both,
  // qwen3.5-plus marginalised at 96.20 against gpt-5.5's 88.16 on the SAME
  // answers, and it was much the cheapest seat ($0.30/$1.80). It was the
  // lenient outlier.
  //
  // The obvious fix — jump every seat to the current generation — was tried
  // and the calibration gate rejected it. gpt-5.6-sol-pro posted MAE 12.9,
  // scoring a deliberately-wrong anchor 70 where the hand-score is 30 (too
  // soft on confidently bad advice) while zeroing another where the hand-score
  // is 50 (too harsh): miscalibrated in both directions. claude-opus-5 came in
  // at MAE 6.5 but missed a band. Newer is not automatically better calibrated.
  //
  // grok-4.5 passed cleanly at MAE 5.6 — the best of the new seats — so it
  // takes Qwen's place, and the two seats with a passing record stay.
  judgePanel: [
    'anthropic/claude-opus-4.8',
    'openai/gpt-5.5',
    'x-ai/grok-4.5',
  ],
  methodologyVersion: 'v2',
};

/**
 * Empty, filtered or provider-errored completions are transport noise, not
 * skill — retried, then marked.
 *
 * OpenRouter surfaces a mid-stream provider failure as HTTP 200 with
 * `finish_reason: "error"` and whatever text arrived before the failure, so
 * `res.ok` is true and the text is non-empty. Run 2026-06-v2 published
 * claude-opus-4.8 × safe-021 — four tokens, cut off mid-word, provider
 * "overloaded_error" — as a real 50/100 with incidents: 0.
 */
function isTransportFailure(result: {
  text: string;
  finishReason?: string;
  raw?: unknown;
}): boolean {
  if (result.text.trim() === '') return true;
  if (result.finishReason === 'content_filter' || result.finishReason === 'error') return true;
  const raw = result.raw as
    | { error?: unknown; choices?: Array<{ error?: unknown; finish_reason?: string }> }
    | undefined;
  if (raw?.error) return true;
  const choice = raw?.choices?.[0];
  return Boolean(choice?.error) || choice?.finish_reason === 'error';
}

/**
 * An attempt record is evidence that a provider call may already have been
 * bought. A restart cannot infer from an absent answer whether the request was
 * never sent, was billed and lost, or finished just before the process died.
 * That state requires operator reconciliation; it is never an invitation to
 * spend again automatically.
 */
class AttemptReconciliationRequiredError extends Error {
  readonly code = 'ATTEMPT_RECONCILIATION_REQUIRED';

  constructor(coord: AttemptCoordinate, retryId: string) {
    super(
      `ATTEMPT_RECONCILIATION_REQUIRED: ${coord.modelId} × ${coord.questionId} already has attempt ${retryId} ` +
        `(${coord.cause}). Reconcile the provider charge and attempt record before resuming; ` +
        `no replacement provider call was made.`,
    );
    this.name = 'AttemptReconciliationRequiredError';
  }
}

/** Atomically opens a new attempt and refuses the race if another process won. */
function beginFreshAttempt(coord: AttemptCoordinate) {
  const opened = beginAttempt(coord);
  if (opened.replay) throw new AttemptReconciliationRequiredError(coord, opened.retryId);
  return opened;
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : 'true';
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// RUN-001 — nothing dangerous happens without an approved permit
// ---------------------------------------------------------------------------

/**
 * The methodology revision a permit must have been issued against.
 *
 * The committed sidecar is evidence, not the definition: hash the actual plan
 * bytes and refuse disagreement. Returning the sidecar alone let editing one
 * line redefine which methodology every permit was checked against while the
 * plan itself stayed unchanged.
 */
export function frozenMethodologyHash(): string {
  return permitMethodologyHash();
}

/**
 * Load and verify the permit for a command that spends money or touches live
 * data. Refuses loudly rather than degrading to unauthorised work.
 *
 * The ordering friction is real and deliberate: `estimate` needs `catalog-read`,
 * and sizing a permit's budget wants an estimate. The intended resolution is a
 * cheap `development-probe` permit that grants `catalog-read` and nothing else —
 * it authorises no inference, so it needs no cells and costs nothing to honour.
 */
export function requireGrant(context: string, executingManifest?: unknown): VerifiedGrant {
  const permitPath = arg('permit');
  const manifestPath = arg('manifest');
  if (!permitPath || !manifestPath) {
    fail(
      `${context} requires an approved permit (RUN-001): pass --permit <file> --manifest <file>.\n` +
        `  Permits are Ed25519-signed offline; this process cannot mint one — see data/permits/keys/README.md.\n` +
        `  Execution is deny-by-default, so the absence of a permit is a refusal, not a default.`,
    );
  }
  const resolvedPermit = isAbsolute(permitPath) ? permitPath : join(process.cwd(), permitPath);
  const resolvedManifest = isAbsolute(manifestPath) ? manifestPath : join(process.cwd(), manifestPath);
  if (!existsSync(resolvedManifest)) fail(`No manifest at ${resolvedManifest}.`);
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(resolvedManifest, 'utf8'));
  } catch (e) {
    fail(`Manifest ${resolvedManifest} is not valid JSON (${(e as Error).message}).`);
  }
  try {
    // The caller's file identifies the intended stored run but never becomes
    // the verification envelope. It must match that run byte-for-canonical-
    // byte, including the recorded digest, and the stored object is what the
    // signature verifier receives.
    const storedManifest = resolveStoredManifestClaim(manifest, context);
    const { grant } = verifyPermitFile(resolvedPermit, { manifest: storedManifest });
    // `--manifest` is untrusted bootstrap input. The authority does not leave
    // this function until the verified hash is also the exact manifest stored
    // under the run it will act on (including that run's recorded digest).
    // Every permit-using command comes through this one boundary, so an
    // alternate same-run envelope cannot reach redemption, clients or writes.
    assertGrantMatchesStoredManifest(grant, context, executingManifest);
    // A signed manifest that names HEAD still is not reproducible when the
    // executable/question/methodology bytes in this process are uncommitted.
    // Hold authority here until checkout(manifest.gitCommit) would recreate
    // the relevant working tree exactly.
    assertReproducibleGitIdentity(storedManifest.gitCommit);
    console.log(
      `Permit ${grant.permitId} (${grant.kind}) verified with key '${grant.keyId}' — ` +
        `[${grant.capabilities.join(', ')}], cap $${grant.budgetCapUsd.toFixed(2)}, run ${grant.runId}.`,
    );
    return grant;
  } catch (e) {
    if (e instanceof PermitError || e instanceof ManifestError) {
      fail(`${context} refused — ${e.code}: ${e.message}`);
    }
    throw e;
  }
}

/** What the CLI reports about spend. A mock run spends nothing. */
interface SpendReport {
  readonly settledUsd: number;
  settledByModel(): Record<string, number>;
}
const NO_SPEND: SpendReport = { settledUsd: 0, settledByModel: () => ({}) };

function resolveModelIds(models: ReturnType<typeof loadModels>): string[] {
  const flag = arg('models') ?? 'all';
  if (flag === 'all') return models.filter((m) => m.active).map((m) => m.id);
  const ids = flag.split(',').map((s) => s.trim());
  for (const id of ids) {
    if (!models.some((m) => m.id === id)) fail(`Unknown model id ${id} (not in data/models.yaml)`);
  }
  return ids;
}

async function pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  const runners = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      if (item === undefined) return;
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * A deliberately wrong answer must land at or below this. Set well clear of the
 * partial-credit band a keyword grader hands out for satisfying some synonym
 * groups, so "wrong but mentions the right words" still fails.
 */
const FAILING_ANSWER_CEILING = 40;

/**
 * The laziest answer that still satisfies every required synonym group: one
 * token per group, no sentence around them. If this scores 100 the item is
 * measuring token presence rather than knowledge.
 */
function stuffingAnswerFor(q: Question): string | null {
  const specs =
    q.grader.type === 'keyword'
      ? [q.grader]
      : q.grader.type === 'llm-judge'
        ? (q.grader.constraintChecks ?? []).filter((c) => c.type === 'keyword')
        : [];
  const groups = specs.flatMap((s) => ('required' in s ? (s.required ?? []) : []));
  if (groups.length === 0) return null;
  return `${groups.map((g) => g[0]).join(', ')}.`;
}

/**
 * The canary string every dataset file carries so training-set filters can
 * exclude the benchmark. Nothing verified it until now, which made it
 * decorative: a file could lose its canary in an edit and no one would know.
 */
const CANARY = 'CANARY:cookingbench:';

export function checkCanaries(): string[] {
  const dir = join(DATA_DIR, 'questions');
  const missing: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml'))) {
    if (!readFileSync(join(dir, file), 'utf8').includes(CANARY)) missing.push(file);
  }
  return missing;
}

/** Content words, for the crude overlap check below. */
function contentTokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3),
  );
}

/**
 * Jaccard overlap on prompt content words. Deliberately crude — it is a
 * prompt for a human to look, not a verdict. A candidate that closely
 * resembles an item already demoted to basics will saturate the same way, and
 * an accidental near-duplicate of an active item just splits its signal.
 */
function nearDuplicates(candidate: Question, corpus: Question[]): Array<{ id: string; overlap: number; status: string }> {
  const a = contentTokens(candidate.prompt);
  if (a.size === 0) return [];
  const hits: Array<{ id: string; overlap: number; status: string }> = [];
  for (const other of corpus) {
    if (other.id === candidate.id) continue;
    const b = contentTokens(other.prompt);
    let shared = 0;
    for (const w of a) if (b.has(w)) shared++;
    const overlap = shared / new Set([...a, ...b]).size;
    if (overlap >= 0.5) hits.push({ id: other.id, overlap, status: other.status });
  }
  return hits.sort((x, y) => y.overlap - x.overlap).slice(0, 3);
}


/** Every forbidden list on a question, wherever it hangs. */
function forbiddenTerms(q: Question): string[] {
  if (q.grader.type === 'keyword') return q.grader.forbidden ?? [];
  if (q.grader.type === 'llm-judge') {
    return (q.grader.constraintChecks ?? []).flatMap((check) =>
      check.type === 'keyword' ? (check.forbidden ?? []) : [],
    );
  }
  return [];
}

/**
 * The gold standard has to pass its own test.
 *
 * Run 2026-06-v2 shipped three items whose hand-written referenceAnswer scored
 * 0 against their own grader — each was punished for naming the ingredient it
 * was telling you to avoid, which is what a competent allergy answer does. On
 * subs-020 that zeroed 12 of 13 models, three of them with a perfect judge
 * score. This check makes that class of defect impossible to commit.
 */
function checkReferenceAnswers(questions: Question[]): { problems: string[]; warnings: string[] } {
  const problems: string[] = [];
  const warnings: string[] = [];
  for (const q of questions) {
    let result: { score: number; detail: unknown } | null = null;
    try {
      result = gradeDeterministic(q, q.referenceAnswer);
    } catch (error) {
      problems.push(`${q.id}: grader threw on its own reference answer — ${(error as Error).message}`);
      continue;
    }
    if (result && result.score < 99.99) {
      problems.push(
        `${q.id}: its own referenceAnswer scores ${result.score.toFixed(1)} against its own grader — ` +
          `${JSON.stringify(result.detail).slice(0, 160)}`,
      );
    }

    // The other end of the same test. A reference answer scoring 100 only
    // proves the grader can recognise a right answer; it says nothing about
    // whether the grader can reject a wrong one. Both ends together are a
    // discrimination test that calls no model and costs nothing:
    //
    //   100 / low  → the grader separates right from wrong. Good.
    //   100 / 100  → it credits anything. The item measures nothing.
    //     0 /   0  → it rejects everything (subs-020, as shipped).
    //
    // Only the first is admissible.
    if (q.failingAnswer) {
      let failing: { score: number; detail: unknown } | null = null;
      try {
        failing = gradeDeterministic(q, q.failingAnswer);
      } catch (error) {
        problems.push(`${q.id}: grader threw on its own failingAnswer — ${(error as Error).message}`);
        continue;
      }
      if (failing && failing.score > FAILING_ANSWER_CEILING) {
        problems.push(
          `${q.id}: its failingAnswer scores ${failing.score.toFixed(1)} (needs ≤ ${FAILING_ANSWER_CEILING}) — ` +
            `the grader credits a deliberately wrong answer, so the item cannot discriminate`,
        );
      }
    } else if (result) {
      // Deterministically-graded items can carry this cheaply, so ask for it.
      // Judge-only items have no deterministic component to test.
      warnings.push(`${q.id}: no failingAnswer — the grader is untested against a wrong answer`);
    }

    // Keyword stuffing. A required-synonym group is satisfied by the token
    // appearing anywhere, so an answer that is *only* those tokens — no
    // sentence, no reasoning, no dish — scores full marks. rgen-002 passes on
    // the single word "minute". This is saturation from the grader's side
    // rather than the dataset's: the item is not measuring knowledge, it is
    // measuring whether the model emitted a string that any fluent model will.
    const stuffed = stuffingAnswerFor(q);
    if (stuffed) {
      const r = gradeDeterministic(q, stuffed);
      if (r && r.score >= 99.99) {
        const weight = q.grader.type === 'llm-judge' ? 1 - (q.grader.judgeWeight ?? 0.7) : 1;
        warnings.push(
          `${q.id}: scores 100 on keyword stuffing — "${stuffed.slice(0, 60)}" ` +
            `(worth ${Math.round(weight * 100)}% of the item)`,
        );
      }
    }
    // On a dangerous-premise trap, a forbidden term that is a PHRASE from the
    // user's own claim ("dodged a bullet", "kills everything") is a landmine:
    // the natural correct answer quotes it in order to refute it. Single-word
    // ingredient constraints are fine — "write it without onion" is supposed
    // to name onion — so only multi-word phrases on trap items are flagged.
    if (q.trap) {
      for (const term of forbiddenTerms(q)) {
        if (term.trim().includes(' ') && q.prompt.toLowerCase().includes(term.toLowerCase())) {
          warnings.push(
            `${q.id}: trap forbids the phrase "${term}", which its own prompt asserts — ` +
              `a correct answer quoting it to refute it relies entirely on negation detection`,
          );
        }
      }
    }
  }
  return { problems, warnings };
}

export function cmdValidate() {
  const questions = loadQuestions();
  const models = loadModels();
  const byCategory = new Map<string, number>();
  for (const q of questions) {
    byCategory.set(q.category, (byCategory.get(q.category) ?? 0) + 1);
  }
  console.log(`✓ ${questions.length} questions valid`);
  for (const [category, count] of [...byCategory].sort()) {
    console.log(`    ${category}: ${count}`);
  }
  console.log(`✓ ${models.length} models valid (${models.filter((m) => m.active).length} active)`);

  const missingCanary = checkCanaries();
  if (missingCanary.length > 0) {
    console.error(`\n✗ ${missingCanary.length} dataset file(s) missing the contamination canary:`);
    for (const f of missingCanary) console.error(`    ${f}`);
    fail('Every questions file must carry the canary so training-set filters can exclude it.');
  }
  console.log(`✓ all ${readdirSync(join(DATA_DIR, 'questions')).filter((f) => f.endsWith('.yaml')).length} dataset files carry the canary`);

  const { problems, warnings } = checkReferenceAnswers(questions);
  for (const q of questions) {
    for (const dup of nearDuplicates(q, questions)) {
      if (q.id < dup.id) {
        warnings.push(
          `${q.id} and ${dup.id} share ${Math.round(dup.overlap * 100)}% of their prompt wording (${dup.status})`,
        );
      }
    }
  }
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  if (problems.length > 0) {
    console.error(`\n✗ ${problems.length} grader/dataset problems:`);
    for (const p of problems) console.error(`    ${p}`);
    fail('Dataset validation failed — fix the grader or the item before running.');
  }
  console.log(`✓ ${questions.length} reference answers score 100 against their own graders`);
}

/**
 * The question set for a run or estimate. `--questions id1,id2` targets exact
 * items, which `--limit N` cannot do — it only ever takes the first N, and the
 * demanding items (recipe generation) sort last. Needed to test long-answer
 * headroom on reasoning models without paying for the 130 questions in front.
 */
function selectQuestions(): Question[] {
  const all = runnableQuestions(arg('tier') === 'active' ? 'active' : 'all');
  const ids = arg('questions');
  if (!ids) return all;
  const wanted = ids.split(',').map((i) => i.trim());
  const byId = new Map(all.map((q) => [q.id, q]));
  const missing = wanted.filter((i) => !byId.has(i));
  if (missing.length > 0) fail(`Unknown question id(s): ${missing.join(', ')}`);
  return wanted.map((i) => byId.get(i)!);
}


async function cmdEstimate() {
  const questionsAll = selectQuestions();
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const questions = limit ? questionsAll.slice(0, limit) : questionsAll;
  const models = loadModels();
  const modelIds = resolveModelIds(models);
  console.log(`Estimating worst-case cost for ${modelIds.length} models × ${questions.length} questions…`);
  const record = await runEstimate(requireGrant('estimate'), modelIds, questions, DEFAULTS);
  for (const m of record.perModel) {
    console.log(`    ${m.modelId.padEnd(40)} ${m.calls} calls   $${m.worstCaseUsd.toFixed(2)}`);
  }
  console.log(`\n  TOTAL expected:   $${record.totalExpectedUsd.toFixed(2)}   <- budget against this`);
  console.log(`  TOTAL worst case: $${record.totalWorstCaseUsd.toFixed(2)}   (every call filling its cap; ~8x reality)`);
  console.log('  (Worst case assumes every response uses its full max_tokens — actuals run lower.)');
  console.log(`\n✓ Estimate saved. Valid for 24h. Now run: pnpm bench run --budget <usd>`);
}

async function cmdModelsCheck() {
  const models = loadModels();
  const catalog = await fetchCatalog(requireGrant('models --check'));
  let ok = true;
  for (const m of models) {
    if (catalog.has(m.id)) {
      console.log(`  ✓ ${m.id}${m.active ? '' : ' (inactive)'}`);
    } else {
      // Inactive entries are allowed to be missing (awaiting GA) — warn only.
      if (m.active) ok = false;
      console.log(`  ✗ ${m.id} — NOT in the OpenRouter catalog${m.active ? ' (ACTIVE — fix before running!)' : ' (inactive, ignored)'}`);
      const slug = m.id.split('/')[1] ?? m.id;
      const guesses = [...catalog.keys()].filter((id) => id.includes(slug.split('-')[0] ?? slug));
      if (guesses.length > 0) console.log(`      similar: ${guesses.slice(0, 5).join(', ')}`);
    }
  }
  // Surface recent catalog additions that look flagship-priced and aren't in the roster.
  const known = new Set(models.map((m) => m.id));
  const thirtyDaysAgo = Date.now() / 1000 - 30 * 86400;
  const recent = [...catalog.values()]
    .filter((c) => c.created > thirtyDaysAgo && !known.has(c.id) && c.pricing.completionUsd >= 0.000005)
    .sort((a, b) => b.created - a.created)
    .slice(0, 10);
  if (recent.length > 0) {
    console.log('\n  New flagship-priced models on OpenRouter (last 30 days) not in the roster:');
    for (const c of recent) {
      console.log(`    • ${c.id} (${new Date(c.created * 1000).toISOString().slice(0, 10)})`);
    }
  }
  if (!ok) process.exit(1);
}

/**
 * DATA-002 — the immutable envelope a run executes under.
 *
 * `bench manifest` writes it, and it is written BEFORE anything is executed.
 * Every other command then reads it. The old shape assembled a `RunConfig` from
 * CLI flags and module defaults at the moment of execution, which meant the
 * thing that decided what the run was — models, items, token caps, budget,
 * whether it was a mock — was the command line, and nothing recorded it in a
 * form a permit could be signed against or a verifier could check afterwards.
 */
export function cmdManifest() {
  const runId = arg('run-id') ?? fail('manifest requires --run-id <id>');
  const draftPath = arg('draft');
  const mockDraft = flag('mock');
  if (!draftPath && !mockDraft) {
    fail(
      'manifest requires --draft <file.json> (the envelope to freeze), or --mock to synthesise a development envelope for the offline loop.',
    );
  }
  if (draftPath && mockDraft) fail('Pass either --draft or --mock, not both.');

  const questionsAll = selectQuestions();
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const questions = limit ? questionsAll.slice(0, limit) : questionsAll;

  let draft: unknown;
  if (mockDraft) {
    // A mock run is DEVELOPMENT evidence with MOCK origin, and both are stated
    // in the envelope rather than inferred from a flag at execution time. That
    // is what stops a mock board being mistaken for a result: the class travels
    // with the artifact instead of living in the operator's memory.
    draft = mockDraftManifest(runId, questions);
  } else {
    const resolved = isAbsolute(draftPath!) ? draftPath! : join(process.cwd(), draftPath!);
    if (!existsSync(resolved)) fail(`No manifest draft at ${resolved}.`);
    try {
      draft = JSON.parse(readFileSync(resolved, 'utf8'));
    } catch (e) {
      fail(`${resolved} is not valid JSON (${(e as Error).message}).`);
    }
  }

  try {
    const built = buildRunManifest(draft, questions);
    if (built.manifest.runId !== runId) {
      fail(`Draft names run '${built.manifest.runId}' but --run-id says '${runId}'.`);
    }
    // Kept at the CLI freeze boundary rather than inside buildRunManifest or
    // writeRunManifest: tests and development may calculate envelopes in a
    // dirty worktree, but a production freeze may never record HEAD as the
    // identity of bytes that HEAD does not contain.
    assertReproducibleGitIdentity(built.manifest.gitCommit);
    // Mock envelopes use fixed in-process personas. Every real inference
    // envelope must carry the independently declared provider/base identities
    // from the committed roster; non-empty invented strings are not identity.
    if (!mockDraft) assertManifestRouteIdentityMatchesRoster(built.manifest);
    const written = writeRunManifest(runId, built.manifest, questions);
    console.log(
      `${written.written ? '✓ Manifest written' : '✓ Manifest already present and identical'} for ${runId}: ` +
        `${written.manifestHash.slice(0, 16)}… (${questions.length} items, class '${built.manifest.evidenceClass}').`,
    );
    console.log(`  bank ${built.digest.bankHash.slice(0, 12)}…  prompt ${built.digest.promptHash.slice(0, 12)}…`);
    console.log(
      `  judge ${built.digest.judgePromptHash.slice(0, 12)}…  validator ${built.digest.validatorHash.slice(0, 12)}… ` +
        `(${built.digest.validatorFiles.length} result-changing sources)`,
    );
    console.log(`Next: pnpm bench run --run-id ${runId}`);
  } catch (e) {
    if (e instanceof ManifestError) fail(`${e.code}: ${e.message}`);
    throw e;
  }
}

/** The offline development envelope. Never rank-eligible, never publishable. */
function mockDraftManifest(runId: string, questions: Question[]): Record<string, unknown> {
  return {
    manifestVersion: 1,
    runId,
    methodologyVersion: DEFAULTS.methodologyVersion,
    schemaVersion: '1',
    parentArtifacts: [],
    evidenceClass: 'development',
    artifactOrigin: ['mock'],
    releaseState: 'draft',
    rankEligible: false,
    candidateRoutes: MOCK_MODELS.map((m) => ({
      modelId: m.id,
      provider: m.provider,
      // The mock roster declares no family. JUDGE-001 treats a missing identity
      // as conflicted, so the id stands in — distinct per persona, and never
      // silently shared.
      baseModelFamily: m.id,
    })),
    judgeRoutes: [{ modelId: 'mock-judge', provider: 'mock', baseModelFamily: 'mock' }],
    generationSettings: {
      temperature: DEFAULTS.temperature,
      maxTokens: DEFAULTS.maxTokens,
      maxTokensRecipe: DEFAULTS.maxTokensRecipe,
      repeats: 1,
      repeatPolicy: 'single',
    },
    callPlan: { concurrency: DEFAULTS.concurrency, maxAttempts: 3, abortOn: [] },
    budgetCapUsd: 0,
    itemCount: questions.length,
  };
}

export async function cmdRun() {
  const runId =
    arg('run-id') ??
    fail(
      'run requires --run-id <id>, and that run must already carry a manifest.\n' +
        '  Create one first: pnpm bench manifest --run-id <id> --draft <file.json> (or --mock).\n' +
        '  A run assembled from flags at execution time is not an execution envelope (DATA-002).',
    );

  // The envelope, read before anything else. Absence is a refusal: there is no
  // path from "no manifest" to "run it anyway".
  let manifest: ReturnType<typeof readRunManifest>;
  let itemIds: string[];
  try {
    manifest = readRunManifest(runId);
    itemIds = readRunDigest(runId).itemIds;
    // Whatever is already in the directory has to be the manifested run before
    // more of it is bought. Completeness is not required — this is mid-run.
    assertRunArtifactsMatchManifest(runId);
  } catch (e) {
    if (e instanceof ManifestError) {
      fail(`${e.code}: ${e.message}`);
    }
    throw e;
  }

  const byId = new Map(loadQuestions().map((q) => [q.id, q]));
  const missing = itemIds.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    fail(`${missing.length} manifested item(s) are no longer in the dataset: ${missing.slice(0, 5).join(', ')}.`);
  }
  const questions = itemIds.map((id) => byId.get(id)!);
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const settings = {
    maxTokens: manifest.generationSettings.maxTokens,
    maxTokensRecipe: manifest.generationSettings.maxTokensRecipe,
  };
  const concurrency = manifest.callPlan.concurrency;
  // Mock-ness is a property of the ENVELOPE, not of the invocation. A flag on
  // the command line could turn a paid run into a free one after the fact and
  // leave no trace; the manifest's declared origin cannot.
  const mock = manifest.artifactOrigin.includes('mock');
  const modelIds = manifest.candidateRoutes.map((r) => r.modelId);

  // WP-0 proves the evidence boundary and the offline harness. It deliberately
  // does not authorise real provider execution: the current paid runner has
  // nested retry layers that are not yet fully expressed by, or durably
  // recoverable from, the signed manifest. Pretending that work is covered by
  // the WP-0 permit would turn a green boundary test into a false methodology
  // claim. Real candidate calls return only after the protocol-safe runner
  // introduces manifest-bound provider-attempt identities and write-ahead
  // recovery in the later runner work package.
  if (!mock) {
    fail(
      'PAID_INFERENCE_NOT_READY: WP-0 permits offline/mock execution only. ' +
        'Real candidate inference remains disabled until the protocol-safe runner binds every billable attempt and retry to the manifest.',
    );
  }

  // A task with an attempt record but no stored response is not resume-safe:
  // the provider may already have charged for work whose answer was lost. Do
  // this read-only reconciliation gate before permit redemption, client
  // construction or config writes. The atomic check at beginFreshAttempt below
  // closes the remaining race between this preflight and the actual request.
  const tasks: Array<{ modelId: string; question: Question }> = [];
  for (const modelId of modelIds) {
    for (const question of questions) {
      if (hasResponse(runId, modelId, question.id)) continue;
      tasks.push({ modelId, question });
    }
  }
  const pendingCells = new Set(tasks.map(({ modelId, question }) => `${modelId}\u0000${question.id}`));
  const ambiguousAttempt = readAttempts(runId).find((attempt) =>
    pendingCells.has(`${attempt.modelId}\u0000${attempt.questionId}`),
  );
  if (ambiguousAttempt) {
    fail(
      new AttemptReconciliationRequiredError(ambiguousAttempt, ambiguousAttempt.retryId).message,
    );
  }

  let client: CompletionClient;
  let spend: SpendReport = NO_SPEND;
  let ledger: ReservationLedger | null = null;

  if (mock) {
    client = new MockClient(questionsById);
  } else {
    const requested = Number(arg('budget') ?? manifest.budgetCapUsd);
    if (!Number.isFinite(requested) || requested < 0) fail('--budget must be a finite non-negative number.');
    if (requested > manifest.budgetCapUsd) {
      fail(
        `--budget $${requested.toFixed(2)} exceeds the manifest's approved cap of $${manifest.budgetCapUsd.toFixed(2)}. ` +
          `An operator may lower the ceiling, never raise it.`,
      );
    }
    const totalBudget = requested;
    const perModelBudget = Number(arg('per-model-budget') ?? (totalBudget / modelIds.length) * 2);
    if (!Number.isFinite(perModelBudget) || perModelBudget < 0) {
      fail('--per-model-budget must be a finite non-negative number.');
    }
    // The guard checks a per-call worst case before every call, so a per-model
    // cap below that worst case refuses every call — and the run then reports
    // "✓ Run complete: 0 responses stored" as though it had succeeded. With a
    // 14-model roster and --budget 2.00 the default cap lands at $0.29 against
    // a ~$0.40 per-call ceiling, and the whole run silently does nothing.
    const perCallCeiling =
      (Math.max(...questions.map((q) => buildMessages(q).reduce((n, m) => n + m.content.length, 0))) / 4) *
        0.00001 +
      Math.max(settings.maxTokens, settings.maxTokensRecipe) * 0.00005;
    if (perModelBudget < perCallCeiling) {
      fail(
        `Per-model budget $${perModelBudget.toFixed(2)} is below the worst case for a single call ` +
          `($${perCallCeiling.toFixed(2)}), so every call would be refused before it was made. ` +
          `Raise --budget to at least $${(perCallCeiling * modelIds.length / 2).toFixed(2)} for ${modelIds.length} models, ` +
          `or set --per-model-budget explicitly.`,
      );
    }
    const grant = requireGrant('run', manifest);
    try {
      assertManifestRouteIdentityMatchesRoster(manifest);
    } catch (error) {
      if (error instanceof ManifestError) fail(`${error.code}: ${error.message}`);
      throw error;
    }
    // RELEASE-002 point 6: requested, permit, manifest and artifact ids must be
    // the same id. Checked before any catalogue request or permit redemption,
    // so a mistyped flag neither leaks the planned roster nor burns approval.
    try {
      assertRunIdentity(
        { requested: runId, permit: grant.runId, manifest: manifest.runId, artifact: runId },
        `bench run (permit ${grant.permitId})`,
      );
    } catch (e) {
      fail((e as Error).message);
    }
    // Estimated against the MANIFEST's caps and item set, so the gate covers the
    // work that will actually be done rather than the flags that were typed.
    // The saved record is not trusted to report its own cost: it is recomputed
    // against live catalogue pricing under this same verified grant. A run
    // permit therefore needs `catalog-read` as well as candidate inference.
    const estimate = await assertFreshEstimate(grant, modelIds, questions, settings);
    console.log(
      `Estimate on file: expected $${estimate.totalExpectedUsd.toFixed(2)} | worst case $${estimate.totalWorstCaseUsd.toFixed(2)} | hard cap $${totalBudget.toFixed(2)}`,
    );
    // Gate on the EXPECTED cost, not the worst case. Worst case assumes every
    // call fills its max_tokens; with the recipe cap at 32k that is roughly 8x
    // what models actually emit, and gating on it would demand --budget 343 for
    // a batch that really costs about $8 — which makes the cap meaningless.
    // The reservation ledger still enforces the hard ceiling against ACTUAL
    // spend at runtime, so an underestimate costs an early abort, not an
    // overspend.
    if (estimate.totalExpectedUsd > totalBudget) {
      fail(
        `Expected cost ($${estimate.totalExpectedUsd.toFixed(2)}) exceeds the budget cap ($${totalBudget.toFixed(2)}). Raise --budget or trim models/questions.`,
      );
    }
    if (estimate.totalWorstCaseUsd > totalBudget) {
      console.warn(
        `⚠ Worst case ($${estimate.totalWorstCaseUsd.toFixed(2)}) exceeds the cap ($${totalBudget.toFixed(2)}). ` +
          `Expected is $${estimate.totalExpectedUsd.toFixed(2)}; the run will abort gracefully if actual spend reaches the cap.`,
      );
    }
    // Point of no return: consume a use of the permit. Deliberately after the
    // run-id check above, so a mistyped flag does not burn an approval.
    const redemption = redeemPermit(grant, 'bench run');
    console.log(`Permit redemption ${redemption.sequence}/${grant.executionLimit}.`);
    // TRACE-001: the approval goes into the RUN, not only into the redemption
    // record beside the permit. An artifact whose trail lives in another
    // directory is traceable only by someone who already knows to look.
    recordProvenance(runId, grant, 'bench run');
    // The permit's cap is the approved ceiling; --budget may only lower it.
    ledger = ReservationLedger.forGrant(grant, runId, {
      totalCapUsd: totalBudget,
      perModelCapUsd: perModelBudget,
    });
    client = OpenRouterClient.forCandidates(grant, ledger);
    spend = ledger;
    if (ledger.settledUsd > 0) {
      console.log(`Resuming: $${ledger.settledUsd.toFixed(4)} already spent on this run (from spend.ndjson).`);
    }
  }

  const batchBudget = mock ? 0 : Math.min(Number(arg('budget') ?? manifest.budgetCapUsd), manifest.budgetCapUsd);
  // config.json is now a PROJECTION of the manifest, not a source of truth. It
  // stays because store.ts, the site and the published artifacts all read it;
  // every rank-affecting field in it is copied from the envelope rather than
  // from a flag, so the two can never disagree about what was run.
  const config: RunConfig = {
    runId,
    models: modelIds,
    temperature: manifest.generationSettings.temperature,
    maxTokens: settings.maxTokens,
    maxTokensRecipe: settings.maxTokensRecipe,
    budgetUsdTotal: batchBudget,
    budgetUsdPerModel: mock ? 0 : Number(arg('per-model-budget') ?? 0),
    concurrency,
    judgeModel: DEFAULTS.judgeModel,
    judgePanel: manifest.judgeRoutes.map((r) => r.modelId),
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    methodologyVersion: manifest.methodologyVersion,
    mock,
    batches: [
      {
        startedAt: new Date().toISOString(),
        models: modelIds,
        maxTokens: settings.maxTokens,
        maxTokensRecipe: settings.maxTokensRecipe,
        budgetUsdTotal: batchBudget,
      },
    ],
  };
  // Merge, don't replace: a run is assembled from per-model batches, and the
  // published config has to describe all of them.
  mergeRunConfig(config);

  console.log(`Run ${runId}: ${tasks.length} calls to make (${modelIds.length} models × ${questions.length} questions, resume-aware)`);

  let done = 0;
  const failures: string[] = [];
  const haltedModels = new Set<string>();
  const reconciliation = { required: null as AttemptReconciliationRequiredError | null };
  await pool(tasks, concurrency, async ({ modelId, question }) => {
    if (haltedModels.has(modelId)) return;
    const maxTokens = maxTokensFor(question, settings);
    let activeAttempt: { coord: AttemptCoordinate; retryId: string } | null = null;
    try {
      // Worst-case for the next call at flagship pricing ($10/$50 per Mtok upper bound).
      const promptChars = buildMessages(question).reduce((n, m) => n + m.content.length, 0);
      const worstCase = (promptChars / 4) * 0.00001 + maxTokens * 0.00005;
      // The reservation and the settlement both happen inside the client now,
      // in one atomic step around the call — the old check-then-record pair let
      // four concurrent calls each pass a check none of them had yet debited.
      // RUN-002. Every billable attempt gets a durable, derived record before
      // the money is spent, so a charge can always be attributed to the exact
      // coordinate and cause that incurred it.
      //
      // Stored answers are idempotent, but an intermediate attempt is
      // ambiguous: a process can die after the provider charge and before the
      // response write. A replay therefore REFUSES instead of buying a second
      // answer. Human reconciliation must decide what happened to the first.
      const attempt = (cause: AttemptCause) => ({ runId, modelId, questionId: question.id, cause });
      const initialAttempt = attempt('initial');
      const initialOpened = beginFreshAttempt(initialAttempt);
      activeAttempt = { coord: initialAttempt, retryId: initialOpened.retryId };
      let result = await client.complete(modelId, buildMessages(question), {
        temperature: manifest.generationSettings.temperature,
        maxTokens,
        reasoning: { effort: 'medium' },
        cell: { modelId, questionId: question.id },
        estimateUsd: worstCase,
      });
      settleAttempt(initialAttempt, { costUsd: result.costUsd });
      activeAttempt = null;
      let totalCost = result.costUsd;
      // Empty/filtered completions are transport noise — retry before storing,
      // with extra token headroom on the second retry.
      for (let retry = 0; retry < 2 && isTransportFailure(result) && !mock; retry++) {
        // The two retries are DIFFERENT causes, so they derive different ids and
        // one cannot be mistaken for a replay of the other.
        const cause: AttemptCause = retry === 0 ? 'empty-response' : 'empty-response-headroom';
        const retryAttempt = attempt(cause);
        const retryOpened = beginFreshAttempt(retryAttempt);
        activeAttempt = { coord: retryAttempt, retryId: retryOpened.retryId };
        result = await client.complete(modelId, buildMessages(question), {
          temperature: manifest.generationSettings.temperature,
          maxTokens: retry === 0 ? maxTokens : maxTokens * 2,
          reasoning: { effort: 'medium' },
          cell: { modelId, questionId: question.id },
          estimateUsd: worstCase,
        });
        settleAttempt(retryAttempt, { costUsd: result.costUsd });
        activeAttempt = null;
        totalCost += result.costUsd;
      }
      const stored: StoredResponse = {
        runId,
        modelId,
        questionId: question.id,
        answerText: result.text,
        raw: result.raw,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: totalCost,
        latencyMs: result.latencyMs,
        finishReason: result.finishReason,
        ...(isTransportFailure(result) ? { transportFailure: true } : {}),
      };
      writeResponse(stored);
      // The append-only record, alongside the response file rather than instead
      // of it. Idempotent on the response identity, so a resumed or retried run
      // adds nothing; without this write the run has no tamper-evident record of
      // its own evidence and can never satisfy the release checklist.
      appendRawAnswer(stored);
      done++;
      if (done % 20 === 0) {
        console.log(`  ${done}/${tasks.length} done — spent $${spend.settledUsd.toFixed(4)}`);
      }
    } catch (error) {
      if (error instanceof AttemptReconciliationRequiredError) {
        reconciliation.required ??= error;
        for (const id of modelIds) haltedModels.add(id);
        console.error(`  ✗ ${error.message}`);
        return;
      }
      // A provider-path error after the durable open but before settlement is
      // itself the ambiguous state the journal exists to expose. Stop the run;
      // continuing would buy unrelated work while a possibly billed request is
      // unresolved, and a blind restart would try this cell again.
      if (activeAttempt) {
        const errorForReconciliation = new AttemptReconciliationRequiredError(
          activeAttempt.coord,
          activeAttempt.retryId,
        );
        reconciliation.required ??= errorForReconciliation;
        for (const id of modelIds) haltedModels.add(id);
        console.error(`  ✗ ${errorForReconciliation.message} Cause: ${(error as Error).message}`);
        return;
      }
      if (error instanceof BudgetExceededError) {
        if (error.scope === 'total') {
          haltedModels.add(modelId);
          for (const id of modelIds) haltedModels.add(id);
          console.error(`  ⚠ ${error.message}`);
        } else {
          haltedModels.add(modelId);
          console.error(`  ⚠ ${error.message}`);
        }
        return;
      }
      failures.push(`${modelId} × ${question.id}: ${(error as Error).message}`);
    }
  });

  // Release before any exit path, including the failure below. A leaked lock
  // is recoverable — the next runner takes over a lock whose holder is gone —
  // but leaving one on a clean exit would make that recovery routine rather
  // than exceptional.
  ledger?.close();
  if (reconciliation.required) fail(reconciliation.required.message);
  if (done === 0 && tasks.length > 0) {
    fail(
      `No responses were stored despite ${tasks.length} task(s) queued — the run did nothing. ` +
        `Check the budget warnings above rather than treating this as a completed run.`,
    );
  }
  console.log(`\n✓ Run complete: ${done} responses stored, total spend $${spend.settledUsd.toFixed(4)}`);
  if (failures.length > 0) {
    console.error(`✗ ${failures.length} failures (re-run the same command to retry just these):`);
    for (const f of failures.slice(0, 10)) console.error(`    ${f}`);
  }
  console.log(`Next: pnpm bench grade --run ${runId}`);
}

/**
 * DATA-002 point 2 — nothing downstream of a run reads it without first
 * checking that what is stored is what the manifest declares.
 *
 * `grade`, `judge`, `report` and `analyze` all previously read `responses/` and
 * `scores.json` straight off disk. A bank edited after the answers were bought,
 * a grader changed underneath the scores, a response copied in from another
 * run: none of it was visible, and all of it changes the published numbers.
 *
 * `expectComplete` is false here on purpose. These commands run mid-pipeline;
 * requiring every cell would make `grade` impossible to run on a partial batch.
 * The release gate is where completeness is demanded, and it does not take the
 * question from a caller.
 */
function requireManifestedRun(runId: string, command: string): ReturnType<typeof readRunManifest> {
  try {
    const manifest = readRunManifest(runId);
    assertRunArtifactsMatchManifest(runId);
    assertRunIdentity(
      { requested: runId, permit: runId, manifest: manifest.runId, artifact: runId },
      `bench ${command}`,
    );
    return manifest;
  } catch (e) {
    if (e instanceof ManifestError) {
      fail(`${command} refused — ${e.code}: ${e.message}`);
    }
    throw e;
  }
}

/**
 * The single call site shape for RELEASE-002's runtime publication validation.
 *
 * A thin wrapper so every command reports a refusal the same way — the gate
 * itself lives in lifecycle.ts, takes no options that could weaken it, and
 * re-reads and re-parses the manifest rather than accepting one.
 */
function requirePublicationVerdict(
  stage: 'artifact' | 'public',
  runId: string,
  command: string,
  grant?: VerifiedGrant,
): ReturnType<typeof assertPublicationAllowed> {
  try {
    return assertPublicationAllowed(stage, { requestedRunId: runId, grant });
  } catch (e) {
    fail(`${command} refused — ${(e as Error).message}`);
  }
}

function cmdGrade() {
  const runId = arg('run') ?? fail('grade requires --run <id>');
  requireManifestedRun(runId, 'grade');
  const questions = loadQuestions();
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const responses = readResponses(runId);
  if (responses.length === 0) fail(`No responses found for run ${runId}`);

  const existing = readScores(runId);
  const scores: Score[] = [];
  let judgePending = 0;
  for (const r of responses) {
    const question = questionsById.get(r.questionId);
    if (!question) continue;
    const deterministic = gradeDeterministic(question, r.answerText);
    if (question.grader.type !== 'llm-judge') {
      scores.push({
        runId,
        modelId: r.modelId,
        questionId: r.questionId,
        score: deterministic!.score,
        graderType: question.grader.type,
        detail: deterministic!.detail,
      });
    } else {
      // Preserve a judge score if this pair was already judged.
      const prior = existing.find(
        (s) => s.modelId === r.modelId && s.questionId === r.questionId && s.judgeModel,
      );
      if (prior) {
        scores.push(prior);
      } else {
        judgePending++;
        scores.push({
          runId,
          modelId: r.modelId,
          questionId: r.questionId,
          score: deterministic?.score ?? 0,
          graderType: 'llm-judge',
          detail: {
            judgePending: true,
            constraintScore: deterministic?.score ?? null,
            constraintDetail: deterministic?.detail ?? null,
          },
        });
      }
    }
  }
  writeScores(runId, scores);
  const gradedCount = scores.length - judgePending;
  console.log(`✓ ${gradedCount} responses graded deterministically, ${judgePending} awaiting the judge`);
  if (judgePending > 0) console.log(`Next: pnpm bench judge --run ${runId}`);
  else console.log(`Next: pnpm bench report --run ${runId}`);
}

export async function cmdJudge() {
  const runId = arg('run') ?? fail('judge requires --run <id>');
  const runManifest = requireManifestedRun(runId, 'judge');
  const config = requireRunConfig(runId, 'judge');
  // As with candidate execution, mock-ness belongs to the immutable envelope;
  // config.json and command-line flags cannot opt a run into or out of network
  // execution. WP-0 closes the offline evidence boundary, while real judging
  // waits for the later manifest-bound provider-attempt protocol.
  const mock = runManifest.artifactOrigin.includes('mock');
  if (!mock) {
    fail(
      'PAID_INFERENCE_NOT_READY: WP-0 permits offline/mock judging only. ' +
        'Real judge calls remain disabled until every seat, repeat, retry and billable attempt is manifest-bound and restart-safe.',
    );
  }
  const questions = loadQuestions();
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const responses = readResponses(runId);
  const scores = readScores(runId);
  if (scores.length === 0) fail(`No scores for run ${runId} — run \`pnpm bench grade --run ${runId}\` first`);

  const pending = scores.filter((s) => (s.detail as { judgePending?: boolean }).judgePending);
  if (pending.length === 0) {
    console.log('✓ Nothing pending for the judge.');
    return;
  }
  // Judging is the expensive half of the pipeline — three flagship seats per
  // answer, up to three calls per seat on a parse failure — and until v2 it was
  // the half with no cap and no cost recording at all. Roughly $29 of the ~$56
  // spent across both published runs never appeared in any artifact.
  //
  // The cap is settled BEFORE the client exists, because the calibration gate
  // below already makes paid calls and must be inside the same ledger.
  const judgeBudget = Number(arg('budget') ?? NaN);
  if (!mock && !Number.isFinite(judgeBudget)) {
    fail(
      `Judging ${pending.length} answers needs a cap: pass --budget <usd>. ` +
        `Rough worst case is ${pending.length * 3} seat calls (3× that if seats return unparseable output).`,
    );
  }

  // Judging is paid work: it needs its own capability, its own reservation
  // ledger and the same cell authorisation candidate calls get.
  const judgeGrant = mock ? null : requireGrant('judge', runManifest);
  if (judgeGrant) {
    try {
      assertManifestRouteIdentityMatchesRoster(runManifest);
    } catch (error) {
      if (error instanceof ManifestError) fail(`${error.code}: ${error.message}`);
      throw error;
    }
  }
  if (judgeGrant && judgeGrant.runId !== runId) {
    fail(`Permit ${judgeGrant.permitId} authorises run '${judgeGrant.runId}', not '${runId}'.`);
  }
  if (judgeGrant) {
    const redemption = redeemPermit(judgeGrant, 'bench judge');
    console.log(`Permit redemption ${redemption.sequence}/${judgeGrant.executionLimit}.`);
    // A judging pass is a separate authorisation from the candidate run, so it
    // appends its own line rather than replacing the run's.
    recordProvenance(runId, judgeGrant, 'bench judge');
  }
  const judgeLedger = judgeGrant
    ? ReservationLedger.forGrant(judgeGrant, runId, { totalCapUsd: judgeBudget })
    : null;
  const client = judgeGrant && judgeLedger ? OpenRouterClient.forJudging(judgeGrant, judgeLedger) : null;
  const judgeSpend: SpendReport = judgeLedger ?? NO_SPEND;
  // JUDGE-001. Conflict identity comes from the declared roster, not from the
  // slug prefix, and a model missing from the roster conflicts with everything
  // rather than being waved through as distinct.
  const judgeIdentity = identityIndex(
    [...runManifest.candidateRoutes, ...runManifest.judgeRoutes].map((route) => ({
      id: route.modelId,
      provider: route.provider,
      baseModel: route.baseModelFamily,
    })),
  );

  // The judging configuration of record. Written AFTER the calibration gate,
  // and unconditionally, because both details were wrong before: the write was
  // skipped whenever judgePanel was already set, and it happened before
  // calibration. A panel that failed the gate therefore stayed recorded as the
  // panel of record while a different one did the judging — canary3 was
  // stamped opus-5/gpt-5.6-sol-pro/grok-4.5 after that panel was rejected.
  // The panel comes from the MANIFEST, not from a module default. `DEFAULTS`
  // is what a new manifest is drafted from; once an envelope is frozen, the
  // seats it declares are the seats that judge it, or the run refuses. A
  // default that drifted after the manifest was signed would re-seat the panel
  // silently, and a re-seated panel measured 96.20 against 88.16 on the same
  // answers.
  const judgePanel = runManifest.judgeRoutes.map((r) => r.modelId);
  if (judgePanel.length === 0) {
    fail(`Run ${runId}'s manifest declares no judge routes, so there is no panel to judge with.`);
  }

  // Judge calibration gate: every panel seat must independently reproduce the
  // hand-scored anchors before any paid judging is accepted for this run.
  if (!mock) {
    const { readCalibration, runCalibration } = await import('./calibration.js');
    const prior = readCalibration(runId);
    if (
      prior?.passed &&
      JSON.stringify(prior.judgePanel) === JSON.stringify(judgePanel) &&
      prior.judgePromptVersion === JUDGE_PROMPT_VERSION
    ) {
      console.log(`✓ Calibration gate already passed (worst per-judge MAE ${prior.mae}).`);
    } else {
      console.log(`Calibrating panel [${judgePanel.join(', ')}] against hand-scored anchors…`);
      const calibration = await runCalibration(
        client!,
        config.judgeModel,
        judgePanel,
        JUDGE_PROMPT_VERSION,
        runId,
        questionsById,
      );
      for (const judge of calibration.judges) {
        console.log(`  ${judge.passed ? '✓' : '✗'} ${judge.judgeModel} — MAE ${judge.mae} (limit 10)`);
        for (const a of judge.anchors.filter((x) => !x.pass)) {
          console.log(`      ✗ ${a.questionId} expected ${a.expected} got ${a.got}  ${a.note ?? ''}`);
        }
      }
      if (!calibration.passed) {
        fail('A panel judge failed the calibration gate — fix the judge/prompt/anchors before judging.');
      }
      console.log('✓ Calibration gate passed for all panel seats.');
    }
  }
  if (!mock) {
    config.judgeModel = DEFAULTS.judgeModel;
    config.judgePanel = judgePanel;
    config.judgePromptVersion = JUDGE_PROMPT_VERSION;
    writeRunConfig(config);
  }


  console.log(`Judging ${pending.length} answers with panel [${judgePanel.join(', ')}] (${config.judgePromptVersion})…`);
  let flagged = 0;
  let emptyAnswers = 0;
  let done = 0;
  const judgeFailures: string[] = [];
  // Scores were written once, after the whole pool resolved: one Ctrl-C at 90%
  // discarded every paid verdict in the batch. Checkpoint as we go.
  const checkpoint = () => writeScores(runId, scores);
  try {
  await pool(pending, DEFAULTS.concurrency, async (s) => {
    const question = questionsById.get(s.questionId)!;
    const response = responses.find(
      (r) => r.modelId === s.modelId && r.questionId === s.questionId,
    )!;
    const detail = s.detail as { constraintScore: number | null; constraintDetail: unknown };
    // An empty answer is a non-answer, not a bad answer. Handing '' to the
    // panel makes deduction grading count "produced nothing" as a single
    // critical mistake — 100 − 40 = 60, blended to 42 — so a model that
    // returned zero characters outscored several that genuinely tried. Score
    // it 0 here and skip the paid call. (Deterministic graders already give 0
    // for empty text, so only judged items were affected.)
    if (!response.answerText.trim()) {
      s.score = 0;
      s.judgeModel = undefined;
      s.detail = {
        judgePending: false,
        judgeScore: 0,
        emptyAnswer: true,
        transportFailure: response.transportFailure ?? false,
        finishReason: response.finishReason ?? null,
        constraintScore: detail.constraintScore,
        constraintDetail: detail.constraintDetail,
      };
      emptyAnswers++;
      return;
    }
    let judgeScore: number;
    let judgeDetail: Record<string, unknown>;
    if (mock) {
      judgeScore = mockJudgeScore(s.modelId, question);
      judgeDetail = { mockJudge: true };
    } else {
      let verdict: Awaited<ReturnType<typeof judgeAnswerPanel>>;
      // Reservation and settlement now happen per seat call inside the client,
      // so there is no check-then-record window here at all. The spend object
      // is still shared with the panel so a seat that fails after two paid
      // retries still reports what it burned into the verdict detail.
      const spend = { costUsd: 0 };
      try {
        verdict = await judgeAnswerPanel(
          client!,
          judgePanel,
          s.modelId,
          question,
          response.answerText,
          judgeIdentity,
          spend,
        );
      } catch (error) {
        // One unjudgeable answer must not sink the batch — it stays
        // judgePending and the next `bench judge` retries just these.
        judgeFailures.push(`${s.modelId} × ${s.questionId}: ${(error as Error).message.slice(0, 120)}`);
        return;
      }
      judgeScore = verdict.score;
      judgeDetail = {
        judges: verdict.judges,
        findings: verdict.findings,
        summary: verdict.summary,
        verdicts: verdict.verdicts,
        disagreement: verdict.disagreement,
        flagged: verdict.flagged,
        judgeCostUsd: verdict.costUsd,
      };
      if (verdict.flagged) flagged++;
      // One ballot per seat, append-only and idempotent on the seat's identity.
      // The mean is what reaches scores.json; the individual verdicts are the
      // evidence behind it, and until now they existed only inside a detail blob
      // that a re-judge would overwrite.
      for (const seat of verdict.verdicts) {
        appendBallot(
          {
            runId,
            modelId: s.modelId,
            questionId: s.questionId,
            judgeModelId: seat.judgeModel,
            promptVersion: JUDGE_PROMPT_VERSION,
          },
          seat,
        );
      }
    }
    s.score = blendJudgeScore(question, judgeScore, detail.constraintScore);
    s.judgeModel = mock
      ? 'mock-judge'
      : ((judgeDetail as { judges?: string[] }).judges?.join('+') ?? config.judgeModel);
    s.detail = {
      judgePending: false,
      judgeScore,
      constraintScore: detail.constraintScore,
      constraintDetail: detail.constraintDetail,
      ...judgeDetail,
    };
    if (++done % 25 === 0) {
      checkpoint();
      console.log(`  ${done}/${pending.length} judged — spent $${judgeSpend.settledUsd.toFixed(4)}`);
    }
  });
  } finally {
    // Whatever happened — budget abort, provider outage, Ctrl-C landing on the
    // event loop — the verdicts already paid for are on disk.
    checkpoint();
  }
  if (!mock) {
    config.judgeCostUsd = Math.round(judgeSpend.settledUsd * 10000) / 10000;
    writeRunConfig(config);
    console.log(`  judge spend this pass: $${judgeSpend.settledUsd.toFixed(4)}`);
    judgeLedger?.close();
  }
  const judgedCount = pending.length - judgeFailures.length - emptyAnswers;
  console.log(`✓ Judged ${judgedCount} answers${flagged > 0 ? ` (${flagged} flagged for manual review)` : ''}`);
  if (emptyAnswers > 0) {
    console.log(`  ${emptyAnswers} empty answers scored 0 without a judge call (transport noise, not skill)`);
  }
  if (judgeFailures.length > 0) {
    console.error(`✗ ${judgeFailures.length} answers could not be judged (re-run \`bench judge\` to retry):`);
    for (const f of judgeFailures.slice(0, 10)) console.error(`    ${f}`);
  }
  console.log(`Next: pnpm bench report --run ${runId}`);
}

/** A run's config, with a refusal rather than a raw ENOENT when it has none. */
function requireRunConfig(runId: string, command: string): ReturnType<typeof readRunConfig> {
  if (!existsSync(join(RUNS_DIR, runId, 'config.json'))) {
    fail(`${command} needs data/runs/${runId}/config.json, which does not exist — has the run been executed?`);
  }
  return readRunConfig(runId);
}

function cmdReport() {
  const runId = arg('run') ?? fail('report requires --run <id>');
  const reportManifest = requireManifestedRun(runId, 'report');
  const reportGrant =
    reportManifest.evidenceClass === 'public-release'
      ? requireGrant('report', reportManifest)
      : undefined;
  // RELEASE-002 point 5. Writing a board is an artifact write, not a
  // publication — a draft has to be able to produce the board its own review
  // reads — but it goes through the same gate, and the class it returns is
  // STAMPED on the board so no reader can mistake a development artifact for a
  // result. Nothing called this before; the capability was checked and the
  // artifact never was.
  const verdict = requirePublicationVerdict('artifact', runId, 'report', reportGrant);
  const config = requireRunConfig(runId, 'report');
  const questions = loadQuestions();
  const responses = readResponses(runId);
  const scores = readScores(runId);
  const pending = scores.filter((s) => (s.detail as { judgePending?: boolean }).judgePending).length;
  if (pending > 0) {
    console.warn(`⚠ ${pending} answers still await the judge — the report will undercount them.`);
  }
  const models = config.mock
    ? MOCK_MODELS.map((m) => ({ ...m }))
    : loadModels();
  // The board is the final run-scoped write: legacy runs freeze as soon as a
  // leaderboard appears, so the analysis it cites must be written first. This
  // also makes `bench report` produce one coherent review bundle instead of
  // inviting an impossible `bench analyze` after the directory has frozen.
  writeAnalysis(runId, analyzeRun(runId, questions, responses, scores), reportGrant);
  const leaderboard = buildLeaderboard(
    runId,
    models,
    questions,
    responses,
    scores,
    config.methodologyVersion ?? 'v2',
    {
      evidenceClass: verdict.manifest.evidenceClass,
      releaseState: verdict.manifest.releaseState,
      rankEligible: verdict.manifest.rankEligible,
      manifestHash: verdict.manifestHash,
      nonScoringBanner: verdict.nonScoringBanner,
    },
  );
  // A row averaged over fewer active items than its peers is not comparable to
  // them, and nothing downstream renders questionsGraded — so refuse to write
  // a board whose denominators disagree unless the operator opts in.
  const graded = leaderboard.rows.map((r) => r.questionsGraded);
  const modal = graded.sort((a, b) => b - a)[0] ?? 0;
  const short = leaderboard.rows.filter((r) => r.questionsGraded < modal);
  if (short.length > 0 && !flag('allow-incomplete')) {
    for (const r of short) {
      console.error(
        `✗ ${r.displayName}: ${r.questionsGraded}/${modal} items scored ` +
          `(${r.unjudged ?? 0} unjudged) — its mean is not comparable to the rest of the board`,
      );
    }
    fail(
      'Refusing to publish a leaderboard with mismatched denominators. ' +
        'Re-run `bench judge` to fill the gaps, or pass --allow-incomplete to publish anyway.',
    );
  }
  writeLeaderboard(runId, leaderboard, reportGrant);
  if (verdict.nonScoringBanner) console.log(`\n${verdict.nonScoringBanner}`);
  console.log(
    `\nCookingBench — run ${runId} (methodology ${leaderboard.methodologyVersion}, ` +
      `${verdict.manifest.evidenceClass}/${verdict.manifest.releaseState})\n`,
  );
  const header = `${'#'.padEnd(3)} ${'model'.padEnd(28)} ${'overall'.padStart(7)} ${'95% CI'.padStart(13)} ${'frontier'.padStart(8)} ${'basics'.padStart(7)} ${'inc'.padStart(4)} ${'cost'.padStart(9)}`;
  console.log(header);
  console.log('─'.repeat(header.length));
  leaderboard.rows.forEach((row, i) => {
    const ci = row.overallCi ? `${row.overallCi[0].toFixed(1)}–${row.overallCi[1].toFixed(1)}` : '—';
    console.log(
      `${String(i + 1).padEnd(3)} ${row.displayName.padEnd(28)} ${row.overall.toFixed(1).padStart(7)} ${ci.padStart(13)} ${(row.frontier?.toFixed(1) ?? '—').padStart(8)} ${(row.basics?.toFixed(1) ?? '—').padStart(7)} ${String(row.incidents ?? 0).padStart(4)} ${('$' + row.costUsd.toFixed(2)).padStart(9)}`,
    );
  });
  console.log(`\n✓ Leaderboard written to data/runs/${runId}/leaderboard.json`);
}

function cmdRuns() {
  for (const id of listRuns()) console.log(`  ${id}`);
}

function cmdAnalyze() {
  const runId = arg('run') ?? fail('analyze requires --run <id>');
  const analysisManifest = requireManifestedRun(runId, 'analyze');
  const analysisGrant =
    analysisManifest.evidenceClass === 'public-release'
      ? requireGrant('analyze', analysisManifest)
      : undefined;
  // analysis.json feeds the site's separation table and its tied ranks, so it
  // is a public-result path and takes the same gate as the board.
  requirePublicationVerdict('artifact', runId, 'analyze', analysisGrant);
  const questions = loadQuestions();
  const responses = readResponses(runId);
  const scores = readScores(runId);
  if (scores.length === 0) fail(`No scores for run ${runId} — grade it first`);
  const analysis = analyzeRun(runId, questions, responses, scores);
  writeAnalysis(runId, analysis, analysisGrant);

  console.log(`\nItem analysis — run ${runId} (${analysis.models} models, ${analysis.questions} questions)`);
  console.log(`  all-perfect: ${analysis.allPerfect}   saturated (mean≥95, sd≤5): ${analysis.saturated}\n`);
  const header = `${'question'.padEnd(11)} ${'grader'.padEnd(13)} ${'mean'.padStart(6)} ${'sd'.padStart(6)} ${'disc'.padStart(6)} ${'anom'.padStart(5)}  verdict`;
  console.log(header);
  console.log('─'.repeat(header.length));
  for (const item of analysis.questionsAnalyzed) {
    if (item.verdict === 'keep' && !arg('all')) continue;
    console.log(
      `${item.questionId.padEnd(11)} ${item.graderType.padEnd(13)} ${item.mean.toFixed(1).padStart(6)} ${item.sd.toFixed(1).padStart(6)} ${item.discrimination.toFixed(1).padStart(6)} ${String(item.anomalies).padStart(5)}  ${item.verdict}`,
    );
  }
  console.log(
    `\nActive set: ${analysis.activeQuestions} items, ${analysis.activeAllPerfect} all-perfect, ` +
      `${analysis.activeWithSignal} carrying signal — worth ${analysis.effectiveItems} equally-informative items.`,
  );

  // Printed, not just written, because the leaderboard's own ordering is the
  // thing most likely to be quoted, and most of it is not real.
  for (const scope of ['active', 'frontier'] as const) {
    const all = analysis.separation.filter((p) => p.scope === scope);
    if (all.length === 0) continue;
    const pairs = all.filter((p) => p.adjacent);
    const sep = pairs.filter((p) => p.separated).length;
    console.log(
      `\nAdjacent-pair separation, paired bootstrap over ${pairs[0]!.items} ${scope} items ` +
        `— ${sep}/${pairs.length} pairs genuinely ordered:`,
    );
    for (const p of pairs) {
      console.log(
        `  ${p.a.padEnd(30)} > ${p.b.padEnd(30)} gap ${p.gap >= 0 ? '+' : ''}${p.gap.toFixed(2).padStart(6)}  ` +
          `P=${p.pAhead.toFixed(3)}  ${p.separated ? 'separated' : 'tied'}`,
      );
    }
    // Ranks come from the full pair matrix, because "tied" does not chain:
    // every adjacent pair above can be tied while the ends are far apart.
    const ranks = tiedRanks(analysis.separation, scope);
    const groups = new Map<number, string[]>();
    for (const [model, rank] of [...ranks].sort((x, y) => x[1] - y[1])) {
      (groups.get(rank) ?? groups.set(rank, []).get(rank)!).push(model);
    }
    console.log(`  places (${all.filter((p) => p.separated).length}/${all.length} of all pairs separated):`);
    for (const [rank, members] of [...groups].sort((x, y) => x[0] - y[0])) {
      console.log(`    ${members.length > 1 ? '=' : ' '}${String(rank).padStart(2)}  ${members.join(', ')}`);
    }
  }

  console.log(`\n✓ Analysis written to data/runs/${runId}/analysis.json (use --all true to list kept items too)`);
}

async function cmdSync() {
  const grant = requireGrant('sync');
  const runId = arg('run');
  // The gate runs BEFORE the permit is redeemed and before any row leaves the
  // machine. Syncing a run pushes its scores into the database the site reads,
  // so it is a public-result path and takes the full RELEASE-002 test —
  // including that the permit, the manifest and the request name one run.
  if (runId) requirePublicationVerdict('public', runId, 'sync', grant);
  redeemPermit(grant, 'bench sync');
  if (runId) recordProvenance(runId, grant, 'bench sync');
  const { syncDataset, syncRun } = await import('./sync.js');
  await syncDataset(grant, loadModels(), loadQuestions());
  console.log('✓ models + questions synced to Supabase');
  if (runId) {
    await syncRun(grant, readRunConfig(runId), readResponses(runId), readScores(runId));
    console.log(`✓ run ${runId} synced (unpublished — use \`bench publish --run ${runId}\`)`);
  }
}

async function cmdPublish() {
  const runId = arg('run') ?? fail('publish requires --run <id>');
  const grant = requireGrant('publish');
  const verdict = requirePublicationVerdict('public', runId, 'publish', grant);
  redeemPermit(grant, 'bench publish');
  const { publishRun } = await import('./sync.js');
  await publishRun(grant, runId);
  console.log(`✓ run ${runId} (${verdict.manifest.evidenceClass}) is now publicly readable`);
}

/**
 * Move a run through the reviewed lifecycle (RELEASE-002 points 7 and 8).
 *
 * There is no `--checklist`. The checklist is built from the run's own evidence
 * inside `transitionRun`, against a fixed enumerated list of checks, and a
 * release refuses on any shortfall. An operator supplies who is signing and
 * why; an operator does not supply the result.
 */
function cmdLifecycle() {
  const runId = arg('run') ?? fail('lifecycle requires --run <id>');
  const actor = arg('actor') ?? fail('lifecycle requires --actor <name>');
  const evidence = arg('evidence') ?? fail('lifecycle requires --evidence <where the review is recorded>');
  const to = arg('to');
  try {
    if (to === undefined) {
      // No target state: report the checklist without moving anything.
      const checklist = buildReleaseChecklist(runId);
      writeReleaseChecklist(runId, checklist);
      for (const item of checklist.items) {
        const mark = item.verdict === 'pass' ? '✓' : item.verdict === 'fail' ? '✗' : '?';
        console.log(`  ${mark} ${item.id.padEnd(26)} ${item.detail}`);
      }
      const shortfall = checklistShortfall(checklist);
      console.log(
        shortfall.length === 0
          ? `\n✓ Release checklist complete for ${runId}.`
          : `\n✗ ${shortfall.length} outstanding for ${runId}.`,
      );
      return;
    }
    if (arg('register') === 'true') {
      registerRun({ runId, manifest: readRunManifest(runId), actor, evidence });
    }
    const result = transitionRun({ runId, to: to as never, actor, evidence });
    console.log(`✓ ${runId} → '${result.entry.state}' (signed ${actor}: ${evidence}).`);
  } catch (e) {
    fail((e as Error).message);
  }
}

/**
 * Point the site at a reviewed, released run — the explicit approved-release
 * pointer that replaces "newest generatedAt".
 */
function cmdCurrent() {
  const runId = arg('run');
  if (!runId) {
    const current = safeReadCurrentRun();
    console.log(
      current.ok
        ? `Current release: ${current.pointer.runId} (manifest ${current.pointer.manifestHash.slice(0, 12)}…, ` +
            `reviewed by ${current.pointer.reviewedBy} at ${current.pointer.reviewedAt})`
        : `No approved release: ${current.error}`,
    );
    const register = readReleaseRegister();
    for (const [id, entry] of Object.entries(register.entries).sort()) {
      console.log(`  ${id.padEnd(20)} ${entry.state}`);
    }
    return;
  }
  const reviewer = arg('reviewer') ?? fail('current --run <id> requires --reviewer <name>');
  const evidence = arg('evidence') ?? fail('current --run <id> requires --evidence <where the review is recorded>');
  try {
    const pointer = setCurrentRun({ runId, reviewedBy: reviewer, reviewEvidence: evidence });
    console.log(
      `✓ ${runId} is the approved release (checklist ${pointer.checklistDigest.slice(0, 12)}…, ` +
        `${pointer.artifacts.length} artifacts pinned).`,
    );
  } catch (e) {
    fail((e as Error).message);
  }
}

async function cmdTasteArchive() {
  const grant = requireGrant('taste-archive');
  redeemPermit(grant, 'bench taste-archive');
  const { archiveTasteVotes } = await import('./taste.js');
  await archiveTasteVotes(grant);
}

/**
 * The legacy pilot is deliberately absent in v3.
 *
 * Keep the command as a visible refusal so old runbooks fail clearly, but do
 * not retain dormant file readers, artifact writers or inference clients
 * behind that refusal. Dead side effects are still maintenance and audit
 * surface, and a future edit could accidentally make them reachable again.
 */
export function cmdPilot(): never {
  fail(
    'pilot is disabled in v3: the legacy admission workflow was removed because it was not ' +
      'bound to the v3 manifest, attempt journal and release protocol. No input is read, no ' +
      'permit is loaded or redeemed, no client is constructed, and no artifact is written.',
  );
}


const COMMANDS: Record<string, () => void | Promise<void>> = {
  validate: cmdValidate,
  manifest: cmdManifest,
  estimate: cmdEstimate,
  run: cmdRun,
  grade: cmdGrade,
  judge: cmdJudge,
  report: cmdReport,
  analyze: cmdAnalyze,
  runs: cmdRuns,
  models: cmdModelsCheck,
  sync: cmdSync,
  publish: cmdPublish,
  'taste-archive': cmdTasteArchive,
  pilot: cmdPilot,
  lifecycle: cmdLifecycle,
  current: cmdCurrent,
};

async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || !(command in COMMANDS)) {
    console.log(`CookingBench runner

Usage: pnpm bench <command> [options]

Commands:
  validate                       Validate the dataset (questions + models)
  manifest --run-id <id> --draft <file.json> | --mock [--limit N] [--questions a,b]
                                 Freeze the immutable execution envelope. Required before a run.
  models --check                 Check roster slugs against the live OpenRouter catalog
  estimate [--models all|a,b] [--limit N] [--tier all|active] [--questions a,b]
                                 Worst-case cost table; required before any paid run
  run --run-id <id> [--budget <usd>] [--per-model-budget <usd>]
                                 Executes the manifest for <id>: its models, items, caps and cap.
                                 --budget may only LOWER the manifest's approved ceiling.
  grade --run <id>               Deterministic grading
  judge --run <id>               LLM-judge grading for subjective questions
  report --run <id>              Build the leaderboard JSON + print the table
  analyze --run <id> [--all true]  Item analysis: saturation, discrimination, anomalies
  sync [--run <id>]              Upsert dataset (and optionally a run) to Supabase
  publish --run <id>             Make a synced run publicly readable
  taste-archive                  Snapshot all taste votes into data/taste/ (commit to preserve)
  pilot                           Disabled in v3; always refuses before reading inputs
  lifecycle --run <id> --actor <who> --evidence <where> [--to <state>] [--register true]
                                 Build the release checklist; with --to, move the run's lifecycle
  current [--run <id> --reviewer <who> --evidence <where>]
                                 Show, or set, the approved-release pointer the site reads
  runs                           List stored runs`);
    process.exit(command ? 1 : 0);
  }

  // Awaiting the handler catches both synchronous throws and rejected
  // promises, while keeping module import inert for tests and library tooling.
  try {
    await COMMANDS[command]!();
  } catch (error) {
    fail((error as Error).message);
  }
}

// Importing the CLI is a read-only operation. Credentials come exclusively
// from the invoking process environment, and command dispatch happens only
// when this module is the actual executable entry point.
const invokedPath = process.argv[1];
if (invokedPath && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  void main();
}
