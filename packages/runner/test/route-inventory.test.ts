import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
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
 * Four defects in the previous validator are closed here.
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
 *  4. IT REDUCED A FILE TO A SET OF KINDS. One registered fs-read anywhere in
 *     a file therefore covered every other read in that file, including reads
 *     in functions the registry never named. The scanner now records each AST
 *     call site and its enclosing symbol, follows named same-module delegates,
 *     and requires every site to have an owning semantic route.
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
  retired?: boolean;
}
interface RetiredRoute {
  key: string;
  file: string;
  formerFunction: string;
  formerKind: string;
  disposition: 'removed' | 'refusal';
  proofTest: string;
  reason: string;
}
interface Registry {
  pinnedCommit: string;
  scanRoots: string[];
  routeKinds: string[];
  riskKinds: string[];
  severities: string[];
  retiredRoutes?: RetiredRoute[];
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
const FS_WRITES = new Set([
  'writeFileSync',
  'appendFileSync',
  'copyFileSync',
  'linkSync',
  'symlinkSync',
  'renameSync',
  'mkdirSync',
  'createWriteStream',
  'writeRunFileAtomic',
  'writeOutputFileAtomic',
  'appendRunFileLine',
]);
const FS_DELETES = new Set(['rmSync', 'unlinkSync', 'rmdirSync']);
const FS_READS = new Set([
  'readFileSync',
  'readdirSync',
  'createReadStream',
  'opendirSync',
  'readlinkSync',
  'globSync',
  'existsSync',
  'statSync',
  'lstatSync',
  'realpathSync',
  'accessSync',
  // Cross-module project readers are boundary calls in their own right. The
  // scanner follows same-module helpers transitively below, but must not build
  // an unsound whole-program call graph merely to recognise these fixed APIs.
  'readRunFile',
  'readRunFileOrNull',
  'readRunJsonEntries',
]);
const PROCESS_EXEC = new Set(['execSync', 'spawnSync', 'execFileSync', 'execFile', 'spawn']);

export interface SinkSite {
  kind: string;
  /** Nearest named function/method/class that actually contains the call. */
  symbol: string | null;
  callee: string;
  line: number;
  column: number;
}

interface ModuleScan {
  sites: SinkSite[];
  /** named callable -> named same-module callables it invokes */
  calls: Map<string, Set<string>>;
}

function propertyName(node: ts.PropertyName | ts.BindingName | undefined): string | null {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) return node.text;
  if (ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text;
  return null;
}

/**
 * The semantic owner of a sink call.
 *
 * Anonymous callbacks are deliberately skipped: a `map(() => readFileSync())`
 * inside `loadQuestions` is still a route through `loadQuestions`. Class
 * constructors use the class name; named methods use the method name. A
 * module-initialisation sink has no owner and therefore cannot be made to look
 * covered by registering an unrelated function in the same file.
 */
function enclosingSymbol(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isFunctionDeclaration(current)) {
      const name = propertyName(current.name);
      if (name) return name;
    } else if (
      ts.isMethodDeclaration(current) ||
      ts.isMethodSignature(current) ||
      ts.isGetAccessorDeclaration(current) ||
      ts.isSetAccessorDeclaration(current)
    ) {
      const name = propertyName(current.name);
      if (name) return name;
    } else if (ts.isConstructorDeclaration(current)) {
      const owner = current.parent;
      if (ts.isClassDeclaration(owner) || ts.isClassExpression(owner)) {
        const name = propertyName(owner.name);
        if (name) return name;
      }
      return 'constructor';
    } else if (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) {
      const parent = current.parent;
      if (ts.isVariableDeclaration(parent)) {
        const name = propertyName(parent.name);
        if (name) return name;
      }
      if (ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) {
        const name = propertyName(parent.name);
        if (name) return name;
      }
      // Anonymous callback: keep walking to the named route that owns it.
    }
    current = current.parent;
  }
  return null;
}

