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
import { analyzeRun, writeAnalysis } from './analyze.js';
import { BudgetExceededError, BudgetGuard } from './budget.js';
import { REPO_ROOT, buildMessages, loadModels, loadQuestions, maxTokensFor, runnableQuestions } from './dataset.js';
import {
  assertFreshEstimate,
  assertFreshTasteEstimate,
  runEstimate,
  runTasteEstimate,
} from './estimate.js';
import { JUDGE_PROMPT_VERSION, judgeAnswerPanel } from './judge.js';
import { MOCK_MODELS, MockClient, mockJudgeScore, mockTasteVerdict } from './mock.js';
import { OpenRouterClient, fetchCatalog, type CompletionClient } from './openrouter.js';
import { buildLeaderboard } from './report.js';
import {
  buildPanelSummary,
  buildTasteJudgeMessages,
  judgePair,
  pairVerdictToVotes,
  planPairs,
  TASTE_JUDGE_PROMPT_VERSION,
  type PairVerdictRecord,
  type PlannedPair,
} from './tastejudge.js';
import type { PanelTasteVote } from '@cookingbench/core';
import {
  hasResponse,
  hasTasteVerdict,
  listRuns,
  readResponses,
  readRunConfig,
  readScores,
  readTasteVerdicts,
  writeLeaderboard,
  writeResponse,
  writeRunConfig,
  writeScores,
  writeTasteVerdict,
  writeTastePanelArtifacts,
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
  // Flat 8k cap with medium reasoning effort: v1's 2000/4000 caps starved
  // hidden-reasoning models into empty answers (measuring budgeting, not cooking).
  maxTokens: 8000,
  maxTokensRecipe: 8000,
  concurrency: 4,
  // Panel judging: two non-conflicted seats score each answer (a judge never
  // scores its own provider). Seat rotation is deterministic — see panelSeats.
  judgeModel: 'panel-v1',
  judgePanel: [
    'anthropic/claude-opus-4.8',
    'qwen/qwen3.5-plus-20260420',
    'openai/gpt-5.5',
  ],
  methodologyVersion: 'v2',
  // Taste panel: pairwise A-vs-B judging excludes BOTH contenders' providers, so
  // five provider-distinct seats guarantee ≥2 eligible for any duel in the
  // 13-model roster. Kept separate from the precision panel above.
  tasteJudgePanel: [
    'anthropic/claude-opus-4.8',
    'openai/gpt-5.5',
    'qwen/qwen3.5-plus-20260420',
    'google/gemini-3.1-pro-preview',
    'x-ai/grok-4.3',
  ],
  tasteMaxTokens: 800,
  tastePairsPerQuestion: 4,
};

/** Empty or filtered completions are transport noise, not skill — retried, then marked. */
function isTransportFailure(result: { text: string; finishReason?: string }): boolean {
  return result.text.trim() === '' || result.finishReason === 'content_filter';
}

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
  const byCategory = new Map<string, { active: number; basics: number; retired: number }>();
  for (const q of questions) {
    const row = byCategory.get(q.category) ?? { active: 0, basics: 0, retired: 0 };
    row[q.status] += 1;
    byCategory.set(q.category, row);
  }
  const totals = { active: 0, basics: 0, retired: 0 };
  console.log(`✓ ${questions.length} questions valid`);
  console.log(`    ${'category'.padEnd(20)} ${'total'.padStart(6)} ${'active'.padStart(7)} ${'basics'.padStart(7)} ${'retired'.padStart(8)}`);
  for (const [category, c] of [...byCategory].sort()) {
    const total = c.active + c.basics + c.retired;
    totals.active += c.active;
    totals.basics += c.basics;
    totals.retired += c.retired;
    console.log(`    ${category.padEnd(20)} ${String(total).padStart(6)} ${String(c.active).padStart(7)} ${String(c.basics).padStart(7)} ${String(c.retired).padStart(8)}`);
  }
  const grand = totals.active + totals.basics + totals.retired;
  console.log(`    ${'— all —'.padEnd(20)} ${String(grand).padStart(6)} ${String(totals.active).padStart(7)} ${String(totals.basics).padStart(7)} ${String(totals.retired).padStart(8)}`);
  console.log(`✓ ${models.length} models valid (${models.filter((m) => m.active).length} active)`);
}

