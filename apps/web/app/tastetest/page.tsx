import Link from 'next/link';
import { TASTE_CLAIM_EXCLUSION, TASTE_MEASUREMENT_CLAIM } from '@cookingbench/core';
import { TastingFlight, type TrackOption } from '@/components/TastingFlight';
import { trackAvailability } from './flight';

// Availability is read from the committed fixture bank, so this page could be
// static — but a flight is minted per visit and the picker must never be served
// from a cache that predates a bank change.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Tasting Flight',
  description:
    'Five blind rounds, about three minutes. Read two culinary proposals, say which you would rather cook, serve or eat. Names stay hidden until the flight ends.',
};

const TRACK_COPY: Record<string, { label: string; blurb: string }> = {
  rescue: {
    label: 'Rescue',
    blurb: 'Something has gone wrong and the clock is running. Which plan would you follow?',
  },
  flavour: {
    label: 'Flavour',
    blurb: 'A dish needs a direction. Which one would you rather eat, with a sensory card for each?',
  },
  service: {
    label: 'Service',
    blurb: 'Getting it hot, together and on time for a table of people.',
  },
  surprise: {
    label: 'Surprise',
    blurb: 'Constraints that should not work, and what a cook does with them.',
  },
};

export default function TastingFlightPage() {
  const tracks: TrackOption[] = trackAvailability().map((t) => ({
    track: t.track,
    label: TRACK_COPY[t.track]?.label ?? t.track,
    blurb: TRACK_COPY[t.track]?.blurb ?? '',
    available: t.available,
    ...(t.reason ? { reason: t.reason } : {}),
  }));

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

      {/*
        M5.1. The claim is rendered verbatim from the frozen constant in
        packages/core, not retyped here, so the page and the analysis cannot
        drift into two different promises. The exclusion is part of the claim
        and sits in the same block as it, not in a footnote further down.
      */}
      <div className="mt-6 max-w-2xl border-l-2 border-paprika pl-5">
        <p className="text-lg leading-relaxed">{TASTE_MEASUREMENT_CLAIM}</p>
        <p className="mt-2 text-lg leading-relaxed text-ink-soft">{TASTE_CLAIM_EXCLUSION}</p>
      </div>

      <p className="mt-6 max-w-2xl text-ink-soft">
        Five numbered rounds, about three minutes. Every proposal is between 120
        and 160 words, so length cannot win. Sides are assigned at random and no
        voice appears twice in one flight. Nothing is named until the whole
        flight ends.
      </p>

      <TastingFlight tracks={tracks} />

      <section className="mt-16 border-t border-hairline pt-6">
        <h2 className="font-display text-lg font-medium">What happens to your ballots</h2>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
          They are recorded as <strong>development evidence</strong> and are analysed
          separately from every published score. The Tasting Flight currently runs on
          authored fixture proposals rather than model answers, and the statistical
          thresholds a Taste ranking would need have not been set — so no ordering is
          published from these ballots, by design rather than by omission. The{' '}
          <Link href="/taste" className="text-paprika hover:underline">
            taste board
          </Link>{' '}
          shows the position, length and control diagnostics as they stand, and says what
          is still blocking.
        </p>
      </section>
    </div>
  );
}
