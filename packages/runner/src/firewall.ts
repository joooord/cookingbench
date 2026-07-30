import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  NON_SCORING_LABEL,
  canPublish,
  runIdSchema,
  type Capability,
  type EvidenceClass,
  type RunManifest,
} from '@cookingbench/core';
import { DATA_DIR, RUNS_DIR } from './dataset.js';

/**
 * WP-0 evidence firewall — RUN-001, RUN-001A, DATA-001, RELEASE-002.
 *
 * The design rule is that a firewall you have to REMEMBER to call is not a
 * firewall. The bypass-path inventory found 178 routes; 134 of them were
 * capable of overwriting history, publishing without authorisation, bypassing
 * the budget or spending money. Adding a check at each of those call sites
 * would leave the next command written by someone who never read the plan wide
 * open. So the dangerous capabilities are made unreachable instead:
 *
 *   - every run-scoped path resolves through `resolveRunDir`, which confines
 *     and refuses published runs on write;
 *   - every network client is constructed through a capability grant;
 *   - the default state, with no permit, denies all of it.
 *
 * Enforcement sits beneath the CLI so every current and future entry point
 * shares one policy.
 */

export class FirewallError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'PATH_ESCAPE'
      | 'HISTORICAL_WRITE'
      | 'NO_PERMIT'
      | 'CAPABILITY_DENIED'
      | 'CELL_NOT_AUTHORISED'
      | 'INELIGIBLE_EVIDENCE'
      | 'INVALID_RUN_ID',
  ) {
    super(message);
    this.name = 'FirewallError';
  }
}

/**
 * DATA-001. Runs whose artifacts are read-only inputs forever.
 *
 * Sourced from a committed registry rather than hardcoded so that publishing a
 * new run adds to the frozen set by data change, not by editing enforcement
 * code. If the registry is missing we fall back to treating EVERY existing run
 * directory as historical — failing closed, because the alternative is a fresh
 * checkout silently permitting overwrites.
 */
const HISTORICAL_REGISTRY = join(DATA_DIR, 'historical-runs.json');

let historicalCache: Set<string> | null = null;

export function historicalRunIds(): Set<string> {
  if (historicalCache) return historicalCache;
  if (existsSync(HISTORICAL_REGISTRY)) {
    const parsed = JSON.parse(readFileSync(HISTORICAL_REGISTRY, 'utf8')) as { runIds?: string[] };
    historicalCache = new Set(parsed.runIds ?? []);
  } else {
    historicalCache = new Set(
      existsSync(RUNS_DIR)
        ? readdirSync(RUNS_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => e.name)
        : [],
    );
  }
  return historicalCache;
}

/** Test seam only. Production code reads the committed registry. */
export function __setHistoricalRunIds(ids: string[] | null): void {
  historicalCache = ids === null ? null : new Set(ids);
}

export function isHistoricalRun(runId: string): boolean {
  return historicalRunIds().has(runId);
}

/**
 * The single confined path resolver. Every run-scoped read and write goes
 * through this.
 *
 * Before WP-0 the three write roots — store.ts, analyze.ts and calibration.ts —
 * each computed `join(RUNS_DIR, runId)` on an unvalidated argv string. Because
 * `join` resolves `..` segments, `--run-id ../../apps/web/public` left the runs
 * directory entirely and recursive mkdir built the tree, so config.json,
 * scores.json, leaderboard.json and responses/*.json could be planted anywhere
 * the process could write. Verified: join('/…/data/runs', '../..') is the repo
 * root.
 *
 * Two independent defences, because either alone is one bug from failure:
 * the run id is validated against a strict pattern, AND the resolved absolute
 * path is proven to remain beneath RUNS_DIR.
 */