async function cmdEstimate() {
  const questionsAll = runnableQuestions();
  const limit = arg('limit') ? Number(arg('limit')) : undefined;
  const questions = limit ? questionsAll.slice(0, limit) : questionsAll;
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
  const questionsAll = runnableQuestions();
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
    judgePanel: DEFAULTS.judgePanel,
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

  // The judging configuration of record: the current panel. (config.json is
  // refreshed so the artifact reflects what actually judged this run.)
  const judgePanel = DEFAULTS.judgePanel;
  if (!config.mock && (config.judgeModel !== DEFAULTS.judgeModel || !config.judgePanel)) {
    config.judgeModel = DEFAULTS.judgeModel;
    config.judgePanel = judgePanel;
    config.judgePromptVersion = JUDGE_PROMPT_VERSION;
    writeRunConfig(config);
  }

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

  console.log(`Judging ${pending.length} answers with panel [${judgePanel.join(', ')}] (${config.judgePromptVersion})…`);
  let flagged = 0;
  const judgeFailures: string[] = [];
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
      let verdict: Awaited<ReturnType<typeof judgeAnswerPanel>>;
      try {
        verdict = await judgeAnswerPanel(client!, judgePanel, s.modelId, question, response.answerText);
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
  });
  writeScores(runId, scores);
  const judgedCount = pending.length - judgeFailures.length;
  console.log(`✓ Judged ${judgedCount} answers${flagged > 0 ? ` (${flagged} flagged for manual review)` : ''}`);
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
  const analysis = analyzeRun(runId, questions, responses, scores, {
    judgePromptVersion: readRunConfig(runId).judgePromptVersion,
  });
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

// ── LLM taste panel: pairwise A-vs-B judging, feeding the same Bradley-Terry
//    ratings as the human crowd but kept in committed artifacts, never blended. ──

/**
 * The taste-duel pool and pair plan for a run: the same subjective items the
 * public /tastetest serves (llm-judge, active, public), the usable stored
 * answers per question, and the deterministic balanced pair plan.
 */
function tastePlan(runId: string) {
  const config = readRunConfig(runId);
  const questions = loadQuestions();
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const modelSet = new Set(config.models);
  let pool = questions.filter(
    (q) => q.grader.type === 'llm-judge' && q.status === 'active' && q.public,
  );
  const only = arg('questions');
  if (only) {
    const ids = new Set(only.split(',').map((s) => s.trim()));
    pool = pool.filter((q) => ids.has(q.id));
  }

  const responses = readResponses(runId);
  const answersByQuestion = new Map<string, Map<string, string>>();
  for (const r of responses) {
    if (!modelSet.has(r.modelId)) continue;
    const usable = r.answerText.trim() !== '' && !(r as { transportFailure?: boolean }).transportFailure;
    if (!usable) continue;
    let byModel = answersByQuestion.get(r.questionId);
    if (!byModel) answersByQuestion.set(r.questionId, (byModel = new Map()));
    byModel.set(r.modelId, r.answerText);
  }
  const eligibleByQuestion = new Map<string, string[]>();
  for (const q of pool) {
    const models = [...(answersByQuestion.get(q.id)?.keys() ?? [])].sort();
    if (models.length >= 2) eligibleByQuestion.set(q.id, models);
  }
  const pairsPerQuestion = Number(arg('pairs-per-question') ?? DEFAULTS.tastePairsPerQuestion);
  const plan = planPairs(runId, pool, eligibleByQuestion, pairsPerQuestion);
  return { config, questionsById, answersByQuestion, plan, pairsPerQuestion };
}

const pairKeyOf = (p: PlannedPair) => `${p.questionId}:${p.modelA}:${p.modelB}`;

async function cmdTasteEstimate() {
  const runId = arg('run') ?? fail('taste-estimate requires --run <id>');
  const { questionsById, answersByQuestion, plan, pairsPerQuestion } = tastePlan(runId);
  if (plan.length === 0) fail('No eligible duels to estimate (need ≥2 usable answers per item).');
  // Mean built-message length across the plan → prompt-token estimate.
  let charSum = 0;
  for (const p of plan) {
    const answers = answersByQuestion.get(p.questionId)!;
    const messages = buildTasteJudgeMessages(
      questionsById.get(p.questionId)!,
      answers.get(p.modelA)!,
      answers.get(p.modelB)!,
    );
    charSum += messages.reduce((n, m) => n + m.content.length, 0);
  }
  const meanPromptChars = charSum / plan.length;
  console.log(
    `Taste panel plan: ${plan.length} duels × ${pairsPerQuestion}/question × 2 seats × 2 orders…`,
  );
  const record = await runTasteEstimate(
    DEFAULTS.tasteJudgePanel,
    plan.map(pairKeyOf),
    meanPromptChars,
    DEFAULTS.tasteMaxTokens,
  );
  console.log(`    ${record.judgeCalls} judge calls across the panel`);
  console.log(`\n  TOTAL worst case: $${record.totalWorstCaseUsd.toFixed(2)}`);
  console.log('  (Worst case assumes every call hits the full token cap — actuals run far lower.)');
  console.log(`\n✓ Taste estimate saved. Valid for 24h. Now: pnpm bench taste-judge --run ${runId} --budget <usd>`);
}

