import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/dataset.js';

/**
 * Validator for the WP-0 requirement traceability matrix.
 *
 * The matrix is an acceptance artifact, so it is held to the same standard as
 * the route registry: every cited test must exist by EXACT name, every named
 * enforcement file must exist, a requirement marked `closed` may not carry
 * gaps, and a requirement carrying gaps may not be marked closed.
 *
 * Without those checks a matrix is a claim about the code that nothing forces
 * to stay true — and it would be read as coverage, which is worse than having
 * no matrix at all.
 */

interface Requirement {
  id: string;
  statement: string;
  status: 'closed' | 'partial' | 'open';
  enforcementPoints: string[];
  tests: string[];
  gaps: string[];
}

const matrix = parse(readFileSync(join(REPO_ROOT, 'docs/wp-0/traceability.yaml'), 'utf8')) as {
  requirements: Requirement[];
};

/** Every named test case that actually exists, harvested from the test files. */
function declaredTestNames(): Set<string> {
  const dir = join(REPO_ROOT, 'packages/runner/test');
  const names = new Set<string>();
  let current = '';
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const line of src.split('\n')) {
      const d = /^\s*describe\(\s*['"`](.+?)['"`]/.exec(line);
      if (d) current = d[1]!;
      const i = /^\s*it(?:\.each\([^)]*\))?\(\s*['"`](.+?)['"`]/.exec(line);
      if (i) names.add(`${current} > ${i[1]!}`);
    }
  }
  return names;
}

const REQUIRED_IDS = [
  'RUN-001',
  'RUN-001A',
  'DATA-001',
  'DATA-002',
  'RELEASE-001',
  'RELEASE-002',
  'JUDGE-001',
  'BUDGET-001',
  'TRACE-001',
];

describe('WP-0 traceability matrix is acceptance-grade', () => {
  it('covers every WP-0 requirement exactly once', () => {
    expect(matrix.requirements.map((r) => r.id)).toEqual(REQUIRED_IDS);
  });

  it('cites an EXACT named test case for every requirement', () => {
    const known = declaredTestNames();
    for (const req of matrix.requirements) {
      expect(req.tests.length, `${req.id} cites no tests`).toBeGreaterThan(0);
      for (const name of req.tests) {
        expect(known.has(name), `${req.id}: no test named "${name}"`).toBe(true);
      }
    }
  });

  it('names enforcement points in files that exist', () => {
    for (const req of matrix.requirements) {
      expect(req.enforcementPoints.length, `${req.id} names no enforcement`).toBeGreaterThan(0);
      for (const point of req.enforcementPoints) {
        const path = point.split(/\s+—\s+/)[0]!.trim();
        expect(existsSync(join(REPO_ROOT, path)), `${req.id}: ${path} does not exist`).toBe(true);
      }
    }
  });

  it('never marks a requirement closed while it carries gaps', () => {
    // The failure mode this exists for: quietly promoting a requirement to
    // `closed` while the caveats stay in the file, unread.
    for (const req of matrix.requirements) {
      expect(['closed', 'partial', 'open']).toContain(req.status);
      if (req.status === 'closed') {
        expect(req.gaps, `${req.id} is closed but lists gaps`).toEqual([]);
      } else {
        expect(req.gaps.length, `${req.id} is ${req.status} but lists no gap`).toBeGreaterThan(0);
      }
    }
  });

  it('reports honest totals', () => {
    const totals = {
      requirements: matrix.requirements.length,
      closed: matrix.requirements.filter((r) => r.status === 'closed').length,
      partial: matrix.requirements.filter((r) => r.status === 'partial').length,
      open: matrix.requirements.filter((r) => r.status === 'open').length,
      gaps: matrix.requirements.reduce((n, r) => n + r.gaps.length, 0),
      citedTests: new Set(matrix.requirements.flatMap((r) => r.tests)).size,
    };
    expect(totals.closed + totals.partial + totals.open).toBe(totals.requirements);
    expect(totals.partial + totals.open, 'WP-0 is not complete').toBeGreaterThan(0);
    console.log('traceability totals:', JSON.stringify(totals));
  });
});
