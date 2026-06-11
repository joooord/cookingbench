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
