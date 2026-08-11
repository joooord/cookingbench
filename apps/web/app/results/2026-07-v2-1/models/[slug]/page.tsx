import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { CATEGORIES, CATEGORY_IDS } from '@cookingbench/core';
import { ResearchStatusChip, TextLink } from '@/components/ResearchPrimitives';
import { ScoreBar } from '@/components/ScoreBar';
import { getStandings, modelIdFromSlug, modelSlug } from '@/lib/data';
import { CATEGORY_COLORS, formatScore, scoreColor } from '@/lib/format';
import { getV21Snapshot, V21_RECORD } from '@/lib/research';

export const revalidate = 3600;

export function generateStaticParams() {
  const snapshot = getV21Snapshot();
  return (snapshot?.report.rows ?? []).map((row) => ({ slug: modelSlug(row.modelId) }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const snapshot = getV21Snapshot();
  const row = snapshot?.report.rows.find((candidate) => candidate.modelId === modelIdFromSlug(slug));
  if (!row) return {};
  return {
    title: `${row.displayName} · archived CookingBench v2.1 profile`,
    description: `${row.displayName} in the archived CookingBench v2.1 study: original culinary-reasoning profile, uncertainty, preserved answers and known scoring limitations.`,
    alternates: { canonical: `/results/2026-07-v2-1/models/${slug}` },
  };
}

export default async function ArchivedModelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const snapshot = getV21Snapshot();
  if (!snapshot) notFound();
  const row = snapshot.report.rows.find((candidate) => candidate.modelId === modelIdFromSlug(slug));
  if (!row) notFound();

  const standings = getStandings(snapshot.report);
  const isLeadingGroup = standings.tested && standings.first.includes(row.modelId);

  return (
    <div className="pb-24 pt-14 sm:pt-20">
      <p className="font-mono text-xs text-ink-soft">
        <Link href="/results" className="hover:text-paprika">Results</Link> /{' '}
        <Link href="/results/2026-07-v2-1" className="hover:text-paprika">v2.1</Link> / {row.provider}
      </p>

      <header className="mt-6 border-b-2 border-ink pb-10">
        <div className="flex flex-wrap gap-2">
          <ResearchStatusChip tone="archived">Archived v2.1</ResearchStatusChip>
          {isLeadingGroup ? (
            <ResearchStatusChip tone="preliminary">Unresolved leading group</ResearchStatusChip>
          ) : null}
        </div>
        <h1 className="mt-6 font-display text-5xl font-semibold tracking-tight sm:text-7xl">{row.displayName}</h1>
        <p className="mt-5 max-w-3xl text-lg leading-relaxed text-ink-soft">
          This profile reports {row.displayName}’s original v2.1 result. It does not claim a timeless
          culinary rank. The run’s scoring limitations and later exploratory analyses are separate records.
        </p>
      </header>

      <section className="grid gap-px border-x border-b border-hairline bg-hairline sm:grid-cols-3">
        <div className="bg-paper p-6">
          <p className="font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">Original overall</p>
          <p className="mt-3 font-mono text-4xl" style={{ color: scoreColor(row.overall) }}>{formatScore(row.overall)}</p>
        </div>
        <div className="bg-paper p-6">
          <p className="font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">95% item-bootstrap interval</p>
          <p className="mt-3 font-mono text-2xl">
            {row.overallCi ? `${row.overallCi[0].toFixed(1)}–${row.overallCi[1].toFixed(1)}` : 'Not recorded'}
          </p>
        </div>
        <div className="bg-paper p-6">
          <p className="font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">Frontier subset</p>
          <p className="mt-3 font-mono text-2xl">{row.frontier == null ? 'n/a' : formatScore(row.frontier)}</p>
        </div>
      </section>

      <section className="mt-16 max-w-3xl">
        <h2 className="border-b-2 border-ink pb-3 font-display text-3xl font-semibold">Original score profile</h2>
        <dl>
          {CATEGORY_IDS.map((category) => {
            const value = row.categories[category];
            if (value === undefined) return null;
            return (
              <div key={category} className="grid items-center gap-3 border-b border-hairline py-4 sm:grid-cols-[1fr_15rem]">
                <dt>
                  <Link href={`/categories/${category}`} className="text-sm hover:text-paprika">{CATEGORIES[category].name}</Link>
                </dt>
                <dd><ScoreBar score={value} color={CATEGORY_COLORS[category]} /></dd>
              </div>
            );
          })}
        </dl>
      </section>

      <section className="mt-16 grid gap-8 border-y border-hairline py-10 lg:grid-cols-2">
        <div>
          <h2 className="font-display text-2xl font-semibold">Uncertainty and pairwise evidence</h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            {isLeadingGroup
              ? `${row.displayName} belonged to a five-model group from which the run’s paired item-bootstrap rule did not identify one unique leader.`
              : 'This model’s position should be interpreted through direct paired comparisons, not its row number alone.'}
          </p>
        </div>
        <div>
          <h2 className="font-display text-2xl font-semibold">Scoring limitations</h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            Saturated numeric items, high-influence keyword items and semantic constraint-check
            failures affected the instrument. The profile is retained as historical evidence, not validated culinary ability.
          </p>
        </div>
      </section>

      <section className="mt-12">
        <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <TextLink href="/questions">Current question bank with archived answers</TextLink>
          <TextLink href="/research/v2-1-autopsy">Read the scoring autopsy</TextLink>
          <TextLink href="/results/2026-07-v2-1">Return to all original scores</TextLink>
        </div>
        <p className="mt-8 font-mono text-[0.68rem] text-ink-soft">
          Run {V21_RECORD.runId} · {row.modelId} · original artifact unchanged
        </p>
      </section>
    </div>
  );
}
