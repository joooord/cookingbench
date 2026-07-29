import type { CategoryId } from '@cookingbench/core';

/**
 * Flat score scale: paprika (poor) → saffron → olive → herb green (excellent).
 * Returns the text-safe variants — this is used for score numerals far more
 * often than for fills, and a score is the last thing that should be hard to
 * read. Use scoreFill() where the colour is a bar or swatch.
 */
export function scoreColor(score: number): string {
  if (score < 50) return 'var(--color-paprika-ink)';
  if (score < 70) return 'var(--color-saffron-ink)';
  if (score < 85) return 'var(--color-olive-ink)';
  return 'var(--color-herb-ink)';
}

/** The vivid counterpart, for bars and swatches rather than text. */
export function scoreFill(score: number): string {
  if (score < 50) return 'var(--color-paprika)';
  if (score < 70) return 'var(--color-saffron)';
  if (score < 85) return 'var(--color-olive)';
  return 'var(--color-herb)';
}

export const CATEGORY_COLORS: Record<CategoryId, string> = {
  'quantities-scaling': 'var(--color-paprika)',
  conversions: 'var(--color-saffron)',
  'food-safety': 'var(--color-herb)',
  substitutions: 'var(--color-caramel)',
  technique: 'var(--color-charcoal)',
  'flavor-pairing': 'var(--color-plum)',
  nutrition: 'var(--color-saltblue)',
  'recipe-generation': 'var(--color-olive)',
};

export function formatScore(score: number | undefined): string {
  return score === undefined ? '—' : score.toFixed(1);
}
