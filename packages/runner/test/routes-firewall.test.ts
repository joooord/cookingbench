import { generateKeyPairSync, sign as signBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalJson } from '@cookingbench/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DATA_DIR, REPO_ROOT, RUNS_DIR } from '../src/dataset.js';
import {
  FirewallError,
  appendRunFileLine,
  writeOutputFileAtomic,
  type FirewallErrorCode,
} from '../src/firewall.js';
import {
  clearRegisterFileForTest,
  readReleaseRegister,
  useRegisterFileForTest,
} from '../src/lifecycle.js';
import {
  KEYRING_DIR,
  PERMIT_FIXTURES_DIR,
  PermitError,
  REVOCATION_LIST,
  verifyPermit,
  verifyPermitFile,
  type PermitErrorCode,
} from '../src/permit.js';

/**
 * Route-level proof for the ENFORCEMENT layer itself.
 *
 * `docs/wp-0/routes.yaml` registers firewall.ts and permit.ts as routes rather
 * than exempting them, on the argument that a guard which leaves itself out of
 * the register of dangerous routes is choosing its own scope. These five risks
 * stayed open because the evidence offered for them exercised a HELPER —
 * `resolveOutputPath`, `resolveRunFile`, or a local `verify()` wrapper that
 * supplied its own keyring. A test of the helper cannot fail if the route stops
 * calling it, which is precisely the failure the citation is supposed to
 * exclude. So every test below calls the route's OWN exported function, and
 * asserts the SPECIFIC refusal the risk names — the error code plus a
 * distinctive fragment of the message. "It threw" is not evidence: an
 * unparseable register or a malformed permit would also throw, and neither says
 * anything about containment or about where trust comes from.
 *
 * Offline by construction: `globalThis.fetch` is replaced for the whole file,
 * the only signing key is generated into a temp directory and destroyed with
 * it, and the committed material that is read is three permits that expired in
 * 2020. No socket is opened, no database is touched, and nothing under
 * data/runs or data/taste is written.
 */

const FROZEN = '2026-07-v2.1';
const SCRATCH_RUN = '__test-routes-firewall-scratch';
const SCRATCH_ALIAS = '__test-routes-firewall-alias';
/** A register file inside the runs root, so the reader has something to confine. */
const SCRATCH_REGISTER = '__test-routes-firewall-register.json';

const fixture = (name: string) => join(PERMIT_FIXTURES_DIR, name);

/** The frozen methodology digest every real permit must name. */
const FROZEN_METHODOLOGY_HASH = /^[a-f0-9]{64}/.exec(
  readFileSync(
    join(REPO_ROOT, 'docs/methodology/CookingBench-methodology-first-master-plan.sha256'),
    'utf8',
  ).trim(),
)![0];

/** What a production caller of the permit boundary is allowed to say. */
function fixtureBinding() {
  return {
    manifest: JSON.parse(readFileSync(fixture('expired-probe.manifest.json'), 'utf8')),
    expectedMethodologyHash: FROZEN_METHODOLOGY_HASH,
  };
}

function expectFirewallRefusal(
  fn: () => unknown,
  code: FirewallErrorCode,
  fragment: RegExp,
  label = '',
): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `${label}: the route did not refuse at all`).toBeInstanceOf(FirewallError);
  expect((caught as FirewallError).code, label).toBe(code);
  expect((caught as FirewallError).message, label).toMatch(fragment);
}

function expectPermitRefusal(
  fn: () => unknown,
  code: PermitErrorCode,
  fragment: RegExp,
  label = '',
): void {
  let caught: unknown;
  try {
    fn();
  } catch (e) {
    caught = e;
  }
  expect(caught, `${label}: the boundary did not refuse at all`).toBeInstanceOf(PermitError);
  expect((caught as PermitError).code, label).toBe(code);
  expect((caught as PermitError).message, label).toMatch(fragment);
}

/** Where a redirected write would land if a link were ever followed. */
let outside: string;
const realFetch = globalThis.fetch;

