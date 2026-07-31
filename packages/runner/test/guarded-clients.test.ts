import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNS_DIR } from '../src/dataset.js';
import { Firewall, FirewallError } from '../src/firewall.js';
import { ReservationLedger } from '../src/ledger.js';
import { OpenRouterClient, fetchCatalog, type GuardedCompletionOpts } from '../src/openrouter.js';
import { serviceRoleClient } from '../src/supabase.js';
import { mintTestGrant } from './support/grant.js';

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
const CELL = { modelId: 'openai/gpt-5.5', questionId: 'conv-001' };

beforeEach(() => {
  // Not a real key and never sent anywhere: `fetch` is stubbed in every test
  // that reaches the transport. Without it `apiKey()` throws INSIDE the retry
  // loop and the suite spends five backoffs discovering a configuration error.
  process.env.OPENROUTER_API_KEY ??= 'test-key-not-used-offline';
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(join(RUNS_DIR, RUN), { recursive: true, force: true });
});

function candidateGrant(budgetCapUsd = 10) {
  return mintTestGrant({
    permitId: 'permit-client-001',
    kind: 'development-probe',
    capabilities: ['candidate-inference'],
    cells: [CELL],
    budgetCapUsd,
    runId: RUN,
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

function ledgerFor(grant: ReturnType<typeof candidateGrant>) {
  return ReservationLedger.forGrant(grant, RUN, { lock: false });
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
});
