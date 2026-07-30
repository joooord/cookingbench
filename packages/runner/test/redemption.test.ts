import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNS_DIR } from '../src/dataset.js';
import { PermitError } from '../src/permit.js';
import { redeemPermit } from '../src/redemption.js';
import { mintTestGrant } from './support/grant.js';

/**
 * RUN-001 — a permit's execution limit is enforced by a record, not by a field.
 *
 * Before this, `executionLimit` was carried on the grant and checked nowhere,
 * so one signed permit could be replayed for ever. Offline: no client, no
 * socket, no model.
 */

const RUN = '__test-redemption-scratch';
const DIR = join(RUNS_DIR, RUN);

afterEach(() => {
  rmSync(DIR, { recursive: true, force: true });
});

function grant(executionLimit: number, permitId = 'permit-redeem-001') {
  return mintTestGrant({
    permitId,
    kind: 'development-probe',
    capabilities: ['candidate-inference'],
    cells: [{ modelId: 'openai/gpt-5.5', questionId: 'conv-001' }],
    runId: RUN,
    executionLimit,
  });
}

describe('single use means single use', () => {
  it('refuses a second redemption of a single-use permit', () => {
    const g = grant(1);
    expect(redeemPermit(g).sequence).toBe(1);
    expect(() => redeemPermit(g)).toThrow(PermitError);
    try {
      redeemPermit(g);
    } catch (e) {
      expect((e as PermitError).code).toBe('PERMIT_EXHAUSTED');
    }
  });

  it('allows exactly as many uses as the permit declares', () => {
    const g = grant(3);
    expect([redeemPermit(g).sequence, redeemPermit(g).sequence, redeemPermit(g).sequence]).toEqual([
      1, 2, 3,
    ]);
    expect(() => redeemPermit(g)).toThrow(/redeemed 3 time\(s\)/);
  });

  it('survives the process, because the record is on disk', () => {
    // The whole point: an in-memory counter resets when the runner restarts,
    // which is precisely when a replay would happen.
    redeemPermit(grant(2));
    const files = readdirSync(join(DIR, 'permit-redemptions'));
    expect(files).toEqual(['permit-redeem-001-1.json']);
    // A freshly verified grant for the same permit sees the earlier redemption.
    expect(redeemPermit(grant(2)).sequence).toBe(2);
    expect(() => redeemPermit(grant(2))).toThrow(/PERMIT_EXHAUSTED|redeemed 2 time/);
  });

  it('records what was redeemed, for the audit trail', () => {
    const g = grant(1);
    const record = JSON.parse(readFileSync(redeemPermit(g).path, 'utf8'));
    expect(record).toMatchObject({
      permitId: 'permit-redeem-001',
      kind: 'development-probe',
      sequence: 1,
      executionLimit: 1,
      manifestHash: g.manifestHash,
    });
  });

  it('counts permits separately', () => {
    expect(redeemPermit(grant(1, 'permit-redeem-001')).sequence).toBe(1);
    expect(redeemPermit(grant(1, 'permit-redeem-002')).sequence).toBe(1);
  });

  it('cannot be redeemed with an unminted grant', () => {
    const forged = { permitId: 'permit-forged-1', runId: RUN, executionLimit: 99 } as never;
    expect(() => redeemPermit(forged)).toThrow(/did not mint by verifying a signed permit/);
    expect(existsSync(DIR)).toBe(false);
  });

  it('cannot record a redemption against a published run', () => {
    // Confinement inherited from the firewall: a permit naming a frozen run
    // cannot even write its redemption, let alone act.
    const g = mintTestGrant({
      permitId: 'permit-redeem-003',
      kind: 'development-probe',
      capabilities: ['candidate-inference'],
      cells: [{ modelId: 'openai/gpt-5.5', questionId: 'conv-001' }],
      runId: '2026-07-v2.1',
    });
    expect(() => redeemPermit(g)).toThrow(/historical and immutable/);
  });
});
