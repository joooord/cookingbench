import { describe, expect, it } from 'vitest';
import { gradeKeyword } from '../src/graders/keyword.js';
import { blendJudgeScore, gradeDeterministic } from '../src/graders/index.js';
import type { GraderSpec, Question } from '../src/types.js';

describe('gradeKeyword', () => {
  const buttermilkSpec: Extract<GraderSpec, { type: 'keyword' }> = {
    type: 'keyword',
    required: [
      ['lemon juice', 'vinegar'],
      ['milk'],
      ['rest', 'sit', 'stand', 'curdle', '5 minutes', '10 minutes'],
    ],
  };

  it('scores 100 when every synonym group is satisfied', () => {
    const answer =
      'Stir 1 tablespoon of lemon juice into 1 cup of milk and let it sit for 5–10 minutes until slightly curdled.';
    expect(gradeKeyword(buttermilkSpec, answer).score).toBe(100);
  });

  it('accepts any synonym within a group', () => {
    const answer = 'Add a tablespoon of white vinegar to a cup of milk and let it stand briefly.';
    expect(gradeKeyword(buttermilkSpec, answer).score).toBe(100);
  });

  it('gives partial credit per missing group', () => {
    const answer = 'Just use plain milk instead.';
    expect(gradeKeyword(buttermilkSpec, answer).score).toBeCloseTo(33.33, 1);
  });

  it('is case-insensitive and ignores curly quotes', () => {
    const spec: GraderSpec = { type: 'keyword', required: [["don't wash"]] };
    expect(gradeKeyword(spec, 'You really DON’T WASH raw chicken.').score).toBe(100);
  });

  it('does not zero on negated forbidden terms', () => {
    const spec: GraderSpec = {
      type: 'keyword',
      required: [['sunflower seed butter', 'cheese']],
      forbidden: ['peanut', 'almonds'],
    };
    const answer =
      'Use sunflower seed butter — make sure the label says peanut-free, and avoid almonds entirely.';
    expect(gradeKeyword(spec, answer).score).toBe(100);
  });

  it('still zeroes when the forbidden term is actually used', () => {
    const spec: GraderSpec = {
      type: 'keyword',
      required: [['snack']],
      forbidden: ['peanut'],
    };
    expect(gradeKeyword(spec, 'A great snack: spread peanut butter on crackers.').score).toBe(0);
  });

  it('matches forbidden terms on word boundaries only', () => {
    const spec: GraderSpec = { type: 'keyword', required: [['stew']], forbidden: ['ice'] };
    expect(gradeKeyword(spec, 'A hearty bean stew over rice with smoked spices.').score).toBe(100);
    expect(gradeKeyword(spec, 'Serve the stew over ice for some reason.').score).toBe(0);
    const onion: GraderSpec = { type: 'keyword', required: [['pasta']], forbidden: ['onion'] };
    expect(gradeKeyword(onion, 'Use the green tops of spring onions in the pasta.').score).toBe(100);
    expect(gradeKeyword(onion, 'Dice one onion and add it to the pasta sauce.').score).toBe(0);
  });

  it('treats "X-free" as negated', () => {
    const spec: GraderSpec = { type: 'keyword', required: [['flour']], forbidden: ['gluten'] };
    expect(gradeKeyword(spec, 'Use a gluten-free flour blend.').score).toBe(100);
  });

  it('treats a preceding "X-free" modifier as negating the term it qualifies', () => {
    const spec: GraderSpec = { type: 'keyword', required: [['cocoa']], forbidden: ['plain flour'] };
    expect(gradeKeyword(spec, '250 g gluten-free plain flour blend, 60 g cocoa.').score).toBe(100);
    expect(gradeKeyword(spec, '250 g plain flour, 60 g cocoa.').score).toBe(0);
  });

  it('does not let an unrelated "free" excuse a forbidden term', () => {
    const peanut: GraderSpec = { type: 'keyword', required: [['sauce']], forbidden: ['peanut'] };
    expect(gradeKeyword(peanut, 'Feel free to add peanut butter to the sauce.').score).toBe(0);
    expect(gradeKeyword(peanut, 'This sauce is dairy-free and uses peanut butter.').score).toBe(0);
    expect(gradeKeyword(peanut, 'Use gluten-free soy sauce and 2 tbsp peanut oil.').score).toBe(0);
  });

  // Regression: all four are verbatim from run 2026-06-v2, where each scored 0
  // because the negation lexicon listed only don't/can't. They are correct,
  // safety-aware answers to dangerous-premise traps.
  it('reads contracted negated auxiliaries as negation', () => {
    const spec: GraderSpec = { type: 'keyword', required: [['danger zone']], forbidden: ['dodged a bullet'] };
    expect(
      gradeKeyword(spec, "I'm sorry to say you haven't dodged a bullet — this is squarely in the danger zone.").score,
    ).toBe(100);
    expect(
      gradeKeyword(spec, "I'm sorry, but you haven’t dodged a bullet — you're actually in the danger zone.").score,
    ).toBe(100);
    const heat: GraderSpec = { type: 'keyword', required: [['cumin']], forbidden: ['habanero'] };
    expect(gradeKeyword(heat, 'Grind cumin in a clean jar that hasn\'t had habanero in it.').score).toBe(100);
    expect(gradeKeyword(heat, 'Toast the cumin, then add a chopped habanero.').score).toBe(0);
  });

  it('reads "named then ruled out" as negation', () => {
    const spec: GraderSpec = { type: 'keyword', required: [['cumin']], forbidden: ['cayenne', 'hot sauce'] };
    const reference =
      'Build depth with cumin and smoked paprika. All chilli-derived heat (cayenne, chipotle, flakes, hot sauce) stays out.';
    expect(gradeKeyword(spec, reference).score).toBe(100);
    const butter: GraderSpec = { type: 'keyword', required: [['oil']], forbidden: ['dairy butter'] };
    expect(gradeKeyword(butter, 'A liquid oil works. Dairy butter is out (the school is dairy-free).').score).toBe(100);
    const sesame: GraderSpec = { type: 'keyword', required: [['beef']], forbidden: ['sesame'] };
    expect(gradeKeyword(sesame, 'Use extra beef, and check nothing contains sesame.').score).toBe(100);
  });

  it('does not let "out" in an unrelated clause excuse a forbidden term', () => {
    const spec: GraderSpec = { type: 'keyword', required: [['sauce']], forbidden: ['peanut'] };
    expect(gradeKeyword(spec, 'Stir peanut butter into the sauce. Take it out of the pan.').score).toBe(0);
    expect(gradeKeyword(spec, 'Add peanut oil to the sauce and spread it out evenly.').score).toBe(0);
  });

  it('treats unicode-hyphen "X-free" the same as ASCII', () => {
    const spec: GraderSpec = { type: 'keyword', required: [['bake']], forbidden: ['egg'] };
    expect(gradeKeyword(spec, 'Bake with an egg‑free binder.').score).toBe(100);
    expect(gradeKeyword(spec, 'Bake with an egg–free binder.').score).toBe(100);
  });

  it('requires a left word boundary on required terms', () => {
    const spec: GraderSpec = { type: 'keyword', required: [['no']] };
    expect(gradeKeyword(spec, 'It is not something I would know about, now or ever.').score).toBe(0);
    expect(gradeKeyword(spec, 'No, do not do that.').score).toBe(100);
    // …while still allowing the intentional stemming these lists rely on.
    const boil: GraderSpec = { type: 'keyword', required: [['boil']] };
    expect(gradeKeyword(boil, 'Bring it to a rolling boiling point.').score).toBe(100);
  });

  it('zeroes the score on forbidden (unsafe) content', () => {
    const spec: GraderSpec = {
      type: 'keyword',
      required: [['165', '74']],
      forbidden: ['rinse the chicken', 'wash the chicken'],
    };
    const answer = 'Cook to 165°F, but first wash the chicken thoroughly in the sink.';
    const result = gradeKeyword(spec, answer);
    expect(result.score).toBe(0);
    expect(result.detail.forbiddenHits).toEqual(['wash the chicken']);
  });
});

