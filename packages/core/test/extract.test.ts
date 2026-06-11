import { describe, expect, it } from 'vitest';
import { extractQuantities, findAnswerLine } from '../src/graders/extract.js';

function q(text: string) {
  return extractQuantities(text).map(({ value, unit }) => ({ value, unit }));
}

describe('extractQuantities', () => {
  it('parses plain integers with units', () => {
    expect(q('Use 500 g flour')).toEqual([{ value: 500, unit: 'g' }]);
  });

  it('parses thousands separators', () => {
    expect(q('You need 1,250 g of flour')).toEqual([{ value: 1250, unit: 'g' }]);
  });

  it('parses decimals', () => {
    expect(q('17.5 g yeast')).toEqual([{ value: 17.5, unit: 'g' }]);
  });

  it('parses mixed fractions', () => {
    expect(q('1 1/2 cups milk')).toEqual([{ value: 1.5, unit: 'cup' }]);
  });

  it('parses bare fractions', () => {
    expect(q('add 3/4 tsp salt')).toEqual([{ value: 0.75, unit: 'tsp' }]);
  });

  it('parses unicode fractions standalone and attached', () => {
    expect(q('½ cup sugar')).toEqual([{ value: 0.5, unit: 'cup' }]);
    expect(q('2½ cups stock')).toEqual([{ value: 2.5, unit: 'cup' }]);
    expect(q('2 ½ cups stock')).toEqual([{ value: 2.5, unit: 'cup' }]);
  });

  it('parses temperatures in °F and °C with degree variants', () => {
    expect(q('Bake at 350°F until done')).toEqual([{ value: 350, unit: 'f' }]);
    expect(q('Bake at 350 °F')).toEqual([{ value: 350, unit: 'f' }]);
    expect(q('that is 177 degrees Celsius')).toEqual([{ value: 177, unit: 'c' }]);
    expect(q('about 180C in a fan oven')).toEqual([{ value: 180, unit: 'c' }]);
  });

  it('parses two-word units like fl oz', () => {
    expect(q('8 fl oz of water')).toEqual([{ value: 8, unit: 'floz' }]);
    expect(q('8 fl. oz of water')).toEqual([{ value: 8, unit: 'floz' }]);
  });

  it('parses unit aliases', () => {
    expect(q('2 tablespoons oil')).toEqual([{ value: 2, unit: 'tbsp' }]);
    expect(q('450 grams')).toEqual([{ value: 450, unit: 'g' }]);
    expect(q('1.5 litres water')).toEqual([{ value: 1.5, unit: 'l' }]);
    expect(q('2 lbs brisket')).toEqual([{ value: 2, unit: 'lb' }]);
  });

  it('leaves unknown words after numbers unitless', () => {
    expect(q('makes 2 loaves')).toEqual([{ value: 2, unit: undefined }]);
  });

  it('treats kcal/calories as energy units', () => {
    expect(q('about 540 kcal per serving')).toEqual([{ value: 540, unit: 'kcal' }]);
    expect(q('roughly 540 calories')).toEqual([{ value: 540, unit: 'kcal' }]);
  });

  it('expands ranges into endpoints with shared unit plus midpoint', () => {
    const result = q('cook to 165–170°F');
    expect(result).toContainEqual({ value: 165, unit: 'f' });
    expect(result).toContainEqual({ value: 170, unit: 'f' });
    expect(result).toContainEqual({ value: 167.5, unit: 'f' });
  });

  it('expands "to" ranges', () => {
    const result = q('rest for 10 to 15 minutes');
    expect(result).toContainEqual({ value: 12.5, unit: 'min' });
  });

  it('extracts multiple quantities in order', () => {
    expect(q('500 g flour, 350 ml water, 10 g salt')).toEqual([
      { value: 500, unit: 'g' },
      { value: 350, unit: 'ml' },
      { value: 10, unit: 'g' },
    ]);
  });
});

describe('findAnswerLine', () => {
  it('finds a plain Answer: line', () => {
    expect(findAnswerLine('Working...\nAnswer: 875 g')).toBe('875 g');
  });

  it('finds the LAST answer line', () => {
    expect(findAnswerLine('Answer: 800 g\nWait, correcting.\nAnswer: 875 g')).toBe('875 g');
  });

  it('handles markdown bold and "Final answer"', () => {
    expect(findAnswerLine('**Answer:** 875 g')).toBe('875 g');
    expect(findAnswerLine('Final answer: 350°F')).toBe('350°F');
  });

  it('returns undefined when absent', () => {
    expect(findAnswerLine('use roughly 875 g of flour')).toBeUndefined();
  });
});
