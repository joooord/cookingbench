import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/dataset.js';

/**
 * RUN-001A validator for the curated semantic route registry.
 *
 * The inventory is an acceptance artifact, so it gets the same treatment as
 * code. An unreviewable or drifting inventory is worse than none, because it
 * reads as coverage.
 *
 * Route identity is curated, not inferred: an earlier generator derived ids
 * from `sha256(file|kind|symbol)` where symbol came from auditor prose, which
 * invented 41 symbols that appear nowhere in the source.
 *
 * Three defects in the previous validator are closed here.
 *
 *  1. THE SCANNER ONLY LOOKED FOR WRITES. Filesystem reads, which is how
 *     untrusted content crosses the boundary and how a traversal escapes a
 *     root, were invisible, so a new reader was never forced into the
 *     registry. Reads are scanned now, and the sweep more than doubled the
 *     inventory.
 *
 *  2. IT ONLY LOOKED AT packages/runner/src. apps/web was hand-registered with
 *     two entries and never checked; the source has fourteen routes. Every
 *     tree in `scanRoots` is scanned now, so a new route on the site fails the
 *     build until it is registered.
 *
 *  3. A CLOSED RISK COULD CITE A TEST THAT NEVER TOUCHED IT. `writeAnalysis`
 *     was certified by a test of `resolveRunFile`; `readResponses` by a test
 *     of `resolveRunFile`; `archiveTasteVotes` by a test of
 *     `assertArchiveGrows`; three database writers by one test of
 *     `serviceRoleClient`. A citation that does not touch the real path is the
 *     same defect class as a traceability matrix that validates itself — it
 *     cannot fail when the route stops calling the helper. A closed risk must
 *     now name a test that CALLS the route's own function.
 *
 * The enforcement layer is not exempt from its own inventory. firewall.ts used
 * to be skipped "because it is the guard", which let the guard choose the scope
 * of the register that governs it.
 */

// --- registry shape ---------------------------------------------------------

interface Risk {
  risk: string;
  severity: string;
  status: 'open' | 'closed';
  capability?: string | null;
  enforcementPoint: string;
  test: string | null;
}
interface Route {
  key: string;
  file: string;
  function: string;
  kind: string;
  operation: string;
  risks: Risk[];
}
interface FalselyClosed {
  route: string;
  citedTest: string;
  reason: string;
}
interface Registry {
  pinnedCommit: string;
  scanRoots: string[];
  routeKinds: string[];
  riskKinds: string[];
  severities: string[];
  falselyClosed: FalselyClosed[];
  routes: Route[];
}

const CAPABILITIES = [
  'catalog-read',
  'candidate-inference',
  'judge-inference',
  'development-db-write',
  'live-db-write',
  'presentation-erratum',
  'result-sync',
  'publication',
];

/**
 * An open risk must SAY it is open in its enforcement point. Free prose next to
 * `status: open` reads as coverage to anyone skimming, which is how "the
 * capability is checked" sat beside an unenforced publication gate for a whole
 * revision.
 */
const OPEN_MARKER = /\bNOT (YET|ENFORCED|REVIEWED|WIRED)\b|\bUNPROVEN\b/;

const registry = parse(
  readFileSync(join(REPO_ROOT, 'docs/wp-0/routes.yaml'), 'utf8'),
) as Registry;

// --- source scanning --------------------------------------------------------

/**
 * Sink kinds the scanner recognises, and the route kinds each may satisfy.
 *
 * `fs-read` deliberately includes the metadata calls (`existsSync`, `statSync`,
 * `realpathSync`). An existence probe is a read of the filesystem, it is how
 * `hasResponse` decides whether to spend money again, and excluding it would
 * mean a file that only probes could carry no route at all.
 *
 * The project's own write helpers are sinks too. `calibration.ts` writes
 * exclusively through `writeRunFileAtomic` and contains no `node:fs` call, so a
 * scanner that knew only the Node API would have declared it sink-free while it
 * was writing calibration.json into a run.
 *
 * `.from('...')` is the Supabase table accessor, but a bare `\.from\(` also
 * matches `Array.from(...)` and `Object.fromEntries` — which is how simulate.ts,
 * a pure-arithmetic module with no sink of any kind, was once flagged as an
 * unregistered database route. Requiring a string-literal first argument
 * removes the whole class. A completeness check that cries wolf gets
 * suppressed.
 */