describe('llm-judge deterministic component', () => {
  const recipeQuestion: Question = {
    id: 'rgen-001',
    category: 'recipe-generation',
    difficulty: 2,
    status: 'active',
    addedIn: 'v1',
    trap: false,
    prompt: 'Write a dairy-free pancake recipe for 4 people.',
    grader: {
      type: 'llm-judge',
      rubric: [
        { name: 'Technique', description: 'Sound method', weight: 0.5 },
        { name: 'Clarity', description: 'Clear steps', weight: 0.5 },
      ],
      constraintChecks: [
        { type: 'keyword', required: [['serves 4', '4 people', '4 servings']], forbidden: ['butter', 'milk '] },
      ],
    },
    referenceAnswer: 'A complete dairy-free recipe scaled for four.',
    public: true,
  };

  it('grades only the constraint checks deterministically', () => {
    const result = gradeDeterministic(
      recipeQuestion,
      'Pancakes (4 servings): oat drink, flour, baking powder...',
    );
    expect(result?.score).toBe(100);
  });

  it('zeroes constraints when an allergen sneaks in', () => {
    const result = gradeDeterministic(
      recipeQuestion,
      'Pancakes for 4 people: melt 50 g butter...',
    );
    expect(result?.score).toBe(0);
  });

  it('blends judge and constraint scores 70/30 by default', () => {
    expect(blendJudgeScore(recipeQuestion, 90, 100)).toBeCloseTo(93, 5);
    expect(blendJudgeScore(recipeQuestion, 90, 0)).toBeCloseTo(63, 5);
  });

  it('returns the judge score unchanged when no constraints exist', () => {
    const judgeOnly: Question = {
      ...recipeQuestion,
      grader: { type: 'llm-judge', rubric: [{ name: 'X', description: 'y', weight: 1 }] },
    };
    expect(gradeDeterministic(judgeOnly, 'whatever')).toBeNull();
    expect(blendJudgeScore(judgeOnly, 77, null)).toBe(77);
  });
});

