import type { Stats } from 'node:fs';
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendRunFileLine, resolveRunFile } from './firewall.js';
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
 * WHAT THE CAP BINDS — and the second review that widened it.
 *
 * BUDGET-001 says "concurrent requests AND RETRIES cannot exceed the manifest
 * cap". The first version of this file bound RESERVATIONS, not spend: one
 * `reserve()` in `OpenRouterClient.complete` covered up to MAX_ATTEMPTS = 5
 * billable POSTs, so a single reservation funded five requests and a run could
 * spend five times its cap while every individual check passed. The cap is now
 * hard for reservations AND for attempts: every potentially billable HTTP
 * attempt takes its own reservation, priced from the request that attempt will
 * actually send (see `openrouter.ts`).
 *
 * THE PROVIDER-SIDE KEY LIMIT REMAINS THE FINAL EXTERNAL BACKSTOP. This ledger
 * is an in-process accounting boundary: it can refuse to authorise the next
 * call, and it can refuse to keep running once it discovers an overspend, but
 * it cannot un-spend money that has already left the account, and it cannot see
 * spend made by any other process or key holder. Set a spend limit on the
 * OpenRouter key as well. That limit is the only control that is enforced by
 * the party actually taking the money.
 *
 * Four things follow from money being involved:
 *
 *   - The ceiling comes from a verified grant, not from a constructor
 *     argument. A budget a caller passes in is a budget a caller can raise.
 *   - Spend is journalled to disk as it settles, and replayed on construction,
 *     so a resumed run inherits what earlier batches already spent instead of
 *     starting from zero against the same cap.
 *   - A run directory is locked for the duration, so two `bench run`
 *     invocations cannot each spend the full cap against one run.
 *   - Every reservation reaches an EXPLICIT terminal state, and the only state
 *     that records zero is the one that can prove no request was ever sent.
 *     "The call failed, so it cost nothing" is a guess, and it is a guess in
 *     the direction that loses money silently.
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

/**
 * Raised when settlement discovers that money ALREADY SPENT exceeds the cap.
 *
 * Deliberately a different error from `BudgetExceededError`. That one means
 * "the next call would exceed the cap, so it was not made" — an orderly stop
 * with the books intact. This one means "a call that was authorised turned out
 * to cost more than its reservation, and the total is now over the ceiling":
 * the money is gone, the run must stop, and the operator has to reconcile
 * against the provider. Collapsing the two into one error would let a genuine
 * overspend be logged with the same shrug as a clean budget stop, which is how
 * an overspend gets discovered on an invoice instead of in a log.
 */
export class CapBreachedError extends Error {
  constructor(
    readonly scope: 'total' | `model:${string}`,
    readonly chargedUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `Cap BREACHED for ${scope}: $${chargedUsd.toFixed(4)} is already charged against a cap of $${capUsd.toFixed(2)}. ` +
        `Settled cost exceeded its reservation. No further spend will be authorised on this ledger; ` +
        `reconcile against the provider's own record, and note that the provider-side key limit is the only external backstop.`,
    );
    this.name = 'CapBreachedError';
  }
}

export type LedgerErrorCode =
  | 'LEDGER_LOCKED'
  | 'LEDGER_CORRUPT'
  | 'LEDGER_CLOSED'
  | 'RESERVATION_UNKNOWN'
  | 'RESERVATION_SETTLED'
  | 'COST_UNKNOWN';

