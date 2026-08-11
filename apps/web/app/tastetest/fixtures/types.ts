import type { TasteTrack } from '@cookingbench/core';

/**
 * The authored fixture bank behind the Tasting Flight.
 *
 * WP-7: "Build against synthetic and archived fixtures until measurement gates
 * pass." Nothing here is a model output. Every proposal is written by hand, and
 * every author id is a `fixture/…` voice that exists only in this bank - a real
 * model id would put an invented model contact into the permanent ballot
 * record, which is precisely what the evidence firewall is for. Migration 0008
 * pins every anonymous ballot to `evidence_class = 'development'` so that even
 * a mistake here cannot become rank-bearing.
 */

/**
 * M5.2's matched sensory card. Every field is required for a flavour round and
 * both sides render the same seven rows in the same order - a card with a
 * missing row on one side is a visible asymmetry and the loader refuses it.
 *
 * The card is a PREDICTION about how a dish would eat. It is written before
 * anyone cooks anything and Gate 5 requires participants to understand that;
 * `SensoryCard` is rendered under a heading that says so.
 */
export interface SensoryCard {
  identity: string;
  aroma: string;
  balance: string;
  /** Texture and temperature. */
  texture: string;
  /** Bite progression and finish. */
  progression: string;
  /** The likely failure, and the correction. */
  failure: string;
  /** What the proposal deliberately leaves out. */
  restraint: string;
}

/** One row of the matched KitchenPlan/timeline view used by rescue rounds. */
export interface TimelineStep {
  /** Clock or offset, e.g. "T−40". Identical scale on both sides. */
  at: string;
  action: string;
}

export interface FixtureProposal {
  /** A `fixture/…` voice. Never a model id. */
  authorId: string;
  /** 120–160 words. Enforced by the loader, not by good intentions. */
  body: string;
  sensory?: SensoryCard;
  timeline?: TimelineStep[];
}

export interface FixtureItem {
  id: string;
  track: TasteTrack;
  /** The short task the reader is judging against. */
  task: string;
  /** One task-specific judging question (M5.2). */
  judgingQuestion: string;
  /**
   * Two or three bounded reasons offered AFTER the primary vote locks (M5.3).
   * They must not read as criteria for the vote itself, or they become the
   * rubric rather than a follow-up.
   */
  reasons: readonly string[];
  /**
   * M5.4's safety and hard-constraint prefilter. For authored fixtures the
   * filter is a recorded human review; the loader refuses an item that does not
   * carry one, so "nobody checked" can never look the same as "checked and
   * fine".
   */
  safety: { reviewed: true; reviewer: string; note?: string };
  proposals: FixtureProposal[];
}
