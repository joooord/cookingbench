import { describe, expect, it } from 'vitest';
import { gradeNumeric, gradeNumericMulti, gradeRange } from '../src/graders/numeric.js';
import type { GraderSpec } from '../src/types.js';

const tempSpec: Extract<GraderSpec, { type: 'numeric' }> = {
  type: 'numeric',
  expected: 74,
  unit: 'c',
  tolerancePct: 1.5,
};

describe('gradeNumeric', () => {
  it('passes an exact answer on an Answer: line', () => {
    expect(gradeNumeric(tempSpec, 'Chicken must reach a safe temp.\nAnswer: 74°C').score).toBe(100);
  });

  it('accepts an equivalent unit (165°F == 74°C)', () => {
    expect(gradeNumeric(tempSpec, 'Answer: 165°F').score).toBe(100);
  });

  it('accepts a unitless answer on the answer line', () => {
    expect(gradeNumeric(tempSpec, 'Answer: 74').score).toBe(100);
  });

  it('fails a wrong value', () => {
    expect(gradeNumeric(tempSpec, 'Answer: 63°C').score).toBe(0);
  });

  it('rejects equivalent units when disabled', () => {
    const strict = { ...tempSpec, acceptEquivalentUnits: false };
    expect(gradeNumeric(strict, 'Answer: 165°F').score).toBe(0);
  });

  it('ignores candidates of the wrong dimension', () => {
    const spec: GraderSpec = { type: 'numeric', expected: 875, unit: 'g', tolerancePct: 1 };
    expect(gradeNumeric(spec, 'Answer: 875 ml').score).toBe(0);
  });

  it('does NOT pass by echoing a prompt value outside an answer line', () => {
    const spec: GraderSpec = { type: 'numeric', expected: 176.7, unit: 'c', tolerancePct: 1 };
    const prompt = 'Convert 350°F to Celsius.';
    // Model restates 350°F (which converts to ~176.7°C) but answers 200°C — must fail.
    const answer = 'For 350°F the oven should be set to 200°C.';
    expect(gradeNumeric(spec, answer, prompt).score).toBe(0);
  });

  it('passes a correct value in prose when no answer line exists', () => {
    const spec: GraderSpec = { type: 'numeric', expected: 176.7, unit: 'c', tolerancePct: 1 };
    const prompt = 'Convert 350°F to Celsius.';
    expect(gradeNumeric(spec, 'That comes out to about 177°C.', prompt).score).toBe(100);
  });

  it('handles thousands separators and fractions in answers', () => {
    const spec: GraderSpec = { type: 'numeric', expected: 1250, unit: 'g', tolerancePct: 1 };
    expect(gradeNumeric(spec, 'Answer: 1,250 g').score).toBe(100);
    const cups: GraderSpec = { type: 'numeric', expected: 1.5, unit: 'cup', tolerancePct: 2 };
    expect(gradeNumeric(cups, 'Answer: 1 1/2 cups').score).toBe(100);
    expect(gradeNumeric(cups, 'Answer: 1½ cups').score).toBe(100);
  });

  it('accepts ml when cups expected via conversion', () => {
    const cups: GraderSpec = { type: 'numeric', expected: 2, unit: 'cup', tolerancePct: 3 };
    expect(gradeNumeric(cups, 'Answer: about 475 ml').score).toBe(100);
  });
});

describe('gradeNumericMulti', () => {
  const breadSpec: Extract<GraderSpec, { type: 'numeric-multi' }> = {
    type: 'numeric-multi',
    scoring: 'proportional',
    targets: [
      { label: 'flour', expected: 1250, unit: 'g', tolerancePct: 1 },
      { label: 'water', expected: 875, unit: 'g', tolerancePct: 1 },
      { label: 'salt', expected: 25, unit: 'g', tolerancePct: 2 },
      { label: 'yeast', expected: 17.5, unit: 'g', tolerancePct: 5 },
    ],
  };

  it('scores 100 on a fully correct ingredient list', () => {
    const answer = [
      'Scaled to 5 loaves:',
      '- Flour: 1,250 g',
      '- Water: 875 g',
      '- Salt: 25 g',
      '- Yeast: 17.5 g',
    ].join('\n');
    expect(gradeNumericMulti(breadSpec, answer).score).toBe(100);
  });

  it('gives proportional partial credit', () => {
    const answer = [
      '- Flour: 1250 g',
      '- Water: 875 g',
      '- Salt: 30 g', // wrong
      '- Yeast: 12 g', // wrong
    ].join('\n');
    expect(gradeNumericMulti(breadSpec, answer).score).toBe(50);
  });

  it('matches labelled lines even with extra prose', () => {
    const answer =
      'You multiply by 2.5. The flour goes from 500 g to 1250 g, water from 350 g to 875 g, salt from 10 g to 25 g, and instant yeast from 7 g to 17.5 g.';
    expect(gradeNumericMulti(breadSpec, answer).score).toBe(100);
  });

  it('all-or-nothing zeroes a single miss', () => {
    const strict = { ...breadSpec, scoring: 'all-or-nothing' as const };
    const answer = '- Flour: 1250 g\n- Water: 875 g\n- Salt: 25 g\n- Yeast: 99 g';
    expect(gradeNumericMulti(strict, answer).score).toBe(0);
  });

  it('does not credit the right number under the wrong label only', () => {
    const answer = '- Flour: 875 g\n- Water: 1250 g\n- Salt: 17.5 g\n- Yeast: 25 g';
    expect(gradeNumericMulti(breadSpec, answer).score).toBe(0);
  });
});

describe('gradeRange', () => {
  const restSpec: Extract<GraderSpec, { type: 'range' }> = {
    type: 'range',
    min: 10,
    max: 20,
    unit: 'min',
  };

  it('passes a value inside the range', () => {
    expect(gradeRange(restSpec, 'Answer: rest it for 15 minutes').score).toBe(100);
  });

  it('passes when the model itself answers with a range (midpoint logic)', () => {
    expect(gradeRange(restSpec, 'Rest the meat for 10–15 minutes before carving.').score).toBe(100);
  });

  it('fails values outside the range', () => {
    expect(gradeRange(restSpec, 'Answer: 45 minutes').score).toBe(0);
  });

  it('converts units before the range check', () => {
    const tempRange: GraderSpec = { type: 'range', min: 60, max: 65, unit: 'c' };
    expect(gradeRange(tempRange, 'Answer: 145°F').score).toBe(100);
  });
});
