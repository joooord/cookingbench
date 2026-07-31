import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { RELEASE_STATES } from '@cookingbench/core';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, RUNS_DIR } from '../src/dataset.js';
import { isHistoricalRun } from '../src/firewall.js';

/**
 * Two findings from the WP-0 self-review that ordinary behaviour tests cannot
 * catch, because in both cases the CODE was right and the STORY it told was
 * wrong. A comment that contradicts its own line, and a matrix that claims
 * coverage the roster does not supply, both survive any amount of black-box
 * testing — and both mislead the next reader in the direction of doing less
 * work, which is the expensive direction.
 *
 * So these read the source and the acceptance artifact, in the same spirit as
 * traceability.test.ts and route-inventory.test.ts.
 */

const RUN = '__test-release-state-scratch';
const DIR = join(RUNS_DIR, RUN);

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(DIR, { recursive: true });
  writeFileSync(join(DIR, 'config.json'), JSON.stringify(config));
}

describe('the release-state guard says what it does', () => {
  const source = readFileSync(join(REPO_ROOT, 'packages/runner/src/firewall.ts'), 'utf8');
  /**
   * The guard's own body, without the prose around it.
   *
   * Scoped deliberately: the comment above the function QUOTES the defective
   * line so the next reader knows what not to write again, and a whole-file
   * scan would flag that quotation forever.
   */
  const guard = source.slice(
    source.indexOf('function isReleasedOnDisk('),
    source.indexOf('\n}\n', source.indexOf('function isReleasedOnDisk(')),
  );

  it('decides on a membership test rather than a disjunction that is always true', () => {
    // The defect: `return FROZEN_RELEASE_STATES.has(config.releaseState) || true;`
    // — unconditionally true, so the Set above it decided nothing. The
    // behaviour was correct and the line was a lie, which is worse than a plain
    // `return true` because the next person to add a release state would
    // "register" it in a set that had no effect and could not tell from the
    // call site whether their state froze or not.
    expect(guard.length, 'isReleasedOnDisk was renamed or removed').toBeGreaterThan(100);
    expect(guard, 'a tautological disjunction is back in the guard').not.toMatch(/\|\|\s*true\b/);
    expect(source, 'the dead frozen-state set is back').not.toMatch(/const\s+FROZEN_RELEASE_STATES/);
    expect(guard).toContain('RESUMABLE_RELEASE_STATES.has(config.releaseState)');
  });

  it('freezes every release state except the ones explicitly declared resumable', () => {
    // Pinned against the CORE vocabulary, not a hand-copied list, so adding a
    // sixth release state upstream fails here until somebody decides which side
    // it belongs on. Fail-closed means a new state freezes by default.
    const resumable = new Set(['draft', 'audited']);
    for (const state of RELEASE_STATES) {
      writeConfig({ releaseState: state });
      expect(isHistoricalRun(RUN), `releaseState '${state}'`).toBe(!resumable.has(state));
    }
  });

  it('freezes on a release state it has never heard of, and on unusable metadata', () => {
    for (const releaseState of ['published', 'DRAFT', ' draft', '', 0, null, [], { draft: true }]) {
      writeConfig({ releaseState });
      expect(isHistoricalRun(RUN), `releaseState ${JSON.stringify(releaseState)}`).toBe(true);
    }
    // Corrupt policy metadata on a run we are about to write to is not
    // something to shrug at either.
    mkdirSync(DIR, { recursive: true });
    writeFileSync(join(DIR, 'config.json'), '{ not json');
    expect(isHistoricalRun(RUN)).toBe(true);
  });

  it('still lets an in-progress run be resumed across batches', () => {
    // The counterweight: freezing everything would be trivially safe and would
    // break every multi-batch run, which is why the permissive side is
    // enumerated rather than the restrictive one.
    writeConfig({ releaseState: 'draft' });
    expect(isHistoricalRun(RUN)).toBe(false);
  });
});

interface Requirement {
  id: string;
  status: 'closed' | 'partial' | 'open';
  gaps: string[];
}

describe('JUDGE-001 is only half proved on the real roster', () => {
  const matrix = parse(readFileSync(join(REPO_ROOT, 'docs/wp-0/traceability.yaml'), 'utf8')) as {
    requirements: Requirement[];
  };
  const roster = parse(readFileSync(join(REPO_ROOT, 'data/models.yaml'), 'utf8')) as Array<{
    id: string;
    provider?: string;
    family?: string;
  }>;

  it('declares the base-model-family arm as a gap until the registry can express it', () => {
    // The matrix said `status: closed, gaps: []`. It should not have: the
    // family arm of hasJudgeConflict cannot exclude a seat on the live roster,
    // because no family spans two providers, so it is exercised only by a
    // fabricated fixture in judge.test.ts. This test is the thing that keeps
    // the admission honest — if the roster ever DOES gain a cross-provider
    // family, the requirement may legitimately be closed and this fails.
    const providersByFamily = new Map<string, Set<string>>();
    for (const m of roster) {
      if (!m.family || !m.provider) continue;
      const set = providersByFamily.get(m.family) ?? new Set<string>();
      set.add(m.provider.trim().toLowerCase());
      providersByFamily.set(m.family, set);
    }
    const crossProvider = [...providersByFamily].filter(([, ps]) => ps.size > 1);

    const judge = matrix.requirements.find((r) => r.id === 'JUDGE-001');
    expect(judge, 'JUDGE-001 is missing from the matrix').toBeDefined();

    if (crossProvider.length === 0) {
      expect(judge!.status, 'no roster family spans two providers, so JUDGE-001 is not closed').not.toBe(
        'closed',
      );
      expect(
        judge!.gaps.some((g) => /famil/i.test(g)),
        'JUDGE-001 must state the family-arm gap in words, not merely stop saying closed',
      ).toBe(true);
    } else {
      expect(judge!.status, `families ${crossProvider.map(([f]) => f).join(', ')} span providers`).toBe(
        'closed',
      );
    }
  });

  it('records that family is a marketing tier, not a base model', () => {
    // `claude-frontier` covers three different base models. A rule that reads
    // this field as `baseModelFamily` is reading a tier and calling it an
    // identity, and the gap text has to say so or the next reader will trust it.
    const familyToIds = new Map<string, string[]>();
    for (const m of roster) {
      if (!m.family) continue;
      familyToIds.set(m.family, [...(familyToIds.get(m.family) ?? []), m.id]);
    }
    expect((familyToIds.get('claude-frontier') ?? []).length).toBeGreaterThan(2);

    const judge = matrix.requirements.find((r) => r.id === 'JUDGE-001')!;
    expect(judge.gaps.join(' ')).toMatch(/marketing tier/i);
  });
});
