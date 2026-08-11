import type { MetadataRoute } from 'next';
import { CATEGORY_IDS } from '@cookingbench/core';
import { getLatestReport, modelSlug } from '@/lib/data';

const BASE = 'https://cookingbench.com';

export default function sitemap(): MetadataRoute.Sitemap {
  const report = getLatestReport();
  const lastModified = report ? new Date(report.generatedAt) : new Date();
  const researchRoutes = [
    '/research',
    '/research/v2-1-autopsy',
    '/research/can-ai-cook',
    '/benchmark',
    '/results',
    '/results/2026-07-v2-1',
    '/corpus/2026-07-v2-1',
    '/about',
  ];

  return [
    { url: BASE, lastModified, changeFrequency: 'weekly', priority: 1 },
    ...researchRoutes.map((route) => ({
      url: `${BASE}${route}`,
      lastModified,
      changeFrequency: 'monthly' as const,
      priority: route === '/research/v2-1-autopsy' || route === '/results/2026-07-v2-1' ? 0.9 : 0.75,
    })),
    { url: `${BASE}/tastetest`, lastModified, changeFrequency: 'daily', priority: 0.8 },
    { url: `${BASE}/taste`, lastModified, changeFrequency: 'daily', priority: 0.8 },
    { url: `${BASE}/questions`, lastModified, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${BASE}/methodology`, lastModified, changeFrequency: 'monthly', priority: 0.6 },
    // Archived category records only. The legacy /models/* URLs now redirect
    // permanently to the archived profiles, so only the destination is
    // advertised - a sitemap pointing search engines at the rank-bearing
    // legacy pages was how the disowned framing kept leaking out.
    ...CATEGORY_IDS.map((id) => ({
      url: `${BASE}/categories/${id}`,
      lastModified,
      changeFrequency: 'monthly' as const,
      priority: 0.5,
    })),
    ...(report?.runId === '2026-07-v2.1' ? report.rows : []).map((row) => ({
      url: `${BASE}/results/2026-07-v2-1/models/${modelSlug(row.modelId)}`,
      lastModified,
      changeFrequency: 'monthly' as const,
      priority: 0.65,
    })),
  ];
}
