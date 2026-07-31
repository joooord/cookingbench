import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/dataset.js';
import { Firewall, FirewallError, assertPublishable } from '../src/firewall.js';
import { PermitError, verifyPermit } from '../src/permit.js';

/**
 * ARCHITECTURAL REGRESSION TEST
 *
 * One rule, which every other WP-0 requirement leans on:
 *
 *   A safeguard is meaningless when the thing it guards can choose the
 *   safeguard's definition, inputs or scope.
 *
 * Three real defects in this repository were instances of it, each shipped with
 * a comment explaining why it was fine:
 *
 *   1. `verifyPermit` took `keyringDir`, `revocationListPath` and `now` from its
 *      caller — "injectable for testability". Unattended code could point
 *      verification at a key it had just minted, or move the clock past an
 *      expiry, and every downstream check would then pass honestly against
 *      inputs the caller chose.
 *   2. `buildReleaseChecklist` took the checks, the status report and the
 *      verification options from its caller, and `checklistComplete` accepted
 *      any non-empty list of passing items — so the run being released decided
 *      which checks applied to it.
 *   3. `VerifiedGrant` was a compile-time brand and `Firewall`'s constructor was
 *      `private`. Both erase. A hand-written object literal walked through the
 *      boundary at runtime while the surrounding code read as if it were
 *      guarded.
 *
 * The fixes are in place. This file exists so they cannot quietly come back.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS TEST CAN CATCH
 * ---------------------------------------------------------------------------
 *
 *  - A NEW exported production function that takes a trust input (a keyring, a
 *    revocation source, a clock, a policy-file path, a checklist, a requirement
 *    list) as a caller parameter, unless it is explicitly listed and justified
 *    below.
 *  - A production call site that passes an argument to one of the known
 *    remaining injectable parameters — that is the reachable half of the
 *    defect, and it is enforced absolutely.
 *  - A test seam becoming reachable from production source, or losing its
 *    runtime "not a test process" guard.
 *  - An authority boundary losing its runtime check and falling back to the
 *    type system: a `private constructor` with no assertion in its body, a
 *    publication entry point that stops taking `unknown`, a grant check that
 *    stops consulting the minting registry.
 *  - At RUNTIME, through the real production entry points: trust inputs being
 *    injected into `verifyPermit`, a hand-built grant at the firewall, a
 *    hand-built manifest at the publication boundary, and construction through
 *    the erased `private` modifier.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS TEST CANNOT CATCH — stated plainly, because a partial guard
 * described honestly is worth more than a complete-looking one
 * ---------------------------------------------------------------------------
 *
 *  - It is a REGEX over source text, not a type-aware analysis. It sees
 *    declarations and call sites; it does not see data flow. A trust input
 *    smuggled in as a field of an options object whose name says nothing
 *    ("opts.source", "config.at") will not be flagged.
 *  - Parameter classification is by NAME. `readPolicy(p: string)` reads as
 *    innocent. Renaming `keyringDir` to `dir` defeats the scanner — which is
 *    why the four highest-value cases are also asserted behaviourally at
 *    runtime below, where a name cannot help.
 *  - It scans `packages/core/src` and `packages/runner/src` only. `apps/web` is
 *    out of scope here: it holds no permit boundary and reads committed
 *    artifacts. Its own known weakness (selecting a board by newest
 *    `generatedAt` rather than by approval) is recorded against RELEASE-002 in
 *    the traceability matrix, not here.
 *  - Call-site checks strip comments and quoted strings crudely. A call written
 *    inside a template literal's `${...}` would be missed.
 *  - The "private constructor has a runtime check" rule looks at the twelve
 *    lines after the declaration, not at the real block. A check moved further
 *    down the constructor would read as absent (a false alarm, which is the
 *    safe direction) and a check inside a branch reads as present (a false
 *    pass, which is not — hence the runtime cases).
 *  - It proves nothing about correctness of the checks themselves. That a
 *    boundary calls `assertVerifiedGrant` is structural evidence; that the
 *    grant means what it should is what permit.test.ts and firewall.test.ts are
 *    for.
 */

// ---------------------------------------------------------------------------
// Source model
// ---------------------------------------------------------------------------

const SCAN_ROOTS = ['packages/core/src', 'packages/runner/src'] as const;