export class LedgerError extends Error {
  constructor(
    message: string,
    readonly code: LedgerErrorCode,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

/**
 * How a reservation ended. There is no fourth option and no default.
 *
 * `settled`               — the provider reported a cost. That cost is charged.
 * `released-uncharged`    — the attempt PROVABLY never reached the provider, so
 *                           no money can have moved. The hold is given back.
 * `retained-unreconciled` — the attempt reached, or may have reached, the
 *                           provider, and we do not know what it cost. The full
 *                           reservation stays charged against the cap until a
 *                           human reconciles it against the provider's record.
 *
 * The old `release()` collapsed the last two, which meant a 200 whose body died
 * mid-transfer — a completion that was generated, billed, and lost in transit —
 * was refunded in full as though it had certainly cost nothing.
 */
export type TerminalState = 'settled' | 'released-uncharged' | 'retained-unreconciled';
export type ReservationState = 'open' | TerminalState;

const TERMINAL_STATES: ReadonlySet<string> = new Set<TerminalState>([
  'settled',
  'released-uncharged',
  'retained-unreconciled',
]);

/** An opaque handle. Settling twice, or settling a closed reservation, throws. */
export interface Reservation {
  readonly id: number;
  readonly modelId: string;
  readonly reservedUsd: number;
}

interface JournalEntry {
  atIso: string;
  permitId: string;
  modelId: string;
  /** What the ledger CHARGED for this attempt against the cap. */
  actualUsd: number;
  /**
   * Absent means `settled` — that is what the v1 writer meant by every line it
   * wrote, so replaying an old journal charges the money exactly as before.
   * An unrecognised value is corruption and refuses to load: a state this build
   * cannot interpret must not be silently counted as zero.
   */
  state?: TerminalState;
  /** What was held, for reconciling a retained entry against an invoice. */
  reservedUsd?: number;
  /** Why, in words, for the audit trail. */
  reason?: string;
}

const JOURNAL_FILE = 'spend.ndjson';
const LOCK_FILE = 'spend.lock';

/** Bumped when the lock record's meaning changes. v1 had no identity at all. */
const LOCK_VERSION = 2;

/**
 * How long an UNIDENTIFIABLE lock must sit before it may be broken.
 *
 * Only reached for a lock this build cannot read — a truncated file, a v1
 * record with no host identity, something a future version wrote. An
 * identifiable lock is decided on evidence (same host + dead pid), never on
 * age, because age is not evidence: a long batch legitimately holds its lock
 * for hours.
 */
const STALE_UNIDENTIFIABLE_LOCK_MS = 15 * 60_000;

interface LockRecord {
  version: number;
  /** THE identity. Not the pid — pids are reused, 128 random bits are not. */
  nonce: string;
  pid: number;
  hostname: string;
  runId: string;
  atIso: string;
}

/**
 * The PRODUCTION options. Two numbers, both of which can only tighten.
 *
 * There is deliberately no `lock` flag and no `now` here. A safeguard whose
 * definition the caller chooses is not a safeguard: `{ lock: false }` on the
 * production boundary is an off switch for the two-runners guard, and an
 * injected clock is an off switch for anything time-based. Tests need both,
 * so the seam is split — see `ReservationLedger.forTests`, which production
 * code never calls and a test in ledger.test.ts proves it never calls.
 */
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
}

/** Test-only additions. Never part of `LedgerOptions`; never reachable from `forGrant`. */
interface TestSeamOptions extends LedgerOptions {
  /** Set false to run without a lock file on disk. */
  lock?: boolean;
  /** Injected clock, so journal entries and lock ages are deterministic. */
  now?: () => Date;
}

export class ReservationLedger {
  readonly #grant: VerifiedGrant;
  readonly #runId: string;
  readonly #totalCapUsd: number;
  readonly #perModelCapUsd: number;
  readonly #now: () => Date;

  #settledTotal = 0;
  #unreconciledTotal = 0;
  #outstandingTotal = 0;
  readonly #settledByModel = new Map<string, number>();
  readonly #unreconciledByModel = new Map<string, number>();
  readonly #outstandingByModel = new Map<string, number>();
  readonly #open = new Map<number, Reservation>();
  readonly #terminal = new Map<number, TerminalState>();
  /**
   * Scopes whose cap has been BREACHED by settled spend, not merely reached.
   * Once a scope is in here nothing more is ever authorised against it.
   */
  readonly #breached = new Set<string>();
  #nextId = 1;
  #lockPath: string | null = null;
  #lockNonce: string | null = null;
  #lockIno: number | null = null;
  #lockDev: number | null = null;
  #closed = false;

