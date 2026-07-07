import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Question, Score, StoredResponse } from '@cookingbench/core';
import { RUNS_DIR } from './dataset.js';

interface SeatVerdict {
  judgeModel?: string;
  score?: number;
  summary?: string;
  findings?: Array<{ quote?: string; issue?: string; severity?: string }>;
}

interface FlaggedDetail {
  flagged?: boolean;
  disagreement?: number;
  verdicts?: SeatVerdict[];
}

function excerpt(text: string, max = 900): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * A human-review worksheet for the answers the judge panel disagreed on
 * (detail.flagged). Grouped by question with each seat's score, summary and
 * findings, an excerpt of the answer, and a blank `Human verdict:` line — the
 * on-ramp for the expert layer the methodology promises. Pure and derived, so
 * it can be regenerated for any run.
 */
export function buildFlaggedReport(
  runId: string,
  questions: Question[],
  responses: StoredResponse[],
  scores: Score[],
): { markdown: string; count: number } {
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const responseKey = (modelId: string, questionId: string) => `${modelId} ${questionId}`;
  const responsesByKey = new Map(responses.map((r) => [responseKey(r.modelId, r.questionId), r]));

  const flagged = scores
    .filter((s) => (s.detail as FlaggedDetail).flagged)
    .sort((a, b) => a.questionId.localeCompare(b.questionId) || a.modelId.localeCompare(b.modelId));

  const byQuestion = new Map<string, Score[]>();
  for (const s of flagged) {
    if (!byQuestion.has(s.questionId)) byQuestion.set(s.questionId, []);
    byQuestion.get(s.questionId)!.push(s);
  }

  const lines: string[] = [
    `# Flagged answers for human review — run ${runId}`,
    '',
    `${flagged.length} answer${flagged.length === 1 ? '' : 's'} across ${byQuestion.size} question${byQuestion.size === 1 ? '' : 's'} where the two judge seats disagreed by more than 15 points.`,
    'Fill in each `Human verdict:` line; this is the expert-review worksheet.',
    '',
  ];

  for (const [questionId, group] of [...byQuestion.entries()].sort()) {
    const q = questionsById.get(questionId);
    lines.push(`## ${questionId}${q ? ` · ${q.category} · difficulty ${q.difficulty}` : ''}`);
    if (q) lines.push('', `**Prompt:** ${q.prompt.trim()}`, '', `**Reference:** ${excerpt(q.referenceAnswer, 500)}`);
    lines.push('');
    for (const s of group) {
      const detail = s.detail as FlaggedDetail;
      const seats = detail.verdicts ?? [];
      const seatScores = seats.map((v) => `${v.judgeModel ?? '?'} → ${v.score ?? '?'}`).join('  |  ');
      lines.push(`### ${s.modelId}  (blended ${Math.round(s.score)}, seats disagreed by ${detail.disagreement ?? '?'})`);
      lines.push('', `Seat scores: ${seatScores}`, '');
      for (const v of seats) {
        lines.push(`- **${v.judgeModel ?? 'seat'} (${v.score ?? '?'}):** ${v.summary?.trim() || '—'}`);
        for (const f of v.findings ?? []) {
          lines.push(`    - _${f.severity}_: ${f.issue ?? ''}${f.quote ? ` ("${f.quote}")` : ''}`);
        }
      }
      const response = responsesByKey.get(responseKey(s.modelId, s.questionId));
      lines.push('', '<details><summary>Answer</summary>', '', '```', excerpt(response?.answerText ?? '(missing)'), '```', '', '</details>');
      lines.push('', '**Human verdict:** ', '');
    }
  }

  return { markdown: lines.join('\n'), count: flagged.length };
}

export function writeFlaggedReport(runId: string, markdown: string): string {
  const path = join(RUNS_DIR, runId, 'flagged-review.md');
  writeFileSync(path, markdown);
  return path;
}
