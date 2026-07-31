import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  NON_SCORING_LABEL,
  canonicalJson,
  canPublish,
  parseHistoricalRegistry,
  runIdSchema,
  type Capability,
  type EvidenceClass,
  safeParseRunManifest,
  type ValidatedRunManifest,
} from '@cookingbench/core';
import { DATA_DIR, RUNS_DIR } from './dataset.js';
import { assertVerifiedGrant, type VerifiedGrant } from './permit.js';

/**
 * WP-0 evidence firewall — RUN-001, RUN-001A, DATA-001, RELEASE-002.
 *
 * A firewall you have to REMEMBER to call is not a firewall, so the dangerous
 * capabilities are made unreachable rather than merely discouraged: every
 * output path resolves through a root-scoped guard, and the default posture
 * with no permit grants nothing.
 *
 * Three classes of bypass shaped this design, all found in review of earlier
 * drafts of this same file:
 *
 *   1. Lexical containment is not filesystem containment. `resolve()` never
 *      touches disk, so a symlink passes it.
 *   2. Filesystem containment is not IDENTITY containment. An alias
 *      `data/runs/alias -> 2026-07-v2.1` stays under RUNS_DIR and passes a
 *      realpath check, while a registry lookup on the lexical name "alias"
 *      finds nothing — and the write lands in the frozen run. Identity must be
 *      taken from the REAL path, never from the name the caller supplied.
 *   3. A guard whose state is reachable is not a guard. Returning the cached
 *      frozen-set let a caller `.clear()` it.
 */

export type FirewallErrorCode =
  | 'PATH_ESCAPE'
  | 'HISTORICAL_WRITE'
  | 'NO_PERMIT'
  | 'CAPABILITY_DENIED'
  | 'CELL_NOT_AUTHORISED'
  | 'UNPRICED_CALL'
  | 'INELIGIBLE_EVIDENCE'
  | 'INVALID_RUN_ID'
  | 'REGISTRY_INVALID'
  | 'SYMLINK_ESCAPE'
  | 'SYMLINK_COMPONENT'
  | 'INVALID_PATH_COMPONENT'
  | 'MISSING_RUN_FILE'
  | 'SEAM_CLOSED';

export class FirewallError extends Error {
  constructor(
    message: string,
    readonly code: FirewallErrorCode,
  ) {
    super(message);
    this.name = 'FirewallError';
  }
}

// ---------------------------------------------------------------------------
// Output families. Each has exactly one permitted root.
// ---------------------------------------------------------------------------

export type OutputFamily = 'runs' | 'taste' | 'pilot' | 'shadow';

const ROOTS: Record<OutputFamily, string> = {
  runs: RUNS_DIR,
  taste: join(DATA_DIR, 'taste'),
  pilot: join(DATA_DIR, 'pilot'),
  shadow: join(DATA_DIR, 'shadow'),
};

/**
 * Anchor every family root to the canonical data directory.
 *
 * `resolveOutputPath` previously trusted `realpath(root)`, which makes a
 * SYMLINKED root its own authority: replacing `data/taste` with a link to an
 * outside directory made that outside directory the trusted root, and writes
 * escaped. The trust has to come from a parent that cannot itself be swapped,
 * so the canonical data directory is the anchor and the family root must sit
 * directly beneath it with no link in between.
 */
function canonicalDataDir(): string {
  const real = realpathSync(DATA_DIR);
  return real;
}

function assertAnchoredRoot(family: OutputFamily): string {
  const root = ROOTS[family];
  const anchor = canonicalDataDir();
  if (existsSync(root)) {
    if (lstatSync(root).isSymbolicLink()) {
      throw new FirewallError(
        `Output root for '${family}' (${root}) is a symlink. A linked root would become its own trust anchor.`,
        'SYMLINK_COMPONENT',
      );
    }
    const real = realpathSync(root);
    if (dirname(real) !== anchor) {
      throw new FirewallError(
        `Output root for '${family}' resolves to ${real}, which is not directly beneath ${anchor}.`,
        'SYMLINK_ESCAPE',
      );
    }
    return real;
  }
  // Not yet created: validate the deepest canonical parent instead.
  if (dirname(root) !== DATA_DIR && dirname(realpathSync(deepestExisting(root))) !== anchor) {
    throw new FirewallError(
      `Output root for '${family}' (${root}) is not anchored beneath ${anchor}.`,
      'SYMLINK_ESCAPE',
    );
  }
  return root;
}

