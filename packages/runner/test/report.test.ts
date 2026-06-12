import { describe, expect, it } from 'vitest';
import { pairedBootstrap } from '../src/report.js';

function modelScores(byQuestion: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(byQuestion));
}

const qids = Array.from({ length: 40 }, (_, i) => `q-${String(i).padStart(3, '0')}`);

describe('pairedBootstrap', () => {
  it('separates clearly different models and ties indistinguishable ones', () => {
    // A: 100 everywhere. B and C: identical means, differing per-question
    // (statistically tied). D: clearly worst.
    const a: Record<string, number> = {};
    const b: Record<string, number> = {};
    const c: Record<string, number> = {};
    const d: Record<string, number> = {};
    qids.forEach((q, i) => {
      a[q] = 100;
      b[q] = i % 2 === 0 ? 90 : 70;
      c[q] = i % 2 === 0 ? 70 : 90;
      d[q] = 20;
    });
    const result = pairedBootstrap(
      new Map([
        ['m-a', modelScores(a)],
        ['m-b', modelScores(b)],
        ['m-c', modelScores(c)],
        ['m-d', modelScores(d)],
      ]),
      qids,
    );
    expect(result.rankCi.get('m-a')).toEqual([1, 1]);
    expect(result.rankCi.get('m-d')).toEqual([4, 4]);
    // B and C are indistinguishable: both can be rank 2 or 3.
    expect(result.rankCi.get('m-b')).toEqual([2, 3]);
    expect(result.rankCi.get('m-c')).toEqual([2, 3]);
  });

  it('is deterministic for a fixed seed', () => {
    const scores = new Map([
      ['m-a', modelScores(Object.fromEntries(qids.map((q, i) => [q, 50 + (i % 5) * 10])))],
      ['m-b', modelScores(Object.fromEntries(qids.map((q, i) => [q, 45 + ((i + 2) % 5) * 10])))],
    ]);
    const first = pairedBootstrap(scores, qids);
    const second = pairedBootstrap(scores, qids);
    expect(first.ci).toEqual(second.ci);
    expect(first.rankCi).toEqual(second.rankCi);
  });

  it('pairing detects a small but consistent gap that marginal CIs miss', () => {
    // B is exactly 3 points below A on every question; per-question scores
    // vary a lot, so marginal CIs overlap heavily — but the paired difference
    // is constant, so ranks must be exact.
    const a: Record<string, number> = {};
    const b: Record<string, number> = {};
    qids.forEach((q, i) => {
      a[q] = 40 + (i % 7) * 9;
      b[q] = 37 + (i % 7) * 9;
    });
    const result = pairedBootstrap(
      new Map([
        ['m-a', modelScores(a)],
        ['m-b', modelScores(b)],
      ]),
      qids,
    );
    const [aLo] = result.ci.get('m-a')!;
    const [, bHi] = result.ci.get('m-b')!;
    expect(bHi).toBeGreaterThan(aLo); // marginal CIs overlap…
    expect(result.rankCi.get('m-a')).toEqual([1, 1]); // …but ranks are settled.
    expect(result.rankCi.get('m-b')).toEqual([2, 2]);
  });

  it('handles a model with a missing question (unjudged answer)', () => {
    const a = Object.fromEntries(qids.map((q) => [q, 90]));
    const b = Object.fromEntries(qids.slice(1).map((q) => [q, 50]));
    const result = pairedBootstrap(
      new Map([
        ['m-a', modelScores(a)],
        ['m-b', modelScores(b)],
      ]),
      qids,
    );
    expect(result.rankCi.get('m-a')).toEqual([1, 1]);
    expect(result.rankCi.get('m-b')).toEqual([2, 2]);
  });
});