  private constructor(grant: VerifiedGrant, runId: string, opts: TestSeamOptions) {
    this.#grant = grant;
    this.#runId = runId;
    this.#totalCapUsd = Math.min(grant.budgetCapUsd, opts.totalCapUsd ?? Infinity);
    this.#perModelCapUsd = Math.min(this.#totalCapUsd, opts.perModelCapUsd ?? Infinity);
    this.#now = opts.now ?? (() => new Date());
    // Preflight the WRITE target before a single call is authorised. Without
    // this, a ledger for a frozen run constructs happily, authorises spend, and
    // only discovers the refusal when it tries to journal the first settlement
    // — i.e. after the money has left. Same lesson as the calibration gate.
    //
    // The TARGET, not its directory: `appendRunFileLine` refuses a leaf symlink,
    // so a preflight that stops at the directory clears a path the write will
    // reject, which is the failure mode this preflight exists to prevent.
    resolveRunFile(runId, JOURNAL_FILE, { write: true });
    this.#replayJournal();
    if (opts.lock !== false) this.#acquireLock();
  }

  /**
   * The only PRODUCTION way to get a ledger. The cap is the grant's, so there
   * is no constructor overload that takes a number a caller chose, and the
   * options carry nothing that can weaken a guard.
   */
  static forGrant(grant: VerifiedGrant, runId: string, opts: LedgerOptions = {}): ReservationLedger {
    assertVerifiedGrant(grant, 'ReservationLedger.forGrant');
    // Spread deliberately narrow: only the two cap fields cross this boundary,
    // so an object carrying `lock: false` from a production call site changes
    // nothing rather than silently disabling the run lock.
    return new ReservationLedger(grant, runId, {
      totalCapUsd: opts.totalCapUsd,
      perModelCapUsd: opts.perModelCapUsd,
    });
  }

  /**
   * TEST SEAM. Do not call from `packages/runner/src` — there is a test that
   * greps for it and fails if production code ever does.
   *
   * Kept as a separate entry point rather than an extra field on
   * `LedgerOptions` because a test flag reachable through the production
   * boundary is a production flag with a comment on it. The lock and the clock
   * are the two things a caller must not be able to choose.
   */
  static forTests(grant: VerifiedGrant, runId: string, opts: TestSeamOptions = {}): ReservationLedger {
    assertVerifiedGrant(grant, 'ReservationLedger.forTests');
    return new ReservationLedger(grant, runId, opts);
  }

  // --- durability ----------------------------------------------------------