export function outputRoot(family: OutputFamily): string {
  return assertAnchoredRoot(family);
}

// ---------------------------------------------------------------------------
// DATA-001 — the frozen set
// ---------------------------------------------------------------------------

const HISTORICAL_REGISTRY = join(DATA_DIR, 'historical-runs.json');

/**
 * Marker file naming a run as released. Written by an explicit release step,
 * never by ordinary pipeline commands, so an in-progress run stays resumable
 * across batches until that transition happens.
 */
const RELEASED_MARKER = 'RELEASED';

function everyRunDirectory(): string[] {
  return existsSync(RUNS_DIR)
    ? readdirSync(RUNS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory() || e.isSymbolicLink())
        .map((e) => e.name)
    : [];
}

/**
 * Is this a test process? Same test as permit.ts, for the same reason.
 */
const UNDER_TEST =
  process.env.VITEST === 'true' ||
  process.env.VITEST_WORKER_ID !== undefined ||
  process.env.NODE_ENV === 'test';

/**
 * Read the declared frozen set from the COMMITTED registry.
 *
 * Fail-closed in every direction: an absent file freezes every run directory,
 * and an unparseable or malformed one throws rather than defaulting to "nothing
 * is frozen" — which is what an earlier `parsed.runIds ?? []` actually did.
 *
 * NO PARAMETER, and this is the point of the function.
 *
 * The signature used to be `readHistoricalRegistry(registryPath =
 * HISTORICAL_REGISTRY)` — "exported with an explicit path parameter so the
 * failure modes are testable against fixtures". Injectable for testability AND
 * reachable by every caller is not a boundary: `{"runIds": []}` is a
 * structurally valid registry, so any caller could hand this function a file
 * naming nothing and make every published run writable. Verified: a planted
 * empty registry returned an empty frozen set, and the run this repository
 * exists to protect stopped being frozen.
 *
 * This is the third instance of one defect — the permit keyring and the
 * revocation list were the first two — and it is the reason the rule is stated
 * as a rule: a guard must not let the thing it guards choose the guard's
 * inputs. Tests reach `readHistoricalRegistryForTests`, which production source
 * never calls and which refuses to run outside a test process.
 */
export function readHistoricalRegistry(): ReadonlySet<string> {
  return readRegistryAt(HISTORICAL_REGISTRY);
}

/**
 * TEST SEAM. Do not call from `packages/runner/src` — architecture.test.ts
 * greps for that and fails if production code ever does.
 *
 * A separate entry point rather than an optional parameter, because an optional
 * parameter on the production function is reachable by production callers no
 * matter what the doc comment says.
 */
export function readHistoricalRegistryForTests(registryPath: string): ReadonlySet<string> {
  if (!UNDER_TEST) {
    throw new FirewallError(
      `readHistoricalRegistryForTests is a test seam and this is not a test process. The frozen set ` +
        `comes from ${HISTORICAL_REGISTRY} and cannot be supplied by a caller.`,
      'SEAM_CLOSED',
    );
  }
  return readRegistryAt(registryPath);
}

function readRegistryAt(registryPath: string): ReadonlySet<string> {
  if (!existsSync(registryPath)) return new Set(everyRunDirectory());
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(registryPath, 'utf8'));
  } catch (e) {
    throw new FirewallError(
      `Historical registry ${registryPath} is not valid JSON (${(e as Error).message}). Refusing to operate with an unknown immutability policy.`,
      'REGISTRY_INVALID',
    );
  }
  const result = parseHistoricalRegistry(parsed);
  if (!result.ok) {
    throw new FirewallError(
      `Historical registry ${registryPath} is malformed: ${result.error}. Refusing to operate with an unknown immutability policy.`,
      'REGISTRY_INVALID',
    );
  }
  return new Set(result.runIds);
}

/** Private. Never returned to a caller — a mutable frozen set is an off switch. */
let registryCache: ReadonlySet<string> | null = null;

function declaredFrozen(): ReadonlySet<string> {
  registryCache ??= readHistoricalRegistry();
  return registryCache;
}

