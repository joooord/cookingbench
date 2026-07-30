import { canonicalId, hasJudgeConflict, type Question } from '@cookingbench/core';
import type { CompletionClient } from './openrouter.js';

export const JUDGE_PROMPT_VERSION = 'judge-v2';

/**
 * judge-v2: reference-anchored deduction grading. The judge only enumerates
 * concrete faults; the severity→points arithmetic lives here, in code. v1's
 * absolute 0–5 rubric saturated (75% of judged answers got every criterion
 * perfect); finding faults is the discriminating task.
 */
export const SEVERITY_POINTS = { critical: 40, major: 15, minor: 5 } as const;

/**
 * Reserved per judge call before it is made. Measured: 1,260 judge calls in
 * 2026-07-v2.1 cost $14.19, about $0.011 each; this is a deliberate ceiling
 * over that, since a reservation that undershoots lets the cap be passed.
 */
export const JUDGE_WORST_CASE_PER_CALL_USD = 0.05;
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
    'List each DISTINCT underlying mistake exactly once. If one root error shows up in several places (a forbidden ingredient in the list and again in the steps, or one wrong claim repeated), report it as a single finding, not several.',
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
 * Every judge call costs money, so the caller has to see it even when the
 * call fails — a parse failure burns three of these.
 */
export interface JudgeSpend {
  costUsd: number;
}

