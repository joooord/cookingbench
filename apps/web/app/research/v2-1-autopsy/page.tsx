import type { Metadata } from 'next';
import Link from 'next/link';
import {
  EvidenceNote,
  FactStrip,
  PublicationHeader,
  ResearchStatusChip,
  TextLink,
} from '@/components/ResearchPrimitives';
import { getV21Snapshot, V21_RECORD } from '@/lib/research';

export const metadata: Metadata = {
  title: 'How a benchmark manufactured a convincing ranking',
  description:
    'A preliminary retrospective autopsy of CookingBench v2.1: saturation, concentrated item influence and a reproduced semantic scoring failure. No corrected winner is claimed.',
  alternates: { canonical: '/research/v2-1-autopsy' },
  openGraph: {
    title: 'CookingBench v2.1 did not reliably discover the best AI cook',
    description: 'A preliminary benchmark autopsy. Retrospective, not peer reviewed, no corrected winner claimed.',
  },
};

const GRADER_ROWS = [
  ['Keyword', '22', '47.5%', '6', '6', '5'],
  ['LLM judge', '45', '30.1%', '6', '3', '2'],
  ['Numeric', '34', '17.1%', '0', '27', '26'],
  ['Range', '1', '5.3%', '0', '0', '0'],
] as const;

const SENSITIVITY_ROWS = [
  ['1', 'Sol Pro', 'GPT-5.4 Mini', 'Sol Pro', 'Sol Pro'],
  ['2', 'GPT-5.4 Mini', 'Terra Pro', 'GPT-5.4 Mini', 'Terra Pro'],
  ['3', 'Grok 4.5', 'Sol Pro', 'Terra Pro', 'GPT-5.4 Mini'],
  ['4', 'Terra Pro', 'Grok 4.5', 'Grok 4.5', 'Fable 5'],
  ['5', 'Fable 5', 'Fable 5', 'Fable 5', 'Grok 4.5'],
] as const;

