import { CATEGORIES, CATEGORY_IDS } from '@cookingbench/core';
import { getQuestions } from '@/lib/data';
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
            <strong>The LLM judge</strong> (methodology v2) is a fact-checker, not a
            mark-giver: it compares each answer to a reference and lists concrete faults —
            each typed critical, major or minor — and code maps those to deductions
            (−40/−15/−5 from 100). It never awards points, which removes the grade-inflation
            ceiling that saturated v1. The judge is blind to which model wrote the answer,
            judges twice at temperature 0, flags large disagreements for human review, and
            must pass a calibration gate (reproducing hand-scored anchor answers) before any
            run is accepted. For constrained recipe generation the judge score is blended
            with deterministic constraint checks — e.g. an allergen appearing in a
            &ldquo;nut-free&rdquo; recipe.
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
