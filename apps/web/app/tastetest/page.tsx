import { getLatestReport, getPublicQuestions, getResponses } from '@/lib/data';
import { getTasteWinrates } from '@/lib/supabase';
import { TasteDuel } from '@/components/TasteDuel';

// A fresh random pair on every load — this page is the human taste signal,
// served dynamically rather than prerendered.
export const dynamic = 'force-dynamic';

export const metadata = {
  title: 'Taste Test',
  description:
    'Side-by-side blind taste test: two AI chefs answer the same cooking question — you pick the better dish. Human votes, arena-style.',
};

/** Strip markdown markers models love (**bold**, ### headers, backticks) for clean display. */
function plainText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^#{1,4}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

export default async function TasteTestPage() {
  const report = getLatestReport();
  if (!report) {
    return <p className="py-16 text-ink-soft">No published runs yet — come back soon.</p>;
  }
  const rows = new Map(report.rows.map((r) => [r.modelId, r]));

  // Duels run on judged (subjective) questions — the ones where taste matters.
  const questions = getPublicQuestions().filter(
    (q) => q.grader.type === 'llm-judge' && q.status !== 'basics' && q.status !== 'retired',
  );
  const responses = getResponses(report.runId).filter(
    (r) => r.answerText.trim().length > 0 && rows.has(r.modelId),
  );

  const question = questions[Math.floor(Math.random() * questions.length)]!;
  const candidates = responses.filter((r) => r.questionId === question.id);
  if (candidates.length < 2) {
    return <p className="py-16 text-ink-soft">Not enough answers for a duel yet.</p>;
  }

  const winrates = await getTasteWinrates();

  // Weight contenders toward under-battled models so battle counts stay
  // balanced — uniform sampling leaves new models starved of data.
  const battlesFor = (modelId: string) =>
    winrates?.find((w) => w.model_id === modelId)?.battles ?? 0;
  const weightedPick = <T,>(items: T[], weightOf: (item: T) => number): T => {
    const weights = items.map(weightOf);
    let roll = Math.random() * weights.reduce((s, w) => s + w, 0);
    for (let i = 0; i < items.length; i++) {
      roll -= weights[i]!;
      if (roll <= 0) return items[i]!;
    }
    return items[items.length - 1]!;
  };
  const first = weightedPick(candidates, (r) => 1 / (battlesFor(r.modelId) + 1));
  const second = weightedPick(
    candidates.filter((r) => r !== first),
    (r) => 1 / (battlesFor(r.modelId) + 1),
  );
  const recordFor = (modelId: string) => winrates?.find((w) => w.model_id === modelId);
  const contender = (r: typeof first) => ({
    modelId: r.modelId,
    displayName: rows.get(r.modelId)?.displayName ?? r.modelId,
    provider: rows.get(r.modelId)?.provider ?? '',
    answer: plainText(r.answerText),
    winRate: recordFor(r.modelId)?.win_rate,
    battles: recordFor(r.modelId)?.battles,
  });

  const totalVotes = winrates ? Math.round(winrates.reduce((s, w) => s + w.battles, 0) / 2) : 0;
  const ranked = winrates
    ?.filter((w) => w.battles >= 5 && rows.has(w.model_id))
    .sort((a, b) => b.win_rate - a.win_rate)
    .slice(0, 10);

  return (
    <div className="py-16">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1
          className="font-display font-semibold tracking-tight"
          style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', letterSpacing: '-0.02em' }}
        >
          The <em className="text-paprika not-italic underline decoration-2 underline-offset-8">taste</em> test
        </h1>
        {totalVotes > 0 && (
          <span className="tabular text-sm text-ink-soft">
            {totalVotes.toLocaleString()} {totalVotes === 1 ? 'vote' : 'votes'} served
          </span>
        )}
      </div>
      <p className="mt-4 max-w-2xl text-lg text-ink-soft">
        Two AI chefs, one brief, no names. The benchmark&rsquo;s judges measure
        precision — here, <strong>you</strong> judge flavour. Pick the dish
        you&rsquo;d rather be served.
      </p>

      <div className="mt-12 border-t-2 border-ink pt-6">
        <p className="text-sm uppercase tracking-wider text-ink-soft">Tonight&rsquo;s brief</p>
        <p className="mt-3 max-w-prose whitespace-pre-wrap font-display text-xl leading-relaxed">
          {question.prompt}
        </p>
      </div>

      {/* Keyed by the exact pairing so the duel remounts (and re-blinds) on every refresh. */}
      <TasteDuel
        key={`${question.id}:${first.modelId}:${second.modelId}`}
        runId={report.runId}
        questionId={question.id}
        a={contender(first)}
        b={contender(second)}
      />

      {ranked && ranked.length > 0 && (
        <section className="mt-20 border-t border-hairline pt-8">
          <h2 className="font-display text-xl font-medium">Crowd favourites so far</h2>
          <table className="mt-4 w-full max-w-md border-collapse text-sm">
            <tbody>
              {ranked.map((w, i) => (
                <tr key={w.model_id} className="border-b border-hairline">
                  <td className="tabular py-2 pr-3 text-ink-soft">{i + 1}</td>
                  <td className="py-2 pr-4">{rows.get(w.model_id)?.displayName}</td>
                  <td className="tabular py-2 pr-4">{w.win_rate.toFixed(1)}%</td>
                  <td className="tabular py-2 text-ink-soft">{w.battles} battles</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 max-w-md text-xs text-ink-soft">
            Win rates from blind human votes. With 5+ battles a model earns a
            Taste column on the main leaderboard.
          </p>
          <p className="mt-2 text-sm">
            <a href="/taste" className="text-paprika hover:underline">
              Full taste board — Bradley-Terry ratings &amp; head-to-head records →
            </a>
          </p>
        </section>
      )}
    </div>
  );
}
