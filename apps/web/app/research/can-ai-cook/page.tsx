import type { Metadata } from 'next';
import {
  ConstructTable,
  EvidenceNote,
  PublicationHeader,
  ResearchStatusChip,
  TextLink,
} from '@/components/ResearchPrimitives';
import { NEXT_PROGRAMME, V21_RECORD } from '@/lib/research';

export const metadata: Metadata = {
  title: 'Can AI cook?',
  description:
    'A research proposal for evaluating culinary intelligence across physical constraint, sensory prediction, culture and recipient-responsive care.',
  alternates: { canonical: '/research/can-ai-cook' },
};

export default function CanAiCookPage() {
  return (
    <article className="pb-24">
      <PublicationHeader
        title="Can AI cook?"
        subtitle="Cooking as a test of constrained, cultural and caring intelligence."
        statuses={[
          { label: 'Position paper', tone: 'proposed' },
          { label: 'Research proposal', tone: 'proposed' },
          { label: 'Not peer reviewed', tone: 'preliminary' },
        ]}
        meta={`Working paper 02 · version 0.1 · web publication ${V21_RECORD.webPublicationDate}`}
        actions={[
          { label: 'Benchmark autopsy', href: '/research/v2-1-autopsy' },
          { label: 'Evidence corpus', href: '/corpus/2026-07-v2-1' },
        ]}
      />

      <div className="mx-auto max-w-[52rem] pt-12">
        <p className="font-display text-3xl leading-relaxed sm:text-4xl">
          Calories are survival. Flavour is art. Care is relationship. Cooking is where they meet.
        </p>
        <p className="mt-8 text-lg leading-relaxed text-ink-soft">
          A model can describe the Maillard reaction without smelling dinner and recommend
          hospitality without loving anyone. It can have read thousands of cuisines without
          hunger, muscle memory, family history or responsibility for the person who eats.
          What kind of culinary judgement can language reconstruct, and where does it fail?
        </p>
      </div>

      <section className="mt-20 grid gap-10 border-y-2 border-ink py-12 lg:grid-cols-2">
        <div>
          <ResearchStatusChip tone="observed">Physical constraint</ResearchStatusChip>
          <h2 className="mt-5 font-display text-4xl font-semibold">A plan must survive reality.</h2>
          <p className="mt-5 leading-relaxed text-ink-soft">
            Ratios, heat transfer, time, equipment, microbiology and ingredient function constrain
            what can be made. An eloquent recipe that curdles, burns, poisons or cannot reach the
            table is not a successful cooking plan.
          </p>
        </div>
        <div>
          <ResearchStatusChip tone="proposed">Human judgement</ResearchStatusChip>
          <h2 className="mt-5 font-display text-4xl font-semibold">A meal must matter to someone.</h2>
          <p className="mt-5 leading-relaxed text-ink-soft">
            Flavour, texture, culture, memory, occasion and care determine whether a feasible dish
            is appropriate or desirable. These are not free of evidence, but neither can they be
            reduced to a single temperature or conversion.
          </p>
        </div>
      </section>

      <section className="py-20">
        <div className="grid gap-8 lg:grid-cols-[0.72fr_1.28fr] lg:items-end">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-paprika">Construct proposal</p>
            <h2 className="mt-4 font-display text-4xl font-semibold">One task, several kinds of truth.</h2>
          </div>
          <p className="text-lg leading-relaxed text-ink-soft">
            Cooking is not claimed to be the only domain with these properties. It is unusually
            compact and tractable because material feasibility and human meaning are coupled inside
            the same sequential plan: changing a flavour decision often changes the physics too.
          </p>
        </div>
        <div className="mt-10"><ConstructTable /></div>
      </section>

      <section className="grid gap-10 border-y border-hairline py-14 lg:grid-cols-[0.65fr_1.35fr]">
        <div>
          <p className="font-mono text-xs uppercase tracking-[0.14em] text-paprika">The hard boundary</p>
          <h2 className="mt-4 font-display text-3xl font-semibold">Text can test a plan. It cannot taste a dish.</h2>
        </div>
        <div className="space-y-6 leading-relaxed text-ink-soft">
          <p>
            Text-only CookingBench can test knowledge, causal reasoning, constraint handling,
            adaptation and the realisability of a proposed method. AI judges can estimate predicted
            human sensory appeal from text. Those are meaningful targets if named precisely.
          </p>
          <p>
            It cannot directly measure actual flavour, aroma, mouthfeel, manual skill, service under
            pressure, lived cultural participation or love. A model-blinded comparison of written
            proposals is not a blind taste test. A future cooked-dish study would be a different
            experiment with different evidence.
          </p>
          <EvidenceNote label="Care without pretending consciousness">
            CookingBench can test recipient-responsive behaviour: whether a plan notices a person’s
            needs, dignity, preference, budget, energy and occasion, and changes accordingly. It does
            not claim that the model feels concern, hunger or love.
          </EvidenceNote>
        </div>
      </section>

      <section id="programme" className="scroll-mt-8 py-20">
        <p className="font-mono text-xs uppercase tracking-[0.14em] text-paprika">The next scientific programme</p>
        <h2 className="mt-4 max-w-4xl font-display text-4xl font-semibold tracking-tight sm:text-5xl">
          Ask whether one model is better only after defining what “better” means.
        </h2>
        <p className="mt-6 max-w-3xl text-lg leading-relaxed text-ink-soft">
          The aim is still ambitious: determine which models are good, bad and genuinely better at
          culinary reasoning. The change is methodological. Question quality, judge validity,
          uncertainty and declared claims come before another expensive run.
        </p>

        <div className="mt-10 border-x border-t border-hairline">
          {NEXT_PROGRAMME.map((stage, index) => (
            <div key={stage.stage} className="grid border-b border-hairline px-5 py-6 sm:grid-cols-[7rem_1.15fr_1fr] sm:gap-7">
              <div>
                <span className="font-mono text-xs text-paprika">{String(index + 1).padStart(2, '0')}</span>
                <h3 className="mt-2 font-display text-xl font-semibold">{stage.stage}</h3>
              </div>
              <p className="mt-4 text-sm leading-relaxed sm:mt-0">{stage.work}</p>
              <div className="mt-4 border-l border-hairline pl-4 sm:mt-0">
                <p className="font-mono text-[0.65rem] uppercase tracking-wider text-ink-soft">Release evidence</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{stage.evidence}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y-2 border-paprika bg-paper-tint p-7 sm:p-10">
        <ResearchStatusChip tone="proposed">Open empirical question</ResearchStatusChip>
        <h2 className="mt-6 font-display text-4xl font-semibold">Can AI cook?</h2>
        <p className="mt-5 max-w-3xl text-lg leading-relaxed text-ink-soft">
          Not yet answered. The next CookingBench should make the question sharper rather than the
          claim louder, and produce an answer that remains credible after the scoring system itself is audited.
        </p>
        <div className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <TextLink href="/research/v2-1-autopsy">See what the first instrument taught us</TextLink>
          <TextLink href="/results/2026-07-v2-1">Inspect the archived evidence</TextLink>
        </div>
      </section>
    </article>
  );
}