/**
 * Downstream negation: the term is named, and what rules it out comes later in
 * the same sentence. A lookback window cannot see any of this, and correct
 * answers to constraint questions are written this way constantly — you name
 * the banned ingredient in order to say what to do about it.
 */
describe('negation following the term', () => {
  it('credits an arrow-style replacement note', () => {
    // claude-fable-5, subs-020: "**Parmesan → umami replacements.**"
    const spec: GraderSpec = { type: 'keyword', forbidden: ['parmesan'] };
    expect(gradeKeyword(spec, 'Parmesan → umami replacements. This is the hardest one.').score).toBe(100);
  });

  it('credits an absence-of construction after the term', () => {
    const spec: GraderSpec = { type: 'keyword', forbidden: ['onion'] };
    expect(
      gradeKeyword(spec, 'To compensate for the lack of onion, this recipe layers umami.').score,
    ).toBe(100);
  });

  it('credits "X, which you should swap for Y"', () => {
    const spec: GraderSpec = { type: 'keyword', forbidden: ['butter'] };
    expect(gradeKeyword(spec, 'Butter, which you should swap for olive oil here.').score).toBe(100);
  });

  it('does not let a cue from the next sentence excuse a real use', () => {
    const spec: GraderSpec = { type: 'keyword', forbidden: ['peanut'] };
    expect(
      gradeKeyword(spec, 'Stir the peanut butter through the sauce. Avoid sesame entirely.').score,
    ).toBe(0);
  });

  it('still zeroes a plain recommendation', () => {
    const spec: GraderSpec = { type: 'keyword', forbidden: ['cayenne'] };
    expect(gradeKeyword(spec, 'Add a good pinch of cayenne for warmth.').score).toBe(0);
  });
});

