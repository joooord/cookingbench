import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArchivedResultNotice,
  ResearchStatusChip,
  TextLink,
} from '@/components/ResearchPrimitives';
import { formatScore } from '@/lib/format';
import { getStandings, modelSlug } from '@/lib/data';
import { getV21Snapshot, V21_RECORD } from '@/lib/research';

export const metadata: Metadata = {
  title: 'CookingBench v2.1 — archived preliminary result',
  description:
    'The original CookingBench v2.1 scores preserved as a historical record, with uncertainty, scoring limitations and no claim of one definitive best AI cook.',
  alternates: { canonical: '/results/2026-07-v2-1' },
};

export default function ArchivedResultPage() {
  const snapshot = getV21Snapshot();
  if (!snapshot) {
    return <p className="py-20 text-ink-soft">The pinned v2.1 archive could not be verified. No scores are shown.</p>;
  }
  const { report } = snapshot;
  const standings = getStandings(report);
  const leadingGroup = new Set(standings.tested ? standings.first : []);

  return (
    <div className="pb-24">
      <header className="py-14 sm:py-20">
        <p className="font-mono text-xs text-ink-soft">
          <Link href="/results" className="hover:text-paprika">Results</Link> / {V21_RECORD.runId}
        </p>
        <h1 className="mt-5 font-display text-5xl font-semibold tracking-tight sm:text-7xl">
          CookingBench v2.1
        </h1>
        <p className="mt-6 max-w-3xl text-xl leading-relaxed text-ink-soft">
          Original published scores, preserved as historical evidence—not a current claim that one
          model was the best cook.
        </p>
      </header>

      <ArchivedResultNotice />

      <section className="grid gap-px border-x border-b border-hairline bg-hairline sm:grid-cols-2">
        <div className="bg-paper p-7">
          <ResearchStatusChip tone="observed">What this supports</ResearchStatusChip>
          <p className="mt-5 leading-relaxed text-ink-soft">
            The raw responses, original scores and paired-comparison record can be reproduced.
            Broad separation between some models exists in this run, and the frontier subset contains
            a stronger signal than the headline total.
          </p>
        </div>
        <div className="bg-paper-tint p-7">
          <ResearchStatusChip tone="preliminary">What this does not support</ResearchStatusChip>
          <p className="mt-5 leading-relaxed text-ink-soft">
            A unique fine-grained ordering of the leading models; a corrected winner after post-hoc
            item removal; or a claim that the overall score is latent cooking ability.
          </p>
        </div>
      </section>

      <section className="mt-16">
        <div className="flex flex-col justify-between gap-4 border-b-2 border-ink pb-4 sm:flex-row sm:items-end">
          <div>
            <h2 className="font-display text-3xl font-semibold">Original published scores</h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-ink-soft">
              Row order reproduces the historical artifact. It is labelled “Published order” because
              the order is not a statistically established total ranking. Values have not been silently regraded.
            </p>
          </div>
          <span className="font-mono text-xs text-ink-soft">14 models · 184/184 prompts each</span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[48rem] border-collapse text-sm">
            <caption className="sr-only">Original CookingBench v2.1 published scores</caption>
            <thead>
              <tr className="border-b border-hairline text-left font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">
                <th scope="col" className="py-3 pr-4 font-normal">Published order</th>
                <th scope="col" className="py-3 pr-4 font-normal">Model</th>
                <th scope="col" className="py-3 pr-4 font-normal">Original overall</th>
                <th scope="col" className="py-3 pr-4 font-normal">95% interval</th>
                <th scope="col" className="py-3 pr-4 font-normal">Frontier</th>
                <th scope="col" className="py-3 font-normal">Interpretation</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((row, index) => (
                <tr key={row.modelId} className="border-b border-hairline">
                  <td className="py-4 pr-4 font-mono text-ink-soft">{index + 1}</td>
                  <td className="py-4 pr-4">
                    <Link href={`/results/2026-07-v2-1/models/${modelSlug(row.modelId)}`} className="font-medium hover:text-paprika">
                      {row.displayName}
                    </Link>
                    <span className="ml-2 text-xs text-ink-soft">{row.provider}</span>
                  </td>
                  <td className="py-4 pr-4 font-mono">{formatScore(row.overall)}</td>
                  <td className="py-4 pr-4 font-mono text-ink-soft">
                    {row.overallCi ? `${row.overallCi[0].toFixed(1)}–${row.overallCi[1].toFixed(1)}` : '—'}
                  </td>
                  <td className="py-4 pr-4 font-mono text-ink-soft">
                    {row.frontier == null ? '—' : formatScore(row.frontier)}
                  </td>
                  <td className="py-4 text-xs text-ink-soft">
                    {leadingGroup.has(row.modelId) ? 'Unresolved leading group' : 'Historical score only'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mt-16 grid gap-10 border-y border-hairline py-12 lg:grid-cols-[0.7fr_1.3fr]">
        <div>
          <ResearchStatusChip tone="exploratory">Exploratory sensitivity</ResearchStatusChip>
          <h2 className="mt-5 font-display text-3xl font-semibold">The top order is fragile.</h2>
        </div>
        <div>
          <p className="leading-relaxed text-ink-soft">
            Excluding all 12 active items with negative observed top–bottom discrimination—six
            keyword and six LLM-judge—reordered all four members of the unrounded raw-score top four
            without changing that group’s membership. Other defensible scoring choices produce other
            orders. This is evidence of sensitivity, not a corrected ranking.
          </p>
          <p className="mt-5 text-sm"><TextLink href="/research/v2-1-autopsy#sensitivity">See the analysis table</TextLink></p>
        </div>
      </section>

      <section className="mt-16">
        <h2 className="border-b-2 border-ink pb-3 font-display text-3xl font-semibold">Errata and known limitations</h2>
        <div className="mt-6 grid gap-px border border-hairline bg-hairline md:grid-cols-3">
          {[
            ['Scoring semantics', 'Keyword and constraint checks sometimes penalised warnings, substitutions and cross-contamination advice for naming a forbidden ingredient.'],
            ['Item-bank saturation', 'Thirty-three of 102 active items were perfect for every model; unrounded effective item count is approximately 24.0.'],
            ['Judge evidence', 'Panel disagreements were not independently adjudicated, and current audit classifications are agent-produced and unblinded.'],
          ].map(([title, body]) => (
            <div key={title} className="bg-paper p-6">
              <h3 className="font-display text-xl font-semibold">{title}</h3>
              <p className="mt-3 text-sm leading-relaxed text-ink-soft">{body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-16 border-t-2 border-ink pt-8">
        <div className="flex flex-wrap gap-x-6 gap-y-3 text-sm">
          <TextLink href="/research/v2-1-autopsy">Read the full autopsy</TextLink>
          <TextLink href="/corpus/2026-07-v2-1">Inspect the preserved corpus</TextLink>
          <TextLink href="/questions">Current question bank with archived answers</TextLink>
          <a href="https://github.com/joooord/cookingbench" className="underline decoration-hairline underline-offset-4 hover:text-paprika">Code and artifacts</a>
        </div>
        <p className="mt-8 font-mono text-[0.68rem] text-ink-soft">
          Archived release · {V21_RECORD.publishedDate} · original scores unchanged · response digest {V21_RECORD.corpusDigest}
        </p>
      </section>
    </div>
  );
}