export default function AutopsyPage() {
  const snapshot = getV21Snapshot();
  if (!snapshot) {
    return (
      <div className="py-20">
        <h1 className="font-display text-4xl font-semibold">The v2.1 evidence is unavailable.</h1>
        <p className="mt-5 max-w-2xl text-ink-soft">
          This publication only renders when the pinned archive can be verified. No figures are shown from an unverified source.
        </p>
      </div>
    );
  }

  return (
    <article className="pb-24">
      <PublicationHeader
        title={V21_RECORD.title}
        subtitle="A forensic audit of a complete response corpus and an instrument that claimed more precision than its evidence could support."
        statuses={[
          { label: 'Preliminary', tone: 'preliminary' },
          { label: 'Retrospective', tone: 'exploratory' },
          { label: 'Not peer reviewed', tone: 'proposed' },
          { label: 'Human validation pending', tone: 'proposed' },
        ]}
        meta={`Working paper 01 · version 0.1 · web publication ${V21_RECORD.webPublicationDate} · run ${V21_RECORD.runId}`}
        actions={[
          { label: 'Archived result', href: '/results/2026-07-v2-1' },
          { label: 'Corpus', href: '/corpus/2026-07-v2-1' },
          { label: 'Next programme', href: '/research/can-ai-cook' },
        ]}
      />

      <div className="grid gap-12 pt-12 lg:grid-cols-[minmax(0,1fr)_17rem]">
        {/* min-w-0: a grid item defaults to min-width:auto, which refuses to
            shrink below the intrinsic width of its widest child (the min-w-[44rem]
            tables) and blows past max-width on a phone. min-w-0 lets the column
            shrink to the track so the tables' own overflow-x-auto scrolls them. */}
        <div className="min-w-0 max-w-[46rem]">
          <section id="abstract" className="scroll-mt-8">
            <p className="font-mono text-xs uppercase tracking-[0.14em] text-paprika">Abstract</p>
            <p className="mt-4 font-display text-2xl leading-relaxed sm:text-3xl">
              CookingBench did not establish a definitive best AI cook. It produced something
              more useful: a clear case study in how a benchmark can manufacture a persuasive
              order from saturated questions, concentrated score influence and a scorer that
              confused mentioning an unsafe ingredient with recommending it.
            </p>
            <p className="mt-6 leading-relaxed text-ink-soft">
              The finding is fragility, not a corrected leaderboard. The original scores are
              preserved, every later analysis is separately labelled, and the central semantic
              classifications remain unblinded and agent-assisted pending independent review.
            </p>
          </section>

          <section id="evidence" className="mt-16 scroll-mt-8">
            <h2 className="border-b-2 border-ink pb-3 font-display text-3xl font-semibold">1. The evidence</h2>
            <p className="mt-6 leading-relaxed">
              The archived run contains {snapshot.corpus.models} model versions answering the same{' '}
              {snapshot.corpus.prompts} prompts: {snapshot.corpus.responses.toLocaleString('en-GB')} stored
              responses. None has empty answer text. The corpus is primary material; the scores are a
              derived interpretation of it.
            </p>
            <div className="mt-7">
              <FactStrip
                facts={[
                  { value: snapshot.analysis.activeQuestions.toString(), label: 'items counted in the published overall' },
                  { value: snapshot.analysis.allPerfect.toString(), label: 'active items perfect for every model' },
                  { value: snapshot.analysis.withSignal.toString(), label: 'active items with score SD above one point' },
                  { value: '≈24.0', label: 'effective item count from unrounded scores' },
                ]}
              />
            </div>
            <EvidenceNote label="Correction to the archived artifact">
              The committed analysis reports {snapshot.analysis.effectiveItemsArtifact.toFixed(1)} effective items
              because it computes the concentration index over variance shares rounded to three
              decimals before storage. Recalculation from unrounded scores gives approximately
              24.0. The SD-above-one tile quotes the committed artifact; from unrounded scores
              it reads 65 (one item&apos;s SD rounds down to exactly 1.0). The archive is not
              rewritten; the discrepancies are disclosed.
            </EvidenceNote>
          </section>

          <section id="variance" className="mt-16 scroll-mt-8">
            <h2 className="border-b-2 border-ink pb-3 font-display text-3xl font-semibold">2. Where separation came from</h2>
            <p className="mt-6 leading-relaxed">
              Keyword-scored items were 22 of 102 ranked items yet accounted for 47.5% of the
              summed across-model itemwise variance. That quantity is not a covariance-aware
              decomposition of leaderboard variance; it is a concentration diagnostic showing
              which items supplied the board’s visible spread.
            </p>
            <div className="mt-7 overflow-x-auto border-t border-ink">
              <table className="w-full min-w-[42rem] border-collapse text-sm">
                <caption className="py-3 text-left font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">
                  Table 1 · Active items by grader family
                </caption>
                <thead>
                  <tr className="border-y border-hairline text-left font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">
                    {['Grader', 'Items', 'Itemwise variance share', 'Disc < 0', 'Disc = 0', 'All perfect'].map((label) => (
                      <th key={label} scope="col" className="py-3 pr-5 font-normal">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {GRADER_ROWS.map((row) => (
                    <tr key={row[0]} className="border-b border-hairline">
                      {row.map((cell, index) => (
                        <td key={index} className={`py-3 pr-5 ${index > 0 ? 'font-mono' : ''}`}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">
              Negative discrimination is a diagnostic, not proof that an item is defective.
              Six keyword items were negative and six were exactly zero; five of those zero items
              were perfect for everyone. Item content must still be inspected.
            </p>
          </section>

          <section id="flav-014" className="mt-16 scroll-mt-8">
            <h2 className="border-b-2 border-ink pb-3 font-display text-3xl font-semibold">3. The case that made the failure visible</h2>
            <div className="mt-7 border-x border-t border-hairline">
              {[
                ['Prompt condition', 'Zero chilli heat for a guest with a genuine capsaicin intolerance; the prompt itself mentions a previous habanero blend.'],
                ['Scoring operation', 'The keyword grader forbids the bare term “habanero” unless a narrow sentence-window negation rule fires.'],
                ['Observed result', 'Nine of fourteen responses received zero, including answers warning against cross-contamination and hidden chilli ingredients.'],
                ['Why it matters', 'The same safety concept earned either 0 or 100 depending on sentence shape, not culinary quality.'],
              ].map(([label, value]) => (
                <div key={label} className="grid border-b border-hairline px-5 py-5 sm:grid-cols-[10rem_1fr] sm:gap-6">
                  <p className="font-mono text-[0.68rem] uppercase tracking-wider text-paprika">{label}</p>
                  <p className="mt-2 leading-relaxed text-ink-soft sm:mt-0">{value}</p>
                </div>
              ))}
            </div>
            <blockquote className="my-8 border-l-2 border-paprika pl-6 font-display text-2xl leading-relaxed">
              “Don’t use the grinder, jar, spoon, or board that handled your habanero mix.”
              <footer className="mt-3 font-sans text-sm text-ink-soft">
                Correct safety advice from GPT-5.6 Sol Pro; published item score: 0.
              </footer>
            </blockquote>
            <p className="leading-relaxed">
              A matcher cannot reliably tell whether an ingredient is being used, avoided,
              substituted, checked on a label, isolated for another diner or used as a comparison.
              This is a semantic judgement disguised as string detection.
            </p>
            <EvidenceNote label="Validation boundary">
              The exact zero scores and matched text are reproducible from the archive. The claim
              that eight of the nine zeros punished correct advice is an unblinded, agent-assisted
              classification awaiting independent human adjudication.
            </EvidenceNote>
          </section>

          <section id="sensitivity" className="mt-16 scroll-mt-8">
            <h2 className="border-b-2 border-ink pb-3 font-display text-3xl font-semibold">4. One run, several plausible boards</h2>
            <p className="mt-6 leading-relaxed">
              Post-hoc reanalyses do not reveal the “real” winner. They test whether the published
              order survives defensible changes. Here, removing all 12 active items with negative
              observed top–bottom discrimination (six keyword and six LLM-judge) reordered all four
              members of the unrounded raw-score top four without changing that four-model membership.
            </p>
            <div className="mt-7 overflow-x-auto border-t border-ink">
              <table className="w-full min-w-[44rem] border-collapse text-sm">
                <caption className="py-3 text-left font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">
                  Table 2 · Exploratory ordering sensitivity
                </caption>
                <thead>
                  <tr className="border-y border-hairline text-left font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">
                    {['Published order', 'Published (unrounded raw-score order)', '12 negative-discrimination items excluded', 'All keyword items excluded', 'Judge component only'].map((label) => (
                      <th key={label} scope="col" className="py-3 pr-5 font-normal">{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {SENSITIVITY_ROWS.map((row) => (
                    <tr key={row[0]} className="border-b border-hairline">
                      {row.map((cell, index) => (
                        <td key={index} className={`py-3 pr-5 ${index === 0 ? 'font-mono text-ink-soft' : ''}`}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-sm leading-relaxed text-ink-soft">
              The archived board&apos;s own row order breaks the 96.0 three-way tie differently:
              it sorts on the one-decimal rounded overall, so its #1/#2 are insertion order,
              while this table&apos;s &ldquo;Published&rdquo; column uses full-precision means.
              Neither ordering is supported as a ranking; that is the point.
              Exploratory only. Items were selected after observing the scores. No row in this table
              is a corrected leaderboard and none should be read as one.
            </p>
          </section>

          <section id="conclusion" className="mt-16 scroll-mt-8">
            <h2 className="border-b-2 border-ink pb-3 font-display text-3xl font-semibold">5. What the evidence supports</h2>
            <div className="mt-7 grid gap-px border border-hairline bg-hairline sm:grid-cols-2">
              <div className="bg-paper p-6">
                <ResearchStatusChip tone="observed">Supported</ResearchStatusChip>
                <ul className="mt-5 space-y-3 text-sm leading-relaxed">
                  <li>The archived response corpus is complete and preserved.</li>
                  <li>The published top was unresolved under the run’s own paired comparison rule.</li>
                  <li>A specific keyword mechanism assigned different scores to semantically equivalent safety advice.</li>
                  <li>The displayed order was sensitive to post-hoc scoring choices.</li>
                </ul>
              </div>
              <div className="bg-paper-tint p-6">
                <ResearchStatusChip tone="preliminary">Not supported</ResearchStatusChip>
                <ul className="mt-5 space-y-3 text-sm leading-relaxed">
                  <li>That any one model was definitively the best cook.</li>
                  <li>That a post-hoc “cleaned” order is the true ranking.</li>
                  <li>That dispersion alone validates an item or grader family.</li>
                  <li>That an AI judge score is tasted flavour or human ground truth.</li>
                </ul>
              </div>
            </div>
            <p className="mt-8 font-display text-3xl leading-snug">
              The most publishable result is not the old winner. It is the autopsy of how
              apparently rigorous machinery created a more convincing claim than the evidence earned.
            </p>
          </section>

          <section id="provenance" className="mt-16 scroll-mt-8">
            <h2 className="border-b-2 border-ink pb-3 font-display text-3xl font-semibold">6. Provenance and disclosure</h2>
            <dl className="mt-6 border-t border-hairline text-sm">
              {[
                ['Primary evidence', `Run ${V21_RECORD.runId}: leaderboard, analysis, scores, calibration, configuration and 2,576 response files.`],
                ['Response digest', V21_RECORD.corpusDigest],
                ['Analysis status', 'Retrospective and exploratory. No model calls and no answer regeneration were used for this audit.'],
                ['Human validation', 'Pending. Defect classifications were produced by AI agents working unblinded to model and score.'],
                ['Authorship disclosure', 'CookingBench project; project lead Jordan Pitts. Analysis, code review and drafting were substantially AI-assisted.'],
                ['Version rule', 'The archived run is never silently regraded. Corrections are separate, versioned records.'],
              ].map(([term, value]) => (
                <div key={term} className="grid border-b border-hairline py-4 sm:grid-cols-[10rem_1fr] sm:gap-6">
                  <dt className="min-w-0 font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">{term}</dt>
                  {/* min-w-0 + break-all: a grid item defaults to min-width:auto and
                      overflow-wrap alone can't shrink an unbreakable 64-char digest
                      below its own width; break-all lets it wrap on a phone. */}
                  <dd className="mt-2 min-w-0 break-all leading-relaxed sm:mt-0 sm:break-words">{value}</dd>
                </div>
              ))}
            </dl>
            <div className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm">
              <a href="https://github.com/joooord/cookingbench/blob/9f4b249e56fbdbe7c30b19aa6a10906563a15925/docs/papers/01-autopsy.md" className="underline decoration-hairline underline-offset-4 hover:text-paprika">
                Read the repository draft
              </a>
              <TextLink href="/corpus/2026-07-v2-1">Verify the corpus</TextLink>
              <TextLink href="/results/2026-07-v2-1">Inspect original scores</TextLink>
            </div>
          </section>
        </div>

        <aside className="hidden lg:block">
          <nav className="sticky top-8 border-l border-hairline pl-5 text-sm" aria-label="Paper contents">
            <p className="font-mono text-[0.68rem] uppercase tracking-wider text-ink-soft">Contents</p>
            <ol className="mt-4 space-y-3 text-ink-soft">
              {([
                ['Abstract', '#abstract'],
                ['1. Evidence', '#evidence'],
                ['2. Separation', '#variance'],
                ['3. flav-014', '#flav-014'],
                ['4. Sensitivity', '#sensitivity'],
                ['5. Conclusions', '#conclusion'],
                ['6. Provenance', '#provenance'],
              ] as const).map(([label, href]) => (
                <li key={href}><Link href={href} className="hover:text-paprika">{label}</Link></li>
              ))}
            </ol>
            <p className="mt-8 border-t border-hairline pt-4 text-xs leading-relaxed text-ink-soft">
              Preliminary · retrospective · not peer reviewed. No corrected winner is claimed.
            </p>
          </nav>
        </aside>
      </div>
    </article>
  );
}