  #replayJournal(): void {
    // Leaf-resolved: replaying a LINKED journal would read another run's spend
    // as this run's prior, and "what has this run already spent" is the number
    // the whole cap rests on.
    const path = resolveRunFile(this.#runId, JOURNAL_FILE, { write: false });
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
      // Absent state = the v1 writer, which only ever wrote settlements.
      const state = entry.state ?? 'settled';
      if (!TERMINAL_STATES.has(state)) {
        throw new LedgerError(
          `Spend journal ${path}:${lineNo} records terminal state ${JSON.stringify(state)}, which this build does not understand. ` +
            `Refusing to guess whether it cost money.`,
          'LEDGER_CORRUPT',
        );
      }
      if (state === 'settled') {
        this.#settledTotal += entry.actualUsd;
        this.#settledByModel.set(
          entry.modelId,
          (this.#settledByModel.get(entry.modelId) ?? 0) + entry.actualUsd,
        );
      } else if (state === 'retained-unreconciled') {
        // Charged, not settled: the resumed run inherits the conservative hold
        // exactly as the crashed one left it. Dropping these on replay would
        // hand the next batch back headroom that may already be spent.
        this.#unreconciledTotal += entry.actualUsd;
        this.#unreconciledByModel.set(
          entry.modelId,
          (this.#unreconciledByModel.get(entry.modelId) ?? 0) + entry.actualUsd,
        );
      }
      // 'released-uncharged' is journalled for the audit trail and charges
      // nothing — it is the one state that can prove no request was sent.
    }
    // A journal that already exceeds a cap must not authorise a single further
    // call, whatever the individual reserve() arithmetic says. Per-model too:
    // an inherited overspend on one model is invisible in the total.
    for (const modelId of new Set([...this.#settledByModel.keys(), ...this.#unreconciledByModel.keys()])) {
      this.#detectBreach(modelId);
    }
    this.#detectBreach();
  }

  /**
   * Exclusive lock on the run.
   *
   * Two defects shaped this, both in the ownership direction rather than the
   * liveness one:
   *
   *   1. The old acquire did `openSync(path, 'wx')` and THEN wrote the pid, so
   *      between those two syscalls the file existed and was empty. A second
   *      process reading it got no pid, concluded "unreadable, therefore
   *      stale", deleted the first process's lock and took over. Both then
   *      believed they held it and each spent the full cap. Fixed by writing
   *      the complete record to a staging file and `link()`ing it into place:
   *      the lock becomes visible already populated, atomically, or not at all.
   *
   *   2. `close()` did `rmSync(lockPath)` unconditionally. If our lock had been
   *      taken over in the meantime — deemed stale, correctly or not — we then
   *      deleted somebody ELSE's lock on the way out. Removal now compares
   *      identity: our nonce, and the inode we created, not the path name.
   *
   * pid reuse is why liveness alone is never enough. `process.kill(pid, 0)`
   * answers "does a process with this number exist", not "is it the process
   * that took this lock", and a recycled pid answers yes for a stranger. So a
   * live pid is NEVER taken over (refusing is the safe direction, and the error
   * names the nonce so an operator can check), and a dead pid is only taken
   * over when the record also names THIS host — we cannot judge the liveness of
   * a pid on another machine at all.
   */
  #acquireLock(): void {
    const path = resolveRunFile(this.#runId, LOCK_FILE, { write: true });
    mkdirSync(dirname(path), { recursive: true }); // a new run has no directory yet
    const record: LockRecord = {
      version: LOCK_VERSION,
      nonce: randomUUID(),
      pid: process.pid,
      hostname: hostname(),
      runId: this.#runId,
      atIso: this.#now().toISOString(),
    };
    // Three attempts, not two: breaking a provably dead lock and losing the
    // race to a third process is a legitimate sequence, and one retry made that
    // look like a hard failure.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.#tryClaim(path, record)) return;
      this.#breakLockIfProvablyStale(path); // throws unless the holder is provably gone
    }
    throw new LedgerError(
      `Could not acquire the spend lock for run ${this.#runId} after 3 attempts — it is being contended. ` +
        `Only one runner may spend against a run.`,
      'LEDGER_LOCKED',
    );
  }

  /** Atomically publish a fully-written lock record, or report contention. */
  #tryClaim(path: string, record: LockRecord): boolean {
    // `path` came from resolveRunFile(write: true), so the run is not frozen and
    // no component is a symlink. The staging name is that validated path plus a
    // suffix containing only a pid and a UUID, so it cannot traverse or collide;
    // it is written directly rather than through writeRunFileAtomic because the
    // point of the exercise is to create the destination with link(), not rename.
    const staging = `${path}.claim-${process.pid}-${record.nonce}`;
    let staged = false;
    try {
      writeFileSync(staging, JSON.stringify(record), { flag: 'wx' });
      staged = true;
      // link() fails with EEXIST if the destination exists, and — unlike
      // rename() — never replaces it. The lock therefore appears complete or
      // not at all, which is what closes the empty-file takeover window.
      linkSync(staging, path);
      const st = lstatSync(path);
      this.#lockPath = path;
      this.#lockNonce = record.nonce;
      this.#lockIno = st.ino;
      this.#lockDev = st.dev;
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false; // somebody holds it; inspect, do not assume
      // Anything else — EPERM, ENOSPC, a filesystem without hard links — means
      // we cannot establish exclusivity. Fail closed: running unlocked is
      // precisely the condition where two runners each spend the whole cap.
      throw new LedgerError(
        `Could not create the spend lock ${path} (${code ?? (e as Error).message}). ` +
          `Refusing to spend without an exclusive lock on the run.`,
        'LEDGER_LOCKED',
      );
    } finally {
      // Only ever remove a staging file we created. The link, not the staging
      // name, is the lock, so dropping it here is correct in both outcomes.
      if (staged) rmSync(staging, { force: true });
    }
  }

