import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import {
  TASTE_FLIGHT_ROUNDS,
  TASTE_TRACKS,
  tasteWordCount,
  withinTasteWordBudget,
  type TasteChoice,
  type TasteControlKind,
  type TasteTrack,
} from '@cookingbench/core';
import { fixtureBank, type FixtureItem, type FixtureProposal } from './fixtures';
import type { BuiltFlight, PublicRound, PublicSide, RoundIdentity } from './shape';

export type { BuiltFlight, PublicRound, PublicSide, RoundIdentity } from './shape';

/**
 * M5.4 — the flight is built, sealed and opened here, and nowhere else.
 *
 * The single hard requirement this file exists to meet is that **model identity
 * is unavailable to the client before a recorded decision**. Signing alone does
 * not achieve that: a signed token is still readable, and "hidden" identities
 * sitting in base64 in the page source would be a blind test in name only. So
 * the flight is *sealed* — AES-256-GCM — and the client receives an opaque
 * string plus the proposal text, with no author ids anywhere in the payload.
 *
 * The seal also carries expiry and one nonce per round, which is what makes the
 * ballot single-use and time-bounded without any server-side session store:
 * the nonce is unique-indexed in the database, so a replay fails at the last
 * possible moment rather than the first, which is the only place we can enforce
 * it across serverless instances.
 */

/**
 * Server-only, asserted rather than declared.
 *
 * The `server-only` package is not a dependency of this app, so the usual
 * `import 'server-only'` marker is unavailable. This module holds key material
 * and the unblinded author ids, and a bundler that pulled it into a client
 * chunk would ship both — so it refuses to initialise in a browser instead.
 * `node:crypto` would fail to resolve there anyway; this makes the reason
 * legible rather than leaving it to a module-resolution error.
 */
if (typeof window !== 'undefined') {
  throw new Error('tastetest/flight.ts is server-only: it holds the ballot key and the unblinded author ids');
}

/* -------------------------------------------------------------------------- */
/* Key material                                                               */
/* -------------------------------------------------------------------------- */

export class FlightUnavailableError extends Error {
  constructor(
    message: string,
    /** Safe to render to a visitor. Never contains key material or ids. */
    readonly publicReason: string,
  ) {
    super(message);
    this.name = 'FlightUnavailableError';
  }
}

/**
 * The site otherwise reads no environment variables at all, and that is a
 * deliberate property worth protecting — but a sealed ballot needs a key and
 * there is nowhere else to put one.
 *
 * There is no development fallback. A hardcoded default key would mean every
 * deployment shares it, the seal is decryptable by anyone with the repository,
 * and the blinding is decorative. Absent configuration the Taste Test refuses
 * to serve; a visitor sees an honest "unavailable" panel and nothing is
 * recorded. That is the fail-closed reading and it is the whole point.
 */
let cachedKey: { secret: string; key: Buffer } | null = null;

function ballotKey(): Buffer {
  const secret = process.env.TASTE_BALLOT_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new FlightUnavailableError(
      'TASTE_BALLOT_SECRET is missing or shorter than 32 characters',
      'The Taste Test is not configured on this deployment.',
    );
  }
  // scrypt is deliberately expensive — that is the point of it for a password,
  // and entirely wrong to pay per request. Casting one ballot opens the seal
  // and mints a receipt, so an uncached derivation would be two full scrypts on
  // the hot path; a 400-flight loop took minutes before this cache existed.
  // Keyed on the secret so a rotated value derives afresh rather than silently
  // continuing to use the old key.
  if (cachedKey?.secret === secret) return cachedKey.key;
  const key = scryptSync(secret, 'cookingbench:taste:seal:v1', 32);
  cachedKey = { secret, key };
  return key;
}

/* -------------------------------------------------------------------------- */
/* The sealed payload                                                         */
/* -------------------------------------------------------------------------- */

/** How long a flight stays castable. Generous: a flight is ~3 minutes. */
const FLIGHT_TTL_MS = 45 * 60 * 1000;

interface SealedRound {
  round: number;
  itemId: string;
  /** Author ids, as displayed. Never leaves the server before the reveal. */
  leftId: string;
  rightId: string;
  nonce: string;
  leftWords: number;
  rightWords: number;
  controlKind: TasteControlKind;
  /** How many post-vote reasons this round offers, so an index can be checked. */
  reasonCount: number;
}

