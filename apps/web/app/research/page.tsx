import type { Metadata } from 'next';
import Link from 'next/link';
import {
  FactStrip,
  ResearchStatusChip,
  TextLink,
} from '@/components/ResearchPrimitives';
import { getV21Snapshot, V21_RECORD } from '@/lib/research';

export const metadata: Metadata = {
  title: 'Research',
  description:
    'CookingBench research on culinary intelligence, benchmark validity, scoring failures and the next scientific programme.',
};

const PAPERS = [
  {
    href: '/research/v2-1-autopsy',
    number: '01',
    type: 'Benchmark autopsy',
    status: 'Preliminary · retrospective · not peer reviewed',
    title: V21_RECORD.title,
    summary:
      'A forensic analysis of saturation, concentrated score influence and a semantic grading failure in the archived v2.1 run. No corrected winner is claimed.',
  },
  {
    href: '/research/can-ai-cook',
    number: '02',
    type: 'Position paper & research proposal',
    status: 'Working paper · proposed programme · not peer reviewed',
    title: 'Can AI cook?',
    summary:
      'A construct framework for evaluating materially constrained, sensory, cultural and recipient-responsive culinary intelligence.',
  },
] as const;

export default function ResearchPage() {
  const snapshot = getV21Snapshot();

  return (
    <div className="pb-20">
      <header className="border-b-2 border-ink py-16 sm:py-24">
        <h1
          className="font-display font-semibold tracking-tight"
          style={{ fontSize: 'clamp(3rem, 8vw, 7rem)', letterSpacing: '-0.05em', lineHeight: 0.9 }}
        >
          Research
        </h1>
        <p className="mt-8 max-w-3xl text-xl leading-relaxed text-ink-soft sm:text-2xl">
          CookingBench studies culinary intelligence and the instruments used to measure it.
          Findings, failures, open questions, data and version history are published together.
        </p>
      </header>

      <section className="py-14">
        <div className="grid border-x border-t border-hairline lg:grid-cols-2">
          {PAPERS.map((paper, index) => (
            <article
              key={paper.number}
              className={`border-b border-hairline p-7 sm:p-10 ${index === 0 ? 'lg:border-r' : ''}`}
            >
              <div className="flex items-center justify-between gap-4">
                <ResearchStatusChip tone={index === 0 ? 'preliminary' : 'proposed'}>
                  {paper.type}
                </ResearchStatusChip>
                <span className="font-mono text-2xl text-hairline">{paper.number}</span>
              </div>
              <h2 className="mt-7 font-display text-3xl font-semibold leading-tight sm:text-4xl">
                <Link href={paper.href} className="transition-colors hover:text-paprika">
                  {paper.title}
                </Link>
              </h2>
              <p className="mt-5 leading-relaxed text-ink-soft">{paper.summary}</p>
              <p className="mt-7 font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">
                {paper.status}
              </p>
              <p className="mt-5 text-sm"><TextLink href={paper.href}>Read publication</TextLink></p>
            </article>
          ))}
        </div>
      </section>

      <section className="grid gap-10 border-y border-hairline py-12 lg:grid-cols-[0.7fr_1.3fr]">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-paprika">Evidence status</p>
          <h2 className="mt-4 font-display text-3xl font-semibold">What exists today</h2>
        </div>
        <div className="space-y-7">
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <ResearchStatusChip tone="observed">Preserved</ResearchStatusChip>
            <p className="text-sm leading-relaxed text-ink-soft">
              A complete, immutable primary-response corpus for v2.1, pinned by file and content digest.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <ResearchStatusChip tone="exploratory">Exploratory</ResearchStatusChip>
            <p className="text-sm leading-relaxed text-ink-soft">
              The scoring autopsy and answer classifications were performed after seeing the data;
              the classifications are agent-assisted, unblinded and not independently adjudicated.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
            <ResearchStatusChip tone="proposed">Proposed</ResearchStatusChip>
            <p className="text-sm leading-relaxed text-ink-soft">
              The next benchmark construct, question bank, judging validation and analysis protocol.
              These are a research programme, not completed evidence.
            </p>
          </div>
        </div>
      </section>

      {snapshot ? (
        <section className="py-16">
          <h2 className="font-display text-3xl font-semibold">The open evidence base</h2>
          <p className="mt-4 max-w-2xl leading-relaxed text-ink-soft">
            The scores are not a valid answer to “which model is the best cook?” The responses are
            still valuable evidence for independent reanalysis and better judging experiments.
          </p>
          <div className="mt-8">
            <FactStrip
              facts={[
                { value: snapshot.corpus.models.toLocaleString('en-GB'), label: 'model versions' },
                { value: snapshot.corpus.prompts.toLocaleString('en-GB'), label: 'culinary prompts each' },
                { value: snapshot.corpus.responses.toLocaleString('en-GB'), label: 'preserved responses' },
                { value: snapshot.corpus.emptyAnswers.toLocaleString('en-GB'), label: 'empty answer texts' },
              ]}
            />
          </div>
          <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-sm">
            <TextLink href="/corpus/2026-07-v2-1">Inspect the corpus record</TextLink>
            <TextLink href="/results/2026-07-v2-1">See the archived scores</TextLink>
            <a
              href="https://github.com/joooord/cookingbench"
              className="underline decoration-hairline underline-offset-4 hover:text-paprika"
            >
              Open code and data on GitHub
            </a>
          </div>
        </section>
      ) : null}
    </div>
  );
}
