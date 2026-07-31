/**
 * TRACE-001 — deterministic regeneration of the WP-0 acceptance summary.
 *
 * WHY THIS EXISTS
 *
 * The acceptance artifacts for WP-0 are two hand-maintained YAML files —
 * `docs/wp-0/routes.yaml` (the route registry) and `docs/wp-0/traceability.yaml`
 * (the requirement matrix) — plus the brief they answer. Their *totals* were
 * being quoted in prose and printed by a `console.log` inside a test, which
 * means the headline numbers ("102 routes, 9 requirements, 3 closed") were
 * asserted by whoever last read the file. A number nothing recomputes is a
 * claim, not a measurement.
 *
 * So the totals are DERIVED, committed, and re-derived in CI. If someone edits a
 * risk from `open` to `closed`, or adds a requirement, or deletes a gap, the
 * committed summary stops matching and the build fails until it is regenerated.
 * The diff then shows exactly which acceptance number moved, in the same commit
 * as the change that moved it.
 *
 * WHY A SEPARATE FILE RATHER THAN A GENERATED BLOCK INSIDE THE YAML
 *
 * A generated region inside a hand-edited file gets hand-edited. Keeping the
 * derived numbers in their own artifact means the inputs stay entirely
 * hand-authored and the output stays entirely machine-authored, and neither can
 * be quietly confused for the other.
 *
 * DETERMINISM RULES OBSERVED HERE, AND WHY EACH ONE MATTERS
 *
 *  - No clock. No `Date`, no `Date.now()`, no `generatedAt`. A timestamp would
 *    make every regeneration a diff, which trains a reviewer to ignore the diff
 *    — and an ignored diff is the same as no check. `test/regeneration.test.ts`
 *    greps this file for the forbidden constructs.
 *  - No randomness, no environment, no current working directory. Paths come
 *    from `REPO_ROOT`, which is derived from this module's own URL.
 *  - No locale-sensitive comparison. Every sort is the default `Array#sort`
 *    (UTF-16 code-unit order); `localeCompare` would reorder under a different
 *    `LC_ALL` and produce a "spurious" diff on someone else's machine.
 *  - Keys are sorted recursively at serialisation time rather than relying on
 *    construction order, so a later edit that reorders a literal does not churn
 *    the artifact.
 *
 * THE PARSING IS STRICT ON PURPOSE
 *
 * Every shape assumption is checked and throws. The failure this avoids: an
 * input file changes shape, the reader quietly reads `undefined`, and the
 * summary regenerates cleanly with `routes: 0` — a broken input laundered into
 * a green build. Fail closed, loudly, naming the file and the entry.
 *
 * NO TRUST INPUTS, NO PARAMETERS
 *
 * None of the exported functions takes a path, a root, a clock or a definition
 * of completeness. This command is itself subject to the rule the work package
 * exists to enforce: the thing being checked must not choose the checker's
 * inputs or scope, and a "just for tests" root parameter here would be
 * reachable from anywhere. Tests exercise exactly what CI exercises.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { REPO_ROOT } from './dataset.js';

/** The committed artifact this command owns. Not a parameter. */
export const ACCEPTANCE_SUMMARY_PATH = join(REPO_ROOT, 'docs/wp-0/acceptance-summary.json');

/**
 * Everything the summary is derived from, repo-relative and fixed.
 *
 * Listed here rather than discovered by globbing: a glob would silently change
 * the summary's meaning when an unrelated file appeared in the directory, and
 * the set of acceptance inputs is a decision, not a directory listing.
 */
const INPUT_FILES = [
  'docs/methodology/CookingBench-methodology-first-master-plan.sha256',
  'docs/methodology/WP-0-start-brief.md',
  'docs/wp-0/routes.yaml',
  'docs/wp-0/traceability.yaml',
] as const;

export class RegenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegenerationError';
  }
}

// ---------------------------------------------------------------------------
// Canonical serialisation
// ---------------------------------------------------------------------------

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/**
 * Recursively key-sorted JSON, two-space indented, one trailing newline.
 *
 * `canonicalJson()` in core is the hashing form — compact, no indentation —
 * and is deliberately not reused here: this artifact is reviewed as a diff, and
 * a single-line JSON file makes every change look like a total rewrite.
 */
export function stableStringify(value: Json): string {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    // Default sort: code-unit order, identical under every locale. See the
    // determinism rules in the module header.
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]!);
    return out;
  }
  return value;
}

