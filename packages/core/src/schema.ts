import { z } from 'zod';
import { CATEGORY_IDS } from './types.js';

export const rubricCriterionSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  weight: z.number().positive().max(1),
});

export const numericTargetSchema = z.object({
  label: z.string().min(1),
  expected: z.number(),
  unit: z.string().optional(),
  tolerancePct: z.number().nonnegative().optional(),
  toleranceAbs: z.number().nonnegative().optional(),
});

const numericGrader = z.object({
  type: z.literal('numeric'),
  expected: z.number(),
  unit: z.string().optional(),
  tolerancePct: z.number().nonnegative().optional(),
  toleranceAbs: z.number().nonnegative().optional(),
  acceptEquivalentUnits: z.boolean().optional(),
});

const numericMultiGrader = z.object({
  type: z.literal('numeric-multi'),
  targets: z.array(numericTargetSchema).min(2),
  scoring: z.enum(['all-or-nothing', 'proportional']),
});

const rangeGrader = z.object({
  type: z.literal('range'),
  min: z.number(),
  max: z.number(),
  unit: z.string().optional(),
});

const keywordGrader = z.object({
  type: z.literal('keyword'),
  required: z.array(z.array(z.string().min(1)).min(1)).min(1),
  forbidden: z.array(z.string().min(1)).optional(),
});

const llmJudgeGrader = z.object({
  type: z.literal('llm-judge'),
  rubric: z
    .array(rubricCriterionSchema)
    .min(1)
    .refine(
      (rubric) =>
        Math.abs(rubric.reduce((sum, c) => sum + c.weight, 0) - 1) < 1e-6,
      { message: 'rubric weights must sum to 1' },
    ),
  constraintChecks: z
    .array(
      z.union([numericGrader, numericMultiGrader, rangeGrader, keywordGrader]),
    )
    .optional(),
  judgeWeight: z.number().positive().max(1).optional(),
});

export const graderSpecSchema = z.union([
  numericGrader,
  numericMultiGrader,
  rangeGrader,
  keywordGrader,
  llmJudgeGrader,
]);

export const questionSchema = z.object({
  id: z.string().regex(/^[a-z]+-\d{3}$/, 'id must look like "conv-007"'),
  category: z.enum(CATEGORY_IDS),
  difficulty: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  prompt: z.string().min(10),
  systemHint: z.string().optional(),
  grader: graderSpecSchema,
  referenceAnswer: z.string().min(1),
  source: z.string().optional(),
  public: z.boolean(),
});

export const questionFileSchema = z.array(questionSchema).min(1);

export const modelEntrySchema = z.object({
  id: z.string().regex(/^[\w.-]+\/[\w.:-]+$/, 'expected an OpenRouter slug like "anthropic/claude-fable-5"'),
  displayName: z.string().min(1),
  provider: z.string().min(1),
  family: z.string().optional(),
  releaseDate: z.string().optional(),
  active: z.boolean(),
});

export const modelsFileSchema = z.array(modelEntrySchema).min(1);
