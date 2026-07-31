import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { appendRunFileLine, resolveRunDir, resolveRunFile } from './firewall.js';
import { assertVerifiedGrant, type VerifiedGrant } from './permit.js';

/**
 * BUDGET-001 — the reservation ledger.
 *
 * The defect this replaces: `BudgetGuard.assertCanSpend()` and `record()` were
 * two calls with the model request in between. Every concurrent call therefore
 * checked against a total that none of them had yet added to, so at concurrency
 * 4 the guard could authorise four calls that each individually fit under a cap
 * they collectively blow. A check whose result is stale by the time it is acted
 * on is not a cap; it is a suggestion.
 *
 * The fix is to make the reservation itself the commitment. `reserve()` checks
 * and debits in ONE synchronous step with no `await` anywhere inside it, so no
 * other task can interleave between the two — that is what "atomic" means on a
 * single-threaded runtime, and it is the whole reason the race existed.
 *
 * Three things follow from money being involved:
 *
 *   - The ceiling comes from a verified grant, not from a constructor
 *     argument. A budget a caller passes in is a budget a caller can raise.
 *   - Spend is journalled to disk as it settles, and replayed on construction,
 *     so a resumed run inherits what earlier batches already spent instead of
 *     starting from zero against the same cap.
 *   - A run directory is locked for the duration, so two `bench run`
 *     invocations cannot each spend the full cap against one run.
 */

export class BudgetExceededError extends Error {
  constructor(
    readonly scope: 'total' | `model:${string}`,
    readonly committedUsd: number,
    readonly capUsd: number,
    readonly nextUsd: number,
  ) {
    super(
      `Budget cap reached for ${scope}: $${committedUsd.toFixed(4)} committed of $${capUsd.toFixed(2)}, ` +
        `and the next call reserves $${nextUsd.toFixed(4)}. Aborting before the call — completed work is saved.`,
    );
    this.name = 'BudgetExceededError';
  }
}

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: 'LEDGER_LOCKED' | 'LEDGER_CORRUPT' | 'RESERVATION_UNKNOWN' | 'RESERVATION_SETTLED',
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/** An opaque handle. Settling twice, or settling a released reservation, throws. */
export interface Reservation {
  readonly id: number;
  readonly modelId: string;
  readonly reservedUsd: number;
}

interface JournalEntry {
  atIso: string;
  permitId: string;
  modelId: string;
  actualUsd: number;
}

const JOURNAL_FILE = 'spend.ndjson';
const LOCK_FILE = 'spend.lock';

export interface LedgerOptions {
  /**
   * An operator sub-cap for this invocation, e.g. `--budget`.
   *
   * Clamped with `Math.min` against the grant, so it can only ever LOWER the
   * ceiling. A caller-supplied number that could raise the approved cap would
   * make the permit's budget advisory.
   */
  totalCapUsd?: number;
  /** Per-model ceiling. Defaults to the grant's total, i.e. no extra bound. */
  perModelCapUsd?: number;
  /** Set false in tests that do not want a lock file on disk. */
  lock?: boolean;
  /** Injected clock, so journal entries are deterministic under test. */
  now?: () => Date;
}

export class ReservationLedger {
  readonly #grant: VerifiedGrant;
  readonly #runId: string;
  readonly #totalCapUsd: number;
  readonly #perModelCapUsd: number;
  readonly #now: () => Date;

  #settledTotal = 0;
  #outstandingTotal = 0;
  readonly #settledByModel = new Map<string, number>();
  readonly #outstandingByModel = new Map<string, number>();
  readonly #open = new Map<number, Reservation>();
  #nextId = 1;
  #lockPath: string | null = null;
  #released = false;

  private constructor(grant: VerifiedGrant, runId: string, opts: LedgerOptions) {
    this.#grant = grant;
    this.#runId = runId;
    this.#totalCapUsd = Math.min(grant.budgetCapUsd, opts.totalCapUsd ?? Infinity);
    this.#perModelCapUsd = Math.min(this.#totalCapUsd, opts.perModelCapUsd ?? Infinity);
    this.#now = opts.now ?? (() => new Date());
    // Preflight the WRITE target before a single call is authorised. Without
    // this, a ledger for a frozen run constructs happily, authorises spend, and
    // only discovers the refusal when it tries to journal the first settlement
    // — i.e. after the money has left. Same lesson as the calibration gate.
    resolveRunDir(runId, { write: true });
    this.#replayJournal();
    if (opts.lock !== false) this.#acquireLock();
  }

