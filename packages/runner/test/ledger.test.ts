import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNS_DIR } from '../src/dataset.js';
import { BudgetExceededError, LedgerError, ReservationLedger } from '../src/ledger.js';
import { mintTestGrant } from './support/grant.js';

/**
 * BUDGET-001 — the reservation ledger.
 *
 * Offline: no client, no socket, no model. These are accounting tests.
 */

const RUN = '__test-ledger-scratch';
const DIR = join(RUNS_DIR, RUN);

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function grantFor(budgetCapUsd: number) {
  return mintTestGrant({
    permitId: 'permit-ledger-001',
    kind: 'development-probe',
    capabilities: ['candidate-inference'],
    cells: [{ modelId: 'openai/gpt-5.5', questionId: 'conv-001' }],
    budgetCapUsd,
    runId: RUN,
  });
}

describe('the check-then-record race is closed', () => {
  it('never authorises more concurrent calls than the cap allows', async () => {
    // The old shape: assertCanSpend(...); await call; record(...). Four
    // concurrent tasks each passed a check against a total none of them had yet
    // added to, so a $1.00 cap authorised 4 x $0.40 = $1.60 of calls.
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN, { lock: false });
    const authorised: number[] = [];
    const refused: string[] = [];
    await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        (async () => {
          try {
            const r = ledger.reserve('openai/gpt-5.5', 0.4);
            authorised.push(i);
            await Promise.resolve(); // the await that used to sit inside the window
            ledger.settle(r, 0.4);
          } catch (e) {
            if (!(e instanceof BudgetExceededError)) throw e;
            refused.push(e.scope);
          }
        })(),
      ),
    );
    expect(authorised.length).toBe(2); // 0.4 + 0.4 fits under 1.00; a third does not
    expect(refused.length).toBe(2);
    expect(ledger.settledUsd).toBeCloseTo(0.8, 10);
    expect(ledger.committedUsd).toBeLessThanOrEqual(ledger.capUsd);
  });

  it('counts an in-flight reservation against the cap before it settles', () => {
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN, { lock: false });
    ledger.reserve('openai/gpt-5.5', 0.9);
    expect(ledger.settledUsd).toBe(0); // nothing spent yet...
    expect(ledger.committedUsd).toBeCloseTo(0.9, 10); // ...but it is committed
    expect(() => ledger.reserve('openai/gpt-5.5', 0.2)).toThrow(BudgetExceededError);
  });

  it('gives the money back when a call never happens', () => {
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN, { lock: false });
    const r = ledger.reserve('openai/gpt-5.5', 0.9);
    ledger.release(r);
    expect(ledger.committedUsd).toBe(0);
    expect(ledger.openReservations).toBe(0);
    expect(() => ledger.reserve('openai/gpt-5.5', 0.9)).not.toThrow();
  });

  it('refuses to settle or release the same reservation twice', () => {
    const ledger = ReservationLedger.forGrant(grantFor(5), RUN, { lock: false });
    const r = ledger.reserve('openai/gpt-5.5', 1);
    ledger.settle(r, 0.5);
    expect(() => ledger.settle(r, 0.5)).toThrow(LedgerError);
    expect(() => ledger.release(r)).toThrow(LedgerError);
    expect(ledger.settledUsd).toBeCloseTo(0.5, 10);
  });

  it('applies a per-model cap independently of the total', () => {
    const ledger = ReservationLedger.forGrant(grantFor(10), RUN, {
      lock: false,
      perModelCapUsd: 1,
    });
    ledger.settle(ledger.reserve('openai/gpt-5.5', 1), 1);
    expect(() => ledger.reserve('openai/gpt-5.5', 0.1)).toThrow(/model:openai/);
    expect(() => ledger.reserve('anthropic/claude-opus-5', 0.1)).not.toThrow();
  });

  it('books spend against the reserved model, not against the handle it is given', () => {
    // A Reservation is an ordinary object; a caller can hand back one whose
    // modelId says something else. Attribution must come from the ledger's own
    // record or a per-model cap can be walked past by relabelling.
    const ledger = ReservationLedger.forGrant(grantFor(10), RUN, { lock: false, perModelCapUsd: 1 });
    const real = ledger.reserve('openai/gpt-5.5', 0.9);
    ledger.settle({ ...real, modelId: 'anthropic/claude-opus-5' }, 0.9);
    expect(ledger.settledByModel()['openai/gpt-5.5']).toBeCloseTo(0.9, 10);
    expect(ledger.settledByModel()['anthropic/claude-opus-5']).toBeUndefined();
    expect(() => ledger.reserve('openai/gpt-5.5', 0.2)).toThrow(/model:openai/);
  });
});

describe('the cap comes from the permit', () => {
  it('lets an operator sub-cap lower the ceiling but never raise it', () => {
    const grant = grantFor(10);
    expect(ReservationLedger.forGrant(grant, RUN, { lock: false, totalCapUsd: 2 }).capUsd).toBe(2);
    // A caller-supplied number that could raise the approved cap would make the
    // permit's budget advisory.
    expect(ReservationLedger.forGrant(grant, RUN, { lock: false, totalCapUsd: 999 }).capUsd).toBe(10);
  });

  it('cannot be built from anything but a verified grant', () => {
    const forged = { permitId: 'x', budgetCapUsd: 1e9, capabilities: [], cells: [] } as never;
    expect(() => ReservationLedger.forGrant(forged, RUN, { lock: false })).toThrow(
      /did not mint by verifying a signed permit/,
    );
  });

  it('refuses to spend against a published run', () => {
    expect(() =>
      ReservationLedger.forGrant(grantFor(1), '2026-07-v2.1', { lock: false }),
    ).toThrow(/historical and immutable/);
  });
});

