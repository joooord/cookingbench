import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/dataset.js';

/**
 * RUN-001A validator for the curated semantic route registry.
 *
 * The inventory is an acceptance artifact, so it gets the same treatment as
 * code. An unreviewable or drifting inventory is worse than none, because it
 * reads as coverage.
 *
 * Route identity is curated, not inferred: the previous generator derived ids
 * from `sha256(file|kind|symbol)` where symbol came from auditor prose, which
 * invented 41 symbols that appear nowhere in the source.
 */

interface Risk {
  risk: string;
  status: 'open' | 'closed';
  capability?: string | null;
  enforcementPoint: string;
  test: string | null;
}
interface Route {
  key: string;
  file: string;
  function: string;
  kind: string;
  operation: string;
  risks: Risk[];
}
interface Registry {
  pinnedCommit: string;
  routeKinds: string[];
  routes: Route[];
}

const CAPABILITIES = [
  'catalog-read',
  'candidate-inference',
  'judge-inference',
  'development-db-write',
  'live-db-write',
  'presentation-erratum',
  'result-sync',
  'publication',
];
const RISKS = [
  'historical-overwrite',
  'unauthorised-publish',
  'budget-bypass',
  'unauthorised-inference',
];

const registry = parse(
  readFileSync(join(REPO_ROOT, 'docs/wp-0/routes.yaml'), 'utf8'),
) as Registry;

/** Every named test case that actually exists, harvested from the test files. */
function declaredTestNames(): Set<string> {
  const dir = join(REPO_ROOT, 'packages/runner/test');
  const names = new Set<string>();
  const describes: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    let current = '';
    for (const line of src.split('\n')) {
      const d = /^\s*describe\(\s*['"`](.+?)['"`]/.exec(line);
      if (d) {
        current = d[1]!;
        describes.push(current);
      }
      const i = /^\s*it(?:\.each\([^)]*\))?\(\s*['"`](.+?)['"`]/.exec(line);
      if (i) names.add(`${current} > ${i[1]!}`);
    }
  }
  return names;
}

describe('route registry is acceptance-grade', () => {
  it('has a unique key per route', () => {
    const keys = registry.routes.map((r) => r.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('uses the declared route-kind vocabulary', () => {
    for (const route of registry.routes) {
      expect(registry.routeKinds, route.key).toContain(route.kind);
    }
  });

  it('names only source files that exist, with a real enclosing function', () => {
    for (const route of registry.routes) {
      const path = join(REPO_ROOT, route.file);
      expect(existsSync(path), `${route.key}: ${route.file} missing`).toBe(true);
      const src = readFileSync(path, 'utf8');
      // Bidirectional anchor: the named function must actually be there, so a
      // rename or deletion fails the build rather than leaving a phantom route.
      expect(src.includes(route.function), `${route.key}: ${route.function} not found in ${route.file}`).toBe(
        true,
      );
    }
  });

  it('uses only vocabulary risks and capabilities', () => {
    for (const route of registry.routes) {
      expect(route.risks.length, `${route.key} has no risks`).toBeGreaterThan(0);
      for (const risk of route.risks) {
        expect(RISKS, `${route.key}`).toContain(risk.risk);
        expect(['open', 'closed']).toContain(risk.status);
        if (risk.capability) expect(CAPABILITIES, `${route.key}`).toContain(risk.capability);
      }
    }
  });

  it('cites an EXACT named test case for every closed risk', () => {
    // Not merely an existing test file: the previous inventory pointed all 25
    // closed routes at one filename, which proves nothing about any of them.
    const known = declaredTestNames();
    for (const route of registry.routes) {
      for (const risk of route.risks.filter((r) => r.status === 'closed')) {
        expect(risk.test, `${route.key}/${risk.risk} closed with no test`).toBeTruthy();
        expect(known.has(risk.test!), `${route.key}/${risk.risk}: no test named "${risk.test}"`).toBe(true);
        expect(risk.enforcementPoint).not.toMatch(/NOT YET|unassigned/i);
      }
    }
  });

  it('never claims an open risk is enforced', () => {
    for (const route of registry.routes) {
      for (const risk of route.risks.filter((r) => r.status === 'open')) {
        expect(risk.test, `${route.key}/${risk.risk} is open but cites a test`).toBeNull();
      }
    }
  });

  it('derives route status as open until every risk is closed', () => {
    // Reported here rather than stored, so the two cannot drift apart.
    const status = (r: Route) => (r.risks.every((x) => x.status === 'closed') ? 'closed' : 'open');
    const open = registry.routes.filter((r) => status(r) === 'open');
    const closed = registry.routes.filter((r) => status(r) === 'closed');
    expect(open.length + closed.length).toBe(registry.routes.length);
    // A route with any open risk is open even if other risks are closed —
    // leaderboard:write is closed for overwrite but open for publication.
    const board = registry.routes.find((r) => r.key === 'runner:store:leaderboard:write')!;
    expect(status(board)).toBe('open');
  });

  it('covers every filesystem, network and database sink in the runner', () => {
    // Bidirectional completeness: a new writer with no registry entry fails.
    const srcDir = join(REPO_ROOT, 'packages/runner/src');
    // Widened after the ledger and the redemption record both wrote through
    // `openSync`/`appendFileSync` and slipped past a pattern that only knew
    // about `writeFileSync`. A completeness check is only as complete as its
    // list of what counts as a sink.
    //
    // `.from(` is the Supabase table accessor, but bare `\.from\(` also matches
    // `Array.from(...)` and `Object.fromEntries` — which is how simulate.ts, a
    // pure-arithmetic module with no sink of any kind, was flagged as an
    // unregistered database route. A completeness check that cries wolf gets
    // suppressed, so the built-ins are excluded rather than the file.
    const sinkPattern =
      /writeFileSync|appendFileSync|openSync|copyFileSync|renameSync|rmSync|unlinkSync|mkdirSync|fetch\(|(?<!Array)(?<!Object)\.from\(/;
    const uncovered: string[] = [];
    const covered = new Set(registry.routes.map((r) => r.file));
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const rel = relative(REPO_ROOT, join(srcDir, file));
      const src = readFileSync(join(srcDir, file), 'utf8');
      if (!sinkPattern.test(src)) continue;
      // firewall.ts is the enforcement layer itself; mock.ts writes nothing real.
      if (/firewall\.ts|mock\.ts/.test(rel)) continue;
      if (!covered.has(rel)) uncovered.push(rel);
    }
    expect(uncovered, 'sinks with no registry route').toEqual([]);
  });

  it('reports honest totals', () => {
    const risks = registry.routes.flatMap((r) => r.risks);
    const totals = {
      routes: registry.routes.length,
      risks: risks.length,
      closedRisks: risks.filter((r) => r.status === 'closed').length,
      openRisks: risks.filter((r) => r.status === 'open').length,
      openRoutes: registry.routes.filter((r) => r.risks.some((x) => x.status === 'open')).length,
    };
    expect(totals.closedRisks + totals.openRisks).toBe(totals.risks);
    expect(totals.openRoutes).toBeGreaterThan(0); // WP-0 is not complete
    console.log('route registry totals:', JSON.stringify(totals));
  });
});