async function cmdTasteJudge() {
  const runId = arg('run') ?? fail('taste-judge requires --run <id>');
  const mock = arg('mock') === 'true';
  const { config, questionsById, answersByQuestion, plan, pairsPerQuestion } = tastePlan(runId);
  if (plan.length === 0) fail('No eligible duels (need ≥2 usable answers per active llm-judge item).');
  const panel = DEFAULTS.tasteJudgePanel;
  const isMock = mock || Boolean(config.mock);

  if (!isMock) {
    const estimate = assertFreshTasteEstimate(panel, plan.map(pairKeyOf), DEFAULTS.tasteMaxTokens);
    const totalBudget = Number(arg('budget') ?? NaN);
    if (!Number.isFinite(totalBudget)) fail('A paid taste run requires --budget <usd> (hard cap).');
    console.log(
      `Taste estimate on file: worst case $${estimate.totalWorstCaseUsd.toFixed(2)} | hard cap $${totalBudget.toFixed(2)}`,
    );
    if (estimate.totalWorstCaseUsd > totalBudget) {
      fail(`Worst-case taste estimate exceeds the budget cap. Raise --budget or lower --pairs-per-question.`);
    }
    // Taste calibration gate: every seat must prefer the good answer over the
    // plainly-worse one in both positions before any paid duel is accepted.
    const { readTasteCalibration, runTasteCalibration } = await import('./tastecalibration.js');
    const prior = readTasteCalibration(runId);
    if (prior?.passed && JSON.stringify(prior.panel) === JSON.stringify(panel) && prior.promptVersion === TASTE_JUDGE_PROMPT_VERSION) {
      console.log('✓ Taste calibration gate already passed.');
    } else {
      console.log(`Calibrating taste panel [${panel.join(', ')}] against good/bad anchors…`);
      const calibration = await runTasteCalibration(new OpenRouterClient(), panel, runId, questionsById);
      for (const judge of calibration.judges) {
        console.log(`  ${judge.passed ? '✓' : '✗'} ${judge.judgeModel}`);
        for (const a of judge.anchors.filter((x) => !x.pass)) {
          console.log(`      ✗ ${a.questionId}: forward=${a.forward} reversed=${a.reversed}  ${a.note ?? ''}`);
        }
      }
      if (!calibration.passed) fail('A taste seat failed calibration (position/verbosity/safety bias) — fix before judging.');
      console.log('✓ Taste calibration gate passed for all seats.');
    }
  }

  const budget = new BudgetGuard(
    isMock ? Infinity : Number(arg('budget')),
    Infinity,
  );
  const client = isMock ? null : new OpenRouterClient();
  const nowIso = new Date().toISOString();
  const todo = plan.filter((p) => !hasTasteVerdict(runId, p.questionId, p.modelA, p.modelB));
  console.log(
    `Taste-judging ${todo.length} of ${plan.length} duels (${pairsPerQuestion}/question, resume-aware)${isMock ? ' [mock]' : ''}…`,
  );

  let flipflops = 0;
  const failures: string[] = [];
  await pool(todo, DEFAULTS.concurrency, async (p) => {
    const question = questionsById.get(p.questionId)!;
    const answers = answersByQuestion.get(p.questionId)!;
    let record: PairVerdictRecord;
    try {
      if (isMock) {
        const winner = mockTasteVerdict(p.modelA, p.modelB);
        const { tastePanelSeats } = await import('./tastejudge.js');
        const seats = tastePanelSeats(panel, p.modelA, p.modelB, question.id);
        record = {
          runId,
          questionId: p.questionId,
          modelA: p.modelA,
          modelB: p.modelB,
          promptVersion: TASTE_JUDGE_PROMPT_VERSION,
          judgedAt: nowIso,
          costUsd: 0,
          seats: seats.map((judgeModel) => ({
            judgeModel,
            forward: { winner, reason: 'mock' },
            reversed: { winner, reason: 'mock' },
            final: winner,
            positionConsistent: true,
          })),
        };
      } else {
        record = await judgePair(client!, panel, runId, question, p.modelA, p.modelB, answers, nowIso);
        budget.record('taste', record.costUsd);
      }
    } catch (error) {
      failures.push(`${p.questionId} ${p.modelA} vs ${p.modelB}: ${(error as Error).message.slice(0, 120)}`);
      return;
    }
    if (record.seats.some((s) => !s.positionConsistent)) flipflops++;
    writeTasteVerdict(record);
  });

  // Regenerate the derived artifacts from ALL stored verdicts (resume-consistent).
  const allVerdicts = readTasteVerdicts(runId);
  const votes: PanelTasteVote[] = allVerdicts.flatMap(pairVerdictToVotes);
  const summary = buildPanelSummary(runId, votes, {
    panel,
    pairsPerQuestion,
    mock: isMock,
    generatedAt: nowIso,
  });
  writeTastePanelArtifacts(runId, votes, summary);

  console.log(
    `✓ ${allVerdicts.length} duels judged → ${votes.length} panel votes${flipflops ? ` (${flipflops} position flip-flops → tie)` : ''}`,
  );
  if (failures.length > 0) {
    console.error(`✗ ${failures.length} duels failed (re-run to retry):`);
    for (const f of failures.slice(0, 10)) console.error(`    ${f}`);
  }
  const top = summary.ratings.slice(0, 5);
  if (top.length > 0) {
    console.log('\n  Critics’ panel (top 5 by rating):');
    for (const r of top) {
      console.log(`    ${r.modelId.padEnd(34)} ${r.rating.toFixed(0)}   ${r.battles} battles`);
    }
  }
  console.log(`\n✓ Artifacts in data/runs/${runId}/taste-panel/ (commit to publish)`);
}