  /**
   * Remove a lock ONLY when its holder is provably gone. Throws otherwise.
   *
   * "Provably" is doing real work here: same host and a dead pid, or a record
   * this build cannot identify at all that has also sat untouched past the
   * staleness window. Everything else refuses, including a lock held by a live
   * pid and a lock claimed by another host, because neither can be disproved
   * from this process.
   */
  #breakLockIfProvablyStale(path: string): void {
    let st: ReturnType<typeof lstatSync>;
    try {
      st = lstatSync(path);
    } catch {
      return; // vanished between the claim and the inspection; the loop retries
    }
    if (st.isSymbolicLink()) {
      // resolveRunFile refuses a symlinked lock path, so this is a link that
      // appeared afterwards. Never unlink it: the target is somebody else's.
      throw new LedgerError(
        `Spend lock ${path} is a symlink. Refusing to remove or trust it.`,
        'LEDGER_LOCKED',
      );
    }
    const holder = readLockRecord(path);
    if (holder && holder.hostname === hostname()) {
      if (holder.pid === process.pid) {
        // Reentrancy is not a lock. Two ledgers in one process would each debit
        // their own totals against the same cap and the same journal.
        throw new LedgerError(
          `Run ${this.#runId} is already locked by THIS process (pid ${holder.pid}, lock ${holder.nonce}). ` +
            `One ledger per run: two in one process would each spend the cap in full.`,
          'LEDGER_LOCKED',
        );
      }
      if (isProcessAlive(holder.pid)) {
        throw new LedgerError(
          `Run ${this.#runId} is already being spent against by pid ${holder.pid} on ${holder.hostname} ` +
            `(lock ${holder.nonce}). Two runners sharing one budget cap would each spend it in full. ` +
            `If that process is definitely gone, remove ${path} by hand — a live pid is never broken automatically, ` +
            `because pids are reused and liveness is not identity.`,
          'LEDGER_LOCKED',
        );
      }
      this.#unlinkIfUnchanged(path, st); // same host, dead pid: provably gone
      return;
    }
    if (holder) {
      throw new LedgerError(
        `Run ${this.#runId} is locked by pid ${holder.pid} on ${holder.hostname}, and this is ${hostname()}. ` +
          `This process cannot prove a pid on another host is gone, so it will not break the lock. Remove ${path} by hand.`,
        'LEDGER_LOCKED',
      );
    }
    // Unidentifiable: truncated, hand-written, or a version this build predates.
    // Age is the only evidence available, and it is weak, so the window is long.
    const ageMs = this.#now().getTime() - st.mtimeMs;
    if (ageMs >= STALE_UNIDENTIFIABLE_LOCK_MS) {
      this.#unlinkIfUnchanged(path, st);
      return;
    }
    throw new LedgerError(
      `Spend lock ${path} carries no identity this build can read and is only ${Math.max(0, Math.round(ageMs / 1000))}s old. ` +
        `Refusing to break it before ${STALE_UNIDENTIFIABLE_LOCK_MS / 60_000} minutes — an unreadable lock is not proof of a dead holder.`,
      'LEDGER_LOCKED',
    );
  }

  /**
   * Unlink by IDENTITY, not by name.
   *
   * Between deciding a lock is stale and removing it, another process may have
   * removed it and claimed its own. Unlinking the path would then delete a live
   * lock. Comparing inode and device before the unlink makes the removal
   * conditional on it still being the same file. The window between the check
   * and the unlink is unavoidable with POSIX unlink-by-name; it is microseconds
   * wide and requires a third process to land inside it, and the consequence is
   * bounded by the loser then failing to claim.
   */
  #unlinkIfUnchanged(path: string, seen: Stats): void {
    try {
      const now = lstatSync(path);
      if (now.ino !== seen.ino || now.dev !== seen.dev) return; // already replaced
      unlinkSync(path);
    } catch {
      // Gone already, which is the outcome we wanted.
    }
  }

  /**
   * Release the lock, if it is still ours. Safe to call more than once.
   *
   * The identity check is the fix for the second half of the ownership race:
   * an unconditional `rmSync` here deleted whichever lock happened to be at the
   * path, including one another process had legitimately taken over.
   */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    const path = this.#lockPath;
    if (!path) return;
    try {
      const st = lstatSync(path);
      if (st.ino !== this.#lockIno || st.dev !== this.#lockDev) return; // not our file
      if (readLockRecord(path)?.nonce !== this.#lockNonce) return; // not our record
      unlinkSync(path);
    } catch {
      // Already removed, or unremovable. A leaked lock is recoverable — the
      // next runner finds a dead holder on this host and takes it over — and is
      // much cheaper than deleting somebody else's.
    }
  }

  // --- the atomic step -----------------------------------------------------

  /**
   * Check and debit in one synchronous step. THERE MUST BE NO `await` IN HERE.
   *
   * Adding one would reintroduce exactly the race this class exists to close:
   * every concurrent caller would resume having checked against a total none of
   * them had yet committed to.
   *
   * Called once per BILLABLE ATTEMPT, not once per logical call. A retry is
   * another chargeable request to the provider and must be authorised as one.
   */
  reserve(modelId: string, estimateUsd: number): Reservation {
    if (this.#closed) {
      throw new LedgerError(
        `Ledger for run ${this.#runId} is closed; its lock has been released. Refusing to authorise further spend.`,
        'LEDGER_CLOSED',
      );
    }
    if (!Number.isFinite(estimateUsd) || estimateUsd < 0) {
      throw new LedgerError(`Refusing to reserve a non-finite or negative amount for ${modelId}.`, 'LEDGER_CORRUPT');
    }
    // A breached scope is not merely full — its money is already gone past the
    // ceiling — so it refuses everything, including a zero-cost reservation.
    if (this.#breached.has('total')) {
      throw new CapBreachedError('total', this.#chargedTotal(), this.#totalCapUsd);
    }
    if (this.#breached.has(`model:${modelId}`)) {
      throw new CapBreachedError(`model:${modelId}`, this.#chargedForModel(modelId), this.#perModelCapUsd);
    }
    const committedTotal = this.committedUsd;
    if (committedTotal + estimateUsd > this.#totalCapUsd) {
      throw new BudgetExceededError('total', committedTotal, this.#totalCapUsd, estimateUsd);
    }
    const committedModel = this.#chargedForModel(modelId) + (this.#outstandingByModel.get(modelId) ?? 0);
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
   *
   * A cost that is absent or unusable is REFUSED rather than coerced to zero —
   * `actualUsd ?? 0` was how an unpriced response became a free one. The caller
   * must decide explicitly, and for a response that reached the provider the
   * only honest decision is `retainUnreconciled`.
   */
  settle(reservation: Reservation, actualUsd: number): void {
    // Attribution comes from the ledger's own record of the reservation, not
    // from the handle the caller passed back — a handle is just an object, and
    // spend must be booked against the model that was actually reserved.
    const open = this.#requireOpen(reservation);
    if (typeof actualUsd !== 'number' || !Number.isFinite(actualUsd) || actualUsd < 0) {
      throw new LedgerError(
        `Refusing to settle reservation ${reservation.id} (${open.modelId}) with cost ${JSON.stringify(actualUsd)}. ` +
          `Missing provider cost is not zero cost: retain the reservation as unreconciled instead.`,
        'COST_UNKNOWN',
      );
    }
    this.#journal(open, 'settled', actualUsd);
    // Nothing between here and the breach check may throw: `#take` was
    // pre-validated above and both map updates are total.
    this.#take(reservation, 'settled');
    this.#settledTotal += actualUsd;
    this.#settledByModel.set(open.modelId, (this.#settledByModel.get(open.modelId) ?? 0) + actualUsd);
    // A settlement ABOVE its reservation can push charged spend past the cap:
    // the money is already gone, so the only thing left to protect is every
    // future call. `detectBreach` latches, `reserve` refuses forever after.
    this.#detectBreach(open.modelId);
  }

  /**
   * The attempt PROVABLY never reached the provider, so nothing can have been
   * charged. The only terminal state that records zero.
   *
   * `reason` is journalled: the classification is a judgement made in
   * `openrouter.ts` from an errno or a status code, and an auditor reading the
   * journal has to be able to see which judgement was made and disagree with it.
   */
  releaseUncharged(reservation: Reservation, reason: string): void {
    const open = this.#requireOpen(reservation);
    this.#journal(open, 'released-uncharged', 0, reason);
    this.#take(reservation, 'released-uncharged');
  }

  /**
   * The attempt reached, or may have reached, the provider, and its cost is
   * unknown. The reservation stays charged in full, pending reconciliation.
   *
   * This is the DEFAULT for anything that is not provably free. An unreadable
   * 200, a dropped socket after the request was written, a 5xx that may have
   * arrived after generation: all of those can be billed, and refunding them
   * hands the cap back money the provider has already taken.
   */
  retainUnreconciled(reservation: Reservation, reason: string): void {
    const open = this.#requireOpen(reservation);
    this.#journal(open, 'retained-unreconciled', open.reservedUsd, reason);
    this.#take(reservation, 'retained-unreconciled');
    this.#unreconciledTotal += open.reservedUsd;
    this.#unreconciledByModel.set(
      open.modelId,
      (this.#unreconciledByModel.get(open.modelId) ?? 0) + open.reservedUsd,
    );
    // Charged exactly what was held, so this cannot breach on its own; checked
    // anyway so every path that moves money past the books runs the same test.
    this.#detectBreach(open.modelId);
  }

  #journal(open: Reservation, state: TerminalState, actualUsd: number, reason?: string): void {
    appendRunFileLine(
      this.#runId,
      JOURNAL_FILE,
      JSON.stringify({
        atIso: this.#now().toISOString(),
        permitId: this.#grant.permitId,
        modelId: open.modelId,
        actualUsd,
        state,
        reservedUsd: open.reservedUsd,
        ...(reason ? { reason } : {}),
      } satisfies JournalEntry),
    );
  }

  /** Latch a breach for every scope whose CHARGED spend is over its ceiling. */
  #detectBreach(modelId?: string): void {
    // A float epsilon, not zero: summing many settlements accumulates error in
    // the last bits, and declaring a breach on 1e-16 would abort a clean run.
    const EPSILON = 1e-9;
    const charged = this.#chargedTotal();
    if (charged > this.#totalCapUsd + EPSILON) {
      this.#breached.add('total');
      throw new CapBreachedError('total', charged, this.#totalCapUsd);
    }
    if (modelId !== undefined) {
      const model = this.#chargedForModel(modelId);
      if (model > this.#perModelCapUsd + EPSILON) {
        this.#breached.add(`model:${modelId}`);
        throw new CapBreachedError(`model:${modelId}`, model, this.#perModelCapUsd);
      }
    }
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
      const already = this.#terminal.get(reservation.id);
      throw new LedgerError(
        `Reservation ${reservation.id} is unknown or already closed${already ? ` (${already})` : ''}. ` +
          `Double-settling would understate committed spend.`,
        'RESERVATION_SETTLED',
      );
    }
    return open;
  }

  /** Remove a reservation from the outstanding books exactly once, recording how it ended. */
  #take(reservation: Reservation, state: TerminalState): void {
    const open = this.#requireOpen(reservation);
    this.#open.delete(reservation.id);
    this.#terminal.set(reservation.id, state);
    this.#outstandingTotal -= open.reservedUsd;
    this.#outstandingByModel.set(
      open.modelId,
      (this.#outstandingByModel.get(open.modelId) ?? 0) - open.reservedUsd,
    );
  }

  #chargedTotal(): number {
    return this.#settledTotal + this.#unreconciledTotal;
  }

  #chargedForModel(modelId: string): number {
    return (this.#settledByModel.get(modelId) ?? 0) + (this.#unreconciledByModel.get(modelId) ?? 0);
  }

  // --- reporting -----------------------------------------------------------

  /** Spend the provider priced. Excludes unreconciled holds — see `chargedUsd`. */
  get settledUsd(): number {
    return this.#settledTotal;
  }

  /**
   * Money charged against the cap for attempts whose real cost is unknown.
   *
   * Non-zero here is a reconciliation task, not an error: somebody has to
   * compare the journal's retained lines with the provider's own record.
   */
  get unreconciledUsd(): number {
    return this.#unreconciledTotal;
  }

  /** Everything already charged: settled plus conservatively retained. */
  get chargedUsd(): number {
    return this.#chargedTotal();
  }

  /** Spend incurred plus spend promised. This is what the cap applies to. */
  get committedUsd(): number {
    return this.#chargedTotal() + this.#outstandingTotal;
  }

  get capUsd(): number {
    return this.#totalCapUsd;
  }

  get openReservations(): number {
    return this.#open.size;
  }

  /** True once settled spend has passed a ceiling. Latched; never clears. */
  get capBreached(): boolean {
    return this.#breached.size > 0;
  }

  /** How a reservation ended, for callers that must not guess. */
  stateOf(reservation: Reservation): ReservationState {
    if (this.#open.has(reservation.id)) return 'open';
    const state = this.#terminal.get(reservation.id);
    if (!state) {
      throw new LedgerError(
        `Reservation ${reservation.id} was never issued by this ledger.`,
        'RESERVATION_UNKNOWN',
      );
    }
    return state;
  }

  settledByModel(): Record<string, number> {
    return Object.fromEntries(this.#settledByModel);
  }

  unreconciledByModel(): Record<string, number> {
    return Object.fromEntries(this.#unreconciledByModel);
  }

  chargedByModel(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const key of new Set([...this.#settledByModel.keys(), ...this.#unreconciledByModel.keys()])) {
      out[key] = this.#chargedForModel(key);
    }
    return out;
  }
}

/** Parse a lock record, returning null for anything this build cannot identify. */
function readLockRecord(path: string): LockRecord | null {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockRecord>;
    if (
      raw.version !== LOCK_VERSION ||
      typeof raw.nonce !== 'string' ||
      raw.nonce === '' ||
      typeof raw.pid !== 'number' ||
      !Number.isInteger(raw.pid) ||
      typeof raw.hostname !== 'string' ||
      raw.hostname === ''
    ) {
      // Includes the v1 record, which carried a pid and nothing that could
      // identify WHICH process it was. Treated as unidentifiable, not as stale.
      return null;
    }
    return raw as LockRecord;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // sends nothing; only asks whether the pid exists
    return true;
  } catch (e) {
    // EPERM means the process EXISTS and belongs to another user. The old code
    // caught every error and answered "dead", so a lock held by a runner under
    // a different account was declared stale and stolen.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
