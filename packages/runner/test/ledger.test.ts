import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, RUNS_DIR } from '../src/dataset.js';
import {
  BudgetExceededError,
  CapBreachedError,
  LedgerError,
  ReservationLedger,
} from '../src/ledger.js';
import { mintTestGrant } from './support/grant.js';

/**
 * BUDGET-001 — the reservation ledger.
 *
 * Offline: no client, no socket, no model. These are accounting tests.
 *
 * They are written to BREAK the ledger, in the two directions that cost money:
 * authorising more than the cap allows, and forgetting money that has already
 * been spent. Every "the call failed" path is therefore probed for a silent
 * refund, and every lock path for a stolen lock.
 */

const RUN = '__test-ledger-scratch';
const DIR = join(RUNS_DIR, RUN);
const LOCK = join(DIR, 'spend.lock');
const JOURNAL = join(DIR, 'spend.ndjson');

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

/** The test seam, used everywhere the lock is not itself the subject. */
function unlocked(budgetCapUsd: number, opts: { perModelCapUsd?: number; totalCapUsd?: number } = {}) {
  return ReservationLedger.forTests(grantFor(budgetCapUsd), RUN, { lock: false, ...opts });
}

function journalLines(): Array<Record<string, unknown>> {
  if (!existsSync(JOURNAL)) return [];
  return readFileSync(JOURNAL, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('the check-then-record race is closed', () => {
  it('never authorises more concurrent calls than the cap allows', async () => {
    // The old shape: assertCanSpend(...); await call; record(...). Four
    // concurrent tasks each passed a check against a total none of them had yet
    // added to, so a $1.00 cap authorised 4 x $0.40 = $1.60 of calls.
    const ledger = unlocked(1);
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
    const ledger = unlocked(1);
    ledger.reserve('openai/gpt-5.5', 0.9);
    expect(ledger.settledUsd).toBe(0); // nothing spent yet...
    expect(ledger.committedUsd).toBeCloseTo(0.9, 10); // ...but it is committed
    expect(() => ledger.reserve('openai/gpt-5.5', 0.2)).toThrow(BudgetExceededError);
  });

  it('gives the money back when a call never happens', () => {
    const ledger = unlocked(1);
    const r = ledger.reserve('openai/gpt-5.5', 0.9);
    ledger.releaseUncharged(r, 'DNS failure: the request was never sent');
    expect(ledger.committedUsd).toBe(0);
    expect(ledger.openReservations).toBe(0);
    expect(ledger.stateOf(r)).toBe('released-uncharged');
    expect(() => ledger.reserve('openai/gpt-5.5', 0.9)).not.toThrow();
  });

  it('refuses to settle or release the same reservation twice', () => {
    const ledger = unlocked(5);
    const r = ledger.reserve('openai/gpt-5.5', 1);
    ledger.settle(r, 0.5);
    expect(() => ledger.settle(r, 0.5)).toThrow(LedgerError);
    expect(() => ledger.releaseUncharged(r, 'second thoughts')).toThrow(LedgerError);
    expect(() => ledger.retainUnreconciled(r, 'third thoughts')).toThrow(LedgerError);
    expect(ledger.settledUsd).toBeCloseTo(0.5, 10);
    // The refusal names the state it already reached, so a double-resolve is
    // diagnosable rather than merely refused.
    expect(() => ledger.settle(r, 0.5)).toThrow(/settled/);
  });

  it('applies a per-model cap independently of the total', () => {
    const ledger = unlocked(10, { perModelCapUsd: 1 });
    ledger.settle(ledger.reserve('openai/gpt-5.5', 1), 1);
    expect(() => ledger.reserve('openai/gpt-5.5', 0.1)).toThrow(/model:openai/);
    expect(() => ledger.reserve('anthropic/claude-opus-5', 0.1)).not.toThrow();
  });

  it('books spend against the reserved model, not against the handle it is given', () => {
    // A Reservation is an ordinary object; a caller can hand back one whose
    // modelId says something else. Attribution must come from the ledger's own
    // record or a per-model cap can be walked past by relabelling.
    const ledger = unlocked(10, { perModelCapUsd: 1 });
    const real = ledger.reserve('openai/gpt-5.5', 0.9);
    ledger.settle({ ...real, modelId: 'anthropic/claude-opus-5' }, 0.9);
    expect(ledger.settledByModel()['openai/gpt-5.5']).toBeCloseTo(0.9, 10);
    expect(ledger.settledByModel()['anthropic/claude-opus-5']).toBeUndefined();
    expect(() => ledger.reserve('openai/gpt-5.5', 0.2)).toThrow(/model:openai/);
  });
});

/**
 * The gap that made BUDGET-001 falsely closed: a reservation had exactly two
 * endings, and one of them assumed a failed call had cost nothing.
 */
describe('a reservation always reaches an explicit terminal state', () => {
  it('distinguishes settled, released-uncharged and retained-unreconciled', () => {
    const ledger = unlocked(10);
    const settled = ledger.reserve('openai/gpt-5.5', 1);
    const released = ledger.reserve('openai/gpt-5.5', 1);
    const retained = ledger.reserve('openai/gpt-5.5', 1);
    expect(ledger.stateOf(settled)).toBe('open');

    ledger.settle(settled, 0.25);
    ledger.releaseUncharged(released, 'connection refused before the request was sent');
    ledger.retainUnreconciled(retained, 'HTTP 200 with an unreadable body');

    expect(ledger.stateOf(settled)).toBe('settled');
    expect(ledger.stateOf(released)).toBe('released-uncharged');
    expect(ledger.stateOf(retained)).toBe('retained-unreconciled');
    expect(ledger.openReservations).toBe(0);

    // The retained hold is CHARGED, not refunded: $1 reserved, cost unknown.
    expect(ledger.settledUsd).toBeCloseTo(0.25, 10);
    expect(ledger.unreconciledUsd).toBeCloseTo(1, 10);
    expect(ledger.chargedUsd).toBeCloseTo(1.25, 10);
    expect(ledger.chargedByModel()['openai/gpt-5.5']).toBeCloseTo(1.25, 10);
  });

  it('refuses to know the state of a reservation it never issued', () => {
    const ledger = unlocked(10);
    expect(() => ledger.stateOf({ id: 999, modelId: 'x', reservedUsd: 1 })).toThrow(
      /never issued/,
    );
  });

  it('keeps a retained reservation against the cap, so the run stops rather than overspending', () => {
    // The failure this exists for: three unreadable-but-billed responses were
    // refunded in full, and the fourth call was authorised against a cap that
    // had already been spent.
    const ledger = unlocked(1);
    for (let i = 0; i < 2; i++) {
      ledger.retainUnreconciled(ledger.reserve('openai/gpt-5.5', 0.4), 'body died in transit');
    }
    expect(ledger.settledUsd).toBe(0); // nothing PRICED...
    expect(ledger.committedUsd).toBeCloseTo(0.8, 10); // ...but $0.80 charged
    expect(() => ledger.reserve('openai/gpt-5.5', 0.4)).toThrow(BudgetExceededError);
  });

  it('refuses a settlement with no usable cost instead of recording zero', () => {
    // `Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0` was the
    // defect: an unpriced response settled as a free one, and the cap got its
    // money back for a call the provider had charged for.
    const ledger = unlocked(10);
    for (const bad of [undefined, null, Number.NaN, Infinity, -1, '0.5']) {
      const r = ledger.reserve('openai/gpt-5.5', 1);
      expect(() => ledger.settle(r, bad as never), `cost ${String(bad)} was accepted`).toThrow(
        /Missing provider cost is not zero cost/,
      );
      // The hold survives the refusal — over-counting is the safe direction —
      // and no journal line claims a charge that was never decided.
      expect(ledger.stateOf(r)).toBe('open');
      ledger.retainUnreconciled(r, 'unpriced');
    }
    expect(journalLines().every((l) => l.state === 'retained-unreconciled')).toBe(true);
    // A genuine zero — a free model — is still a settlement.
    const free = ledger.reserve('openai/gpt-5.5', 0);
    expect(() => ledger.settle(free, 0)).not.toThrow();
  });

  it('journals the reason a reservation ended the way it did', () => {
    // The classification is a judgement made from an errno or a status code.
    // An auditor has to be able to read which judgement was made and disagree.
    const ledger = unlocked(10);
    ledger.releaseUncharged(ledger.reserve('openai/gpt-5.5', 1), 'ECONNREFUSED');
    ledger.retainUnreconciled(ledger.reserve('openai/gpt-5.5', 2), 'HTTP 502 after generation');
    const [released, retained] = journalLines();
    expect(released).toMatchObject({ state: 'released-uncharged', actualUsd: 0, reservedUsd: 1, reason: 'ECONNREFUSED' });
    expect(retained).toMatchObject({ state: 'retained-unreconciled', actualUsd: 2, reservedUsd: 2 });
    expect(String(retained!.reason)).toContain('502');
  });
});

describe('settlement can never authorise more than the cap', () => {
  it('latches a breach when settled cost exceeds its reservation and the ceiling', () => {
    // Reserving is a promise about the future; the provider decides the past.
    // If the bill comes in over the cap the money is gone — the only thing left
    // to protect is every subsequent call.
    const ledger = unlocked(1);
    const r = ledger.reserve('openai/gpt-5.5', 0.9);
    expect(() => ledger.settle(r, 1.4)).toThrow(CapBreachedError);
    expect(ledger.capBreached).toBe(true);
    expect(ledger.chargedUsd).toBeCloseTo(1.4, 10); // recorded, not discarded
    // Even a free call is refused afterwards: the scope is over its ceiling,
    // not merely full, so `committed + 0 > cap` is not the check that matters.
    expect(() => ledger.reserve('openai/gpt-5.5', 0)).toThrow(CapBreachedError);
    expect(journalLines()).toHaveLength(1); // and the overspend is on disk
  });

  it('latches a per-model breach without condemning other models', () => {
    const ledger = unlocked(10, { perModelCapUsd: 1 });
    expect(() => ledger.settle(ledger.reserve('openai/gpt-5.5', 0.9), 1.5)).toThrow(
      /model:openai/,
    );
    expect(() => ledger.reserve('openai/gpt-5.5', 0.01)).toThrow(CapBreachedError);
    expect(() => ledger.reserve('anthropic/claude-opus-5', 0.01)).not.toThrow();
  });

  it('refuses to open a ledger whose journal already exceeds the cap', () => {
    // Restart is the obvious way to launder a breach: the latch lives in
    // memory, so replay has to reach the same conclusion from the journal.
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      JOURNAL,
      `${JSON.stringify({ atIso: 'x', permitId: 'p', modelId: 'openai/gpt-5.5', actualUsd: 3, state: 'settled' })}\n`,
    );
    expect(() => unlocked(1)).toThrow(CapBreachedError);
  });

  it('refuses to authorise anything after the ledger is closed', () => {
    // Closing releases the run lock, so another runner may already be spending
    // against this cap. A late in-flight task must not reserve into that.
    const ledger = ReservationLedger.forTests(grantFor(10), RUN, { lock: false });
    ledger.close();
    expect(() => ledger.reserve('openai/gpt-5.5', 0.1)).toThrow(LedgerError);
    expect(() => ledger.reserve('openai/gpt-5.5', 0.1)).toThrow(/closed/);
  });
});

describe('the cap comes from the permit', () => {
  it('lets an operator sub-cap lower the ceiling but never raise it', () => {
    const grant = grantFor(10);
    expect(ReservationLedger.forTests(grant, RUN, { lock: false, totalCapUsd: 2 }).capUsd).toBe(2);
    // A caller-supplied number that could raise the approved cap would make the
    // permit's budget advisory.
    expect(ReservationLedger.forTests(grant, RUN, { lock: false, totalCapUsd: 999 }).capUsd).toBe(10);
  });

  it('cannot be built from anything but a verified grant', () => {
    const forged = { permitId: 'x', budgetCapUsd: 1e9, capabilities: [], cells: [] } as never;
    expect(() => ReservationLedger.forGrant(forged, RUN)).toThrow(
      /did not mint by verifying a signed permit/,
    );
    expect(() => ReservationLedger.forTests(forged, RUN, { lock: false })).toThrow(
      /did not mint by verifying a signed permit/,
    );
  });

  it('refuses to spend against a published run', () => {
    expect(() => ReservationLedger.forGrant(grantFor(1), '2026-07-v2.1')).toThrow(
      /historical and immutable/,
    );
  });

  it('does not let a production caller turn off the lock or the clock', () => {
    // The architectural rule this enforces: test-time dependency injection must
    // not be reachable through the production boundary. `forGrant` takes two
    // numbers, both of which can only tighten; a stray `{ lock: false }` from a
    // production call site therefore changes nothing rather than disabling the
    // two-runners guard.
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN, {
      totalCapUsd: 1,
      lock: false,
      now: () => new Date('2000-01-01T00:00:00Z'),
    } as never);
    try {
      expect(existsSync(LOCK)).toBe(true); // locked anyway
      const settled = ledger.reserve('openai/gpt-5.5', 0.1);
      ledger.settle(settled, 0.1);
      expect(journalLines()[0]!.atIso).not.toContain('2000-01-01'); // real clock
    } finally {
      ledger.close();
    }
  });

  it('keeps the test seam out of production code', () => {
    // A seam nothing in src/ calls is a seam that cannot be an off switch. This
    // is the check that keeps it that way as the runner grows.
    const srcDir = join(REPO_ROOT, 'packages/runner/src');
    const offenders = readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts') && f !== 'ledger.ts')
      .filter((f) => /ReservationLedger\.forTests|forTests\(/.test(readFileSync(join(srcDir, f), 'utf8')));
    expect(offenders, 'production code reached the ledger test seam').toEqual([]);
  });
});

describe('spend survives the process', () => {
  it('replays prior spend so a resumed run does not spend its cap twice', () => {
    const first = unlocked(1);
    first.settle(first.reserve('openai/gpt-5.5', 0.6), 0.6);
    expect(existsSync(JOURNAL)).toBe(true);

    const resumed = unlocked(1);
    expect(resumed.settledUsd).toBeCloseTo(0.6, 10);
    expect(() => resumed.reserve('openai/gpt-5.5', 0.5)).toThrow(BudgetExceededError);
  });

  it('replays a retained charge, so a crash does not launder an unknown cost', () => {
    // Restart is the other way to get a refund for free: if replay only counted
    // settlements, killing the process would drop every conservative hold and
    // hand the cap back money that may already have been taken.
    const first = unlocked(1);
    first.retainUnreconciled(first.reserve('openai/gpt-5.5', 0.7), 'unreadable 200');

    const resumed = unlocked(1);
    expect(resumed.settledUsd).toBe(0);
    expect(resumed.unreconciledUsd).toBeCloseTo(0.7, 10);
    expect(resumed.chargedUsd).toBeCloseTo(0.7, 10);
    expect(resumed.unreconciledByModel()['openai/gpt-5.5']).toBeCloseTo(0.7, 10);
    expect(() => resumed.reserve('openai/gpt-5.5', 0.4)).toThrow(BudgetExceededError);
  });

  it('ignores a released-uncharged line on replay, because nothing was spent', () => {
    const first = unlocked(1);
    first.releaseUncharged(first.reserve('openai/gpt-5.5', 0.9), 'ENOTFOUND');
    expect(journalLines()).toHaveLength(1); // still audited...
    expect(unlocked(1).chargedUsd).toBe(0); // ...but not charged
  });

  it('appends rather than replaces, so no earlier entry can be lost', () => {
    const ledger = unlocked(5);
    ledger.settle(ledger.reserve('openai/gpt-5.5', 1), 0.1);
    ledger.settle(ledger.reserve('openai/gpt-5.5', 1), 0.2);
    const lines = journalLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.actualUsd).toBe(0.1);
    expect(lines[0]!.permitId).toBe('permit-ledger-001');
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
    const ledger = unlocked(1);
    const r = ledger.reserve('openai/gpt-5.5', 0.6);
    symlinkSync(join(DIR, 'elsewhere.ndjson'), JOURNAL);

    expect(() => ledger.settle(r, 0.6)).toThrow(/symlink/i);

    // Over-counting is the safe direction: the hold survives, so the cap stays
    // consumed. Before the fix all three of these read as if nothing had been
    // spent at all.
    expect(ledger.openReservations).toBe(1);
    expect(ledger.committedUsd).toBeCloseTo(0.6, 10);
    expect(() => ledger.reserve('openai/gpt-5.5', 0.5)).toThrow(BudgetExceededError);
    expect(existsSync(join(DIR, 'elsewhere.ndjson'))).toBe(false); // and nothing followed the link

    // The same ordering protects the two new terminal states.
    expect(() => ledger.retainUnreconciled(r, 'still unknown')).toThrow(/symlink/i);
    expect(ledger.openReservations).toBe(1);
    expect(() => ledger.releaseUncharged(r, 'never sent')).toThrow(/symlink/i);
    expect(ledger.openReservations).toBe(1);
  });

  it('writes no journal line for a settle it is going to refuse', () => {
    // The trap in "journal first": appending before validating would record a
    // charge for a double settle that never happened, and the next resume would
    // inherit it. Validation has to come first, then the journal, then the books.
    const ledger = unlocked(5);
    const r = ledger.reserve('openai/gpt-5.5', 1);
    ledger.settle(r, 0.5);
    expect(() => ledger.settle(r, 0.5)).toThrow(LedgerError);
    expect(journalLines()).toHaveLength(1);
    expect(ledger.settledUsd).toBeCloseTo(0.5, 10);
  });

  it('refuses to run against a corrupt journal rather than assuming zero', () => {
    // "Assume nothing was spent" is how a resumed run spends its cap a second
    // time — the same fail-open shape as the historical registry bug.
    mkdirSync(DIR, { recursive: true });
    for (const contents of ['{ not json\n', '{"actualUsd": "lots"}\n', '{"actualUsd": -5}\n']) {
      writeFileSync(JOURNAL, contents);
      expect(() => unlocked(1)).toThrow(LedgerError);
    }
  });

  it('refuses a journal whose terminal state this build cannot interpret', () => {
    // A future state — say `refunded-by-provider` — must not be read as zero by
    // a build that predates it. Unknown means unknown means stop.
    mkdirSync(DIR, { recursive: true });
    writeFileSync(
      JOURNAL,
      `${JSON.stringify({ atIso: 'x', permitId: 'p', modelId: 'm', actualUsd: 0.5, state: 'refunded-later' })}\n`,
    );
    expect(() => unlocked(5)).toThrow(/does not understand/);
  });
});