interface SealedFlight {
  v: 1;
  flightId: string;
  track: TasteTrack;
  /** Epoch milliseconds. */
  exp: number;
  rounds: SealedRound[];
}

export function sealFlight(flight: SealedFlight): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ballotKey(), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(flight), 'utf8'),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body].map((b) => b.toString('base64url')).join('.');
}

/**
 * Open a sealed flight, or return null.
 *
 * Every failure path — malformed, wrong key, tampered, expired, wrong version —
 * returns null rather than throwing or distinguishing itself, because the
 * distinction is only useful to someone probing the seal.
 */
export function openFlight(token: unknown): SealedFlight | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 20_000) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const [iv, tag, body] = parts.map((p) => Buffer.from(p, 'base64url'));
    if (!iv || !tag || !body || iv.length !== 12 || tag.length !== 16) return null;
    const decipher = createDecipheriv('aes-256-gcm', ballotKey(), iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(json) as SealedFlight;
    if (parsed?.v !== 1) return null;
    if (!Array.isArray(parsed.rounds) || parsed.rounds.length !== TASTE_FLIGHT_ROUNDS) return null;
    if (typeof parsed.exp !== 'number' || Date.now() > parsed.exp) return null;
    if (!(TASTE_TRACKS as readonly string[]).includes(parsed.track)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Receipts — the reveal must be earned                                       */
/* -------------------------------------------------------------------------- */

/**
 * A receipt proves a specific round of a specific flight was recorded with a
 * specific choice. The reveal endpoint demands one per round.
 *
 * Without this, a visitor could request the flight, skip voting entirely and
 * ask for the identities — and every subsequent round of that flight would be
 * unblinded. Gate 5 requires that identity be unavailable *before a recorded
 * decision*, and the recorded decision is the thing being proved here.
 */
export function mintReceipt(flightId: string, round: number, choice: TasteChoice): string {
  return createHmac('sha256', ballotKey())
    .update(`${flightId}|${round}|${choice}`)
    .digest('base64url');
}

function receiptValid(flightId: string, round: number, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0) return false;
  const offered = Buffer.from(presented, 'base64url');
  // The choice is not known here, so accept a receipt matching any of them —
  // the receipt proves *a* recorded decision, which is what the gate asks for.
  for (const choice of ['left', 'right', 'equal', 'neither', 'abstain'] as const) {
    const expected = Buffer.from(mintReceipt(flightId, round, choice), 'base64url');
    if (expected.length === offered.length && timingSafeEqual(expected, offered)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Seeded determinism                                                         */
/* -------------------------------------------------------------------------- */

/** mulberry32, the PRNG family the rest of the project seeds with. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Building a flight                                                          */
/* -------------------------------------------------------------------------- */

/** How often a flight carries an identical-answer control round (M5.6). */
const IDENTICAL_CONTROL_RATE = 0.2;

/**
 * Item-level admissibility. An item that fails any of these is not served, and
 * a track without five admissible items is refused outright rather than served
 * short — a four-round "five-round flight" is a silent protocol change.
 */
function admissibleItem(item: FixtureItem): string | null {
  // M5.4's safety and hard-constraint prefilter. An item with no recorded
  // review is refused, so "nobody looked at it" cannot present as "looked at
  // and fine" — the same fail-closed reading the calibration gate uses.
  if (item.safety?.reviewed !== true || !item.safety.reviewer) {
    return 'no recorded safety review';
  }
  if (item.reasons.length < 2 || item.reasons.length > 3) {
    // M5.3 bounds the post-vote reason to two or three choices plus skip. More
    // than that and it becomes a second questionnaire; fewer and it is a
    // leading question.
    return `${item.reasons.length} post-vote reasons, expected 2 or 3`;
  }
  if (item.proposals.length < 2) return 'fewer than two proposals';
  const authors = new Set(item.proposals.map((p) => p.authorId));
  if (authors.size !== item.proposals.length) return 'two proposals share an author';
  for (const p of item.proposals) {
    if (!withinTasteWordBudget(p.body)) {
      // The word budget IS the length control (M5.2). Serving an item outside
      // it would make length a live confound in the very data collected to
      // check that length is not a confound.
      return `${p.authorId} is ${tasteWordCount(p.body)} words, outside the 120–160 budget`;
    }
  }
  if (item.track === 'flavour' && item.proposals.some((p) => !p.sensory)) {
    return 'a flavour item is missing a matched sensory card';
  }
  return null;
}

export interface TrackAvailability {
  track: TasteTrack;
  available: boolean;
  /** Why not, in words a visitor can read. */
  reason?: string;
  items: number;
}

export function trackAvailability(): TrackAvailability[] {
  return TASTE_TRACKS.map((track) => {
    const items = (fixtureBank[track] ?? []).filter((i) => admissibleItem(i) === null);
    if (items.length < TASTE_FLIGHT_ROUNDS) {
      return {
        track,
        available: false,
        items: items.length,
        reason:
          items.length === 0
            ? 'No fixture rounds authored yet.'
            : `Only ${items.length} of ${TASTE_FLIGHT_ROUNDS} rounds authored.`,
      };
    }
    return { track, available: true, items: items.length };
  });
}

/**
 * Assign one author pair per round with **no author used twice in the flight**
 * (M5.4). This is a bipartite matching, not a shuffle, and a greedy pass
 * genuinely fails on the fixture bank's overlapping author sets — the last
 * round can be left with both of its authors already spent. So: seeded
 * randomised order, then backtracking, then refuse.
 *
 * Refusing matters more than it looks. Quietly permitting a repeat would put
 * one author in two rounds of the same flight, and every ballot in that flight
 * shares a reader — the session cluster then carries a duplicated model and the
 * clustered bootstrap under-counts its dependence.
 */
function assignPairs(
  items: readonly FixtureItem[],
  rand: () => number,
): Array<{ item: FixtureItem; left: FixtureProposal; right: FixtureProposal }> | null {
  const used = new Set<string>();
  const chosen: Array<{ item: FixtureItem; left: FixtureProposal; right: FixtureProposal }> = [];

  const recurse = (index: number): boolean => {
    if (index === items.length) return true;
    const item = items[index]!;
    const options: Array<[FixtureProposal, FixtureProposal]> = [];
    for (let i = 0; i < item.proposals.length; i++) {
      for (let j = i + 1; j < item.proposals.length; j++) {
        options.push([item.proposals[i]!, item.proposals[j]!]);
      }
    }
    for (const [x, y] of shuffled(options, rand)) {
      if (used.has(x.authorId) || used.has(y.authorId)) continue;
      used.add(x.authorId);
      used.add(y.authorId);
      // Side assignment is randomised here, per round, independently of which
      // author the matching happened to pick first. Without this the matching
      // order would systematically decide who sits on the left.
      const flip = rand() < 0.5;
      chosen.push({ item, left: flip ? y : x, right: flip ? x : y });
      if (recurse(index + 1)) return true;
      chosen.pop();
      used.delete(x.authorId);
      used.delete(y.authorId);
    }
    return false;
  };

  return recurse(0) ? chosen : null;
}

export function buildFlight(track: unknown, seed?: number): BuiltFlight {
  if (!(TASTE_TRACKS as readonly string[]).includes(track as string)) {
    throw new FlightUnavailableError(
      `unknown track ${JSON.stringify(track)}`,
      'That tasting track does not exist.',
    );
  }
  const chosenTrack = track as TasteTrack;
  const pool = (fixtureBank[chosenTrack] ?? []).filter((i) => admissibleItem(i) === null);
  if (pool.length < TASTE_FLIGHT_ROUNDS) {
    throw new FlightUnavailableError(
      `track ${chosenTrack} has ${pool.length} admissible items, needs ${TASTE_FLIGHT_ROUNDS}`,
      'This tasting track is not ready to serve yet.',
    );
  }

  const rand = prng(seed ?? (randomBytes(4).readUInt32BE(0) >>> 0));
  // No repeated question within a flight follows from taking five DISTINCT
  // items; the pool is de-duplicated by item id in the fixture loader.
  const items = shuffled(pool, rand).slice(0, TASTE_FLIGHT_ROUNDS);
  const pairs = assignPairs(items, rand);
  if (!pairs) {
    throw new FlightUnavailableError(
      `no author assignment for ${chosenTrack} avoids a repeat within the flight`,
      'This tasting track is not ready to serve yet.',
    );
  }

  // At most one control round, and never round 1 — a reader meeting two
  // identical cards as their first impression learns the wrong thing about
  // what the flight is asking.
  const controlRound = rand() < IDENTICAL_CONTROL_RATE ? 2 + Math.floor(rand() * 4) : 0;

  const sealedRounds: SealedRound[] = [];
  const publicRounds: PublicRound[] = [];
  for (let i = 0; i < pairs.length; i++) {
    const { item, left, right } = pairs[i]!;
    const round = i + 1;
    const isControl = round === controlRound;
    // An identical-answer control serves ONE proposal on both sides. The
    // author is the same on both, which is exactly what the database's
    // `distinct_unless_identical_control` constraint permits and nothing else.
    const rightSide = isControl ? left : right;
    const side = (p: FixtureProposal): PublicSide => ({
      body: p.body,
      words: tasteWordCount(p.body),
      ...(p.sensory ? { sensory: p.sensory } : {}),
      ...(p.timeline ? { timeline: p.timeline } : {}),
    });
    sealedRounds.push({
      round,
      itemId: item.id,
      leftId: left.authorId,
      rightId: rightSide.authorId,
      nonce: randomBytes(24).toString('base64url'),
      leftWords: tasteWordCount(left.body),
      rightWords: tasteWordCount(rightSide.body),
      controlKind: isControl ? 'identical' : 'none',
      reasonCount: item.reasons.length,
    });
    publicRounds.push({
      round,
      itemId: item.id,
      task: item.task,
      judgingQuestion: item.judgingQuestion,
      reasons: item.reasons,
      left: side(left),
      right: side(rightSide),
    });
  }

  const flight: SealedFlight = {
    v: 1,
    flightId: randomUUID(),
    track: chosenTrack,
    exp: Date.now() + FLIGHT_TTL_MS,
    rounds: sealedRounds,
  };
  return { token: sealFlight(flight), track: chosenTrack, rounds: publicRounds };
}

/* -------------------------------------------------------------------------- */
/* Casting and revealing                                                      */
/* -------------------------------------------------------------------------- */

export interface CastContext {
  flightId: string;
  /** Server-derived, from the seal — never the number the client sent. */
  round: number;
  track: TasteTrack;
  itemId: string;
  modelLeft: string;
  modelRight: string;
  nonce: string;
  leftWords: number;
  rightWords: number;
  controlKind: TasteControlKind;
  reasonCount: number;
}

/** Resolve a round of a sealed flight, or null if the token does not carry it. */
export function roundContext(token: unknown, round: unknown): CastContext | null {
  const flight = openFlight(token);
  if (!flight) return null;
  if (typeof round !== 'number' || !Number.isInteger(round)) return null;
  const sealed = flight.rounds.find((r) => r.round === round);
  if (!sealed) return null;
  return {
    flightId: flight.flightId,
    round: sealed.round,
    track: flight.track,
    itemId: sealed.itemId,
    modelLeft: sealed.leftId,
    modelRight: sealed.rightId,
    nonce: sealed.nonce,
    leftWords: sealed.leftWords,
    rightWords: sealed.rightWords,
    controlKind: sealed.controlKind,
    // Absent on a token minted before this field existed; 0 refuses every
    // index, which is the fail-closed reading of "we do not know".
    reasonCount: typeof sealed.reasonCount === 'number' ? sealed.reasonCount : 0,
  };
}

/**
 * The reveal. Refuses unless every round of the flight presents a valid
 * receipt — five recorded decisions, then and only then the names.
 */
export function revealFlight(token: unknown, receipts: unknown): RoundIdentity[] | null {
  const flight = openFlight(token);
  if (!flight) return null;
  if (!Array.isArray(receipts) || receipts.length !== flight.rounds.length) return null;
  for (const sealed of flight.rounds) {
    const presented = receipts[sealed.round - 1];
    if (!receiptValid(flight.flightId, sealed.round, presented)) return null;
  }
  return flight.rounds.map((r) => ({
    round: r.round,
    left: displayNameFor(r.leftId),
    right: displayNameFor(r.rightId),
    identical: r.controlKind === 'identical',
  }));
}

/**
 * Fixture voices are named, not numbered, so the reveal reads as a reveal.
 * They are NOT models and the UI says so — attributing authored fixture prose
 * to a real model would be a fabricated model contact in the permanent record.
 */
export function displayNameFor(authorId: string): string {
  const leaf = authorId.split('/').pop() ?? authorId;
  return leaf.charAt(0).toUpperCase() + leaf.slice(1);
}
