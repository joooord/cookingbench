import { CATEGORIES, CATEGORY_IDS } from '@cookingbench/core';
import {
  getAnalysis,
  getLatestReport,
  getModelNames,
  getRunConfig,
  getRunCost,
  getStandings,
  getQuestions,
} from '@/lib/data';
import { CATEGORY_COLORS } from '@/lib/format';

export const revalidate = 3600;

export const metadata = {
  title: 'Methodology',
  description:
    'How CookingBench grades AI models: deterministic graders for facts and numbers, a calibrated two-seat LLM judge panel for technique and recipes, all reproducible from the open dataset.',
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
  const standings = report ? getStandings(report) : null;
  const separation =
    report && activePairs.length > 0
      ? {
          runId: report.runId,
          separated: activePairs.filter((p) => p.separated).length,
          total: activePairs.length,
          tiedFirst: standings?.tested ? standings.first.length : 0,
        }
      : null;

  // The panel was named by hand here and went stale the moment a seat changed:
  // the page went on crediting Qwen 3.5 Plus long after the calibration gate
  // had replaced it with Grok 4.5, which means it described a panel that never
  // judged the board on the same screen. Read the seats off the run instead.
  const config = report ? getRunConfig(report.runId) : null;
  const modelNames = getModelNames();
  const panel = (config?.judgePanel ?? []).map((id) => modelNames.get(id) ?? id);
  const cost = report ? getRunCost(report) : null;
  // The published board's own version label, never a hardcoded one. The run id
  // may carry a revision suffix (2026-07-v2.1) that the version does not.
  const methodologyVersion = report?.methodologyVersion ?? 'v1';
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

      {report && (
        // The board badges a version; this page has to say what that version
        // is and which run was scored under it, or the two drift apart with
        // nothing on either page to catch it.
        <p className="mt-6 max-w-[42rem] text-sm leading-relaxed text-ink-soft">
          The archived board — run <span className="tabular">{report.runId}</span> — was scored
          under methodology <strong>{methodologyVersion}</strong>, and this page describes that
          methodology as it stood. A retrospective audit found the derived scores unreliable:
          they remain visible as a historical record, but they{' '}
          <strong>must not be cited as a ranking of culinary ability</strong> — see{' '}
          <a href="/research/v2-1-autopsy" className="text-paprika hover:underline">
            the autopsy
          </a>{' '}
          and the corpus-and-scores erratum in the repository. The roster and judge seats below
          are read from that run, and the grader corrections from the July audit are set out in
          the erratum at the foot of the page. The next methodology is being rebuilt
          measurement-first under the Revision 3 research programme — nothing published here has
          been scored under it.
        </p>
      )}

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
            <strong>The judge panel</strong> replaces a single LLM judge with a panel
            {panel.length > 0 ? (
              <>
                {' '}
                — on run {report?.runId} the seats were{' '}
                {new Intl.ListFormat('en-GB', { type: 'conjunction' }).format(panel)}
              </>
            ) : null}
            . Each answer is scored by two of the seats; a judge never scores a model from
            its own maker (self-preference bias), and which seat sits out is deterministic
            by hash, so every published score is reproducible. Judges are fact-checkers, not
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
            is the second axis: blind, side-by-side human preference. Ballot collection is
            currently <strong>paused</strong> while the flight is rebuilt under the new
            methodology — the archived duel ballots are preserved in the repository, and the{' '}
            <a href="/taste" className="text-paprika hover:underline">Taste Board</a> explains
            what a future Taste ordering would be allowed to claim. Taste evidence is never
            folded into the precision score.
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
              pairs clear that <strong>uncorrected</strong> 95% screen — a screening figure,
              not a confirmatory ordering: at a family of {separation.total} tests, several
              pairs would be expected to clear it by chance even on a roster of identical
              models. {separation.tiedFirst > 1 ? (
                <>
                  {separation.tiedFirst} models share first place: nothing on the board is
                  shown ahead of any of them even at the uncorrected level.
                </>
              ) : (
                <>The top of the board clears the screen.</>
              )}{' '}
              This is also why the site never advertises a single winner from a lead of a
              tenth of a point.
            </p>
          )}
          <p className="mt-4">
            The archived board&apos;s places are one plus the number of models shown ahead at
            that uncorrected level, over all pairs rather than adjacent ones. Statistical ties
            do not chain: A tied with B and B tied with C says nothing about A against C, and
            following such a chain down this board would merge almost the whole roster into a
            single place. A multiplicity-corrected ordering would separate fewer pairs still —
            which is one reason these places are archived history, not a claim.
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
            grading is layered: deterministic checks need no opinion at all; the panel
            handles the subjective bulk; and every answer its two seats disagreed on by
            more than 15 points is flagged in the run artifacts for a person to settle.
          </p>
          <p className="mt-4">
            Where that actually stands, since a page like this is worth nothing if it
            describes an intention as a practice: the flags are computed and published with
            every run, but the expert layer meant to clear them is not yet staffed, and{' '}
            <strong>no published score has been changed by a human review</strong>. We are
            recruiting professional chefs and nutritionists for it. The{' '}
            <a href="/tastetest" className="text-paprika hover:underline">Taste Test</a> is
            the third signal; its ballot collection is paused during the rebuild, and any
            future taste evidence stays beside the precision score, never folded into it.
          </p>
        </section>

        <section>
          <h2 className="border-b-2 border-ink pb-2 font-display text-xl font-medium">Reproducibility</h2>
          <p className="mt-4">
            Models run via OpenRouter at temperature {config?.temperature ?? 0} with fixed
            token caps
            {config?.maxTokens && config?.maxTokensRecipe ? (
              <>
                {' '}
                — {config.maxTokens.toLocaleString('en-GB')} tokens for most questions and{' '}
                {config.maxTokensRecipe.toLocaleString('en-GB')} for recipe generation. The
                split is not cosmetic: some providers count hidden reasoning against that cap
                and others do not, so one flat cap truncated the answers of the ones that do
                while leaving their rivals untouched
              </>
            ) : null}
            . Raw responses, per-request costs, grading details and the judge configuration
            are committed to the open repository, so every published leaderboard can be
            rebuilt from git alone.
          </p>
          {report && cost && (
            // Published separately from the board's per-model column, which is
            // candidate spend alone. Reporting only that column understated
            // this run by more than a third of what it cost.
            <p className="mt-4">
              Run {report.runId} cost{' '}
              <span className="tabular">${cost.candidateUsd.toFixed(2)}</span> in candidate
              answers,{' '}
              {cost.judgeUsd === null ? (
                <>an unrecorded amount on the judge panel</>
              ) : (
                <>
                  <span className="tabular">${cost.judgeUsd.toFixed(2)}</span> on the judge panel
                </>
              )}{' '}
              and{' '}
              {cost.calibrationUsd === null ? (
                <>an unrecorded amount on the calibration gate</>
              ) : (
                <>
                  <span className="tabular">${cost.calibrationUsd.toFixed(2)}</span> on the
                  calibration gate
                </>
              )}
              {cost.complete ? (
                <>
                  {' '}
                  — <span className="tabular">${cost.knownUsd.toFixed(2)}</span> in total.
                </>
              ) : (
                <>
                  {' '}
                  — at least <span className="tabular">${cost.knownUsd.toFixed(2)}</span> in
                  total, the unrecorded parts being unknown rather than free.
                </>
              )}{' '}
              The leaderboard&rsquo;s per-model cost column covers candidate answers only, so
              it does not add up to that figure.
            </p>
          )}
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
