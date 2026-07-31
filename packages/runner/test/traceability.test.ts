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

/**
 * The requirement list is DERIVED from the brief, never hand-typed.
 *
 * It was hand-typed, and RUN-002 (protocol consistency) was omitted — so the
 * matrix contained nine requirements, the brief contained ten, and the test
 * named "covers every WP-0 requirement exactly once" passed. A validator whose
 * definition of "every" comes from the same author as the thing it validates
 * checks nothing; it launders an omission into a green tick. Reading the brief
 * means a requirement added there fails this suite until it is answered.
 */
function requirementIdsFromBrief(): string[] {
  const brief = readFileSync(join(REPO_ROOT, 'docs/methodology/WP-0-start-brief.md'), 'utf8');
  const ids = [...brief.matchAll(/^###\s+`([A-Z]+-\d+[A-Z]?)`/gm)].map((m) => m[1]!);
  if (ids.length === 0) throw new Error('No requirement headings found in the WP-0 brief.');
  return ids;
}

const REQUIRED_IDS = requirementIdsFromBrief();

describe('WP-0 traceability matrix is acceptance-grade', () => {
  it('covers every WP-0 requirement exactly once', () => {
    // Compared as sorted sets: the brief's presentation order is not a contract,
    // but its CONTENTS are. A requirement in the brief and absent here fails.
    expect([...matrix.requirements.map((r) => r.id)].sort()).toEqual([...REQUIRED_IDS].sort());
  });

  it('cites an EXACT named test case for every requirement', () => {
    const known = declaredTestNames();
    for (const req of matrix.requirements) {
      // An `open` requirement legitimately has no tests — there is nothing to
      // cite yet. Demanding one would push an author to cite a loosely-related
      // test, which is how a matrix starts overstating.
      if (req.status !== 'open') {
        expect(req.tests.length, `${req.id} cites no tests`).toBeGreaterThan(0);
      }
      for (const name of req.tests) {
        expect(known.has(name), `${req.id}: no test named "${name}"`).toBe(true);
      }
    }
  });

  it('names enforcement points in files that exist', () => {
    for (const req of matrix.requirements) {
      expect(req.enforcementPoints.length, `${req.id} names no enforcement`).toBeGreaterThan(0);
      for (const point of req.enforcementPoints) {
        if (point.startsWith('NOT ENFORCED')) continue; // an honest absence, not a path
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
