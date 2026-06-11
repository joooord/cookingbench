import type { Question } from '@cookingbench/core';
import type { CompletionClient } from './openrouter.js';

export const JUDGE_PROMPT_VERSION = 'judge-v2';

/**
 * judge-v2: reference-anchored deduction grading. The judge only enumerates
 * concrete faults; the severity→points arithmetic lives here, in code. v1's
 * absolute 0–5 rubric saturated (75% of judged answers got every criterion
 * perfect); finding faults is the discriminating task.
 */
export const SEVERITY_POINTS = { critical: 40, major: 15, minor: 5 } as const;
export type Severity = keyof typeof SEVERITY_POINTS;

export interface JudgeFinding {
  quote: string;
  issue: string;
  severity: Severity;
}

export interface JudgeVerdict {
  /** 0–100: 100 minus severity deductions, floored at 0. */
  score: number;
  findings: JudgeFinding[];
  summary: string;
}

/** Strip phrases that could reveal which model wrote the answer. */
export function anonymizeAnswer(text: string): string {
  return text.replace(
    /\b(?:as|i(?:'| a)?m)\s+(?:chatgpt|gpt-?[\d.]*|claude|gemini|grok|llama|deepseek|kimi|qwen|mistral|an? (?:ai|large language model|assistant) (?:developed|made|created|trained) by [\w\s]+?)(?=[,.\s])/gi,
    '[assistant]',
  );
}

/** judge-v2 attention hints: explicit judgingNotes, else the v1 rubric descriptions. */
function attentionHints(question: Question): string | undefined {
  if (question.judgingNotes) return question.judgingNotes;
  if (question.grader.type === 'llm-judge' && question.grader.rubric) {
    return question.grader.rubric.map((c) => `${c.name}: ${c.description.trim()}`).join('\n');
  }
  return undefined;
}

export function buildJudgeMessages(question: Question, answerText: string) {
  if (question.grader.type !== 'llm-judge') {
    throw new Error(`Question ${question.id} is not judge-graded`);
  }
  const system = [
    'You are a meticulous culinary fact-checker. Compare the CANDIDATE ANSWER against the QUESTION and REFERENCE ANSWER and list every concrete error, omission, or constraint violation. Do not award points — only find faults.',
    'Severity definitions:',
    '- critical: dangerous advice, a violated hard constraint (allergen, dietary rule, equipment, serving count), or an error that would ruin the dish.',
    '- major: a materially wrong quantity/temperature/time/technique claim, or a missing element the question explicitly required.',
    '- minor: imprecision, a small omission, or an unclear instruction that a competent cook would survive.',
    'Do not list style, verbosity, or formatting as faults. The reference shows ONE good answer, not the only one — a different but equally sound approach is not a fault. Do not invent faults to seem rigorous: an answer that is sound and complete has zero findings.',
    'Respond with STRICT JSON only, no markdown:',
    '{"findings":[{"quote":"<≤15 words quoted from the candidate, or \'omission\'>","issue":"<what is wrong>","severity":"critical|major|minor"}],"summary":"<1-2 sentences>"}',
  ].join('\n');
  const hints = attentionHints(question);
  const user = [
    `QUESTION:\n${question.prompt}`,
    `REFERENCE ANSWER (one sound answer, for comparison):\n${question.referenceAnswer}`,
    ...(hints ? [`PAY PARTICULAR ATTENTION TO:\n${hints}`] : []),
    `CANDIDATE ANSWER:\n${anonymizeAnswer(answerText)}`,
  ].join('\n\n');
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export function parseJudgeResponse(question: Question, text: string): JudgeVerdict {
  if (question.grader.type !== 'llm-judge') {
    throw new Error(`Question ${question.id} is not judge-graded`);
  }
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Judge returned no JSON for ${question.id}: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as {
    findings?: Array<{ quote?: string; issue?: string; severity?: string }>;
    summary?: string;
  };
  if (!Array.isArray(parsed.findings)) {
    throw new Error(`Judge JSON missing findings[] for ${question.id}`);
  }
  const findings: JudgeFinding[] = parsed.findings.map((f) => {
    const severity = f.severity as Severity;
    if (!(severity in SEVERITY_POINTS)) {
      throw new Error(`Judge gave invalid severity "${f.severity}" on ${question.id}`);
    }
    return { quote: f.quote ?? '', issue: f.issue ?? '', severity };
  });
  const deductions = findings.reduce((sum, f) => sum + SEVERITY_POINTS[f.severity], 0);
  return {
    score: Math.max(0, 100 - deductions),
    findings,
    summary: parsed.summary ?? '',
  };
}

/**
 * Judge an answer twice and average; flags large score disagreement for
 * manual review. Both verdicts are returned for the published artifact.
 */
export async function judgeAnswer(
  client: CompletionClient,
  judgeModel: string,
  question: Question,
  answerText: string,
): Promise<JudgeVerdict & { verdicts: JudgeVerdict[]; disagreement: number; flagged: boolean }> {
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
  return {
    score: (a.score + b.score) / 2,
    findings: a.findings,
    summary: a.summary,
    verdicts,
    disagreement,
    flagged: disagreement > 15,
  };
}