function sha256Of(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readInput(relativePath: string): string {
  const path = join(REPO_ROOT, relativePath);
  if (!existsSync(path)) {
    throw new RegenerationError(
      `Acceptance input ${relativePath} is missing. The summary is derived from a fixed set of inputs; ` +
        `regenerating without one would publish totals for a document that no longer exists.`,
    );
  }
  return readFileSync(path, 'utf8');
}

// ---------------------------------------------------------------------------
// The brief — the authority for which requirements exist
// ---------------------------------------------------------------------------

/**
 * Requirement ids come from the BRIEF, never from the matrix.
 *
 * The matrix once hand-typed its own definition of "every requirement" and
 * omitted RUN-002, so its self-validation passed while a tenth requirement went
 * unanswered. A summary that took its denominator from the matrix would repeat
 * that mistake with an authoritative-looking number on it.
 */
function requirementIdsFromBrief(brief: string): string[] {
  const ids = [...brief.matchAll(/^###\s+`([A-Z]+-\d+[A-Z]?)`/gm)].map((m) => m[1]!);
  if (ids.length === 0) {
    throw new RegenerationError('No requirement headings found in the WP-0 brief — its format has changed.');
  }
  return [...ids].sort();
}

/** The numbered list under "## Mandatory tests". Counted, so the brief's own bar is recorded. */
function mandatoryTestCount(brief: string): number {
  const section = /##\s+Mandatory tests\n([\s\S]*?)(?:\n##\s|$)/.exec(brief);
  if (!section) {
    throw new RegenerationError('The WP-0 brief no longer has a "Mandatory tests" section.');
  }
  const count = [...section[1]!.matchAll(/^\d+\.\s+/gm)].length;
  if (count === 0) {
    throw new RegenerationError('The WP-0 brief\'s "Mandatory tests" section lists no numbered items.');
  }
  return count;
}

// ---------------------------------------------------------------------------
// The traceability matrix
// ---------------------------------------------------------------------------

export interface MatrixRequirement {
  id: string;
  status: string;
  enforcementPoints: string[];
  tests: string[];
  gaps: string[];
}

const REQUIREMENT_STATUSES = ['closed', 'partial', 'open'] as const;

/**
 * Exported so the strictness can be attacked with malformed input.
 *
 * It takes CONTENT, never a path: a test can hand it a broken document, and no
 * caller can redirect which documents the summary is built from. That
 * distinction is the whole point of the work package — a pure parser over
 * supplied text is not a trust input; a parameter naming the file to trust is.
 */
export function parseTraceabilityMatrix(raw: string): MatrixRequirement[] {
  const doc = parseYaml(raw) as { requirements?: unknown };
  const list = doc?.requirements;
  if (!Array.isArray(list) || list.length === 0) {
    throw new RegenerationError('docs/wp-0/traceability.yaml has no `requirements` list.');
  }
  return list.map((entry, index) => {
    const r = entry as Record<string, unknown>;
    const id = r.id;
    if (typeof id !== 'string' || id === '') {
      throw new RegenerationError(`traceability.yaml requirement #${index + 1} has no id.`);
    }
    if (typeof r.status !== 'string' || !(REQUIREMENT_STATUSES as readonly string[]).includes(r.status)) {
      throw new RegenerationError(
        `traceability.yaml ${id} has status ${JSON.stringify(r.status)}, which is not one of ` +
          `[${REQUIREMENT_STATUSES.join(', ')}]. An unrecognised status must not be counted as anything.`,
      );
    }
    return {
      id,
      status: r.status,
      enforcementPoints: stringList(r.enforcementPoints, `${id}.enforcementPoints`),
      tests: stringList(r.tests, `${id}.tests`),
      gaps: stringList(r.gaps, `${id}.gaps`),
    };
  });
}

function stringList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new RegenerationError(`${label} must be a list of strings.`);
  }
  return value as string[];
}

// ---------------------------------------------------------------------------
// The route registry
// ---------------------------------------------------------------------------

export interface RegistryRoute {
  key: string;
  file: string;
  kind: string;
  risks: Array<{ risk: string; severity: string; status: string }>;
}

export interface Registry {
  scanRoots: string[];
  routeKinds: string[];
  riskKinds: string[];
  severities: string[];
  routes: RegistryRoute[];
  falselyClosed: number;
  /** Of those, the ones whose route still carries an open risk. Only these block. */
  falselyClosedStillOpen: number;
}

/** Exported for the same reason as `parseTraceabilityMatrix`, and on the same terms. */
export function parseRouteRegistry(raw: string): Registry {
  const doc = parseYaml(raw) as Record<string, unknown>;
  const routes = doc.routes;
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new RegenerationError('docs/wp-0/routes.yaml has no `routes` list.');
  }
  const routeKinds = stringList(doc.routeKinds, 'routes.yaml routeKinds');
  const riskKinds = stringList(doc.riskKinds, 'routes.yaml riskKinds');
  const severities = stringList(doc.severities, 'routes.yaml severities');
  const parsed: RegistryRoute[] = routes.map((entry, index) => {
    const r = entry as Record<string, unknown>;
    const key = r.key;
    if (typeof key !== 'string' || key === '') {
      throw new RegenerationError(`routes.yaml route #${index + 1} has no key.`);
    }
    if (typeof r.file !== 'string' || typeof r.kind !== 'string') {
      throw new RegenerationError(`routes.yaml ${key} must declare a file and a kind.`);
    }
    // A declared vocabulary that the entries do not respect is worse than no
    // vocabulary: the totals below bucket by kind, and an unknown kind would
    // create a silent bucket nobody reads.
    if (!routeKinds.includes(r.kind)) {
      throw new RegenerationError(
        `routes.yaml ${key} has kind '${r.kind}', which is not in the declared routeKinds [${routeKinds.join(', ')}].`,
      );
    }
    if (!Array.isArray(r.risks) || r.risks.length === 0) {
      throw new RegenerationError(
        `routes.yaml ${key} lists no risks. A registered route with no risk is a route nobody assessed.`,
      );
    }
    const risks = r.risks.map((riskEntry, riskIndex) => {
      const k = riskEntry as Record<string, unknown>;
      const where = `${key} risk #${riskIndex + 1}`;
      if (typeof k.risk !== 'string' || !riskKinds.includes(k.risk)) {
        throw new RegenerationError(`routes.yaml ${where} has risk ${JSON.stringify(k.risk)}, not in riskKinds.`);
      }
      if (typeof k.severity !== 'string' || !severities.includes(k.severity)) {
        throw new RegenerationError(`routes.yaml ${where} has severity ${JSON.stringify(k.severity)}, not in severities.`);
      }
      if (k.status !== 'open' && k.status !== 'closed') {
        throw new RegenerationError(
          `routes.yaml ${where} has status ${JSON.stringify(k.status)}; only 'open' and 'closed' are countable.`,
        );
      }
      return { risk: k.risk, severity: k.severity, status: k.status };
    });
    return { key, file: r.file, kind: r.kind, risks };
  });
  // `falselyClosed` is HISTORY: the risks a review reopened, kept so the record
  // of how a green matrix came to be wrong outlives the commit message. Most of
  // them are legitimately closed again. Counting the whole list as a blocker
  // therefore made the summary report a permanent failure for work that was
  // done — so the blocker counts only the entries whose ROUTE still has an open
  // risk, while the full list is still reported for the record.
  const falselyClosedEntries = Array.isArray(doc.falselyClosed) ? doc.falselyClosed : [];
  const openRouteKeys = new Set(
    parsed.filter((r) => r.risks.some((k) => k.status === 'open')).map((r) => r.key),
  );
  const falselyClosed = falselyClosedEntries.length;
  const falselyClosedStillOpen = falselyClosedEntries.filter((e) => {
    const route = (e as Record<string, unknown>).route;
    return typeof route === 'string' && openRouteKeys.has(route);
  }).length;
  return {
    scanRoots: stringList(doc.scanRoots, 'routes.yaml scanRoots'),
    routeKinds,
    riskKinds,
    severities,
    routes: parsed,
    falselyClosed,
    falselyClosedStillOpen,
  };
}