beforeAll(() => {
  outside = mkdtempSync(join(tmpdir(), 'cb-routes-firewall-'));
  globalThis.fetch = (async () => {
    throw new Error('a firewall route opened the network; enforcement must never reach a provider');
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
  rmSync(outside, { recursive: true, force: true });
});

afterEach(() => {
  // The register override is process-wide state; leaving it set would point a
  // later suite at a file this one deleted.
  clearRegisterFileForTest();
  rmSync(join(RUNS_DIR, SCRATCH_RUN), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, SCRATCH_ALIAS), { recursive: true, force: true });
  rmSync(join(RUNS_DIR, SCRATCH_REGISTER), { force: true });
});

// ---------------------------------------------------------------------------
// runner:firewall:output-file:write — path-escape
// ---------------------------------------------------------------------------

describe('runner:firewall:output-file:write — writeOutputFileAtomic', () => {
  it('refuses a path that leaves its output family, and never follows a leaf symlink out', () => {
    const board = join(RUNS_DIR, FROZEN, 'leaderboard.json');
    const publishedBefore = readFileSync(board);
    const tasteBefore = readdirSync(join(DATA_DIR, 'taste')).sort();

    // The taste and shadow artifacts both reach disk through this writer, and
    // the family root is the only thing standing between a vote archive and a
    // published board. `..` out of data/taste lands squarely in a frozen run.
    expectFirewallRefusal(
      () => writeOutputFileAtomic('taste', join('..', 'runs', FROZEN, 'leaderboard.json'), '{"hijacked":1}'),
      'PATH_ESCAPE',
      /resolves outside the taste root/,
      'traversal into a frozen run',
    );

    // An absolute path is the same attack without the climb: `resolve(root,
    // '/tmp/…')` discards the root entirely, so containment has to be proved
    // after resolution rather than assumed from the join.
    expectFirewallRefusal(
      () => writeOutputFileAtomic('taste', join(outside, 'evil.json'), 'x'),
      'PATH_ESCAPE',
      /resolves outside the taste root/,
      'absolute path',
    );
    expect(existsSync(join(outside, 'evil.json')), 'bytes landed outside the family root').toBe(false);

    // The root itself is not a writable target: a family whose own directory
    // entry can be replaced by a file has no root left to confine anything to.
    expectFirewallRefusal(
      () => writeOutputFileAtomic('taste', '.', 'x'),
      'PATH_ESCAPE',
      /resolves outside the taste root/,
      'the family root itself',
    );

    // Families do not leak into each other. Refused even though data/shadow
    // does not exist yet — a not-yet-created root must not mean an unchecked one.
    expectFirewallRefusal(
      () => writeOutputFileAtomic('shadow', join('..', 'taste', 'votes.ndjson'), 'x'),
      'PATH_ESCAPE',
      /resolves outside the shadow root/,
      'cross-family write',
    );
    expect(existsSync(join(DATA_DIR, 'shadow')), 'a refused write created its family root').toBe(false);

    const scratch = join(RUNS_DIR, SCRATCH_RUN);
    mkdirSync(scratch, { recursive: true });

    // A leaf symlink is the bypass that lexical containment cannot see: the
    // path stays under the root while the write lands wherever the link points.
    const decoy = join(outside, 'link-target.json');
    writeFileSync(decoy, 'original');
    symlinkSync(decoy, join(scratch, 'linked.json'));
    expectFirewallRefusal(
      () => writeOutputFileAtomic('runs', `${SCRATCH_RUN}/linked.json`, '{"redirected":1}'),
      'SYMLINK_ESCAPE',
      /resolves through a link to/,
      'leaf symlink out of the root',
    );
    expect(readFileSync(decoy, 'utf8'), 'the write followed the link').toBe('original');

    // A DANGLING link is the same attack with the target not yet created, and
    // `existsSync` follows links and therefore lies about it. Refusing here is
    // what stops the writer creating the outside file it was aimed at.
    symlinkSync(join(outside, 'not-yet.json'), join(scratch, 'dangling.json'));
    expectFirewallRefusal(
      () => writeOutputFileAtomic('runs', `${SCRATCH_RUN}/dangling.json`, 'x'),
      'SYMLINK_COMPONENT',
      /Refusing to traverse symlink component/,
      'dangling leaf symlink',
    );
    expect(existsSync(join(outside, 'not-yet.json')), 'the write created the link target').toBe(false);

    // The control, so the refusals above are known not to be vacuous: a
    // legitimate target inside the root is written, at the path it reports, and
    // no staging file is left behind by the rename.
    const written = writeOutputFileAtomic('runs', `${SCRATCH_RUN}/allowed.json`, '{"ok":true}\n');
    expect(written).toBe(join(scratch, 'allowed.json'));
    expect(readFileSync(written, 'utf8')).toBe('{"ok":true}\n');
    expect(readdirSync(scratch).filter((f) => f.includes('.tmp-'))).toEqual([]);

    // The claim is about the artifacts, not only about the throw.
    expect(readFileSync(board).equals(publishedBefore), 'the published board moved').toBe(true);
    expect(readdirSync(join(DATA_DIR, 'taste')).sort()).toEqual(tasteBefore);
  });
});

// ---------------------------------------------------------------------------
// runner:firewall:run-file:append — path-escape
// ---------------------------------------------------------------------------

describe('runner:firewall:run-file:append — appendRunFileLine', () => {
  it('refuses a traversing id or path, and never appends through a symlinked leaf', () => {
    const scratch = join(RUNS_DIR, SCRATCH_RUN);
    mkdirSync(scratch, { recursive: true });

    // The run id is caller-supplied at every command boundary, so it is the
    // first thing that can steer the spend journal out of the runs directory.
    expectFirewallRefusal(
      () => appendRunFileLine(join('..', '..', 'etc'), 'spend.ndjson', '{}'),
      'INVALID_RUN_ID',
      /Invalid run id/,
      'traversing run id',
    );

    // Traversal in the FILE half, which the run id check never sees.
    expectFirewallRefusal(
      () => appendRunFileLine(SCRATCH_RUN, join('..', '..', 'escape.ndjson'), '{}'),
      'INVALID_PATH_COMPONENT',
      /may not be empty, traverse/,
      'traversing relative path',
    );

    // An absolute path would otherwise discard the run directory entirely.
    const absolute = join(outside, 'escape.ndjson');
    expectFirewallRefusal(
      () => appendRunFileLine(SCRATCH_RUN, absolute, '{}'),
      'INVALID_PATH_COMPONENT',
      /may not be empty, traverse/,
      'absolute relative path',
    );
    expect(existsSync(absolute), 'the journal was appended outside the runs directory').toBe(false);

    // Identity, not the name: an alias run directory stays under the runs root
    // and passes containment, while the journal lands in the published run it
    // points at. The refusal has to name the run it really resolved to.
    symlinkSync(join(RUNS_DIR, FROZEN), join(RUNS_DIR, SCRATCH_ALIAS));
    expectFirewallRefusal(
      () => appendRunFileLine(SCRATCH_ALIAS, 'spend.ndjson', '{}'),
      'HISTORICAL_WRITE',
      /via alias/,
      'aliased run directory',
    );

    // THE arm this route exists for. Append is the one mode where a symlinked
    // leaf writes THROUGH to the target: `writeRunFileAtomic` renames over the
    // entry and so replaces a link, while `appendFileSync` opens it and follows.
    const decoy = join(outside, 'journal-target.ndjson');
    writeFileSync(decoy, 'original\n');
    symlinkSync(decoy, join(scratch, 'spend.ndjson'));
    expectFirewallRefusal(
      () => appendRunFileLine(SCRATCH_RUN, 'spend.ndjson', '{"actualUsd":999}'),
      'SYMLINK_COMPONENT',
      /symlink/,
      'symlinked journal leaf',
    );
    expect(readFileSync(decoy, 'utf8'), 'the append followed the link').toBe('original\n');
    rmSync(join(scratch, 'spend.ndjson'), { force: true });

    // A dangling link would be CREATED by an append that followed it.
    symlinkSync(join(outside, 'not-yet.ndjson'), join(scratch, 'ghost.ndjson'));
    expectFirewallRefusal(
      () => appendRunFileLine(SCRATCH_RUN, 'ghost.ndjson', '{}'),
      'SYMLINK_COMPONENT',
      /symlink/,
      'dangling journal leaf',
    );
    expect(existsSync(join(outside, 'not-yet.ndjson'))).toBe(false);

    // A linked DIRECTORY component redirects every file beneath it, so the
    // whole path from the root down has to be checked, not just the leaf.
    symlinkSync(join(RUNS_DIR, FROZEN), join(scratch, 'journal'));
    expectFirewallRefusal(
      () => appendRunFileLine(SCRATCH_RUN, 'journal/spend.ndjson', '{}'),
      'SYMLINK_COMPONENT',
      /symlink/,
      'symlinked directory component',
    );
    expect(existsSync(join(RUNS_DIR, FROZEN, 'spend.ndjson')), 'a journal landed in a frozen run').toBe(
      false,
    );

    // The control: the writer still does its job, and it APPENDS rather than
    // replacing — losing an earlier line is how a spend journal forgets money
    // that has already been paid.
    appendRunFileLine(SCRATCH_RUN, 'ledger.ndjson', '{"first":1}');
    const path = appendRunFileLine(SCRATCH_RUN, 'ledger.ndjson', '{"second":2}\n');
    expect(path).toBe(join(scratch, 'ledger.ndjson'));
    expect(readFileSync(path, 'utf8')).toBe('{"first":1}\n{"second":2}\n');
  });
});

// ---------------------------------------------------------------------------
// runner:lifecycle:register:read — path-escape
// ---------------------------------------------------------------------------

describe('runner:lifecycle:register:read — readReleaseRegister', () => {
  it('refuses a register outside the runs root, whether by traversal or by symlink', () => {
    // The register decides which run is publicly current, so a caller that can
    // name the file decides what is published. routes.yaml records the
    // signature as `readReleaseRegister(file = REGISTER_FILE)`; production now
    // has no parameter at all to reach, and this pins that down.
    expect(readReleaseRegister.length, 'the reader takes a caller-supplied path again').toBe(0);

    // The control, which also proves the override under test is genuinely in
    // effect — without it the refusals below could be coming from anywhere.
    useRegisterFileForTest(SCRATCH_REGISTER);
    writeFileSync(
      join(RUNS_DIR, SCRATCH_REGISTER),
      JSON.stringify({ registerVersion: 1, entries: {}, currentRun: { runId: SCRATCH_RUN } }),
    );
    expect(readReleaseRegister().currentRun?.runId).toBe(SCRATCH_RUN);

    // An extra positional argument is IGNORED rather than honoured: a caller
    // that reads like it chose the register has not chosen it.
    const forged = join(outside, 'forged-register.json');
    writeFileSync(
      forged,
      JSON.stringify({ registerVersion: 1, entries: {}, currentRun: { runId: FROZEN } }),
    );
    const asIfInjectable = readReleaseRegister as unknown as (file: string) => ReturnType<
      typeof readReleaseRegister
    >;
    expect(asIfInjectable(forged).currentRun?.runId).toBe(SCRATCH_RUN);

    // Even the test seam — the only thing left that can name the file — is
    // confined to the runs root. A seam that could escape would be the same
    // hole one indirection further out.
    useRegisterFileForTest(join('..', 'taste', 'votes.ndjson'));
    expectFirewallRefusal(
      () => readReleaseRegister(),
      'PATH_ESCAPE',
      /resolves outside the runs root/,
      'traversing register file',
    );

    useRegisterFileForTest(forged);
    expectFirewallRefusal(
      () => readReleaseRegister(),
      'PATH_ESCAPE',
      /resolves outside the runs root/,
      'absolute register file',
    );

    // Containment is not enough on its own: a link inside the root satisfies it
    // while the bytes read come from a register somebody else wrote.
    rmSync(join(RUNS_DIR, SCRATCH_REGISTER), { force: true });
    symlinkSync(forged, join(RUNS_DIR, SCRATCH_REGISTER));
    useRegisterFileForTest(SCRATCH_REGISTER);
    expectFirewallRefusal(
      () => readReleaseRegister(),
      'SYMLINK_ESCAPE',
      /resolves through a link to/,
      'symlinked register file',
    );
  });
});

// ---------------------------------------------------------------------------
// runner:permit:keyring:read — unauthorised-inference
// ---------------------------------------------------------------------------

describe('runner:permit:keyring:read — verifyPermit at the production boundary', () => {
  it('refuses a self-minted key, and every way of naming the keyring that signed it', async () => {
    // The attack the risk names, run for real. The permit BODY is the committed
    // fixture's, byte for byte, so the only variable is which keyring decides
    // whether the signature over it counts. If the caller could name that
    // directory it could mint itself any authority it liked, and every later
    // check would pass honestly against inputs it chose.
    const committed = JSON.parse(readFileSync(fixture('expired-probe.permit.json'), 'utf8')) as {
      permit: Record<string, unknown>;
      keyId: string;
    };
    const attackerRoot = mkdtempSync(join(tmpdir(), 'cb-attacker-keyring-'));
    const attackerKeyring = join(attackerRoot, 'keys');
    mkdirSync(attackerKeyring, { recursive: true });
    const pair = generateKeyPairSync('ed25519');
    const attackerKeyId = 'routes-firewall-self-minted';
    writeFileSync(
      join(attackerKeyring, `${attackerKeyId}.pub`),
      pair.publicKey.export({ type: 'spki', format: 'pem' }) as string,
    );

    const selfMinted = {
      permit: committed.permit,
      signature: signBytes(
        null,
        Buffer.from(canonicalJson(committed.permit), 'utf8'),
        pair.privateKey,
      ).toString('base64'),
      keyId: attackerKeyId,
    };
    const base = { signedPermit: selfMinted, ...fixtureBinding() };

    // The refusal NAMES the directory it read and lists what is in it, which is
    // what turns "it threw" into evidence about which keyring is the trust root.
    // A test asserting only that it threw would pass just as happily against a
    // keyring the caller had supplied — the bypass this replaces.
    for (const [label, call] of [
      ['verifyPermit', () => verifyPermit(base)],
      [
        'verifyPermitFile',
        () => {
          const path = join(attackerRoot, 'self-minted.permit.json');
          writeFileSync(path, JSON.stringify(selfMinted));
          return verifyPermitFile(path, fixtureBinding());
        },
      ],
    ] as const) {
      expectPermitRefusal(call, 'PERMIT_UNKNOWN_KEY', /No committed public key/, label);
      let message = '';
      try {
        call();
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, `${label} did not read the committed keyring`).toContain(KEYRING_DIR);
      expect(message, `${label} did not list the committed keys`).toContain('wp0-fixture-2026-07');
    }

    // Not merely refused — unreachable. Neither production entry point has a
    // parameter for a trust root, and every shape of injection is rejected
    // rather than dropped, because a silently-ignored keyringDir reads to its
    // author as though it took effect.
    expect(verifyPermit.length, 'verifyPermit grew a second parameter').toBe(1);
    expect(verifyPermitFile.length, 'verifyPermitFile grew a third parameter').toBe(2);
    for (const injection of [
      { keyringDir: attackerKeyring },
      { keyring: attackerKeyring },
      { publicKey: pair.publicKey },
      { trustRoot: { keyringDir: attackerKeyring } },
    ]) {
      expectPermitRefusal(
        () => verifyPermit({ ...base, ...injection } as never),
        'PERMIT_TRUST_INPUT_REJECTED',
        /does not accept a keyring/,
        `injection ${Object.keys(injection)[0]}`,
      );
    }

    // Own keys are not the only way in: `Object.create` hides the property on
    // the prototype chain, where an own-key check misses it and a destructure
    // still reads it.
    const smuggled = Object.create({ keyringDir: attackerKeyring }) as Record<string, unknown>;
    Object.assign(smuggled, base);
    expectPermitRefusal(
      () => verifyPermit(smuggled as never),
      'PERMIT_TRUST_INPUT_REJECTED',
      /does not accept a keyring/,
      'prototype-smuggled keyring',
    );

    // A JavaScript caller can pass anything at all. An extra positional
    // argument is not a seam: it is ignored, and the committed keyring is still
    // the one consulted.
    const asIfInjectable = verifyPermit as unknown as (input: unknown, trust: unknown) => unknown;
    expectPermitRefusal(
      () => asIfInjectable(base, { keyringDir: attackerKeyring }),
      'PERMIT_UNKNOWN_KEY',
      /No committed public key/,
      'extra positional trust argument',
    );

    // The permit cannot steer the keyring read either. A key id is a filename
    // component, so it is constrained rather than sanitised — a traversing id
    // is rejected as a bad identifier, never cleaned into a plausible one.
    expectPermitRefusal(
      () =>
        verifyPermit({
          ...base,
          signedPermit: { ...selfMinted, keyId: `../../${join(attackerKeyring, attackerKeyId)}` },
        }),
      'PERMIT_UNKNOWN_KEY',
      /not a valid key identifier/,
      'traversing key id',
    );

    // The two filesystem sinks this route is really about — `loadPublicKey`
    // and `revokedPermitIds` — are module-private, and `docs/wp-0/routes.yaml`
    // now names `verifyPermit` as the route's function on exactly that
    // argument. That is only honest while the sinks stay unreachable, so it is
    // asserted rather than assumed: export either one and this fails, and the
    // route must be split again.
    const permitModule = await import('../src/permit.js');
    for (const internal of ['loadPublicKey', 'revokedPermitIds']) {
      expect(
        Object.keys(permitModule),
        `${internal} is exported; the keyring/revocation sinks are no longer reachable only through verifyPermit`,
      ).not.toContain(internal);
    }

    rmSync(attackerRoot, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// runner:permit:revocation:read — unauthorised-inference
// ---------------------------------------------------------------------------

describe('runner:permit:revocation:read — verifyPermit at the production boundary', () => {
  it('reads the committed revocation list, and no production input can substitute another', () => {
    const envelope = JSON.parse(readFileSync(fixture('revoked-probe.permit.json'), 'utf8')) as {
      permit: { permitId: string; notAfter: string };
    };
    const base = { signedPermit: envelope, ...fixtureBinding() };

    // The committed list is what says this permit is dead.
    const committedList = JSON.parse(readFileSync(REVOCATION_LIST, 'utf8')) as { permitIds: string[] };
    expect(committedList.permitIds).toContain(envelope.permit.permitId);

    // REVOKED, not EXPIRED — and the fixture is both. Revocation is consulted
    // before the clock is even looked at, so this refusal is only reachable if
    // data/permits/revoked.json was genuinely read: a permit withdrawn after
    // signing must stop buying inference immediately, not at its expiry.
    expect(new Date(envelope.permit.notAfter).getTime()).toBeLessThan(Date.now());
    expectPermitRefusal(() => verifyPermit(base), 'PERMIT_REVOKED', /has been revoked/, 'verifyPermit');
    expectPermitRefusal(
      () => verifyPermitFile(fixture('revoked-probe.permit.json'), fixtureBinding()),
      'PERMIT_REVOKED',
      /has been revoked/,
      'verifyPermitFile',
    );

    // A caller that can name the revocation list can un-revoke itself. Every
    // arrangement of the production input is refused rather than ignored.
    const emptyList = join(outside, 'un-revoked.json');
    writeFileSync(emptyList, JSON.stringify({ permitIds: [] }));
    for (const injection of [
      { revocationListPath: emptyList },
      { revocationList: { permitIds: [] } },
      { trustRoot: { revocationListPath: emptyList } },
    ]) {
      expectPermitRefusal(
        () => verifyPermit({ ...base, ...injection } as never),
        'PERMIT_TRUST_INPUT_REJECTED',
        /does not accept a keyring, a revocation source or a clock/,
        `injection ${Object.keys(injection)[0]}`,
      );
    }
    expectPermitRefusal(
      () =>
        verifyPermitFile(fixture('revoked-probe.permit.json'), {
          ...fixtureBinding(),
          revocationListPath: emptyList,
        } as never),
      'PERMIT_TRUST_INPUT_REJECTED',
      /does not accept a keyring, a revocation source or a clock/,
      'injection through the file entry point',
    );

    const smuggled = Object.create({ revocationListPath: emptyList }) as Record<string, unknown>;
    Object.assign(smuggled, base);
    expectPermitRefusal(
      () => verifyPermit(smuggled as never),
      'PERMIT_TRUST_INPUT_REJECTED',
      /does not accept a keyring, a revocation source or a clock/,
      'prototype-smuggled revocation list',
    );

    // Impossible rather than merely refused: an extra positional argument is
    // ignored, and after every attempt above the permit is still revoked. There
    // is no arrangement of the production input that un-revokes it.
    const asIfInjectable = verifyPermit as unknown as (input: unknown, trust: unknown) => unknown;
    expectPermitRefusal(
      () => asIfInjectable(base, { revocationListPath: emptyList }),
      'PERMIT_REVOKED',
      /has been revoked/,
      'extra positional trust argument',
    );
    expectPermitRefusal(() => verifyPermit(base), 'PERMIT_REVOKED', /has been revoked/, 'after every attempt');
  });
});
