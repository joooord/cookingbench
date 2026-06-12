'use client';

import { useEffect, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { voteAction } from '@/app/tastetest/actions';

interface Contender {
  modelId: string;
  displayName: string;
  provider: string;
  answer: string;
  /** Crowd record so far, if the model has battled before. */
  winRate?: number;
  battles?: number;
}

interface DuelProps {
  runId: string;
  questionId: string;
  a: Contender;
  b: Contender;
}

/** Kitchen-brigade ranks earned by judging rounds (stored locally, just for fun). */
const RANKS: Array<[number, string]> = [
  [40, 'Michelin Inspector'],
  [25, 'Food Critic'],
  [15, 'Head Chef'],
  [10, 'Sous Chef'],
  [6, 'Line Cook'],
  [3, 'Commis Chef'],
  [1, 'Dishwasher'],
  [0, 'Hungry Guest'],
];

function rankFor(count: number): string {
  return RANKS.find(([n]) => count >= n)![1];
}

function Toque({ color }: { color: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">
      <g fill={color}>
        <circle cx="21" cy="27" r="9.5" />
        <circle cx="32" cy="22.5" r="11" />
        <circle cx="43" cy="27" r="9.5" />
        <rect x="14.5" y="27" width="35" height="12" />
        <rect x="19" y="42.5" width="26" height="6.5" rx="2" />
      </g>
    </svg>
  );
}

function DishCard({
  label,
  color,
  contender,
  state,
  onPick,
}: {
  label: string;
  color: string;
  contender: Contender;
  state: 'open' | 'picked' | 'passed';
  onPick: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const long = contender.answer.length > 900;
  const revealed = state !== 'open';

  return (
    <div
      className={`flex-1 border-2 bg-paper transition-all duration-200 ${
        state === 'picked'
          ? 'border-paprika bg-paper-tint'
          : state === 'passed'
            ? 'border-hairline opacity-60'
            : 'border-hairline hover:-translate-y-0.5 hover:border-ink'
      }`}
    >
      <button
        type="button"
        onClick={onPick}
        disabled={revealed}
        className="block w-full p-5 text-left"
      >
        <div className="flex items-center justify-between border-b border-hairline pb-3">
          <span className="flex items-center gap-2.5">
            <Toque color={color} />
            <span className="font-display text-xl font-semibold">
              {revealed ? contender.displayName : label}
            </span>
            {revealed && <span className="text-xs text-ink-soft">{contender.provider}</span>}
          </span>
          {state === 'picked' && (
            <span className="border border-paprika px-2 py-0.5 text-xs font-medium uppercase tracking-wider text-paprika">
              Your pick
            </span>
          )}
        </div>
        {revealed && contender.battles !== undefined && contender.battles >= 5 && (
          <p className="mt-2 text-xs text-ink-soft">
            Crowd record: wins {contender.winRate?.toFixed(0)}% of {contender.battles} battles
          </p>
        )}
      </button>
      <div className="px-5 pb-5">
        <div className="relative">
          <p
            className={`whitespace-pre-wrap text-sm leading-relaxed text-ink-soft ${
              long && !expanded ? 'max-h-72 overflow-hidden' : ''
            }`}
          >
            {contender.answer}
          </p>
          {long && !expanded && (
            <div
              className="pointer-events-none absolute inset-x-0 bottom-0 h-16"
              style={{ background: 'linear-gradient(transparent, var(--color-paper))' }}
            />
          )}
        </div>
        {long && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="mt-2 text-xs font-medium text-paprika hover:underline"
          >
            {expanded ? 'Fold it back up ↑' : 'Read the full recipe ↓'}
          </button>
        )}
      </div>
    </div>
  );
}

export function TasteDuel({ runId, questionId, a, b }: DuelProps) {
  const router = useRouter();
  const [voted, setVoted] = useState<'a' | 'b' | 'tie' | null>(null);
  const [rounds, setRounds] = useState(0);
  const [, startTransition] = useTransition();

  useEffect(() => {
    setRounds(Number(localStorage.getItem('tastetest-rounds') ?? 0));
  }, []);

  function vote(winner: 'a' | 'b' | 'tie') {
    if (voted) return;
    setVoted(winner);
    const next = rounds + 1;
    setRounds(next);
    localStorage.setItem('tastetest-rounds', String(next));
    const form = new FormData();
    form.set('runId', runId);
    form.set('questionId', questionId);
    form.set('modelA', a.modelId);
    form.set('modelB', b.modelId);
    form.set('winner', winner);
    startTransition(async () => {
      await voteAction(form);
    });
  }

  const state = (side: 'a' | 'b'): 'open' | 'picked' | 'passed' =>
    voted === null ? 'open' : voted === side ? 'picked' : 'passed';

  return (
    <div>
      {/* The duel */}
      <div className="relative mt-8 flex flex-col gap-10 md:flex-row md:gap-12">
        <DishCard label="Dish A" color="var(--color-saltblue)" contender={a} state={state('a')} onPick={() => vote('a')} />
        {/* VS badge */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 z-10 hidden -translate-x-1/2 -translate-y-1/2 md:block">
          <div className="flex h-12 w-12 items-center justify-center rounded-full border-2 border-paper bg-paprika font-display text-base font-bold text-paper">
            VS
          </div>
        </div>
        <div className="-my-7 flex justify-center md:hidden">
          <div className="z-10 flex h-11 w-11 items-center justify-center rounded-full border-2 border-paper bg-paprika font-display text-sm font-bold text-paper">
            VS
          </div>
        </div>
        <DishCard label="Dish B" color="var(--color-olive)" contender={b} state={state('b')} onPick={() => vote('b')} />
      </div>

      {/* Controls */}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3 border-t border-hairline pt-6">
        {voted === null ? (
          <>
            <span className="text-sm text-ink-soft">Tap the dish you&rsquo;d rather eat —</span>
            <button
              type="button"
              onClick={() => vote('tie')}
              className="border border-hairline px-4 py-2 text-sm transition-colors hover:border-paprika hover:text-paprika"
            >
              Too close to call
            </button>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="px-2 py-2 text-sm text-ink-soft transition-colors hover:text-paprika"
            >
              Pass — serve me another ↻
            </button>
          </>
        ) : (
          <>
            <span className="font-display text-base">
              {voted === 'tie' ? 'A diplomatic palate.' : 'Noted, chef.'}
            </span>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="border border-ink bg-ink px-5 py-2.5 text-sm font-medium text-paper transition-colors hover:border-paprika hover:bg-paprika"
            >
              Next round →
            </button>
          </>
        )}
      </div>

      {/* Brigade rank */}
      {rounds > 0 && (
        <p className="mt-4 text-center text-xs text-ink-soft">
          You&rsquo;ve judged <span className="tabular">{rounds}</span>{' '}
          {rounds === 1 ? 'round' : 'rounds'} — current rank:{' '}
          <span className="font-medium text-ink">{rankFor(rounds)}</span>
          {rounds < 40 && (
            <span>
              {' '}
              · promotion at {[...RANKS].reverse().find(([n]) => n > rounds)?.[0]} rounds
            </span>
          )}
        </p>
      )}
    </div>
  );
}
