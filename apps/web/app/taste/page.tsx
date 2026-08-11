import Link from 'next/link';
import {
  computeTasteRatings,
  headToHead,
  identicalAnswerControl,
  lengthEffect,
  positionEffect,
  TASTE_CLAIM_EXCLUSION,
  TASTE_MEASUREMENT_CLAIM,
  TASTE_PUBLICATION_THRESHOLDS,
  TASTE_TRACKS,
  tasteChoiceCounts,
  tasteComparisonGraph,
  type TasteCohort,
  type TasteFlightBallot,
} from '@cookingbench/core';
import { getLatestReport, modelSlug } from '@/lib/data';
import { scoreColor } from '@/lib/format';
import { getAllTasteVotes, getFlightBallots, type FlightBallotRead } from '@/lib/supabase';

// Recomputed from the ballot record on each revalidation - the ballots, not
// the board, are the permanent record.
export const revalidate = 60;

export const metadata = {
  title: 'Taste Board',
  description:
    'What blind readers prefer between paired culinary proposals, and what that is allowed to claim. Never blended into the precision score.',
};

const MIN_BATTLES = 5;

/**
 * Map the public read view onto the analysis type.
 *
 * `dwellMs` and `sessionId` are absent BY DESIGN - the view withholds them so a
 * per-browser id plus per-round timings cannot be used to reconstruct one
 * visitor's sitting. That means this page cannot run `admitTasteBallots` or the
 * abuse screen; both need the base table and a service-role reader. The page
 * says so rather than reporting "0 admissible" as if it were a finding.
 */
function toBallot(row: FlightBallotRead): TasteFlightBallot {
  return {
    id: row.id,
    createdAt: row.created_at,
    flightId: row.flight_id,
    round: row.round,
    track: row.track as TasteFlightBallot['track'],
    itemId: row.item_id,
    modelLeft: row.model_left,
    modelRight: row.model_right,
    choice: row.choice as TasteFlightBallot['choice'],
    bothSeen: row.both_seen,
    dwellMs: null,
    leftWords: row.left_words,
    rightWords: row.right_words,
    cohort: row.cohort as TasteCohort,
    controlKind: row.control_kind as TasteFlightBallot['controlKind'],
    sessionId: null,
    evidenceClass: row.evidence_class as TasteFlightBallot['evidenceClass'],
  };
}

function Effect({
  name,
  what,
  estimate,
}: {
  name: string;
  what: string;
  estimate: ReturnType<typeof positionEffect>;
}) {
  return (
    <div className="border-t border-hairline py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{name}</span>
        <span className="tabular text-sm">
          {estimate.n === 0 ? 'n/a' : `${(estimate.share * 100).toFixed(1)}%`}
          {estimate.ci95 && (
            <span className="ml-2 text-xs text-ink-soft">
              95% CI {(estimate.ci95[0] * 100).toFixed(1)}–{(estimate.ci95[1] * 100).toFixed(1)}%
            </span>
          )}
        </span>
      </div>
      <p className="mt-1 text-xs text-ink-soft">
        {what} Neutral is 50%.{' '}
        {estimate.refusal
          ? `Not yet measurable: ${estimate.refusal}.`
          : estimate.detected
            ? 'The interval excludes 50%: this effect is real and blocks any ordering.'
            : 'The interval covers 50%.'}{' '}
        <span className="tabular">n={estimate.n}</span>
      </p>
    </div>
  );
}

