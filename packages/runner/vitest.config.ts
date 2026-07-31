import { defineConfig } from 'vitest/config';

/**
 * Vitest's default 5-second per-test timeout is wrong for this package, and it
 * failed intermittently rather than honestly.
 *
 * These are integration tests, not unit tests: the WP-0 acceptance lifecycle
 * mints real Ed25519 keypairs, signs and verifies permits, hashes the question
 * bank, writes and re-reads run artifacts, and drives the release register from
 * end to end. Alone it takes about four seconds. Under the full suite's
 * parallelism it took longer than five and was reported as a FAILURE, which is
 * the worst possible way for a green suite to go red: the assertion never ran,
 * so the output says nothing about whether the boundary holds, and the same
 * command passes on a quieter machine.
 *
 * Thirty seconds is chosen to be far above the slowest observed case (~18s for
 * the regeneration subprocess tests, which spawn a CLI three times) and far
 * below anything a genuinely hung test would sit under. A test that needs more
 * than this is hung, and should say so.
 */
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
