import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNS_DIR } from '../src/dataset.js';
import { Firewall, FirewallError } from '../src/firewall.js';
import {
  BudgetExceededError,
  CapBreachedError,
  LedgerError,
  ReservationLedger,
} from '../src/ledger.js';
import { OpenRouterClient, fetchCatalog, type GuardedCompletionOpts } from '../src/openrouter.js';
import { serviceRoleClient } from '../src/supabase.js';
import { mintTestGrant, type MintOptions } from './support/grant.js';
import { temporarilyRevokePermit } from './support/production-trust.js';

/**
 * RUN-001 — the paid and privileged clients are constructible only from a
 * verified grant carrying the right capability, and every call they make names
 * the cell it consumes and the money it reserves.
 *
 * Offline by construction. The tests that exercise a completion stub
 * `globalThis.fetch`, so no socket is opened and no provider is contacted; the
 * refusal tests all throw before any transport is reached, which is itself the
 * property being asserted.
 */

const RUN = '__test-clients-scratch';
const OTHER_RUN = '__test-clients-other';
const CELL = { modelId: 'openai/gpt-5.5', questionId: 'conv-001' };
const revocationRestores: Array<() => void> = [];

beforeEach(() => {
  // Not a real key and never sent anywhere: `fetch` is stubbed in every test
  // that reaches the transport. Without it `apiKey()` throws INSIDE the retry
  // loop and the suite spends every configured backoff discovering a configuration error.
  process.env.OPENROUTER_API_KEY ??= 'test-key-not-used-offline';
});

afterEach(() => {
  for (const restore of revocationRestores.splice(0).reverse()) restore();
  vi.useRealTimers(); // a leaked fake clock would hang the next file's backoffs
  vi.unstubAllGlobals();
  activeLedger?.close();
  activeLedger = null;
  activeGrant = null;
  rmSync(join(RUNS_DIR, RUN), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, OTHER_RUN), { recursive: true, force: true });
});

function candidateGrant(budgetCapUsd = 10, maxAttempts = 3) {
  return mintTestGrant({
    permitId: 'permit-client-001',
    kind: 'development-probe',
    capabilities: ['candidate-inference'],
    cells: [CELL],
    budgetCapUsd,
    runId: RUN,
    maxAttempts,
  });
}

/**
 * A legacy-shadow permit: judge calls only, over ARCHIVED candidate answers.
 *
 * The cell names the candidate whose answer is being re-scored — gpt-5.5 —
 * because that is what the approver decides. Which seat draws the ballot is the
 * panel's business (JUDGE-001), not the permit's, and pinning it here would
 * bind a signed approval to the seat-selection hash.
 */
function judgeGrant() {
  return mintTestGrant({
    permitId: 'permit-client-002',
    kind: 'legacy-shadow',
    capabilities: ['judge-inference'],
    cells: [CELL],
    runId: RUN,
  });
}

let activeLedger: ReservationLedger | null = null;
let activeGrant: ReturnType<typeof candidateGrant> | null = null;

/** A production ledger, reused only for the same grant inside one test. */
function ledgerFor(grant: ReturnType<typeof candidateGrant>) {
  if (activeLedger && activeGrant === grant) return activeLedger;
  activeLedger?.close();
  activeLedger = ReservationLedger.forGrant(grant, RUN);
  activeGrant = grant;
  return activeLedger;
}

/** A grant whose clock and revocation list the test may change after verification. */
function controlledGrant(overrides: Partial<MintOptions> = {}) {
  const grant = mintTestGrant({
    permitId: 'permit-client-controlled',
    kind: 'development-probe',
    capabilities: ['candidate-inference'],
    cells: [CELL],
    budgetCapUsd: 10,
    runId: RUN,
    ...overrides,
  });
  return {
    grant,
    revoke() {
      revocationRestores.push(temporarilyRevokePermit(grant.permitId));
    },
    setNow(iso: string) {
      vi.setSystemTime(iso);
    },
  };
}

/** A complete, well-formed call. Individual tests break exactly one field. */
function opts(overrides: Partial<GuardedCompletionOpts> = {}): GuardedCompletionOpts {
  return { temperature: 0, maxTokens: 100, cell: { ...CELL }, estimateUsd: 1, ...overrides };
}

