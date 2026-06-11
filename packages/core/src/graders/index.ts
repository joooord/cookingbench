import type { GradeResult, GraderSpec, Question } from '../types.js';
import { gradeKeyword } from './keyword.js';
import { gradeNumeric, gradeNumericMulti, gradeRange } from './numeric.js';

export { extractQuantities, findAnswerLine, gradableScope } from './extract.js';
export { convert, dimensionOf, normalizeUnit } from './units.js';
export { gradeKeyword } from './keyword.js';
export { gradeNumeric, gradeNumericMulti, gradeRange } from './numeric.js';

export function gradeSpec(
  spec: GraderSpec,
  answerText: string,
  promptText?: string,
): GradeResult {
  switch (spec.type) {
    case 'numeric':
      return gradeNumeric(spec, answerText, promptText);
    case 'numeric-multi':
      return gradeNumericMulti(spec, answerText, promptText);
    case 'range':
      return gradeRange(spec, answerText, promptText);
    case 'keyword':
      return gradeKeyword(spec, answerText);
    case 'llm-judge':
      throw new Error('llm-judge questions are graded by the judge pipeline, not gradeSpec');
  }
}

/**
 * Grade everything that can be graded without an LLM. For llm-judge questions
 * this returns only the deterministic constraint-check component (or null if
 * there is none); the judge pipeline blends it later via blendJudgeScore.
 */
export function gradeDeterministic(
  question: Question,
  answerText: string,
): GradeResult | null {
  const { grader, prompt } = question;
  if (grader.type !== 'llm-judge') {
    return gradeSpec(grader, answerText, prompt);
  }
  if (!grader.constraintChecks || grader.constraintChecks.length === 0) return null;
  const results = grader.constraintChecks.map((c) => gradeSpec(c, answerText, prompt));
  const mean = results.reduce((s, r) => s + r.score, 0) / results.length;
  return { score: mean, detail: { constraintChecks: results } };
}

/**
 * Combine a 0–100 judge score with the deterministic constraint score for an
 * llm-judge question. judgeWeight defaults to 0.7 when constraint checks exist.
 */
export function blendJudgeScore(
  question: Question,
  judgeScore: number,
  constraintScore: number | null,
): number {
  const grader = question.grader;
  if (grader.type !== 'llm-judge') {
    throw new Error(`blendJudgeScore called on ${grader.type} question ${question.id}`);
  }
  if (constraintScore === null) return judgeScore;
  const w = grader.judgeWeight ?? 0.7;
  return w * judgeScore + (1 - w) * constraintScore;
}
