'use client';

import { useEffect, useRef } from 'react';
import type { SensoryCard, TimelineStep } from '@/app/tastetest/fixtures/types';

export interface ProposalView {
  body: string;
  words: number;
  sensory?: SensoryCard;
  timeline?: TimelineStep[];
}

/**
 * The seven rows of a sensory card, in a fixed order, rendered identically on
 * both sides (M5.2). The order is declared here rather than taken from
 * `Object.keys` because key order is an accident of how an object literal was
 * typed, and two cards whose rows appeared in different orders would be a
 * comparison the reader has to reconcile before they can judge the food.
 */
const SENSORY_ROWS: ReadonlyArray<[keyof SensoryCard, string]> = [
  ['identity', 'Identity'],
  ['aroma', 'Aroma'],
  ['balance', 'Balance'],
  ['texture', 'Texture & temperature'],
  ['progression', 'Bite & finish'],
  ['failure', 'Likely failure'],
  ['restraint', 'Deliberate restraint'],
];

/**
 * One blinded proposal.
 *
 * Two things here are load-bearing rather than cosmetic.
 *
 * **The whole card is the tap target.** A v1 bug put the click on the header
 * strip only and most taps did nothing. The card `div` carries the pointer
 * handler for that reason.
 *
 * **The card is NOT `role="button"`.** It contains a description list, which is
 * not valid button content, and a role without complete keyboard semantics is
 * worse than no role — it promises a control that Enter and Space do not
 * operate. Every keyboard and screen-reader path goes through the real
 * `<button>`s in the ballot fieldset below, which is where the accessible name
 * for each side lives. The pointer handler is a convenience on top of that, not
 * a substitute for it.
 */
export function ProposalCard({
  side,
  label,
  proposal,
  revealedName,
  state,
  onPick,
  onSeen,
}: {
  side: 'left' | 'right';
  label: string;
  proposal: ProposalView;
  /** Non-null only after the whole flight has ended. */
  revealedName?: string | null;
  state: 'open' | 'picked' | 'passed' | 'locked';
  onPick: () => void;
  /** Fires once when the reader has had the bottom of this card on screen. */
  onSeen: () => void;
}) {
  const foot = useRef<HTMLDivElement | null>(null);
  const reported = useRef(false);

  useEffect(() => {
    const node = foot.current;
    if (!node) return;
    // "Both seen" means the bottom of the card reached the viewport, not that
    // the card exists in the DOM. On a phone the second proposal is entirely
    // below the fold, and a ballot cast without ever scrolling to it is not a
    // comparison. IntersectionObserver is absent in some embedded webviews, in
    // which case the signal stays false and the ballot is excluded in analysis
    // — recorded and counted, never silently promoted to "seen".
    if (typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !reported.current) {
          reported.current = true;
          onSeen();
        }
      },
      { threshold: 0.9 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [onSeen]);

  const interactive = state === 'open';

  return (
    <div
      data-side={side}
      onClick={(event) => {
        if (!interactive) return;
        // A reader highlighting a phrase to compare it is not voting.
        if (typeof window !== 'undefined' && window.getSelection()?.isCollapsed === false) return;
        if ((event.target as HTMLElement).closest('button, a')) return;
        onPick();
      }}
      className={`flex-1 border-2 bg-paper transition-colors duration-150 motion-reduce:transition-none ${
        state === 'picked'
          ? 'border-paprika bg-paper-tint'
          : state === 'passed'
            ? 'border-hairline opacity-70'
            : state === 'locked'
              ? 'border-hairline'
              : 'cursor-pointer border-hairline hover:border-ink'
      }`}
    >
      <div className="flex items-baseline justify-between gap-3 border-b border-hairline px-5 py-3">
        <h3 className="font-display text-lg font-semibold">
          {revealedName ? revealedName : label}
        </h3>
        <span className="tabular text-xs text-ink-soft">{proposal.words} words</span>
      </div>

      <div className="px-5 py-4">
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{proposal.body}</p>
      </div>

      {proposal.sensory && (
        <div className="border-t border-hairline px-5 py-4">
          <h4 className="text-xs uppercase tracking-[0.18em] text-ink-soft">
            Predicted sensory card
          </h4>
          {/*
            Gate 5 requires participants to understand that the card PREDICTS
            rather than measures. Saying so once at the top of the page is not
            enough — the reader is looking at this list when the thought occurs.
          */}
          <p className="mt-1 text-xs text-ink-soft">
            Written before anyone cooked it. A prediction, not a measurement.
          </p>
          <dl className="mt-3 space-y-2 text-sm">
            {SENSORY_ROWS.map(([key, heading]) => (
              <div key={key} className="grid grid-cols-[9.5rem_1fr] gap-x-3 gap-y-0.5 max-sm:grid-cols-1">
                <dt className="text-xs uppercase tracking-wider text-ink-soft">{heading}</dt>
                <dd className="leading-snug">{proposal.sensory![key]}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {proposal.timeline && proposal.timeline.length > 0 && (
        <div className="border-t border-hairline px-5 py-4">
          <h4 className="text-xs uppercase tracking-[0.18em] text-ink-soft">
            Plan, counting down to service
          </h4>
          <ol className="mt-3 space-y-1.5 text-sm">
            {proposal.timeline.map((step, i) => (
              <li key={`${step.at}-${i}`} className="grid grid-cols-[4.5rem_1fr] gap-3">
                <span className="tabular text-ink-soft">{step.at}</span>
                <span className="leading-snug">{step.action}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div ref={foot} aria-hidden className="h-px" />
    </div>
  );
}