describe('spend survives the process', () => {
  it('replays prior spend so a resumed run does not spend its cap twice', () => {
    const first = ReservationLedger.forGrant(grantFor(1), RUN, { lock: false });
    first.settle(first.reserve('openai/gpt-5.5', 0.6), 0.6);
    expect(existsSync(join(DIR, 'spend.ndjson'))).toBe(true);

    const resumed = ReservationLedger.forGrant(grantFor(1), RUN, { lock: false });
    expect(resumed.settledUsd).toBeCloseTo(0.6, 10);
    expect(() => resumed.reserve('openai/gpt-5.5', 0.5)).toThrow(BudgetExceededError);
  });

  it('appends rather than replaces, so no earlier entry can be lost', () => {
    const ledger = ReservationLedger.forGrant(grantFor(5), RUN, { lock: false });
    ledger.settle(ledger.reserve('openai/gpt-5.5', 1), 0.1);
    ledger.settle(ledger.reserve('openai/gpt-5.5', 1), 0.2);
    const lines = readFileSync(join(DIR, 'spend.ndjson'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).actualUsd).toBe(0.1);
    expect(JSON.parse(lines[0]!).permitId).toBe('permit-ledger-001');
  });

  it('keeps the money on the books when the journal write fails', () => {
    // The defect: settle() closed the reservation FIRST and journalled second,
    // under a comment claiming the opposite. A throw from the append therefore
    // released the hold and never recorded the settlement, so $0.60 that had
    // genuinely been spent disappeared from the accounting and the cap it had
    // consumed became spendable again.
    //
    // The append is made to fail for real rather than by mocking: the firewall
    // refuses to append through a leaf symlink, which is one of the ways this
    // actually breaks in the field (the others being a full disk and a run that
    // froze mid-batch).
    mkdirSync(DIR, { recursive: true });
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN, { lock: false });
    const r = ledger.reserve('openai/gpt-5.5', 0.6);
    symlinkSync(join(DIR, 'elsewhere.ndjson'), join(DIR, 'spend.ndjson'));

    expect(() => ledger.settle(r, 0.6)).toThrow(/symlink/i);

    // Over-counting is the safe direction: the hold survives, so the cap stays
    // consumed. Before the fix all three of these read as if nothing had been
    // spent at all.
    expect(ledger.openReservations).toBe(1);
    expect(ledger.committedUsd).toBeCloseTo(0.6, 10);
    expect(() => ledger.reserve('openai/gpt-5.5', 0.5)).toThrow(BudgetExceededError);
    expect(existsSync(join(DIR, 'elsewhere.ndjson'))).toBe(false); // and nothing followed the link
  });

  it('writes no journal line for a settle it is going to refuse', () => {
    // The trap in "journal first": appending before validating would record a
    // charge for a double settle that never happened, and the next resume would
    // inherit it. Validation has to come first, then the journal, then the books.
    const ledger = ReservationLedger.forGrant(grantFor(5), RUN, { lock: false });
    const r = ledger.reserve('openai/gpt-5.5', 1);
    ledger.settle(r, 0.5);
    expect(() => ledger.settle(r, 0.5)).toThrow(LedgerError);
    expect(readFileSync(join(DIR, 'spend.ndjson'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(ledger.settledUsd).toBeCloseTo(0.5, 10);
  });

  it('refuses to run against a corrupt journal rather than assuming zero', () => {
    // "Assume nothing was spent" is how a resumed run spends its cap a second
    // time — the same fail-open shape as the historical registry bug.
    mkdirSync(DIR, { recursive: true });
    for (const contents of ['{ not json\n', '{"actualUsd": "lots"}\n', '{"actualUsd": -5}\n']) {
      writeFileSync(join(DIR, 'spend.ndjson'), contents);
      expect(() => ReservationLedger.forGrant(grantFor(1), RUN, { lock: false })).toThrow(LedgerError);
    }
  });
});

describe('two runners cannot each spend the whole cap', () => {
  it('refuses a second ledger while the first holds the lock', () => {
    const held = ReservationLedger.forGrant(grantFor(1), RUN);
    try {
      expect(() => ReservationLedger.forGrant(grantFor(1), RUN)).toThrow(/already being spent against/);
    } finally {
      held.close();
    }
    // Released, so the next runner may proceed.
    const next = ReservationLedger.forGrant(grantFor(1), RUN);
    next.close();
  });

  it('takes over a lock whose holder is gone', () => {
    // A crashed runner must not wedge the run forever. pid 1 would be alive, so
    // use a pid that cannot be: the maximum plus one is never allocated.
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, 'spend.lock'), JSON.stringify({ pid: 2 ** 30, atIso: '2026-01-01T00:00:00Z' }));
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN);
    expect(JSON.parse(readFileSync(join(DIR, 'spend.lock'), 'utf8')).pid).toBe(process.pid);
    ledger.close();
    expect(existsSync(join(DIR, 'spend.lock'))).toBe(false);
  });
});
