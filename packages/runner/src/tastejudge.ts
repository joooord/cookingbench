import type { PanelTasteVote, Question, TasteRating } from '@cookingbench/core';
import { computeTasteRatings, mulberry32 } from '@cookingbench/core';
import { anonymizeAnswer, fnv1a, providerOf } from './judge.js';
import type { CompletionClient } from './openrouter.js';

export const TASTE_JUDGE_PROMPT_VERSION = 'taste-judge-v1';

export type TasteWinner = 'a' | 'b' | 'tie';

export interface TasteJudgeVerdict {
  winner: TasteWinner;
  reason: string;
}

export interface PairSeatVerdict {
  judgeModel: string;
  /** A = modelA's answer, B = modelB's answer. */
  forward: TasteJudgeVerdict;
  /** Judged with positions swapped, then mapped back to canonical A/B. */
  reversed: TasteJudgeVerdict;
  /** Collapsed verdict: the agreed winner, or 'tie' when the seat flip-flopped. */
  final: TasteWinner;
  positionConsistent: boolean;
}

export interface PairVerdictRecord {
  runId: string;
  questionId: string;
  /** Canonical order: modelA < modelB (string compare). */
  modelA: string;
  modelB: string;
  promptVersion: string;
  judgedAt: string;
  costUsd: number;
  seats: PairSeatVerdict[];
}

export interface PlannedPair {
  questionId: string;
  modelA: string;
  modelB: string;
}

export interface TastePanelSummary {
  runId: string;
  generatedAt: string;
  promptVersion: string;
  panel: string[];
  pairsPerQuestion: number;
  mock: boolean;
  totalVotes: number;
  ratings: TasteRating[];
}

/**
 * A discerning-cook preference prompt. Unlike the precision judge (which hunts
 * faults against a reference), this asks which dish the judge would rather cook
 * and eat — appeal, flavour logic and practicality — and deliberately tells it
 * to ignore length and formatting so verbose answers get no free advantage.
 */
