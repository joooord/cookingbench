import Link from 'next/link';
import { CATEGORIES, type CategoryId } from '@cookingbench/core';
import { CATEGORY_COLORS } from '@/lib/format';

export function CategoryChip({ id, link = true }: { id: CategoryId; link?: boolean }) {
  const chip = (
    <span
      className="inline-flex items-center gap-2 border border-hairline px-2.5 py-1 text-xs tracking-wide"
      style={{ borderRadius: 2 }}
    >
      <span className="h-2 w-2" style={{ background: CATEGORY_COLORS[id] }} />
      {CATEGORIES[id].name}
    </span>
  );
  return link ? <Link href={`/categories/${id}`}>{chip}</Link> : chip;
}
