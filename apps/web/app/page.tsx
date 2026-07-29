import Link from 'next/link';
import { CATEGORIES, CATEGORY_IDS } from '@cookingbench/core';
import { getLatestReport, getTiedRanks, modelSlug } from '@/lib/data';
import { CATEGORY_COLORS, formatScore, scoreColor } from '@/lib/format';
import { getTasteWinrates } from '@/lib/supabase';

export const revalidate = 3600;

export default async function LeaderboardPage() {
  const report = getLatestReport();
  const methodology = report?.methodologyVersion ?? 'v1';
  const isV2 = methodology !== 'v1';
  const winrates = await getTasteWinrates();
  const taste = new Map(
    (winrates ?? []).filter((w) => w.battles >= 5).map((w) => [w.model_id, w]),
  );
  const showTaste = taste.size > 0;
  // Models nothing on the board is proven to beat. The row order stays as it is
  // — readers expect a sorted table — but calling the top row "the winner" when
  // five models share first place is the one claim this page must not make.
  const ranks = report ? getTiedRanks(report.runId) : null;
  const tiedFirst = ranks
    ? (report?.rows ?? []).filter((r) => ranks.get(r.modelId) === 1).map((r) => r.modelId)
    : [];
  const sharedFirst = tiedFirst.length > 1;
  return (
    <div>
      <section className="py-16">
        <h1
          className="font-display font-semibold tracking-tight"
          style={{ fontSize: 'clamp(2.5rem, 6vw, 4.5rem)', letterSpacing: '-0.02em', lineHeight: 1.05 }}
        >
          Which AI model is the best{' '}
          <em className="text-paprika not-italic underline decoration-2 underline-offset-8">chef</em>?
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
              <span className="ml-3 rounded-sm border border-hairline px-2 py-0.5 align-middle text-xs text-ink-soft">
                methodology {methodology}
              </span>
            </h2>
            <span className="tabular text-xs text-ink-soft">
              {new Date(report.generatedAt).toISOString().slice(0, 10)}
            </span>
          </div>
          {sharedFirst && (
            <p className="mt-3 text-sm text-ink-soft">
              <span className="font-medium text-ink">
                {tiedFirst.length} models are tied for first.
              </span>{' '}
              Rows are sorted by Overall, but the gaps at the top are smaller than the
              measurement error: no model on this board is shown to beat any of the top{' '}
              {tiedFirst.length}. Places come from a paired bootstrap over per-question
              score differences —{' '}
              <Link
                href="/methodology#separation"
                className="underline decoration-hairline underline-offset-4 hover:text-paprika"
              >
                how this is measured
              </Link>
              .
            </p>
          )}
          <table className="mt-4 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-ink-soft">
                <th className="py-3 pr-2 font-normal">#</th>
                <th className="py-3 pr-4 font-normal">Model</th>
                <th className="py-3 pr-4 font-normal">Overall</th>
                {isV2 ? (
                  <>
                    <th className="py-3 pr-4 font-normal" title="Mean score on difficulty ≥ 4 questions — compound chains, traps, buried constraints">
                      Frontier
                    </th>
                    <th className="hidden py-3 pr-4 font-normal sm:table-cell" title="Saturated v1 items kept as a regression gate — excluded from Overall">
                      Basics
                    </th>
                  </>
                ) : (
                  <th className="py-3 pr-4 font-normal" title="Mean score on difficulty-3 questions only — compound math, unit traps, multi-constraint requests">
                    Hard set
                  </th>
                )}
                {showTaste && (
                  <th className="hidden py-3 pr-4 font-normal sm:table-cell" title="Human blind-vote win rate from the Taste Test — full Bradley-Terry standings on the Taste Board">
                    <Link href="/taste" className="underline decoration-hairline underline-offset-4 hover:text-paprika">
                      Taste
                    </Link>
                  </th>
                )}
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
                      <span
                        className={
                          ranks?.get(row.modelId) === 1 ? 'font-semibold text-paprika' : 'font-medium'
                        }
                      >
                        {row.displayName}
                      </span>
                      <span className="ml-2 text-xs text-ink-soft">{row.provider}</span>
                    </Link>
                    {sharedFirst && ranks?.get(row.modelId) === 1 && (
                      <span
                        className="ml-2 rounded-sm border border-hairline px-1.5 py-0.5 align-middle text-[10px] uppercase tracking-wider text-ink-soft"
                        title={`Statistically tied for first with ${tiedFirst.length - 1} other model(s) — no model on this board is shown to beat it`}
                      >
                        =1st
                      </span>
                    )}
                  </td>
                  <td className="py-4 pr-4">
                    <span
                      className="tabular text-base font-medium"
                      style={{ color: scoreColor(row.overall) }}
                    >
                      {formatScore(row.overall)}
                    </span>
                    {row.overallCi && (
                      <span
                        className="tabular ml-1 text-xs text-ink-soft"
                        title="95% bootstrap confidence interval over questions"
                      >
                        ±{((row.overallCi[1] - row.overallCi[0]) / 2).toFixed(1)}
                      </span>
                    )}
                  </td>
                  {isV2 ? (
                    <>
                      <td className="py-4 pr-4">
                        <span
                          className="tabular text-sm"
                          style={{ color: scoreColor(row.frontier ?? 0) }}
                        >
                          {row.frontier == null ? '—' : formatScore(row.frontier)}
                        </span>
                      </td>
                      <td className="hidden py-4 pr-4 sm:table-cell">
                        <span className="tabular text-sm text-ink-soft">
                          {row.basics == null ? '—' : formatScore(row.basics)}
                        </span>
                        {(row.incidents ?? 0) > 0 && (
                          <span
                            className="ml-1 text-xs text-saffron-ink"
                            title={`${row.incidents} responses stayed empty/filtered after retries (transport noise, scored 0)`}
                          >
                            ⚠{row.incidents}
                          </span>
                        )}
                      </td>
                    </>
                  ) : (
                    <td className="py-4 pr-4">
                      <span
                        className="tabular text-sm"
                        style={{ color: scoreColor(row.hardSet ?? 0) }}
                      >
                        {row.hardSet == null ? '—' : formatScore(row.hardSet)}
                      </span>
                    </td>
                  )}
                  {showTaste && (
                    <td className="hidden py-4 pr-4 sm:table-cell">
                      <span className="tabular text-sm text-ink-soft">
                        {taste.has(row.modelId)
                          ? `${taste.get(row.modelId)!.win_rate.toFixed(0)}%`
                          : '—'}
                      </span>
                    </td>
                  )}
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
