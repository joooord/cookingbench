import type { CategoryId } from '@cookingbench/core';

/** Flat score scale: paprika (poor) → saffron → olive → herb green (excellent). */
export function scoreColor(score: number): string {
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
