import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resolveRunFile } from './firewall.js';
import { PermitError, assertVerifiedGrant, type VerifiedGrant } from './permit.js';

/**
 * RUN-001 — single-use permits, enforced by a durable record.
 *
 * `executionLimit` was carried on the grant and enforced nowhere, which made
 * "single-use" a label rather than a property: one signed permit could be
 * replayed indefinitely. A limit with no record of prior redemptions is not a
 * limit.
 *
 * The record is one file per redemption, created with `open(..., 'wx')`, which
 * fails atomically at the filesystem level if the file already exists. Counting
 * existing redemptions and then writing the next one would leave a window in
 * which two processes both read N and both write N+1; letting the filesystem
 * arbitrate removes the window entirely, so the ordering here is deliberate
 * rather than incidental.
 *
 * Redemptions live inside the run the permit binds, so they inherit the
 * firewall's path confinement and the immutability rule — a permit for a frozen
 * run cannot even record a redemption, let alone act.
 */

const REDEMPTION_DIR = 'permit-redemptions';

export interface Redemption {
  /** 1-based. Equal to `executionLimit` on the last permitted use. */
  readonly sequence: number;
  readonly permitId: string;
  readonly path: string;
}

/**
 * Consume one use of a permit. Call this at the point of no return — once work
 * is about to begin — not at verification time, so a run refused for a
 * mismatched id or a bad flag does not burn a permit that is expensive to
 * replace.
 */
export function redeemPermit(
  grant: VerifiedGrant,
  /** Which command is consuming the use. Part of the audit trail. */
  context = 'unspecified',
  atIso: string = new Date().toISOString(),
): Redemption {
  assertVerifiedGrant(grant, 'redeemPermit');
  for (let sequence = 1; sequence <= grant.executionLimit; sequence++) {
    const target = resolveRunFile(
      grant.runId,
      join(REDEMPTION_DIR, `${grant.permitId}-${sequence}.json`),
      { write: true },
    );
    mkdirSync(dirname(target), { recursive: true });
    try {
      const fd = openSync(target, 'wx');
      writeSync(
        fd,
        JSON.stringify(
          {
            // TRACE-001. This record is the link between an artifact and the
            // approval that authorised it: which permit, signed by which key,
            // bound to which manifest, granting what, consumed when and by what.
            permitId: grant.permitId,
            kind: grant.kind,
            keyId: grant.keyId,
            manifestHash: grant.manifestHash,
            capabilities: [...grant.capabilities],
            evidenceClass: grant.evidenceClass,
            verifiedAtIso: grant.verifiedAtIso,
            sequence,
            executionLimit: grant.executionLimit,
            context,
            atIso,
            pid: process.pid,
          },
          null,
          2,
        ),
      );
      closeSync(fd);
      return { sequence, permitId: grant.permitId, path: target };
    } catch (e) {
      // Taken by an earlier redemption, or by a concurrent one that won the
      // race. Either way, try the next slot.
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new PermitError(
    `Permit ${grant.permitId} has been redeemed ${grant.executionLimit} time(s), its execution limit. ` +
      `A permit authorises a bounded amount of work; re-running requires a new approval. ` +
      `Redemption records are in data/runs/${grant.runId}/${REDEMPTION_DIR}/.`,
    'PERMIT_EXHAUSTED',
  );
}