export function buildTasteJudgeMessages(question: Question, answerA: string, answerB: string) {
  const system = [
    'You are a discerning home cook comparing two answers to the same cooking request. Pick the one you would rather actually cook and eat — judge appeal, flavour logic, and practicality in a real kitchen.',
    'Judge ONLY the substance. Ignore length, formatting, headings, and confident tone: a longer or more elaborately formatted answer is NOT better for that reason. If one answer is unsafe, ignores a stated constraint, or would taste worse, prefer the other.',
    "Answer A and Answer B are anonymous; do not guess or reward who wrote them. Choose 'tie' only when they are genuinely inseparable in appeal.",
    'Respond with STRICT JSON only, no markdown:',
    '{"winner":"a|b|tie","reason":"<one or two sentences>"}',
  ].join('\n');
  const user = [
    `REQUEST:\n${question.prompt}`,
    `ANSWER A:\n${anonymizeAnswer(answerA)}`,
    `ANSWER B:\n${anonymizeAnswer(answerB)}`,
  ].join('\n\n');
  return [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
}

export function parseTasteJudgeVerdict(text: string): TasteJudgeVerdict {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Taste judge returned no JSON: ${text.slice(0, 200)}`);
  const parsed = JSON.parse(jsonMatch[0]) as { winner?: string; reason?: string };
  const winner = parsed.winner;
  if (winner !== 'a' && winner !== 'b' && winner !== 'tie') {
    throw new Error(`Taste judge gave invalid winner "${parsed.winner}"`);
  }
  return { winner, reason: parsed.reason ?? '' };
}

/** Reverse a verdict cast on swapped positions back to canonical A/B labels. */
function flip(winner: TasteWinner): TasteWinner {
  if (winner === 'a') return 'b';
  if (winner === 'b') return 'a';
  return 'tie';
}

/**
 * Two taste-panel seats for a (modelA, modelB, question) triple:
 * - a judge NEVER scores a duel involving its own provider (self-preference);
 * - the remaining seats are ranked by a deterministic hash and the two lowest
 *   are chosen, so the assignment is balanced and any published rating is
 *   reproducible from the artifacts.
 * Callers pass models in canonical order so the hash is stable.
 */
export function tastePanelSeats(
  panel: string[],
  modelA: string,
  modelB: string,
  questionId: string,
): string[] {
  const eligible = panel.filter(
    (j) => providerOf(j) !== providerOf(modelA) && providerOf(j) !== providerOf(modelB),
  );
  if (eligible.length < 2) {
    throw new Error(
      `Taste panel too small for ${modelA} vs ${modelB}: only ${eligible.length} non-conflicted seat(s)`,
    );
  }
  return [...eligible]
    .sort(
      (x, y) =>
        fnv1a(`${x}|${modelA}|${modelB}|${questionId}`) -
        fnv1a(`${y}|${modelA}|${modelB}|${questionId}`),
    )
    .slice(0, 2);
}

/** One taste verdict from one seat, judged in both orders to cancel position bias. */
async function seatVerdict(
  client: CompletionClient,
  judgeModel: string,
  question: Question,
  aText: string,
  bText: string,
): Promise<{ verdict: PairSeatVerdict; costUsd: number }> {
  const call = async (first: string, second: string): Promise<{ v: TasteJudgeVerdict; cost: number }> => {
    const messages = buildTasteJudgeMessages(question, first, second);
    let lastError: Error | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await client.complete(judgeModel, messages, {
        temperature: 0,
        maxTokens: 800 * (attempt + 1),
        reasoning: { effort: 'low' },
      });
      try {
        return { v: parseTasteJudgeVerdict(result.text), cost: result.costUsd };
      } catch (err) {
        lastError = err as Error;
      }
    }
    throw lastError ?? new Error(`Taste judge ${judgeModel} failed on ${question.id}`);
  };
  const fwd = await call(aText, bText);
  const rev = await call(bText, aText);
  const forward = fwd.v;
  const reversedCanonical: TasteJudgeVerdict = { winner: flip(rev.v.winner), reason: rev.v.reason };
  const positionConsistent = forward.winner === reversedCanonical.winner;
  const final: TasteWinner = positionConsistent ? forward.winner : 'tie';
  return {
    verdict: { judgeModel, forward, reversed: reversedCanonical, final, positionConsistent },
    costUsd: fwd.cost + rev.cost,
  };
}

/**
 * Judge one duel with the full panel: pick the non-conflicted seats, run each
 * seat in both orders, and collect a PairVerdictRecord. `answers` maps modelId →
 * answer text; both contenders must be present.
 */
export async function judgePair(
  client: CompletionClient,
  panel: string[],
  runId: string,
  question: Question,
  modelA: string,
  modelB: string,
  answers: Map<string, string>,
  nowIso: string,
): Promise<PairVerdictRecord> {
  const [a, b] = modelA < modelB ? [modelA, modelB] : [modelB, modelA];
  const aText = answers.get(a);
  const bText = answers.get(b);
  if (aText === undefined || bText === undefined) {
    throw new Error(`Missing answer text for ${a} or ${b} on ${question.id}`);
  }
  const seats = tastePanelSeats(panel, a, b, question.id);
  const results = await Promise.all(
    seats.map((judgeModel) => seatVerdict(client, judgeModel, question, aText, bText)),
  );
  return {
    runId,
    questionId: question.id,
    modelA: a,
    modelB: b,
    promptVersion: TASTE_JUDGE_PROMPT_VERSION,
    judgedAt: nowIso,
    costUsd: results.reduce((s, r) => s + r.costUsd, 0),
    seats: results.map((r) => r.verdict),
  };
}

/** Each seat's collapsed verdict becomes one PanelTasteVote (voter = the seat). */
export function pairVerdictToVotes(record: PairVerdictRecord): PanelTasteVote[] {
  return record.seats.map((seat) => ({
    run_id: record.runId,
    question_id: record.questionId,
    model_a: record.modelA,
    model_b: record.modelB,
    winner: seat.final,
    judge_model: seat.judgeModel,
    position_consistent: seat.positionConsistent,
  }));
}

/**
 * Deterministic balanced pair plan. Per question: seed a PRNG from the run and
 * question ids, shuffle the eligible models, and take disjoint consecutive pairs
 * (so each model appears at most once per round → balanced). Extra rounds are
 * added, de-duplicated by unordered pair, until `pairsPerQuestion` is met or the
 * round-robin is exhausted. Fully reproducible, so the estimate can hash it.
 */
export function planPairs(
  runId: string,
  questions: Question[],
  eligibleByQuestion: Map<string, string[]>,
  pairsPerQuestion: number,
): PlannedPair[] {
  const plan: PlannedPair[] = [];
  for (const question of questions) {
    const models = eligibleByQuestion.get(question.id) ?? [];
    if (models.length < 2) continue;
    const maxPairs = Math.min(pairsPerQuestion, (models.length * (models.length - 1)) / 2);
    const seen = new Set<string>();
    const rand = mulberry32(fnv1a(`${runId}|${question.id}|taste-v1`));
    let guard = 0;
    while (seen.size < maxPairs && guard < 1000) {
      guard++;
      const shuffled = [...models];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      for (let i = 0; i + 1 < shuffled.length && seen.size < maxPairs; i += 2) {
        const [a, b] = shuffled[i]! < shuffled[i + 1]!
          ? [shuffled[i]!, shuffled[i + 1]!]
          : [shuffled[i + 1]!, shuffled[i]!];
        const key = `${a}::${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        plan.push({ questionId: question.id, modelA: a, modelB: b });
      }
    }
  }
  return plan;
}

export function buildPanelSummary(
  runId: string,
  votes: PanelTasteVote[],
  meta: { panel: string[]; pairsPerQuestion: number; mock: boolean; generatedAt: string },
): TastePanelSummary {
  return {
    runId,
    generatedAt: meta.generatedAt,
    promptVersion: TASTE_JUDGE_PROMPT_VERSION,
    panel: meta.panel,
    pairsPerQuestion: meta.pairsPerQuestion,
    mock: meta.mock,
    totalVotes: votes.length,
    ratings: computeTasteRatings(votes, { bootstrap: 200, seed: 42 }),
  };
}
