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
            Roughly 55% are graded deterministically; the rest by a rubric-driven LLM judge.
            A subset of questions is held out (never published) to resist contamination.
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
            <strong>The LLM judge</strong> grades subjective answers against a per-question
            written rubric, blind to which model wrote the answer (self-identifying phrases
            are stripped). Each answer is judged twice at temperature 0 and averaged;
            large disagreements are flagged for manual review. For constrained recipe
            generation, the judge score (70%) is blended with deterministic constraint
            checks (30%) — e.g. an allergen appearing in a "nut-free" recipe.
          </p>
          <p className="mt-4">
            Every question scores 0–100. A category score is the mean of its questions; the
            overall score is the unweighted mean of category scores. The leaderboard also
            reports a <strong>Hard set</strong> score — difficulty-3 questions only. Frontier
            models saturate the easy questions (which exist as a floor, to catch regressions
            and rank smaller models), so the hard set carries the ranking signal at the top:
            inverse and non-linear scaling traps, unit-identity traps (a UK pint, an
            Australian tablespoon, weight-vs-volume ounces), chained conversions, given-data
            nutrition reasoning, and multi-constraint recipe briefs.
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