/**
 * Runtime-enforced release state for a single run, independent of the registry.
 *
 * The registry alone is not sufficient: `{"runIds": []}` is structurally valid,
 * so a run released but omitted from the registry would be writable. Checking
 * the run itself closes that without freezing work in progress:
 *
 *   - an explicit RELEASED marker    → frozen
 *   - config.releaseState 'released' → frozen
 *   - a published board (leaderboard.json) on a run whose config predates
 *     releaseState → frozen, conservatively, because legacy runs cannot state
 *     their own status and a published board is evidence of release
 *   - a releaseState this build recognises as in-progress → resumable
 *   - anything else, including a state this build has never heard of → frozen
 */

/**
 * The complete list of release states that keep a run WRITABLE.
 *
 * Stated as the resumable set rather than the frozen set on purpose. An earlier
 * version of this file listed the frozen states — 'released', 'retired',
 * 'quarantined' — and then returned `FROZEN.has(state) || true`, which is
 * unconditionally true and made the set dead code. The behaviour was right and
 * the code was a lie: it read as a membership test that decided nothing, so a
 * later reader adding a sixth release state would have "added" it to a set that
 * no longer had any effect, and could not tell from the line whether their new
 * state froze or not.
 *
 * Enumerating the permissive side is also the fail-closed direction. A new
 * release state added to the core vocabulary freezes here until somebody
 * deliberately declares it resumable, rather than silently unlocking published
 * evidence because nobody remembered to extend a list of things to forbid.
 */
const RESUMABLE_RELEASE_STATES: ReadonlySet<string> = new Set(['draft', 'audited']);

function isReleasedOnDisk(realRunDir: string): boolean {
  if (existsSync(join(realRunDir, RELEASED_MARKER))) return true;
  const hasBoard = existsSync(join(realRunDir, 'leaderboard.json'));
  const configPath = join(realRunDir, 'config.json');

  // Missing policy metadata plus a published board must FREEZE, not unlock.
  // The earlier version only consulted the board when config.json existed, so
  // a board with no config was considered writable — fail-open in exactly the
  // case with the least information.
  if (!existsSync(configPath)) return hasBoard;

  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { releaseState?: string };
    if (config.releaseState === undefined) return hasBoard;
    // Only an explicit in-progress state keeps a run writable. Everything else
    // — released, retired, quarantined, or a value this build does not
    // recognise — freezes. `has` is called on the RESUMABLE set precisely so
    // this line is a real decision and not a tautology.
    return !RESUMABLE_RELEASE_STATES.has(config.releaseState);
  } catch {
    // Corrupt policy metadata on a run we are about to write to is not
    // something to shrug at.
    return true;
  }
}

/** Membership only. Deliberately not a collection — see bypass class 3 above. */
export function isHistoricalRun(runId: string): boolean {
  if (declaredFrozen().has(runId)) return true;
  const dir = join(RUNS_DIR, runId);
  return existsSync(dir) && isReleasedOnDisk(dir);
}

/** An immutable copy, for reporting only. */
export function declaredHistoricalRunIds(): readonly string[] {
  return Object.freeze([...declaredFrozen()]);
}

/** CI/reporting helper: released runs that the registry fails to declare. */
export function undeclaredPublishedRuns(): string[] {
  const declared = declaredFrozen();
  return everyRunDirectory().filter(
    (runId) => !declared.has(runId) && isReleasedOnDisk(join(RUNS_DIR, runId)),
  );
}

// ---------------------------------------------------------------------------
// Path confinement
// ---------------------------------------------------------------------------

function containedBy(root: string, target: string): boolean {
  const rel = relative(root, target);
  return target === root || (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel));
}

/** Deepest ancestor of `target` that exists, for resolving not-yet-created paths. */
function deepestExisting(target: string): string {
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) return probe;
    probe = parent;
  }
  return probe;
}

/**
 * Reject a path that reaches its destination through a symlink.
 *
 * Containment alone is not enough (bypass class 2): a link *inside* the root
 * still satisfies containment while redirecting the write. On writes we refuse
 * links outright, which is stricter than resolving them and much easier to
 * reason about.
 */
/**
 * Reject a symlink anywhere between `root` and `target`, INCLUDING the leaf.
 *
 * The leaf matters most and was the gap: only response writes went through
 * final-target resolution, so `scores.json -> ../outside.json` inside an
 * unfrozen run passed the directory check and the write followed the link out.
 * Applied to reads as well, because a linked `responses` directory or a linked
 * JSON file can otherwise pull content in from outside the root.
 */
