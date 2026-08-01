import Link from 'next/link';

/**
 * An explicit pause state for the public Tasting Flight.
 *
 * WP-0 deliberately disconnects every live ballot write. Rendering the old
 * comparison client in that state would let a visitor read and choose a first
 * pair, then strand them when the save is refused. The pause therefore lives
 * at the component boundary: no flight is minted, no proposal is shown, and no
 * control suggests that a ballot can currently be recorded.
 */
export function TastingFlight() {
  return (
    <section
      aria-labelledby="tasting-flight-status"
      className="mt-10 border-y-2 border-ink py-8 sm:py-10"
    >
      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.35fr)_minmax(17rem,0.65fr)] lg:gap-16">
        <div>
          <p className="tabular text-xs uppercase tracking-[0.18em] text-paprika">
            Service note · paused
          </p>
          <h2
            id="tasting-flight-status"
            className="mt-3 max-w-2xl font-display text-2xl font-semibold leading-tight sm:text-3xl"
          >
            The next Tasting Flight is being rebuilt.
          </h2>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-ink-soft">
            Ballot collection is intentionally disconnected while we rebuild the
            blind-comparison method and its evidence trail. We will not show you a
            choice unless we can reliably record it.
          </p>
          <p role="status" className="mt-5 flex max-w-2xl items-start gap-3 text-sm leading-relaxed">
            <span
              aria-hidden="true"
              className="mt-[0.42rem] h-2 w-2 shrink-0 rounded-full bg-paprika"
            />
            <span>
              <strong>No live ballots are being collected right now.</strong>{' '}
              Nothing you do on this page is presented as a vote or added to a result.
            </span>
          </p>
        </div>

        <div className="border-l border-hairline pl-5 sm:pl-7">
          <h3 className="font-display text-lg font-medium">Open while we rebuild</h3>
          <nav aria-label="Tasting Flight alternatives" className="mt-4">
            <ul className="divide-y divide-hairline border-y border-hairline">
              <li>
                <Link
                  href="/taste"
                  className="group flex items-center justify-between gap-5 py-4 text-sm transition-colors hover:text-paprika"
                >
                  <span>
                    <strong className="block font-medium">Explore the Taste archive</strong>
                    <span className="mt-1 block text-ink-soft group-hover:text-paprika">
                      See the existing evidence and its limits.
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-lg">
                    →
                  </span>
                </Link>
              </li>
              <li>
                <Link
                  href="/methodology"
                  className="group flex items-center justify-between gap-5 py-4 text-sm transition-colors hover:text-paprika"
                >
                  <span>
                    <strong className="block font-medium">Read the methodology</strong>
                    <span className="mt-1 block text-ink-soft group-hover:text-paprika">
                      Follow how the next test is being designed.
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-lg">
                    →
                  </span>
                </Link>
              </li>
            </ul>
          </nav>
        </div>
      </div>
    </section>
  );
}
