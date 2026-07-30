import {
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
  canPublish,
  parseHistoricalRegistry,
  runIdSchema,
  type Capability,
  type EvidenceClass,
  safeParseRunManifest,
  type ValidatedRunManifest,
} from '@cookingbench/core';
import { DATA_DIR, RUNS_DIR } from './dataset.js';

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
  | 'INELIGIBLE_EVIDENCE'
  | 'INVALID_RUN_ID'
  | 'REGISTRY_INVALID'
  | 'SYMLINK_ESCAPE'
  | 'SYMLINK_COMPONENT'
  | 'INVALID_PATH_COMPONENT';

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
 * Read the declared frozen set from a registry file.
 *
 * Fail-closed in every direction: an absent file freezes every run directory,
 * and an unparseable or malformed one throws rather than defaulting to "nothing
 * is frozen" — which is what an earlier `parsed.runIds ?? []` actually did.
 *
 * Exported with an explicit path parameter so the failure modes are testable
 * against fixtures. There is deliberately no setter and no accessor returning
 * mutable internal state.
 */
export function readHistoricalRegistry(registryPath: string = HISTORICAL_REGISTRY): ReadonlySet<string> {
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
 *   - anything else                  → resumable
 */
const FROZEN_RELEASE_STATES = new Set(['released', 'retired', 'quarantined']);

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
    // Only an explicit in-progress state keeps a run writable. Anything else —
    // released, retired, quarantined, or a value we do not recognise — freezes.
    if (config.releaseState === 'draft' || config.releaseState === 'audited') return false;
    return FROZEN_RELEASE_STATES.has(config.releaseState) || true;
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

export interface PermitGrant {
  permitId: string;
  kind: string;
  capabilities: readonly Capability[];
  cells: ReadonlyArray<{ modelId: string; questionId: string }>;
  budgetCapUsd: number;
}

/** JSON-encoded tuple: injective, unlike concatenation or a single separator. */
function cellKey(modelId: string, questionId: string): string {
  return JSON.stringify([modelId, questionId]);
}

export class Firewall {
  private readonly cellIndex: Set<string>;

  private constructor(private readonly grant: PermitGrant | null) {
    this.cellIndex = new Set((grant?.cells ?? []).map((c) => cellKey(c.modelId, c.questionId)));
  }

  /** The default posture. Nothing dangerous is permitted. */
  static denyAll(): Firewall {
    return new Firewall(null);
  }

  /**
   * Constructed only from a permit that has already passed verification.
   *
   * NOTE: this still accepts a plain object. Replacing `PermitGrant` with an
   * opaque branded type that only the verifier can mint is the next task; until
   * then a method name is not a security boundary.
   */
  static fromVerifiedPermit(grant: PermitGrant): Firewall {
    return new Firewall(grant);
  }

  get permitId(): string | null {
    return this.grant?.permitId ?? null;
  }

  get budgetCapUsd(): number {
    return this.grant?.budgetCapUsd ?? 0;
  }

  has(capability: Capability): boolean {
    return this.grant?.capabilities.includes(capability) ?? false;
  }

  requireCapability(capability: Capability, context: string): void {
    if (!this.grant) {
      throw new FirewallError(
        `${context} requires capability '${capability}' but no permit is active. Execution is deny-by-default (RUN-001).`,
        'NO_PERMIT',
      );
    }
    if (!this.has(capability)) {
      throw new FirewallError(
        `Permit ${this.grant.permitId} (${this.grant.kind}) does not grant '${capability}', required by ${context}. Granted: [${this.grant.capabilities.join(', ')}].`,
        'CAPABILITY_DENIED',
      );
    }
  }

  /** Inference is authorised per cell. An empty cell list authorises nothing. */
  requireCell(modelId: string, questionId: string, context: string): void {
    if (!this.grant) {
      throw new FirewallError(`${context} requires an authorised cell but no permit is active.`, 'NO_PERMIT');
    }
    if (!this.cellIndex.has(cellKey(modelId, questionId))) {
      throw new FirewallError(
        `Permit ${this.grant.permitId} does not authorise ${modelId} × ${questionId}.`,
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
