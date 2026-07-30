import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/dataset.js';

/**
 * RUN-001A validator. The inventory is an acceptance artifact, so it needs the
 * same treatment as code: an unreviewable or drifting inventory is worse than
 * none, because it looks like coverage.
 */

interface Route {
  routeId: string;
  sink: string;
  symbol: string;
  kind: string;
  riskTags: string[];
  capabilities: string[];
  disposition: string;
  enforcementPoint: string;
  test: string | null;
  rationale: string;
  sinkExists: boolean;
  observationCount: number;
  observations: unknown[];
}

interface Inventory {
  schemaVersion: number;
  vocabularies: { riskTags: string[]; capabilities: string[]; dispositions: string[] };
  totals: {
    routes: number;
    observations: number;
    dangerousRoutes: number;
    closed: number;
    open: number;
    noAction: number;
  };
  routes: Route[];
}

const PATH = join(REPO_ROOT, 'docs/wp-0/route-inventory.json');
const inventory = JSON.parse(readFileSync(PATH, 'utf8')) as Inventory;

describe('route inventory is acceptance-grade', () => {
  it('has a unique routeId per route', () => {
    const ids = inventory.routes.map((r) => r.routeId);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(dupes).toEqual([]);
  });

  it('totals match the routes actually present — no drift', () => {
    const { routes } = inventory;
    expect(inventory.totals.routes).toBe(routes.length);
    expect(inventory.totals.closed).toBe(routes.filter((r) => r.disposition === 'closed').length);
    expect(inventory.totals.open).toBe(routes.filter((r) => r.disposition === 'open').length);
    expect(inventory.totals.noAction).toBe(routes.filter((r) => r.disposition === 'no-action').length);
    expect(inventory.totals.observations).toBe(
      routes.reduce((sum, r) => sum + r.observationCount, 0),
    );
    expect(inventory.totals.dangerousRoutes).toBe(
      routes.filter((r) => !r.riskTags.every((t) => t === 'benign')).length,
    );
  });

  it('names only sinks that still exist', () => {
    const stale = inventory.routes
      .filter((r) => r.sink !== 'unknown' && !existsSync(join(REPO_ROOT, r.sink)))
      .map((r) => `${r.routeId} ${r.sink}`);
    expect(stale).toEqual([]);
  });

  it('uses only vocabulary terms, never free text', () => {
    for (const route of inventory.routes) {
      expect(inventory.vocabularies.dispositions).toContain(route.disposition);
      for (const tag of route.riskTags) expect(inventory.vocabularies.riskTags).toContain(tag);
      for (const cap of route.capabilities) expect(inventory.vocabularies.capabilities).toContain(cap);
    }
  });

  it('has no "closed" route without a real, existing test file', () => {
    // The failure mode this catches: marking a route closed to improve the
    // coverage number without anything actually proving it.
    for (const route of inventory.routes.filter((r) => r.disposition === 'closed')) {
      expect(route.test, `${route.routeId} (${route.sink}) is closed with no test`).toBeTruthy();
      expect(existsSync(join(REPO_ROOT, route.test!)), `${route.test} does not exist`).toBe(true);
      expect(route.enforcementPoint).not.toMatch(/NOT YET|unassigned/i);
    }
  });

  it('retains untruncated observation evidence for every route', () => {
    for (const route of inventory.routes) {
      expect(route.observations.length).toBe(route.observationCount);
      expect(route.observationCount).toBeGreaterThan(0);
    }
  });

  it('does not claim any open route is enforced', () => {
    for (const route of inventory.routes.filter((r) => r.disposition === 'open')) {
      expect(route.test).toBeNull();
    }
  });

  it('classifies the catalog fetch as network activity, not benign', () => {
    // Explicitly reclassified: a live OpenRouter catalog fetch is network
    // activity requiring catalog-read, not a no-action route.
    const openrouter = inventory.routes.filter((r) => r.sink.includes('openrouter.ts'));
    expect(openrouter.length).toBeGreaterThan(0);
    for (const route of openrouter) {
      expect(route.disposition).toBe('open');
      expect(route.capabilities.length).toBeGreaterThan(0);
    }
  });
});