  /**
   * The only way to get a ledger. The cap is the grant's, so there is no
   * constructor overload that takes a number a caller chose.
   */
  static forGrant(grant: VerifiedGrant, runId: string, opts: LedgerOptions = {}): ReservationLedger {
    assertVerifiedGrant(grant, 'ReservationLedger.forGrant');
    return new ReservationLedger(grant, runId, opts);
  }

  // --- durability ----------------------------------------------------------

  #replayJournal(): void {
    const path = join(resolveRunDir(this.#runId, { write: false }), JOURNAL_FILE);
    if (!existsSync(path)) return;
    let lineNo = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      lineNo++;
      if (!line.trim()) continue;
      let entry: JournalEntry;
      try {
        entry = JSON.parse(line) as JournalEntry;
      } catch {
        // Refusing is the only safe reading. An unparseable journal means we do
        // not know what has been spent, and "assume zero" is how a resumed run
        // spends its cap a second time.
        throw new LedgerError(
          `Spend journal ${path}:${lineNo} is not valid JSON. Refusing to run with an unknown prior spend.`,
          'LEDGER_CORRUPT',
        );
      }
      if (typeof entry.actualUsd !== 'number' || !Number.isFinite(entry.actualUsd) || entry.actualUsd < 0) {
        throw new LedgerError(
          `Spend journal ${path}:${lineNo} has a non-numeric or negative amount.`,
          'LEDGER_CORRUPT',
        );
      }
      this.#settledTotal += entry.actualUsd;
      this.#settledByModel.set(
        entry.modelId,
        (this.#settledByModel.get(entry.modelId) ?? 0) + entry.actualUsd,
      );
    }
  }

