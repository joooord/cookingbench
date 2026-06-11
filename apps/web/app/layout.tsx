import type { Metadata } from 'next';
import { Fraunces, IBM_Plex_Mono, Inter } from 'next/font/google';
import Link from 'next/link';
import './globals.css';

const fraunces = Fraunces({
  subsets: ['latin'],
  variable: '--font-fraunces',
  axes: ['opsz', 'SOFT', 'WONK'],
});
const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });
const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-plex-mono',
});

export const metadata: Metadata = {
  title: 'CookingBench — which AI model is the best chef?',
  description:
    'A benchmark and leaderboard ranking AI models on culinary competence: quantities, conversions, food safety, technique, flavour and nutrition.',
};

const NAV = [
  { href: '/', label: 'Leaderboard' },
  { href: '/questions', label: 'Questions' },
  { href: '/methodology', label: 'Methodology' },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${fraunces.variable} ${inter.variable} ${plexMono.variable}`}>
      <body className="font-sans antialiased">
        <header className="border-b border-hairline">
          <div className="mx-auto flex max-w-6xl items-baseline justify-between px-6 py-5">
            <Link href="/" className="font-display text-2xl font-semibold tracking-tight">
              Cooking<span className="text-paprika">Bench</span>
            </Link>
            <nav className="flex gap-8 text-sm">
              {NAV.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="text-ink-soft transition-colors hover:text-paprika"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
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
