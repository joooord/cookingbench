import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteNav } from '@/components/SiteNav';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://cookingbench.com'),
  title: {
    default: 'CookingBench · can AI cook?',
    template: '%s · CookingBench',
  },
  description:
    'An open research programme testing culinary reasoning across physical constraint, sensory judgement, culture and care.',
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
      <head>
        <link
          rel="preload"
          href="/fonts/fraunces-latin-variable.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          href="/fonts/inter-latin-variable.woff2"
          as="font"
          type="font/woff2"
          crossOrigin="anonymous"
        />
      </head>
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
          <div className="mx-auto flex max-w-6xl flex-col justify-between gap-5 px-6 py-10 text-sm text-ink-soft sm:flex-row sm:items-end">
            <p className="max-w-2xl leading-relaxed">
              CookingBench is an open research programme asking what AI can understand about
              cooking, and publishing the evidence, uncertainty and failures together. v2.1 is an
              archived preliminary study, not a definitive ranking.
            </p>
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              <Link href="/research/v2-1-autopsy" className="hover:text-paprika">Autopsy</Link>
              <Link href="/corpus/2026-07-v2-1" className="hover:text-paprika">Data</Link>
              <a href="https://github.com/joooord/cookingbench" className="hover:text-paprika">GitHub</a>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
