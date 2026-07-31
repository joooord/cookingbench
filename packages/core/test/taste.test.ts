import { describe, expect, it } from 'vitest';
import { computeTasteRatings, headToHead, type TasteVoteRecord } from '../src/taste.js';
import {
  abuseSignals,
  admitTasteBallots,
  analyseTaste,
  assertTasteClaimLanguage,
  ballotObservation,
  consistencyControl,
  identicalAnswerControl,
  lengthEffect,
  positionEffect,
  TASTE_MEASUREMENT_CLAIM,
  TASTE_PUBLICATION_THRESHOLDS,
  tasteChoiceCounts,
  tasteComparisonGraph,
  tasteWordCount,
  withinTasteWordBudget,
  type TasteChoice,
  type TasteFlightBallot,
  type TasteTrack,
} from '../src/taste.js';

function vote(
  model_a: string,
  model_b: string,
  winner: 'a' | 'b' | 'tie',
): TasteVoteRecord {
  return { run_id: 'test', question_id: 'q-001', model_a, model_b, winner };
}

describe('computeTasteRatings', () => {
  it('orders a transitive triangle correctly', () => {
    const votes = [
      ...Array.from({ length: 6 }, () => vote('alpha', 'beta', 'a')),
      ...Array.from({ length: 6 }, () => vote('beta', 'gamma', 'a')),
      ...Array.from({ length: 6 }, () => vote('alpha', 'gamma', 'a')),
    ];
    const ratings = computeTasteRatings(votes);
    expect(ratings.map((r) => r.modelId)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('corrects for opponent strength where raw win% does not', () => {
    // A ladder strong > mid > weak anchors the scale. "bully" wins 90% but
    // only ever against weak; "contender" wins 70% against strong. Raw win%
    // ranks bully over contender — Bradley-Terry must not.
    const votes = [
      ...Array.from({ length: 8 }, () => vote('strong', 'mid', 'a')),
      ...Array.from({ length: 2 }, () => vote('strong', 'mid', 'b')),
      ...Array.from({ length: 8 }, () => vote('mid', 'weak', 'a')),
      ...Array.from({ length: 2 }, () => vote('mid', 'weak', 'b')),
      ...Array.from({ length: 9 }, () => vote('bully', 'weak', 'a')),
      ...Array.from({ length: 1 }, () => vote('bully', 'weak', 'b')),
      ...Array.from({ length: 7 }, () => vote('contender', 'strong', 'a')),
      ...Array.from({ length: 3 }, () => vote('contender', 'strong', 'b')),
    ];
    const ratings = computeTasteRatings(votes);
    const byId = new Map(ratings.map((r) => [r.modelId, r]));
    expect(byId.get('bully')!.winRate).toBe(90);
    expect(byId.get('contender')!.winRate).toBe(70);
    expect(byId.get('contender')!.rating).toBeGreaterThan(byId.get('bully')!.rating);
  });

  it('counts ties as half a win in both rating and winRate', () => {
    const votes = Array.from({ length: 10 }, () => vote('x', 'y', 'tie'));
    const ratings = computeTasteRatings(votes);
    expect(ratings[0]!.winRate).toBe(50);
    expect(ratings[1]!.winRate).toBe(50);
    expect(Math.abs(ratings[0]!.rating - ratings[1]!.rating)).toBeLessThan(1e-6);
    expect(ratings[0]!.ties).toBe(10);
  });

  it('is deterministic, including bootstrap CIs', () => {
    const votes = [
      ...Array.from({ length: 5 }, () => vote('x', 'y', 'a')),
      ...Array.from({ length: 3 }, () => vote('x', 'y', 'b')),
    ];
    const a = computeTasteRatings(votes, { bootstrap: 50 });
    const b = computeTasteRatings(votes, { bootstrap: 50 });
    expect(a).toEqual(b);
    expect(a[0]!.ci95).toBeDefined();
  });

  it('handles an empty vote list', () => {
    expect(computeTasteRatings([])).toEqual([]);
  });

  it('keeps an undefeated model finite (phantom prior)', () => {
    const votes = Array.from({ length: 20 }, () => vote('unbeaten', 'punchbag', 'a'));
    const ratings = computeTasteRatings(votes);
    expect(Number.isFinite(ratings[0]!.rating)).toBe(true);
    expect(ratings[0]!.modelId).toBe('unbeaten');
  });
});

describe('headToHead', () => {
  it('mirrors records from both perspectives', () => {
    const votes = [vote('x', 'y', 'a'), vote('y', 'x', 'a'), vote('x', 'y', 'tie')];
    const h2h = headToHead(votes);
    expect(h2h.get('x::y')).toEqual({ wins: 1, losses: 1, ties: 1 });
    expect(h2h.get('y::x')).toEqual({ wins: 1, losses: 1, ties: 1 });
  });
});

/* ========================================================================== */
/* Stage 5 — the v3 Tasting Flight ballot                                     */
/* ========================================================================== */

/** A ballot that passes every admissibility check, so a test can break one. */
function ballot(over: Partial<TasteFlightBallot> = {}): TasteFlightBallot {
  return {
    flightId: 'flight-1',
    round: 1,
    track: 'flavour',
    itemId: 'taste-001',
    modelLeft: 'left-model',
    modelRight: 'right-model',
    choice: 'left',
    bothSeen: true,
    dwellMs: 9_000,
    leftWords: 140,
    rightWords: 141,
    cohort: 'public',
    controlKind: 'none',
    sessionId: 'session-1',
    evidenceClass: 'development',
    ...over,
  };
}

describe('admitTasteBallots', () => {
  it('admits a well-formed ballot', () => {
    const { admitted, rejected } = admitTasteBallots([ballot()]);
    expect(admitted).toHaveLength(1);
    expect(rejected).toHaveLength(0);
  });

  it.each([
    ['not-both-seen', { bothSeen: false }],
    ['dwell-missing', { dwellMs: null }],
    ['dwell-too-short', { dwellMs: 400 }],
    ['dwell-too-long', { dwellMs: 1_900_000 }],
    ['word-count-missing', { leftWords: null }],
    ['word-count-out-of-budget', { rightWords: 400 }],
    ['word-count-out-of-budget', { leftWords: 12 }],
    ['round-out-of-range', { round: 6 }],
    ['round-out-of-range', { round: 0 }],
    ['round-out-of-range', { round: 1.5 }],
    ['same-model-both-sides', { modelRight: 'left-model' }],
    ['missing-model-id', { modelLeft: '' }],
    ['control-ballot', { controlKind: 'identical' as const }],
    ['unknown-track', { track: 'dessert' as unknown as TasteTrack }],
    ['unknown-choice', { choice: 'maybe' as unknown as TasteChoice }],
  ])('refuses %s', (reason, patch) => {
    const { admitted, rejected } = admitTasteBallots([
      ballot(patch as Partial<TasteFlightBallot>),
    ]);
    expect(admitted).toHaveLength(0);
    expect(rejected[0]!.reason).toBe(reason);
  });

  it('refuses absence, not just bad values — a missing dwell is not a fast reader', () => {
    const { rejected } = admitTasteBallots([
      ballot({ dwellMs: undefined }),
      ballot({ leftWords: undefined, rightWords: undefined }),
    ]);
    expect(rejected.map((r) => r.reason)).toEqual(['dwell-missing', 'word-count-missing']);
  });

  it('counts every refusal rather than dropping it silently', () => {
    const { rejectedByReason } = admitTasteBallots([
      ballot({ bothSeen: false }),
      ballot({ bothSeen: false }),
      ballot({ dwellMs: 10 }),
    ]);
    expect(rejectedByReason).toEqual([
      { reason: 'not-both-seen', count: 2 },
      { reason: 'dwell-too-short', count: 1 },
    ]);
  });

  it('never lets a cohort leak into another cohort’s analysis', () => {
    const { admitted, rejected } = admitTasteBallots(
      [ballot({ cohort: 'professional' }), ballot()],
      { cohort: 'public' },
    );
    expect(admitted).toHaveLength(1);
    expect(rejected[0]!.reason).toBe('cohort-mismatch');
  });
});

describe('ballotObservation', () => {
  it('reads the same regardless of which side a model was shown on', () => {
    const leftWin = ballotObservation(
      ballot({ modelLeft: 'alpha', modelRight: 'beta', choice: 'left' }),
    );
    const rightWin = ballotObservation(
      ballot({ modelLeft: 'beta', modelRight: 'alpha', choice: 'right' }),
    );
    expect(leftWin).toMatchObject({ a: 'alpha', b: 'beta', outcome: 'a' });
    expect(rightWin).toMatchObject({ a: 'alpha', b: 'beta', outcome: 'a' });
  });

  it('keeps "neither works" out of the tie outcome', () => {
    expect(ballotObservation(ballot({ choice: 'neither' })).outcome).toBe('both_unacceptable');
    expect(ballotObservation(ballot({ choice: 'equal' })).outcome).toBe('equal');
    expect(ballotObservation(ballot({ choice: 'abstain' })).outcome).toBe('abstain');
  });

  it('clusters by item by default and by flight on request', () => {
    const b = ballot({ itemId: 'taste-009', flightId: 'flight-77' });
    expect(ballotObservation(b).cluster).toBe('taste-009');
    expect(ballotObservation(b, 'flight').cluster).toBe('flight-77');
  });
});

describe('positionEffect', () => {
  it('catches a pure left-side bias that the ratings cannot see', () => {
    // Left always wins, but each model sits left half the time. Canonicalised,
    // the two models are exactly level — so the ONLY place this shows up is
    // here. A build that dropped the position diagnostic would report a clean
    // tie and never mention that nobody read the right-hand card.
    const ballots: TasteFlightBallot[] = [];
    for (let i = 0; i < 40; i++) {
      const swap = i % 2 === 0;
      ballots.push(
        ballot({
          flightId: `flight-${i}`,
          modelLeft: swap ? 'alpha' : 'beta',
          modelRight: swap ? 'beta' : 'alpha',
          choice: 'left',
        }),
      );
    }
    const effect = positionEffect(ballots);
    expect(effect.share).toBe(1);
    expect(effect.detected).toBe(true);
    expect(effect.ci95![0]).toBeGreaterThan(0.5);
  });

  it('refuses an interval rather than inventing one from two flights', () => {
    const effect = positionEffect([
      ballot({ flightId: 'f1' }),
      ballot({ flightId: 'f2', choice: 'right' }),
    ]);
    expect(effect.ci95).toBeNull();
    expect(effect.detected).toBe(false);
    expect(effect.refusal).toMatch(/at least 3/);
  });
});

describe('lengthEffect', () => {
  it('ignores equal-length pairs instead of diluting the estimate with them', () => {
    // 6 pairs differ in length and the longer side always wins; 60 identical
    // -length pairs surround them. Counting the latter as half would drag the
    // share to ~0.53 and hide a total length effect.
    const ballots: TasteFlightBallot[] = [];
    for (let i = 0; i < 6; i++) {
      ballots.push(
        ballot({ flightId: `long-${i}`, leftWords: 158, rightWords: 122, choice: 'left' }),
      );
    }
    for (let i = 0; i < 60; i++) {
      ballots.push(
        ballot({
          flightId: `even-${i}`,
          leftWords: 140,
          rightWords: 140,
          choice: i % 2 === 0 ? 'left' : 'right',
        }),
      );
    }
    const effect = lengthEffect(ballots);
    expect(effect.n).toBe(6);
    expect(effect.share).toBe(1);
  });
});

describe('controls', () => {
  it('fails a session that made a decisive choice on identical text', () => {
    const result = identicalAnswerControl([
      ballot({ controlKind: 'identical', sessionId: 's-clicker', choice: 'left' }),
      ballot({ controlKind: 'identical', sessionId: 's-honest', choice: 'equal' }),
      ballot({ controlKind: 'identical', sessionId: 's-strict', choice: 'neither' }),
      ballot({ controlKind: 'identical', sessionId: 's-shrug', choice: 'abstain' }),
    ]);
    expect(result.n).toBe(4);
    expect(result.pass).toBe(0.75);
    expect(result.failingSessions).toEqual(['s-clicker']);
  });

  it('reports a refusal rather than a passing score when no control was served', () => {
    const result = identicalAnswerControl([ballot()]);
    expect(result.pass).toBeNull();
    expect(result.refusal).toMatch(/no identical-answer controls/);
  });

  it('scores consistency on model identity, not on which side was tapped', () => {
    const stable = [
      ballot({ sessionId: 's1', modelLeft: 'alpha', modelRight: 'beta', choice: 'left' }),
      ballot({ sessionId: 's1', modelLeft: 'beta', modelRight: 'alpha', choice: 'right' }),
    ];
    const flipped = [
      ballot({ sessionId: 's2', modelLeft: 'alpha', modelRight: 'beta', choice: 'left' }),
      ballot({ sessionId: 's2', modelLeft: 'beta', modelRight: 'alpha', choice: 'left' }),
    ];
    expect(consistencyControl(stable).pass).toBe(1);
    expect(consistencyControl(flipped).pass).toBe(0);
    expect(consistencyControl(flipped).failingSessions).toEqual(['s2']);
  });

  it('does not treat two different sessions as one rater', () => {
    const result = consistencyControl([
      ballot({ sessionId: 's1', choice: 'left' }),
      ballot({ sessionId: 's2', choice: 'right' }),
    ]);
    expect(result.n).toBe(0);
    expect(result.refusal).toMatch(/no repeated pair/);
  });
});

describe('abuseSignals', () => {
  it('flags straight-lining but not a genuine run of agreement below the threshold', () => {
    const long = Array.from({ length: 6 }, (_, i) =>
      ballot({ sessionId: 's-robot', flightId: `f${i}`, choice: 'left' }),
    );
    const short = Array.from({ length: 3 }, (_, i) =>
      ballot({ sessionId: 's-human', flightId: `g${i}`, choice: 'left' }),
    );
    const signals = abuseSignals([...long, ...short]);
    expect(signals.straightLining).toEqual(['s-robot']);
    expect(signals.suspect).toContain('s-robot');
    expect(signals.suspect).not.toContain('s-human');
  });
});

describe('analyseTaste', () => {
  /**
   * A connected, well-spread bank: three models, three items, many flights,
   * alpha > beta > gamma. Sides alternate so the position effect is zero by
   * construction, one round in five is a tie so ν is identified, and the
   * favourite loses one round in five so nobody is undefeated — an undefeated
   * model makes `fitDavidson` iterate for longer the more data it is given
   * (see the note in the disconnected-graph test).
   */
  function bank(track: TasteTrack, flights: number): TasteFlightBallot[] {
    const pairs: Array<[string, string]> = [
      ['alpha', 'beta'],
      ['beta', 'gamma'],
      ['alpha', 'gamma'],
    ];
    const out: TasteFlightBallot[] = [];
    for (let f = 0; f < flights; f++) {
      for (let r = 0; r < pairs.length; r++) {
        const [strong, weak] = pairs[r]!;
        const swap = (f + r) % 2 === 0;
        const mod = (f + r) % 5;
        const favouriteWon = mod > 1;
        const choice: TasteChoice =
          mod === 0 ? 'equal' : (swap === favouriteWon ? 'left' : 'right');
        out.push(
          ballot({
            flightId: `${track}-f${f}`,
            round: r + 1,
            track,
            itemId: `${track}-item-${r}`,
            modelLeft: swap ? strong! : weak!,
            modelRight: swap ? weak! : strong!,
            choice,
            sessionId: `${track}-s${f}`,
          }),
        );
      }
    }
    return out;
  }

  it('recovers the true order on a clean bank', () => {
    const analysis = analyseTaste(bank('flavour', 30), { cohort: 'public' });
    const axis = analysis.axes.find((a) => a.track === 'flavour')!;
    expect(axis.fit!.ratings.map((r) => r.modelId)).toEqual(['alpha', 'beta', 'gamma']);
    expect(axis.fit!.nu).toBeGreaterThan(0);
  });

  it('still refuses to publish an order on a bank with no measurable flaw', () => {
    // The whole point of the gate. The graph is connected, both side effects
    // are measured and neutral, every model holds an interval — and the answer
    // is still no, because M5.6's counts have not been through Stage 4
    // simulation. No amount of data can clear this blocker; only a reviewed
    // edit to TASTE_PUBLICATION_THRESHOLDS.status can.
    expect(TASTE_PUBLICATION_THRESHOLDS.status).toBe('requires-preregistration');
    const analysis = analyseTaste(bank('flavour', 40), { cohort: 'public' });
    const axis = analysis.axes[0]!;
    expect(axis.graph.connected).toBe(true);
    expect(axis.intervals).not.toBeNull();
    expect(analysis.position.detected).toBe(false);
    expect(axis.blockers).toContain(
      'Taste publication thresholds are provisional — M5.6 requires them to be set by Stage 4 simulation',
    );
    expect(axis.orderPublishable).toBe(false);
    expect(analysis.overallPublishable).toBe(false);
  });

  it('refuses an axis whose comparison graph is in two pieces', () => {
    // The phantom opponent connects everything to everything in a naive fit,
    // so this is exactly the failure that looks like a working rating.
    //
    // Note on bank sizes throughout this block: `fitDavidson` needs iterations
    // roughly proportional to the observation count when one model is
    // undefeated, and refuses past 10,000. Banks here stay small and two-sided
    // for that reason; `fitAxis` turns the refusal into a blocker rather than
    // an exception, which is the behaviour the empty-bank test pins down.
    const split: TasteFlightBallot[] = [];
    for (let f = 0; f < 12; f++) {
      split.push(
        ballot({
          flightId: `f${f}`,
          itemId: 'i-1',
          modelLeft: 'alpha',
          modelRight: 'beta',
          choice: 'left',
        }),
        ballot({
          flightId: `f${f}`,
          round: 2,
          itemId: 'i-2',
          modelLeft: 'delta',
          modelRight: 'epsilon',
          choice: 'right',
        }),
      );
    }
    const axis = analyseTaste(split, { cohort: 'public' }).axes[0]!;
    expect(axis.graph.connected).toBe(false);
    expect(axis.fit).toBeNull();
    expect(axis.refusal).toMatch(/disconnected components/);
    expect(axis.orderPublishable).toBe(false);
  });

  it('separates the axes and refuses the overall while any axis is unpublishable', () => {
    const analysis = analyseTaste(
      [...bank('flavour', 20), ...bank('rescue', 20)],
      { cohort: 'public' },
    );
    expect(analysis.axes.map((a) => a.track)).toEqual(['rescue', 'flavour']);
    expect(analysis.overall!.track).toBe('overall');
    expect(analysis.overallBlockers.join(' ')).toMatch(/axis ratings must stand first/);
  });

  it('never pools cohorts', () => {
    const pro = bank('flavour', 10).map((b) => ({ ...b, cohort: 'professional' as const }));
    const publicAnalysis = analyseTaste([...bank('flavour', 10), ...pro], { cohort: 'public' });
    const proAnalysis = analyseTaste([...bank('flavour', 10), ...pro], { cohort: 'professional' });
    expect(publicAnalysis.axes[0]!.ballots).toBe(30);
    expect(proAnalysis.axes[0]!.ballots).toBe(30);
    expect(publicAnalysis.cohort).toBe('public');
  });

  it('does not let "neither works" buy gamma a place in the ratings', () => {
    // Every comparison gamma appears in is rejected outright. Folded into
    // `equal` — the collapse M5.3 forbids — that would be half a win apiece and
    // gamma would sit mid-table on evidence that nobody would serve it.
    // Treated correctly, gamma has no valid comparison at all, the graph falls
    // into two pieces, and the axis REFUSES rather than rating it.
    const rows = bank('flavour', 24).map((b) =>
      b.modelLeft === 'gamma' || b.modelRight === 'gamma'
        ? { ...b, choice: 'neither' as const }
        : b,
    );
    const axis = analyseTaste(rows, { cohort: 'public' }).axes[0]!;
    expect(axis.graph.isolated).toContain('gamma');
    expect(axis.fit).toBeNull();
    expect(axis.orderPublishable).toBe(false);
  });

  it('reports a rejection rate beside the rating, never inside it', () => {
    // Same idea, but gamma keeps enough decisive rounds to stay in the graph.
    const rows = bank('flavour', 24).map((b, i) =>
      (b.modelLeft === 'gamma' || b.modelRight === 'gamma') && i % 2 === 0
        ? { ...b, choice: 'neither' as const }
        : b,
    );
    const axis = analyseTaste(rows, { cohort: 'public' }).axes[0]!;
    const gamma = axis.fit!.ratings.find((r) => r.modelId === 'gamma')!;
    expect(gamma.bothUnacceptable).toBeGreaterThan(0);
    expect(axis.rejection[0]!.modelId).toBe('gamma');
    expect(axis.rejection[0]!.rate).toBeGreaterThan(0);

    // The counterfactual is the assertion that matters: run the same ballots
    // with every rejection rewritten as `equal` and gamma climbs. That gap is
    // exactly the credit the forbidden collapse would hand a model nobody
    // would serve, and it must not be in the real fit.
    const collapsed = analyseTaste(
      rows.map((b) => (b.choice === 'neither' ? { ...b, choice: 'equal' as const } : b)),
      { cohort: 'public' },
    ).axes[0]!;
    const gammaCollapsed = collapsed.fit!.ratings.find((r) => r.modelId === 'gamma')!;
    expect(gammaCollapsed.rating).toBeGreaterThan(gamma.rating);
    expect(gammaCollapsed.bothUnacceptable).toBe(0);
  });

  it('reports a refusal instead of throwing when there is nothing to fit', () => {
    const analysis = analyseTaste([], { cohort: 'public' });
    expect(analysis.axes).toEqual([]);
    expect(analysis.overall).toBeNull();
    expect(analysis.overallPublishable).toBe(false);
    expect(analysis.overallBlockers).toContain('no axis has any admissible ballot');
  });

  it('excludes suspect sessions only when asked, and says so either way', () => {
    const clean = bank('flavour', 12);
    const robot = Array.from({ length: 8 }, (_, i) =>
      ballot({
        sessionId: 's-robot',
        flightId: `robot-${i}`,
        itemId: 'flavour-item-0',
        modelLeft: 'gamma',
        modelRight: 'alpha',
        choice: 'left',
      }),
    );
    const kept = analyseTaste([...clean, ...robot], { cohort: 'public' });
    const dropped = analyseTaste([...clean, ...robot], {
      cohort: 'public',
      excludeSuspectSessions: true,
    });
    expect(kept.abuse.straightLining).toContain('s-robot');
    expect(dropped.axes[0]!.ballots).toBe(kept.axes[0]!.ballots - 8);
  });
});

describe('the measurement claim', () => {
  it('states what Taste measures and what it does not', () => {
    expect(TASTE_MEASUREMENT_CLAIM).toMatch(/would rather cook, serve or eat after reading it/);
    expect(() => assertTasteClaimLanguage(TASTE_MEASUREMENT_CLAIM)).not.toThrow();
  });

  it('refuses copy that claims cooked flavour', () => {
    expect(() => assertTasteClaimLanguage('The tastiest model of 2026')).toThrow(/cooked flavour/);
    expect(() => assertTasteClaimLanguage('This one actually tastes better')).toThrow();
  });
});

describe('the word budget', () => {
  it('counts words and holds both ends of the budget', () => {
    expect(tasteWordCount('  one   two\nthree ')).toBe(3);
    expect(tasteWordCount('   ')).toBe(0);
    expect(withinTasteWordBudget(Array(119).fill('word').join(' '))).toBe(false);
    expect(withinTasteWordBudget(Array(120).fill('word').join(' '))).toBe(true);
    expect(withinTasteWordBudget(Array(160).fill('word').join(' '))).toBe(true);
    expect(withinTasteWordBudget(Array(161).fill('word').join(' '))).toBe(false);
  });
});

describe('read-only summaries', () => {
  it('counts every outcome separately and drops nothing into a neighbour', () => {
    const counts = tasteChoiceCounts([
      ballot({ choice: 'left' }),
      ballot({ choice: 'right' }),
      ballot({ choice: 'equal' }),
      ballot({ choice: 'neither' }),
      ballot({ choice: 'neither' }),
      ballot({ choice: 'abstain' }),
      ballot({ choice: 'sideways' as unknown as TasteChoice }),
    ]);
    expect(counts).toEqual({ left: 1, right: 1, equal: 1, neither: 2, abstain: 1 });
    // The unrecognised row is counted nowhere, so the totals visibly fall short
    // of the seven rows that went in.
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(6);
  });

  it('does not let a rejection or an abstention connect the graph', () => {
    // alpha/beta are genuinely compared; gamma/delta only ever produce
    // no-contest and missing outcomes. A graph that counted those as edges
    // would report one component and invite an ordering across all four.
    const graph = tasteComparisonGraph([
      ballot({ modelLeft: 'alpha', modelRight: 'beta', choice: 'left' }),
      ballot({ modelLeft: 'gamma', modelRight: 'delta', choice: 'neither' }),
      ballot({ modelLeft: 'gamma', modelRight: 'delta', choice: 'abstain' }),
    ]);
    expect(graph.connected).toBe(false);
    expect(graph.isolated.sort()).toEqual(['delta', 'gamma']);
    expect(graph.edges).toBe(1);
  });

  it('survives a corrupt row instead of throwing on the page that renders it', () => {
    // comparisonGraph throws on a self-comparison. A public board reading a
    // table it does not fully control must not 500 because one row is odd.
    const graph = tasteComparisonGraph([
      ballot({ modelLeft: 'alpha', modelRight: 'beta', choice: 'left' }),
      ballot({ modelLeft: 'same', modelRight: 'same', choice: 'left' }),
      ballot({ modelLeft: '', modelRight: 'beta', choice: 'left' }),
    ]);
    expect(graph.models).toEqual(['alpha', 'beta']);
  });
});
