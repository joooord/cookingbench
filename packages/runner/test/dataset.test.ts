import { describe, expect, it } from 'vitest';
import { gradeDeterministic, gradeKeyword, gradeSpec, type Question } from '@cookingbench/core';
import { loadQuestions } from '../src/dataset.js';

const questions = loadQuestions();
const byId = new Map(questions.map((q) => [q.id, q]));

function q(id: string): Question {
  const found = byId.get(id);
  if (!found) throw new Error(`missing question ${id}`);
  return found;
}

/**
 * The mock "perfect chef" answers every question with its own reference answer
 * on an explicit "Answer:" line. Every deterministic v3 item must grade 100 on
 * that, or the reference and the grader's `expected` have drifted apart.
 */
function perfectAnswer(question: Question): string {
  return `Here is the answer.\nAnswer: ${question.referenceAnswer}`;
}

const V3_DETERMINISTIC = questions.filter(
  (item) => item.addedIn === 'v3' && item.grader.type !== 'llm-judge',
);

const V3_LLM_JUDGE = questions.filter(
  (item) => item.addedIn === 'v3' && item.grader.type === 'llm-judge',
);

describe('v3 dataset self-check', () => {
  it('has 36 new v3 items', () => {
    expect(questions.filter((item) => item.addedIn === 'v3')).toHaveLength(36);
  });

  it.each(V3_DETERMINISTIC.map((item) => [item.id, item] as const))(
    'perfect answer for %s grades 100',
    (_id, item) => {
      const result = gradeSpec(item.grader, perfectAnswer(item), item.prompt);
      expect(result.score).toBe(100);
    },
  );

  it.each(V3_DETERMINISTIC.map((item) => [item.id, item] as const))(
    'a non-answer for %s grades below 100 (grader is not vacuous)',
    (_id, item) => {
      const result = gradeSpec(item.grader, 'I have no idea, honestly.', item.prompt);
      expect(result.score).toBeLessThan(100);
    },
  );

  it.each(V3_LLM_JUDGE.map((item) => [item.id, item] as const))(
    'reference for %s satisfies its constraint checks',
    (_id, item) => {
      const constraint = gradeDeterministic(item, perfectAnswer(item));
      // Items with no constraintChecks return null; those with them must pass.
      if (constraint !== null) expect(constraint.score).toBe(100);
    },
  );
});

describe('grader-audit regression fixes', () => {
  it('subs-021 no longer zeroes the "vegan butters use coconut oil" caution', () => {
    const item = q('subs-021');
    if (item.grader.type !== 'keyword') throw new Error('subs-021 should be keyword');
    const answer =
      'Swap the coconut oil for a solid vegan margarine or baking block, roughly ' +
      '1:1 (200 g). Many vegan butters use coconut oil as a base, so read the label ' +
      'and pick a coconut-free one. Dairy butter is out because the school is dairy-free.';
    expect(gradeKeyword(item.grader, answer).score).toBeGreaterThan(0);
  });

  it('safe-016 credits "please throw that rice out"', () => {
    const item = q('safe-016');
    if (item.grader.type !== 'keyword') throw new Error('safe-016 should be keyword');
    const answer =
      'No, please throw that rice out. Rice held overnight grows Bacillus cereus, ' +
      'whose toxin is heat-stable, so frying it hot will not make it safe.';
    expect(gradeKeyword(item.grader, answer).score).toBe(100);
  });

  it('flav-014 constraint check passes a correct heat-free blend', () => {
    const item = q('flav-014');
    if (item.grader.type !== 'llm-judge') throw new Error('flav-014 should be llm-judge');
    const answer =
      'Build it on cumin, smoked sweet paprika, oregano, garlic and onion powder, ' +
      'ground coriander and a little cocoa. Keep all chilli out for her; if the others ' +
      'want heat, offer a separate hot sauce on the side.';
    const constraint = gradeDeterministic(item, answer);
    expect(constraint?.score).toBe(100);
  });
});
