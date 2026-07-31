import type { TasteTrack } from '@cookingbench/core';
import { flavourItems } from './flavour';
import { rescueItems } from './rescue';
import type { FixtureItem } from './types';

export type { FixtureItem, FixtureProposal, SensoryCard, TimelineStep } from './types';

/**
 * The fixture bank, keyed by track.
 *
 * `service` and `surprise` are declared and EMPTY. That is deliberate and
 * visible: `trackAvailability()` reports them as unavailable with a reason, the
 * track picker shows them disabled, and `buildFlight` refuses them outright.
 * The alternative — quietly serving a four-round flight, or silently falling
 * back to another track — would change the protocol without changing the label
 * on the data, which is the failure mode this whole stage exists to avoid.
 */
export const fixtureBank: Record<TasteTrack, FixtureItem[]> = {
  rescue: dedupe(rescueItems),
  flavour: dedupe(flavourItems),
  service: [],
  surprise: [],
};

/**
 * De-duplicate by item id. "No repeated question within a flight" (M5.4) is
 * enforced by drawing distinct items, which only works if the pool genuinely
 * holds distinct ids — a copy-pasted item with the same id would let one
 * question appear twice in a flight and look like two independent readings.
 * Later duplicates are dropped rather than merged, and the first wins.
 */
function dedupe(items: readonly FixtureItem[]): FixtureItem[] {
  const seen = new Set<string>();
  const out: FixtureItem[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/** Every author id the bank uses. Must match the seed list in migration 0008. */
export function fixtureAuthorIds(): string[] {
  const ids = new Set<string>();
  for (const items of Object.values(fixtureBank)) {
    for (const item of items) for (const p of item.proposals) ids.add(p.authorId);
  }
  return [...ids].sort();
}
