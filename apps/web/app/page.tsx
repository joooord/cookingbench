import Link from 'next/link';
import { CATEGORIES, CATEGORY_IDS } from '@cookingbench/core';
import { getLatestReport, modelSlug } from '@/lib/data';
import { CATEGORY_COLORS, formatScore, scoreColor } from '@/lib/format';

export const revalidate = 3600;

export default function LeaderboardPage() {
  const report = getLatestReport();
  return (
    <div>
      <section className="py-16">
        <h1
          className="font-display font-semibold tracking-tight"
          style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', letterSpacing: '-0.02em', lineHeight: 1.05 }}
        >
          How well do AI models <em className="text-paprika not-italic underline decoration-2 underline-offset-8">cook</em>?
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-ink-soft">
          CookingBench scores models on the things that actually go wrong in a kitchen:
          scaling quantities, converting units, food safety, substitutions, technique,
          flavour logic and nutrition math.
        </p>
      </section>

      {report === null ? (
        <p className="border-t border-hairline py-12 text-ink-soft">
          No published runs yet — the first leaderboard lands soon.
        </p>
      ) : (
        <section className="pb-12">
          <div className="flex items-baseline justify-between border-b-2 border-ink pb-3">
            <h2 className="font-display text-xl font-medium">
              Leaderboard <span className="text-ink-soft">· run {report.runId}</span>
            </h2>
            <span className="tabular text-xs text-ink-soft">
              {new Date(report.generatedAt).toISOString().slice(0, 10)}
            </span>
          </div>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-ink-soft">
                <th className="py-3 pr-2 font-normal">#</th>
                <th className="py-3 pr-4 font-normal">Model</th>
                <th className="py-3 pr-4 font-normal">Overall</th>
                <th className="hidden py-3 pr-4 font-normal md:table-cell">Categories</th>
                <th className="py-3 text-right font-normal">Run cost</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row, i) => (
                <tr key={row.modelId} className="border-b border-hairline hover:bg-paper-tint">
                  <td className="tabular py-4 pr-2 text-ink-soft">{i + 1}</td>
                  <td className="py-4 pr-4">
                    <Link href={`/models/${modelSlug(row.modelId)}`} className="hover:text-paprika">
                      <span className={i === 0 ? 'font-semibold text-paprika' : 'font-medium'}>
                        {row.displayName}
                      </span>
                      <span className="ml-2 text-xs text-ink-soft">{row.provider}</span>
                    </Link>
                  </td>
                  <td className="py-4 pr-4">
                    <span
                      className="tabular text-base font-medium"
                      style={{ color: scoreColor(row.overall) }}
                    >
                      {formatScore(row.overall)}
                    </span>
                  </td>
                  <td className="hidden py-4 pr-4 md:table-cell">
                    <div className="flex h-3 w-full max-w-72 gap-px">
                      {CATEGORY_IDS.map((category) => {
                        const value = row.categories[category];
                        return (
                          <div
                            key={category}
                            title={`${CATEGORIES[category].name}: ${formatScore(value)}`}
                            className="flex-1 bg-paper-tint"
                          >
                            <div
                              style={{
                                height: '100%',
                                width: `${value ?? 0}%`,
                                background: CATEGORY_COLORS[category],
                              }}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </td>
                  <td className="tabular py-4 text-right text-ink-soft">
                    ${row.costUsd.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="border-t border-hairline py-12">
        <h2 className="font-display text-xl font-medium">Categories</h2>
        <div className="mt-6 grid gap-px border border-hairline bg-hairline sm:grid-cols-2 lg:grid-cols-4">
          {CATEGORY_IDS.map((id) => (
            <Link
              key={id}
              href={`/categories/${id}`}
              className="group bg-paper p-5 transition-colors hover:bg-paper-tint"
            >
              <div className="h-1 w-8" style={{ background: CATEGORY_COLORS[id] }} />
              <h3 className="mt-3 font-medium group-hover:text-paprika">{CATEGORIES[id].name}</h3>
              <p className="mt-1 text-xs leading-relaxed text-ink-soft">
                {CATEGORIES[id].description}
              </p>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
