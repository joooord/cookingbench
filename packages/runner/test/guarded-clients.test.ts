import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUNS_DIR } from '../src/dataset.js';
import { ReservationLedger } from '../src/ledger.js';
import { OpenRouterClient, fetchCatalog } from '../src/openrouter.js';
import { serviceRoleClient } from '../src/supabase.js';
import { mintTestGrant } from './support/grant.js';

/**
 * RUN-001 — the paid and privileged clients are constructible only from a
 * verified grant carrying the right capability.
 *
 * Offline by construction. The one test that exercises a completion stubs
 * `globalThis.fetch`, so no socket is opened and no provider is contacted; the
 * refusal tests all throw before any transport is reached, which is itself the
 * property being asserted.
 */

const RUN = '__test-clients-scratch';
const CELL = { modelId: 'openai/gpt-5.5', questionId: 'conv-001' };

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

function judgeGrant() {
  return mintTestGrant({
    permitId: 'permit-client-002',
    kind: 'legacy-shadow',
    capabilities: ['judge-inference'],
    cells: [{ modelId: 'anthropic/claude-opus-4.8', questionId: 'conv-001' }],
    runId: RUN,
  });
}

function ledgerFor(grant: ReturnType<typeof candidateGrant>) {
  return ReservationLedger.forGrant(grant, RUN, { lock: false });
}

describe('the paid client cannot be built without authorisation', () => {
  it('has no public constructor to call', () => {
    const grant = candidateGrant();
    const ledger = ledgerFor(grant);
    // `private constructor` is erased at runtime, so the guard has to be a
    // runtime check — otherwise this line builds a fully working paid client.
    expect(() => Reflect.construct(OpenRouterClient, [{ capabilities: ['candidate-inference'] }, ledger, 'candidate-inference'])).toThrow(
      /did not mint by verifying a signed permit/,
    );
    expect(() => Reflect.construct(OpenRouterClient, [grant, ledger, 'candidate-inference'])).not.toThrow();
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

describe('every completion is authorised and accounted for', () => {
  beforeEach(() => {
    process.env.OPENROUTER_API_KEY ??= 'test-key-not-used-offline';
  });

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
        temperature: 0,
        maxTokens: 100,
        questionId: 'conv-999',
      }),
    ).rejects.toThrow(/does not authorise openai\/gpt-5.5 × conv-999/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('settles the reservation with the actual cost', async () => {
    stubResponse(0.42);
    const grant = candidateGrant();
    const ledger = ledgerFor(grant);
    const client = OpenRouterClient.forCandidates(grant, ledger);
    const result = await client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], {
      temperature: 0,
      maxTokens: 100,
      questionId: 'conv-001',
      estimateUsd: 1.0, // reserved high...
    });
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
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], {
        temperature: 0,
        maxTokens: 100,
        questionId: 'conv-001',
        estimateUsd: 9,
      }),
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
      client.complete('openai/gpt-5.5', [{ role: 'user', content: 'hi' }], {
        temperature: 0,
        maxTokens: 100,
        questionId: 'conv-001',
        estimateUsd: 4,
      });
    await call();
    await call();
    await expect(call()).rejects.toThrow(/Budget cap reached/);
    expect(ledger.settledUsd).toBe(8);
  });
});