describe('the paid client cannot be built without authorisation', () => {
  it('has no public constructor to call', () => {
    const grant = candidateGrant();
    const ledger = ledgerFor(grant);
    // `private constructor` is erased at runtime, so the guard has to be a
    // runtime check — otherwise this line builds a fully working paid client.
    expect(() =>
      Reflect.construct(OpenRouterClient, [
        { capabilities: ['candidate-inference'] },
        ledger,
        'candidate-inference',
        'candidate',
      ]),
    ).toThrow(/did not mint by verifying a signed permit/);
    expect(() =>
      Reflect.construct(OpenRouterClient, [grant, ledger, 'candidate-inference', 'candidate']),
    ).not.toThrow();
  });

  it('refuses a candidate client to a judge-only permit', () => {
    // The legacy-shadow case with teeth: re-scoring the archive must not be
    // able to buy fresh candidate inference, at the construction site.
    const grant = judgeGrant();
    expect(() => OpenRouterClient.forCandidates(grant, ledgerFor(grant))).toThrow(
      /does not grant 'candidate-inference'/,
    );
    expect(() => OpenRouterClient.forJudging(grant, ledgerFor(grant))).not.toThrow();
  });

  it('refuses a judge client to a candidate-only permit', () => {
    const grant = candidateGrant();
    expect(() => OpenRouterClient.forJudging(grant, ledgerFor(grant))).toThrow(
      /does not grant 'judge-inference'/,
    );
  });

  it('refuses a ledger minted for another verified grant, permit, manifest or run', () => {
    const grant = candidateGrant();
    const ledger = ledgerFor(grant);

    const anotherPermit = mintTestGrant({
      permitId: 'permit-client-foreign',
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [CELL],
      budgetCapUsd: 10,
      runId: RUN,
    });
    expect(() => OpenRouterClient.forCandidates(anotherPermit, ledger)).toThrow(LedgerError);
    expect(() => OpenRouterClient.forCandidates(anotherPermit, ledger)).toThrow(
      /cannot be shared across grants, permits, manifests or runs/,
    );

    // Same permit id and run, but a different signed manifest (the budget is
    // part of it), is still a different authority and cannot inherit a ledger.
    const anotherManifest = mintTestGrant({
      permitId: grant.permitId,
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [CELL],
      budgetCapUsd: 9,
      runId: RUN,
    });
    expect(() => OpenRouterClient.forCandidates(anotherManifest, ledger)).toThrow(
      /LEDGER|exact verified grant|cannot be shared/i,
    );

    const otherRunGrant = mintTestGrant({
      permitId: 'permit-client-other-run',
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [CELL],
      budgetCapUsd: 10,
      runId: OTHER_RUN,
    });
    const otherRunLedger = ReservationLedger.forGrant(otherRunGrant, OTHER_RUN);
    expect(() => OpenRouterClient.forCandidates(grant, otherRunLedger)).toThrow(
      /cannot be shared across grants, permits, manifests or runs/,
    );
  });

  it('refuses a ledger-shaped object that was not constructed by the ledger boundary', () => {
    const grant = candidateGrant();
    const fake = {
      reserve: vi.fn(),
      settle: vi.fn(),
      releaseUncharged: vi.fn(),
      retainUnreconciled: vi.fn(),
    } as never;
    expect(() => OpenRouterClient.forCandidates(grant, fake)).toThrow(LedgerError);
    expect(() => OpenRouterClient.forCandidates(grant, fake)).toThrow(
      /not constructed by ReservationLedger/,
    );
  });

  it('refuses the live catalog without catalog-read, before any request', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(fetchCatalog(candidateGrant())).rejects.toThrow(/does not grant 'catalog-read'/);
    expect(fetchSpy).not.toHaveBeenCalled(); // the point: refused before the socket
  });

  it('refuses a service-role database client without the capability', () => {
    const grant = candidateGrant();
    expect(() => serviceRoleClient(grant, 'result-sync', 'syncRun')).toThrow(
      /does not grant 'result-sync'/,
    );
    expect(() => serviceRoleClient(grant, 'publication', 'publishRun')).toThrow(
      /does not grant 'publication'/,
    );
    const forged = { capabilities: ['publication'] } as never;
    expect(() => serviceRoleClient(forged, 'publication', 'publishRun')).toThrow(
      /did not mint by verifying a signed permit/,
    );
  });
});