async function cmdFlagged() {
  const runId = arg('run') ?? fail('flagged requires --run <id>');
  const questions = loadQuestions();
  const responses = readResponses(runId);
  const scores = readScores(runId);
  if (scores.length === 0) fail(`No scores for run ${runId} — grade and judge it first`);
  const { buildFlaggedReport, writeFlaggedReport } = await import('./flagged.js');
  const { markdown, count } = buildFlaggedReport(runId, questions, responses, scores);
  const path = writeFlaggedReport(runId, markdown);
  console.log(`✓ ${count} flagged answer${count === 1 ? '' : 's'} written to ${path.replace(REPO_ROOT + '/', '')}`);
  if (count === 0) console.log('  (No panel disagreements to review — nothing flagged.)');
}

async function cmdTasteArchive() {
  const { archiveTasteVotes } = await import('./taste.js');
  await archiveTasteVotes();
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
  flagged: cmdFlagged,
  'taste-estimate': cmdTasteEstimate,
  'taste-judge': cmdTasteJudge,
  'taste-archive': cmdTasteArchive,
};

const command = process.argv[2];
if (!command || !(command in COMMANDS)) {
  console.log(`CookingBench runner

Usage: pnpm bench <command> [options]

Commands:
  validate                       Validate the dataset (questions + models)
  models --check                 Check roster slugs against the live OpenRouter catalog
  estimate [--models all|a,b] [--limit N]
                                 Worst-case cost table; required before any paid run
  run --budget <usd> [--models all|a,b] [--limit N] [--run-id id] [--mock]
  grade --run <id>               Deterministic grading
  judge --run <id>               LLM-judge grading for subjective questions
  report --run <id>              Build the leaderboard JSON + print the table
  analyze --run <id> [--all true]  Item analysis: saturation, discrimination, anomalies
  flagged --run <id>             Export judge-disagreement answers for human review (markdown)
  sync [--run <id>]              Upsert dataset (and optionally a run) to Supabase
  publish --run <id>             Make a synced run publicly readable
  taste-estimate --run <id> [--pairs-per-question N] [--questions a,b]
                                 Worst-case cost of an LLM taste-panel run
  taste-judge --run <id> --budget <usd> [--pairs-per-question N] [--questions a,b] [--mock]
                                 Pairwise LLM taste judging → data/runs/<id>/taste-panel/
  taste-archive                  Snapshot all human taste votes into data/taste/ (commit to preserve)
  runs                           List stored runs`);
  process.exit(command ? 1 : 0);
}

Promise.resolve(COMMANDS[command]!()).catch((error) => fail((error as Error).message));
