import { CATEGORIES, CATEGORY_IDS } from '@cookingbench/core';
import { getAnalysis, getLatestReport, getTiedRanks, getQuestions } from '@/lib/data';
import { CATEGORY_COLORS } from '@/lib/format';

export const revalidate = 3600;

export const metadata = {
  title: 'Methodology',
  description:
    'How CookingBench grades AI models: deterministic graders for facts and numbers, a double-judged LLM rubric for technique and recipes, all reproducible from the open dataset.',
};

export default function MethodologyPage() {
  const questions = getQuestions();
  const counts = new Map<string, number>();
  for (const q of questions) counts.set(q.category, (counts.get(q.category) ?? 0) + 1);

  // Read from the published run rather than hardcoded, so these numbers cannot
  // drift away from the board they describe — that drift is exactly how a
  // methodology page starts lying.
  const report = getLatestReport();
  const analysis = report ? getAnalysis(report.runId) : null;
  const activePairs = analysis?.separation?.filter((p) => p.scope === 'active') ?? [];
  const ranks = report ? getTiedRanks(report.runId) : null;
  const separation =
    report && activePairs.length > 0
      ? {
          runId: report.runId,
          separated: activePairs.filter((p) => p.separated).length,
          total: activePairs.length,
          tiedFirst: report.rows.filter((r) => ranks?.get(r.modelId) === 1).length,
        }
      : null;
  const saturation =
    analysis && analysis.activeQuestions > 0
      ? {
          activeQuestions: analysis.activeQuestions,
          activeAllPerfect: analysis.activeAllPerfect,
          activeWithSignal: analysis.activeWithSignal,
          effectiveItems: analysis.effectiveItems,
        }
      : null;

  return (
    <div className="py-16">
      <h1
        className="font-display font-semibold tracking-tight"
        style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', letterSpacing: '-0.02em' }}
      >
        Methodology
      </h1>

      <div className="mt-10 max-w-[42rem] space-y-12 leading-relaxed">
        <section>
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">Why this benchmark</h2>
          <p className="mt-4">
            Cooking is an unusually good probe of model reliability: it mixes hard
            arithmetic (scaling, conversions, nutrition math), regulated facts (food-safety
            temperatures), and judgement (technique, flavour). Models visibly differ here —
            and crucially, <strong>new versions of the same model family sometimes regress on
            quantities and volumes</strong> while improving elsewhere. CookingBench makes that
            measurable.
          </p>
        </section>

        <section>
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">Dataset</h2>
          <p className="mt-4">
            {questions.length} hand-written questions across {CATEGORY_IDS.length} categories.
            Most are graded deterministically; the rest by a reference-anchored LLM judge.
            <strong> The entire dataset is public</strong> — we don&rsquo;t pretend to have a
            secret hold-out. Contamination defence is mechanical instead: after every run,
            item analysis demotes saturated questions to a separate Basics tier (a regression
            gate excluded from the Overall score) and the active set is refreshed with harder,
            real-life items. The dataset carries a canary string so training-data filters can
            exclude it.
          </p>
          <ul className="mt-4 space-y-2 text-sm">
            {CATEGORY_IDS.map((id) => (
              <li key={id} className="flex items-center gap-3">
                <span className="h-2 w-2 shrink-0" style={{ background: CATEGORY_COLORS[id] }} />
                <span className="font-medium">{CATEGORIES[id].name}</span>
                <span className="tabular text-ink-soft">{counts.get(id) ?? 0} questions</span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">Grading</h2>
          <p className="mt-4">
            <strong>Deterministic graders</strong> handle anything with a right answer: numbers
            are extracted from the model's final answer line (handling fractions, thousands
            separators and ranges), converted across units where equivalent (350°F = 177°C),
            and checked against a tolerance. Answers that merely restate a value from the
            question never get credit. Unsafe advice (e.g. washing raw chicken) zeroes the
            question regardless of anything else said.
          </p>
          <p className="mt-4">
            <strong>The judge panel</strong> (methodology v2) replaces a single LLM judge
            with three: Claude Opus 4.8, GPT-5.5 and Qwen 3.5 Plus. Each answer is scored
            by two of the three seats; a judge never scores a model from its own maker
            (self-preference bias), and the remaining seat rotation is deterministic by
            hash, so every published score is reproducible. Judges are fact-checkers, not
            mark-givers: each compares the answer to a reference and lists concrete faults
            — typed critical, major or minor — and code maps those to deductions
            (−40/−15/−5 from 100). Never awarding points removes the grade-inflation
            ceiling that saturated v1. Judges are blind to which model wrote the answer,
            cross-judge disagreements over 15 points are flagged for human review, and
            every panel seat must independently pass a calibration gate (reproducing
            hand-scored anchor answers) before a run is accepted. For constrained recipe
            generation the panel score is blended with deterministic constraint checks —
            e.g. an allergen appearing in a &ldquo;nut-free&rdquo; recipe.
          </p>
          <p className="mt-4">
            <strong>Precision and taste are scored separately.</strong> Everything above
            measures precision — facts, math, constraints, technique. But a benchmark
            that stops there is a metrics test, not a flavour test. The{' '}
            <a href="/tastetest" className="text-paprika hover:underline">Taste Test</a>{' '}
            is the second axis: blind, side-by-side human votes on paired answers,
            arena-style. Every ballot is kept forever and a Bradley-Terry rating is
            fitted to the full history on the{' '}
            <a href="/taste" className="text-paprika hover:underline">Taste Board</a>;
            with enough battles the human win rate also appears as its own leaderboard
            column — never folded into the precision score.
          </p>
          <p className="mt-4">
            Every question scores 0–100. The <strong>Overall</strong> score is the plain mean
            over active questions, with a 95% bootstrap confidence interval over questions
            shown as ±. <strong>Frontier</strong> is the mean over difficulty-4+ items —
            compound multi-step chains where errors compound, dangerous-premise traps,
            buried-constraint briefs and locale traps (a UK pint, an Australian tablespoon).
            <strong> Basics</strong> is the saturated tier every model should ace; a dip
            there is a regression worth investigating, and transport incidents (empty or
            provider-filtered responses, retried then scored 0) are reported separately so
            infrastructure noise is never mistaken for skill.
          </p>
        </section>

        <section id="separation" className="scroll-mt-8">
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">
            What the ranking can and cannot tell you
          </h2>
          <p className="mt-4">
            The ± on the leaderboard is a <em>marginal</em> confidence interval: it describes
            one model on its own. Two of them overlapping neither proves nor disproves that
            one model beats the other, so an ordering cannot be read off the Overall column.
            Because every model answers the same questions, the honest comparison is{' '}
            <strong>paired</strong> — resample the per-question score <em>differences</em>,
            which cancels out how hard the questions happen to be. A pair counts as
            separated when one model still leads in at least 95% of 4,000 resamples.
          </p>
          {separation && (
            <p className="mt-4">
              On run {separation.runId}, {separation.separated} of {separation.total} model
              pairs separate. {separation.tiedFirst > 1 ? (
                <>
                  {separation.tiedFirst} models share first place: nothing on the board is
                  shown to beat any of them.
                </>
              ) : (
                <>The top of the board is genuinely ordered.</>
              )}{' '}
              This is also why the site never advertises a single winner from a lead of a
              tenth of a point.
            </p>
          )}
          <p className="mt-4">
            Ranks are computed as one plus the number of models <em>proven</em> better, over
            all pairs rather than adjacent ones. Statistical ties do not chain: A tied with B
            and B tied with C says nothing about A against C, and following such a chain down
            this board would merge almost the whole roster into a single place.
          </p>
        </section>

        <section>
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">
            How much of the dataset is actually working
          </h2>
          <p className="mt-4">
            A question every model answers perfectly costs money and moves no one, so the
            active set is audited after every run and the numbers are published whether or
            not they flatter the benchmark.
          </p>
          {saturation && (
            <ul className="mt-4 space-y-2">
              <li>
                <strong>{saturation.activeQuestions} active questions</strong>, of which{' '}
                {saturation.activeAllPerfect} are answered perfectly by every model on the
                board.
              </li>
              <li>
                <strong>{saturation.activeWithSignal}</strong> carry any between-model signal
                at all.
              </li>
              <li>
                <strong>Effective item count: {saturation.effectiveItems}</strong> — weighting
                each question by its share of the variance, the active set does the work of
                about that many equally-informative questions. That gap is the honest measure
                of how much room the benchmark has left, and closing it means writing harder
                questions, not changing how they are scored.
              </li>
            </ul>
          )}
          <p className="mt-4">
            Saturated items are demoted to the Basics tier — kept as a regression gate,
            excluded from Overall — and replaced. Candidate questions must pass an admission
            gate before they count: a reference answer that scores full marks against its own
            grader, a deliberately wrong answer that does not, and a pilot against a
            frontier model, which rejects the question if the strongest model finds it easy.
          </p>
        </section>

        <section>
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">
            The role of human experts
          </h2>
          <p className="mt-4">
            An AI judge scales, but it shares the blind spots of the models it grades. So
            grading is layered: deterministic checks need no opinion at all; the LLM judge
            handles the subjective bulk; and a sampled and flagged set of answers — anything
            the double-judge disagreed on, plus a random audit slice — is reviewed by people
            who actually cook. We are recruiting professional chefs and nutritionists for
            that expert layer, and their verdicts calibrate the judge over time. A future
            public &ldquo;taste test&rdquo; mode will let visitors blind-vote on paired
            answers, arena-style, as a third independent signal.
          </p>
        </section>

        <section>
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">Reproducibility</h2>
          <p className="mt-4">
            Models run via OpenRouter at temperature 0 with fixed token caps. Raw responses,
            per-request costs, grading details and the judge configuration are committed to
            the open repository, so every published leaderboard can be rebuilt from git alone.
          </p>
        </section>

        <section>
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">
            Erratum — run 2026-06-v2
          </h2>
          <p className="mt-4">
            The keyword grader used to treat a forbidden term as a violation wherever it
            appeared, and its negation detection was too narrow to recognise the shapes a
            correct answer actually takes. Two in particular: a refutation using a contracted
            auxiliary (<em>&ldquo;you haven&rsquo;t dodged a bullet&rdquo;</em>), and naming a
            banned ingredient in order to rule it out (<em>&ldquo;many vegan butters use
            coconut oil &mdash; look for soy-based brands&rdquo;</em>). Separately, an answer
            that came back empty was handed to the judge panel, which deducted once for
            producing nothing and floored at 60 &mdash; so silence scored better than a poor
            answer.
          </p>
          <p className="mt-4">
            The effect was not small. Three questions&rsquo; own hand-written reference
            answers scored 0 against their own graders, and on one item 12 of 13 models were
            zeroed on the constraint check &mdash; three of them while the judge panel scored
            them 100. Eighteen answers in run 2026-06-v2 were marked wrong when they were
            right.
          </p>
          <p className="mt-4">
            Run artifacts are immutable, so 2026-06-v2 stands as published. Re-grading it with
            the corrected graders moves six of thirteen positions: DeepSeek V4 Pro rises from
            11th to 5th, Qwen 3.5 Plus from 9th to 7th, and Kimi K2.6 falls from 8th to 11th
            once its empty answer scores 0 rather than being excluded from its mean. The top
            three are unchanged. Those corrections are carried by the next run, not
            backdated onto this one.
          </p>
          <p className="mt-4 text-sm text-ink-soft">
            <code className="font-mono">bench validate</code> now refuses to run if any
            question&rsquo;s reference answer scores below 100 against its own grader, so this
            class of defect cannot be committed again.
          </p>
        </section>

        <section>
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">Related work</h2>
          <p className="mt-4 text-sm text-ink-soft">
            Existing cooking-adjacent benchmarks measure something different: CookBench
            (embodied planning in a simulated kitchen), CuisineWorld (multi-agent kitchen
            coordination), PizzaCommonSense (commonsense reasoning over recipe steps) and
            Recipe1MSubs (ingredient substitution pairs). To our knowledge CookingBench is
            the first public leaderboard for culinary knowledge correctness in
            general-purpose chat models.
          </p>
        </section>
      </div>
    </div>
  );
}
