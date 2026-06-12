/**
 * Agreement and correlation statistics for judge-panel diagnostics.
 *
 * Krippendorff's alpha uses the interval distance function (squared
 * difference), the right choice for 0–100 deduction scores. Reported alongside
 * Spearman/MAE because alpha deflates under the score skew typical of judged
 * answers (most cluster near the top) — read them together, not alone.
 */

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

export function pearson(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return NaN;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    dx += (x[i]! - mx) ** 2;
    dy += (y[i]! - my) ** 2;
  }
  if (dx === 0 || dy === 0) return NaN;
  return num / Math.sqrt(dx * dy);
}

/** Ranks with ties averaged (midranks), as Spearman requires. */
function midranks(v: number[]): number[] {
  const indexed = v.map((value, i) => ({ value, i }));
  indexed.sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(v.length);
  let pos = 0;
  while (pos < indexed.length) {
    let end = pos;
    while (end + 1 < indexed.length && indexed[end + 1]!.value === indexed[pos]!.value) end++;
    const rank = (pos + end) / 2 + 1;
    for (let k = pos; k <= end; k++) ranks[indexed[k]!.i] = rank;
    pos = end + 1;
  }
  return ranks;
}

export function spearman(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 2) return NaN;
  return pearson(midranks(x), midranks(y));
}

export function meanAbsoluteError(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) return NaN;
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i]! - y[i]!);
  return sum / x.length;
}

/**
 * Krippendorff's alpha for two raters on interval data, all units fully paired.
 *
 * Do = mean over units of (a−b)²  (observed disagreement)
 * De = mean squared difference over all pairs of pooled values (chance level)
 * alpha = 1 − Do/De. 1 = perfect agreement, 0 = chance, < 0 = systematic
 * disagreement. Returns NaN when the pooled values have no variance (alpha is
 * undefined: agreement is indistinguishable from a constant scale).
 */
export function krippendorffAlphaInterval(pairs: Array<[number, number]>): number {
  const n = pairs.length;
  if (n < 2) return NaN;
  let dObserved = 0;
  const pooled: number[] = [];
  for (const [a, b] of pairs) {
    dObserved += (a - b) ** 2;
    pooled.push(a, b);
  }
  dObserved /= n;
  const m = pooled.length;
  const pooledMean = mean(pooled);
  // Sum over all ordered pairs of (v_i − v_j)² equals 2m·Σ(v−mean)²; divide by
  // the m(m−1) ordered pairs to get De.
  const sumSq = pooled.reduce((acc, v) => acc + (v - pooledMean) ** 2, 0);
  const dExpected = (2 * m * sumSq) / (m * (m - 1));
  if (dExpected === 0) return NaN;
  return 1 - dObserved / dExpected;
}