function assertNoSymlinkComponent(root: string, target: string): void {
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return; // containment checked elsewhere
  // Walk root -> target one component at a time, leaf included. Stop at the
  // first component that does not exist; nothing below it can be a link.
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    if (!existsSync(current) && !isLink(current)) return;
    if (isLink(current)) {
      throw new FirewallError(
        `Refusing to traverse symlink component ${current}. Use the canonical path instead.`,
        'SYMLINK_COMPONENT',
      );
    }
  }
}

/** lstat that tolerates a dangling link (existsSync follows links and lies). */
function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Write a guarded path atomically.
 *
 * Staging to a sibling temp file and renaming means the destination entry is
 * REPLACED rather than followed, so even a leaf symlink that appeared between
 * resolution and write cannot redirect the bytes. The path is re-resolved
 * immediately before the rename to close the gap Codex identified between an
 * early preflight and the final write.
 */
export function writeRunFileAtomic(runId: string, relativePath: string, data: string): string {
  const target = resolveRunFile(runId, relativePath, { write: true });
  return atomicReplace(target, data);
}

export function writeOutputFileAtomic(
  family: OutputFamily,
  relativePath: string,
  data: string,
): string {
  const target = resolveOutputPath(family, relativePath, { write: true });
  return atomicReplace(target, data);
}

/**
 * Append a single line to a guarded journal.
 *
 * Append rather than replace, because a spend journal must never lose an
 * earlier entry — a temp-file-and-rename would rewrite the whole file, and a
 * crash mid-rewrite loses the record of money already spent. `appendFileSync`
 * opens O_APPEND, so each write lands at the current end of file even with
 * another writer present.
 *
 * The leaf is re-checked for a symlink immediately before the write, the same
 * way `atomicReplace` does, because append FOLLOWS a link where rename replaces
 * it.
 */
export function appendRunFileLine(runId: string, relativePath: string, line: string): string {
  const target = resolveRunFile(runId, relativePath, { write: true });
  if (isLink(target)) {
    throw new FirewallError(`Refusing to append through leaf symlink ${target}.`, 'SYMLINK_COMPONENT');
  }
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, line.endsWith('\n') ? line : `${line}\n`);
  return target;
}

let tempCounter = 0;
function atomicReplace(target: string, data: string): string {
  if (isLink(target)) {
    throw new FirewallError(
      `Refusing to write through leaf symlink ${target}.`,
      'SYMLINK_COMPONENT',
    );
  }
  mkdirSync(dirname(target), { recursive: true });
  const tmp = `${target}.tmp-${process.pid}-${tempCounter++}`;
  writeFileSync(tmp, data);
  renameSync(tmp, target); // replaces the entry; never follows a link
  return target;
}

/**
 * Confine `relativePath` beneath the root of `family`, proving both lexical and
 * real containment, and return the absolute path.
 */
export function resolveOutputPath(
  family: OutputFamily,
  relativePath: string,
  opts: { write: boolean },
): string {
  const root = assertAnchoredRoot(family);
  const target = resolve(root, relativePath);
  if (!containedBy(root, target) || target === root) {
    throw new FirewallError(
      `Path ${JSON.stringify(relativePath)} resolves outside the ${family} root (${target}).`,
      'PATH_ESCAPE',
    );
  }
  if (existsSync(root)) {
    const realTarget = realpathSync(deepestExisting(target));
    if (!containedBy(realpathSync(root), realTarget)) {
      throw new FirewallError(
        `Path ${target} resolves through a link to ${realTarget}, outside the ${family} root.`,
        'SYMLINK_ESCAPE',
      );
    }
    if (opts.write) assertNoSymlinkComponent(root, target);
  }
  return target;
}

/**
 * Resolve a run directory, taking the run's IDENTITY from its real path.
 *
 * This is the fix for the alias bypass. `data/runs/alias -> 2026-07-v2.1`
 * satisfies containment and would previously be checked against the registry as
 * "alias", which is not frozen, so the write landed in the published run. The
 * canonical id is now derived from the resolved path, so the alias is refused
 * under the name it actually points at.
 */
