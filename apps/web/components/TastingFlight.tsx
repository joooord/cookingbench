'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
// TYPE-ONLY. A value import from the core barrel drags schema.ts and zod into
// the client bundle for the sake of one integer; the round count is already on
// the flight the server sent.
import type { TasteChoice } from '@cookingbench/core';
import {
  attachReasonAction,
  castBallotAction,
  revealAction,
  startFlightAction,
} from '@/app/tastetest/actions';
import type { BuiltFlight, RoundIdentity } from '@/app/tastetest/shape';
import { ProposalCard } from './ProposalCard';

export interface TrackOption {
  track: string;
  label: string;
  blurb: string;
  available: boolean;
  reason?: string;
}

/**
 * The ballot (M5.3). Five outcomes, and `equal` and `neither` are never the
 * same button. "Equally good" says both are worth cooking; "Neither works"
 * says neither should be served. A single "tie" button conflates them, and the
 * conflation is not recoverable afterwards — which is why the v2 vote log
 * cannot be converted into this vocabulary at all.
 */
const BALLOT: ReadonlyArray<{ choice: TasteChoice; label: string; hint: string }> = [
  { choice: 'left', label: 'Choose A', hint: 'I would rather cook, serve or eat A' },
  { choice: 'right', label: 'Choose B', hint: 'I would rather cook, serve or eat B' },
  { choice: 'equal', label: 'Equally good', hint: 'Both are worth cooking; I cannot separate them' },
  { choice: 'neither', label: 'Neither works', hint: 'I would not serve either of these' },
  { choice: 'abstain', label: 'Not my area', hint: 'I am not the right person to judge this one' },
];

type SaveState =
  | { kind: 'open' }
  | { kind: 'pending' }
  | { kind: 'saved' }
  | { kind: 'error'; retryable: boolean; message: string };

function sessionId(): string {
  try {
    let id = localStorage.getItem('tastetest-session');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('tastetest-session', id);
    }
    return id;
  } catch {
    // Private mode, or storage blocked. An absent session id costs the
    // consistency and abuse controls, so the ballot is still recorded but is
    // honestly unattributable rather than given a fresh id every round, which
    // would look like a crowd of one-round voters.
    return '';
  }
}

