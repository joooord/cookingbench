import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  hasJudgeConflict,
  modelEntrySchema,
  modelsFileSchema,
  RELEASE_STATES,
  UNKNOWN_BASE_MODEL,
} from '@cookingbench/core';
import { parse } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { REPO_ROOT, RUNS_DIR } from '../src/dataset.js';
import { isHistoricalRun } from '../src/firewall.js';
import { identityIndex, panelSeats } from '../src/judge.js';

/**
 * Findings from the WP-0 self-review where behaviour and the acceptance story
 * can drift independently. A comment that contradicts its own line, or a
 * matrix that keeps describing an identity model the roster no longer uses,
 * both survive an ordinary black-box test and mislead the next reader.
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
  status_note?: string;
  gaps: string[];
}

describe('JUDGE-001 uses declared base-model identity end to end', () => {
  const matrix = parse(readFileSync(join(REPO_ROOT, 'docs/wp-0/traceability.yaml'), 'utf8')) as {
    requirements: Requirement[];
  };
  const roster = modelsFileSchema.parse(
    parse(readFileSync(join(REPO_ROOT, 'data/models.yaml'), 'utf8')),
  );
  const identifyLive = identityIndex(roster);

  const entry = (row: {
    id: string;
    provider: string;
    baseModel: string;
    family?: string;
  }) => modelEntrySchema.parse({ displayName: row.id, active: false, ...row });

  // The two conflict arms are deliberately separable. `origin/model-b` shares
  // only the provider with `origin/model-a`; `reseller/model-a` shares only its
  // base model. The independent rows keep the exact-seat assertions from
  // passing merely because identity lookup failed and the panel failed closed.
  const identityFixture = [
    entry({
      id: 'origin/model-a',
      provider: 'Origin Lab',
      family: 'origin-frontier',
      baseModel: 'origin:model-a',
    }),
    entry({
      id: 'origin/model-b',
      provider: 'Origin Lab',
      family: 'origin-mid',
      baseModel: 'origin:model-b',
    }),
    entry({
      id: 'reseller/model-a',
      provider: 'Reseller',
      family: 'reseller-frontier',
      baseModel: 'origin:model-a',
    }),
    entry({
      id: 'independent/one',
      provider: 'Independent One',
      baseModel: 'independent-one:model',
    }),
    entry({
      id: 'independent/two',
      provider: 'Independent Two',
      baseModel: 'independent-two:model',
    }),
  ];
  const identifyFixture = identityIndex(identityFixture);
  const panel = ['origin/model-a', 'independent/one', 'independent/two'];

  it('declares a known base model for every active route', () => {
    const active = roster.filter((model) => model.active);
    expect(active.length).toBeGreaterThan(0); // vacuity guard
    for (const model of active) {
      expect(model.baseModel, `${model.id} is active with unknown identity`).not.toBe(
        UNKNOWN_BASE_MODEL,
      );
      expect(identifyLive(model.id), `${model.id} is active without a usable identity`).toEqual({
        provider: model.provider,
        baseModelFamily: model.baseModel,
      });
    }
  });

  it('fails closed on a missing or unknown base-model identity', () => {
    const incomplete = identityIndex([
      ...identityFixture,
      // Intentionally bypasses the roster schema: identityIndex is a runtime
      // boundary used by fixtures and callers that may hand it an incomplete
      // structural row. Missing identity must still buy no seat.
      { id: 'unplaced/missing', provider: 'Unplaced', family: 'mystery' },
      entry({
        id: 'unplaced/unknown',
        provider: 'Unplaced Elsewhere',
        family: 'mystery',
        baseModel: UNKNOWN_BASE_MODEL,
      }),
    ]);

    expect(incomplete('unplaced/missing')).toBeUndefined();
    expect(incomplete('unplaced/unknown')).toBeUndefined();
    expect(panelSeats(panel, 'unplaced/missing', 'tech-001', incomplete)).toEqual([]);
    expect(panelSeats(panel, 'unplaced/unknown', 'tech-001', incomplete)).toEqual([]);

    // Fail closed in the other direction too: an unidentified seat cannot
    // grade a candidate whose identity is known.
    expect(
      panelSeats(
        ['unplaced/missing', 'unplaced/unknown', 'independent/two'],
        'independent/one',
        'tech-001',
        incomplete,
      ),
    ).toEqual(['independent/two']);
  });

  it('detects a cross-provider rebadge by base identity alone', () => {
    const original = identifyFixture('origin/model-a')!;
    const rebadge = identifyFixture('reseller/model-a')!;
    expect(rebadge.provider).not.toBe(original.provider);
    expect(identityFixture.find((model) => model.id === 'reseller/model-a')!.family).not.toBe(
      identityFixture.find((model) => model.id === 'origin/model-a')!.family,
    );
    expect(rebadge.baseModelFamily).toBe(original.baseModelFamily);
    expect(hasJudgeConflict(rebadge, original)).toBe(true);
    expect(panelSeats(panel, 'reseller/model-a', 'tech-001', identifyFixture)).toEqual([
      'independent/one',
      'independent/two',
    ]);
  });

  it('detects provider identity independently of base identity', () => {
    const original = identifyFixture('origin/model-a')!;
    const sibling = identifyFixture('origin/model-b')!;
    expect(sibling.provider).toBe(original.provider);
    expect(sibling.baseModelFamily).not.toBe(original.baseModelFamily);
    expect(hasJudgeConflict(sibling, original)).toBe(true);
    expect(panelSeats(panel, 'origin/model-b', 'tech-001', identifyFixture)).toEqual([
      'independent/one',
      'independent/two',
    ]);
  });

  it('records closure without demanding a naturally occurring live rebadge', () => {
    const judge = matrix.requirements.find((r) => r.id === 'JUDGE-001')!;
    expect(judge, 'JUDGE-001 is missing from the matrix').toBeDefined();
    expect(judge.status).toBe('closed');
    expect(judge.gaps).toEqual([]);
    expect(judge.status_note).toMatch(/schema-valid fixture/i);
    expect(judge.status_note).toMatch(/does not depend on.*live roster/i);
  });
});
