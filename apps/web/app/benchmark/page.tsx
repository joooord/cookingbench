import type { Metadata } from 'next';
import { ConstructTable, ResearchStatusChip, TextLink } from '@/components/ResearchPrimitives';

export const metadata: Metadata = {
  title: 'The benchmark',
  description: 'What CookingBench measures now, what failed in v2.1 and how the next culinary-intelligence instrument will be built.',
};

export default function BenchmarkPage() {
  return (
    <div className="pb-24">
      <header className="border-b-2 border-ink py-16 sm:py-24">
        <h1 className="font-display text-5xl font-semibold tracking-tight sm:text-7xl">The benchmark</h1>
        <p className="mt-7 max-w-3xl text-xl leading-relaxed text-ink-soft">
          CookingBench is rebuilding its instrument around causal culinary reasoning, explicit
          constructs, validated judging and uncertainty. The old question bank remains public as an archive, not a template to rerun unchanged.
        </p>
      </header>

      <section className="grid gap-px border-x border-b border-hairline bg-hairline sm:grid-cols-3">
        {[
          ['Archived', 'v2.1 questions, answers, scores and analysis are fixed historical evidence.'],
          ['Implemented', 'Evidence boundaries preserve artifacts and prevent a draft from silently becoming a public result.'],
          ['Proposed', 'New constructs, item authoring, judge validation and confirmatory analysis must still be exercised.'],
        ].map(([title, body], index) => (
          <div key={title} className="bg-paper p-6">
            <ResearchStatusChip tone={index === 0 ? 'archived' : index === 1 ? 'observed' : 'proposed'}>{title}</ResearchStatusChip>
            <p className="mt-5 text-sm leading-relaxed text-ink-soft">{body}</p>
          </div>
        ))}
      </section>

      <section className="py-20">
        <h2 className="font-display text-4xl font-semibold">The proposed construct</h2>
        <p className="mt-5 max-w-3xl text-lg leading-relaxed text-ink-soft">
          Future scores should describe a profile, not hide every capability inside one total.
        </p>
        <div className="mt-10"><ConstructTable /></div>
      </section>

      <section className="grid gap-10 border-y border-hairline py-12 lg:grid-cols-3">
        <div>
          <h2 className="font-display text-2xl font-semibold">Questions</h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            Hard, varied tasks with explicit purpose, target evidence, failure modes, lifecycle state and adversarial paraphrases.
          </p>
          <p className="mt-5 text-sm"><TextLink href="/questions">Inspect the current bank and archived answers</TextLink></p>
        </div>
        <div>
          <h2 className="font-display text-2xl font-semibold">Judging</h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            AI panels can scale predicted culinary judgement, but must be tested against blinded expert annotations and retained disagreement.
          </p>
          <p className="mt-5 text-sm"><TextLink href="/research/can-ai-cook#programme">See the validation programme</TextLink></p>
        </div>
        <div>
          <h2 className="font-display text-2xl font-semibold">Method</h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            Per-construct reporting, item health, paired uncertainty, frozen exclusions and analysis sensitivity before any winner claim.
          </p>
          <p className="mt-5 text-sm"><TextLink href="/methodology">Read the current methodology record</TextLink></p>
        </div>
      </section>
    </div>
  );
}