export function resolveRunDir(runId: string, opts: { write: boolean }): string {
  const parsed = runIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new FirewallError(
      `Invalid run id ${JSON.stringify(runId)}: ${parsed.error.issues[0]?.message ?? 'rejected'}`,
      'INVALID_RUN_ID',
    );
  }
  const dir = resolveOutputPath('runs', runId, { write: false });

  // Identity from the real path, not the supplied name.
  let canonical = runId;
  if (existsSync(dir)) {
    const real = realpathSync(dir);
    if (!containedBy(realpathSync(RUNS_DIR), real)) {
      throw new FirewallError(
        `Run ${JSON.stringify(runId)} resolves to ${real}, outside the runs directory.`,
        'SYMLINK_ESCAPE',
      );
    }
    canonical = relative(realpathSync(RUNS_DIR), real).split(sep)[0] || runId;
  }

  if (opts.write) {
    if (isHistoricalRun(canonical) || isHistoricalRun(runId)) {
      const via = canonical === runId ? '' : ` (via alias ${JSON.stringify(runId)})`;
      throw new FirewallError(
        `Run ${canonical}${via} is historical and immutable (DATA-001). Derived work must use a new run id and its own output root.`,
        'HISTORICAL_WRITE',
      );
    }
    assertNoSymlinkComponent(RUNS_DIR, dir);
  }
  return dir;
}

/**
 * Resolve a file INSIDE a run, validating the final target.
 *
 * Validating only the run directory left a nested `responses` symlink able to
 * redirect every response write.
 */
export function resolveRunFile(runId: string, relativePath: string, opts: { write: boolean }): string {
  const dir = resolveRunDir(runId, opts);
  for (const part of relativePath.split(/[\\/]/)) assertSafePathComponent(part, 'path component');
  const target = resolve(dir, relativePath);
  if (!containedBy(dir, target)) {
    throw new FirewallError(
      `Path ${JSON.stringify(relativePath)} escapes run directory ${dir}.`,
      'PATH_ESCAPE',
    );
  }
  assertNoSymlinkComponent(RUNS_DIR, target);
  return target;
}

/**
 * Read a guarded file inside a run, or null when it is absent.
 *
 * Reads went through `join(resolveRunDir(runId, { write: false }), leaf)`, which
 * validates the DIRECTORY and then follows whatever the leaf turns out to be.
 * That is the write-side leaf defect with the arrow reversed: a run whose
 * `scores.json` links to another run's reads the other run's scores and
 * presents them as its own evidence. Provenance is the entire point of the
 * firewall, so a read that crosses a link is refused, not resolved.
 */
export function readRunFileOrNull(runId: string, relativePath: string): string | null {
  const target = resolveRunFile(runId, relativePath, { write: false });
  return existsSync(target) ? readFileSync(target, 'utf8') : null;
}

/** Same guard, but a missing file is an error rather than an absence. */
export function readRunFile(runId: string, relativePath: string): string {
  const text = readRunFileOrNull(runId, relativePath);
  if (text === null) {
    throw new FirewallError(
      `Run ${runId} has no ${relativePath}.`,
      'MISSING_RUN_FILE',
    );
  }
  return text;
}

/**
 * Read every `.json` file directly inside a run's subdirectory, in sorted order,
 * refusing any entry that is a symlink.
 *
 * `readdirSync` then `readFileSync(join(dir, name))` follows links at BOTH
 * levels. Verified on a scratch run containing `responses -> the frozen run's
 * responses`: it returned 2,576 archived answers with no error, attributed to
 * the scratch run. Resolving the directory catches that one; a single linked
 * file inside an otherwise real directory needs the per-entry check below.
 */
export function readRunJsonEntries(
  runId: string,
  relativeDir: string,
): Array<{ name: string; text: string }> {
  const dir = resolveRunFile(runId, relativeDir, { write: false });
  if (!existsSync(dir)) return [];
  const entries: Array<{ name: string; text: string }> = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const target = join(dir, name);
    if (isLink(target)) {
      throw new FirewallError(
        `Refusing to read ${relativeDir}/${name} in run ${runId} through a symlink. ` +
          `A run's artifacts must be its own; derive a run rather than linking to one.`,
        'SYMLINK_COMPONENT',
      );
    }
    entries.push({ name, text: readFileSync(target, 'utf8') });
  }
  return entries;
}

/**
 * Validate a single filename component at the writer boundary.
 *
 * Shared enforcement must not depend on an upstream caller remembering to
 * validate: the CLI's schema constrains question ids today, but a programmatic
 * or future caller has no such schema in the way.
 */