describe('two runners cannot each spend the whole cap', () => {
  /** A lock file exactly as another process would have left it. */
  function writeLock(record: Record<string, unknown> | string, ageMs = 0): void {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(LOCK, typeof record === 'string' ? record : JSON.stringify(record));
    if (ageMs > 0) {
      const when = new Date(Date.now() - ageMs);
      utimesSync(LOCK, when, when);
    }
  }

  it('refuses a second ledger while the first holds the lock', () => {
    const held = ReservationLedger.forGrant(grantFor(1), RUN);
    try {
      // Same process: reentrancy is not a lock either. Two ledgers would each
      // debit their own totals against one cap and one journal.
      expect(() => ReservationLedger.forGrant(grantFor(1), RUN)).toThrow(/already locked by THIS process/);
    } finally {
      held.close();
    }
    // Released, so the next runner may proceed.
    const next = ReservationLedger.forGrant(grantFor(1), RUN);
    next.close();
  });

  it('refuses a lock whose holder is alive, because a live pid is never broken', () => {
    // pid 1 exists in every container. `process.kill(1, 0)` answers EPERM for a
    // non-root caller, and the old liveness check caught every error and
    // answered "dead" — so a lock held by a runner under another account was
    // declared stale and stolen. EPERM means the process EXISTS.
    writeLock({ version: 2, nonce: 'other-runner', pid: 1, hostname: hostname(), runId: RUN, atIso: 'x' });
    expect(() => ReservationLedger.forGrant(grantFor(1), RUN)).toThrow(/already being spent against by pid 1/);
    expect(JSON.parse(readFileSync(LOCK, 'utf8')).nonce).toBe('other-runner'); // untouched
  });

  it('takes over a lock whose holder is gone', () => {
    // A crashed runner must not wedge the run forever. pid 1 would be alive, so
    // use a pid that cannot be: the maximum plus one is never allocated.
    writeLock({ version: 2, nonce: 'crashed', pid: 2 ** 30, hostname: hostname(), runId: RUN, atIso: 'x' });
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN);
    expect(JSON.parse(readFileSync(LOCK, 'utf8')).pid).toBe(process.pid);
    ledger.close();
    expect(existsSync(LOCK)).toBe(false);
  });

  it('will not break a lock claimed by another host, whatever its pid says', () => {
    // A pid number means nothing off the machine that issued it, so liveness
    // cannot be evaluated at all — and "dead here" would steal a live lock on a
    // shared filesystem.
    writeLock({ version: 2, nonce: 'elsewhere', pid: 2 ** 30, hostname: 'some-other-host', runId: RUN, atIso: 'x' });
    expect(() => ReservationLedger.forGrant(grantFor(1), RUN)).toThrow(/another host/);
  });

  it('treats an empty or unreadable lock as unidentifiable, not as stale', () => {
    // THE RACE THIS CLOSES. The old acquire created the lock with open(wx) and
    // wrote the pid afterwards, so between those two syscalls the file existed
    // and was empty. A second process read it, found no pid, concluded "stale",
    // deleted a lock that was one syscall old and took over — and both then
    // spent the full cap. An unreadable lock is not evidence of a dead holder.
    for (const contents of ['', '{ partial', '{"pid":123}']) {
      writeLock(contents as never);
      expect(() => ReservationLedger.forGrant(grantFor(1), RUN), `contents ${contents}`).toThrow(
        /no identity this build can read/,
      );
      expect(readFileSync(LOCK, 'utf8')).toBe(contents); // and it was not stolen
    }
  });

  it('breaks an unidentifiable lock only once it is provably stale', () => {
    writeLock('' as never, 20 * 60_000); // older than the 15-minute window
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN);
    expect(JSON.parse(readFileSync(LOCK, 'utf8')).pid).toBe(process.pid);
    ledger.close();
  });

  it('writes its own lock complete, with an identity that is not a pid', () => {
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN);
    try {
      const record = JSON.parse(readFileSync(LOCK, 'utf8'));
      expect(record).toMatchObject({ version: 2, pid: process.pid, hostname: hostname(), runId: RUN });
      expect(String(record.nonce)).toMatch(/^[0-9a-f-]{36}$/); // 128 random bits, not a pid
      // No staging file is left behind to be mistaken for a lock.
      expect(readdirSync(DIR).filter((f) => f.includes('.claim-'))).toEqual([]);
    } finally {
      ledger.close();
    }
  });

  it('never removes a lock that is no longer ours', () => {
    // The other half of the ownership race: close() did an unconditional
    // rmSync, so a runner whose lock had been taken over deleted the NEW
    // holder's lock on its way out, and a third runner walked straight in.
    const ledger = ReservationLedger.forGrant(grantFor(1), RUN);
    const ours = JSON.parse(readFileSync(LOCK, 'utf8')).nonce;
    // Simulate a takeover: a different file, at the same path.
    unlinkSync(LOCK);
    writeFileSync(LOCK, JSON.stringify({ version: 2, nonce: 'someone-else', pid: 1, hostname: hostname(), runId: RUN, atIso: 'x' }));
    const inode = lstatSync(LOCK).ino;

    ledger.close();

    expect(existsSync(LOCK)).toBe(true);
    expect(JSON.parse(readFileSync(LOCK, 'utf8')).nonce).toBe('someone-else');
    expect(JSON.parse(readFileSync(LOCK, 'utf8')).nonce).not.toBe(ours);
    expect(lstatSync(LOCK).ino).toBe(inode); // same file, untouched
  });

  it('refuses to remove or trust a symlinked lock', () => {
    mkdirSync(DIR, { recursive: true });
    symlinkSync(join(DIR, 'somewhere-else.json'), LOCK);
    // Refused by the firewall's symlink-component check before the ledger sees
    // it, and refused again by the lock inspector if one appears later. Either
    // way nothing is written through the link and the link is not removed.
    expect(() => ReservationLedger.forGrant(grantFor(1), RUN)).toThrow(/symlink/i);
    expect(existsSync(join(DIR, 'somewhere-else.json'))).toBe(false);
    expect(lstatSync(LOCK).isSymbolicLink()).toBe(true); // still there, still refused
  });
});