describe('authority is fresh when network access is exercised', () => {
  it('stops a completion revoked after client construction, before fetch', async () => {
    const controlled = controlledGrant();
    const ledger = ledgerFor(controlled.grant);
    const client = OpenRouterClient.forCandidates(controlled.grant, ledger);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    controlled.revoke();
    await expect(
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts()),
    ).rejects.toMatchObject({ code: 'PERMIT_REVOKED' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledger.committedUsd).toBe(0);
  });

  it('stops a completion whose permit expires after client construction, before fetch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime('2026-07-31T12:00:00.000Z');
    const controlled = controlledGrant({ notAfter: '2026-07-31T12:01:00.000Z' });
    const ledger = ledgerFor(controlled.grant);
    const client = OpenRouterClient.forCandidates(controlled.grant, ledger);
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    controlled.setNow('2026-07-31T12:02:00.000Z');
    await expect(
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts()),
    ).rejects.toMatchObject({ code: 'PERMIT_EXPIRED' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledger.committedUsd).toBe(0);
  });

  it('stops a catalog read revoked after verification, before fetch', async () => {
    const controlled = controlledGrant({
      permitId: 'permit-catalog-controlled',
      capabilities: ['catalog-read'],
      cells: [],
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    controlled.revoke();
    await expect(fetchCatalog(controlled.grant)).rejects.toMatchObject({ code: 'PERMIT_REVOKED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/**
 * A cell is a (candidate, item) coordinate, and the KIND of work at that
 * coordinate is a separate authorisation carried by the permit's capabilities.
 *
 * Before this, `requireCell(modelId, questionId)` had no kind at all, and
 * `complete()` passed the JUDGE SEAT as `modelId` on a judging call. A judging
 * permit therefore had to enumerate seat × question — roughly 552 pairs for a
 * three-seat panel over 184 items — and each one had to be precomputed by
 * reproducing the panel's FNV-1a seat hash by hand. Nobody can approve that,
 * and changing the hash would silently void a signed permit.
 */
describe('cells name the candidate and carry a kind', () => {
  it('refuses a cell kind it does not recognise, including an inherited one', () => {
    const fw = Firewall.fromVerifiedPermit(candidateGrant());
    for (const kind of ['', 'CANDIDATE', 'inference', 'constructor', 'toString', undefined, null, 7]) {
      // 'constructor' and 'toString' matter: a prototype lookup on the kind →
      // capability table would find a truthy value for both and sail past the
      // membership check into an undefined capability comparison.
      expect(
        () => fw.requireCell({ kind, ...CELL } as never, 'probe'),
        `kind ${JSON.stringify(kind)} was accepted`,
      ).toThrow(FirewallError);
    }
  });

  it('refuses a cell with a missing coordinate rather than matching on undefined', () => {
    const fw = Firewall.fromVerifiedPermit(candidateGrant());
    expect(() => fw.requireCell({ kind: 'candidate', questionId: 'conv-001' } as never, 'probe')).toThrow(
      /incomplete candidate cell/,
    );
    expect(() =>
      fw.requireCell({ kind: 'candidate', modelId: 'openai/gpt-5.5', questionId: '' } as never, 'probe'),
    ).toThrow(/incomplete candidate cell/);
  });

  it('keeps the two kinds distinct at the same coordinate', () => {
    // The whole reason the kind exists. A permit that may GENERATE gpt-5.5's
    // answer to conv-001 must not thereby be able to buy a judge call on it,
    // and vice versa — even though both name the identical cell.
    const candidateOnly = Firewall.fromVerifiedPermit(candidateGrant());
    expect(() => candidateOnly.requireCell({ kind: 'candidate', ...CELL }, 'probe')).not.toThrow();
    expect(() => candidateOnly.requireCell({ kind: 'judge', ...CELL }, 'probe')).toThrow(
      /does not grant 'judge-inference'/,
    );

    const judgeOnly = Firewall.fromVerifiedPermit(judgeGrant());
    expect(() => judgeOnly.requireCell({ kind: 'judge', ...CELL }, 'probe')).not.toThrow();
    expect(() => judgeOnly.requireCell({ kind: 'candidate', ...CELL }, 'probe')).toThrow(
      /does not grant 'candidate-inference'/,
    );
  });

  it('authorises a judge call by the answer it scores, not by the seat scoring it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: '{"findings":[]}' }, finish_reason: 'stop' }],
              usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.02 },
            }),
            { status: 200 },
          ),
      ),
    );
    const grant = judgeGrant();
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forJudging(grant, ledger);
    const seat = 'anthropic/claude-opus-4.8'; // NOT a cell in the permit, and must not need to be

    await client.complete(seat, [{ role: 'user', content: 'score this' }], opts());

    // Spend is booked against the seat, because the seat is who gets billed —
    // while authorisation was decided by the candidate whose answer it scored.
    expect(ledger.settledByModel()[seat]).toBeCloseTo(0.02, 10);
    expect(ledger.settledByModel()[CELL.modelId]).toBeUndefined();

    // And a seat-shaped cell — the old encoding — is refused, because the
    // permit authorises answers, not seats.
    await expect(
      client.complete(seat, [{ role: 'user', content: 'score this' }], {
        ...opts(),
        cell: { modelId: seat, questionId: 'conv-001' },
      }),
    ).rejects.toThrow(/does not authorise the judge cell/);
  });
});