export function resolveRunDir(runId: string, opts: { write: boolean }): string {
  const parsed = runIdSchema.safeParse(runId);
  if (!parsed.success) {
    throw new FirewallError(
      `Invalid run id ${JSON.stringify(runId)}: ${parsed.error.issues[0]?.message ?? 'rejected'}`,
      'INVALID_RUN_ID',
    );
  }
  const dir = resolve(RUNS_DIR, runId);
  const rel = relative(RUNS_DIR, dir);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.includes(`..${sep}`)) {
    throw new FirewallError(
      `Run id ${JSON.stringify(runId)} resolves outside the runs directory (${dir}).`,
      'PATH_ESCAPE',
    );
  }
  if (opts.write && isHistoricalRun(runId)) {
    throw new FirewallError(
      `Run ${runId} is historical and immutable (DATA-001). Derived work must use a new run id and its own output root.`,
      'HISTORICAL_WRITE',
    );
  }
  return dir;
}

/**
 * Guards writes to any path, not just run directories. Used for the taste
 * archive and any future writer, so a new output location cannot quietly land
 * inside a published run.
 */
export function assertWritablePath(target: string): string {
  const abs = resolve(target);
  const relToRuns = relative(RUNS_DIR, abs);
  const insideRuns = relToRuns !== '' && !relToRuns.startsWith('..') && !isAbsolute(relToRuns);
  if (insideRuns) {
    const runId = relToRuns.split(sep)[0]!;
    if (isHistoricalRun(runId)) {
      throw new FirewallError(
        `Refusing to write ${abs}: run ${runId} is historical and immutable (DATA-001).`,
        'HISTORICAL_WRITE',
      );
    }
  }
  return abs;
}

/**
 * The active authorisation for this process.
 *
 * Deny-by-default is the whole point: a Firewall constructed with no permit
 * grants nothing, so any code path that reaches a paid or publishing operation
 * without an explicit grant fails rather than proceeding.
 */
export interface PermitGrant {
  permitId: string;
  kind: string;
  capabilities: readonly Capability[];
  cells: ReadonlyArray<{ modelId: string; questionId: string }>;
  budgetCapUsd: number;
}

/**
 * Unambiguous composite key. A plain concatenation or a single-character
 * separator can collide when one component contains the separator, and model
 * ids are vendor/model slugs with punctuation. JSON encoding is injective.
 */
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

  /** Constructed only from a permit that has already passed signature verification. */
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

  /** Throws unless the active permit explicitly grants `capability`. */
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

  /**
   * RUN-001. Inference is authorised per (model, item) cell, not wholesale.
   * An empty cell list authorises nothing — absence is denial.
   */
  requireCell(modelId: string, questionId: string, context: string): void {
    if (!this.grant) {
      throw new FirewallError(
        `${context} requires an authorised cell but no permit is active.`,
        'NO_PERMIT',
      );
    }
    if (!this.cellIndex.has(cellKey(modelId, questionId))) {
      throw new FirewallError(
        `Permit ${this.grant.permitId} does not authorise ${modelId} × ${questionId}.`,
        'CELL_NOT_AUTHORISED',
      );
    }
  }
}

/**
 * RELEASE-002. The publication gate.
 *
 * Every class other than an approved public-release manifest fails closed here,
 * which is why sync and publish call it before touching anything live.
 */
export function assertPublishable(
  manifest: Pick<RunManifest, 'runId' | 'evidenceClass' | 'releaseState'>,
  context: string,
): void {
  if (!canPublish(manifest)) {
    throw new FirewallError(
      `${context} refused for run ${manifest.runId}: evidenceClass '${manifest.evidenceClass}' / releaseState '${manifest.releaseState}'. ` +
        `Only an approved 'public-release' manifest in 'released' may create a public result (RELEASE-002).`,
      'INELIGIBLE_EVIDENCE',
    );
  }
}

/** Surfaces built from shadow or probe evidence must carry this verbatim. */
export function nonScoringBanner(evidenceClass: EvidenceClass): string | null {
  return evidenceClass === 'legacy-shadow' || evidenceClass === 'development-probe'
    ? NON_SCORING_LABEL
    : null;
}