function callName(expression: ts.LeftHandSideExpression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function chainedDbKind(node: ts.CallExpression): 'db-read' | 'db-write' | 'db' {
  const methods = new Set<string>();
  let current: ts.Node = node;
  while (current.parent) {
    const parent = current.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.expression === current) {
      methods.add(parent.name.text);
      current = parent;
      continue;
    }
    if (ts.isCallExpression(parent) && parent.expression === current) {
      current = parent;
      continue;
    }
    break;
  }
  if ([...methods].some((name) => ['insert', 'upsert', 'update', 'delete'].includes(name))) return 'db-write';
  if (methods.has('select')) return 'db-read';
  return 'db';
}

function sinkKind(node: ts.CallExpression | ts.NewExpression): string | null {
  const callee = callName(node.expression);
  if (!callee) return null;
  if (FS_WRITES.has(callee)) return 'fs-write';
  if (FS_DELETES.has(callee)) return 'fs-delete';
  if (FS_READS.has(callee)) return 'fs-read';
  if (PROCESS_EXEC.has(callee)) return 'process-exec';

  if (callee === 'Request' && ts.isNewExpression(node)) return 'network-out';
  if (callee === 'fetch' || callee === 'complete') return 'network-out';
  if (callee === 'createClient' || callee === 'serviceRoleClient') return 'db';
  if (callee === 'from' && ts.isCallExpression(node)) {
    const first = node.arguments[0];
    if (!first || (!ts.isStringLiteral(first) && !ts.isNoSubstitutionTemplateLiteral(first))) return null;
    if (ts.isPropertyAccessExpression(node.expression)) {
      const owner = node.expression.expression.getText();
      if (owner === 'Array' || owner === 'Object') return null;
    }
    return chainedDbKind(node);
  }
  return null;
}

function callableName(node: ts.Node): string | null {
  if (ts.isFunctionDeclaration(node)) return propertyName(node.name);
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return propertyName(node.name);
  }
  if (ts.isConstructorDeclaration(node)) {
    const owner = node.parent;
    return ts.isClassDeclaration(owner) || ts.isClassExpression(owner) ? propertyName(owner.name) : 'constructor';
  }
  if (
    ts.isVariableDeclaration(node) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return propertyName(node.name);
  }
  if (
    (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) &&
    node.initializer &&
    (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
  ) {
    return propertyName(node.name);
  }
  if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) return propertyName(node.name);
  return null;
}

