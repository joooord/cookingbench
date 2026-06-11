import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CATEGORIES, CATEGORY_IDS } from '@cookingbench/core';
import { getLatestReport, modelIdFromSlug, modelSlug } from '@/lib/data';
import { CATEGORY_COLORS, formatScore, scoreColor } from '@/lib/format';
import { ScoreBar } from '@/components/ScoreBar';

export const revalidate = 3600;

export function generateStaticParams() {
  const report = getLatestReport();
  return (report?.rows ?? []).map((row) => ({ slug: modelSlug(row.modelId) }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const report = getLatestReport();
  const row = report?.rows.find((r) => r.modelId === modelIdFromSlug(slug));
  if (!report || !row) return {};
  const rank = report.rows.indexOf(row) + 1;
  return {
    title: `${row.displayName} as a chef`,
    description: `${row.displayName} ranks #${rank} of ${report.rows.length} on CookingBench with an overall culinary score of ${formatScore(row.overall)}. Full category breakdown: conversions, food safety, technique, flavour and more.`,
  };
}

export default async function ModelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const report = getLatestReport();
  if (!report) notFound();
  const modelId = modelIdFromSlug(slug);
  const row = report.rows.find((r) => r.modelId === modelId);
  if (!row) notFound();
  const rank = report.rows.indexOf(row) + 1;
  const familyPeers = row.family
    ? report.rows.filter((r) => r.family === row.family && r.modelId !== row.modelId)
    : [];

  return (
    <div className="py-16">
      <p className="text-sm text-ink-soft">
        <Link href="/" className="hover:text-paprika">Leaderboard</Link> / {row.provider}
      </p>
      <div className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h1
          className="font-display font-semibold tracking-tight"
          style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', letterSpacing: '-0.02em' }}
        >
          {row.displayName}
        </h1>
        <span className="tabular text-3xl font-medium" style={{ color: scoreColor(row.overall) }}>
          {formatScore(row.overall)}
        </span>
        <span className="tabular text-sm text-ink-soft">rank #{rank} · run {report.runId}</span>
      </div>

      <section className="mt-12 max-w-2xl">
        <h2 className="border-b-2 border-ink pb-3 font-display text-xl font-medium">
          Category breakdown
        </h2>
        <dl>
          {CATEGORY_IDS.map((category) => {
            const value = row.categories[category];
            if (value === undefined) return null;
            return (
              <div
                key={category}
                className="flex items-center justify-between gap-6 border-b border-hairline py-4"
              >
                <dt>
                  <Link href={`/categories/${category}`} className="text-sm hover:text-paprika">
                    {CATEGORIES[category].name}
                  </Link>
                </dt>
                <dd className="w-56">
                  <ScoreBar score={value} color={CATEGORY_COLORS[category]} />
                </dd>
              </div>
            );
          })}
        </dl>
      </section>

      {familyPeers.length > 0 && (
        <section className="mt-16 max-w-2xl">
          <h2 className="border-b-2 border-ink pb-3 font-display text-xl font-medium">
            Same family, different version
          </h2>
          <p className="mt-3 text-sm text-ink-soft">
            Version-to-version changes are where culinary regressions hide — quantity and
            volume errors can appear in an otherwise stronger release.
          </p>
          <table className="mt-4 w-full text-sm">
            <tbody>
              {[row, ...familyPeers]
                .sort((a, b) => b.overall - a.overall)
                .map((peer) => (
                  <tr key={peer.modelId} className="border-b border-hairline">
                    <td className="py-3">
                      {peer.modelId === row.modelId ? (
                        <span className="font-semibold">{peer.displayName}</span>
                      ) : (
                        <Link href={`/models/${modelSlug(peer.modelId)}`} className="hover:text-paprika">
                          {peer.displayName}
                        </Link>
                      )}
                    </td>
                    <td className="tabular py-3 text-right" style={{ color: scoreColor(peer.overall) }}>
                      {formatScore(peer.overall)}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