describe('every completion is authorised and accounted for', () => {
  function stubResponse(costUsd: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'an answer' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 20, cost: costUsd },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
  }

  it('refuses a cell the permit does not name, without making the call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const grant = candidateGrant();
    const client = OpenRouterClient.forCandidates(grant, ledgerFor(grant));
    await expect(
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], {
        ...opts(),
        cell: { modelId: 'openai/gpt-5.5', questionId: 'conv-999' },
      }),
    ).rejects.toThrow(/does not authorise the candidate cell openai\/gpt-5.5 × conv-999/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a call that names no cell, instead of skipping the check', async () => {
    // The defect: `questionId` was OPTIONAL, so omitting it skipped requireCell
    // entirely. A permit for 30 items would have happily answered all 184 —
    // opt-in enforcement inside the module whose header says a firewall you
    // have to remember to call is not a firewall.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const grant = candidateGrant();
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);
    for (const bad of [undefined, null, 'conv-001', 42]) {
      await expect(
        client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], {
          temperature: 0,
          maxTokens: 100,
          estimateUsd: 1,
          cell: bad,
        } as never),
      ).rejects.toThrow(FirewallError);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledger.committedUsd).toBe(0); // refused before anything was reserved
  });

  it('refuses an unpriced call instead of reserving zero against the cap', async () => {
    // The other half of the same defect: `estimateUsd` was optional and the
    // ledger reserved `?? 0`, so a forgetful caller spent real money against a
    // cap it never touched. Concurrency then had nothing to check against.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const grant = candidateGrant();
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);
    for (const bad of [undefined, null, -1, Number.NaN, Infinity, '5']) {
      await expect(
        client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], {
          temperature: 0,
          maxTokens: 100,
          cell: { ...CELL },
          estimateUsd: bad,
        } as never),
        `estimate ${String(bad)} was accepted`,
      ).rejects.toThrow(/no usable cost estimate/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledger.committedUsd).toBe(0);
  });

  it('refuses a candidate call whose cell names a different model', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const grant = candidateGrant();
    const client = OpenRouterClient.forCandidates(grant, ledgerFor(grant));
    await expect(
      client.complete('anthropic/claude-opus-5', [{ role: 'user', content: 'hi' }], opts()),
    ).rejects.toThrow(/is not the model being called/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('settles the reservation with the actual cost', async () => {
    stubResponse(0.42);
    const grant = candidateGrant();
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);
    const result = await client.complete(
      'openai/gpt-5.5',
      [{ role: 'user', content: 'hi' }],
      opts({ estimateUsd: 1.0 }), // reserved high...
    );
    expect(result.costUsd).toBe(0.42);
    expect(ledger.settledUsd).toBeCloseTo(0.42, 10); // ...settled at actual
    expect(ledger.openReservations).toBe(0);
  });

  it('releases the reservation when the call fails, rather than stranding the cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 })),
    );
    const grant = candidateGrant();
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);
    await expect(
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts({ estimateUsd: 9 })),
    ).rejects.toThrow(/OpenRouter 400/);
    expect(ledger.committedUsd).toBe(0);
    expect(ledger.openReservations).toBe(0);
  });

  it('stops at the cap instead of spending past it', async () => {
    stubResponse(4);
    const grant = candidateGrant(10);
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);
    const call = () =>
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts({ estimateUsd: 4 }));
    await call();
    await call();
    await expect(call()).rejects.toThrow(/Budget cap reached/);
    expect(ledger.settledUsd).toBe(8);
  });

  it('refuses a call that does not say how big a request it will send', async () => {
    // maxTokens is half of what an attempt costs, so it is priced, and
    // therefore validated. Absent, it produced a NaN reservation.
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const grant = candidateGrant();
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);
    for (const bad of [undefined, null, 0, -1, Number.NaN, '100']) {
      await expect(
        client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], {
          temperature: 0,
          cell: { ...CELL },
          estimateUsd: 1,
          maxTokens: bad,
        } as never),
        `maxTokens ${String(bad)} was accepted`,
      ).rejects.toThrow(/no usable max_tokens/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(ledger.committedUsd).toBe(0);
  });

  it('holds concurrent calls to the cap, through the real client', async () => {
    // The ledger proves the arithmetic; this proves the production call path
    // actually reserves inside the window, with four calls in flight at once.
    stubResponse(0.4);
    const grant = candidateGrant(1);
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () =>
        client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts({ estimateUsd: 0.4 })),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    for (const r of results.filter((x) => x.status === 'rejected')) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BudgetExceededError);
    }
    expect(ledger.settledUsd).toBeCloseTo(0.8, 10);
    expect(ledger.committedUsd).toBeLessThanOrEqual(ledger.capUsd);
  });
});