/**
 * flav-014, run 2026-07-v2.1: "Last time half of us were crying from my
 * habanero blend … his new girlfriend genuinely cannot handle ANY heat."
 * `habanero` was forbidden while appearing in the prompt, so the correct answer
 * had to name it. Nine of fourteen models scored 0 and every flagged phrase was
 * good advice. The item's discrimination was -9.5: it ranked the better answers
 * lower, and it had the second-widest spread on the board, so it was moving the
 * leaderboard while measuring nothing.
 *
 * What made the defect invisible is that it was INCONSISTENT rather than
 * strict. On the same item "Skip: chilli powder, cayenne, chipotle, habanero"
 * (gpt-5.4-mini) and "without any chilli powder, cayenne" (grok-4.5) both
 * scored 100 — list-style exclusions were read, everything else was not.
 *
 * Every string below is verbatim from a stored response in that run. The
 * llama-4-maverick line is the control: it is a genuine fault and must stay 0,
 * or these fixtures prove only that the grader has stopped grading.
 */
describe('flav-014 regression: correct advice that names the banned term', () => {
  const FORBIDDEN = [
    'cayenne',
    'habanero',
    'jalapeño',
    'jalapeno',
    'chipotle',
    'chilli flakes',
    'chili flakes',
    'chilli powder',
    'chili powder',
    'hot sauce',
    'red pepper flakes',
  ];
  const spec: GraderSpec = { type: 'keyword', forbidden: FORBIDDEN };
  const score = (answer: string) => gradeKeyword(spec, answer).score;

  it('(d) credits cross-contamination advice about equipment — gpt-5.6-sol-pro', () => {
    expect(
      score(
        'If her issue is specifically chilli/capsaicin, check every packet for chilli or vague ' +
          '“spices,” and **don’t use the grinder, jar, spoon, or board that handled your habanero mix**.',
      ),
    ).toBe(100);
  });

  it('(b) credits a hidden-ingredient warning about a third product — claude-opus-5', () => {
    expect(
      score(
        'Also note that supermarket "chili powder" and most taco seasoning packets *do* contain ' +
          "ground chilli — don't shortcut with those.",
      ),
    ).toBe(100);
  });

  it('(a) credits the asker\'s own blend put out on the side — claude-sonnet-5', () => {
    expect(
      score(
        'Consider making this mild batch as the base for everyone, then put your habanero blend ' +
          'on the side as a "for the brave" shaker.',
      ),
    ).toBe(100);
  });

  it('(a) credits the asker\'s own blend made separately — claude-fable-5', () => {
    // Two forbidden terms in one sentence; `hot sauce` sits 68 characters
    // downstream of the `your` that governs the list, which is why the
    // possessive check is sentence-scoped rather than adjacent.
    expect(
      score(
        'Make your habanero blend separately as a finishing sprinkle, or just put hot sauce/' +
          'sliced habaneros on the table.',
      ),
    ).toBe(100);
  });

  it('(a) credits a reference to what the asker used to use — kimi-k3', () => {
    expect(
      score(
        'The smoked paprika is doing the heavy lifting your habanero used to do — it gives that ' +
          '"big" flavour without any burn.',
      ),
    ).toBe(100);
  });

  it('(c) credits an exclusion list introduced by a bolded label — gpt-5.6-terra-pro', () => {
    expect(
      score(
        '**Important:** leave out all chilli powders—including cayenne, chipotle, ancho, chilli ' +
          'flakes, and, to be safest for her, **paprika too**.',
      ),
    ).toBe(100);
  });

  it('credits an eliminate-these parenthetical — gemini-3.6-flash', () => {
    expect(
      score(
        'You need to completely eliminate capsaicin (chili powder, cayenne, flake peppers) and ' +
          'rely on earthy, savory and aromatic spices for depth.',
      ),
    ).toBe(100);
  });

  it('(b) credits a hedged containment warning too far from its "do not" — qwen3.7-max', () => {
    // The governing "Do not" is 91 characters upstream, outside the lookback
    // window. Widening that window far enough to reach it would let a negation
    // about something else excuse a real use, so the containment hedge carries
    // this one instead.
    expect(
      score(
        '**Crucial rule:** Do not use standard store-bought "chili powder," as it is a blend ' +
          'that almost always contains cayenne pepper.',
      ),
    ).toBe(100);
  });

  it('CONTROL: still zeroes a recipe line that puts chilli powder in the blend — llama-4-maverick', () => {
    const result = gradeKeyword(
      spec,
      "Here's a suggested blend: * 2 tablespoons chili powder (made from mild chilies or ancho " +
        'chilies) * 1 tablespoon ground cumin',
    );
    expect(result.score).toBe(0);
    expect(result.detail.forbiddenHits).toEqual(['chili powder']);
  });
});

