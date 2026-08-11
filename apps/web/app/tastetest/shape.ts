import type { SensoryCard, TimelineStep } from './fixtures/types';

/**
 * The wire shape between the server flight builder and the client.
 *
 * It lives in its own module - rather than beside the builder in `flight.ts`  - 
 * because `flight.ts` is `import 'server-only'` and holds the key material and
 * the unblinded author ids. A client component that needs these types must not
 * be able to reach that module even accidentally through a type import that a
 * bundler decides to keep.
 *
 * Nothing here names a model. That is the invariant: if an author id could be
 * expressed in this file, it could be sent to the browser before the reveal.
 */

export interface PublicSide {
  body: string;
  words: number;
  sensory?: SensoryCard;
  timeline?: TimelineStep[];
}

export interface PublicRound {
  round: number;
  itemId: string;
  task: string;
  judgingQuestion: string;
  /** Bounded post-vote reasons, offered only after the primary vote locks. */
  reasons: readonly string[];
  left: PublicSide;
  right: PublicSide;
}

export interface BuiltFlight {
  /** Sealed. Opaque to the client by construction. */
  token: string;
  track: string;
  rounds: PublicRound[];
}

/** Returned only by `revealAction`, only once every round has been recorded. */
export interface RoundIdentity {
  round: number;
  left: string;
  right: string;
  identical: boolean;
}