export function TastingFlight({ tracks }: { tracks: TrackOption[] }) {
  const [flight, setFlight] = useState<BuiltFlight | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [index, setIndex] = useState(0);
  const [choice, setChoice] = useState<TasteChoice | null>(null);
  const [save, setSave] = useState<SaveState>({ kind: 'open' });
  const [receipts, setReceipts] = useState<string[]>([]);
  const [reasonDone, setReasonDone] = useState(false);
  const [finished, setFinished] = useState(false);
  const [identities, setIdentities] = useState<RoundIdentity[] | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [shared, setShared] = useState(false);

  // Dwell is measured from the round appearing, and "both seen" from the foot
  // of each card reaching the viewport. Refs, not state: they must not
  // re-render the round underneath a reader who is mid-sentence.
  const shownAt = useRef(Date.now());
  const seen = useRef({ left: false, right: false });
  const headingRef = useRef<HTMLHeadingElement | null>(null);

  const round = flight?.rounds[index] ?? null;
  // Completion is an EXPLICIT step, not "five receipts exist". Round five is
  // recorded before its post-vote reason is asked, so a completeness test
  // derived from the receipt count flips one render too early and skips the
  // last round's reason question entirely.
  const recorded = receipts.filter(Boolean).length;

  useEffect(() => {
    shownAt.current = Date.now();
    seen.current = { left: false, right: false };
    // Move focus to the round heading so a screen-reader user lands on the new
    // round rather than at the top of the document, and a keyboard user's next
    // Tab reaches this round's ballot instead of the previous one's.
    headingRef.current?.focus();
  }, [index, flight]);

  const markSeen = useCallback((side: 'left' | 'right') => {
    seen.current[side] = true;
  }, []);

  async function start(track: string) {
    setStarting(true);
    setStartError(null);
    const result = await startFlightAction(track);
    setStarting(false);
    if (!result.ok) {
      setStartError(result.reason);
      return;
    }
    setFlight(result.flight);
    setIndex(0);
    setFinished(false);
    setChoice(null);
    setSave({ kind: 'open' });
    setReceipts([]);
    setReasonDone(false);
    setIdentities(null);
    setRevealError(null);
  }

  async function cast(picked: TasteChoice) {
    if (!flight || !round) return;
    // The pick locks on the first press. Everything after this is about whether
    // it reached the kitchen, never about changing it — a vote a reader can
    // revise after seeing a "saved" tick is not a blind first impression.
    if (choice !== null && save.kind !== 'error') return;
    setChoice(picked);
    setSave({ kind: 'pending' });
    const result = await castBallotAction({
      token: flight.token,
      round: round.round,
      choice: picked,
      dwellMs: Date.now() - shownAt.current,
      bothSeen: seen.current.left && seen.current.right,
      sessionId: sessionId(),
    });
    if (result.ok) {
      setReceipts((prev) => {
        const next = [...prev];
        next[round.round - 1] = result.receipt;
        return next;
      });
      setSave({ kind: 'saved' });
      return;
    }
    setSave({ kind: 'error', retryable: result.retryable, message: result.reason });
  }

  async function chooseReason(reasonIndex: number | null) {
    setReasonDone(true);
    if (reasonIndex === null || !flight || !round) return;
    // Best effort by design: the reason is a follow-up, and a reader who has
    // already cast their ballot must never be held at a retry prompt for it.
    await attachReasonAction(flight.token, round.round, reasonIndex);
  }

  function advance() {
    if (!flight) return;
    if (index + 1 >= flight.rounds.length) {
      setFinished(true);
      return;
    }
    setChoice(null);
    setSave({ kind: 'open' });
    setReasonDone(false);
    setIndex((i) => i + 1);
  }

  async function reveal() {
    if (!flight) return;
    // Dense, in round order. A sparse array would serialise its holes as null
    // and the reveal would refuse a flight that was in fact complete.
    const ordered = flight.rounds.map((r) => receipts[r.round - 1] ?? '');
    const result = await revealAction(flight.token, ordered);
    if (result.ok) setIdentities(result.identities);
    else setRevealError(result.reason);
  }

  useEffect(() => {
    if (finished && identities === null && revealError === null) void reveal();
    // `reveal` closes over flight and receipts, both settled by the time
    // `finished` flips; re-running on every render would re-request the reveal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [finished]);

  /* ---------------------------------------------------------------------- */
  /* Track picker                                                           */
  /* ---------------------------------------------------------------------- */

  if (!flight) {
    return (
      <section className="mt-10">
        <h2 className="font-display text-xl font-medium">Pick a tasting track</h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-soft">
          Five rounds, about three minutes. Names stay hidden until the whole
          flight ends.
        </p>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2">
          {tracks.map((t) => (
            <li key={t.track}>
              <button
                type="button"
                disabled={!t.available || starting}
                onClick={() => void start(t.track)}
                className={`w-full border-2 p-5 text-left transition-colors motion-reduce:transition-none ${
                  t.available
                    ? 'cursor-pointer border-hairline hover:border-paprika'
                    : 'cursor-not-allowed border-hairline opacity-55'
                }`}
              >
                <span className="font-display text-lg font-semibold">{t.label}</span>
                <span className="mt-1 block text-sm text-ink-soft">{t.blurb}</span>
                {!t.available && (
                  <span className="mt-3 block text-xs uppercase tracking-wider text-ink-soft">
                    Not serving — {t.reason}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
        {startError && (
          <p role="alert" className="mt-4 text-sm text-paprika">
            {startError}
          </p>
        )}
      </section>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Completion, reveal and contribution summary                            */
  /* ---------------------------------------------------------------------- */

  if (finished) {
    return (
      <section className="mt-10">
        <h2 className="font-display text-2xl font-semibold">Flight complete</h2>
        <p className="mt-2 max-w-2xl text-ink-soft">
          <span className="tabular">{recorded}</span> ballots recorded on the{' '}
          <strong>{flight.track}</strong> track. Every one of them
          is development evidence: it is kept, it is analysed, and it does not move any
          published ranking.
        </p>

        <div className="mt-8 border-t-2 border-ink pt-6">
          <h3 className="font-display text-lg font-medium">Who you were reading</h3>
          {identities ? (
            <table className="mt-4 w-full max-w-xl border-collapse text-sm">
              <thead>
                <tr className="border-b border-hairline text-left text-xs uppercase tracking-wider text-ink-soft">
                  <th className="py-2 pr-3 font-normal">Round</th>
                  <th className="py-2 pr-4 font-normal">A</th>
                  <th className="py-2 font-normal">B</th>
                </tr>
              </thead>
              <tbody>
                {identities.map((row) => (
                  <tr key={row.round} className="border-b border-hairline">
                    <td className="tabular py-2 pr-3 text-ink-soft">{row.round}</td>
                    <td className="py-2 pr-4">{row.left}</td>
                    <td className="py-2">
                      {row.right}
                      {row.identical && (
                        <span className="ml-2 text-xs text-paprika">
                          — same text on both sides (a control round)
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="mt-3 text-sm text-ink-soft" role="status">
              {revealError ?? 'Unsealing the names…'}
            </p>
          )}
          <p className="mt-4 max-w-2xl text-xs leading-relaxed text-ink-soft">
            These are authored fixture voices, not models. The Tasting Flight runs on
            hand-written proposals until the Stage 5 measurement gates pass, so that the
            interaction can be tested without spending a model contact or putting an
            unvalidated number on a public board.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3 border-t border-hairline pt-6">
          <button
            type="button"
            onClick={() => setFlight(null)}
            className="border border-ink bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:border-paprika hover:bg-paprika motion-reduce:transition-none"
          >
            Another flight →
          </button>
          <button
            type="button"
            onClick={async () => {
              // Spoiler-free by construction: no round, no verdict, no name.
              // A share that quotes your own choices primes whoever clicks it.
              const text = `I judged a five-round tasting flight on CookingBench. No names until the end.`;
              try {
                await navigator.clipboard.writeText(`${text} https://cookingbench.com/tastetest`);
                setShared(true);
              } catch {
                setShared(false);
              }
            }}
            className="border border-hairline px-5 py-2.5 text-sm transition-colors hover:border-paprika hover:text-paprika motion-reduce:transition-none"
          >
            {shared ? 'Link copied ✓' : 'Copy a spoiler-free link'}
          </button>
        </div>
      </section>
    );
  }

  /* ---------------------------------------------------------------------- */
  /* A round                                                                */
  /* ---------------------------------------------------------------------- */

  if (!round) return null;
  const cardState = (side: 'left' | 'right') => {
    if (choice === null) return 'open' as const;
    if (choice === 'left' || choice === 'right') {
      return choice === side ? ('picked' as const) : ('passed' as const);
    }
    return 'locked' as const;
  };
  const locked = choice !== null;
  const showReason = save.kind === 'saved' && !reasonDone;
  const canAdvance = save.kind === 'saved' && reasonDone;

  return (
    // Bottom padding clears the mobile decision bar. "Non-obstructive" is a
    // layout obligation, not a z-index one: a bar that floats over the last
    // paragraph of proposal B hides the thing being judged.
    <section className="mt-10 pb-40 sm:pb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="font-display text-xl font-medium outline-none"
        >
          Round <span className="tabular">{round.round}</span> of{' '}
          <span className="tabular">{flight.rounds.length}</span>
        </h2>
        <ol className="flex items-center gap-1.5" aria-hidden>
          {flight.rounds.map((r) => (
            <li
              key={r.round}
              className={`h-1.5 w-8 ${
                receipts[r.round - 1]
                  ? 'bg-paprika'
                  : r.round === round.round
                    ? 'bg-ink'
                    : 'bg-hairline'
              }`}
            />
          ))}
        </ol>
      </div>

      <div className="mt-5 border border-hairline bg-paper-bright px-5 py-6 sm:px-8">
        <p className="text-xs uppercase tracking-[0.2em] text-ink-soft">The brief</p>
        <p className="mt-3 max-w-3xl font-display text-lg leading-relaxed">{round.task}</p>
      </div>

      <div className="mt-8 flex flex-col gap-8 lg:flex-row lg:gap-10">
        {/* Keyed by round: without this React reuses the same card instance
            across rounds, its IntersectionObserver never re-arms, and the
            both-seen signal is recorded as false for every round after the
            first — a silent 80% exclusion rate in analysis. */}
        <ProposalCard
          key={`${round.round}-left`}
          side="left"
          label="Proposal A"
          proposal={round.left}
          state={cardState('left')}
          onPick={() => void cast('left')}
          onSeen={() => markSeen('left')}
        />
        <ProposalCard
          key={`${round.round}-right`}
          side="right"
          label="Proposal B"
          proposal={round.right}
          state={cardState('right')}
          onPick={() => void cast('right')}
          onSeen={() => markSeen('right')}
        />
      </div>

      {/* The ballot. Native buttons in a fieldset with the judging question as
          its legend — the question a screen-reader user needs is the one they
          are answering, not the page title. */}
      {/* Once the pick is made the ballot stays disabled, including through a
          failed save. Re-enabling it on error would let a reader change their
          mind at the one moment they have had extra seconds to think — the
          retry button re-sends the choice they actually made. */}
      <fieldset
        disabled={locked}
        className="sticky bottom-0 z-20 mt-8 border-t-2 border-ink bg-paper px-1 py-4 sm:static sm:px-0"
      >
        <legend className="font-display text-base">{round.judgingQuestion}</legend>
        <div className="mt-3 flex flex-wrap gap-2">
          {BALLOT.map((option) => (
            <button
              key={option.choice}
              type="button"
              title={option.hint}
              aria-label={`${option.label} — ${option.hint}`}
              onClick={() => void cast(option.choice)}
              className={`border px-4 py-2.5 text-sm transition-colors motion-reduce:transition-none ${
                choice === option.choice
                  ? 'border-paprika bg-paprika text-paper'
                  : 'border-hairline hover:border-paprika hover:text-paprika disabled:hover:border-hairline disabled:hover:text-ink'
              } disabled:opacity-60`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="mt-2 text-xs text-ink-soft sm:hidden">
          Or tap the proposal you would rather cook.
        </p>
      </fieldset>

      {/* One live region for the whole round, so a save, a failure and a
          completion are announced in the order they happen. */}
      <div role="status" aria-live="polite" className="mt-4 min-h-6 text-sm">
        {save.kind === 'pending' && <span className="text-ink-soft">Recording your ballot…</span>}
        {save.kind === 'saved' && !showReason && (
          <span className="text-ink-soft">Recorded. Names stay sealed until round five.</span>
        )}
      </div>

      {save.kind === 'error' && (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <span role="alert" className="text-sm text-paprika">
            {save.message}
          </span>
          {save.retryable ? (
            <button
              type="button"
              onClick={() => choice && void cast(choice)}
              className="border border-paprika px-4 py-2 text-sm font-medium text-paprika transition-colors hover:bg-paprika hover:text-paper motion-reduce:transition-none"
            >
              Try again
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setFlight(null)}
              className="border border-hairline px-4 py-2 text-sm transition-colors hover:border-paprika motion-reduce:transition-none"
            >
              Start a fresh flight
            </button>
          )}
        </div>
      )}

      {/* The bounded "why?", asked only after the primary vote has locked and
          been recorded. It is never on screen while the ballot is open, which
          is the requirement — a reason list visible during the decision is a
          rubric, and it would tell the reader what they are supposed to notice. */}
      {showReason && (
        <fieldset className="mt-6 border-t border-hairline pt-5">
          <legend className="text-sm text-ink-soft">
            Optional — what decided it? (Your vote is already recorded.)
          </legend>
          <div className="mt-3 flex flex-wrap gap-2">
            {round.reasons.map((reason, i) => (
              <button
                key={reason}
                type="button"
                onClick={() => void chooseReason(i)}
                className="border border-hairline px-4 py-2 text-sm transition-colors hover:border-paprika hover:text-paprika motion-reduce:transition-none"
              >
                {reason}
              </button>
            ))}
            <button
              type="button"
              onClick={() => void chooseReason(null)}
              className="px-3 py-2 text-sm text-ink-soft transition-colors hover:text-paprika motion-reduce:transition-none"
            >
              Skip
            </button>
          </div>
        </fieldset>
      )}

      {canAdvance && (
        <div className="mt-6">
          <button
            type="button"
            onClick={advance}
            className="border border-ink bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:border-paprika hover:bg-paprika motion-reduce:transition-none"
          >
            {round.round === flight.rounds.length ? 'Finish and reveal →' : 'Next round →'}
          </button>
        </div>
      )}
    </section>
  );
}
