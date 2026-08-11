import { CATEGORIES, type CategoryId } from '@cookingbench/core';
import { getLatestReport, getPublicQuestions, getResponses, getScores } from '@/lib/data';
import { formatScore, scoreColor } from '@/lib/format';
import { CategoryChip } from '@/components/CategoryChip';
import Link from 'next/link';

export const revalidate = 3600;

export const metadata = {
  title: 'Current question bank and archived answers',
  description:
    'The current repaired CookingBench question bank shown beside archived v2.1 answers, with an explicit version boundary.',
};

export default function QuestionsPage() {
  const questions = getPublicQuestions();
  const report = getLatestReport();
  const responses = report ? getResponses(report.runId) : [];
  const scores = report ? getScores(report.runId) : [];

  return (
    <div className="py-16">
      <h1
        className="font-display font-semibold tracking-tight"
        style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', letterSpacing: '-0.02em' }}
      >
        The questions
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-ink-soft">
        The current repaired question bank, shown beside answers preserved from the July v2.1
        run. The whole dataset is public; future confirmatory questions will be sealed until use.
      </p>

      <aside className="mt-8 max-w-3xl border-y-2 border-paprika py-5" aria-label="Version boundary">
        <p className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-paprika">
          Important version boundary
        </p>
        <p className="mt-3 text-sm leading-relaxed text-ink-soft">
          Prompts, references and scoring rules on this page come from the current repaired bank;
          model answers and original scores come from the archived v2.1 run. Some items, including
          flav-014 and rgen-004, changed after that run, so this is not a reconstruction of the exact
          historical instrument. The frozen response corpus remains independently verifiable in the{' '}
          <Link href="/corpus/2026-07-v2-1" className="text-paprika underline underline-offset-4">
            corpus record
          </Link>
          .
        </p>
      </aside>

      <div className="mt-12 space-y-16">
        {questions.map((question) => {
          const questionScores = scores
            .filter((s) => s.questionId === question.id)
            .sort((a, b) => b.score - a.score);
          return (
            <article key={question.id} className="border-t-2 border-ink pt-6">
              <div className="flex flex-wrap items-center gap-3">
                <span className="tabular text-sm text-ink-soft">{question.id}</span>
                <CategoryChip id={question.category as CategoryId} />
                <span className="text-xs text-ink-soft">
                  difficulty {'●'.repeat(question.difficulty)}{'○'.repeat(Math.max(0, 5 - question.difficulty))}
                </span>
                {question.status === 'basics' && (
                  <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-xs text-ink-soft" title="Saturated item: runs as a regression gate, excluded from Overall">
                    basics
                  </span>
                )}
                {question.trap && (
                  <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-xs text-saffron-ink" title="The prompt embeds a false or dangerous premise the model must catch">
                    trap
                  </span>
                )}
              </div>
              <p className="mt-4 max-w-prose text-lg leading-relaxed">{question.prompt}</p>
              <p className="mt-3 max-w-prose border-l-2 border-herb pl-4 text-sm leading-relaxed text-ink-soft">
                <span className="font-medium text-herb">Reference: </span>
                {question.referenceAnswer}
              </p>

              {questionScores.length > 0 && (
                <details className="mt-5">
                  <summary className="cursor-pointer text-sm text-paprika">
                    Model answers ({questionScores.length})
                  </summary>
                  <div className="mt-4 grid gap-px border border-hairline bg-hairline md:grid-cols-2">
                    {questionScores.map((score) => {
                      const response = responses.find(
                        (r) => r.modelId === score.modelId && r.questionId === question.id,
                      );
                      const row = report?.rows.find((r) => r.modelId === score.modelId);
                      // A response that never arrived, or never got a verdict, is
                      // missing data - not a bad answer. Showing it as "0.0" reads
                      // as the model failing the question when the pipeline failed.
                      const detail = score.detail as
                        | { judgePending?: boolean; emptyAnswer?: boolean }
                        | undefined;
                      const noAnswer = !(response?.answerText ?? '').trim();
                      const unscored = detail?.judgePending || noAnswer;
                      return (
                        <div key={score.modelId} className="bg-paper p-4">
                          <div className="flex items-baseline justify-between gap-3">
                            <span className="text-sm font-medium">
                              {row?.displayName ?? score.modelId}
                            </span>
                            {unscored ? (
                              <span
                                className="tabular whitespace-nowrap text-sm text-ink-soft"
                                title={
                                  detail?.judgePending
                                    ? 'No judge verdict for this answer; excluded from the score'
                                    : 'The model returned no text (transport failure), scored 0'
                                }
                              >
                                {detail?.judgePending ? 'unjudged' : '0.0 · no answer'}
                              </span>
                            ) : (
                              <span
                                className="tabular text-sm font-medium"
                                style={{ color: scoreColor(score.score) }}
                              >
                                {formatScore(score.score)}
                              </span>
                            )}
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">
                            {noAnswer ? (
                              <em>No response: the model returned no text.</em>
                            ) : (
                              <>
                                {(response?.answerText ?? '').slice(0, 600)}
                                {(response?.answerText.length ?? 0) > 600 ? '…' : ''}
                              </>
                            )}
                          </p>
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
