import Link from 'next/link';
import { TASTE_CLAIM_EXCLUSION, TASTE_MEASUREMENT_CLAIM } from '@cookingbench/core';
import { TastingFlight } from '@/components/TastingFlight';

export const metadata = {
  title: 'Tasting Flight',
  description:
    'The Tasting Flight is paused while CookingBench rebuilds its blind-comparison method and ballot evidence trail. Explore the existing Taste archive in the meantime.',
};

export default function TastingFlightPage() {
  return (
    <div className="py-16">
      <h1
        className="font-display font-semibold tracking-tight"
        style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', letterSpacing: '-0.02em' }}
      >
        The{' '}
        <em className="text-paprika not-italic underline decoration-2 underline-offset-8">
          tasting
        </em>{' '}
        flight
      </h1>

      <p className="mt-6 max-w-2xl text-ink-soft">
        This is where cooks and curious readers will compare culinary proposals
        without seeing which model wrote them. It is paused today so the page
        never asks for a judgement it cannot faithfully save.
      </p>

      <TastingFlight />

      <section className="mt-16 border-t border-hairline pt-6">
        <h2 className="font-display text-lg font-medium">What the next flight is designed to measure</h2>
        {/*
          M5.1. The claim is rendered verbatim from the frozen constant in
          packages/core, not retyped here, so the page and the analysis cannot
          drift into two different promises. The exclusion is part of the same
          block rather than being hidden in a distant footnote.
        */}
        <div className="mt-4 max-w-2xl border-l-2 border-paprika pl-5">
          <p className="text-base leading-relaxed">{TASTE_MEASUREMENT_CLAIM}</p>
          <p className="mt-2 text-base leading-relaxed text-ink-soft">{TASTE_CLAIM_EXCLUSION}</p>
        </div>
        <p className="mt-5 max-w-2xl text-sm leading-relaxed text-ink-soft">
          The{' '}
          <Link href="/taste" className="text-paprika hover:underline">
            taste board
          </Link>{' '}
          keeps the existing archive visible, including its limits and diagnostics,
          while this collection surface is offline.
        </p>
      </section>
    </div>
  );
}
