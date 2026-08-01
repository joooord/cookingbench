import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import {
  KEYRING_DIR,
  REVOCATION_LIST,
  verifyPermit,
  verifySignedPermitReceipt,
  type VerifiedPermit,
  type VerifiedPermitReceipt,
  type VerifyPermitInput,
  type VerifySignedPermitReceiptInput,
} from '../../src/permit.js';

/**
 * Verify through the production boundary while temporarily installing exactly
 * one public test key into the fixed repository keyring.
 *
 * This is deliberately test-source code, not an exported runner seam. The
 * production verifier still chooses its keyring, revocation list and clock;
 * the test merely arranges the fixed keyring's filesystem state for the
 * duration of the test worker. Keeping it until process cleanup lets later
 * release/provenance checks re-verify the signed envelope against the same
 * fixed keyring; the private key remains memory-only.
 */
const installed = new Map<string, string>();
let cleanupRegistered = false;

function cleanupInstalledPublicKeys(): void {
  for (const path of installed.keys()) rmSync(path, { force: true });
  installed.clear();
}

// Keep a key for the whole test so a later receipt check can re-verify it, then
// remove it deterministically. Process-exit cleanup remains a crash backstop.
afterEach(cleanupInstalledPublicKeys);

export function verifyWithInstalledPublicKey(
  keyId: string,
  publicKeyPem: string,
  input: VerifyPermitInput,
): VerifiedPermit {
  installPublicKey(keyId, publicKeyPem);
  return verifyPermit(input);
}

export function verifyReceiptWithInstalledPublicKey(
  keyId: string,
  publicKeyPem: string,
  input: VerifySignedPermitReceiptInput,
): VerifiedPermitReceipt {
  installPublicKey(keyId, publicKeyPem);
  return verifySignedPermitReceipt(input);
}

function installPublicKey(keyId: string, publicKeyPem: string): void {
  const keyPath = join(KEYRING_DIR, `${keyId}.pub`);
  const prior = installed.get(keyPath);
  if (prior !== undefined && prior !== publicKeyPem) {
    throw new Error(`test key id ${keyId} was reused for different key bytes`);
  }
  if (prior === undefined) {
    if (existsSync(keyPath)) throw new Error(`test key path already exists: ${keyPath}`);
    writeFileSync(keyPath, publicKeyPem, { flag: 'wx' });
    installed.set(keyPath, publicKeyPem);
  }
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once('exit', cleanupInstalledPublicKeys);
  }
}

/** Temporarily add one id to the fixed revocation source and restore exact bytes. */
export async function withTemporarilyRevokedPermit<T>(
  permitId: string,
  action: () => T | Promise<T>,
): Promise<T> {
  const restore = temporarilyRevokePermit(permitId);
  try {
    return await action();
  } finally {
    restore();
  }
}

/**
 * Test-only controller for the one case where revocation lands DURING a call.
 * Returns an idempotent exact-byte restore function so tests cannot leave the
 * committed policy changed even when their assertion throws.
 */
export function temporarilyRevokePermit(permitId: string): () => void {
  const original = readFileSync(REVOCATION_LIST, 'utf8');
  const parsed = JSON.parse(original) as { permitIds?: unknown };
  if (!Array.isArray(parsed.permitIds) || parsed.permitIds.some((id) => typeof id !== 'string')) {
    throw new Error(`${REVOCATION_LIST} is not a usable test revocation list`);
  }
  writeFileSync(
    REVOCATION_LIST,
    `${JSON.stringify({ ...parsed, permitIds: [...new Set([...parsed.permitIds, permitId])] }, null, 2)}\n`,
  );
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    writeFileSync(REVOCATION_LIST, original);
  };
}