/** Counts keyed by a declared vocabulary, so a zero bucket is visible rather than missing. */
function tally(vocabulary: readonly string[], values: readonly string[]): { [key: string]: Json } {
  const counts: { [key: string]: Json } = {};
  for (const term of vocabulary) counts[term] = 0;
  for (const value of values) counts[value] = (counts[value] as number) + 1;
  return counts;
}

// ---------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------

/**
 * Build the exact bytes of the committed acceptance summary.
 *
 * Pure with respect to everything except the four committed input files: same
 * inputs, same bytes, on any machine, in any directory, under any locale or
 * timezone.
 */
export function buildAcceptanceSummary(): string {
  const contents = new Map<string, string>();
  const inputs = INPUT_FILES.map((path) => {
    const text = readInput(path);
    contents.set(path, text);
    // Hashed as UTF-8 bytes of the text actually parsed, so the digest is over
    // what the totals were computed from.
    return { path, sha256: sha256Of(text) };
  });

  const brief = contents.get('docs/methodology/WP-0-start-brief.md')!;
  const declared = requirementIdsFromBrief(brief);
  const matrix = parseTraceabilityMatrix(contents.get('docs/wp-0/traceability.yaml')!);
  const registry = parseRouteRegistry(contents.get('docs/wp-0/routes.yaml')!);

  // The frozen methodology digest every permit binds to. Recorded here because
  // an acceptance summary that cannot say which plan revision it accepts is
  // accepting an unnamed document.
  const sidecar = contents.get('docs/methodology/CookingBench-methodology-first-master-plan.sha256')!;
  const methodologyHash = /^[a-f0-9]{64}/.exec(sidecar.trim())?.[0];
  if (!methodologyHash) {
    throw new RegenerationError('The methodology sidecar does not start with a sha256 digest.');
  }

  const documented = [...matrix.map((r) => r.id)].sort();
  const undocumented = declared.filter((id) => !documented.includes(id));
  const extra = documented.filter((id) => !declared.includes(id));

  const allRisks = registry.routes.flatMap((route) => route.risks);
  const openRisks = allRisks.filter((risk) => risk.status === 'open');
  const openHighRoutes = registry.routes
    .filter((route) => route.risks.some((risk) => risk.status === 'open' && risk.severity === 'high'))
    .map((route) => route.key)
    .sort();

  // Completeness is DECLARED here, not by a caller, and it is deliberately
  // strict: WP-0 is complete only when every requirement is closed, every
  // registered risk is closed, no risk is recorded as falsely closed, and the
  // matrix answers exactly the brief. Anything softer would let the artifact
  // report success while the gaps it lists were still open.
  const blockers: string[] = [];
  for (const id of undocumented) blockers.push(`${id} is in the brief and absent from the traceability matrix`);
  for (const id of extra) blockers.push(`${id} is in the traceability matrix and not in the brief`);
  for (const req of matrix) {
    if (req.status !== 'closed') blockers.push(`${req.id} is ${req.status} with ${req.gaps.length} recorded gap(s)`);
  }
  if (openRisks.length > 0) blockers.push(`${openRisks.length} registered route risk(s) are open`);
  if (registry.falselyClosedStillOpen > 0) {
    blockers.push(
      `${registry.falselyClosedStillOpen} reopened risk(s) are still open ` +
        `(of ${registry.falselyClosed} recorded)`,
    );
  }
  blockers.sort();

  const summary: Json = {
    summaryVersion: 1,
    generatedBy: 'packages/runner/src/regenerate.ts',
    note:
      'Generated. Do not hand-edit: run `pnpm --filter @cookingbench/runner exec tsx src/regenerate.ts --write` ' +
      'and commit the result alongside the change that moved these numbers. No timestamp by design.',
    methodologyHash,
    inputs: inputs.map((i) => ({ path: i.path, sha256: i.sha256 })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    requirements: {
      declaredInBrief: declared,
      documentedInMatrix: documented,
      totals: {
        declared: declared.length,
        documented: documented.length,
        closed: matrix.filter((r) => r.status === 'closed').length,
        partial: matrix.filter((r) => r.status === 'partial').length,
        open: matrix.filter((r) => r.status === 'open').length,
        gaps: matrix.reduce((n, r) => n + r.gaps.length, 0),
        citedTests: new Set(matrix.flatMap((r) => r.tests)).size,
        enforcementPoints: matrix.reduce((n, r) => n + r.enforcementPoints.length, 0),
      },
      // Per requirement: counts plus a digest over the requirement's own
      // content. The digest is what makes a silent edit visible — rewording a
      // gap changes no count, and would otherwise regenerate to an identical
      // summary.
      byId: [...matrix]
        .sort((a, b) => (a.id < b.id ? -1 : 1))
        .map((r) => ({
          id: r.id,
          status: r.status,
          gaps: r.gaps.length,
          tests: r.tests.length,
          enforcementPoints: r.enforcementPoints.length,
          digest: sha256Of(
            stableStringify({
              id: r.id,
              status: r.status,
              enforcementPoints: r.enforcementPoints,
              tests: r.tests,
              gaps: r.gaps,
            }),
          ).slice(0, 16),
        })),
    },
    mandatoryTests: { declaredInBrief: mandatoryTestCount(brief) },
    routes: {
      scanRoots: [...registry.scanRoots].sort(),
      totals: {
        routes: registry.routes.length,
        files: new Set(registry.routes.map((r) => r.file)).size,
        risks: allRisks.length,
        openRisks: openRisks.length,
        closedRisks: allRisks.length - openRisks.length,
        falselyClosed: registry.falselyClosed,
        falselyClosedStillOpen: registry.falselyClosedStillOpen,
      },
      routesByKind: tally(registry.routeKinds, registry.routes.map((r) => r.kind)),
      openRisksByKind: tally(registry.riskKinds, openRisks.map((r) => r.risk)),
      openRisksBySeverity: tally(registry.severities, openRisks.map((r) => r.severity)),
      routesWithOpenHighSeverityRisk: openHighRoutes,
    },
    acceptance: {
      wp0Complete: blockers.length === 0,
      blockers,
    },
  };

  return stableStringify(summary);
}

// ---------------------------------------------------------------------------
// Check / write
// ---------------------------------------------------------------------------

export interface DriftReport {
  ok: boolean;
  /** Human-readable, and specific enough to act on without re-running anything. */
  detail: string;
}

/** Compare the committed artifact with a fresh regeneration. */
export function checkAcceptanceSummary(): DriftReport {
  const expected = buildAcceptanceSummary();
  if (!existsSync(ACCEPTANCE_SUMMARY_PATH)) {
    return { ok: false, detail: 'docs/wp-0/acceptance-summary.json is missing.' };
  }
  const actual = readFileSync(ACCEPTANCE_SUMMARY_PATH, 'utf8');
  if (actual === expected) return { ok: true, detail: 'docs/wp-0/acceptance-summary.json is up to date.' };
  return { ok: false, detail: firstDifference(actual, expected) };
}

/** Report the first differing line — enough to see which total moved. */
function firstDifference(actual: string, expected: string): string {
  const a = actual.split('\n');
  const b = expected.split('\n');
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      return (
        `docs/wp-0/acceptance-summary.json is stale at line ${i + 1}:\n` +
        `    committed:   ${a[i] ?? '<end of file>'}\n` +
        `    regenerated: ${b[i] ?? '<end of file>'}`
      );
    }
  }
  return 'docs/wp-0/acceptance-summary.json differs only in trailing bytes.';
}