  /**
   * Exclusive lock on the run, via `open(..., 'wx')` — which fails if the file
   * exists, atomically, at the filesystem level.
   *
   * A stale lock from a crashed process would otherwise wedge the run forever,
   * so the holder's pid is recorded and a lock whose holder is gone is taken
   * over. `process.kill(pid, 0)` sends no signal; it only asks whether the
   * process exists.
   */
  #acquireLock(): void {
    const path = resolveRunFile(this.#runId, LOCK_FILE, { write: true });
    mkdirSync(dirname(path), { recursive: true }); // a new run has no directory yet
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(path, 'wx');
        writeSync(fd, JSON.stringify({ pid: process.pid, atIso: this.#now().toISOString() }));
        closeSync(fd);
        this.#lockPath = path;
        return;
      } catch {
        const holder = readLockHolder(path);
        if (holder !== null && isProcessAlive(holder)) {
          throw new LedgerError(
            `Run ${this.#runId} is already being spent against by pid ${holder}. ` +
              `Two runners sharing one budget cap would each spend it in full.`,
            'LEDGER_LOCKED',
          );
        }
        rmSync(path, { force: true }); // stale: holder is gone
      }
    }
    throw new LedgerError(`Could not acquire the spend lock for run ${this.#runId}.`, 'LEDGER_LOCKED');
  }

  /** Release the lock. Safe to call more than once. */
  close(): void {
    if (this.#lockPath && !this.#released) {
      rmSync(this.#lockPath, { force: true });
      this.#released = true;
    }
  }

  // --- the atomic step -----------------------------------------------------

  /**
   * Check and debit in one synchronous step. THERE MUST BE NO `await` IN HERE.
   *
   * Adding one would reintroduce exactly the race this class exists to close:
   * every concurrent caller would resume having checked against a total none of
   * them had yet committed to.
   */
  reserve(modelId: string, estimateUsd: number): Reservation {
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) {
      throw new LedgerError(`Refusing to reserve a non-finite or negative amount for ${modelId}.`, 'LEDGER_CORRUPT');
    }
    const committedTotal = this.#settledTotal + this.#outstandingTotal;
    if (committedTotal + estimateUsd > this.#totalCapUsd) {
      throw new BudgetExceededError('total', committedTotal, this.#totalCapUsd, estimateUsd);
    }
    const committedModel =
      (this.#settledByModel.get(modelId) ?? 0) + (this.#outstandingByModel.get(modelId) ?? 0);
    if (committedModel + estimateUsd > this.#perModelCapUsd) {
      throw new BudgetExceededError(`model:${modelId}`, committedModel, this.#perModelCapUsd, estimateUsd);
    }
    const reservation: Reservation = Object.freeze({
      id: this.#nextId++,
      modelId,
      reservedUsd: estimateUsd,
    });
    this.#outstandingTotal += estimateUsd;
    this.#outstandingByModel.set(modelId, (this.#outstandingByModel.get(modelId) ?? 0) + estimateUsd);
    this.#open.set(reservation.id, reservation);
    return reservation;
  }

  /**
   * The call happened and cost this much.
   *
   * Three steps, in this order, and the order is the whole point:
   *
   *   1. VALIDATE the reservation without touching the books. A double settle
   *      must be refused before anything durable is written, or the refusal
   *      leaves a spurious journal line behind and the next resume inherits a
   *      charge that never happened.
   *   2. JOURNAL, while the reservation is still outstanding.
   *   3. Move the books — release the hold, add the settled amount.
   *
   * The failure this ordering exists for: the first version closed the
   * reservation FIRST and journalled second, under a comment claiming it did
   * the opposite. A throw from the append (a symlinked journal, a full disk, a
   * frozen run) therefore removed the hold and never added the settlement, so
   * money that had genuinely left the account vanished from the accounting
   * entirely and the freed headroom could be spent a second time. Journalling
   * first inverts that: a failure leaves the reservation held, which
   * OVER-counts committed spend. Over-counting stops early and is visible;
   * under-counting overspends the cap silently. There is only one safe
   * direction for an accounting error involving real money.
   */
  settle(reservation: Reservation, actualUsd: number): void {
    // Attribution comes from the ledger's own record of the reservation, not
    // from the handle the caller passed back — a handle is just an object, and
    // spend must be booked against the model that was actually reserved.
    const open = this.#requireOpen(reservation);
    const amount = Number.isFinite(actualUsd) && actualUsd > 0 ? actualUsd : 0;
    appendRunFileLine(
      this.#runId,
      JOURNAL_FILE,
      JSON.stringify({
        atIso: this.#now().toISOString(),
        permitId: this.#grant.permitId,
        modelId: open.modelId,
        actualUsd: amount,
      } satisfies JournalEntry),
    );
    // Nothing between here and the end of the method may throw: `#take` was
    // pre-validated above and both map updates are total.
    this.#take(reservation);
    this.#settledTotal += amount;
    this.#settledByModel.set(open.modelId, (this.#settledByModel.get(open.modelId) ?? 0) + amount);
  }

  /** The call never happened (network failure, refusal). No spend recorded. */
  release(reservation: Reservation): void {
    this.#take(reservation);
  }

  /**
   * Prove a reservation is open, WITHOUT mutating anything.
   *
   * Split out of `#take` so `settle` can refuse a double settle before it
   * writes to the journal. Combining the two is what forced the wrong ordering.
   */
  #requireOpen(reservation: Reservation): Reservation {
    const open = this.#open.get(reservation.id);
    if (!open) {
      throw new LedgerError(
        `Reservation ${reservation.id} is unknown or already closed. Double-settling would understate committed spend.`,
        'RESERVATION_SETTLED',
      );
    }
    return open;
  }

  /** Remove a reservation from the outstanding books exactly once. */
  #take(reservation: Reservation): void {
    const open = this.#requireOpen(reservation);
    this.#open.delete(reservation.id);
    this.#outstandingTotal -= open.reservedUsd;
    this.#outstandingByModel.set(
      open.modelId,
      (this.#outstandingByModel.get(open.modelId) ?? 0) - open.reservedUsd,
    );
  }

  // --- reporting -----------------------------------------------------------

  /** Spend already incurred. */
  get settledUsd(): number {
    return this.#settledTotal;
  }

  /** Spend incurred plus spend promised. This is what the cap applies to. */
  get committedUsd(): number {
    return this.#settledTotal + this.#outstandingTotal;
  }

  get capUsd(): number {
    return this.#totalCapUsd;
  }

  get openReservations(): number {
    return this.#open.size;
  }

  settledByModel(): Record<string, number> {
    return Object.fromEntries(this.#settledByModel);
  }
}

function readLockHolder(path: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(path, 'utf8')) as { pid?: unknown }).pid;
    return typeof pid === 'number' ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
