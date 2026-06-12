import Link from 'next/link';
import { getPublishedReports } from '@/lib/data';
import { formatScore, scoreColor } from '@/lib/format';

export const revalidate = 3600;

export const metadata = {
  title: 'Run archive',
  description:
    'Every published CookingBench run, kept permanently: leaderboards, methodology versions and dates. Scores are only comparable within a methodology version.',
};

export default function RunsPage() {
  const reports = getPublishedReports();
  return (
    <div className="py-16">
      <h1 className="font-display text-3xl font-semibold tracking-tight">Run archive</h1>
      <p className="mt-4 max-w-2xl text-ink-soft">
        Every published run, kept permanently — the homepage only shows the newest one.
        Each run is reproducible from artifacts committed to the repo: per-response
        outputs, scores, judge verdicts and calibration results.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-ink-soft">
        Scores are <strong>not comparable across methodology versions</strong>: the
        question set, graders and judging change between versions by design.
      </p>

      {reports.length === 0 ? (
        <p className="mt-10 text-ink-soft">No published runs yet.</p>
      ) : (
        <table className="mt-10 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b-2 border-ink text-left text-xs uppercase tracking-wider text-ink-soft">
              <th className="py-3 pr-4 font-normal">Run</th>
              <th className="py-3 pr-4 font-normal">Date</th>
              <th className="py-3 pr-4 font-normal">Methodology</th>
              <th className="py-3 pr-4 font-normal">Models</th>
              <th className="py-3 font-normal">Top model</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((report) => {
              const top = report.rows[0];
              return (
                <tr key={report.runId} className="border-b border-hairline hover:bg-paper-tint">
                  <td className="py-4 pr-4">
                    <Link
                      href={`/runs/${report.runId}`}
                      className="font-medium underline decoration-hairline underline-offset-4 hover:text-paprika"
                    >
                      {report.runId}
                    </Link>
                  </td>
                  <td className="tabular py-4 pr-4 text-ink-soft">
                    {new Date(report.generatedAt).toISOString().slice(0, 10)}
                  </td>
                  <td className="py-4 pr-4">
                    <span className="rounded-sm border border-hairline px-2 py-0.5 text-xs text-ink-soft">
                      {report.methodologyVersion ?? 'v1'}
                    </span>
                  </td>
                  <td className="tabular py-4 pr-4 text-ink-soft">{report.rows.length}</td>
                  <td className="py-4">
                    {top ? (
                      <>
                        <span className="font-medium">{top.displayName}</span>{' '}
                        <span className="tabular text-sm" style={{ color: scoreColor(top.overall) }}>
                          {formatScore(top.overall)}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
