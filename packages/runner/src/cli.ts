import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  blendJudgeScore,
  gradeDeterministic,
  type Question,
  type RunConfig,
  type Score,
  type StoredResponse,
} from '@cookingbench/core';
import { BudgetExceededError, BudgetGuard } from './budget.js';
import { REPO_ROOT, buildMessages, loadModels, loadQuestions, maxTokensFor } from './dataset.js';
import { assertFreshEstimate, runEstimate } from './estimate.js';
import { JUDGE_PROMPT_VERSION, judgeAnswer } from './judge.js';
import { MOCK_MODELS, MockClient, mockJudgeScore } from './mock.js';
import { OpenRouterClient, fetchCatalog, type CompletionClient } from './openrouter.js';
import { buildLeaderboard } from './report.js';
import {
  hasResponse,
  listRuns,
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
  maxTokens: 2000,
  maxTokensRecipe: 4000,
  concurrency: 4,
  judgeModel: 'google/gemini-3.1-pro',
  methodologyVersion: 'v1',
};

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  const value = process.argv[idx + 1];
  return value && !value.startsWith('--') ? value : 'true';
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
}

async function cmdEstimate() {
  const questions = loadQuestions();
  const models = loadModels();
  const modelIds = resolveModelIds(models);
  console.log(`Estimating worst-case cost for ${modelIds.length} models × ${questions.length} questions…`);
  const record = await runEstimate(modelIds, questions, DEFAULTS);
  for (const m of record.perModel) {
    console.log(`    ${m.modelId.padEnd(40)} ${m.calls} calls   $${m.worstCaseUsd.toFixed(2)}`);
  }
  console.log(`\n  TOTAL worst case: $${record.totalWorstCaseUsd.toFixed(2)}`);
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
      ok = false;
      console.log(`  ✗ ${m.id} — NOT in the OpenRouter catalog${m.active ? ' (ACTIVE — fix before running!)' : ''}`);
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
  const questionsAll = loadQuestions();
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
    const perModelBudget = Number(arg('per-model-budget') ?? totalBudget / modelIds.length * 2);
    const estimate = assertFreshEstimate(modelIds, questions, DEFAULTS);
    console.log(
      `Estimate on file: worst case $${estimate.totalWorstCaseUsd.toFixed(2)} | hard cap $${totalBudget.toFixed(2)}`,
    );
    if (estimate.totalWorstCaseUsd > totalBudget) {
      fail(
        `Worst-case estimate ($${estimate.totalWorstCaseUsd.toFixed(2)}) exceeds the budget cap ($${totalBudget.toFixed(2)}). Raise --budget or trim models/questions.`,
      );
    }
    client = new OpenRouterClient();
    budget = new BudgetGuard(totalBudget, perModelBudget);
  }

  const config: RunConfig = {
    runId,
    models: modelIds,
    temperature: DEFAULTS.temperature,
    maxTokens: DEFAULTS.maxTokens,
    maxTokensRecipe: DEFAULTS.maxTokensRecipe,
    budgetUsdTotal: mock ? 0 : Number(arg('budget')),
    budgetUsdPerModel: mock ? 0 : Number(arg('per-model-budget') ?? 0),
    concurrency: DEFAULTS.concurrency,
    judgeModel: DEFAULTS.judgeModel,
    judgePromptVersion: JUDGE_PROMPT_VERSION,
    methodologyVersion: DEFAULTS.methodologyVersion,
    mock,
  };
  writeRunConfig(config);

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
      const result = await client.complete(modelId, buildMessages(question), {
        temperature: DEFAULTS.temperature,
        maxTokens,
      });
      budget.record(modelId, result.costUsd);
      const stored: StoredResponse = {
        runId,
        modelId,
        questionId: question.id,
        answerText: result.text,
        raw: result.raw,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        finishReason: result.finishReason,
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
  console.log(`Judging ${pending.length} answers with ${config.judgeModel} (${config.judgePromptVersion})…`);

  const client = config.mock ? null : new OpenRouterClient();
  let flagged = 0;
  await pool(pending, DEFAULTS.concurrency, async (s) => {
    const question = questionsById.get(s.questionId)!;
    const response = responses.find(
      (r) => r.modelId === s.modelId && r.questionId === s.questionId,
    )!;
    const detail = s.detail as { constraintScore: number | null; constraintDetail: unknown };
    let judgeScore: number;
    let judgeDetail: Record<string, unknown>;
    if (config.mock) {
      judgeScore = mockJudgeScore(s.modelId, question);
      judgeDetail = { mockJudge: true };
    } else {
      const verdict = await judgeAnswer(client!, config.judgeModel, question, response.answerText);
      judgeScore = verdict.score;
      judgeDetail = {
        criterionScores: verdict.criterionScores,
        justification: verdict.justification,
        disagreement: verdict.disagreement,
        flagged: verdict.flagged,
      };
      if (verdict.flagged) flagged++;
    }
    s.score = blendJudgeScore(question, judgeScore, detail.constraintScore);
    s.judgeModel = config.mock ? 'mock-judge' : config.judgeModel;
    s.detail = {
      judgePending: false,
      judgeScore,
      constraintScore: detail.constraintScore,
      constraintDetail: detail.constraintDetail,
      ...judgeDetail,
    };
  });
  writeScores(runId, scores);
  console.log(`✓ Judged ${pending.length} answers${flagged > 0 ? ` (${flagged} flagged for manual review)` : ''}`);
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
  const leaderboard = buildLeaderboard(runId, models, questions, responses, scores);
  writeLeaderboard(runId, leaderboard);
  console.log(`\nCookingBench — run ${runId}\n`);
  const header = `${'#'.padEnd(3)} ${'model'.padEnd(28)} ${'overall'.padStart(7)} ${'cost'.padStart(9)}`;
  console.log(header);
  console.log('─'.repeat(header.length));
  leaderboard.rows.forEach((row, i) => {
    console.log(
      `${String(i + 1).padEnd(3)} ${row.displayName.padEnd(28)} ${row.overall.toFixed(1).padStart(7)} ${('$' + row.costUsd.toFixed(2)).padStart(9)}`,
    );
  });
  console.log(`\n✓ Leaderboard written to data/runs/${runId}/leaderboard.json`);
}

function cmdRuns() {
  for (const id of listRuns()) console.log(`  ${id}`);
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

const COMMANDS: Record<string, () => void | Promise<void>> = {
  validate: cmdValidate,
  estimate: cmdEstimate,
  run: cmdRun,
  grade: cmdGrade,
  judge: cmdJudge,
  report: cmdReport,
  runs: cmdRuns,
  models: cmdModelsCheck,
  sync: cmdSync,
  publish: cmdPublish,
};

const command = process.argv[2];
if (!command || !(command in COMMANDS)) {
  console.log(`CookingBench runner

Usage: pnpm bench <command> [options]

Commands:
  validate                       Validate the dataset (questions + models)
  models --check                 Check roster slugs against the live OpenRouter catalog
  estimate [--models all|a,b]    Worst-case cost table; required before any paid run
  run --budget <usd> [--models all|a,b] [--limit N] [--run-id id] [--mock]
  grade --run <id>               Deterministic grading
  judge --run <id>               LLM-judge grading for subjective questions
  report --run <id>              Build the leaderboard JSON + print the table
  sync [--run <id>]              Upsert dataset (and optionally a run) to Supabase
  publish --run <id>             Make a synced run publicly readable
  runs                           List stored runs`);
  process.exit(command ? 1 : 0);
}

Promise.resolve(COMMANDS[command]!()).catch((error) => fail((error as Error).message));