/** Every sink call plus the same-module call graph used to assign ownership. */
function scanModule(src: string, file = 'source.ts'): ModuleScan {
  const scriptKind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKind);
  const localCallables = new Set<string>();
  const localClasses = new Set<string>();
  const classMembers = new Map<string, Set<string>>();
  const lexicalEdges: Array<readonly [string, string]> = [];
  const collect = (node: ts.Node): void => {
    const name = callableName(node);
    if (name) {
      localCallables.add(name);
      let parent = node.parent;
      while (parent) {
        const lexicalOwner = callableName(parent);
        if (lexicalOwner && lexicalOwner !== name) {
          lexicalEdges.push([lexicalOwner, name]);
          break;
        }
        parent = parent.parent;
      }
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      const className = propertyName(node.name);
      if (className) {
        localClasses.add(className);
        const members = classMembers.get(className) ?? new Set<string>();
        for (const member of node.members) {
          const memberName = callableName(member);
          if (memberName && memberName !== className) members.add(memberName);
        }
        classMembers.set(className, members);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(source);

  const found: SinkSite[] = [];
  const calls = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const destinations = calls.get(from) ?? new Set<string>();
    destinations.add(to);
    calls.set(from, destinations);
  };
  for (const [className, members] of classMembers) {
    for (const member of members) link(className, member);
  }
  for (const [owner, nested] of lexicalEdges) link(owner, nested);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const owner = enclosingSymbol(node);
      // Only calls whose receiver proves same-module identity participate in
      // ownership. `helper()` is a local binding, `this.helper()` is a method
      // on the current local class, and `LocalClass.helper()` is a local static
      // method. An arbitrary `client.helper()` must not borrow a same-named
      // local helper's sink.
      const target = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression) &&
            (node.expression.expression.kind === ts.SyntaxKind.ThisKeyword ||
              (ts.isIdentifier(node.expression.expression) && localClasses.has(node.expression.expression.text)))
          ? node.expression.name.text
          : null;
      if (owner && target && target !== owner && localCallables.has(target)) link(owner, target);
      const kind = sinkKind(node);
      if (kind) {
        const position = source.getLineAndCharacterOfPosition(node.getStart(source));
        found.push({
          kind,
          symbol: owner,
          callee: node.expression.getText(source),
          line: position.line + 1,
          column: position.character + 1,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { sites: found, calls };
}

/** Every individual sink CALL, with the symbol that directly encloses it. */
export function scanSinkSites(src: string, file = 'source.ts'): SinkSite[] {
  return scanModule(src, file).sites;
}

const KINDS_FOR_SINK: Record<string, readonly string[]> = {
  'fs-write': ['fs-write'],
  'fs-delete': ['fs-delete'],
  'fs-read': ['fs-read'],
  'network-out': ['network-out'],
  db: ['db-read', 'db-write'],
  'db-read': ['db-read'],
  'db-write': ['db-write'],
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
  return new Set(scanSinkSites(src).map((site) => site.kind));
}

/** Does this file DECLARE a callable with the named semantic route symbol? */
export function declaresSymbol(src: string, name: string, file = 'source.ts'): boolean {
  const source = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let declared = false;
  const visit = (node: ts.Node): void => {
    if (declared) return;
    if (callableName(node) === name) {
      declared = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return declared;
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
 * The expansion is not a loophole, it is how tests are written: small local
 * factories commonly construct the real production subject. Refusing those
 * would downgrade genuinely proved risks. Expansion stays one level deep and
 * inside the test file, so it can only reach code the test itself already runs
 * — it can never
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
  /** relative source path -> every individual sink call found in it */
  sinks: Map<string, SinkSite[]>;
  /** relative source path -> same-module callable graph */
  calls: Map<string, Map<string, Set<string>>>;
  /** relative source path -> file contents */
  sources: Map<string, string>;
  /** exact test name -> case */
  cases: Map<string, TestCase>;
}

function realScan(roots: readonly string[]): ScanContext {
  const sinks = new Map<string, SinkSite[]>();
  const calls = new Map<string, Map<string, Set<string>>>();
  const sources = new Map<string, string>();
  for (const root of roots) {
    for (const path of sourceFiles(join(REPO_ROOT, root))) {
      const rel = relative(REPO_ROOT, path);
      const src = readFileSync(path, 'utf8');
      sources.set(rel, src);
      const scan = scanModule(src, rel);
      if (scan.sites.length) sinks.set(rel, scan.sites);
      calls.set(rel, scan.calls);
    }
  }
  return { sinks, calls, sources, cases: CASES_BY_NAME };
}

interface RouteSinkMatching {
  routeToSites: Map<number, Array<{ file: string; site: SinkSite }>>;
  unmatchedSites: Array<{ file: string; site: SinkSite }>;
}

interface UnownedSinkGroup {
  file: string;
  symbol: string | null;
  kind: string;
  sites: SinkSite[];
}

function unownedSinkGroups(matching: RouteSinkMatching): UnownedSinkGroup[] {
  const groups = new Map<string, UnownedSinkGroup>();
  for (const { file, site } of matching.unmatchedSites) {
    const key = `${file}\u0000${site.symbol ?? '<module>'}\u0000${site.kind}`;
    const group = groups.get(key) ?? { file, symbol: site.symbol, kind: site.kind, sites: [] };
    group.sites.push(site);
    groups.set(key, group);
  }
  return [...groups.values()];
}

/**
 * Bind each semantic route to the concrete sink sites it owns.
 *
 * Ownership is at (file, callable symbol, sink kind), not merely file+kind and
 * not one row per low-level syscall. A function may make several reads as one
 * semantic route. A wrapper also owns sinks reached through named same-module
 * helpers, because it is independently callable and therefore is itself a
 * boundary; unrelated functions in the same file remain unrelated.
 */
function matchRoutesToSinks(routes: readonly Route[], ctx: ScanContext): RouteSinkMatching {
  const sites = [...ctx.sinks].flatMap(([file, values]) => values.map((site) => ({ file, site })));
  const routeToSites = new Map<number, Array<{ file: string; site: SinkSite }>>();
  const covered = new Set<SinkSite>();

  const reachableSymbols = (file: string, root: string): Set<string> => {
    const graph = ctx.calls.get(file) ?? new Map<string, Set<string>>();
    const reached = new Set<string>();
    const stack = [root];
    while (stack.length > 0) {
      const symbol = stack.pop()!;
      if (reached.has(symbol)) continue;
      reached.add(symbol);
      for (const next of graph.get(symbol) ?? []) stack.push(next);
    }
    return reached;
  };

  for (const [routeIndex, route] of routes.entries()) {
    const owners = reachableSymbols(route.file, route.function);
    const owned = sites.filter(
      ({ file, site }) =>
        file === route.file &&
        site.symbol !== null &&
        owners.has(site.symbol) &&
        (KINDS_FOR_SINK[site.kind] ?? []).includes(route.kind),
    );
    if (owned.length > 0) {
      routeToSites.set(routeIndex, owned);
      for (const { site } of owned) covered.add(site);
    }
  }

  return {
    routeToSites,
    unmatchedSites: sites.filter(({ site }) => !covered.has(site)),
  };
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
  const matching = matchRoutesToSinks(reg.routes, ctx);

  const seen = new Set<string>();
  const semanticSeen = new Set<string>();
  for (const [routeIndex, route] of reg.routes.entries()) {
    if (seen.has(route.key)) say(`duplicate route key ${route.key}`);
    seen.add(route.key);

    const semanticKey = `${route.file}\u0000${route.function}\u0000${route.kind}`;
    if (semanticSeen.has(semanticKey)) {
      say(`${route.key}: duplicate semantic route (${route.file}, ${route.function}, ${route.kind})`);
    }
    semanticSeen.add(semanticKey);

    if (!reg.routeKinds.includes(route.kind)) say(`${route.key}: unknown kind ${route.kind}`);

    const src = ctx.sources.get(route.file);
    if (src === undefined) {
      say(`${route.key}: ${route.file} is not a scanned source file`);
    } else if (!declaresSymbol(src, route.function, route.file)) {
      say(`${route.key}: ${route.file} declares no symbol ${route.function}`);
    }

    // Backward completeness: the route owns a real sink of its kind, directly
    // or through a named same-module helper. A sink elsewhere in the file is
    // not evidence this route is real.
    if (src !== undefined && !matching.routeToSites.has(routeIndex)) {
      const inSymbol = (ctx.sinks.get(route.file) ?? []).filter((site) => site.symbol === route.function);
      say(
        `${route.key}: no reachable ${route.kind} sink found from ${route.function} in ${route.file}` +
          ` (direct symbol contains: ${inSymbol.map((site) => site.kind).join(', ') || 'none'})`,
      );
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

  // A deleted route is not kept as a phantom current route merely to preserve
  // history. Retirement has its own checked record: either the former symbol is
  // absent, or it remains solely as a compatibility refusal with a test that
  // calls it. In both cases the proof name and source file are real.
  const retiredSeen = new Set<string>();
  for (const retired of reg.retiredRoutes ?? []) {
    if (retiredSeen.has(retired.key)) say(`duplicate retired route key ${retired.key}`);
    retiredSeen.add(retired.key);
    if (seen.has(retired.key)) say(`${retired.key}: route is both current and retired`);
    if (!reg.routeKinds.includes(retired.formerKind)) {
      say(`${retired.key}: unknown former kind ${retired.formerKind}`);
    }
    const source = ctx.sources.get(retired.file);
    if (source === undefined) {
      say(`${retired.key}: retired source ${retired.file} is not scanned`);
      continue;
    }
    const declared = declaresSymbol(source, retired.formerFunction, retired.file);
    if (retired.disposition === 'removed' && declared) {
      say(`${retired.key}: removed symbol ${retired.formerFunction} still exists`);
    } else if (retired.disposition === 'refusal' && !declared) {
      say(`${retired.key}: refusal symbol ${retired.formerFunction} no longer exists`);
    } else if (retired.disposition !== 'removed' && retired.disposition !== 'refusal') {
      say(`${retired.key}: unknown retirement disposition ${String(retired.disposition)}`);
    }
    const proof = ctx.cases.get(retired.proofTest);
    if (!proof) {
      say(`${retired.key}: no retirement proof named "${retired.proofTest}"`);
    } else if (
      retired.disposition === 'refusal' &&
      !callsSymbol(proof.body, retired.formerFunction)
    ) {
      say(`${retired.key}: retirement proof never calls ${retired.formerFunction}`);
    }
    if (retired.reason.length < 40) say(`${retired.key}: retirement reason is not substantive`);
  }

  // Forward completeness: every concrete call site has at least one owning
  // semantic route. Reporting the
  // enclosing symbol and location makes the required registry change explicit.
  for (const group of unownedSinkGroups(matching)) {
    say(
      `unregistered semantic sink route (${group.file}, ${group.symbol ?? '<module>'}, ${group.kind}) owns ` +
        `${group.sites.length} call site(s): ${group.sites.map((site) => `${site.line}:${site.column} ${site.callee}`).join(', ')}`,
    );
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
    const matching = matchRoutesToSinks(registry.routes, ctx);
    const uncovered = unownedSinkGroups(matching).map(
      (group) => `${group.file}:${group.symbol ?? '<module>'}:${group.kind} (${group.sites.length} call site(s))`,
    );
    // No exemption list. firewall.ts used to be skipped for being the guard,
    // which let the guard set the scope of the register that governs it.
    expect(uncovered, 'sinks with no registry route').toEqual([]);
  });

  it('resolves every registered route back to a real sink of that kind', () => {
    const matching = matchRoutesToSinks(registry.routes, ctx);
    const phantom = registry.routes
      .filter((_route, index) => !matching.routeToSites.has(index))
      .map((route) => route.key);
    expect(phantom, 'routes that resolve to no sink').toEqual([]);
  });

  it('scans apps/web, not only the runner', () => {
    // The gap this revision closes: the web routes used to be hand-written and
    // were never compared against the source, so five further PostgREST calls
    // and seven filesystem readers stayed invisible. The former anonymous
    // PostgREST routes are now compatibility refusals: the source must still be
    // scanned, while contributing no sink and remaining in retiredRoutes.
    expect(registry.scanRoots).toContain('apps/web');
    const webFiles = [...ctx.sinks.keys()].filter((f) => f.startsWith('apps/web/'));
    expect(webFiles.length, 'apps/web contributed no scanned sinks').toBeGreaterThan(0);
    expect(webFiles).toContain('apps/web/lib/data.ts');
    expect(ctx.sources.has('apps/web/lib/supabase.ts')).toBe(true);
    expect(webFiles).not.toContain('apps/web/lib/supabase.ts');
    expect(
      registry.retiredRoutes?.filter((route) => route.file === 'apps/web/lib/supabase.ts'),
    ).toHaveLength(6);
    expect(registry.routes.some((r) => r.file === 'apps/web/lib/data.ts' && r.kind === 'fs-read')).toBe(true);
  });

  it('treats filesystem reads as routes, not as exempt', () => {
    // The other gap: the scanner knew writes, network and database calls only.
    expect(registry.routes.filter((r) => r.kind === 'fs-read').length).toBeGreaterThan(20);
    // Files that ONLY read had no route at all before this. dataset.ts is the
    // clearest case: it reads the bank every run scores against.
    expect(new Set(ctx.sinks.get('packages/runner/src/dataset.ts')?.map((site) => site.kind))).toEqual(
      new Set(['fs-read']),
    );
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
    // The board carries two independent risks. Its status is derived from both,
    // never hand-written on the route, and a synthetic reopening moves it.
    const board = registry.routes.find((r) => r.key === 'runner:store:leaderboard:write')!;
    expect(board.risks).toHaveLength(2);
    expect(status(board)).toBe('closed');
    expect(Object.hasOwn(board as unknown as object, 'status')).toBe(false);
    expect(
      status({
        ...board,
        risks: [{ ...board.risks[0]!, status: 'open' }, ...board.risks.slice(1)],
      }),
    ).toBe('open');
  });

  it('records every route it reopened, against a current or explicitly retired route and a real test', () => {
    // The downgrades are the finding, so they are part of the artifact rather
    // than a commit message nobody reads back.
    expect(registry.falselyClosed.length).toBeGreaterThan(0);
    for (const entry of registry.falselyClosed) {
      const route = registry.routes.find((r) => r.key === entry.route);
      const retired = (registry.retiredRoutes ?? []).find((r) => r.key === entry.route);
      expect(route ?? retired, `falselyClosed names unknown route ${entry.route}`).toBeTruthy();
      expect(CASES_BY_NAME.has(entry.citedTest), `falselyClosed cites unknown test "${entry.citedTest}"`).toBe(true);
      if (route) {
        // The claim must still hold: the old test must genuinely not call the
        // current route. A retired route instead proves its deletion above.
        const c = CASES_BY_NAME.get(entry.citedTest)!;
        expect(
          callsSymbol(c.body, route.function),
          `${entry.route}: the reopening reason is stale — "${entry.citedTest}" does call ${route.function} now`,
        ).toBe(false);
      } else {
        expect(entry.retired, `${entry.route}: retired history is not marked retired`).toBe(true);
      }
      expect(entry.reason.length, `${entry.route}: no reason given`).toBeGreaterThan(40);
    }
  });

  it('reports honest totals', () => {
    const risks = registry.routes.flatMap((r) => r.risks);
    const matching = matchRoutesToSinks(registry.routes, ctx);
    const totals = {
      routes: registry.routes.length,
      risks: risks.length,
      closedRisks: risks.filter((r) => r.status === 'closed').length,
      openRisks: risks.filter((r) => r.status === 'open').length,
      openRoutes: registry.routes.filter((r) => r.risks.some((x) => x.status === 'open')).length,
      reopened: registry.falselyClosed.length,
      scannedFilesWithSinks: ctx.sinks.size,
      sinkCallSites: [...ctx.sinks.values()].reduce((total, sites) => total + sites.length, 0),
      matchedRoutes: matching.routeToSites.size,
      phantomRoutes: registry.routes.length - matching.routeToSites.size,
      unregisteredSinkCallSites: matching.unmatchedSites.length,
      unregisteredSemanticRoutes: unownedSinkGroups(matching).length,
    };
    expect(totals.closedRisks + totals.openRisks).toBe(totals.risks);
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
  const sourceContext = (file: string, source: string): ScanContext => {
    const scan = scanModule(source, file);
    return {
      sources: new Map([[file, source]]),
      sinks: new Map([[file, scan.sites]]),
      calls: new Map([[file, scan.calls]]),
      cases: new Map(),
    };
  };

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
    expect(
      problems.some((p) => p.includes('no reachable db-write sink found from castTasteVote')),
    ).toBe(true);
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
    const missing = (kind: string, file: string) =>
      problems.some(
        (problem) =>
          problem.startsWith(`unregistered semantic sink route (${file},`) && problem.includes(`, ${kind})`),
      );
    expect(missing('fs-read', 'apps/web/lib/data.ts')).toBe(true);
    expect(missing('network-out', 'packages/runner/src/openrouter.ts')).toBe(true);
    expect(missing('fs-read', 'packages/runner/src/dataset.ts')).toBe(true);
    expect(missing('process-exec', 'packages/runner/src/derive.ts')).toBe(true);
    expect(missing('db', 'packages/runner/src/sync.ts')).toBe(true);
    // …and the enforcement layer itself, which used to be exempt outright.
    expect(missing('fs-write', 'packages/runner/src/firewall.ts')).toBe(true);
  });

  it('does not let one function route cover a same-kind sink in another function', () => {
    const file = 'fixture/two-readers.ts';
    const source = [
      `export function registered() { return readFileSync('a'); }`,
      `export function omitted() { return readFileSync('b'); }`,
    ].join('\n');
    const synthetic = sourceContext(file, source);
    const problems = validateRegistry(
      base([
        {
          key: 'fixture:registered',
          file,
          function: 'registered',
          kind: 'fs-read',
          operation: 'read a',
          risks: [
            { risk: 'historical-overwrite', severity: 'high', status: 'open', enforcementPoint: 'NOT YET', test: null },
          ],
        },
      ]),
      synthetic,
    );
    expect(problems.some((p) => p.includes('(fixture/two-readers.ts, omitted, fs-read)'))).toBe(true);
  });

  it('does not let a sinkless named route borrow another function’s sink', () => {
    const file = 'fixture/borrowed.ts';
    const source = [
      `export function claimed() { return 'no I/O'; }`,
      `export function actual() { return readFileSync('evidence'); }`,
    ].join('\n');
    const synthetic = sourceContext(file, source);
    const problems = validateRegistry(
      base([
        {
          key: 'fixture:phantom',
          file,
          function: 'claimed',
          kind: 'fs-read',
          operation: 'invented read',
          risks: [
            { risk: 'historical-overwrite', severity: 'high', status: 'open', enforcementPoint: 'NOT YET', test: null },
          ],
        },
      ]),
      synthetic,
    );
    expect(problems.some((p) => p.includes('no reachable fs-read sink found from claimed'))).toBe(true);
    expect(problems.some((p) => p.includes('(fixture/borrowed.ts, actual, fs-read)'))).toBe(true);
  });

  it('attributes a same-module helper sink to the independently callable wrapper', () => {
    const file = 'fixture/delegated.ts';
    const source = [
      `function readEvidence() { return readFileSync('evidence'); }`,
      `export function loadApproved() { return readEvidence(); }`,
    ].join('\n');
    const problems = validateRegistry(
      base([
        {
          key: 'fixture:delegated',
          file,
          function: 'loadApproved',
          kind: 'fs-read',
          operation: 'load approved evidence',
          risks: [
            { risk: 'historical-overwrite', severity: 'high', status: 'open', enforcementPoint: 'NOT YET', test: null },
          ],
        },
      ]),
      sourceContext(file, source),
    );
    expect(problems.filter((p) => p.includes('sink'))).toEqual([]);
  });

  it('does not confuse an arbitrary receiver with a same-named local helper', () => {
    const file = 'fixture/receiver-alias.ts';
    const source = [
      `function readEvidence() { return readFileSync('evidence'); }`,
      `export function claimed(client: { readEvidence(): string }) { return client.readEvidence(); }`,
    ].join('\n');
    const problems = validateRegistry(
      base([
        {
          key: 'fixture:receiver-alias',
          file,
          function: 'claimed',
          kind: 'fs-read',
          operation: 'external client read',
          risks: [
            { risk: 'historical-overwrite', severity: 'high', status: 'open', enforcementPoint: 'NOT YET', test: null },
          ],
        },
      ]),
      sourceContext(file, source),
    );
    expect(problems.some((p) => p.includes('no reachable fs-read sink found from claimed'))).toBe(true);
    expect(problems.some((p) => p.includes('(fixture/receiver-alias.ts, readEvidence, fs-read)'))).toBe(true);
  });

  it('owns nested operation methods through their factory without treating reads as writes', () => {
    const file = 'fixture/db-factory.ts';
    const source = [
      `export function makeOperations(db: any) {`,
      `  return {`,
      `    async readRows() { return db.from('rows').select('*'); },`,
      `    async writeRows(rows: unknown[]) { return db.from('rows').upsert(rows); },`,
      `  };`,
      `}`,
    ].join('\n');
    const writeOnly = validateRegistry(
      base([
        {
          key: 'fixture:db-write',
          file,
          function: 'makeOperations',
          kind: 'db-write',
          operation: 'write rows',
          risks: [
            { risk: 'historical-overwrite', severity: 'high', status: 'open', enforcementPoint: 'NOT YET', test: null },
          ],
        },
      ]),
      sourceContext(file, source),
    );
    expect(writeOnly.some((p) => p.includes('(fixture/db-factory.ts, readRows, db-read)'))).toBe(true);
    expect(writeOnly.some((p) => p.includes('(fixture/db-factory.ts, writeRows, db-write)'))).toBe(false);
  });

  it('treats several same-kind calls in one callable as one semantic route', () => {
    const file = 'fixture/two-sites.ts';
    const source = `export function loadBoth() { return [readFileSync('a'), readFileSync('b')]; }`;
    const synthetic = sourceContext(file, source);
    const problems = validateRegistry(
      base([
        {
          key: 'fixture:one-route',
          file,
          function: 'loadBoth',
          kind: 'fs-read',
          operation: 'read both',
          risks: [
            { risk: 'historical-overwrite', severity: 'high', status: 'open', enforcementPoint: 'NOT YET', test: null },
          ],
        },
      ]),
      synthetic,
    );
    expect(problems.filter((p) => p.includes('(fixture/two-sites.ts, loadBoth, fs-read)'))).toEqual([]);
    expect(problems.some((p) => p.includes('no reachable fs-read sink found from loadBoth'))).toBe(false);
  });

  it('has a scanner that is not vacuous', () => {
    // A regex that matched nothing would make forward completeness trivially
    // true, which is how a completeness check dies quietly.
    expect(scanSinks("const a = readFileSync(p, 'utf8');")).toEqual(new Set(['fs-read']));
    expect(scanSinks('writeFileSync(p, x);')).toEqual(new Set(['fs-write']));
    expect(scanSinks('await fetch(url);')).toEqual(new Set(['network-out']));
    expect(scanSinks("db.from('taste_votes').select()")).toEqual(new Set(['db-read']));
    expect(scanSinks("db.from('taste_votes').upsert(rows)")).toEqual(new Set(['db-write']));
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
    expect(callsSymbol('expect(thing.completed).toBe(true)', 'complete')).toBe(false);
    // A call at the start of a line is not a declaration.
    expect(declaresSymbol('  writeResponse({ runId });', 'writeResponse')).toBe(false);
    expect(declaresSymbol('export function writeResponse(r: X): void {', 'writeResponse')).toBe(true);
    expect(declaresSymbol('class Client { async complete() {} }', 'complete')).toBe(true);
    expect(declaresSymbol('class Client { static forCandidates(g, l) {} }', 'forCandidates')).toBe(true);
    expect(declaresSymbol('const operations = { async upsertModels(rows) {} };', 'upsertModels')).toBe(true);
    expect(declaresSymbol('const envPath = join(REPO_ROOT, ".env");', 'envPath')).toBe(false);
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
