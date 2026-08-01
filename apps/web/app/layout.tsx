import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '@/components/SiteNav';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://cookingbench.com'),
  title: {
    default: 'CookingBench — which AI model is the best chef?',
    template: '%s — CookingBench',
  },
  description:
    'A benchmark and leaderboard ranking AI models on culinary competence: quantities, conversions, food safety, technique, flavour and nutrition.',
  alternates: { canonical: './' },
  openGraph: {
    type: 'website',
    siteName: 'CookingBench',
    url: 'https://cookingbench.com',
    locale: 'en_GB',
  },
  twitter: { card: 'summary_large_image' },
  keywords: [
    'AI benchmark',
    'LLM leaderboard',
    'cooking',
    'AI cooking',
    'food safety',
    'recipe generation',
    'model evaluation',
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <header className="relative border-b border-hairline">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
            <Link href="/" className="font-display text-2xl font-semibold tracking-tight">
              Cooking<span className="text-paprika">Bench</span>
            </Link>
            <SiteNav />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-6">{children}</main>
        <footer className="mt-24 border-t border-hairline">
          <div className="mx-auto max-w-6xl px-6 py-10 text-sm text-ink-soft">
            <p>
              CookingBench measures culinary competence in AI models. Scores are reproducible
              from the open dataset and committed run artifacts.
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
