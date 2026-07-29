import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  modelsFileSchema,
  questionFileSchema,
  type ModelEntry,
  type Question,
} from '@cookingbench/core';

export const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
export const DATA_DIR = join(REPO_ROOT, 'data');
export const RUNS_DIR = join(DATA_DIR, 'runs');

export function loadQuestions(): Question[] {
  const dir = join(DATA_DIR, 'questions');
  const questions: Question[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.yaml')).sort()) {
    const raw = parse(readFileSync(join(dir, file), 'utf8'));
    const parsed = questionFileSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`Invalid questions in ${file}:\n${parsed.error.message}`);
    }
    questions.push(...(parsed.data as Question[]));
  }
  const seen = new Set<string>();
  for (const q of questions) {
    if (seen.has(q.id)) throw new Error(`Duplicate question id: ${q.id}`);
    seen.add(q.id);
  }
  return questions;
}

export function loadModels(): ModelEntry[] {
  const raw = parse(readFileSync(join(DATA_DIR, 'models.yaml'), 'utf8'));
  const parsed = modelsFileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid models.yaml:\n${parsed.error.message}`);
  }
  const models = parsed.data as ModelEntry[];
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) throw new Error(`Duplicate model id: ${m.id}`);
    seen.add(m.id);
  }
  return models;
}

/** Everything a run executes: active + basics. Retired items never run again. */
export function runnableQuestions(tier: 'all' | 'active' = 'all'): Question[] {
  const runnable = loadQuestions().filter((q) => q.status !== 'retired');
  // `basics` is a regression gate, excluded from Overall by design — so on a
  // routine run it is 82 of 184 questions buying nothing that affects the
  // ranking. Worth re-running when a model is new to the roster, or when you
  // want the gate figure; not worth it every time.
  return tier === 'active' ? runnable.filter((q) => q.status === 'active') : runnable;
}

const BASE_SYSTEM_PROMPT =
  'You are a knowledgeable cooking assistant. Answer the question accurately and concisely.';

export function buildMessages(question: Question) {
  const system = question.systemHint
    ? `${BASE_SYSTEM_PROMPT}\n${question.systemHint}`
    : BASE_SYSTEM_PROMPT;
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: question.prompt },
  ];
}

export function maxTokensFor(_question: Question, config: { maxTokens: number; maxTokensRecipe: number }) {
  // v2: one flat cap for every category (the old recipe split is kept in the
  // config shape only for v1 artifact compatibility).
  return config.maxTokens;
}
