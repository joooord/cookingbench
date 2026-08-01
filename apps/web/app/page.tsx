import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  ArchivedResultNotice,
  ConstructTable,
  FactStrip,
  ResearchStatusChip,
  TextLink,
} from '@/components/ResearchPrimitives';
import { getV21Snapshot, V21_RECORD } from '@/lib/research';

export const revalidate = 3600;

const arrow = (
  <svg viewBox="0 0 20 20" aria-hidden="true" className="h-4 w-4" fill="none">
    <path d="M4 10h11M11 6l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

function PrimaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center gap-3 border border-ink bg-ink px-5 py-3 text-sm text-paper transition-colors hover:border-paprika hover:bg-paprika"
    >
      {children}
      {arrow}
    </Link>
  );
}

function SecondaryLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center justify-center gap-3 border border-ink px-5 py-3 text-sm transition-colors hover:border-paprika hover:text-paprika"
    >
      {children}
      {arrow}
    </Link>
  );
}

export default function HomePage() {
  const snapshot = getV21Snapshot();
  const corpus = snapshot?.corpus;

  return (
    <div>
      <section className="grid gap-12 py-16 sm:py-24 lg:grid-cols-[1.25fr_0.75fr] lg:items-end">
        <div>
          <h1
            className="max-w-4xl font-display font-semibold tracking-tight"
            style={{ fontSize: 'clamp(3.6rem, 9vw, 8.5rem)', letterSpacing: '-0.055em', lineHeight: 0.86 }}
          >
            Can AI <em className="text-paprika not-italic">cook?</em>
          </h1>
          <p className="mt-9 max-w-2xl text-xl leading-relaxed text-ink-soft sm:text-2xl">
            Cooking joins physical truth with human judgement. A good answer must be safe,
            feasible and technically sound—but it must also understand flavour, culture,
            occasion and the person being fed.
          </p>
          <div className="mt-9 flex flex-col gap-3 sm:flex-row">
            <PrimaryLink href="/research/v2-1-autopsy">Read the benchmark autopsy</PrimaryLink>
            <SecondaryLink href="/corpus/2026-07-v2-1">Explore the preserved responses</SecondaryLink>
          </div>
        </div>

        <div className="border-y border-ink py-5">
          <p className="font-mono text-[0.68rem] uppercase tracking-[0.14em] text-ink-soft">
            The test, in one sequence
          </p>
          <ol className="mt-4">
            {[
              ['01', 'Can it survive physics?', 'Heat · time · ratios · safety'],
              ['02', 'Can it predict experience?', 'Flavour · texture · aroma'],
              ['03', 'Can it respond to a person?', 'Culture · occasion · care'],
            ].map(([number, question, dimensions]) => (
              <li key={number} className="grid grid-cols-[2.5rem_1fr] border-t border-hairline py-4">
                <span className="font-mono text-xs text-paprika">{number}</span>
                <div>
                  <p className="font-display text-lg">{question}</p>
                  <p className="mt-1 font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">
                    {dimensions}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <ArchivedResultNotice />

      <section className="grid gap-px border-x border-b border-hairline bg-hairline lg:grid-cols-2">
        <article className="bg-paper p-7 sm:p-10">
          <ResearchStatusChip tone="observed">What the benchmark exposed</ResearchStatusChip>
          <h2 className="mt-6 max-w-xl font-display text-3xl font-semibold leading-tight sm:text-4xl">
            A leaderboard can be reproducible and still measure the wrong thing.
          </h2>
          <p className="mt-5 max-w-xl leading-relaxed text-ink-soft">
            Some questions separated no models. Others spread scores for the wrong reason.
            One flavour item with a safety constraint gave zero to correct warnings because the
            answers named the ingredient they were telling the user to avoid. The autopsy shows how saturation, semantic scoring
            failures and concentrated influence can create unjustified rank precision.
          </p>
          <p className="mt-7 text-sm"><TextLink href="/research/v2-1-autopsy">Read the forensic audit</TextLink></p>
        </article>

        <article className="bg-paper-tint p-7 sm:p-10">
          <ResearchStatusChip tone="proposed">Why cooking matters</ResearchStatusChip>
          <h2 className="mt-6 max-w-xl font-display text-3xl font-semibold leading-tight sm:text-4xl">
            Cooking is where physics becomes personal.
          </h2>
          <p className="mt-5 max-w-xl leading-relaxed text-ink-soft">
            Heat, time, ratios and microbiology constrain what can work. Flavour, culture,
            memory and care shape whether the result is worth eating. Because both live inside
            the same task, cooking offers an unusually rich way to study what AI understands—and
            what it only sounds as if it understands.
          </p>
          <p className="mt-7 text-sm"><TextLink href="/research/can-ai-cook">Read “Can AI cook?”</TextLink></p>
        </article>
      </section>

      <section className="py-20 sm:py-28">
        <div className="grid gap-8 lg:grid-cols-[0.75fr_1.25fr] lg:items-end">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-paprika">The next instrument</p>
            <h2 className="mt-4 font-display text-4xl font-semibold tracking-tight sm:text-5xl">
              What would culinary intelligence require?
            </h2>
          </div>
          <p className="max-w-2xl text-lg leading-relaxed text-ink-soft">
            There may be no single cooking ability. The next CookingBench will test a profile
            of connected capabilities and report uncertainty rather than forcing every difference
            into one rank.
          </p>
        </div>
        <div className="mt-10"><ConstructTable /></div>
      </section>

      {corpus ? (
        <section className="border-y-2 border-ink py-12 sm:py-16">
          <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr]">
            <div>
              <ResearchStatusChip tone="observed">Preserved primary material</ResearchStatusChip>
              <h2 className="mt-5 font-display text-4xl font-semibold tracking-tight">
                The answers remain valuable even when the scores do not.
              </h2>
            </div>
            <div>
              <p className="text-lg leading-relaxed text-ink-soft">
                v2.1 contains every planned model–prompt response and no empty answer text.
                That does not validate the original ranking. It does preserve the primary material
                needed for blinded adjudication, alternative scoring and independent analysis.
              </p>
              <div className="mt-7"><TextLink href="/corpus/2026-07-v2-1">Open the corpus record</TextLink></div>
            </div>
          </div>
          <div className="mt-10">
            <FactStrip
              facts={[
                { value: corpus.models.toLocaleString('en-GB'), label: 'model versions' },
                { value: corpus.prompts.toLocaleString('en-GB'), label: 'prompts per model' },
                { value: corpus.responses.toLocaleString('en-GB'), label: 'response artifacts' },
                { value: corpus.codePoints.toLocaleString('en-GB'), label: 'answer-text Unicode code points' },
              ]}
            />
          </div>
        </section>
      ) : (
        <section className="border-y-2 border-paprika py-10 text-ink-soft">
          The pinned v2.1 evidence could not be verified, so corpus figures are withheld.
        </section>
      )}

      <section className="grid gap-10 py-20 sm:py-28 lg:grid-cols-[1fr_0.8fr] lg:items-center">
        <div>
          <ResearchStatusChip tone="proposed">Scientific programme</ResearchStatusChip>
          <h2 className="mt-5 max-w-3xl font-display text-4xl font-semibold tracking-tight sm:text-5xl">
            The next run starts with better questions, better judging and a frozen claim.
          </h2>
          <p className="mt-6 max-w-2xl text-lg leading-relaxed text-ink-soft">
            CookingBench will treat question design as the instrument, validate AI judges against
            blinded expert judgements, measure dimensions separately and publish sensitivity—not
            declare a winner simply because a table can be sorted.
          </p>
          <div className="mt-8"><PrimaryLink href="/research/can-ai-cook#programme">See the research programme</PrimaryLink></div>
        </div>
        <blockquote className="border-l-2 border-paprika pl-7 font-display text-3xl leading-snug text-ink-soft">
          “Calories are survival. Flavour is art. Care is relationship. Cooking is where they meet.”
        </blockquote>
      </section>

      <section className="border-t border-hairline py-14">
        <div className="flex flex-col justify-between gap-8 sm:flex-row sm:items-end">
          <div>
            <p className="font-mono text-xs uppercase tracking-wider text-ink-soft">Historical result · July 2026</p>
            <h2 className="mt-3 font-display text-3xl font-semibold">CookingBench v2.1</h2>
            <p className="mt-3 max-w-2xl text-ink-soft">
              Original published scores, uncertainty, the unresolved leading group and every known
              limitation—preserved without silently rewriting the record.
            </p>
          </div>
          <SecondaryLink href="/results/2026-07-v2-1">View archived result</SecondaryLink>
        </div>
        <p className="mt-8 font-mono text-[0.68rem] text-ink-soft">
          Archive record {V21_RECORD.runId} · response digest {V21_RECORD.corpusDigest.slice(0, 16)}…
        </p>
      </section>
    </div>
  );
}
