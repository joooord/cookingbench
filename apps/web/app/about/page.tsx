import type { Metadata } from 'next';
import { ResearchStatusChip, TextLink } from '@/components/ResearchPrimitives';

export const metadata: Metadata = {
  title: 'About',
  description: 'Why CookingBench uses cooking to study intelligence, and how its evidence, failures and future claims are governed.',
};

export default function AboutPage() {
  return (
    <div className="pb-24">
      <header className="border-b-2 border-ink py-16 sm:py-24">
        <h1 className="font-display text-5xl font-semibold tracking-tight sm:text-7xl">About CookingBench</h1>
        <p className="mt-7 max-w-3xl text-xl leading-relaxed text-ink-soft">
          An open research programme asking how much culinary intelligence language models can
          reconstruct, and building an instrument honest enough to admit when it cannot tell.
        </p>
      </header>

      <section className="mx-auto max-w-3xl py-16">
        <ResearchStatusChip tone="proposed">Mission</ResearchStatusChip>
        <p className="mt-7 font-display text-3xl leading-relaxed">
          Cooking is calories plus art, made through knowledge, skill, attention and care. It is
          materially constrained, culturally situated and almost universally legible. That makes it
          a fascinating place to ask what AI knows, predicts and understands.
        </p>
        <p className="mt-8 leading-relaxed text-ink-soft">
          The project is led by cook and researcher Jordan Pitts. Research, analysis, software and
          drafting use substantial AI assistance; that assistance is disclosed rather than treated
          as invisible authorship. Independent human review is required before exploratory findings
          become validated corrections.
        </p>
      </section>

      <section className="grid gap-px border border-hairline bg-hairline sm:grid-cols-3">
        {[
          ['Show the evidence', 'Primary responses, scores, code, uncertainty, errata and version history should travel with every public claim.'],
          ['Publish the failure', 'A benchmark that discovers its own ranking is unreliable has found a result worth sharing, not something to hide.'],
          ['Earn the winner', 'CookingBench will name one best model only if a preregistered, validated instrument actually separates one.'],
        ].map(([title, body]) => (
          <div key={title} className="bg-paper p-7">
            <h2 className="font-display text-2xl font-semibold">{title}</h2>
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">{body}</p>
          </div>
        ))}
      </section>

      <div className="mt-12 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <TextLink href="/research">Read the research</TextLink>
        <TextLink href="/benchmark">Explore the benchmark</TextLink>
        <TextLink href="/results">Inspect results</TextLink>
        <a href="https://github.com/joooord/cookingbench" className="underline decoration-hairline underline-offset-4 hover:text-paprika">Open repository</a>
      </div>
    </div>
  );
}
