import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLatestReport, getPublishedReports, getReport, modelSlug } from '@/lib/data';
import { formatScore, scoreColor } from '@/lib/format';

export const revalidate = 3600;

export function generateStaticParams() {
  return getPublishedReports().map((report) => ({ id: report.runId }));
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = getReport(id);
  if (!report) return {};
  return {
    title: `Run ${report.runId}`,
    description: `Archived CookingBench leaderboard for run ${report.runId} (methodology ${report.methodologyVersion ?? 'v1'}, ${report.rows.length} models).`,
  };
}

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = getReport(id);
  if (!report) notFound();
  const methodology = report.methodologyVersion ?? 'v1';
  const isLatest = getLatestReport()?.runId === report.runId;
  const hasRankCi = report.rows.some((row) => row.rankCi !== undefined);

  return (
    <div className="py-16">
      <p className="text-xs uppercase tracking-wider text-ink-soft">
        <Link href="/runs" className="underline decoration-hairline underline-offset-4 hover:text-paprika">
          Run archive
        </Link>
      </p>
      <div className="mt-2 flex items-baseline justify-between border-b-2 border-ink pb-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">
          Run {report.runId}
          <span className="ml-3 rounded-sm border border-hairline px-2 py-0.5 align-middle text-xs font-normal text-ink-soft">
            methodology {methodology}
          </span>
        </h1>
        <span className="tabular text-xs text-ink-soft">
          {new Date(report.generatedAt).toISOString().slice(0, 10)}
        </span>
      </div>

      {!isLatest && (
        <p className="mt-4 border-l-2 border-saffron pl-4 text-sm text-ink-soft">
          This is an archived run, preserved as published. Scores are not comparable
          with runs under other methodology versions — see the{' '}
          <Link href="/" className="underline decoration-hairline underline-offset-4 hover:text-paprika">
            current leaderboard
          </Link>{' '}
          for the live standings.
        </p>
      )}

      <table className="mt-8 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-ink-soft">
            <th className="py-3 pr-2 font-normal">#</th>
            {hasRankCi && (
              <th className="py-3 pr-4 font-normal" title="95% rank interval from the paired bootstrap — overlapping intervals mean the order is within noise">
                Rank 95%
              </th>
            )}
            <th className="py-3 pr-4 font-normal">Model</th>
            <th className="py-3 pr-4 font-normal">Overall</th>
            <th className="py-3 pr-4 font-normal">{methodology === 'v1' ? 'Hard set' : 'Frontier'}</th>
            {methodology !== 'v1' && (
              <th className="hidden py-3 pr-4 font-normal sm:table-cell">Basics</th>
            )}
            <th className="hidden py-3 pr-4 font-normal sm:table-cell">Questions</th>
            <th className="py-3 text-right font-normal">Run cost</th>
          </tr>
        </thead>
        <tbody>
          {report.rows.map((row, i) => (
            <tr key={row.modelId} className="border-b border-hairline hover:bg-paper-tint">
              <td className="tabular py-4 pr-2 text-ink-soft">{i + 1}</td>
              {hasRankCi && (
                <td className="tabular py-4 pr-4 text-xs text-ink-soft">
                  {row.rankCi
                    ? row.rankCi[0] === row.rankCi[1]
                      ? row.rankCi[0]
                      : `${row.rankCi[0]}–${row.rankCi[1]}`
                    : '—'}
                </td>
              )}
              <td className="py-4 pr-4">
                <Link href={`/models/${modelSlug(row.modelId)}`} className="hover:text-paprika">
                  <span className={i === 0 ? 'font-semibold text-paprika' : 'font-medium'}>
                    {row.displayName}
                  </span>
                  <span className="ml-2 text-xs text-ink-soft">{row.provider}</span>
                </Link>
              </td>
              <td className="py-4 pr-4">
                <span className="tabular text-base font-medium" style={{ color: scoreColor(row.overall) }}>
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
              <td className="py-4 pr-4">
                <span
                  className="tabular text-sm"
                  style={{ color: scoreColor((methodology === 'v1' ? row.hardSet : row.frontier) ?? 0) }}
                >
                  {(methodology === 'v1' ? row.hardSet : row.frontier) == null
                    ? '—'
                    : formatScore((methodology === 'v1' ? row.hardSet : row.frontier)!)}
                </span>
              </td>
              {methodology !== 'v1' && (
                <td className="hidden py-4 pr-4 sm:table-cell">
                  <span className="tabular text-sm text-ink-soft">
                    {row.basics == null ? '—' : formatScore(row.basics)}
                  </span>
                  {(row.incidents ?? 0) > 0 && (
                    <span
                      className="ml-1 text-xs text-saffron"
                      title={`${row.incidents} responses stayed empty/filtered after retries (transport noise, scored 0)`}
                    >
                      ⚠{row.incidents}
                    </span>
                  )}
                </td>
              )}
              <td className="tabular hidden py-4 pr-4 text-ink-soft sm:table-cell">
                {row.questionsGraded}
              </td>
              <td className="tabular py-4 text-right text-ink-soft">${row.costUsd.toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="mt-6 text-xs text-ink-soft">
        Raw artifacts for this run — every response, score, judge verdict and the run
        config — live in the repo under <code>data/runs/{report.runId}/</code>.
      </p>
    </div>
  );
}
