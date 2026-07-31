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

interface ProposedDecision {
  id: string;
  question: string;
  argument: string;
  recommendation: string;
  status: string;
}

interface Requirement {
  id: string;
  statement: string;
  status: 'closed' | 'partial' | 'open';
  enforcementPoints: string[];
  tests: string[];
  gaps: string[];
  /**
   * Boundaries of the mechanism, not work left undone. See the matrix header:
   * a `closed` requirement may carry limitations and may not carry gaps.
   */
  limitations?: string[];
  /**
   * A scope question that must be ANSWERED before the requirement can move,
   * recorded rather than decided in an implementation commit. The brief is
   * explicit that a requirement must not be quietly reinterpreted to make the
   * matrix green; this field is where the alternative goes.
   */
  proposedDecisions?: ProposedDecision[];
}

const matrix = parse(readFileSync(join(REPO_ROOT, 'docs/wp-0/traceability.yaml'), 'utf8')) as {
  requirements: Requirement[];
};


/**
 * Read the title out of a `describe(...)` or `it(...)` line.
 *
 * Two bugs lived in the one-line regex this replaces, and both made an HONEST
 * citation look like a fabricated one — the worst direction for a completeness
 * checker to fail in, because the cheapest way to make the suite pass is to
 * weaken the citation.
 *
 *   1. `['"`](.+?)['"`]` ends a lazy match at the first quote of ANY kind, so
 *      `it('… reading it as "no disputes"')` indexed as `… reading it as `.
 *   2. It did not understand escapes, so `describe('… this run\'s own')`
 *      indexed as `… this run\`.
 *
 * The quote character is captured and back-referenced, escaped characters are
 * consumed as a unit, and the result is unescaped — so the harvested name is
 * the string the runtime sees.
 *
 * `it.each` titles are harvested in TEMPLATE form (`… changes %s`), because
 * that is what the source says; vitest expands the placeholder per case at run
 * time. A citation therefore names the template, which is the only stable
 * identifier the case has.
 */
const TITLE = {
  describe: (line: string): string | null => title(/^\s*describe(?:\.\w+)?\(\s*/, line),
  it: (line: string): string | null => title(/^\s*it(?:\.each\([^)]*\))?(?:\.\w+)?\(\s*/, line),
};

function title(prefix: RegExp, line: string): string | null {
  const head = prefix.exec(line);
  if (!head) return null;
  const rest = line.slice(head[0].length);
  const quote = rest[0];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let out = '';
  for (let i = 1; i < rest.length; i++) {
    const ch = rest[i]!;
    if (ch === '\\') {
      // Consume the escape as a unit and keep what it denotes, so the harvested
      // name matches the string the runtime builds.
      const next = rest[++i];
      if (next === undefined) return null;
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      continue;
    }
    if (ch === quote) return out;
    out += ch;
  }
  return null;
}

/** Every named test case that actually exists, harvested from the test files. */
function declaredTestNames(): Set<string> {
  const dir = join(REPO_ROOT, 'packages/runner/test');
  const names = new Set<string>();
  let current = '';
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.test.ts'))) {
    const src = readFileSync(join(dir, file), 'utf8');
    for (const line of src.split('\n')) {
      const d = TITLE.describe(line);
      if (d !== null) current = d;
      const i = TITLE.it(line);
      if (i !== null) names.add(`${current} > ${i}`);
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

  it('keeps a LIMITATION from doing a gap\'s job', () => {
    // The distinction the header introduces, enforced rather than trusted. A
    // limitation is a boundary of the mechanism; a gap is work not done. The
    // hazard is one-directional and obvious: reclassify an unfinished gap as a
    // permanent limitation and the requirement reads closed for free.
    //
    // No validator can tell those apart by reading the prose, so this checks
    // what it can — a limitation must be stated, at length, on a requirement
    // that has enforcement behind it, and it may never be the ONLY thing a
    // requirement has to say for itself.
    for (const req of matrix.requirements) {
      for (const limitation of req.limitations ?? []) {
        expect(limitation.length, `${req.id}: a limitation is stated too thinly to review`).toBeGreaterThan(80);
      }
      if ((req.limitations ?? []).length > 0) {
        expect(req.tests.length, `${req.id} claims a limitation but cites no test`).toBeGreaterThan(0);
      }
    }
  });

  it('records a scope question as a DECISION rather than resolving it quietly', () => {
    // The brief's rule: "Do not weaken a requirement merely to make the matrix
    // green. If a requirement truly needs revision, stop, record the proposed
    // formal decision and explain why." A requirement carrying an unanswered
    // decision must NOT be closed — that is the whole point of recording it.
    for (const req of matrix.requirements) {
      for (const decision of req.proposedDecisions ?? []) {
        expect(decision.id, `${req.id}: a proposed decision has no id`).toMatch(/^[A-Z]+-\d+[A-Z]?-D\d+$/);
        expect(decision.question.length, `${decision.id}: no question`).toBeGreaterThan(30);
        // Both readings must be argued, not just the convenient one.
        expect(decision.argument.length, `${decision.id}: the argument is too thin to review`).toBeGreaterThan(200);
        expect(decision.recommendation.length, `${decision.id}: no recommendation`).toBeGreaterThan(60);
        expect(['awaiting-decision', 'accepted', 'rejected']).toContain(decision.status);
        if (decision.status === 'awaiting-decision') {
          expect(
            req.status,
            `${req.id} is closed while ${decision.id} is still awaiting a decision`,
          ).not.toBe('closed');
        }
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
      limitations: matrix.requirements.reduce((n, r) => n + (r.limitations ?? []).length, 0),
      awaitingDecision: matrix.requirements.reduce(
        (n, r) => n + (r.proposedDecisions ?? []).filter((d) => d.status === 'awaiting-decision').length,
        0,
      ),
      citedTests: new Set(matrix.requirements.flatMap((r) => r.tests)).size,
    };
    expect(totals.closed + totals.partial + totals.open).toBe(totals.requirements);
    // Deliberately NOT `expect(partial + open).toBeGreaterThan(0)`, which is
    // what stood here. That asserted WP-0 is incomplete — so the day it became
    // complete, this suite would have failed, and the cheapest way to make it
    // pass again would have been to reopen a requirement. A ratchet pointing
    // the wrong way. The totals are reported; whether they are good enough is
    // the reader's call, not this test's.
    console.log('traceability totals:', JSON.stringify(totals));
  });
});
