import type { Metadata } from 'next';
import { FactStrip, ResearchStatusChip, TextLink } from '@/components/ResearchPrimitives';
import { getV21Snapshot, V21_RECORD } from '@/lib/research';

export const metadata: Metadata = {
  title: 'CookingBench v2.1 response corpus',
  description: 'The preserved 2,576-response CookingBench v2.1 corpus, its coverage, digest, provenance and permitted uses.',
  alternates: { canonical: '/corpus/2026-07-v2-1' },
};

export default function CorpusPage() {
  const snapshot = getV21Snapshot();
  if (!snapshot) return <p className="py-20 text-ink-soft">The pinned corpus could not be verified, so no corpus record is shown.</p>;
  const { corpus, report } = snapshot;

  return (
    <div className="pb-24">
      <header className="border-b-2 border-ink py-14 sm:py-20">
        <div className="flex flex-wrap gap-2">
          <ResearchStatusChip tone="observed">Preserved primary material</ResearchStatusChip>
          <ResearchStatusChip tone="archived">Immutable archive</ResearchStatusChip>
        </div>
        <h1 className="mt-7 max-w-5xl font-display text-5xl font-semibold tracking-tight sm:text-7xl">
          The v2.1 response corpus
        </h1>
        <p className="mt-6 max-w-3xl text-xl leading-relaxed text-ink-soft">
          Every planned answer from 14 model versions to 184 culinary prompts, retained exactly as
          returned. The primary material is valuable even though the original scoring is known to be unreliable.
        </p>
      </header>

      <section className="py-12">
        <FactStrip
          facts={[
            { value: corpus.responses.toLocaleString('en-GB'), label: 'response artifacts' },
            { value: corpus.models.toLocaleString('en-GB'), label: 'model versions' },
            { value: corpus.prompts.toLocaleString('en-GB'), label: 'prompts per model' },
            { value: corpus.emptyAnswers.toLocaleString('en-GB'), label: 'empty answer texts' },
          ]}
        />
        <div className="mt-px">
          <FactStrip
            facts={[
              { value: corpus.codePoints.toLocaleString('en-GB'), label: 'Unicode code points of answer text' },
              { value: corpus.utf8Bytes.toLocaleString('en-GB'), label: 'UTF-8 answer-text bytes' },
              { value: corpus.contentFilterFinishes.toLocaleString('en-GB'), label: 'content-filter finish states, disclosed' },
              { value: '184/184', label: 'coverage for every model version' },
            ]}
          />
        </div>
      </section>

      <section className="grid gap-10 border-y border-hairline py-12 lg:grid-cols-[0.65fr_1.35fr]">
        <div>
          <h2 className="font-display text-3xl font-semibold">What this record proves</h2>
        </div>
        <div className="space-y-5 leading-relaxed text-ink-soft">
          <p>
            The archive contains {report.rows.length} rostered model versions and exactly{' '}
            {corpus.responses.toLocaleString('en-GB')} nonempty response artifacts. Each response retains
            its model, prompt, answer text, provider envelope, token counts, cost, latency and finish state.
          </p>
          <p>
            It proves corpus completeness and preservation. It does not validate the original scores,
            prove that the answers are correct or turn an exploratory regrading into confirmatory evidence.
          </p>
        </div>
      </section>

      <section className="py-16">
        <h2 className="border-b-2 border-ink pb-3 font-display text-3xl font-semibold">Integrity record</h2>
        <dl className="mt-6 border-t border-hairline text-sm">
          {[
            ['Run id', V21_RECORD.runId],
            ['Response content digest', V21_RECORD.corpusDigest],
            ['Git response tree', V21_RECORD.responseTree],
            ['Digest scope', 'Sorted response filenames and content in the immutable v2.1 response set.'],
            ['Score status', 'Known unreliable as a ranking; preserved separately from answers.'],
            ['Audit status', 'Agent-produced, unblinded classifications; independent human validation pending.'],
          ].map(([term, value]) => (
            <div key={term} className="grid border-b border-hairline py-4 sm:grid-cols-[13rem_1fr] sm:gap-6">
              <dt className="font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">{term}</dt>
              <dd className="mt-2 break-all leading-relaxed sm:mt-0">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="grid gap-px border border-hairline bg-hairline sm:grid-cols-2">
        <div className="bg-paper p-7">
          <ResearchStatusChip tone="observed">Permitted uses</ResearchStatusChip>
          <ul className="mt-5 space-y-3 text-sm leading-relaxed text-ink-soft">
            <li>Independent exploratory regrading under a declared scheme.</li>
            <li>Blinded culinary adjudication and judge-validation studies.</li>
            <li>Research into scoring, saturation and evaluation failure.</li>
            <li>Regression cases for repaired graders and new question contracts.</li>
          </ul>
        </div>
        <div className="bg-paper-tint p-7">
          <ResearchStatusChip tone="preliminary">Not supported</ResearchStatusChip>
          <ul className="mt-5 space-y-3 text-sm leading-relaxed text-ink-soft">
            <li>Citing the original leaderboard as culinary-ability ground truth.</li>
            <li>Publishing a corrected winner from post-hoc deletions alone.</li>
            <li>Calling AI text judgement tasted flavour or human preference.</li>
            <li>Describing the corpus as independent validation of the benchmark.</li>
          </ul>
        </div>
      </section>

      <div className="mt-10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <a href="https://github.com/joooord/cookingbench/tree/980dfcb5e3ff920fe1a3231121a6115e3fa48dcb/data/runs/2026-07-v2.1" className="underline decoration-hairline underline-offset-4 hover:text-paprika">Open frozen files on GitHub</a>
        <TextLink href="/questions">Current question bank with archived answers</TextLink>
        <TextLink href="/research/v2-1-autopsy">Read the autopsy</TextLink>
        <TextLink href="/results/2026-07-v2-1">See original scores</TextLink>
      </div>
    </div>
  );
}