/**
 * BUDGET-001, the half that was falsely closed.
 *
 * One `reserve()` used to sit OUTSIDE the retry loop, so a single reservation
 * funded every configured billable POST: the cap bound reservations, not
 * requests, and a run could multiply its ceiling by the retry count with every individual
 * check passing. And every failure was `release()`d in full, so a completion
 * that was generated, billed and lost in transit was recorded as free.
 *
 * These tests stub `globalThis.fetch`, so no socket is opened, and drive the
 * backoffs with fake timers rather than waiting out 225 seconds of them.
 */
describe('every billable attempt is reserved on its own', () => {
  /** Run `fn` to completion, advancing past every retry backoff. */
  async function withBackoffsSkipped<T>(fn: () => Promise<T>): Promise<T> {
    vi.useFakeTimers();
    try {
      const settled = fn().then(
        (value) => () => value,
        (error) => () => {
          throw error;
        },
      );
      // The supported test ceilings below fit comfortably inside this fake window.
      await vi.advanceTimersByTimeAsync(600_000);
      return (await settled)();
    } finally {
      vi.useRealTimers();
    }
  }

  function stubSequence(...responses: Array<() => unknown>) {
    let i = 0;
    const spy = vi.fn(async () => {
      const next = responses[Math.min(i++, responses.length - 1)]!;
      return next() as Response;
    });
    vi.stubGlobal('fetch', spy);
    return spy;
  }

  const ok = (costUsd: number | undefined) => () =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: 'an answer' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, ...(costUsd === undefined ? {} : { cost: costUsd }) },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  const status = (code: number) => () => new Response('provider says no', { status: code });
  /** A 200 whose body dies mid-transfer: generated, billed, and lost. */
  const truncated = () => new Response('{"choices": [{"message"', { status: 200 });
  const networkError = (code?: string) => () => {
    const error = new TypeError('fetch failed');
    if (code) (error as { cause?: unknown }).cause = { code };
    throw error;
  };

  function journal(): Array<Record<string, unknown>> {
    const path = join(RUNS_DIR, RUN, 'spend.ndjson');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }

  it('reserves again for every retry, so multiple attempts cannot ride one reservation', async () => {
    const fetchSpy = stubSequence(status(429), status(500), ok(0.02));
    const grant = candidateGrant(10);
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);

    const result = await withBackoffsSkipped(() =>
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts({ estimateUsd: 1 })),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(result.costUsd).toBe(0.02);
    // Three attempts, three reservations, three terminal states — not one
    // reservation stretched over three chargeable requests.
    expect(journal().map((l) => l.state)).toEqual([
      'released-uncharged', // 429: rate limited before any inference
      'retained-unreconciled', // 500: may have followed generation
      'settled',
    ]);
    expect(ledger.openReservations).toBe(0);
    expect(ledger.settledUsd).toBeCloseTo(0.02, 10);
    expect(ledger.unreconciledUsd).toBeCloseTo(1, 10); // the 500 is still charged
  });

  it.each([1, 2, 4])(
    'obeys the verified manifest retry ceiling exactly (%i provider attempt(s))',
    async (maxAttempts) => {
      const fetchSpy = stubSequence(status(429));
      const grant = candidateGrant(10, maxAttempts);
      const ledger = ledgerFor(grant);
      const client = OpenRouterClient.forCandidates(grant, ledger);

      await expect(
        withBackoffsSkipped(() =>
          client.complete(
            'openai/gpt-5.5',
            [{ role: 'user', content: 'hi' }],
            // A caller-supplied lookalike is deliberately ignored: retry
            // authority comes from the verified grant, not completion options.
            { ...opts({ estimateUsd: 0.1 }), maxAttempts: 99 } as GuardedCompletionOpts,
          ),
        ),
      ).rejects.toThrow(/OpenRouter 429/);

      expect(grant.maxAttempts).toBe(maxAttempts);
      expect(fetchSpy).toHaveBeenCalledTimes(maxAttempts);
      expect(journal()).toHaveLength(maxAttempts);
      expect(ledger.openReservations).toBe(0);
      expect(ledger.chargedUsd).toBe(0); // all 429s were pre-generation
    },
  );

  it('re-checks revocation after a retry backoff and sends no later attempt', async () => {
    const controlled = controlledGrant();
    const ledger = ledgerFor(controlled.grant);
    const fetchSpy = vi.fn(async () => {
      // The first attempt was authorised. Revocation lands while it is in
      // flight; the next attempt must observe it after the backoff.
      controlled.revoke();
      return new Response('rate limited', { status: 429 });
    });
    vi.stubGlobal('fetch', fetchSpy);
    const client = OpenRouterClient.forCandidates(controlled.grant, ledger);

    await expect(
      withBackoffsSkipped(() =>
        client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts({ estimateUsd: 1 })),
      ),
    ).rejects.toMatchObject({ code: 'PERMIT_REVOKED' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(ledger.openReservations).toBe(0);
    expect(ledger.committedUsd).toBe(0); // 429 was provably pre-generation
  });

  it('stops a retry that no longer fits under the cap, before it is sent', async () => {
    // The whole point of reserving per attempt: the SECOND request has to pass
    // the cap on its own, and a run that has already burned its ceiling on a
    // first attempt must not be able to send a second.
    const fetchSpy = stubSequence(status(500), ok(0.02));
    const grant = candidateGrant(1.5);
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);

    await expect(
      withBackoffsSkipped(() =>
        client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts({ estimateUsd: 1 })),
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);

    expect(fetchSpy).toHaveBeenCalledTimes(1); // the retry was never sent
    expect(ledger.chargedUsd).toBeCloseTo(1, 10);
    expect(ledger.committedUsd).toBeLessThanOrEqual(ledger.capUsd);
  });

  it('charges an unreadable 200 instead of refunding a completion that was billed', async () => {
    // run 2026-07-v2.1 lost four responses this way. The completion existed and
    // was billed; only the body died. `release()` gave the money back.
    const fetchSpy = stubSequence(truncated, ok(0.02));
    const grant = candidateGrant(10);
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);

    const result = await withBackoffsSkipped(() =>
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts({ estimateUsd: 0.3 })),
    );

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(result.costUsd).toBe(0.02); // the retry's real cost
    expect(ledger.unreconciledUsd).toBeCloseTo(0.3, 10); // the lost one, still charged
    expect(ledger.settledUsd).toBeCloseTo(0.02, 10);
    expect(String(journal()[0]!.reason)).toMatch(/unreadable body/);
  });

  it('never records a missing provider cost as zero', async () => {
    // `costUsd: json.usage?.cost ?? 0` made an unpriced call a free call, in
    // the artifact AND in the ledger.
    stubSequence(ok(undefined));
    const grant = candidateGrant(10);
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);

    const result = await client.complete(
      'openai/gpt-5.5',
      [{ role: 'user', content: 'hi' }],
      opts({ estimateUsd: 0.25 }),
    );

    expect(result.costUsd).toBeCloseTo(0.25, 10); // the reservation, not zero
    expect(result.costBasis).toBe('reserved-unreconciled'); // and it says so
    expect(ledger.settledUsd).toBe(0);
    expect(ledger.unreconciledUsd).toBeCloseTo(0.25, 10);
    expect(journal()[0]).toMatchObject({ state: 'retained-unreconciled', actualUsd: 0.25 });
  });

  it('prices an attempt from the token budget it actually sends', async () => {
    // cmdRun retries an empty completion with `maxTokens * 2` while passing the
    // estimate it computed for the ORIGINAL maxTokens, and judge.ts escalates
    // `2000 * (attempt + 1)` against one flat per-call estimate. Both reserved
    // for a smaller request than the one they sent.
    stubSequence(ok(0.01));
    const grant = candidateGrant(1);
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);

    await client.complete(
      'openai/gpt-5.5',
      [{ role: 'user', content: 'hi' }],
      opts({ estimateUsd: 0.001, maxTokens: 10_000 }),
    );
    // 10k tokens at the $50/Mtok worst case is $0.50, not the $0.001 declared.
    expect(Number(journal()[0]!.reservedUsd)).toBeCloseTo(0.5, 2);

    // The retry doubles the token budget, so it must reserve double — and there
    // is no longer room for it. Before the fix it reserved $0.001 and went.
    await expect(
      client.complete(
        'openai/gpt-5.5',
        [{ role: 'user', content: 'hi' }],
        opts({ estimateUsd: 0.001, maxTokens: 20_000 }),
      ),
    ).rejects.toBeInstanceOf(BudgetExceededError);
  });

  it('gives the money back only when the provider provably never saw the request', async () => {
    const grant = candidateGrant(10);

    // A refused connection cannot have been billed: DNS and TCP both failed
    // before a byte of the body was written.
    const refused = ledgerFor(grant);
    stubSequence(networkError('ECONNREFUSED'));
    await expect(
      withBackoffsSkipped(() =>
        OpenRouterClient.forCandidates(grant, refused).complete(
          'openai/gpt-5.5',
          [{ role: 'user', content: 'hi' }],
          opts({ estimateUsd: 0.1 }),
        ),
      ),
    ).rejects.toThrow(/network error/);
    expect(refused.chargedUsd).toBe(0);
    expect(refused.openReservations).toBe(0);

    rmSync(join(RUNS_DIR, RUN), { recursive: true, force: true });

    // A socket that died with no errno is undici's `terminated`, and it happens
    // AFTER the request is written just as often as before. Three attempts, three
    // reservations, all retained: the conservative reading is the default.
    const dropped = ledgerFor(grant);
    stubSequence(networkError());
    await expect(
      withBackoffsSkipped(() =>
        OpenRouterClient.forCandidates(grant, dropped).complete(
          'openai/gpt-5.5',
          [{ role: 'user', content: 'hi' }],
          opts({ estimateUsd: 0.1 }),
        ),
      ),
    ).rejects.toThrow(/network error/);
    expect(dropped.chargedUsd).toBeCloseTo(0.3, 10); // signed limit: 3 attempts x $0.10
    expect(dropped.openReservations).toBe(0);
  });

  it('stops the run when the provider bills more than the attempt reserved', async () => {
    // Reserving is a promise about the future; the provider decides the past.
    // Requirement 4 — settlement must never leave total AUTHORISED spend over
    // the cap — is not "refuse the settlement" (the money is already gone) but
    // "authorise nothing further, loudly", and it is exercised here through the
    // production call path rather than by poking the ledger directly.
    const fetchSpy = stubSequence(ok(5));
    const grant = candidateGrant(1);
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);
    const call = () =>
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], opts({ estimateUsd: 0.5 }));

    await expect(call()).rejects.toBeInstanceOf(CapBreachedError);
    expect(ledger.capBreached).toBe(true);
    expect(ledger.chargedUsd).toBeCloseTo(5, 10); // recorded, not discarded
    await expect(call()).rejects.toBeInstanceOf(CapBreachedError);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // the second call never reached the socket
  });

  it('resolves every reservation even when the error body cannot be read', async () => {
    // `await res.text()` on the failure path used to sit outside any try: a
    // throw there escaped the loop with the reservation still open and
    // unjournalled, so the money was neither charged nor released.
    const grant = candidateGrant(10);
    const ledger = ledgerFor(grant);
    stubSequence(() => ({
      ok: false,
      status: 503,
      text: async () => {
        throw new Error('socket hang up');
      },
    }));
    await expect(
      withBackoffsSkipped(() =>
        OpenRouterClient.forCandidates(grant, ledger).complete(
          'openai/gpt-5.5',
          [{ role: 'user', content: 'hi' }],
          opts({ estimateUsd: 0.1 }),
        ),
      ),
    ).rejects.toThrow(/OpenRouter 503/);
    expect(ledger.openReservations).toBe(0);
    expect(ledger.chargedUsd).toBeCloseTo(0.3, 10); // three 503s may follow generation
  });
});
