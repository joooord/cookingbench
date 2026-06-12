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

export default async function TasteTestPage() {
  const report = getLatestReport();
  if (!report) {
    return <p className="py-16 text-ink-soft">No published runs yet — come back soon.</p>;
  }
  const displayNames = new Map(report.rows.map((r) => [r.modelId, r.displayName]));

  // Duels run on judged (subjective) questions — the ones where taste matters.
  const questions = getPublicQuestions().filter(
    (q) => q.grader.type === 'llm-judge' && q.status !== 'basics' && q.status !== 'retired',
  );
  const responses = getResponses(report.runId).filter(
    (r) => r.answerText.trim().length > 0 && displayNames.has(r.modelId),
  );

  const question = questions[Math.floor(Math.random() * questions.length)]!;
  const candidates = responses.filter((r) => r.questionId === question.id);
  if (candidates.length < 2) {
    return <p className="py-16 text-ink-soft">Not enough answers for a duel yet.</p>;
  }
  const first = candidates.splice(Math.floor(Math.random() * candidates.length), 1)[0]!;
  const second = candidates[Math.floor(Math.random() * candidates.length)]!;

  const winrates = await getTasteWinrates();
  const ranked = winrates
    ?.filter((w) => w.battles >= 5 && displayNames.has(w.model_id))
    .sort((a, b) => b.win_rate - a.win_rate)
    .slice(0, 10);

  return (
    <div className="py-16">
      <h1
        className="font-display font-semibold tracking-tight"
        style={{ fontSize: 'clamp(2rem, 5vw, 3.5rem)', letterSpacing: '-0.02em' }}
      >
        The taste test
      </h1>
      <p className="mt-4 max-w-2xl text-lg text-ink-soft">
        Two AI chefs, one question, no names. Read both answers and pick the dish
        you&rsquo;d rather eat. The benchmark&rsquo;s judges measure precision —
        this is where humans judge taste.
      </p>

      <div className="mt-12 border-t-2 border-ink pt-6">
        <p className="text-sm uppercase tracking-wider text-ink-soft">The brief</p>
        <p className="mt-3 max-w-prose whitespace-pre-wrap text-lg leading-relaxed">
          {question.prompt}
        </p>
      </div>

      <TasteDuel
        runId={report.runId}
        questionId={question.id}
        prompt={question.prompt}
        modelA={first.modelId}
        displayA={displayNames.get(first.modelId) ?? first.modelId}
        answerA={first.answerText}
        modelB={second.modelId}
        displayB={displayNames.get(second.modelId) ?? second.modelId}
        answerB={second.answerText}
      />

      {ranked && ranked.length > 0 && (
        <section className="mt-20 border-t border-hairline pt-8">
          <h2 className="font-display text-xl font-medium">Crowd favourites so far</h2>
          <table className="mt-4 w-full max-w-md border-collapse text-sm">
            <tbody>
              {ranked.map((w, i) => (
                <tr key={w.model_id} className="border-b border-hairline">
                  <td className="tabular py-2 pr-3 text-ink-soft">{i + 1}</td>
                  <td className="py-2 pr-4">{displayNames.get(w.model_id)}</td>
                  <td className="tabular py-2 pr-4">{w.win_rate.toFixed(1)}%</td>
                  <td className="tabular py-2 text-ink-soft">{w.battles} battles</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
