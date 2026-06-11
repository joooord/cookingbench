import { describe, expect, it } from 'vitest';
import { convert, normalizeUnit } from '../src/graders/units.js';

describe('normalizeUnit', () => {
  it('normalizes aliases', () => {
    expect(normalizeUnit('grams')).toBe('g');
    expect(normalizeUnit('Tablespoons')).toBe('tbsp');
    expect(normalizeUnit('°F')).toBe('f');
    expect(normalizeUnit('degrees Celsius')).toBe('c');
    expect(normalizeUnit('fl oz')).toBe('floz');
    expect(normalizeUnit('Calories')).toBe('kcal');
  });

  it('returns undefined for non-units', () => {
    expect(normalizeUnit('loaves')).toBeUndefined();
    expect(normalizeUnit('eggs')).toBeUndefined();
  });
});

describe('convert', () => {
  it('converts mass', () => {
    expect(convert(1, 'kg', 'g')).toBe(1000);
    expect(convert(1, 'lb', 'oz')).toBeCloseTo(16, 3);
  });

  it('converts volume', () => {
    expect(convert(1, 'cup', 'ml')).toBeCloseTo(236.588, 2);
    expect(convert(3, 'tsp', 'tbsp')).toBeCloseTo(1, 3);
    expect(convert(1, 'l', 'ml')).toBe(1000);
  });

  it('converts temperature both ways', () => {
    expect(convert(350, 'f', 'c')).toBeCloseTo(176.67, 1);
    expect(convert(100, 'c', 'f')).toBe(212);
    expect(convert(74, 'c', 'c')).toBe(74);
  });

  it('rejects cross-dimension conversion', () => {
    expect(convert(100, 'g', 'ml')).toBeUndefined();
    expect(convert(100, 'f', 'g')).toBeUndefined();
  });
});
