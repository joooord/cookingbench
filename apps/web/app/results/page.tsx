import type { Metadata } from 'next';
import Link from 'next/link';
import { ArchivedResultNotice, ResearchStatusChip, TextLink } from '@/components/ResearchPrimitives';
import { getV21Snapshot, V21_RECORD } from '@/lib/research';

export const metadata: Metadata = {
  title: 'Results',
  description: 'Versioned CookingBench results, preserved with uncertainty, limitations and errata.',
};

export default function ResultsPage() {
  const snapshot = getV21Snapshot();
  return (
    <div className="pb-20">
      <header className="border-b-2 border-ink py-16 sm:py-24">
        <h1
          className="font-display font-semibold tracking-tight"
          style={{ fontSize: 'clamp(3rem, 8vw, 7rem)', letterSpacing: '-0.05em', lineHeight: 0.9 }}
        >
          Results
        </h1>
        <p className="mt-8 max-w-3xl text-xl leading-relaxed text-ink-soft sm:text-2xl">
          Each run is a fixed historical study with its own protocol, evidence and limitations.
          A model does not possess one timeless CookingBench rank.
        </p>
      </header>

      <div className="mt-12"><ArchivedResultNotice /></div>

      {snapshot ? (
        <section className="mt-10 border-x border-t border-hairline">
          <article className="grid border-b border-hairline lg:grid-cols-[0.42fr_1fr]">
            <div className="border-b border-hairline bg-paper-tint p-7 lg:border-b-0 lg:border-r">
              <ResearchStatusChip tone="archived">Archived preliminary</ResearchStatusChip>
              <p className="mt-5 font-mono text-xs text-ink-soft">{V21_RECORD.runId}</p>
              <p className="mt-2 font-mono text-xs text-ink-soft">{V21_RECORD.publishedDate}</p>
            </div>
            <div className="p-7 sm:p-10">
              <h2 className="font-display text-4xl font-semibold">
                <Link href="/results/2026-07-v2-1" className="hover:text-paprika">CookingBench v2.1</Link>
              </h2>
              <p className="mt-5 max-w-3xl leading-relaxed text-ink-soft">
                {snapshot.corpus.models} models, {snapshot.corpus.prompts} prompts each and{' '}
                {snapshot.corpus.responses.toLocaleString('en-GB')} preserved responses. The original
                published scores remain visible, but the scoring instrument did not support a unique
                fine-grained ordering of the leading models.
              </p>
              <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
                <TextLink href="/results/2026-07-v2-1">View archived result</TextLink>
                <TextLink href="/research/v2-1-autopsy">Read the autopsy</TextLink>
                <TextLink href="/corpus/2026-07-v2-1">Open corpus record</TextLink>
              </div>
            </div>
          </article>
        </section>
      ) : (
        <p className="mt-10 border-y border-paprika py-8 text-ink-soft">
          The pinned archive could not be verified, so no result is shown.
        </p>
      )}
    </div>
  );
}
