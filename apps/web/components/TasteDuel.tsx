'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { voteAction } from '@/app/tastetest/actions';

interface DuelProps {
  runId: string;
  questionId: string;
  prompt: string;
  modelA: string;
  displayA: string;
  answerA: string;
  modelB: string;
  displayB: string;
  answerB: string;
}

export function TasteDuel(duel: DuelProps) {
  const router = useRouter();
  const [voted, setVoted] = useState<'a' | 'b' | 'tie' | null>(null);
  const [pending, startTransition] = useTransition();

  function vote(winner: 'a' | 'b' | 'tie') {
    if (voted) return;
    setVoted(winner);
    const form = new FormData();
    form.set('runId', duel.runId);
    form.set('questionId', duel.questionId);
    form.set('modelA', duel.modelA);
    form.set('modelB', duel.modelB);
    form.set('winner', winner);
    startTransition(async () => {
      await voteAction(form);
    });
  }

  const card = (side: 'a' | 'b', label: string, text: string, revealed: string) => (
    <button
      type="button"
      onClick={() => vote(side)}
      disabled={voted !== null}
      className={`flex-1 border p-5 text-left align-top transition-colors ${
        voted === side
          ? 'border-paprika bg-paper-tint'
          : voted
            ? 'border-hairline opacity-70'
            : 'border-hairline hover:border-paprika hover:bg-paper-tint'
      }`}
    >
      <div className="flex items-baseline justify-between">
        <span className="font-display text-lg font-medium">
          {voted ? revealed : label}
        </span>
        {voted === side && <span className="text-xs font-medium text-paprika">your pick</span>}
      </div>
      <p className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">
        {text}
      </p>
    </button>
  );

  return (
    <div>
      <div className="mt-8 flex flex-col gap-4 md:flex-row">
        {card('a', 'Dish A', duel.answerA, duel.displayA)}
        {card('b', 'Dish B', duel.answerB, duel.displayB)}
      </div>
      <div className="mt-6 flex items-center gap-4">
        {voted === null ? (
          <>
            <span className="text-sm text-ink-soft">Click the better answer, or</span>
            <button
              type="button"
              onClick={() => vote('tie')}
              className="border border-hairline px-4 py-2 text-sm hover:border-paprika hover:text-paprika"
            >
              Call it a tie
            </button>
          </>
        ) : (
          <>
            <span className="text-sm text-ink-soft">
              {pending ? 'Recording your vote…' : 'Vote recorded — chefs revealed above.'}
            </span>
            <button
              type="button"
              onClick={() => router.refresh()}
              className="border border-ink bg-ink px-4 py-2 text-sm text-paper hover:bg-paprika hover:border-paprika"
            >
              Next pair →
            </button>
          </>
        )}
      </div>
    </div>
  );
}