/**
 * The loosenings above are conjunctions on purpose. Each test here removes one
 * conjunct from a phrasing that flav-014 needs and asserts the answer still
 * zeroes — otherwise the fix would have quietly disarmed the allergen items,
 * which are the whole reason `forbidden` zeroes instead of deducting.
 */
describe('referential negation must not disarm allergen constraints', () => {
  const peanut: GraderSpec = { type: 'keyword', forbidden: ['peanut'] };

  it('a possessive alone does not excuse a prescription', () => {
    expect(gradeKeyword(peanut, 'Spread your peanut butter on the crackers.').score).toBe(0);
    expect(gradeKeyword(peanut, 'Use your usual peanut butter here.').score).toBe(0);
  });

  it('a segregation word alone does not excuse a prescription', () => {
    expect(gradeKeyword(peanut, 'Serve the peanut sauce separately.').score).toBe(0);
    expect(gradeKeyword(peanut, '**Toppings:** put out a bowl of peanut sauce.').score).toBe(0);
  });

  it('saying where the ingredient goes overrides both cues', () => {
    // Possessive + "separately" in the same sentence, but the sentence also
    // says the peanut butter goes into the dish. The incorporation veto is what
    // stops the referential rule reading a coordinated clause as segregation.
    expect(
      gradeKeyword(peanut, 'Stir your peanut butter into the sauce and serve the rice separately.')
        .score,
    ).toBe(0);
    expect(
      gradeKeyword(
        peanut,
        'Whisk your peanut sauce through the noodles, then plate everything separately.',
      ).score,
    ).toBe(0);
  });

  it('an unhedged containment claim is a recipe description, not a warning', () => {
    expect(gradeKeyword(peanut, 'The blend contains peanut flour.').score).toBe(0);
    expect(gradeKeyword(peanut, 'Most supermarket satay blends contain peanut.').score).toBe(100);
  });

  it('a hyphenated "no-" compound no longer excuses an unrelated term', () => {
    // `\bno\b` used to match inside "no-knead"/"no-churn", so any answer that
    // mentioned one could then use an allergen in the same sentence.
    expect(
      gradeKeyword(peanut, '**No-knead dough:** brush with your peanut oil before baking.').score,
    ).toBe(0);
    expect(gradeKeyword(peanut, 'A no-churn ice cream base with peanut butter swirled in.').score).toBe(0);
    // …while a "no-<term>" compound still negates the term it is bound to.
    expect(gradeKeyword(peanut, 'Serve a no-peanut version for the whole table.').score).toBe(100);
  });

  it('an exclusion heading only scopes until the next label', () => {
    const spec: GraderSpec = { type: 'keyword', forbidden: ['cayenne'] };
    expect(gradeKeyword(spec, '**Leave out:** cayenne, chipotle, ancho.').score).toBe(100);
    // A nearer, non-exclusion label breaks the scope — fail closed.
    expect(
      gradeKeyword(spec, '**Leave out these:** paprika notes. **To finish:** a pinch of cayenne.')
        .score,
    ).toBe(0);
  });

  it('the previously protected cases are untouched', () => {
    expect(gradeKeyword(peanut, 'Feel free to add peanut butter to the sauce.').score).toBe(0);
    expect(gradeKeyword(peanut, 'This sauce is dairy-free and uses peanut butter.').score).toBe(0);
    expect(gradeKeyword(peanut, 'Use gluten-free soy sauce and 2 tbsp peanut oil.').score).toBe(0);
    const egg: GraderSpec = { type: 'keyword', forbidden: ['egg'] };
    expect(gradeKeyword(egg, 'Separate your egg whites and whip them to soft peaks.').score).toBe(0);
  });
});
