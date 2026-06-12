'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
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

/** Anonymous per-browser id so analysis can spot repeat/spam voters. */
function sessionId(): string {
  try {
    let id = localStorage.getItem('tastetest-session');
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem('tastetest-session', id);
    }
    return id;
  } catch {
    return '';
  }
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

  // The whole card is the vote target ("tap the dish"), so the root carries
  // the click — it can't be a <button> because the expand toggle nests inside.
  return (
    <div
      role="button"
      tabIndex={revealed ? -1 : 0}
      aria-disabled={revealed}
      onClick={revealed ? undefined : onPick}
      onKeyDown={(e) => {
        if (!revealed && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onPick();
        }
      }}
      className={`flex-1 border-2 bg-paper transition-all duration-200 ${
        state === 'picked'
          ? 'border-paprika bg-paper-tint'
          : state === 'passed'
            ? 'border-hairline opacity-60'
            : 'cursor-pointer border-hairline hover:-translate-y-0.5 hover:border-ink'
      }`}
    >
      <div className="w-full p-5 text-left">
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
      </div>
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
            onClick={(e) => {
              e.stopPropagation();
              setExpanded(!expanded);
            }}
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
  // The pick is made once, blind; status tracks whether it actually reached
  // the kitchen. A failed save keeps the pick locked and offers a retry —
  // votes must never be lost silently.
  const [picked, setPicked] = useState<'a' | 'b' | 'tie' | null>(null);
  const [status, setStatus] = useState<'open' | 'pending' | 'saved' | 'error'>('open');
  const [rounds, setRounds] = useState<number | null>(null);
  const [, startTransition] = useTransition();
  // Component remounts per pairing (keyed by the parent), so mount ≈ pair shown.
  const shownAt = useRef(Date.now());

  useEffect(() => {
    setRounds(Number(localStorage.getItem('tastetest-rounds') ?? 0));
  }, []);

  function submit(winner: 'a' | 'b' | 'tie') {
    setStatus('pending');
    const form = new FormData();
    form.set('runId', runId);
    form.set('questionId', questionId);
    form.set('modelA', a.modelId);
    form.set('modelB', b.modelId);
    form.set('winner', winner);
    form.set('sessionId', sessionId());
    form.set('voteMs', String(Date.now() - shownAt.current));
    startTransition(async () => {
      const { ok } = await voteAction(form);
      if (ok) {
        setStatus('saved');
        const next = Number(localStorage.getItem('tastetest-rounds') ?? 0) + 1;
        localStorage.setItem('tastetest-rounds', String(next));
        setRounds(next);
      } else {
        setStatus('error');
      }
    });
  }

  function vote(winner: 'a' | 'b' | 'tie') {
    if (picked) return;
    setPicked(winner);
    submit(winner);
  }

  const state = (side: 'a' | 'b'): 'open' | 'picked' | 'passed' =>
    picked === null ? 'open' : picked === side ? 'picked' : 'passed';

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
        {status === 'open' && (
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
        )}
        {status === 'pending' && (
          <span className="text-sm text-ink-soft" role="status">
            Plating your verdict&hellip;
          </span>
        )}
        {status === 'error' && (
          <>
            <span className="text-sm text-paprika" role="alert">
              Your vote didn&rsquo;t reach the kitchen.
            </span>
            <button
              type="button"
              onClick={() => picked && submit(picked)}
              className="border border-paprika px-4 py-2 text-sm font-medium text-paprika transition-colors hover:bg-paprika hover:text-paper"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="px-2 py-2 text-sm text-ink-soft transition-colors hover:text-paprika"
            >
              Skip it ↻
            </button>
          </>
        )}
        {status === 'saved' && (
          <>
            <span className="font-display text-base">
              {picked === 'tie' ? 'A diplomatic palate.' : 'Noted, chef.'}
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
      {rounds !== null && rounds > 0 && (
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
