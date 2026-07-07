import { describe, expect, it } from 'vitest';
import {
  computeTasteRatings,
  headToHead,
  mulberry32,
  type PanelTasteVote,
  type TasteVoteRecord,
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

describe('PanelTasteVote', () => {
  it('feeds computeTasteRatings unchanged (extra fields ignored, seat-ties counted)', () => {
    // Same structure as human votes plus judge_model; a seat flip-flop is a tie.
    const votes: PanelTasteVote[] = [
      ...Array.from({ length: 6 }, () => ({
        run_id: 'r',
        question_id: 'q',
        model_a: 'alpha',
        model_b: 'beta',
        winner: 'a' as const,
        judge_model: 'j/one',
        position_consistent: true,
      })),
      ...Array.from({ length: 2 }, () => ({
        run_id: 'r',
        question_id: 'q',
        model_a: 'alpha',
        model_b: 'beta',
        winner: 'tie' as const,
        judge_model: 'j/two',
        position_consistent: false,
      })),
    ];
    const ratings = computeTasteRatings(votes);
    expect(ratings.map((r) => r.modelId)).toEqual(['alpha', 'beta']);
    const alpha = ratings.find((r) => r.modelId === 'alpha')!;
    expect(alpha.battles).toBe(8);
    expect(alpha.ties).toBe(2);
    expect(alpha.wins).toBe(6);
  });
});

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
});