export default async function TasteBoardPage() {
  const [flightRows, legacyVotes] = await Promise.all([getFlightBallots(), getAllTasteVotes()]);
  const report = getLatestReport();
  const rows = new Map((report?.rows ?? []).map((r) => [r.modelId, r]));

  const ballots = (flightRows ?? []).map(toBallot);
  const publicBallots = ballots.filter((b) => b.cohort === 'public');
  const professionalBallots = ballots.filter((b) => b.cohort === 'professional');
  const counts = tasteChoiceCounts(publicBallots);
  const position = positionEffect(publicBallots, 'taste:board:position');
  const length = lengthEffect(publicBallots, 'taste:board:length');
  const identical = identicalAnswerControl(publicBallots);
  const scored = publicBallots.filter((b) => b.controlKind === 'none');

  return (
    <div className="py-16">
      <h1
        className="font-display font-semibold tracking-tight"
        style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', letterSpacing: '-0.02em' }}
      >
        The taste{' '}
        <em className="text-paprika not-italic underline decoration-2 underline-offset-8">
          board
        </em>
      </h1>

      {/* M5.1, verbatim from the frozen constant. */}
      <div className="mt-6 max-w-2xl border-l-2 border-paprika pl-5">
        <p className="text-lg leading-relaxed">{TASTE_MEASUREMENT_CLAIM}</p>
        <p className="mt-2 text-lg leading-relaxed text-ink-soft">{TASTE_CLAIM_EXCLUSION}</p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* v3 - development evidence, and why there is no ordering            */}
      {/* ------------------------------------------------------------------ */}

      <section className="mt-14 border-t-2 border-ink pt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="font-display text-xl font-medium">Tasting Flight · methodology v3</h2>
          <span className="border border-paprika px-2 py-0.5 text-xs uppercase tracking-wider text-paprika">
            Development evidence
          </span>
        </div>

        {flightRows === null ? (
          <p className="mt-4 text-sm text-ink-soft">
            Live ballot reads are intentionally offline while the flight is rebuilt under the
            new methodology, so nothing is shown here. (This is the designed pause, not a
            failed read: a partial read would produce a different fit and look exactly like
            a complete one, which is why the page refuses rather than guessing.)
          </p>
        ) : ballots.length === 0 ? (
          <p className="mt-4 max-w-2xl text-ink-soft">
            No flights recorded yet; be the first to{' '}
            <Link href="/tastetest" className="text-paprika hover:underline">
              judge a five-round tasting flight
            </Link>
            .
          </p>
        ) : (
          <>
            <dl className="mt-5 grid gap-4 sm:grid-cols-4">
              {[
                ['Ballots', String(ballots.length)],
                ['Flights', String(new Set(ballots.map((b) => b.flightId)).size)],
                ['Public cohort', String(publicBallots.length)],
                ['Verified professionals', String(professionalBallots.length)],
              ].map(([label, value]) => (
                <div key={label} className="border border-hairline p-4">
                  <dt className="text-xs uppercase tracking-wider text-ink-soft">{label}</dt>
                  <dd className="tabular mt-1 text-2xl">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="mt-2 text-xs text-ink-soft">
              Cohorts are counted and analysed separately and are never pooled.
            </p>

            <h3 className="mt-10 font-display text-lg font-medium">
              How the public cohort voted
            </h3>
            <table className="mt-3 w-full max-w-lg border-collapse text-sm">
              <tbody>
                {(
                  [
                    ['Chose A', counts.left],
                    ['Chose B', counts.right],
                    ['Equally good', counts.equal],
                    ['Neither works', counts.neither],
                    ['Not my area', counts.abstain],
                  ] as const
                ).map(([label, n]) => (
                  <tr key={label} className="border-b border-hairline">
                    <td className="py-2 pr-4">{label}</td>
                    <td className="tabular py-2 text-right">{n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 max-w-2xl text-xs text-ink-soft">
              &ldquo;Equally good&rdquo; and &ldquo;Neither works&rdquo; are different answers and
              stay apart everywhere. A rejection is an absolute failure reported beside a
              rating, never half a win inside it; an abstention is missing data, not a draw.
            </p>

            <h3 className="mt-10 font-display text-lg font-medium">Bias diagnostics</h3>
            <div className="mt-3 max-w-2xl">
              <Effect
                name="Position"
                what="How often the left-hand proposal won a decisive ballot."
                estimate={position}
              />
              <Effect
                name="Length"
                what="How often the longer proposal won, over pairs whose lengths differ."
                estimate={length}
              />
              <div className="border-y border-hairline py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium">Identical-answer control</span>
                  <span className="tabular text-sm">
                    {identical.pass === null ? 'n/a' : `${(identical.pass * 100).toFixed(0)}% pass`}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ink-soft">
                  Rounds that served the same text on both sides. A decisive choice on one is
                  a position effect or a click-through, not a preference.{' '}
                  {identical.refusal ?? `n=${identical.n}`}
                </p>
              </div>
            </div>

            <h3 className="mt-10 font-display text-lg font-medium">
              Comparison graph, by task axis
            </h3>
            <p className="mt-2 max-w-2xl text-sm text-ink-soft">
              Ratings are fitted per axis before any overall, and only over a connected graph.
              A phantom opponent shrinks small samples but must never join two clusters that
              were never compared; that would manufacture an ordering rather than measure one.
            </p>
            <table className="mt-3 w-full max-w-2xl border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-ink-soft">
                  <th className="py-2 pr-4 font-normal">Axis</th>
                  <th className="py-2 pr-4 font-normal">Ballots</th>
                  <th className="py-2 pr-4 font-normal">Voices</th>
                  <th className="py-2 pr-4 font-normal">Edges</th>
                  <th className="py-2 font-normal">Connected</th>
                </tr>
              </thead>
              <tbody>
                {TASTE_TRACKS.map((track) => {
                  const axis = scored.filter((b) => b.track === track);
                  if (axis.length === 0) return null;
                  const graph = tasteComparisonGraph(axis);
                  return (
                    <tr key={track} className="border-b border-hairline">
                      <td className="py-2 pr-4 capitalize">{track}</td>
                      <td className="tabular py-2 pr-4">{axis.length}</td>
                      <td className="tabular py-2 pr-4">{graph.models.length}</td>
                      <td className="tabular py-2 pr-4">{graph.edges}</td>
                      <td className="py-2">
                        {graph.connected ? (
                          'yes'
                        ) : (
                          <span className="text-paprika">
                            no: {graph.components.length} components
                          </span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}

        <div className="mt-10 border border-hairline bg-paper-tint p-5">
          <h3 className="font-display text-lg font-medium">
            No Taste ranking is published, and this is why
          </h3>
          <ul className="mt-3 max-w-2xl list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-soft">
            <li>
              The minimum ballot counts and precision thresholds a Taste ordering would need
              still <strong>require preregistration</strong>; they are provisional until
              frozen in advance.
              The provisional figures are {TASTE_PUBLICATION_THRESHOLDS.minBallotsPerAxis}{' '}
              ballots and {TASTE_PUBLICATION_THRESHOLDS.minFlightsPerAxis} flights per axis,
              with every voice above{' '}
              {TASTE_PUBLICATION_THRESHOLDS.minBallotsPerModelPerAxis} comparisons, but no
              amount of data clears this while the thresholds themselves are unsimulated.
            </li>
            <li>
              Every ballot here is cast against <strong>authored fixture proposals</strong>, not
              model answers, so the evidence is development-class and carries no rank by
              construction.
            </li>
            <li>
              Position and length effects must be measured and small, the comparison graph
              connected, and the uncertainty simultaneous rather than marginal, before any
              order is reportable.
            </li>
            <li>
              The admissibility gate and the abuse screen are not computed on this page: they
              need per-ballot dwell and session id, which the public ballot view withholds so
              that one visitor&rsquo;s sitting cannot be reconstructed from it.
            </li>
          </ul>
        </div>
      </section>

      {/* ------------------------------------------------------------------ */}
      {/* v2 - the archived duel record                                      */}
      {/* ------------------------------------------------------------------ */}

      <LegacyBoard votes={legacyVotes} rows={rows} />
    </div>
  );
}

/**
 * The v2 duel board, archived.
 *
 * It stays because the ballots are a permanent record and their scale must not
 * move under them - but it is fenced off and labelled, because its three-outcome
 * vocabulary cannot be reconciled with the v3 ballot. "Tie" there means either
 * "equally excellent" or "equally poor" and nobody can now say which, so the two
 * vote sets are never pooled and the v2 numbers are never restated in v3 terms.
 */
function LegacyBoard({
  votes,
  rows,
}: {
  votes: Awaited<ReturnType<typeof getAllTasteVotes>>;
  rows: Map<string, { displayName: string; provider: string }>;
}) {
  if (!votes || votes.length === 0) return null;
  const rosterVotes = votes.filter((v) => rows.has(v.model_a) && rows.has(v.model_b));
  if (rosterVotes.length === 0) return null;
  const ratings = computeTasteRatings(rosterVotes, { bootstrap: 200 });
  const ranked = ratings.filter((r) => r.battles >= MIN_BATTLES && rows.has(r.modelId));
  const h2h = headToHead(rosterVotes);
  const nameFor = (modelId: string) => rows.get(modelId)?.displayName ?? modelId;

  return (
    <section className="mt-16 border-t border-hairline pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="font-display text-xl font-medium">
          Face-smash duel · methodology v2 <span className="text-ink-soft">· archived</span>
        </h2>
        <span className="tabular text-sm text-ink-soft">
          {rosterVotes.length.toLocaleString()} blind{' '}
          {rosterVotes.length === 1 ? 'vote' : 'votes'}
        </span>
      </div>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-soft">
        The original three-outcome duel: two answers, pick one or call it too close. Kept
        exactly as cast. It is <strong>not</strong> pooled with the Tasting Flight above and
        never will be: its &ldquo;too close to call&rdquo; conflates two answers the v3 ballot
        keeps apart, and there is no way to recover which was meant.
      </p>

      {ranked.length === 0 ? (
        <p className="mt-4 text-sm text-ink-soft">
          No model reached {MIN_BATTLES} battles before the duel was retired.
        </p>
      ) : (
        <table className="mt-5 w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-ink-soft">
              <th className="py-3 pr-2 font-normal">#</th>
              <th className="py-3 pr-4 font-normal">Model</th>
              <th className="py-3 pr-4 font-normal">Rating</th>
              <th className="hidden py-3 pr-4 font-normal sm:table-cell">Win rate</th>
              <th className="py-3 pr-4 font-normal">Record</th>
              <th className="hidden py-3 text-right font-normal sm:table-cell">Battles</th>
            </tr>
          </thead>
          <tbody>
            {ranked.map((r, i) => (
              <tr key={r.modelId} className="border-b border-hairline hover:bg-paper-tint">
                <td className="tabular py-4 pr-2 text-ink-soft">{i + 1}</td>
                <td className="py-4 pr-4">
                  <Link href={`/models/${modelSlug(r.modelId)}`} className="hover:text-paprika">
                    <span className={i === 0 ? 'font-semibold text-paprika' : 'font-medium'}>
                      {nameFor(r.modelId)}
                    </span>
                    <span className="ml-2 hidden text-xs text-ink-soft sm:inline">
                      {rows.get(r.modelId)!.provider}
                    </span>
                  </Link>
                </td>
                <td className="py-4 pr-4">
                  <span className="tabular text-base font-medium">{Math.round(r.rating)}</span>
                  {r.ci95 && (
                    <span
                      className="tabular ml-1 text-xs text-ink-soft"
                      title="95% bootstrap confidence interval over votes"
                    >
                      ±{Math.round((r.ci95[1] - r.ci95[0]) / 2)}
                    </span>
                  )}
                </td>
                <td className="hidden py-4 pr-4 sm:table-cell">
                  <span className="tabular" style={{ color: scoreColor(r.winRate) }}>
                    {r.winRate.toFixed(0)}%
                  </span>
                </td>
                <td className="tabular py-4 pr-4 text-ink-soft">
                  {r.wins}&ndash;{r.battles - r.wins - r.ties}
                  {r.ties > 0 ? `–${r.ties}` : ''}
                </td>
                <td className="tabular hidden py-4 text-right text-ink-soft sm:table-cell">
                  {r.battles}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {ranked.length >= 3 && (
        <div className="mt-8">
          <h3 className="font-display text-lg font-medium">Head to head</h3>
          <div className="mt-3 overflow-x-auto">
            <table className="border-collapse text-xs">
              <thead>
                <tr>
                  <th className="p-2" />
                  {ranked.map((c) => (
                    <th
                      key={c.modelId}
                      className="max-w-24 p-2 text-left align-bottom font-normal text-ink-soft"
                      title={nameFor(c.modelId)}
                    >
                      <span className="block truncate">{nameFor(c.modelId)}</span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ranked.map((r) => (
                  <tr key={r.modelId} className="border-t border-hairline">
                    <th className="max-w-40 py-2 pr-3 text-left font-medium">
                      <span className="block truncate" title={nameFor(r.modelId)}>
                        {nameFor(r.modelId)}
                      </span>
                    </th>
                    {ranked.map((c) => {
                      if (r.modelId === c.modelId) {
                        return (
                          <td key={c.modelId} className="p-2 text-center text-ink-soft">
                            &mdash;
                          </td>
                        );
                      }
                      const rec = h2h.get(`${r.modelId}::${c.modelId}`);
                      const met = rec ? rec.wins + rec.losses + rec.ties : 0;
                      if (!rec || met === 0) {
                        return (
                          <td
                            key={c.modelId}
                            className="p-2 text-center text-ink-soft"
                            title="Never met"
                          >
                            ·
                          </td>
                        );
                      }
                      const pct = ((rec.wins + rec.ties / 2) / met) * 100;
                      return (
                        <td
                          key={c.modelId}
                          className="tabular p-2 text-center"
                          style={{ color: scoreColor(pct) }}
                          title={`${nameFor(r.modelId)} vs ${nameFor(c.modelId)}: ${rec.wins}–${rec.losses}${rec.ties > 0 ? `–${rec.ties}` : ''} over ${met} ${met === 1 ? 'battle' : 'battles'}`}
                        >
                          {pct.toFixed(0)}%
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
