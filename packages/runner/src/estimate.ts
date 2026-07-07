import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { estimateModelCost, type Question } from '@cookingbench/core';
import { DATA_DIR, buildMessages, maxTokensFor } from './dataset.js';
import { fetchCatalog } from './openrouter.js';

const ESTIMATE_PATH = join(DATA_DIR, '.estimate.json');
const TASTE_ESTIMATE_PATH = join(DATA_DIR, '.estimate-taste.json');
const ESTIMATE_TTL_MS = 24 * 60 * 60 * 1000;

export interface EstimateRecord {
  hash: string;
  atIso: string;
  totalWorstCaseUsd: number;
  perModel: Array<{ modelId: string; calls: number; worstCaseUsd: number }>;
}

export function estimateHash(
  modelIds: string[],
  questions: Question[],
  maxTokens: number,
  maxTokensRecipe: number,
): string {
  const h = createHash('sha256');
  h.update(JSON.stringify([...modelIds].sort()));
  h.update(JSON.stringify(questions.map((q) => q.id).sort()));
  h.update(`${maxTokens}:${maxTokensRecipe}`);
  return h.digest('hex').slice(0, 16);
}

export async function runEstimate(
  modelIds: string[],
  questions: Question[],
  config: { maxTokens: number; maxTokensRecipe: number },
): Promise<EstimateRecord> {
  const catalog = await fetchCatalog();
  const prompts = questions.map((q) => ({
    text: buildMessages(q)
      .map((m) => m.content)
      .join('\n'),
    maxTokens: maxTokensFor(q, config),
  }));

  const perModel: EstimateRecord['perModel'] = [];
  let total = 0;
  const missing: string[] = [];
  for (const modelId of modelIds) {
    const entry = catalog.get(modelId);
    if (!entry) {
      missing.push(modelId);
      continue;
    }
    const cost = estimateModelCost(prompts, entry.pricing);
    perModel.push({ modelId, calls: cost.calls, worstCaseUsd: cost.worstCaseUsd });
    total += cost.worstCaseUsd;
  }
  if (missing.length > 0) {
    throw new Error(
      `These model slugs are not in the OpenRouter catalog (fix data/models.yaml): ${missing.join(', ')}`,
    );
  }
  const record: EstimateRecord = {
    hash: estimateHash(modelIds, questions, config.maxTokens, config.maxTokensRecipe),
    atIso: new Date().toISOString(),
    totalWorstCaseUsd: total,
    perModel,
  };
  writeFileSync(ESTIMATE_PATH, JSON.stringify(record, null, 2));
  return record;
}

// ── Taste-panel estimate gate ──

export interface TasteEstimateRecord {
  hash: string;
  atIso: string;
  panel: string[];
  pairs: number;
  /** Two seats × two orders (forward + swapped) per pair. */
  judgeCalls: number;
  totalWorstCaseUsd: number;
}

/** Stable hash over the panel, the exact planned pair keys, and the token cap. */
export function tasteEstimateHash(
  panel: string[],
  pairKeys: string[],
  maxTokens: number,
): string {
  const h = createHash('sha256');
  h.update(JSON.stringify([...panel].sort()));
  h.update(JSON.stringify([...pairKeys].sort()));
  h.update(`${maxTokens}`);
  return h.digest('hex').slice(0, 16);
}

/**
 * Worst-case cost of a taste-panel run. Each planned pair is judged by 2 seats,
 * each seat in 2 orders (4 judge calls/pair), and every call is priced at its
 * full token cap against the live catalog. The `promptChars` estimate is the
 * mean built-message length across the plan.
 */
export async function runTasteEstimate(
  panel: string[],
  pairKeys: string[],
  meanPromptChars: number,
  maxTokens: number,
): Promise<TasteEstimateRecord> {
  const catalog = await fetchCatalog();
  const missing = panel.filter((id) => !catalog.get(id));
  if (missing.length > 0) {
    throw new Error(`Taste judge slugs not in the OpenRouter catalog: ${missing.join(', ')}`);
  }
  const callsPerPair = 4; // 2 seats × 2 orders
  const judgeCalls = pairKeys.length * callsPerPair;
  // Each pair uses 2 of the panel's seats; price the whole panel's mean per-call
  // cost as an upper bound (the actual seats are a subset, so this over-counts).
  const meanPromptTokens = meanPromptChars / 4;
  const meanCallUsd =
    panel
      .map((id) => catalog.get(id)!.pricing)
      .reduce((s, p) => s + meanPromptTokens * p.promptUsd + maxTokens * p.completionUsd, 0) /
    panel.length;
  const total = judgeCalls * meanCallUsd;
  const record: TasteEstimateRecord = {
    hash: tasteEstimateHash(panel, pairKeys, maxTokens),
    atIso: new Date().toISOString(),
    panel,
    pairs: pairKeys.length,
    judgeCalls,
    totalWorstCaseUsd: total,
  };
  writeFileSync(TASTE_ESTIMATE_PATH, JSON.stringify(record, null, 2));
  return record;
}

export function assertFreshTasteEstimate(
  panel: string[],
  pairKeys: string[],
  maxTokens: number,
): TasteEstimateRecord {
  if (!existsSync(TASTE_ESTIMATE_PATH)) {
    throw new Error('No taste estimate found. Run `pnpm bench taste-estimate --run <id>` first.');
  }
  const record = JSON.parse(readFileSync(TASTE_ESTIMATE_PATH, 'utf8')) as TasteEstimateRecord;
  if (record.hash !== tasteEstimateHash(panel, pairKeys, maxTokens)) {
    throw new Error(
      'The saved taste estimate does not match this run (panel/pairs/token cap changed). Re-run `pnpm bench taste-estimate`.',
    );
  }
  if (Date.now() - Date.parse(record.atIso) > ESTIMATE_TTL_MS) {
    throw new Error('The saved taste estimate is older than 24h. Re-run `pnpm bench taste-estimate`.');
  }
  return record;
}

/**
 * The run gate: a paid run refuses to start unless a fresh estimate matching
 * the exact model set, question set and token caps exists.
 */
export function assertFreshEstimate(
  modelIds: string[],
  questions: Question[],
  config: { maxTokens: number; maxTokensRecipe: number },
): EstimateRecord {
  if (!existsSync(ESTIMATE_PATH)) {
    throw new Error('No cost estimate found. Run `pnpm bench estimate` first.');
  }
  const record = JSON.parse(readFileSync(ESTIMATE_PATH, 'utf8')) as EstimateRecord;
  const expected = estimateHash(modelIds, questions, config.maxTokens, config.maxTokensRecipe);
  if (record.hash !== expected) {
    throw new Error(
      'The saved estimate does not match this run (models/questions/token caps changed). Re-run `pnpm bench estimate`.',
    );
  }
  if (Date.now() - Date.parse(record.atIso) > ESTIMATE_TTL_MS) {
    throw new Error('The saved estimate is older than 24h. Re-run `pnpm bench estimate`.');
  }
  return record;
}