export function assertSafePathComponent(value: string, label: string): string {
  if (
    value === '' ||
    value === '.' ||
    value === '..' ||
    value.includes('/') ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.length > 160
  ) {
    throw new FirewallError(
      `Unsafe ${label} ${JSON.stringify(value)}: filename components may not be empty, traverse, contain separators or NUL, or exceed 160 chars.`,
      'INVALID_PATH_COMPONENT',
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// RUN-001 — capabilities
// ---------------------------------------------------------------------------

/**
 * What KIND of paid work a cell authorises.
 *
 * The plan names two, and they are genuinely different authorisations:
 * "exact model–item or judge–answer cells where inference is allowed".
 *
 *   candidate — this model may be ASKED this item.
 *   judge     — this model's ANSWER to this item may be SCORED.
 */
export type CellKind = 'candidate' | 'judge';

export interface InferenceCell {
  readonly kind: CellKind;
  /**
   * Always the CANDIDATE — the model whose answer the call is about.
   *
   * For a judge cell this is emphatically NOT the seat doing the scoring. The
   * earlier code passed the seat here, which meant a judging permit had to
   * enumerate seat × question: with a three-seat panel choosing two seats per
   * answer by FNV-1a hash, authorising 184 items across a roster meant
   * precomputing several hundred pairs whose membership depended on
   * reproducing the panel's hash by hand. That is not an approval anybody can
   * read, and it binds the permit to the seat-selection algorithm, so changing
   * the hash would silently invalidate a signed approval.
   *
   * Naming the candidate instead makes the permit say the thing an approver
   * actually decides — which answers may be bought and which may be scored —
   * and leaves seat conflict to JUDGE-001 in the panel, where it belongs.
   */
  readonly modelId: string;
  readonly questionId: string;
}

/**
 * Kind → the capability that authorises it.
 *
 * This pairing is why the two kinds stay distinct without the permit carrying a
 * per-cell literal. A cell list is a set of (candidate, item) coordinates; the
 * permit's CAPABILITIES say what may be done at those coordinates, and the
 * signature covers both. So:
 *
 *   - a legacy-shadow permit (judge-inference only) authorises scoring the
 *     archived answers it lists and cannot buy a single fresh candidate call,
 *     even at the same coordinates;
 *   - a development-probe permit granting both authorises generating those
 *     answers AND judging them, which is what "fixes every model–item contact"
 *     means when the probe is judged;
 *   - neither kind is ever authorised by silence.
 *
 * A per-cell `kind` field in the permit schema would let one permit generate a
 * cell and not judge it. Nothing needs that yet, and the field would have to be
 * added to `permitSchema` in packages/core — see docs/wp-0/INTEGRATION-NOTES.md.
 */
const CAPABILITY_FOR_CELL_KIND: Readonly<Record<CellKind, Capability>> = Object.freeze({
  candidate: 'candidate-inference',
  judge: 'judge-inference',
});

/** JSON-encoded tuple: injective, unlike concatenation or a single separator. */
function cellKey(modelId: string, questionId: string): string {
  return JSON.stringify([modelId, questionId]);
}

export class Firewall {
  /**
   * `#private`, not TypeScript `private`.
   *
   * TS `private` is a compile-time convention: `(firewall as any).cellIndex.add(
   * ...)` or `(firewall as any).grant = forged` both work at runtime, which
   * would make every check below advisory. `#` fields are genuinely
   * unreachable from outside the class body. Same reasoning as the grant
   * registry — the boundary has to survive being called from JavaScript.
   */
  readonly #grant: VerifiedGrant | null;
  readonly #cellIndex: Set<string>;

  private constructor(grant: VerifiedGrant | null) {
    // The constructor re-checks rather than trusting `fromVerifiedPermit`.
    // `private constructor` is also erased: `Reflect.construct(Firewall,
    // [forgedGrant])` and `new (Firewall as any)(forgedGrant)` reach it
    // directly, so the static factory alone is not the boundary.
    if (grant !== null) assertVerifiedGrant(grant, 'Firewall construction');
    this.#grant = grant;
    this.#cellIndex = new Set((grant?.cells ?? []).map((c) => cellKey(c.modelId, c.questionId)));
  }

  /** The default posture. Nothing dangerous is permitted. */
  static denyAll(): Firewall {
    return new Firewall(null);
  }

  /**
   * Constructed only from a grant this process minted by verifying a signature.
   *
   * The runtime check is the boundary, not the parameter type. An earlier
   * version took a plain `PermitGrant` interface and relied on the method NAME
   * to imply verification, which meant `Firewall.fromVerifiedPermit({ permitId:
   * 'x', capabilities: ['publication'], ... })` authorised publication. That
   * interface is gone: there is no exported shape a caller can fill in.
   */
  static fromVerifiedPermit(grant: VerifiedGrant): Firewall {
    return new Firewall(assertVerifiedGrant(grant, 'Firewall.fromVerifiedPermit'));
  }

  get permitId(): string | null {
    return this.#grant?.permitId ?? null;
  }

  get budgetCapUsd(): number {
    return this.#grant?.budgetCapUsd ?? 0;
  }

  /** TRACE-001: what a run artifact should record about its authorisation. */
  provenance(): {
    permitId: string;
    kind: string;
    keyId: string;
    manifestHash: string;
    runId: string;
    capabilities: readonly Capability[];
    verifiedAtIso: string;
  } | null {
    if (!this.#grant) return null;
    const g = this.#grant;
    return {
      permitId: g.permitId,
      kind: g.kind,
      keyId: g.keyId,
      manifestHash: g.manifestHash,
      runId: g.runId,
      capabilities: g.capabilities,
      verifiedAtIso: g.verifiedAtIso,
    };
  }

  has(capability: Capability): boolean {
    return this.#grant?.capabilities.includes(capability) ?? false;
  }

  requireCapability(capability: Capability, context: string): void {
    if (!this.#grant) {
      throw new FirewallError(
        `${context} requires capability '${capability}' but no permit is active. Execution is deny-by-default (RUN-001).`,
        'NO_PERMIT',
      );
    }
    if (!this.has(capability)) {
      throw new FirewallError(
        `Permit ${this.#grant.permitId} (${this.#grant.kind}) does not grant '${capability}', required by ${context}. Granted: [${this.#grant.capabilities.join(', ')}].`,
        'CAPABILITY_DENIED',
      );
    }
  }

  /**
   * Inference is authorised per cell. An empty cell list authorises nothing.
   *
   * The caller must STATE the kind of work it is doing. It is not inferred from
   * the client, the model id or anything else the caller could get wrong
   * quietly: a candidate call and a judge call at the same coordinates need
   * different capabilities, and the check is only worth anything if the two
   * cannot be confused.
   */
  requireCell(cell: InferenceCell, context: string): void {
    if (!this.#grant) {
      throw new FirewallError(`${context} requires an authorised cell but no permit is active.`, 'NO_PERMIT');
    }
    // Validated rather than trusted: this boundary is reachable from JavaScript
    // and from a future kind this build has never heard of, and an unrecognised
    // kind must refuse rather than fall through to an undefined capability
    // lookup (`requireCapability(undefined)` would compare against nothing).
    const capability = Object.hasOwn(CAPABILITY_FOR_CELL_KIND, (cell as { kind: string }).kind)
      ? CAPABILITY_FOR_CELL_KIND[cell.kind]
      : undefined;
    if (capability === undefined) {
      throw new FirewallError(
        `${context} named cell kind ${JSON.stringify((cell as { kind: unknown }).kind)}, which is not one of [${Object.keys(CAPABILITY_FOR_CELL_KIND).join(', ')}].`,
        'CELL_NOT_AUTHORISED',
      );
    }
    if (typeof cell.modelId !== 'string' || cell.modelId === '' || typeof cell.questionId !== 'string' || cell.questionId === '') {
      throw new FirewallError(
        `${context} named an incomplete ${cell.kind} cell (${JSON.stringify(cell.modelId)} × ${JSON.stringify(cell.questionId)}). A cell with a missing coordinate authorises nothing.`,
        'CELL_NOT_AUTHORISED',
      );
    }
    // Kind first. A judge-only permit that happens to list a coordinate must
    // not buy a candidate call at it, and the capability is what says so.
    this.requireCapability(capability, `${cell.kind} cell for ${context}`);
    if (!this.#cellIndex.has(cellKey(cell.modelId, cell.questionId))) {
      throw new FirewallError(
        `Permit ${this.#grant.permitId} does not authorise the ${cell.kind} cell ${cell.modelId} × ${cell.questionId}.`,
        'CELL_NOT_AUTHORISED',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// RELEASE-002 — publication
// ---------------------------------------------------------------------------

/**
 * The publication boundary. Takes `unknown` and PARSES.
 *
 * The previous signature took a compile-time-branded type, which TypeScript
 * erases: `{ runId, evidenceClass: 'public-release', releaseState: 'released' }`
 * was accepted at runtime. Treating external input as unknown and re-parsing
 * the complete manifest here is the only version of this that survives being
 * called from JavaScript, from a test with `as any`, or across a package
 * boundary.
 */
export function assertPublishable(candidate: unknown, context: string): ValidatedRunManifest {
  const parsed = safeParseRunManifest(candidate);
  if (!parsed.ok) {
    throw new FirewallError(
      `${context} refused: manifest failed validation (${parsed.error}). Publication requires a complete, coherent manifest.`,
      'INELIGIBLE_EVIDENCE',
    );
  }
  const manifest = parsed.manifest;
  if (!canPublish(manifest)) {
    throw new FirewallError(
      `${context} refused for run ${manifest.runId}: evidenceClass '${manifest.evidenceClass}' / releaseState '${manifest.releaseState}'. ` +
        `Only an approved 'public-release' manifest in 'released' may create a public result (RELEASE-002).`,
      'INELIGIBLE_EVIDENCE',
    );
  }
  return manifest;
}

export function nonScoringBanner(evidenceClass: EvidenceClass): string | null {
  return evidenceClass === 'legacy-shadow' || evidenceClass === 'development-probe'
    ? NON_SCORING_LABEL
    : null;
}

// ---------------------------------------------------------------------------
// TRACE-001 — the approval trail, written into the run
// ---------------------------------------------------------------------------

/** One unit of authorised work, as recorded in the run's own artifacts. */
export interface ProvenanceEntry {
  permitId: string;
  kind: string;
  keyId: string;
  manifestHash: string;
  runId: string;
  capabilities: readonly Capability[];
  verifiedAtIso: string;
  /** The command that exercised the authority, e.g. `bench run`. */
  command: string;
  recordedAtIso: string;
}

const PROVENANCE_FILE = 'provenance.ndjson';

/**
 * Record, IN THE RUN'S OWN ARTIFACTS, the approval a unit of work was done
 * under.
 *
 * `Firewall.provenance()` has existed since the permit layer landed and was
 * never called by anything that writes: the redemption record — which lives in
 * `data/permits/`, beside the permit rather than beside the run — was the only
 * durable trail. That is the wrong place for it. TRACE-001 asks that every
 * ARTIFACT can be traced to the approval that authorised it, and an artifact
 * whose trail lives in another directory is traceable only by someone who
 * already knows to look.
 *
 * APPEND, not replace, for the same reason the spend journal appends: a run is
 * assembled from several batches, judged in a separate pass, and may be resumed
 * days later under a second permit. Each of those is a distinct authorisation,
 * and a file that kept only the last one would describe the run as though one
 * approval covered all of it. `appendRunFileLine` refuses a leaf symlink and
 * refuses a published run, so the trail cannot be redirected or retro-fitted
 * into frozen work.
 *
 * Canonical JSON per line so two records of the same authorisation are
 * byte-identical regardless of field order.
 */
export function recordProvenance(runId: string, grant: VerifiedGrant, command: string): ProvenanceEntry {
  assertVerifiedGrant(grant, `recordProvenance(${command})`);
  const base = Firewall.fromVerifiedPermit(grant).provenance();
  if (!base) {
    // Unreachable: fromVerifiedPermit on a minted grant always carries one.
    // Stated rather than assumed, because a silent null here would write an
    // empty trail that reads as "no authority was used".
    throw new FirewallError(
      `recordProvenance(${command}): a verified grant carried no provenance.`,
      'NO_PERMIT',
    );
  }
  const entry: ProvenanceEntry = { ...base, command, recordedAtIso: new Date().toISOString() };
  appendRunFileLine(runId, PROVENANCE_FILE, canonicalJson(entry));
  return entry;
}

/** The run's approval trail, oldest first. Empty when nothing has authorised work on it. */
export function readProvenance(runId: string): ProvenanceEntry[] {
  const text = readRunFileOrNull(runId, PROVENANCE_FILE);
  if (text === null) return [];
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((line, i) => {
      try {
        return JSON.parse(line) as ProvenanceEntry;
      } catch {
        // Refusing is the only safe reading: an unparseable trail means we do
        // not know what authorised this run, and "assume nothing did" is how an
        // unapproved artifact passes a provenance check.
        throw new FirewallError(
          `Provenance trail for run ${runId} is corrupt at line ${i + 1}. Refusing to report an unknown approval as none.`,
          'REGISTRY_INVALID',
        );
      }
    });
}
