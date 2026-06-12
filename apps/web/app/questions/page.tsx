import { CATEGORIES, type CategoryId } from '@cookingbench/core';
import { getLatestReport, getPublicQuestions, getResponses, getScores } from '@/lib/data';
import { formatScore, scoreColor } from '@/lib/format';
import { CategoryChip } from '@/components/CategoryChip';

export const revalidate = 3600;

export const metadata = {
  title: 'Questions',
  description:
    'Every public CookingBench question, its reference answer, and what each AI model actually said.',
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
        Every public question, its reference answer, and what each model actually said.
        A held-out private set guards against models training on the benchmark.
      </p>

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
                  <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-xs text-ink-soft" title="Saturated item — runs as a regression gate, excluded from Overall">
                    basics
                  </span>
                )}
                {question.trap && (
                  <span className="rounded-sm border border-hairline px-1.5 py-0.5 text-xs text-saffron" title="The prompt embeds a false or dangerous premise the model must catch">
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
                      return (
                        <div key={score.modelId} className="bg-paper p-4">
                          <div className="flex items-baseline justify-between">
                            <span className="text-sm font-medium">
                              {row?.displayName ?? score.modelId}
                            </span>
                            <span
                              className="tabular text-sm font-medium"
                              style={{ color: scoreColor(score.score) }}
                            >
                              {formatScore(score.score)}
                            </span>
                          </div>
                          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-ink-soft">
                            {(response?.answerText ?? '').slice(0, 600)}
                            {(response?.answerText.length ?? 0) > 600 ? '…' : ''}
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
