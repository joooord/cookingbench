import type { Question, RubricCriterion } from '@cookingbench/core';
import type { CompletionClient } from './openrouter.js';

export const JUDGE_PROMPT_VERSION = 'judge-v1';

/** Strip phrases that could reveal which model wrote the answer. */
export function anonymizeAnswer(text: string): string {
  return text.replace(
    /\b(?:as|i(?:'| a)?m)\s+(?:chatgpt|gpt-?[\d.]*|claude|gemini|grok|llama|deepseek|kimi|qwen|mistral|an? (?:ai|large language model|assistant) (?:developed|made|created|trained) by [\w\s]+?)(?=[,.\s])/gi,
    '[assistant]',
  );
}

function rubricBlock(rubric: RubricCriterion[]): string {
  return rubric
    .map((c) => `- "${c.name}" (weight ${c.weight}): ${c.description}`)
    .join('\n');
}

export function buildJudgeMessages(question: Question, answerText: string) {
  if (question.grader.type !== 'llm-judge') {
    throw new Error(`Question ${question.id} is not judge-graded`);
  }
  const system = [
    'You are a strict, fair culinary examiner grading an anonymous AI assistant’s answer to a cooking question.',
    'Score each rubric criterion from 0 (completely fails) to 5 (exemplary), using the per-criterion descriptions as the standard.',
    'Judge only what is written. Do not reward verbosity. Penalize confident errors more than honest hedging.',
    'Respond with STRICT JSON only, no markdown: {"scores": {"<criterion name>": <0-5>, ...}, "justification": "<2-3 sentences>"}',
  ].join('\n');
  const user = [
    `QUESTION:\n${question.prompt}`,
    `REFERENCE ANSWER (the standard to compare against):\n${question.referenceAnswer}`,
    `RUBRIC:\n${rubricBlock(question.grader.rubric)}`,
    `CANDIDATE ANSWER:\n${anonymizeAnswer(answerText)}`,
  ].join('\n\n');
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export interface JudgeVerdict {
  /** Weighted 0–100. */
  score: number;
  criterionScores: Record<string, number>;
  justification: string;
}

export function parseJudgeResponse(question: Question, text: string): JudgeVerdict {
  if (question.grader.type !== 'llm-judge') {
    throw new Error(`Question ${question.id} is not judge-graded`);
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Judge returned no JSON for ${question.id}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as {
    scores: Record<string, number>;
    justification?: string;
  };
  let weighted = 0;
  const criterionScores: Record<string, number> = {};
  for (const criterion of question.grader.rubric) {
    const raw = parsed.scores[criterion.name];
    if (typeof raw !== 'number' || raw < 0 || raw > 5) {
      throw new Error(`Judge gave invalid score for "${criterion.name}" on ${question.id}`);
    }
    criterionScores[criterion.name] = raw;
    weighted += (raw / 5) * criterion.weight;
  }
  return {
    score: weighted * 100,
    criterionScores,
    justification: parsed.justification ?? '',
  };
}

/**
 * Judge an answer twice and average (cheap variance reduction); flags large
 * disagreement for manual review.
 */
export async function judgeAnswer(
  client: CompletionClient,
  judgeModel: string,
  question: Question,
  answerText: string,
): Promise<JudgeVerdict & { disagreement: number; flagged: boolean }> {
  const messages = buildJudgeMessages(question, answerText);
  const verdicts: JudgeVerdict[] = [];
  for (let i = 0; i < 2; i++) {
    // Reasoning judges can burn the whole token cap on hidden thinking, so cap
    // effort low, leave headroom, and retry once on truncated/invalid output.
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await client.complete(judgeModel, messages, {
        temperature: 0,
        maxTokens: 2000,
        reasoning: { effort: 'low' },
      });
      try {
        verdicts.push(parseJudgeResponse(question, result.text));
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err as Error;
      }
    }
    if (lastError) throw lastError;
  }
  const [a, b] = verdicts as [JudgeVerdict, JudgeVerdict];
  const disagreement = Math.abs(a.score - b.score);
  const criterionScores: Record<string, number> = {};
  for (const name of Object.keys(a.criterionScores)) {
    criterionScores[name] = (a.criterionScores[name]! + b.criterionScores[name]!) / 2;
  }
  return {
    score: (a.score + b.score) / 2,
    criterionScores,
    justification: a.justification,
    disagreement,
    flagged: disagreement > 20, // > 1 criterion-point on the 0–100 scale
  };
}
