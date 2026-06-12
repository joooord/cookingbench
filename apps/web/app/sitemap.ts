import type { MetadataRoute } from 'next';
import { CATEGORY_IDS } from '@cookingbench/core';
import { getLatestReport, modelSlug } from '@/lib/data';

const BASE = 'https://cookingbench.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const report = getLatestReport();
  const lastModified = report ? new Date(report.generatedAt) : new Date();

  return [
    { url: BASE, lastModified, changeFrequency: 'weekly', priority: 1 },
    { url: `${BASE}/tastetest`, lastModified, changeFrequency: 'daily', priority: 0.8 },
    { url: `${BASE}/taste`, lastModified, changeFrequency: 'daily', priority: 0.8 },
    { url: `${BASE}/questions`, lastModified, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${BASE}/methodology`, lastModified, changeFrequency: 'monthly', priority: 0.6 },
    ...CATEGORY_IDS.map((id) => ({
      url: `${BASE}/categories/${id}`,
      lastModified,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
    ...(report?.rows ?? []).map((row) => ({
      url: `${BASE}/models/${modelSlug(row.modelId)}`,
      lastModified,
      changeFrequency: 'weekly' as const,
      priority: 0.7,
    })),
  ];
}