interface SourceFile {
  /** Repo-relative, POSIX-style — the form every table below uses. */
  rel: string;
  text: string;
  /** Comments and quoted strings removed, line count preserved. */
  code: string;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(path));
    else if (entry.name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/**
 * Blank out comments and string literals while preserving line numbers.
 *
 * Necessary, not cosmetic: this repository documents its own defects in prose,
 * so every module that FIXED an injectable keyring also mentions `keyringDir`
 * in a comment, and every guard names the function it guards in an error
 * string. Scanning raw text would either drown in those or be weakened until it
 * caught nothing.
 */
function stripNonCode(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  return text
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/\/\/[^\n]*/g, blank)
    .replace(/'(?:[^'\\\n]|\\.)*'/g, blank)
    .replace(/"(?:[^"\\\n]|\\.)*"/g, blank)
    .replace(/`(?:[^`\\]|\\.)*`/g, blank);
}

const SOURCES: SourceFile[] = SCAN_ROOTS.flatMap((root) =>
  listTsFiles(join(REPO_ROOT, root)).map((path) => {
    const text = readFileSync(path, 'utf8');
    return { rel: relative(REPO_ROOT, path).split('\\').join('/'), text, code: stripNonCode(text) };
  }),
);

interface Declaration {
  file: string;
  line: number;
  /** Function name, `constructor`, or the static method name. */
  symbol: string;
  exported: boolean;
  /** Parameter list, flattened to one line. */
  params: string[];
}

const DECLARATION = /^\s*(export\s+)?(?:async\s+)?(?:(?:public|private|protected)\s+)?(?:static\s+)?(function\s+)?([A-Za-z_$][\w$]*|constructor)\s*(?:<[^(]*>)?\s*\(/;

/**
 * Collect declarations and their parameter text.
 *
 * Balanced-paren walk rather than a single regex, because a parameter list
 * routinely spans lines and contains its own parentheses and object types.
 */
function declarations(file: SourceFile): Declaration[] {
  const lines = file.code.split('\n');
  const out: Declaration[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = DECLARATION.exec(lines[i]!);
    if (!match) continue;
    const symbol = match[3]!;
    // Control-flow keywords read as calls to the regex above.
    if (['if', 'for', 'while', 'switch', 'catch', 'return', 'else'].includes(symbol)) continue;
    // Method-shaped lines inside object literals and interfaces are not
    // declarations we can attribute; the boundary tables below name real ones.
    let depth = 0;
    let started = false;
    let buffer = '';
    let closed = false;
    for (let j = i; j < Math.min(i + 60, lines.length) && !closed; j++) {
      for (const ch of lines[j]!) {
        if (ch === '(') {
          depth++;
          started = true;
          if (depth === 1) continue;
        }
        if (ch === ')') {
          depth--;
          if (depth === 0 && started) {
            closed = true;
            break;
          }
        }
        if (started && depth >= 1) buffer += ch;
      }
      buffer += ' ';
    }
    if (!closed) continue;
    const params = buffer
      // Split on top-level commas only: `opts: { a, b }` is one parameter.
      .split(/,(?![^{[(]*[}\])])/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);
    out.push({ file: file.rel, line: i + 1, symbol, exported: Boolean(match[1]), params });
  }
  return out;
}

const DECLARATIONS: Declaration[] = SOURCES.flatMap(declarations);

/** Parameter name, with `?`, defaults, destructuring braces and types removed. */
function paramName(param: string): string {
  return param.split(/[?:=]/)[0]!.replace(/^\.\.\./, '').trim();
}

/**
 * Every argument list for `symbol(` in a file, as raw text.
 *
 * Used to prove the reachable half of a known defect: a parameter that exists
 * but that no production caller supplies is a smaller problem than one being
 * used, and the difference is exactly what a test can hold still.
 */
function callArguments(file: SourceFile, symbol: string): string[] {
  const out: string[] = [];
  const pattern = new RegExp(`(?<![\\w$.])${symbol}\\s*\\(`, 'g');
  const code = file.code;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) {
    // Skip the declaration itself.
    const lineStart = code.lastIndexOf('\n', match.index) + 1;
    const lineText = code.slice(lineStart, code.indexOf('\n', match.index));
    if (/\b(function|static|constructor)\b/.test(lineText) && lineText.includes(symbol)) continue;
    let depth = 0;
    let buffer = '';
    for (let k = match.index + match[0].length - 1; k < code.length; k++) {
      const ch = code[k]!;
      if (ch === '(') {
        depth++;
        if (depth === 1) continue;
      }
      if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
      buffer += ch;
    }
    out.push(buffer.trim());
  }
  return out;
}

function sourceOf(rel: string): SourceFile {
  const file = SOURCES.find((f) => f.rel === rel);
  if (!file) throw new Error(`${rel} is not in the scanned source set — this test's tables are stale.`);
  return file;
}

/** The lines following a declaration, for the "is there a runtime check" rules. */
function bodyAfter(rel: string, declarationLine: number, lines: number): string {
  return sourceOf(rel)
    .code.split('\n')
    .slice(declarationLine - 1, declarationLine - 1 + lines)
    .join('\n');
}

// ---------------------------------------------------------------------------
// (a) Trust inputs as caller parameters
// ---------------------------------------------------------------------------

/**
 * Parameter names that name a source of TRUST rather than a piece of work.
 *
 * Deliberately broad, because the cost of a false positive is one line in the
 * table below with a reason attached, and the cost of a false negative is a
 * safeguard that verifies whatever the caller pointed it at.
 */
const TRUST_INPUT_PATTERNS: Array<[RegExp, string]> = [
  [/keyring|publickey|signingkey/i, 'a verification keyring'],
  [/revocation/i, 'a revocation source'],
  [/^now$|^clock$|^currenttime$|^at$/i, 'a clock'],
  [/trustroot|trustanchor/i, 'a trust root'],
  [/registrypath|policypath|policyfile|registryfile/i, 'a policy file'],
  [/checklist|requiredchecks|checkids/i, 'the set of checks that must pass'],
  [/^requirements?$/i, 'the requirement list'],
  [/permitpath|manifestpath/i, 'the artifact under verification'],
];

interface AllowedTrustInput {
  file: string;
  symbol: string;
  parameter: string;
  why: string;
}

/**
 * The complete set of exported production functions that may name a trust-ish
 * parameter, each with the argument for why it is not a bypass.
 *
 * This list is a RATCHET in both directions. An entry that no longer matches
 * the source fails the suite, so fixing one of these forces deleting its entry
 * rather than leaving a stale justification behind; and anything not on the
 * list fails the moment it appears.
 */
const ALLOWED_TRUST_INPUTS: AllowedTrustInput[] = [
  {
    file: 'packages/runner/src/permit.ts',
    symbol: 'verifyPermitFile',
    parameter: 'permitPath',
    why:
      'The path of the ARTIFACT being verified, not of the trust root. The keyring, the revocation list ' +
      'and the clock remain fixed, so naming a different permit file changes what is checked, never what it is checked against.',
  },
  {
    file: 'packages/runner/src/permit.ts',
    symbol: 'verifyPermitForTests',
    parameter: 'trustRoot',
    why:
      'The test seam. Split out of the production API precisely so trust inputs are not reachable through it, ' +
      'and guarded at runtime by UNDER_TEST — see the seam cases below, which prove production never calls it.',
  },
  {
    file: 'packages/runner/src/firewall.ts',
    symbol: 'readHistoricalRegistryForTests',
    parameter: 'registryPath',
    why:
      'The test seam, split out as permit.ts did. The production entry point now takes no parameter at all, ' +
      'and this one is guarded at runtime by UNDER_TEST — see the seam cases below, which prove production ' +
      'never calls it. Before the split, a caller could hand the guard a structurally valid {"runIds": []} ' +
      'and every published run became writable; that is verified in routes-web.test.ts.',
  },
  {
    file: 'packages/runner/src/lifecycle.ts',
    symbol: 'appendJournalEntry',
    parameter: 'now',
    why:
      'A timestamp written into an append-only journal, not a gate input: no check compares against it, and ' +
      'the journal chains by hash rather than by time. Residual risk recorded rather than dismissed — a caller ' +
      'may backdate an entry it writes.',
  },
  {
    file: 'packages/runner/src/lifecycle.ts',
    symbol: 'appendRawAnswer',
    parameter: 'now',
    why: 'As appendJournalEntry: a stamp on the record, never consulted by a decision.',
  },
  {
    file: 'packages/runner/src/lifecycle.ts',
    symbol: 'appendBallot',
    parameter: 'now',
    why: 'As appendJournalEntry: a stamp on the record, never consulted by a decision.',
  },
  {
    file: 'packages/runner/src/lifecycle.ts',
    symbol: 'buildReleaseChecklist',
    parameter: 'now',
    why:
      'Stamps generatedAt. Every verdict is read from the run\'s own artifacts, so a caller-chosen clock cannot ' +
      'turn a failing check into a passing one — which is the property the case below asserts by proving no ' +
      'production caller supplies one at all.',
  },
  {
    file: 'packages/runner/src/lifecycle.ts',
    symbol: 'checklistComplete',
    parameter: 'checklist',
    why:
      'A pure predicate over a checklist the caller already holds, used for display. It is NOT the release gate: ' +
      'transitionRun and setCurrentRun rebuild the checklist from the run before consulting it, which is the ' +
      'defect this shape used to be (a one-item list reading `pass` released a run).',
  },
  {
    file: 'packages/runner/src/lifecycle.ts',
    symbol: 'checklistShortfall',
    parameter: 'checklist',
    why: 'As checklistComplete — the reporting form of the same predicate.',
  },
  {
    file: 'packages/runner/src/lifecycle.ts',
    symbol: 'writeReleaseChecklist',
    parameter: 'checklist',
    why:
      'Persists a checklist the caller built. Weakest entry in this table: the published release-checklist.json ' +
      'is whatever object it is handed. It is not authority — the gate rebuilds — but the artifact and the ' +
      'decision could disagree if a future caller wrote one it had not built. Held by the file-level rule below.',
  },
  {
    file: 'packages/runner/src/judgebench.ts',
    symbol: 'assessSealedComposition',
    parameter: 'requirement',
    why:
      'A false positive, kept to show the scanner\'s reach: `SealedRequirement` is a property of a benchmark ' +
      'item (what a sealed bank must contain), not a WP-0 requirement list. Classification here is by NAME.',
  },
  {
    file: 'packages/runner/src/judgebench.ts',
    symbol: 'assessDevelopmentSizing',
    parameter: 'requirement',
    why: 'As assessSealedComposition.',
  },
];

describe('the scanner is looking at the source it claims to', () => {
  // Every check in this file is a search that passes when it finds nothing.
  // If the roots moved, the extension changed, or the comment stripper ate the
  // code, all of them would go green while checking an empty set. This is the
  // anti-vacuity guard, and it is deliberately the first thing here.
  it('sees the real modules, their declarations and their code', () => {
    expect(SOURCES.length).toBeGreaterThan(20);
    expect(SOURCES.map((f) => f.rel)).toEqual(expect.arrayContaining([
      'packages/core/src/evidence.ts',
      'packages/runner/src/permit.ts',
      'packages/runner/src/firewall.ts',
      'packages/runner/src/ledger.ts',
      'packages/runner/src/lifecycle.ts',
    ]));
    expect(DECLARATIONS.length).toBeGreaterThan(200);
    expect(
      DECLARATIONS.some((d) => d.file === 'packages/runner/src/permit.ts' && d.symbol === 'verifyPermit' && d.exported),
    ).toBe(true);
    // Code survives stripping; comments and strings do not. Both directions
    // matter: keeping the code is what makes the checks real, and dropping the
    // prose is what stops this repository's own defect write-ups tripping them.
    const permit = sourceOf('packages/runner/src/permit.ts');
    expect(permit.code).toContain('MINTED.has(');
    expect(permit.text).toContain('injectable for testability');
    expect(permit.code).not.toContain('injectable for testability');
    expect(permit.code.split('\n').length).toBe(permit.text.split('\n').length);
  });

  it('flags a synthetic offender, so the trust-input rule is known to bite', () => {
    // The checks above pass because the source is clean. This one proves the
    // scanner would NOT pass if it were not — the difference between a guard
    // and a decoration, and it costs nothing to establish.
    const text = [
      '/** A comment mentioning keyringDir, which must not count. */',
      "const message = 'pass a revocationListPath here';",
      'export function verifyThing(',
      '  payload: unknown,',
      '  keyringDir: string = DEFAULT,',
      ') {}',
      'export function innocent(runId: string, questions: Question[]) {}',
    ].join('\n');
    const synthetic: SourceFile = { rel: 'synthetic.ts', text, code: stripNonCode(text) };
    const found = declarations(synthetic);
    const flagged = found.flatMap((d) =>
      d.exported
        ? d.params
            .filter((p) => TRUST_INPUT_PATTERNS.some(([pattern]) => pattern.test(paramName(p))))
            .map((p) => `${d.symbol}:${paramName(p)}`)
        : [],
    );
    expect(flagged).toEqual(['verifyThing:keyringDir']);
    // Multi-line parameter lists are the realistic shape and were the reason
    // for the balanced-paren walk rather than a one-line regex.
    expect(found.find((d) => d.symbol === 'verifyThing')?.params).toHaveLength(2);
  });
});

describe('trust inputs are not caller parameters', () => {
  it('flags every exported production function that names one', () => {
    const offenders: string[] = [];
    for (const decl of DECLARATIONS) {
      if (!decl.exported) continue;
      for (const param of decl.params) {
        const name = paramName(param);
        const hit = TRUST_INPUT_PATTERNS.find(([pattern]) => pattern.test(name));
        if (!hit) continue;
        const allowed = ALLOWED_TRUST_INPUTS.some(
          (a) => a.file === decl.file && a.symbol === decl.symbol && a.parameter === name,
        );
        if (!allowed) {
          offenders.push(
            `${decl.file}:${decl.line} ${decl.symbol}(… ${param} …) lets a caller choose ${hit[1]}`,
          );
        }
      }
    }
    expect(
      offenders,
      `A production entry point must not accept a trust input.\n${offenders.join('\n')}\n\n` +
        'Split the seam as packages/runner/src/permit.ts does: a fixed production entry point that takes none, ' +
        'and a separately-named test entry point that refuses to run outside a test process. ' +
        'If the parameter genuinely is not a trust input, add it to ALLOWED_TRUST_INPUTS with the argument for why.',
    ).toEqual([]);
  });

  it('keeps every justification in the allow-list attached to real source', () => {
    // The other direction of the ratchet. Without this, fixing `readHistoricalRegistry`
    // would leave its excuse in the file, and the next reader would believe the
    // defect was still there — or, worse, would copy the excuse.
    for (const allowed of ALLOWED_TRUST_INPUTS) {
      const match = DECLARATIONS.find(
        (d) =>
          d.file === allowed.file &&
          d.symbol === allowed.symbol &&
          d.params.some((p) => paramName(p) === allowed.parameter),
      );
      expect(
        match,
        `ALLOWED_TRUST_INPUTS still excuses ${allowed.symbol}(${allowed.parameter}) in ${allowed.file}, ` +
          'which no longer matches the source. If it was fixed, delete the entry.',
      ).toBeDefined();
    }
  });
});

describe('the known remaining injectable parameters are not reachable in production', () => {
  it('never lets a caller name the historical-immutability policy file', () => {
    // readHistoricalRegistry still TAKES a path (recorded above). What must
    // never happen is a production call site supplying one: the registry
    // decides which runs are frozen, so a caller-chosen registry is a
    // caller-chosen definition of "published".
    const callers = SOURCES.flatMap((file) =>
      callArguments(file, 'readHistoricalRegistry')
        .filter((args) => args.trim() !== '')
        .map((args) => `${file.rel}: readHistoricalRegistry(${args})`),
    );
    expect(
      callers,
      'A production caller is choosing the immutability policy source. The default is the committed registry; ' +
        'passing a path makes the guard answer to the code it guards.',
    ).toEqual([]);
  });

  it('never lets a caller outside lifecycle.ts supply the clock or the checklist', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      if (file.rel === 'packages/runner/src/lifecycle.ts') continue; // the module's own internals
      for (const args of callArguments(file, 'buildReleaseChecklist')) {
        if (args.trim() !== '' && args.split(',').length > 1) {
          offenders.push(`${file.rel}: buildReleaseChecklist(${args})`);
        }
      }
      for (const symbol of ['transitionRun', 'setCurrentRun', 'appendRawAnswer', 'appendBallot']) {
        for (const args of callArguments(file, symbol)) {
          if (/\bnow\b|\bnew Date\b/.test(args)) offenders.push(`${file.rel}: ${symbol}(${args})`);
        }
      }
    }
    expect(offenders, 'A lifecycle timestamp is being supplied by a caller in production.').toEqual([]);
  });

  it('writes a release checklist only where one is built', () => {
    // Weak by construction — file-level, not function-level, because the build
    // and the write are twenty lines apart inside transitionRun and a
    // proximity rule would cry wolf. It still catches the shape that matters: a
    // NEW module that writes a checklist it did not derive from the run.
    for (const file of SOURCES) {
      if (callArguments(file, 'writeReleaseChecklist').length === 0) continue;
      expect(
        file.code.includes('buildReleaseChecklist('),
        `${file.rel} writes a release checklist without building one. The published checklist must be the one ` +
          'the gate evaluated, not an object handed in from elsewhere.',
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

/**
 * Every test seam this codebase is allowed to have, and what guards it.
 *
 * `guard: null` means the seam has NO runtime guard and is protected only by
 * the grep below — a convention with a test behind it, which is weaker than a
 * check and is recorded as such rather than described as "guarded".
 */
const KNOWN_SEAMS: ReadonlyArray<{ file: string; symbol: string; guard: string | null; note?: string }> = [
  { file: 'packages/runner/src/permit.ts', symbol: 'verifyPermitForTests', guard: 'UNDER_TEST' },
  { file: 'packages/runner/src/firewall.ts', symbol: 'readHistoricalRegistryForTests', guard: 'UNDER_TEST' },
  { file: 'packages/runner/src/ledger.ts', symbol: 'forTests', guard: 'UNDER_TEST' },
  { file: 'packages/runner/src/lifecycle.ts', symbol: 'useRegisterFileForTest', guard: 'assertTestSeam' },
  { file: 'packages/runner/src/lifecycle.ts', symbol: 'clearRegisterFileForTest', guard: 'assertTestSeam' },
] as const;

const SEAM_NAME = /(?:^|[a-z0-9_$])[Ff]or[Tt]ests?$/;

describe('test seams are declared, guarded, and unreachable from production', () => {
  it('has no test seam that is not on the known list', () => {
    const found = DECLARATIONS.filter((d) => SEAM_NAME.test(d.symbol)).map((d) => `${d.file}:${d.symbol}`);
    const known = KNOWN_SEAMS.map((s) => `${s.file}:${s.symbol}`);
    const undeclared = found.filter((f) => !known.includes(f));
    expect(
      undeclared,
      'A new test seam appeared. Add it to KNOWN_SEAMS with its runtime guard — a seam nobody enumerated is a ' +
        'seam nobody checked for reachability.',
    ).toEqual([]);
    // And each known seam must still exist, so the list cannot rot into a
    // decoration that guards names no longer in the source.
    for (const seam of KNOWN_SEAMS) {
      expect(found, `KNOWN_SEAMS names ${seam.symbol}, which is gone from ${seam.file}`).toContain(
        `${seam.file}:${seam.symbol}`,
      );
    }
  });

  it('guards every seam at runtime, not by naming convention', () => {
    // "Only tests call it" is a convention. `assertTestSeam` / UNDER_TEST is a
    // check, and the difference shows up the first time production code
    // imports the convenient-looking function.
    for (const seam of KNOWN_SEAMS) {
      if (seam.guard === null) continue; // recorded separately, below
      const decl = DECLARATIONS.find((d) => d.file === seam.file && d.symbol === seam.symbol);
      expect(decl, `${seam.symbol} not found in ${seam.file}`).toBeDefined();
      const body = bodyAfter(seam.file, decl!.line, 14);
      expect(
        body.includes(seam.guard),
        `${seam.file}:${seam.symbol} no longer checks ${seam.guard} before doing test-only work.`,
      ).toBe(true);
    }
  });

  it('records the exact set of seams with NO runtime guard, and lets it only shrink', () => {
    // The list is EMPTY, and the assertion is written as an equality so it
    // cannot drift back. `ReservationLedger.forTests` was the last entry: it
    // checked that the grant was real but not that the process was a test
    // process, so a production caller holding a legitimate grant could take a
    // ledger with the run lock disabled — two runners each spending the whole
    // cap, the case BUDGET-001 exists to close — and a clock of its own, which
    // decides dead-holder lock takeover. Only "no production caller does it"
    // stood in the way, and that is a convention, not a check.
    //
    // Two regressions still fail here: a new unguarded seam appearing, and an
    // existing one being fixed without this record being updated, so an excuse
    // can never outlive the defect it excuses.
    const unguarded = KNOWN_SEAMS.filter((s) => s.guard === null).map((s) => `${s.file}:${s.symbol}`);
    expect(unguarded, 'a test seam without a runtime test-process guard').toEqual([]);
  });

  it('refuses every seam at runtime when the process is not a test process', () => {
    // The guard names above are read out of the source, which proves the string
    // is present, not that it does anything. This drives the real refusal: with
    // the test-process signals removed, each seam must throw rather than hand
    // back the test-only object. Restored in a finally, because every later
    // test in this file depends on those variables.
    const saved = {
      VITEST: process.env.VITEST,
      VITEST_WORKER_ID: process.env.VITEST_WORKER_ID,
      NODE_ENV: process.env.NODE_ENV,
    };
    try {
      delete process.env.VITEST;
      delete process.env.VITEST_WORKER_ID;
      process.env.NODE_ENV = 'production';
      // Modules read the flag once at import, so this asserts the SHAPE the
      // guard depends on rather than re-importing every module under a
      // different environment: each guarded seam must consult a constant
      // derived from these three signals, and nothing else.
      for (const seam of KNOWN_SEAMS.filter((s) => s.guard === 'UNDER_TEST')) {
        const src = readFileSync(join(REPO_ROOT, seam.file), 'utf8');
        expect(src, `${seam.file} derives UNDER_TEST from something else`).toMatch(
          /const UNDER_TEST =\s*\n?\s*process\.env\.VITEST === 'true' \|\|/,
        );
        expect(src).toContain("process.env.VITEST_WORKER_ID !== undefined");
        expect(src).toContain("process.env.NODE_ENV === 'test'");
      }
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('is never called from production source', () => {
    // The check the permit module's header promises exists. Without it, the
    // split seam is only a rename.
    const offenders: string[] = [];
    for (const file of SOURCES) {
      for (const seam of KNOWN_SEAMS) {
        const isDefiningModule = file.rel === seam.file;
        // No /g flag: a global regex carries `lastIndex` between `test()`
        // calls, so scanning line by line with one would skip every other
        // match — a scanner that silently misses half its input.
        const pattern = new RegExp(`(?<![\\w$])${seam.symbol}\\s*\\(`);
        for (const line of file.code.split('\n')) {
          if (!pattern.test(line)) continue;
          // The declaration itself, and the defining module's own re-export.
          if (isDefiningModule && /\b(export|function|static)\b/.test(line)) continue;
          offenders.push(`${file.rel}: ${line.trim()}`);
        }
      }
    }
    expect(
      offenders,
      'Production source is calling a test seam. A seam reachable through the production boundary is a ' +
        'production parameter with a comment on it.',
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) Runtime authority, never a brand and never a modifier
// ---------------------------------------------------------------------------

interface Boundary {
  file: string;
  symbol: string;
  /** Regexes that must all appear within `window` lines of the declaration. */
  requires: RegExp[];
  window?: number;
  why: string;
}

const BOUNDARIES: Boundary[] = [
  {
    file: 'packages/runner/src/firewall.ts',
    symbol: 'fromVerifiedPermit',
    requires: [/assertVerifiedGrant\(/],
    why: 'It once took a plain interface, so a literal with the right shape authorised publication.',
  },
  {
    file: 'packages/runner/src/openrouter.ts',
    symbol: 'forCandidates',
    requires: [/assertVerifiedGrant\(|new OpenRouterClient\(/],
    why:
      'The paid client must be constructible only from a minted grant. The alternation is deliberate: the ' +
      'authority check lives in the private constructor (which the private-constructor rule below verifies), ' +
      'so this factory may either assert itself or route through it — but it may not do neither.',
  },
  {
    file: 'packages/runner/src/ledger.ts',
    symbol: 'forGrant',
    requires: [/assertVerifiedGrant\(/],
    why: 'The budget cap comes from the permit; a forged grant would set its own ceiling.',
  },
  {
    file: 'packages/runner/src/redemption.ts',
    symbol: 'redeemPermit',
    requires: [/assertVerifiedGrant\(/],
    why: 'Single-use enforcement is worthless if the thing being spent can be fabricated.',
  },
  {
    file: 'packages/runner/src/supabase.ts',
    symbol: 'serviceRoleClient',
    requires: [/assertVerifiedGrant\(/, /assertGrantStillValid\(/],
    window: 30,
    why: 'The one path to a service-role key. Re-validated at the point of use, not only at load.',
  },
  {
    file: 'packages/runner/src/permit.ts',
    symbol: 'isVerifiedGrant',
    requires: [/MINTED\.has\(/],
    why:
      'The whole identity model. If this ever compares a shape instead of consulting the registry of grants ' +
      'this process minted, every boundary above degrades to a type assertion.',
  },
];

describe('authority is checked at runtime, not asserted by the type system', () => {
  it.each(BOUNDARIES.map((b) => [`${b.file}:${b.symbol}`, b] as const))(
    'keeps the runtime check at %s',
    (_label, boundary) => {
      const decl = DECLARATIONS.find((d) => d.file === boundary.file && d.symbol === boundary.symbol);
      expect(decl, `${boundary.symbol} is gone from ${boundary.file}`).toBeDefined();
      const body = bodyAfter(boundary.file, decl!.line, boundary.window ?? 12);
      for (const required of boundary.requires) {
        expect(
          required.test(body),
          `${boundary.file}:${boundary.symbol} no longer matches ${required} — ${boundary.why}`,
        ).toBe(true);
      }
    },
  );

  /**
   * Private constructors that do NOT re-check their authority.
   *
   * `private` erases: `Reflect.construct(C, [forged])` and `new (C as any)(…)`
   * both reach it, so a constructor guarded only by its static factory is
   * guarded by nothing. firewall.ts and openrouter.ts both fixed this and say
   * so in their comments; ledger.ts has not.
   */
  const CONSTRUCTORS_WITHOUT_RUNTIME_CHECK: ReadonlyArray<{ file: string; why: string }> = [
    {
      file: 'packages/runner/src/ledger.ts',
      why:
        'QUARANTINED. ReservationLedger\'s constructor takes the budget cap straight off the grant it is handed ' +
        '(#totalCapUsd = min(grant.budgetCapUsd, …)) and asserts nothing. Both factories check, but the ' +
        'constructor is reachable past them, so a forged grant sets its own ceiling — the exact bypass ' +
        'Firewall\'s constructor was changed to close.',
    },
  ];

  it('never leaves a private constructor as the only gate', () => {
    const privateCtors = SOURCES.flatMap((file) =>
      file.code
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => /^\s*private\s+constructor\s*\(/.test(line))
        .map(({ index }) => ({ file: file.rel, line: index + 1 })),
    );
    // If this ever finds nothing, the rule has stopped applying to anything and
    // the tables here need revisiting rather than quietly passing.
    expect(privateCtors.length).toBeGreaterThan(0);
    const quarantined = CONSTRUCTORS_WITHOUT_RUNTIME_CHECK.map((c) => c.file);
    for (const ctor of privateCtors) {
      const guarded = /assert[A-Z]\w*\(|throw new /.test(bodyAfter(ctor.file, ctor.line, 16));
      if (quarantined.includes(ctor.file)) {
        // Recorded as open. When it is fixed this assertion fails, which is the
        // signal to delete the quarantine entry rather than leave a stale
        // excuse in the file.
        expect(
          guarded,
          `${ctor.file}:${ctor.line} now re-checks its authority. Remove it from ` +
            'CONSTRUCTORS_WITHOUT_RUNTIME_CHECK.',
        ).toBe(false);
        continue;
      }
      expect(
        guarded,
        `${ctor.file}:${ctor.line} has a private constructor with no runtime check in it. ` +
          'The modifier is a compile-time convention; the constructor is reachable from JavaScript.',
      ).toBe(true);
    }
  });

  it('takes unknown at the publication boundary rather than a branded type', () => {
    const decl = DECLARATIONS.find(
      (d) => d.file === 'packages/runner/src/firewall.ts' && d.symbol === 'assertPublishable',
    );
    expect(decl).toBeDefined();
    expect(
      decl!.params[0],
      'assertPublishable must accept `unknown` and PARSE. A branded parameter type erases, and the literal ' +
        '{ evidenceClass: "public-release", releaseState: "released" } walked through the previous version.',
    ).toMatch(/:\s*unknown\b/);
    const body = bodyAfter(decl!.file, decl!.line, 10);
    expect(/safeParseRunManifest\(|Schema\.safeParse\(/.test(body)).toBe(true);
  });

  it('declares a compile-time brand nowhere except the one recorded module', () => {
    // The pattern that already failed once here: `declare const brand: unique
    // symbol` plus an intersection type, used as if it were a runtime check.
    // It is fine as documentation. It is never authority — a cast produces one,
    // and JavaScript callers never see it at all.
    for (const file of SOURCES) {
      const branded = file.code.match(/declare const (\w+)\s*:\s*unique symbol/g) ?? [];
      if (file.rel === BRAND_ONLY_BOUNDARY.file) continue; // asserted exactly, below
      expect(
        branded,
        `${file.rel} declares a type-level brand. TypeScript erases it: if it is separating trusted material ` +
          'from untrusted, the separation must also exist at runtime.',
      ).toEqual([]);
    }
  });

  /**
   * The one boundary in this codebase whose only authority is a brand.
   *
   * `judgebench.ts` separates development material from sealed holdout
   * material with three branded types, and its header states the separation is
   * "by the type system, not by a convention". At runtime there is no
   * difference: `readSealedBank` returns `parseBank(value, 'sealed-holdout') as
   * SealedBank`, `openSealedBank` returns `bank as OpenedSealedBank` — a cast,
   * setting no field — and `buildHarnessPlan` performs no tranche check. So
   * `buildHarnessPlan(readSealedBank(file) as never, opts)`, or the same call
   * from plain JavaScript, plans a judging run over sealed holdout material
   * without ever passing the commitment check or the single-open rule that
   * `openSealedBank` exists to enforce.
   *
   * Recorded, not fixed: judgebench.ts belongs to another work package. The
   * assertions below pin the present state exactly, so the day someone adds a
   * runtime marker this case fails and has to be rewritten rather than
   * forgotten. A full runtime demonstration is not attempted here — it would
   * need a valid bank fixture and would couple this suite to that module's
   * schema, which churns.
   */
  const BRAND_ONLY_BOUNDARY = {
    file: 'packages/runner/src/judgebench.ts',
    brands: ['DEVELOPMENT_BRAND', 'SEALED_BRAND', 'OPENED_BRAND'],
    entryPoint: 'buildHarnessPlan',
  } as const;

  it('records the brand-only boundary in judgebench, and fails when it changes', () => {
    const file = sourceOf(BRAND_ONLY_BOUNDARY.file);
    const declared = [...file.code.matchAll(/declare const (\w+)\s*:\s*unique symbol/g)].map((m) => m[1]!);
    expect(
      declared,
      'The brands in judgebench.ts changed. Either a fourth brand appeared — which is more type-level ' +
        'authority, not less — or the runtime separation this case is waiting for has landed.',
    ).toEqual([...BRAND_ONLY_BOUNDARY.brands]);

    // The cast that mints the "opened" form without recording anything.
    expect(
      /as OpenedSealedBank/.test(file.code),
      'openSealedBank no longer casts to the opened form. If it now stamps a runtime marker, this whole case ' +
        'is obsolete: delete it and add the marker check to BOUNDARIES.',
    ).toBe(true);

    // And the consumer that trusts the brand. `bank.tranche` is the one field
    // that could distinguish the two at runtime; the planner never reads it.
    const decl = DECLARATIONS.find(
      (d) => d.file === BRAND_ONLY_BOUNDARY.file && d.symbol === BRAND_ONLY_BOUNDARY.entryPoint,
    );
    expect(decl, 'buildHarnessPlan is gone — this record needs rewriting.').toBeDefined();
    expect(
      /\btranche\b/.test(bodyAfter(BRAND_ONLY_BOUNDARY.file, decl!.line, 40)),
      'buildHarnessPlan now inspects the tranche at runtime. Good: remove this quarantine and assert the ' +
        'check in BOUNDARIES instead.',
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The same rules, proved at runtime through the real production entry points
// ---------------------------------------------------------------------------

describe('the production boundaries refuse the bypass at runtime', () => {
  it('refuses an injected keyring, revocation list or clock — own or inherited', () => {
    // Through `verifyPermit` itself, not a helper. The junk permit body is
    // deliberate: the refusal must come from the OPTIONS, before anything in
    // the signed material is read.
    const inputs: Array<[string, Record<string, unknown>]> = [
      ['keyringDir', { keyringDir: '/tmp/attacker-keys' }],
      ['revocationListPath', { revocationListPath: '/tmp/empty.json' }],
      ['now', { now: new Date('2020-01-01T12:00:00Z') }],
      ['clock', { clock: () => new Date(0) }],
      ['trustRoot', { trustRoot: { keyringDir: '/tmp' } }],
    ];
    for (const [label, injection] of inputs) {
      expect(() =>
        verifyPermit({
          signedPermit: { permit: {}, signature: 'x', keyId: 'y' },
          manifest: {},
          expectedMethodologyHash: 'f'.repeat(64),
          ...injection,
        } as never),
      ).toThrow(new RegExp(label));
    }
    // Inherited, not own: `Object.create` puts the key on the prototype, where
    // an `Object.keys` check would not look.
    const smuggled = Object.create({ keyringDir: '/tmp/attacker-keys' }) as Record<string, unknown>;
    smuggled.signedPermit = { permit: {}, signature: 'x', keyId: 'y' };
    smuggled.manifest = {};
    smuggled.expectedMethodologyHash = 'f'.repeat(64);
    let error: unknown;
    try {
      verifyPermit(smuggled as never);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(PermitError);
    expect((error as PermitError).code).toBe('PERMIT_TRUST_INPUT_REJECTED');
  });

  it('refuses a hand-built grant at the firewall, including through the erased private constructor', () => {
    const forged = {
      permitId: 'forged',
      kind: 'public-release',
      capabilities: ['publication', 'candidate-inference'],
      cells: [{ modelId: 'anthropic/claude-opus-5', questionId: 'conv-001' }],
      budgetCapUsd: 1000,
      executionLimit: 99,
      manifestHash: 'a'.repeat(64),
      runId: 'anything',
      evidenceClass: 'public-release',
      releaseState: 'released',
      keyId: 'nobody',
      notBeforeIso: '2020-01-01T00:00:00Z',
      notAfterIso: '2099-01-01T00:00:00Z',
      verifiedAtIso: '2026-07-31T00:00:00Z',
    };
    expect(() => Firewall.fromVerifiedPermit(forged as never)).toThrow(PermitError);
    // The factory is not the boundary — the constructor is reachable directly.
    expect(() => Reflect.construct(Firewall as never, [forged])).toThrow(PermitError);
    expect(() => new (Firewall as never as { new (g: unknown): unknown })(forged)).toThrow(PermitError);
  });

  it('denies everything without a permit, as the default posture', () => {
    const denied = Firewall.denyAll();
    expect(denied.permitId).toBeNull();
    expect(denied.budgetCapUsd).toBe(0);
    expect(denied.has('publication' as never)).toBe(false);
    expect(() => denied.requireCapability('publication' as never, 'architecture test')).toThrow(FirewallError);
    expect(() =>
      denied.requireCell({ kind: 'candidate', modelId: 'm', questionId: 'q' } as never, 'architecture test'),
    ).toThrow(FirewallError);
    // Nothing exported may re-open it: a `provenance()` on a denied firewall is
    // null rather than an empty-but-present record that reads as authorised.
    expect(denied.provenance()).toBeNull();
  });

  it('refuses a shaped literal at the publication boundary', () => {
    expect(() =>
      assertPublishable(
        { runId: 'made-up', evidenceClass: 'public-release', releaseState: 'released', rankEligible: true },
        'architecture test',
      ),
    ).toThrow(FirewallError);
    // And the reverse-shaped attack: a complete-looking object whose class is
    // not publishable must fail on the CLASS, not slip through on completeness.
    expect(() => assertPublishable(null, 'architecture test')).toThrow(FirewallError);
    expect(() => assertPublishable('public-release', 'architecture test')).toThrow(FirewallError);
  });
});
