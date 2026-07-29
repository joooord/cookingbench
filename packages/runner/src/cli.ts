import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  blendJudgeScore,
  gradeDeterministic,
  questionFileSchema,
  type Question,
  type RunConfig,
  type Score,
  type StoredResponse,
} from '@cookingbench/core';
import { analyzeRun, tiedRanks, writeAnalysis } from './analyze.js';
import { BudgetExceededError, BudgetGuard } from './budget.js';
import { DATA_DIR, REPO_ROOT, RUNS_DIR, buildMessages, loadModels, loadQuestions, maxTokensFor, runnableQuestions } from './dataset.js';
import { assertFreshEstimate, runEstimate } from './estimate.js';
import { JUDGE_PROMPT_VERSION, judgeAnswerPanel } from './judge.js';
import { MOCK_MODELS, MockClient, mockJudgeScore } from './mock.js';
import { OpenRouterClient, fetchCatalog, type CompletionClient } from './openrouter.js';
import { buildLeaderboard } from './report.js';
import {
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

// Minimal .env loader (repo root) — real values never override an explicit env.
const envPath = join(REPO_ROOT, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!;
  }
}

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

function checkCanaries(): string[] {
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

function cmdValidate() {
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
  const record = await runEstimate(modelIds, questions, DEFAULTS);
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
  const catalog = await fetchCatalog();
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

async function cmdRun() {
  const mock = arg('mock') === 'true';
  const questionsAll = selectQuestions();
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const questions = limit ? questionsAll.slice(0, limit) : questionsAll;
  const questionsById = new Map(questions.map((q) => [q.id, q]));

  let modelIds: string[];
  let client: CompletionClient;
  let budget: BudgetGuard;
  let runId = arg('run-id') ?? (mock ? 'mock-run' : `${new Date().toISOString().slice(0, 10)}-v1`);

  if (mock) {
    modelIds = MOCK_MODELS.map((m) => m.id);
    client = new MockClient(questionsById);
    budget = new BudgetGuard(Infinity, Infinity);
  } else {
    const models = loadModels();
    modelIds = resolveModelIds(models);
    const totalBudget = Number(arg('budget') ?? NaN);
    if (!Number.isFinite(totalBudget)) fail('A paid run requires --budget <usd> (hard cap).');
    const perModelBudget = Number(arg('per-model-budget') ?? (totalBudget / modelIds.length) * 2);
    // The guard checks a per-call worst case before every call, so a per-model
    // cap below that worst case refuses every call — and the run then reports
    // "✓ Run complete: 0 responses stored" as though it had succeeded. With a
    // 14-model roster and --budget 2.00 the default cap lands at $0.29 against
    // a ~$0.40 per-call ceiling, and the whole run silently does nothing.
    const perCallCeiling =
      (Math.max(...questions.map((q) => buildMessages(q).reduce((n, m) => n + m.content.length, 0))) / 4) *
        0.00001 +
      Math.max(DEFAULTS.maxTokens, DEFAULTS.maxTokensRecipe) * 0.00005;
    if (perModelBudget < perCallCeiling) {
      fail(
        `Per-model budget $${perModelBudget.toFixed(2)} is below the worst case for a single call ` +
          `($${perCallCeiling.toFixed(2)}), so every call would be refused before it was made. ` +
          `Raise --budget to at least $${(perCallCeiling * modelIds.length / 2).toFixed(2)} for ${modelIds.length} models, ` +
          `or set --per-model-budget explicitly.`,
      );
    }
    const estimate = assertFreshEstimate(modelIds, questions, DEFAULTS);
    console.log(
      `Estimate on file: expected $${estimate.totalExpectedUsd.toFixed(2)} | worst case $${estimate.totalWorstCaseUsd.toFixed(2)} | hard cap $${totalBudget.toFixed(2)}`,
    );
    // Gate on the EXPECTED cost, not the worst case. Worst case assumes every
    // call fills its max_tokens; with the recipe cap at 32k that is roughly 8x
    // what models actually emit, and gating on it would demand --budget 343 for
    // a batch that really costs about $8 — which makes the cap meaningless.
    // BudgetGuard still enforces the hard ceiling against ACTUAL spend at
    // runtime, so an underestimate costs an early abort, not an overspend.
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
    client = new OpenRouterClient();
    budget = new BudgetGuard(totalBudget, perModelBudget);
  }

  const batchBudget = mock ? 0 : Number(arg('budget'));
  const config: RunConfig = {
    runId,
    models: modelIds,
    temperature: DEFAULTS.temperature,
    maxTokens: DEFAULTS.maxTokens,
    maxTokensRecipe: DEFAULTS.maxTokensRecipe,
    budgetUsdTotal: batchBudget,
    budgetUsdPerModel: mock ? 0 : Number(arg('per-model-budget') ?? 0),
    concurrency: DEFAULTS.concurrency,
    judgeModel: DEFAULTS.judgeModel,
    judgePanel: DEFAULTS.judgePanel,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    methodologyVersion: DEFAULTS.methodologyVersion,
    mock,
    batches: [
      {
        startedAt: new Date().toISOString(),
        models: modelIds,
        maxTokens: DEFAULTS.maxTokens,
        maxTokensRecipe: DEFAULTS.maxTokensRecipe,
        budgetUsdTotal: batchBudget,
      },
    ],
  };
  // Merge, don't replace: a run is assembled from per-model batches, and the
  // published config has to describe all of them.
  mergeRunConfig(config);

  const tasks: Array<{ modelId: string; question: Question }> = [];
  for (const modelId of modelIds) {
    for (const question of questions) {
      if (hasResponse(runId, modelId, question.id)) continue; // idempotent resume
      tasks.push({ modelId, question });
    }
  }
  console.log(`Run ${runId}: ${tasks.length} calls to make (${modelIds.length} models × ${questions.length} questions, resume-aware)`);

  let done = 0;
  const failures: string[] = [];
  const haltedModels = new Set<string>();
  await pool(tasks, DEFAULTS.concurrency, async ({ modelId, question }) => {
    if (haltedModels.has(modelId)) return;
    const maxTokens = maxTokensFor(question, DEFAULTS);
    try {
      // Worst-case for the next call at flagship pricing ($10/$50 per Mtok upper bound).
      const promptChars = buildMessages(question).reduce((n, m) => n + m.content.length, 0);
      const worstCase = (promptChars / 4) * 0.00001 + maxTokens * 0.00005;
      budget.assertCanSpend(modelId, worstCase);
      let result = await client.complete(modelId, buildMessages(question), {
        temperature: DEFAULTS.temperature,
        maxTokens,
        reasoning: { effort: 'medium' },
      });
      budget.record(modelId, result.costUsd);
      let totalCost = result.costUsd;
      // Empty/filtered completions are transport noise — retry before storing,
      // with extra token headroom on the second retry.
      for (let retry = 0; retry < 2 && isTransportFailure(result) && !mock; retry++) {
        result = await client.complete(modelId, buildMessages(question), {
          temperature: DEFAULTS.temperature,
          maxTokens: retry === 0 ? maxTokens : maxTokens * 2,
          reasoning: { effort: 'medium' },
        });
        budget.record(modelId, result.costUsd);
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
      done++;
      if (done % 20 === 0) {
        console.log(`  ${done}/${tasks.length} done — spent $${budget.spentTotalUsd.toFixed(4)}`);
      }
    } catch (error) {
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

  if (done === 0 && tasks.length > 0) {
    fail(
      `No responses were stored despite ${tasks.length} task(s) queued — the run did nothing. ` +
        `Check the budget warnings above rather than treating this as a completed run.`,
    );
  }
  console.log(`\n✓ Run complete: ${done} responses stored, total spend $${budget.spentTotalUsd.toFixed(4)}`);
  if (failures.length > 0) {
    console.error(`✗ ${failures.length} failures (re-run the same command to retry just these):`);
    for (const f of failures.slice(0, 10)) console.error(`    ${f}`);
  }
  console.log(`Next: pnpm bench grade --run ${runId}`);
}

function cmdGrade() {
  const runId = arg('run') ?? fail('grade requires --run <id>');
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

async function cmdJudge() {
  const runId = arg('run') ?? fail('judge requires --run <id>');
  const config = readRunConfig(runId);
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
  const client = config.mock ? null : new OpenRouterClient();

  // The judging configuration of record. Written AFTER the calibration gate,
  // and unconditionally, because both details were wrong before: the write was
  // skipped whenever judgePanel was already set, and it happened before
  // calibration. A panel that failed the gate therefore stayed recorded as the
  // panel of record while a different one did the judging — canary3 was
  // stamped opus-5/gpt-5.6-sol-pro/grok-4.5 after that panel was rejected.
  const judgePanel = DEFAULTS.judgePanel;

  // Judge calibration gate: every panel seat must independently reproduce the
  // hand-scored anchors before any paid judging is accepted for this run.
  if (!config.mock) {
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
  if (!config.mock) {
    config.judgeModel = DEFAULTS.judgeModel;
    config.judgePanel = judgePanel;
    config.judgePromptVersion = JUDGE_PROMPT_VERSION;
    writeRunConfig(config);
  }

  // Judging is the expensive half of the pipeline — two flagship seats per
  // answer, up to three calls per seat on a parse failure — and until now it
  // was the half with no cap and no cost recording at all. Roughly $29 of the
  // ~$56 spent across both published runs never appeared in any artifact.
  const judgeBudget = Number(arg('budget') ?? NaN);
  if (!config.mock && !Number.isFinite(judgeBudget)) {
    fail(
      `Judging ${pending.length} answers needs a cap: pass --budget <usd>. ` +
        `Rough worst case is ${pending.length * 2} seat calls (3× that if seats return unparseable output).`,
    );
  }
  const budget = new BudgetGuard(config.mock ? Infinity : judgeBudget, Infinity);
  // A flagship seat pair on a long answer; used only for the pre-flight check.
  const WORST_CASE_PER_ANSWER_USD = 0.25;

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
    if (config.mock) {
      judgeScore = mockJudgeScore(s.modelId, question);
      judgeDetail = { mockJudge: true };
    } else {
      let verdict: Awaited<ReturnType<typeof judgeAnswerPanel>>;
      budget.assertCanSpend('judge-panel', WORST_CASE_PER_ANSWER_USD);
      // The spend object is shared with the panel so a seat that fails after
      // two paid retries still reports what it burned.
      const spend = { costUsd: 0 };
      try {
        verdict = await judgeAnswerPanel(
          client!,
          judgePanel,
          s.modelId,
          question,
          response.answerText,
          spend,
        );
      } catch (error) {
        // One unjudgeable answer must not sink the batch — it stays
        // judgePending and the next `bench judge` retries just these.
        budget.record('judge-panel', spend.costUsd);
        judgeFailures.push(`${s.modelId} × ${s.questionId}: ${(error as Error).message.slice(0, 120)}`);
        return;
      }
      budget.record('judge-panel', verdict.costUsd);
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
    }
    s.score = blendJudgeScore(question, judgeScore, detail.constraintScore);
    s.judgeModel = config.mock
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
      console.log(`  ${done}/${pending.length} judged — spent $${budget.spentTotalUsd.toFixed(4)}`);
    }
  });
  } finally {
    // Whatever happened — budget abort, provider outage, Ctrl-C landing on the
    // event loop — the verdicts already paid for are on disk.
    checkpoint();
  }
  if (!config.mock) {
    config.judgeCostUsd = Math.round(budget.spentTotalUsd * 10000) / 10000;
    writeRunConfig(config);
    console.log(`  judge spend this pass: $${budget.spentTotalUsd.toFixed(4)}`);
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

function cmdReport() {
  const runId = arg('run') ?? fail('report requires --run <id>');
  const config = readRunConfig(runId);
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
  const leaderboard = buildLeaderboard(
    runId,
    models,
    questions,
    responses,
    scores,
    config.methodologyVersion ?? 'v2',
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
  writeLeaderboard(runId, leaderboard);
  console.log(`\nCookingBench — run ${runId} (methodology ${leaderboard.methodologyVersion})\n`);
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
  const questions = loadQuestions();
  const responses = readResponses(runId);
  const scores = readScores(runId);
  if (scores.length === 0) fail(`No scores for run ${runId} — grade it first`);
  const analysis = analyzeRun(runId, questions, responses, scores);
  writeAnalysis(runId, analysis);

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
  const { syncDataset, syncRun } = await import('./sync.js');
  await syncDataset(loadModels(), loadQuestions());
  console.log('✓ models + questions synced to Supabase');
  const runId = arg('run');
  if (runId) {
    await syncRun(readRunConfig(runId), readResponses(runId), readScores(runId));
    console.log(`✓ run ${runId} synced (unpublished — use \`bench publish --run ${runId}\`)`);
  }
}

async function cmdPublish() {
  const runId = arg('run') ?? fail('publish requires --run <id>');
  const { publishRun } = await import('./sync.js');
  await publishRun(runId);
  console.log(`✓ run ${runId} is now publicly readable`);
}

async function cmdTasteArchive() {
  const { archiveTasteVotes } = await import('./taste.js');
  await archiveTasteVotes();
}

/** Both models comfortable here and the item separates nobody. */
const SLACK_THRESHOLD = 90;
/** Both models on the floor: the item, or its grader, is broken rather than hard. */
const FLOOR_THRESHOLD = 20;

interface PilotResult {
  questionId: string;
  ceiling: number;
  mid: number;
  verdict: 'admit' | 'reject-slack' | 'reject-floor';
}

/**
 * The pilot seats, taken from the newest published leaderboard rather than a
 * hardcoded pair, so the gate tracks the roster instead of drifting behind it:
 * the strongest model sets the ceiling, the middle of the table gives a second
 * opinion. Falls back to roster order when nothing has been published yet.
 */
function pilotSeats(models: ReturnType<typeof loadModels>): { ceiling: string; mid: string } {
  const active = models.filter((m) => m.active).map((m) => m.id);
  // Newest published board wins, and a mock run is never a board — the same
  // selection the site makes, for the same reason.
  const boards = listRuns()
    .map((runId) => ({ runId, path: join(RUNS_DIR, runId, 'leaderboard.json') }))
    .filter(({ path }) => existsSync(path))
    .map(({ runId, path }) => ({
      runId,
      board: JSON.parse(readFileSync(path, 'utf8')) as {
        generatedAt: string;
        rows: Array<{ modelId: string }>;
      },
    }))
    .filter(({ runId }) => {
      const configPath = join(RUNS_DIR, runId, 'config.json');
      if (!existsSync(configPath)) return true;
      return !(JSON.parse(readFileSync(configPath, 'utf8')) as { mock?: boolean }).mock;
    })
    .sort((a, b) => Date.parse(b.board.generatedAt) - Date.parse(a.board.generatedAt));
  const ranked =
    boards[0]?.board.rows.map((r) => r.modelId).filter((id) => active.includes(id)) ?? [];
  const order = ranked.length > 0 ? ranked : active;
  const ceiling = arg('ceiling') ?? order[0]!;
  const mid = arg('mid') ?? order[Math.floor(order.length / 2)]!;
  if (ceiling === mid) fail('Pilot needs two distinct models — pass --ceiling and --mid.');
  return { ceiling, mid };
}

/** Admission records are artifacts too: every decision stays auditable. */
function writePilot(sourceFile: string, results: PilotResult[]): void {
  const dir = join(DATA_DIR, 'pilot');
  mkdirSync(dir, { recursive: true });
  const name = basename(sourceFile).replace(/\.ya?ml$/, '');
  const path = join(dir, `${name}.json`);
  writeFileSync(
    path,
    `${JSON.stringify({ source: sourceFile, at: new Date().toISOString(), results }, null, 2)}\n`,
  );
  console.log(`✓ Admission record written to data/pilot/${name}.json`);
}


/**
 * Pilot: prove a candidate question discriminates *before* it costs a full run.
 *
 * Two models, not a ladder, and the ceiling rather than the floor. If today's
 * strongest model aces a question it is slack no matter how badly the weakest
 * one does — and it will still be slack for whatever replaces them, which is
 * what stops the dataset decaying as the roster turns over. Selecting items
 * because the weakest model fails them just builds a small-model detector.
 *
 * Stage 0 (free, no calls) runs first: reference answer must score 100, a
 * failingAnswer must score low, and anything scoring 100 on keyword stuffing is
 * reported. Only survivors cost money.
 */
async function cmdPilot() {
  const file = arg('file') ?? fail('pilot requires --file <candidates.yaml>');
  const path = isAbsolute(file) ? file : join(REPO_ROOT, file);
  if (!existsSync(path)) fail(`No candidate file at ${path}`);
  const parsed = questionFileSchema.safeParse(parseYaml(readFileSync(path, 'utf8')));
  if (!parsed.success) fail(`Invalid candidate file:\n${parsed.error.message}`);
  const candidates = parsed.data as Question[];

  const corpus = loadQuestions();
  const existing = new Set(corpus.map((q) => q.id));
  for (const c of candidates) {
    if (existing.has(c.id)) fail(`Candidate ${c.id} already exists in the dataset — pick a fresh id.`);
    for (const dup of nearDuplicates(c, corpus)) {
      console.log(
        `  ⚠ ${c.id} resembles ${dup.id} (${dup.status}, ${Math.round(dup.overlap * 100)}% prompt overlap)` +
          (dup.status === 'basics' ? ' — that item saturated, so this one probably will too' : ''),
      );
    }
  }

  console.log(`Piloting ${candidates.length} candidates from ${file}\n`);

  // --- Stage 0: free rejection -------------------------------------------
  const { problems, warnings } = checkReferenceAnswers(candidates);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  const brokenIds = new Set(problems.map((p) => p.split(':')[0]!));
  for (const p of problems) console.error(`  ✗ ${p}`);
  const survivors = candidates.filter((c) => !brokenIds.has(c.id));
  console.log(
    `\nStage 0 — ${candidates.length - survivors.length} rejected before any model was called, ${survivors.length} continue.`,
  );
  if (survivors.length === 0) {
    writePilot(file, []);
    return;
  }

  // --- Stage 1: ceiling + mid --------------------------------------------
  const models = flag('mock') ? MOCK_MODELS.map((m) => ({ ...m })) : loadModels();
  const seats = pilotSeats(models);
  console.log(`Stage 1 — ${seats.ceiling} (ceiling) and ${seats.mid} (mid)\n`);

  const mock = flag('mock');
  const budgetArg = arg('budget');
  if (!mock && budgetArg === undefined) fail('pilot requires --budget <usd> (hard cap).');
  const cap = mock ? Infinity : Number(budgetArg);
  if (!mock && !Number.isFinite(cap)) fail('--budget must be a number.');
  const budget = new BudgetGuard(cap, Infinity);
  const client: CompletionClient = mock
    ? new MockClient(new Map(survivors.map((q) => [q.id, q])))
    : new OpenRouterClient();

  const results: PilotResult[] = [];
  try {
  for (const q of survivors) {
    const scores: Record<string, number> = {};
    for (const modelId of [seats.ceiling, seats.mid]) {
      const maxTokens = maxTokensFor(q, DEFAULTS);
      const promptChars = buildMessages(q).reduce((n, m) => n + m.content.length, 0);
      budget.assertCanSpend(modelId, (promptChars / 4) * 0.00001 + maxTokens * 0.00005);
      const result = await client.complete(modelId, buildMessages(q), {
        temperature: DEFAULTS.temperature,
        maxTokens,
        reasoning: { effort: 'medium' },
      });
      budget.record(modelId, result.costUsd);
      const deterministic = gradeDeterministic(q, result.text);
      if (q.grader.type === 'llm-judge') {
        const judgeScore = mock
          ? mockJudgeScore(modelId, q)
          : await judgeAnswerPanel(client, DEFAULTS.judgePanel, modelId, q, result.text).then((v) => {
              budget.record(modelId, v.costUsd);
              return v.score;
            });
        scores[modelId] = blendJudgeScore(q, judgeScore, deterministic?.score ?? null);
      } else {
        scores[modelId] = deterministic?.score ?? 0;
      }
    }
    const ceiling = scores[seats.ceiling]!;
    const mid = scores[seats.mid]!;
    // Both models comfortable → nothing to measure. Both floored → the item or
    // its grader is broken, not hard; either way it separates nobody.
    const verdict =
      ceiling >= SLACK_THRESHOLD && mid >= SLACK_THRESHOLD
        ? 'reject-slack'
        : ceiling <= FLOOR_THRESHOLD && mid <= FLOOR_THRESHOLD
          ? 'reject-floor'
          : 'admit';
    results.push({ questionId: q.id, ceiling, mid, verdict });
    const mark = verdict === 'admit' ? '✓' : '✗';
    console.log(
      `  ${mark} ${q.id.padEnd(10)} ceiling ${ceiling.toFixed(0).padStart(3)}  mid ${mid.toFixed(0).padStart(3)}  ${verdict}`,
    );
  }
  } finally {
    // A budget abort must not discard verdicts already paid for — the guard
    // says "completed work is saved" and for the pilot that has to be true too.
    if (results.length > 0) writePilot(file, results);
  }

  const admitted = results.filter((r) => r.verdict === 'admit');
  console.log(
    `\n${admitted.length}/${candidates.length} admitted. Spend $${budget.spentTotalUsd.toFixed(4)}.`,
  );
  if (admitted.length > 0) {
    console.log('Admitted candidates still need the Stage 2 validity check before going active.');
  }
}


const COMMANDS: Record<string, () => void | Promise<void>> = {
  validate: cmdValidate,
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
};

const command = process.argv[2];
if (!command || !(command in COMMANDS)) {
  console.log(`CookingBench runner

Usage: pnpm bench <command> [options]

Commands:
  validate                       Validate the dataset (questions + models)
  models --check                 Check roster slugs against the live OpenRouter catalog
  estimate [--models all|a,b] [--limit N] [--tier all|active] [--questions a,b]
                                 Worst-case cost table; required before any paid run
  run --budget <usd> [--models all|a,b] [--limit N] [--tier all|active] [--questions a,b] [--run-id id] [--mock]
                                 --tier active skips the basics regression gate (82 of 184 items)
  grade --run <id>               Deterministic grading
  judge --run <id>               LLM-judge grading for subjective questions
  report --run <id>              Build the leaderboard JSON + print the table
  analyze --run <id> [--all true]  Item analysis: saturation, discrimination, anomalies
  sync [--run <id>]              Upsert dataset (and optionally a run) to Supabase
  publish --run <id>             Make a synced run publicly readable
  taste-archive                  Snapshot all taste votes into data/taste/ (commit to preserve)
  pilot --file <yaml> --budget <usd> [--mock] [--ceiling id] [--mid id]
                                 Admission gate for candidate questions
  runs                           List stored runs`);
  process.exit(command ? 1 : 0);
}

Promise.resolve(COMMANDS[command]!()).catch((error) => fail((error as Error).message));