/** Write the artifact. Returns true when the bytes changed. */
export function writeAcceptanceSummary(): boolean {
  const expected = buildAcceptanceSummary();
  const current = existsSync(ACCEPTANCE_SUMMARY_PATH)
    ? readFileSync(ACCEPTANCE_SUMMARY_PATH, 'utf8')
    : null;
  if (current === expected) return false;
  writeFileSync(ACCEPTANCE_SUMMARY_PATH, expected);
  return true;
}

const REGENERATE_COMMAND = 'pnpm --filter @cookingbench/runner exec tsx src/regenerate.ts --write';

function main(argv: readonly string[]): number {
  const write = argv.includes('--write');
  const check = argv.includes('--check');
  const print = argv.includes('--print');
  if ([write, check, print].filter(Boolean).length > 1) {
    console.error('✗ Pass exactly one of --write, --check or --print.');
    return 1;
  }
  try {
    if (print) {
      // Writes the artifact to stdout and touches no file. Exists so the
      // determinism claim can be tested across PROCESSES by comparing bytes,
      // rather than by comparing two verdicts about the same committed file —
      // two runs can agree on a verdict while disagreeing on content.
      process.stdout.write(buildAcceptanceSummary());
      return 0;
    }
    if (write) {
      const changed = writeAcceptanceSummary();
      console.log(
        changed
          ? '✓ docs/wp-0/acceptance-summary.json regenerated — review the diff and commit it.'
          : '✓ docs/wp-0/acceptance-summary.json was already up to date.',
      );
      return 0;
    }
    // Default is --check. A command that rewrote a committed artifact when
    // invoked with no arguments would make "I ran it to see" indistinguishable
    // from "I changed it".
    const report = checkAcceptanceSummary();
    if (report.ok) {
      console.log(`✓ ${report.detail}`);
      return 0;
    }
    console.error(`✗ ${report.detail}\n  Regenerate with: ${REGENERATE_COMMAND}`);
    return 1;
  } catch (error) {
    console.error(`✗ ${(error as Error).message}`);
    return 1;
  }
}

// Executed only when this file is the entry point, so importing it from a test
// never runs the CLI.
//
// `main` is deliberately NOT exported. The regeneration test drives the CLI as
// a subprocess, through this exact line, because an exported `main(argv)` is a
// second entry point with its own argument handling — and a test that proves
// the second one proves nothing about the one CI runs.
if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main(process.argv.slice(2)));
}
