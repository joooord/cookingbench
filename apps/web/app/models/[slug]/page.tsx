import { notFound, permanentRedirect } from 'next/navigation';
import { getLatestReport, modelIdFromSlug, modelSlug } from '@/lib/data';

export const revalidate = 3600;

export function generateStaticParams() {
  const report = getLatestReport();
  return (report?.rows ?? []).map((row) => ({ slug: modelSlug(row.modelId) }));
}

// The pre-pivot model pages presented the disowned v2.1 scores in the present
// tense - "joint 1st of 14" in the very meta description search engines quote  - 
// while the archived profiles at /results/2026-07-v2-1/models/<slug> carry the
// same numbers under their real standing. Two live pages telling contradictory
// stories about one number is the defect; the archived profile is the one that
// tells it honestly, so the legacy URL now points there permanently.
export default async function LegacyModelPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const report = getLatestReport();
  const row = report?.rows.find((r) => r.modelId === modelIdFromSlug(slug));
  if (!row) notFound();
  permanentRedirect(`/results/2026-07-v2-1/models/${slug}`);
}
