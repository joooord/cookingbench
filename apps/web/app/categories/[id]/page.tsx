import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CATEGORIES, CATEGORY_IDS, type CategoryId } from '@cookingbench/core';
import { getLatestReport, getPublicQuestions, getScores, modelSlug } from '@/lib/data';
import { CATEGORY_COLORS, formatScore, scoreColor } from '@/lib/format';
import { ScoreBar } from '@/components/ScoreBar';

export const revalidate = 3600;

export function generateStaticParams() {
  return CATEGORY_IDS.map((id) => ({ id }));
}

export default async function CategoryPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!CATEGORY_IDS.includes(id as CategoryId)) notFound();
  const category = id as CategoryId;
  const report = getLatestReport();
  const meta = CATEGORIES[category];
  const questions = getPublicQuestions().filter((q) => q.category === category);
  const scores = report ? getScores(report.runId) : [];

  const ranked = (report?.rows ?? [])
    .filter((row) => row.categories[category] !== undefined)
    .sort((a, b) => (b.categories[category] ?? 0) - (a.categories[category] ?? 0));

  return (
    <div className="py-16">
      <p className="text-sm text-ink-soft">
        <Link href="/" className="hover:text-paprika">Leaderboard</Link> / categories
      </p>
      <div className="mt-4 h-1.5 w-12" style={{ background: CATEGORY_COLORS[category] }} />
      <h1
        className="mt-3 font-display font-semibold tracking-tight"
        style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', letterSpacing: '-0.02em' }}
      >
        {meta.name}
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-ink-soft">{meta.description}</p>

      {report && (
        <section className="mt-12 max-w-2xl">
          <h2 className="border-b-2 border-ink pb-3 font-display text-xl font-medium">Ranking</h2>
          <ol>
            {ranked.map((row, i) => (
              <li
                key={row.modelId}
                className="flex items-center justify-between gap-6 border-b border-hairline py-4"
              >
                <span className="flex items-baseline gap-3">
                  <span className="tabular text-sm text-ink-soft">{i + 1}</span>
                  <Link href={`/models/${modelSlug(row.modelId)}`} className="text-sm font-medium hover:text-paprika">
                    {row.displayName}
                  </Link>
                </span>
                <span className="w-56">
                  <ScoreBar score={row.categories[category]!} color={CATEGORY_COLORS[category]} />
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {report && questions.length > 0 && (
        <section className="mt-16">
          <h2 className="border-b-2 border-ink pb-3 font-display text-xl font-medium">
            Question heatmap <span className="text-sm font-normal text-ink-soft">(public questions only)</span>
          </h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wider text-ink-soft">
                  <th className="py-2 pr-4 font-normal">Model</th>
                  {questions.map((q) => (
                    <th key={q.id} className="tabular px-1 py-2 text-center font-normal">
                      {q.id.split('-')[1]}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranked.map((row) => (
                  <tr key={row.modelId} className="border-t border-hairline">
                    <td className="py-2 pr-4">{row.displayName}</td>
                    {questions.map((q) => {
                      const score = scores.find(
                        (s) => s.modelId === row.modelId && s.questionId === q.id,
                      );
                      return (
                        <td key={q.id} className="px-1 py-2">
                          <div
                            title={`${q.id}: ${formatScore(score?.score)}`}
                            className="mx-auto h-6 w-full min-w-8"
                            style={{
                              background: score ? scoreColor(score.score) : 'var(--color-paper-tint)',
                              opacity: score ? 0.25 + 0.75 * (score.score / 100) : 1,
                            }}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-ink-soft">
            Each cell is one question; deeper colour = higher score. Hover for exact values.
          </p>
        </section>
      )}
    </div>
  );
}
