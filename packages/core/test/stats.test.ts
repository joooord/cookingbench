import { describe, expect, it } from 'vitest';
import { krippendorffAlphaInterval, meanAbsoluteError, pearson, spearman } from '../src/stats.js';

describe('pearson', () => {
  it('is 1 for a perfect linear relationship', () => {
    expect(pearson([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
  });

  it('is -1 for a perfect inverse relationship', () => {
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
  });

  it('returns NaN when one side is constant', () => {
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNaN();
  });
});

describe('spearman', () => {
  it('is 1 for any monotone relationship', () => {
    expect(spearman([1, 2, 3, 4], [1, 10, 100, 1000])).toBeCloseTo(1);
  });

  it('averages tied ranks', () => {
    // x has a tie; hand-computed midrank Spearman.
    const x = [1, 2, 2, 4];
    const y = [1, 2, 3, 4];
    const rx = [1, 2.5, 2.5, 4];
    const ry = [1, 2, 3, 4];
    expect(spearman(x, y)).toBeCloseTo(pearson(rx, ry));
  });
});

describe('meanAbsoluteError', () => {
  it('averages absolute differences', () => {
    expect(meanAbsoluteError([100, 90, 80], [90, 90, 70])).toBeCloseTo((10 + 0 + 10) / 3);
  });
});

describe('krippendorffAlphaInterval', () => {
  it('is 1 for perfect agreement with score variance', () => {
    expect(
      krippendorffAlphaInterval([
        [100, 100],
        [60, 60],
        [30, 30],
      ]),
    ).toBeCloseTo(1);
  });

  it('is NaN when all values are identical (undefined agreement)', () => {
    expect(
      krippendorffAlphaInterval([
        [100, 100],
        [100, 100],
      ]),
    ).toBeNaN();
  });

  it('matches a hand-computed value on a small example', () => {
    // Units: (90,95), (60,50), (100,100).
    // Do = (25 + 100 + 0) / 3 = 41.667
    // Pooled = [90,95,60,50,100,100], mean = 82.5, sum sq = 2387.5
    // De = 2*6*2387.5 / (6*5) = 955
    // alpha = 1 - 41.667/955 = 0.95637...
    expect(
      krippendorffAlphaInterval([
        [90, 95],
        [60, 50],
        [100, 100],
      ]),
    ).toBeCloseTo(1 - 41.666667 / 955, 5);
  });

  it('is near 0 when one rater is shuffled against the other', () => {
    // Same marginal distributions, no per-unit relationship.
    const a = [100, 80, 60, 40, 20, 0];
    const b = [40, 0, 100, 20, 80, 60];
    const alpha = krippendorffAlphaInterval(a.map((v, i) => [v, b[i]!] as [number, number]));
    expect(Math.abs(alpha)).toBeLessThan(0.45);
  });
});