/** One verdict from one judge, with empty/truncated-output escalation. */
async function singleVerdict(
  client: CompletionClient,
  judgeModel: string,
  question: Question,
  answerText: string,
  spend: JudgeSpend,
): Promise<JudgeVerdict> {
  const messages = buildJudgeMessages(question, answerText);
  // Reasoning judges can burn the whole token cap on hidden thinking or
  // return empty text outright: cap effort low, escalate tokens on retry.
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await client.complete(judgeModel, messages, {
      temperature: 0,
      maxTokens: 2000 * (attempt + 1),
      reasoning: { effort: 'low' },
      // Carried through so the permit's cell list and the reservation ledger
      // apply to judge calls too. A judging pass is paid work like any other.
      questionId: question.id,
      estimateUsd: JUDGE_WORST_CASE_PER_CALL_USD,
    });
    spend.costUsd += result.costUsd;
    try {
      return parseJudgeResponse(question, result.text);
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error(`Judge ${judgeModel} failed on ${question.id}`);
}

/**
 * JUDGE-001. Where a model's conflict identity comes from.
 *
 * Seating used to compare the OpenRouter slug prefix — `anthropic/claude-x` vs
 * `openai/gpt-x` — which is a routing detail, not an identity. It misses the
 * case the rule exists for: a model served under one vendor's prefix that is
 * another vendor's base model underneath, or two entries of the same family
 * shipped under different prefixes. `hasJudgeConflict` compares the declared
 * provider AND the base-model family, and treats a MISSING identity as a
 * conflict rather than as conflict-free.
 */
export interface JudgeIdentity {
  provider: string;
  baseModelFamily: string;
}
export type IdentityOf = (modelId: string) => JudgeIdentity | undefined;

/**
 * Build a lookup from the roster. Structural on purpose so this module does not
 * need the dataset loader — judge.ts stays free of filesystem imports.
 */
export function identityIndex(
  models: ReadonlyArray<{ id: string; provider: string; family?: string }>,
): IdentityOf {
  const index = new Map<string, JudgeIdentity>();
  for (const m of models) {
    // A model with no declared family has no identity, and no identity means
    // conflict everywhere. Recorded as undefined rather than defaulted to the
    // slug, which would manufacture a distinctness that was never declared.
    if (m.family) index.set(m.id, { provider: m.provider, baseModelFamily: m.family });
  }
  return (modelId) => index.get(modelId);
}

/** Deterministic 32-bit FNV-1a hash — seat assignment must be reproducible. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pick two panel seats for a (candidate, question) pair:
 * - a judge NEVER scores a model sharing its provider OR its base-model family
 *   (self-preference bias), and an undeclared identity counts as a conflict;
 * - otherwise the excluded seat rotates deterministically by hash, so seat
 *   load is balanced and any published score is reproducible.
 */
export function panelSeats(
  panel: string[],
  candidateModelId: string,
  questionId: string,
  identify: IdentityOf,
): string[] {
  const candidate = identify(candidateModelId);
  const eligible = panel.filter((seat) => !hasJudgeConflict(identify(seat) ?? {}, candidate ?? {}));
  if (eligible.length <= 2) return eligible;
  const drop = fnv1a(`${candidateModelId}|${questionId}`) % eligible.length;
  return eligible.filter((_, i) => i !== drop);
}

/** Why a seat was excluded, for the diagnostic when too few remain. */
function conflictReason(seatId: string, candidateId: string, identify: IdentityOf): string {
  const seat = identify(seatId);
  const candidate = identify(candidateId);
  if (!seat) return `${seatId}: no declared identity in the roster`;
  if (!candidate) return `${candidateId}: no declared identity in the roster`;
  if (canonicalId(seat.provider) === canonicalId(candidate.provider)) {
    return `${seatId}: same provider (${seat.provider})`;
  }
  if (canonicalId(seat.baseModelFamily) === canonicalId(candidate.baseModelFamily)) {
    return `${seatId}: same base-model family (${seat.baseModelFamily})`;
  }
  return `${seatId}: eligible`;
}

export interface PanelVerdict extends JudgeVerdict {
  judges: string[];
  verdicts: Array<JudgeVerdict & { judgeModel: string }>;
  disagreement: number;
  flagged: boolean;
  /** What this answer cost to judge, including retries on a failed seat. */
  costUsd: number;
}

/**
 * Panel judging: two distinct judges score each answer once; the mean is the
 * score, and large cross-judge disagreement is flagged for human review.
 */
export async function judgeAnswerPanel(
  client: CompletionClient,
  panel: string[],
  candidateModelId: string,
  question: Question,
  answerText: string,
  identify: IdentityOf,
  spend: JudgeSpend = { costUsd: 0 },
): Promise<PanelVerdict> {
  const seats = panelSeats(panel, candidateModelId, question.id, identify);
  if (seats.length < 2) {
    // Name WHY each seat was dropped. The likeliest cause is an incomplete
    // roster rather than a genuinely small panel, and "panel too small" sends
    // you looking in the wrong place — including at the temptation to relax the
    // conflict rule, which is the one thing that must not happen here.
    throw new Error(
      `Only ${seats.length} non-conflicted judge(s) for ${candidateModelId} on ${question.id}; two are required.\n` +
        panel.map((seat) => `  ${conflictReason(seat, candidateModelId, identify)}`).join('\n'),
    );
  }
  const before = spend.costUsd;
  const verdicts = await Promise.all(
    seats.map(async (judgeModel) => ({
      judgeModel,
      ...(await singleVerdict(client, judgeModel, question, answerText, spend)),
    })),
  );
  const [a, b] = verdicts as [PanelVerdict['verdicts'][number], PanelVerdict['verdicts'][number]];
  const disagreement = Math.abs(a.score - b.score);
  return {
    score: (a.score + b.score) / 2,
    // Both seats' findings, tagged — the headline score is the two-seat mean,
    // so attributing it to seat A's findings alone (the pre-v3 behaviour) left
    // 78 rows with a sub-100 score and an empty findings list, which is the
    // first thing the human-review layer reads.
    findings: verdicts.flatMap((v) => v.findings.map((f) => ({ ...f, judgeModel: v.judgeModel }))),
    summary: verdicts.map((v) => `${v.judgeModel}: ${v.summary}`).join('\n'),
    judges: seats,
    verdicts,
    disagreement,
    flagged: disagreement > 15,
    costUsd: spend.costUsd - before,
  };
}

/**
 * Single-judge double-scoring (used by the calibration gate, which calibrates
 * each panel member independently).
 */
export async function judgeAnswer(
  client: CompletionClient,
  judgeModel: string,
  question: Question,
  answerText: string,
  spend: JudgeSpend = { costUsd: 0 },
): Promise<
  JudgeVerdict & { verdicts: JudgeVerdict[]; disagreement: number; flagged: boolean; costUsd: number }
> {
  const before = spend.costUsd;
  const verdicts: JudgeVerdict[] = [];
  for (let i = 0; i < 2; i++) {
    verdicts.push(await singleVerdict(client, judgeModel, question, answerText, spend));
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
    costUsd: spend.costUsd - before,
  };
}