const SINK_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'fs-write',
    /(?<![.\w])(writeFileSync|appendFileSync|copyFileSync|linkSync|symlinkSync|renameSync|mkdirSync|createWriteStream|writeRunFileAtomic|writeOutputFileAtomic|appendRunFileLine)\s*\(/,
  ],
  ['fs-delete', /(?<![.\w])(rmSync|unlinkSync|rmdirSync)\s*\(/],
  [
    'fs-read',
    /(?<![.\w])(readFileSync|readdirSync|createReadStream|opendirSync|readlinkSync|globSync|existsSync|statSync|lstatSync|realpathSync|accessSync)\s*\(/,
  ],
  // `.complete(` is the guarded transport: judge.ts and cli.ts reach the
  // network only through it, and a scanner that insisted on a literal `fetch(`
  // would call both of them network-free.
  ['network-out', /(?<![.\w])fetch\s*\(|globalThis\.fetch\s*\(|(?<![.\w])new\s+Request\s*\(|\.complete\s*\(/],
  ['db', /(?<![.\w])(createClient|serviceRoleClient)\s*\(|(?<!Array)(?<!Object)\.from\s*\(\s*['"`]/],
  ['process-exec', /(?<![.\w])(execSync|spawnSync|execFileSync|execFile|spawn)\s*\(/],
];

const KINDS_FOR_SINK: Record<string, readonly string[]> = {
  'fs-write': ['fs-write'],
  'fs-delete': ['fs-delete'],
  'fs-read': ['fs-read'],
  'network-out': ['network-out'],
  db: ['db-read', 'db-write'],
  'process-exec': ['process-exec'],
};

const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'public', 'coverage']);

function sourceFiles(root: string, out: string[] = []): string[] {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Strip comments and import statements before matching.
 *
 * Both matter. A block comment in openrouter.ts contains the text
 * `complete()` while explaining an old defect, and every module imports the
 * very symbols the scanner looks for — `import { writeFileSync }` is not a
 * write. Counting either would make the scan report sinks that do not exist,
 * and a scan nobody believes is a scan nobody reads.
 */
export function executableLines(src: string): string[] {
  const out: string[] = [];
  let inBlockComment = false;
  let inImport = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      inBlockComment = false;
      line = line.slice(end + 2);
    }
    const open = line.indexOf('/*');
    if (open !== -1 && line.indexOf('*/', open) === -1) {
      inBlockComment = true;
      line = line.slice(0, open);
    }
    line = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '');
    if (/^\s*import\b/.test(line)) inImport = true;
    if (inImport) {
      if (/\bfrom\s*['"]/.test(line) || /;\s*$/.test(line)) inImport = false;
      continue;
    }
    out.push(line);
  }
  return out;
}

/** The sink kinds present in one source file. */
export function scanSinks(src: string): Set<string> {
  const found = new Set<string>();
  for (const line of executableLines(src)) {
    for (const [kind, pattern] of SINK_PATTERNS) if (pattern.test(line)) found.add(kind);
  }
  return found;
}

/**
 * Does this file DECLARE the named symbol?
 *
 * `src.includes(name)` was the old check, which a route could satisfy by
 * naming a word that happened to appear in a comment. The method form requires
 * an access modifier so that a CALL at the start of a line — `  writeResponse({`
 * in some other module — cannot masquerade as a declaration.
 */
export function declaresSymbol(src: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`^\\s*(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class)\\s+${n}\\b`, 'm'),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\b`, 'm'),
    new RegExp(`^\\s*(?:public|private|protected|static|async|get|set)\\s+(?:async\\s+)?${n}\\s*\\(`, 'm'),
  ];
  return patterns.some((p) => p.test(src));
}

/**
 * Does this text CALL the named symbol?
 *
 * Two forms, and the distinction is load-bearing. `serviceRoleClient(grant,
 * 'result-sync', 'syncRun')` MENTIONS syncRun — it was the citation three
 * database routes relied on — but it does not call it. Matching a call and not
 * a mention is what reopened them.
 */
export function callsSymbol(text: string, name: string): boolean {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const invocation = new RegExp(`(?:^|[^A-Za-z0-9_$])\\.?${n}\\s*\\(`, 'm');
  const staticMember = new RegExp(`(?:^|[^A-Za-z0-9_$.])${n}\\s*\\.\\s*[A-Za-z_$]`, 'm');
  return invocation.test(text) || staticMember.test(text);
}

// --- test harvesting --------------------------------------------------------

interface TestCase {
  file: string;
  name: string;
  body: string;
}

const TEST_DIR = join(REPO_ROOT, 'packages/runner/test');

/** Top-level helper declarations in a test file, sliced to the next one. */
function helperBodies(lines: string[]): Map<string, string> {
  const decl = /^(?:export\s+)?(?:async\s+)?(?:function\s+([A-Za-z0-9_$]+)|(?:const|let)\s+([A-Za-z0-9_$]+)\s*=)/;
  const starts: Array<{ name: string; line: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = decl.exec(lines[i]!);
    if (m) starts.push({ name: (m[1] ?? m[2])!, line: i });
    else if (/^(?:describe|it)\s*\(/.test(lines[i]!)) starts.push({ name: '', line: i });
  }
  const out = new Map<string, string>();
  for (let i = 0; i < starts.length; i++) {
    const { name, line } = starts[i]!;
    if (!name) continue;
    const end = starts[i + 1]?.line ?? lines.length;
    out.set(name, lines.slice(line, end).join('\n'));
  }
  return out;
}

/**
 * Every named test case, with its body, and with one level of local helper
 * expansion.
 *
 * The expansion is not a loophole, it is how tests are written: ledger.test.ts
 * builds its subject through a two-line `ledgerFor()` that calls
 * `ReservationLedger.forTests`. Refusing that would have downgraded a dozen
 * genuinely-proved risks. It stays one level deep and stays inside the test
 * file, so it can only reach code the test itself already runs — it can never
 * reach across to a production helper the route merely happens to share, which
 * is the defect this whole check exists for. permit.test.ts's `verify()`
 * wrapper is expanded too, and its risks stay open regardless: the wrapper
 * calls `verifyPermit` while supplying its own keyringDir, and never calls
 * `loadPublicKey` at all.
 */

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

function testCases(): TestCase[] {
  const cases: TestCase[] = [];
  for (const file of readdirSync(TEST_DIR).filter((f) => f.endsWith('.ts'))) {
    const lines = executableLines(readFileSync(join(TEST_DIR, file), 'utf8'));
    const helpers = helperBodies(lines);
    let describeName = '';
    let current: { name: string; from: number } | null = null;
    const flush = (to: number) => {
      if (!current) return;
      const body = lines.slice(current.from, to).join('\n');
      const expanded = [body];
      for (const [name, text] of helpers) if (callsSymbol(body, name)) expanded.push(text);
      cases.push({ file, name: `${describeName} > ${current.name}`, body: expanded.join('\n') });
      current = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const d = TITLE.describe(lines[i]!);
      if (d !== null) {
        flush(i);
        describeName = d;
        continue;
      }
      const t = TITLE.it(lines[i]!);
      if (t !== null) {
        flush(i);
        current = { name: t, from: i };
      }
    }
    flush(lines.length);
  }
  return cases;
}

const CASES = testCases();
const CASES_BY_NAME = new Map(CASES.map((c) => [c.name, c] as const));

// --- the validator ----------------------------------------------------------

interface ScanContext {
  /** relative source path -> sink kinds found in it */
  sinks: Map<string, Set<string>>;
  /** relative source path -> file contents */
  sources: Map<string, string>;
  /** exact test name -> case */
  cases: Map<string, TestCase>;
}

function realScan(roots: readonly string[]): ScanContext {
  const sinks = new Map<string, Set<string>>();
  const sources = new Map<string, string>();
  for (const root of roots) {
    for (const path of sourceFiles(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, path);
      const src = readFileSync(path, 'utf8');
      sources.set(rel, src);
      const found = scanSinks(src);
      if (found.size) sinks.set(rel, found);
    }
  }
  return { sinks, sources, cases: CASES_BY_NAME };
}

/**
 * Every rule, in one place, returning problems rather than asserting — so the
 * real registry and the synthetic bypass fixtures below go through the SAME
 * code. A validator with a separate path for its own negative tests proves
 * nothing about the path the registry actually takes.
 */
export function validateRegistry(reg: Registry, ctx: ScanContext): string[] {
  const problems: string[] = [];
  const say = (m: string) => problems.push(m);

  const seen = new Set<string>();
  for (const route of reg.routes) {
    if (seen.has(route.key)) say(`duplicate route key ${route.key}`);
    seen.add(route.key);

    if (!reg.routeKinds.includes(route.kind)) say(`${route.key}: unknown kind ${route.kind}`);

    const src = ctx.sources.get(route.file);
    if (src === undefined) {
      say(`${route.key}: ${route.file} is not a scanned source file`);
    } else if (!declaresSymbol(src, route.function)) {
      say(`${route.key}: ${route.file} declares no symbol ${route.function}`);
    }

    // Backward completeness: the route must resolve to a real sink of its own
    // kind, in its own file. A phantom route is the failure mode a hand-kept
    // registry drifts into — apps/web's ballot insert was filed as `db-write`
    // when the file makes a `fetch` and holds no database sink at all.
    const found = ctx.sinks.get(route.file) ?? new Set<string>();
    const resolves = [...found].some((sink) => (KINDS_FOR_SINK[sink] ?? []).includes(route.kind));
    if (src !== undefined && !resolves) {
      say(`${route.key}: no ${route.kind} sink found in ${route.file} (found: ${[...found].join(', ') || 'none'})`);
    }

    if (route.risks.length === 0) say(`${route.key}: no risks`);
    for (const risk of route.risks) {
      if (!reg.riskKinds.includes(risk.risk)) say(`${route.key}: unknown risk ${risk.risk}`);
      if (!reg.severities.includes(risk.severity)) say(`${route.key}/${risk.risk}: unknown severity ${risk.severity}`);
      if (risk.status !== 'open' && risk.status !== 'closed') say(`${route.key}/${risk.risk}: bad status`);
      if (risk.capability && !CAPABILITIES.includes(risk.capability)) {
        say(`${route.key}/${risk.risk}: unknown capability ${risk.capability}`);
      }

      if (risk.status === 'closed') {
        if (!risk.test) {
          say(`${route.key}/${risk.risk}: closed with no test`);
          continue;
        }
        const found2 = ctx.cases.get(risk.test);
        if (!found2) {
          say(`${route.key}/${risk.risk}: no test named "${risk.test}"`);
        } else if (!callsSymbol(found2.body, route.function)) {
          // The rule that reopened eleven risks.
          say(
            `${route.key}/${risk.risk}: cited test "${risk.test}" never calls ${route.function} — ` +
              `it exercises a helper, so it cannot fail when the route stops using one`,
          );
        }
        if (OPEN_MARKER.test(risk.enforcementPoint)) {
          say(`${route.key}/${risk.risk}: closed but the enforcement point says it is not`);
        }
      } else {
        if (risk.test !== null) say(`${route.key}/${risk.risk}: open but cites a test`);
        if (!OPEN_MARKER.test(risk.enforcementPoint)) {
          say(`${route.key}/${risk.risk}: open, but the enforcement point does not say so`);
        }
      }
    }
  }

  // Forward completeness: every sink kind in every scanned file has a route.
  for (const [file, kinds] of ctx.sinks) {
    for (const sink of kinds) {
      const allowed = KINDS_FOR_SINK[sink] ?? [];
      const covered = reg.routes.some((r) => r.file === file && allowed.includes(r.kind));
      if (!covered) say(`unregistered ${sink} sink in ${file}`);
    }
  }

  return problems;
}

// --- the suite --------------------------------------------------------------

describe('route registry is acceptance-grade', () => {
  const ctx = realScan(registry.scanRoots);

  it('passes every rule it declares, in both directions', () => {
    // One assertion over the whole validator, so the registry cannot satisfy
    // the individual checks below while failing a rule that has no test of
    // its own.
    expect(validateRegistry(registry, ctx)).toEqual([]);
  });

  it('has a unique key per route', () => {
    const keys = registry.routes.map((r) => r.key);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i)).toEqual([]);
  });

  it('names only source files that exist, with a real declared symbol', () => {
    for (const route of registry.routes) {
      expect(existsSync(join(REPO_ROOT, route.file)), `${route.key}: ${route.file} missing`).toBe(true);
      const src = readFileSync(join(REPO_ROOT, route.file), 'utf8');
      expect(declaresSymbol(src, route.function), `${route.key}: ${route.file} declares no ${route.function}`).toBe(
        true,
      );
    }
  });

  it('covers every filesystem, network and database sink under every scan root', () => {
    const uncovered: string[] = [];
    for (const [file, kinds] of ctx.sinks) {
      for (const sink of kinds) {
        const allowed = KINDS_FOR_SINK[sink] ?? [];
        if (!registry.routes.some((r) => r.file === file && allowed.includes(r.kind))) {
          uncovered.push(`${file}:${sink}`);
        }
      }
    }
    // No exemption list. firewall.ts used to be skipped for being the guard,
    // which let the guard set the scope of the register that governs it.
    expect(uncovered, 'sinks with no registry route').toEqual([]);
  });

  it('resolves every registered route back to a real sink of that kind', () => {
    const phantom: string[] = [];
    for (const route of registry.routes) {
      const found = ctx.sinks.get(route.file) ?? new Set<string>();
      if (![...found].some((s) => (KINDS_FOR_SINK[s] ?? []).includes(route.kind))) phantom.push(route.key);
    }
    expect(phantom, 'routes that resolve to no sink').toEqual([]);
  });

  it('scans apps/web, not only the runner', () => {
    // The gap this revision closes: the web routes used to be hand-written and
    // were never compared against the source, so five PostgREST calls and
    // seven filesystem readers stayed invisible.
    expect(registry.scanRoots).toContain('apps/web');
    const webFiles = [...ctx.sinks.keys()].filter((f) => f.startsWith('apps/web/'));
    expect(webFiles.length, 'apps/web contributed no scanned sinks').toBeGreaterThan(0);
    expect(webFiles).toContain('apps/web/lib/data.ts');
    expect(webFiles).toContain('apps/web/lib/supabase.ts');
    expect(registry.routes.some((r) => r.file === 'apps/web/lib/data.ts' && r.kind === 'fs-read')).toBe(true);
  });

  it('treats filesystem reads as routes, not as exempt', () => {
    // The other gap: the scanner knew writes, network and database calls only.
    expect(registry.routes.filter((r) => r.kind === 'fs-read').length).toBeGreaterThan(20);
    // Files that ONLY read had no route at all before this. dataset.ts is the
    // clearest case: it reads the bank every run scores against.
    expect(ctx.sinks.get('packages/runner/src/dataset.ts')).toEqual(new Set(['fs-read']));
    expect(registry.routes.some((r) => r.file === 'packages/runner/src/dataset.ts')).toBe(true);
  });

  it('cites an EXACT named test case for every closed risk', () => {
    for (const route of registry.routes) {
      for (const risk of route.risks.filter((r) => r.status === 'closed')) {
        expect(risk.test, `${route.key}/${risk.risk} closed with no test`).toBeTruthy();
        expect(CASES_BY_NAME.has(risk.test!), `${route.key}/${risk.risk}: no test named "${risk.test}"`).toBe(true);
      }
    }
  });

  it('requires every closed risk to cite a test that CALLS the route', () => {
    // The rule that reopened eleven risks. A test of a helper the route
    // happens to use cannot fail when the route stops using it.
    const bad: string[] = [];
    for (const route of registry.routes) {
      for (const risk of route.risks.filter((r) => r.status === 'closed')) {
        const c = CASES_BY_NAME.get(risk.test!);
        if (c && !callsSymbol(c.body, route.function)) bad.push(`${route.key}/${risk.risk} -> ${risk.test}`);
      }
    }
    expect(bad, 'closed risks whose cited test never calls the route').toEqual([]);
  });

  it('never claims an open risk is enforced', () => {
    for (const route of registry.routes) {
      for (const risk of route.risks.filter((r) => r.status === 'open')) {
        expect(risk.test, `${route.key}/${risk.risk} is open but cites a test`).toBeNull();
        expect(risk.enforcementPoint, `${route.key}/${risk.risk} is open but does not say so`).toMatch(OPEN_MARKER);
      }
    }
  });

  it('derives route status as open until every risk is closed', () => {
    // Reported here rather than stored, so the two cannot drift apart.
    const status = (r: Route) => (r.risks.every((x) => x.status === 'closed') ? 'closed' : 'open');
    // A route with any open risk is open even if other risks are closed —
    // leaderboard:write is closed for overwrite but open for publication.
    const board = registry.routes.find((r) => r.key === 'runner:store:leaderboard:write')!;
    expect(status(board)).toBe('open');
    expect(board.risks.some((r) => r.status === 'closed')).toBe(true);
  });

  it('records every route it reopened, against a real route and a real test', () => {
    // The downgrades are the finding, so they are part of the artifact rather
    // than a commit message nobody reads back.
    expect(registry.falselyClosed.length).toBeGreaterThan(0);
    for (const entry of registry.falselyClosed) {
      const route = registry.routes.find((r) => r.key === entry.route);
      expect(route, `falselyClosed names unknown route ${entry.route}`).toBeTruthy();
      expect(CASES_BY_NAME.has(entry.citedTest), `falselyClosed cites unknown test "${entry.citedTest}"`).toBe(true);
      // The claim must still hold: the test must genuinely not call the route.
      const c = CASES_BY_NAME.get(entry.citedTest)!;
      expect(
        callsSymbol(c.body, route!.function),
        `${entry.route}: the reopening reason is stale — "${entry.citedTest}" does call ${route!.function} now`,
      ).toBe(false);
      expect(entry.reason.length, `${entry.route}: no reason given`).toBeGreaterThan(40);
    }
  });

  it('reports honest totals', () => {
    const risks = registry.routes.flatMap((r) => r.risks);
    const totals = {
      routes: registry.routes.length,
      risks: risks.length,
      closedRisks: risks.filter((r) => r.status === 'closed').length,
      openRisks: risks.filter((r) => r.status === 'open').length,
      openRoutes: registry.routes.filter((r) => r.risks.some((x) => x.status === 'open')).length,
      reopened: registry.falselyClosed.length,
      scannedFilesWithSinks: ctx.sinks.size,
    };
    expect(totals.closedRisks + totals.openRisks).toBe(totals.risks);
    expect(totals.openRoutes).toBeGreaterThan(0); // WP-0 is not complete
    console.log('route registry totals:', JSON.stringify(totals));
  });
});

/**
 * Negative tests. Each drives the REAL `validateRegistry` — the same function
 * the committed registry goes through — with a registry crafted to slip the
 * rule. A validator that keeps a separate path for its own tests proves
 * nothing about the path the artifact takes.
 */
describe('the registry validator cannot be talked round', () => {
  const ctx = realScan(registry.scanRoots);
  const base = (routes: Route[], falselyClosed: FalselyClosed[] = []): Registry => ({
    ...registry,
    routes,
    falselyClosed,
  });

  it('rejects a closed risk whose test only exercises a helper', () => {
    // Verbatim the citation that certified writeAnalysis for a whole revision.
    const problems = validateRegistry(
      base([
        {
          key: 'x:analyze:write',
          file: 'packages/runner/src/analyze.ts',
          function: 'writeAnalysis',
          kind: 'fs-write',
          operation: 'writes analysis.json',
          risks: [
            {
              risk: 'historical-overwrite',
              severity: 'high',
              status: 'closed',
              enforcementPoint: 'firewall.resolveRunDir write mode',
              test: 'path confinement — the traversal that WP-0 closed > guards files inside a frozen run, and validates the final target',
            },
          ],
        },
      ]),
      ctx,
    );
    expect(problems.some((p) => p.includes('never calls writeAnalysis'))).toBe(true);
  });

  it('rejects a citation that merely MENTIONS the route in a string', () => {
    // `serviceRoleClient(grant, 'result-sync', 'syncRun')` contains the text
    // syncRun. Three database routes were closed on exactly this.
    const problems = validateRegistry(
      base([
        {
          key: 'x:sync:run',
          file: 'packages/runner/src/sync.ts',
          function: 'syncRun',
          kind: 'db-write',
          operation: 'upserts a run',
          risks: [
            {
              risk: 'unauthorised-publish',
              severity: 'high',
              status: 'closed',
              enforcementPoint: 'serviceRoleClient requires result-sync',
              test: 'the paid client cannot be built without authorisation > refuses a service-role database client without the capability',
            },
          ],
        },
      ]),
      ctx,
    );
    expect(problems.some((p) => p.includes('never calls syncRun'))).toBe(true);
  });

  it('rejects a route whose symbol the file only mentions', () => {
    // The old check was `src.includes(route.function)`, which a comment
    // satisfied. 'firewall' appears throughout store.ts prose.
    const problems = validateRegistry(
      base([
        {
          key: 'x:phantom',
          file: 'packages/runner/src/store.ts',
          function: 'firewall',
          kind: 'fs-write',
          operation: 'invented',
          risks: [
            { risk: 'historical-overwrite', severity: 'high', status: 'open', enforcementPoint: 'NOT YET', test: null },
          ],
        },
      ]),
      ctx,
    );
    expect(problems.some((p) => p.includes('declares no symbol firewall'))).toBe(true);
  });

  it('rejects a route filed under a kind its file has no sink for', () => {
    // apps/web/lib/supabase.ts talks to PostgREST with fetch and holds no
    // database sink; it was registered as db-write for two revisions.
    const problems = validateRegistry(
      base([
        {
          key: 'x:web:vote',
          file: 'apps/web/lib/supabase.ts',
          function: 'castTasteVote',
          kind: 'db-write',
          operation: 'ballot insert',
          risks: [
            { risk: 'unauthorised-publish', severity: 'medium', status: 'open', enforcementPoint: 'NOT YET WIRED', test: null },
          ],
        },
      ]),
      ctx,
    );
    expect(problems.some((p) => p.includes('no db-write sink found in apps/web/lib/supabase.ts'))).toBe(true);
  });

  it('rejects an open risk whose enforcement point reads as enforced', () => {
    const problems = validateRegistry(
      base([
        {
          key: 'x:soft',
          file: 'packages/runner/src/analyze.ts',
          function: 'writeAnalysis',
          kind: 'fs-write',
          operation: 'writes analysis.json',
          risks: [
            {
              risk: 'unauthorised-publish',
              severity: 'high',
              status: 'open',
              enforcementPoint: 'the capability is checked at the boundary',
              test: null,
            },
          ],
        },
      ]),
      ctx,
    );
    expect(problems.some((p) => p.includes('the enforcement point does not say so'))).toBe(true);
  });

  it('rejects a registry that drops a file the scanner found', () => {
    // Forward completeness with the whole registry removed except one route:
    // every other scanned sink must be reported.
    const kept = registry.routes.filter((r) => r.key === 'runner:store:scores:write');
    const problems = validateRegistry(base(kept), ctx);
    const missing = (kind: string, file: string) => `unregistered ${kind} sink in ${file}`;
    expect(problems).toContain(missing('fs-read', 'apps/web/lib/data.ts'));
    expect(problems).toContain(missing('network-out', 'apps/web/lib/supabase.ts'));
    expect(problems).toContain(missing('fs-read', 'packages/runner/src/dataset.ts'));
    expect(problems).toContain(missing('process-exec', 'packages/runner/src/derive.ts'));
    expect(problems).toContain(missing('db', 'packages/runner/src/sync.ts'));
    // …and the enforcement layer itself, which used to be exempt outright.
    expect(problems).toContain(missing('fs-write', 'packages/runner/src/firewall.ts'));
  });

  it('has a scanner that is not vacuous', () => {
    // A regex that matched nothing would make forward completeness trivially
    // true, which is how a completeness check dies quietly.
    expect(scanSinks("const a = readFileSync(p, 'utf8');")).toEqual(new Set(['fs-read']));
    expect(scanSinks('writeFileSync(p, x);')).toEqual(new Set(['fs-write']));
    expect(scanSinks('await fetch(url);')).toEqual(new Set(['network-out']));
    expect(scanSinks("db.from('taste_votes').select()")).toEqual(new Set(['db']));
    expect(scanSinks("execFileSync('git', args)")).toEqual(new Set(['process-exec']));
    expect(scanSinks('rmSync(p, { force: true });')).toEqual(new Set(['fs-delete']));
    // …and does not fire on the look-alikes that made it cry wolf before.
    expect(scanSinks('Array.from({ length: n }, (_x, i) => i)')).toEqual(new Set());
    expect(scanSinks('Object.fromEntries(pairs)')).toEqual(new Set());
    expect(scanSinks("import { writeFileSync } from 'node:fs';")).toEqual(new Set());
    expect(scanSinks('// writeFileSync(p, x)')).toEqual(new Set());
    expect(scanSinks('/* explains that complete() used to pass the seat */')).toEqual(new Set());
  });

  it('does not read a mention as a call, or a call as a declaration', () => {
    expect(callsSymbol("serviceRoleClient(g, 'result-sync', 'syncRun')", 'syncRun')).toBe(false);
    expect(callsSymbol('await syncRun(grant, id)', 'syncRun')).toBe(true);
    expect(callsSymbol('await client.complete(m, msgs, opts)', 'complete')).toBe(true);
    expect(callsSymbol('ReservationLedger.forTests(g, RUN, {})', 'ReservationLedger')).toBe(true);
    expect(callsSymbol('expect(thing.completed).toBe(true)', 'complete')).toBe(false);
    // A call at the start of a line is not a declaration.
    expect(declaresSymbol('  writeResponse({ runId });', 'writeResponse')).toBe(false);
    expect(declaresSymbol('export function writeResponse(r: X): void {', 'writeResponse')).toBe(true);
    expect(declaresSymbol('  async complete(', 'complete')).toBe(true);
    expect(declaresSymbol('  static forCandidates(g, l) {', 'forCandidates')).toBe(true);
    expect(declaresSymbol('const envPath = join(REPO_ROOT, ".env");', 'envPath')).toBe(true);
    expect(declaresSymbol('// mentions writeAnalysis in prose', 'writeAnalysis')).toBe(false);
  });

  it('harvests a title through quotes, escapes and each-templates', () => {
    // Three ways the one-line regex this replaces got a title wrong, each of
    // which made an HONEST citation look fabricated — the worst direction for a
    // completeness checker to fail in, because the cheapest way to make the
    // suite pass is to weaken the citation.
    expect(TITLE.it(`  it('reading it as \"no disputes\"', () => {`)).toBe('reading it as "no disputes"');
    expect(TITLE.describe(`describe('this run\\'s own', () => {`)).toBe("this run's own");
    expect(TITLE.it(`  it.each([1, 2])('changes %s', (x) => {`)).toBe('changes %s');
    expect(TITLE.describe('  const notADescribe = 1;')).toBeNull();
  });

  it('harvests a test name that contains a quote, rather than truncating it', () => {
    // The harvester used `['"`](.+?)['"`]`, which ends a lazy match at the
    // first quote of ANY kind. `it('… reading it as "no disputes"')` therefore
    // entered the index under a truncated name, and the registry's citation of
    // the real name could never match — reported as "no test named …" for a
    // test that exists and passes. Silent truncation inside a completeness
    // checker is worse than an obvious failure: it makes an honest citation
    // look dishonest, and the fix is to weaken the citation.
    const real = CASES.find((c) => c.name.includes('reading it as "no disputes"'));
    expect(real, 'a quoted test name was truncated out of the index again').toBeDefined();
    expect(real!.name).toBe(
      'runner:adjudicate:record:read — readAdjudicationRecord > ' +
        'refuses an unparseable record rather than reading it as "no disputes"',
    );
  });
});
