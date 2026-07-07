import Link from 'next/link';
import { computeTasteRatings, headToHead } from '@cookingbench/core';
import { getLatestReport, getLatestTastePanel, modelSlug } from '@/lib/data';
import { scoreColor } from '@/lib/format';
import { getAllTasteVotes } from '@/lib/supabase';

// Ratings are recomputed from the full vote history on each revalidation —
// the votes themselves are the permanent record (Supabase + data/taste/).
// Kept short so the board doesn't visibly trail votes just cast next door.
export const revalidate = 60;

export const metadata = {
  title: 'Taste Board',
  description:
    'The human side of CookingBench: Bradley-Terry ratings from blind, arena-style taste test votes on paired AI answers. Never blended into the precision score.',
};

const MIN_BATTLES = 5;

export default async function TasteBoardPage() {
  const votes = await getAllTasteVotes();
  const report = getLatestReport();
  const rows = new Map((report?.rows ?? []).map((r) => [r.modelId, r]));

  if (!votes || votes.length === 0) {
    return (
      <div className="py-16">
        <h1 className="font-display text-4xl font-semibold tracking-tight">The taste board</h1>
        <p className="mt-6 max-w-2xl text-lg text-ink-soft">
          No votes on the books yet — be the first to{' '}
          <Link href="/tastetest" className="text-paprika hover:underline">
            judge a blind duel
          </Link>
          .
        </p>
      </div>
    );
  }

  const ratings = computeTasteRatings(votes, { bootstrap: 200 });
  const ranked = ratings.filter((r) => r.battles >= MIN_BATTLES);
  const provisional = ratings.filter((r) => r.battles < MIN_BATTLES);
  const h2h = headToHead(votes);
  // The LLM critics' panel — its own separate ratings from committed run
  // artifacts, never merged with the crowd rows above (null until a real run).
  const panel = getLatestTastePanel();

  const nameFor = (modelId: string) => rows.get(modelId)?.displayName ?? modelId;
  const ModelName = ({ modelId, bold }: { modelId: string; bold?: boolean }) =>
    rows.has(modelId) ? (
      <Link href={`/models/${modelSlug(modelId)}`} className="hover:text-paprika">
        <span className={bold ? 'font-semibold text-paprika' : 'font-medium'}>
          {nameFor(modelId)}
        </span>
        <span className="ml-2 hidden text-xs text-ink-soft sm:inline">
          {rows.get(modelId)!.provider}
        </span>
      </Link>
    ) : (
      <span className="font-medium">{nameFor(modelId)}</span>
    );

  return (
    <div className="py-16">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1
          className="font-display font-semibold tracking-tight"
          style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', letterSpacing: '-0.02em' }}
        >
          The taste{' '}
          <em className="text-paprika not-italic underline decoration-2 underline-offset-8">
            board
          </em>
        </h1>
        <span className="tabular text-sm text-ink-soft">
          {votes.length.toLocaleString()} blind {votes.length === 1 ? 'vote' : 'votes'} on the
          books
        </span>
      </div>
      <p className="mt-4 max-w-2xl text-lg text-ink-soft">
        The human half of the benchmark. Visitors{' '}
        <Link href="/tastetest" className="text-paprika hover:underline">
          blind-taste paired answers
        </Link>{' '}
        and pick the dish they&rsquo;d rather eat; a Bradley-Terry rating is fitted to every
        vote ever cast, so beating a strong chef counts for more than beating a weak one.
        Pure human preference — never blended into the precision score.
      </p>

      <section className="mt-12 border-t-2 border-ink pt-6">
        <h2 className="font-display text-xl font-medium">
          Standings{' '}
          <span className="text-ink-soft">· models with {MIN_BATTLES}+ battles</span>
        </h2>
        {ranked.length === 0 ? (
          <p className="mt-4 text-ink-soft">
            No model has reached {MIN_BATTLES} battles yet — every vote at the{' '}
            <Link href="/tastetest" className="text-paprika hover:underline">
              taste test
            </Link>{' '}
            moves the board.
          </p>
        ) : (
          <table className="mt-4 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-ink-soft">
                <th className="py-3 pr-2 font-normal">#</th>
                <th className="py-3 pr-4 font-normal">Model</th>
                <th
                  className="py-3 pr-4 font-normal"
                  title="Bradley-Terry strength on an Elo-like scale (mean 1500), ± half the 95% bootstrap interval"
                >
                  Rating
                </th>
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
                    <ModelName modelId={r.modelId} bold={i === 0} />
                  </td>
                  <td className="py-4 pr-4">
                    <span className="tabular text-base font-medium">
                      {Math.round(r.rating)}
                    </span>
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
                    {r.wins}–{r.battles - r.wins - r.ties}
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
        {ranked.length > 0 && (
          <p className="mt-3 text-xs text-ink-soft">
            Record reads wins–losses{ranked.some((r) => r.ties > 0) ? '–ties' : ''}; a tie
            counts as half a win. Ratings carry a ± from bootstrap resampling — early
            numbers are honest guesses, not verdicts.
          </p>
        )}
      </section>

      {provisional.length > 0 && (
        <section className="mt-12 border-t border-hairline pt-6">
          <h2 className="font-display text-xl font-medium">
            Still earning their stars{' '}
            <span className="text-ink-soft">· fewer than {MIN_BATTLES} battles</span>
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-ink-soft">
            {provisional.map((r, i) => (
              <span key={r.modelId}>
                {i > 0 && ' · '}
                {nameFor(r.modelId)}{' '}
                <span className="tabular">
                  ({r.battles} {r.battles === 1 ? 'battle' : 'battles'})
                </span>
              </span>
            ))}
          </p>
        </section>
      )}

      {ranked.length >= 3 && (
        <section className="mt-12 border-t border-hairline pt-6">
          <h2 className="font-display text-xl font-medium">Head to head</h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-soft">
            Each cell is the row model&rsquo;s win rate against the column model (ties count
            half) — hover for the exact record.
          </p>
          <div className="mt-4 overflow-x-auto">
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
                            —
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
        </section>
      )}

      {panel && panel.ratings.length > 0 && (
        <section className="mt-16 border-t-2 border-ink pt-6">
          <h2 className="font-display text-xl font-medium">
            The critics&rsquo; table{' '}
            <span className="text-ink-soft">· a panel of AI judges</span>
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-soft">
            A separate signal: a panel of frontier models blind-tastes the same paired
            answers. Every duel is judged twice with the two answers swapped (to cancel
            position bias), and no judge ever scores a duel involving its own provider. Its
            Bradley-Terry ratings live here, alongside the crowd&rsquo;s — <strong>never
            blended</strong> with the human votes above or with the precision score.
          </p>
          <table className="mt-4 w-full border-collapse text-sm">
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
              {panel.ratings.map((r, i) => (
                <tr key={r.modelId} className="border-b border-hairline hover:bg-paper-tint">
                  <td className="tabular py-4 pr-2 text-ink-soft">{i + 1}</td>
                  <td className="py-4 pr-4">
                    <ModelName modelId={r.modelId} bold={i === 0} />
                  </td>
                  <td className="py-4 pr-4">
                    <span className="tabular text-base font-medium">{Math.round(r.rating)}</span>
                    {r.ci95 && (
                      <span className="tabular ml-1 text-xs text-ink-soft">
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
                    {r.wins}–{r.battles - r.wins - r.ties}
                    {r.ties > 0 ? `–${r.ties}` : ''}
                  </td>
                  <td className="tabular hidden py-4 text-right text-ink-soft sm:table-cell">
                    {r.battles}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-ink-soft">
            Panel: {panel.panel.join(', ')}. {panel.totalVotes.toLocaleString()} seat-votes
            from run <span className="tabular">{panel.runId}</span>, reproducible from the
            committed{' '}
            <span className="tabular">data/runs/{panel.runId}/taste-panel/</span> artifacts.
          </p>
        </section>
      )}

      <section className="mt-12 border-t border-hairline pt-8">
        <Link
          href="/tastetest"
          className="inline-block border border-ink bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:border-paprika hover:bg-paprika"
        >
          Cast your vote in the Taste Test →
        </Link>
        <p className="mt-4 max-w-2xl text-xs leading-relaxed text-ink-soft">
          Votes are anonymous, immutable once cast, and archived into the open repository
          alongside the run artifacts — the board can be rebuilt from the raw ballots at any
          time. Models need {MIN_BATTLES}+ battles to enter the standings; under-battled
          models are served more often in the duel until they catch up.
        </p>
      </section>
    </div>
  );
}
