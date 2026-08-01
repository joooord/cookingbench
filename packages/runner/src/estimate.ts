import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXPECTED_OUTPUT_TOKENS, estimateModelCost, type Question } from '@cookingbench/core';
import { DATA_DIR, buildMessages, maxTokensFor } from './dataset.js';
import { fetchCatalog, type CatalogModel } from './openrouter.js';
import type { VerifiedGrant } from './permit.js';

const ESTIMATE_PATH = join(DATA_DIR, '.estimate.json');
const ESTIMATE_TTL_MS = 24 * 60 * 60 * 1000;

export interface EstimateRecord {
  hash: string;
  atIso: string;
  totalWorstCaseUsd: number;
  totalExpectedUsd: number;
  perModel: Array<{ modelId: string; calls: number; worstCaseUsd: number; expectedUsd: number }>;
}

type Catalog = ReadonlyMap<string, CatalogModel>;

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

function calculateEstimate(
  modelIds: string[],
  questions: Question[],
  config: { maxTokens: number; maxTokensRecipe: number },
  catalog: Catalog,
  atIso: string,
): EstimateRecord {
  const prompts = questions.map((q) => ({
    text: buildMessages(q)
      .map((m) => m.content)
      .join('\n'),
    maxTokens: maxTokensFor(q, config),
    expectedTokens:
      q.category === 'recipe-generation'
        ? EXPECTED_OUTPUT_TOKENS.recipe
        : EXPECTED_OUTPUT_TOKENS.normal,
  }));

  const perModel: EstimateRecord['perModel'] = [];
  let total = 0;
  let expected = 0;
  const missing: string[] = [];
  for (const modelId of modelIds) {
    const entry = catalog.get(modelId);
    if (!entry) {
      missing.push(modelId);
      continue;
    }
    if (
      !Number.isFinite(entry.pricing.promptUsd) ||
      entry.pricing.promptUsd < 0 ||
      !Number.isFinite(entry.pricing.completionUsd) ||
      entry.pricing.completionUsd < 0
    ) {
      throw new Error(`OpenRouter returned invalid pricing for ${modelId}; refusing to estimate from it.`);
    }
    const cost = estimateModelCost(prompts, entry.pricing);
    perModel.push({ modelId, calls: cost.calls, worstCaseUsd: cost.worstCaseUsd, expectedUsd: cost.expectedUsd });
    total += cost.worstCaseUsd;
    expected += cost.expectedUsd;
  }
  if (missing.length > 0) {
    throw new Error(
      `These model slugs are not in the OpenRouter catalog (fix data/models.yaml): ${missing.join(', ')}`,
    );
  }
  const record: EstimateRecord = {
    hash: estimateHash(modelIds, questions, config.maxTokens, config.maxTokensRecipe),
    atIso,
    totalWorstCaseUsd: total,
    totalExpectedUsd: expected,
    perModel,
  };
  return record;
}

export async function runEstimate(
  grant: VerifiedGrant,
  modelIds: string[],
  questions: Question[],
  config: { maxTokens: number; maxTokensRecipe: number },
): Promise<EstimateRecord> {
  // Live pricing is an outbound request, so it needs `catalog-read` like any
  // other network route.
  const catalog = await fetchCatalog(grant);
  const record = calculateEstimate(modelIds, questions, config, catalog, new Date().toISOString());
  writeFileSync(ESTIMATE_PATH, JSON.stringify(record, null, 2));
  return record;
}

function parseEstimateRecord(raw: string): EstimateRecord {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('The saved estimate is not valid JSON. Re-run `pnpm bench estimate`.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The saved estimate has the wrong shape. Re-run `pnpm bench estimate`.');
  }
  const record = value as Partial<EstimateRecord>;
  const validAmount = (amount: unknown): amount is number =>
    typeof amount === 'number' && Number.isFinite(amount) && amount >= 0;
  if (
    typeof record.hash !== 'string' ||
    typeof record.atIso !== 'string' ||
    !validAmount(record.totalWorstCaseUsd) ||
    !validAmount(record.totalExpectedUsd) ||
    !Array.isArray(record.perModel) ||
    record.perModel.some(
      (row) =>
        typeof row !== 'object' ||
        row === null ||
        typeof row.modelId !== 'string' ||
        !Number.isInteger(row.calls) ||
        row.calls < 0 ||
        !validAmount(row.worstCaseUsd) ||
        !validAmount(row.expectedUsd),
    )
  ) {
    throw new Error('The saved estimate has invalid fields. Re-run `pnpm bench estimate`.');
  }
  return record as EstimateRecord;
}

function samePricedWork(saved: EstimateRecord, current: EstimateRecord): boolean {
  if (
    saved.totalWorstCaseUsd !== current.totalWorstCaseUsd ||
    saved.totalExpectedUsd !== current.totalExpectedUsd ||
    saved.perModel.length !== current.perModel.length
  ) {
    return false;
  }
  return saved.perModel.every((row, index) => {
    const expected = current.perModel[index];
    return (
      expected !== undefined &&
      row.modelId === expected.modelId &&
      row.calls === expected.calls &&
      row.worstCaseUsd === expected.worstCaseUsd &&
      row.expectedUsd === expected.expectedUsd
    );
  });
}

/**
 * The run gate: a paid run refuses to start unless a fresh estimate matching
 * the exact model set, question set and token caps exists.
 */
export async function assertFreshEstimate(
  grant: VerifiedGrant,
  modelIds: string[],
  questions: Question[],
  config: { maxTokens: number; maxTokensRecipe: number },
): Promise<EstimateRecord> {
  if (!existsSync(ESTIMATE_PATH)) {
    throw new Error('No cost estimate found. Run `pnpm bench estimate` first.');
  }
  const record = parseEstimateRecord(readFileSync(ESTIMATE_PATH, 'utf8'));
  const expected = estimateHash(modelIds, questions, config.maxTokens, config.maxTokensRecipe);
  if (record.hash !== expected) {
    throw new Error(
      'The saved estimate does not match this run (models/questions/token caps changed). Re-run `pnpm bench estimate`.',
    );
  }
  if (Date.now() - Date.parse(record.atIso) > ESTIMATE_TTL_MS) {
    throw new Error('The saved estimate is older than 24h. Re-run `pnpm bench estimate`.');
  }
  if (!Number.isFinite(Date.parse(record.atIso)) || Date.parse(record.atIso) > Date.now() + 5 * 60 * 1000) {
    throw new Error('The saved estimate has an invalid or future timestamp. Re-run `pnpm bench estimate`.');
  }

  // The file is a convenience record, not its own authority. Re-price the
  // exact work against the live catalogue under the run's verified grant and
  // compare every money-bearing field. A hand-written low estimate can no
  // longer buy a run: it either matches the live arithmetic or this refuses
  // before permit redemption, client construction or candidate inference.
  const catalog = await fetchCatalog(grant);
  const current = calculateEstimate(modelIds, questions, config, catalog, record.atIso);
  if (!samePricedWork(record, current)) {
    throw new Error(
      'The saved estimate no longer matches live catalogue pricing or its priced work. Re-run `pnpm bench estimate`.',
    );
  }
  return record;
}
