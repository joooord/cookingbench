#!/usr/bin/env node
/**
 * RUN-001A — normalise raw audit observations into a route inventory.
 *
 * The first inventory counted OBSERVATIONS, not routes: seven auditors looking
 * at the same sink produced seven rows, so "178 routes / 134 dangerous" was an
 * overcount and the coverage percentages derived from it were meaningless.
 *
 * This collapses observations onto one stable routeId per sink, keeps every
 * observation as evidence, and assigns exactly one adjudicated disposition per
 * route. Re-runnable: `node scripts/normalise-route-inventory.mjs <journal>`.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = new URL('..', import.meta.url).pathname;
const OUT = join(REPO, 'docs/wp-0/route-inventory.json');

const RISK_TAGS = [
  'historical-overwrite',
  'unauthorised-publish',
  'budget-bypass',
  'unauthorised-inference',
  'benign',
];
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
const DISPOSITIONS = ['closed', 'open', 'no-action'];

/** Normalise a "file:line" observation to the file, since lines drift. */
function sinkOf(location) {
  const m = /^([^:]+)/.exec((location || '').trim());
  return m ? m[1] : 'unknown';
}

/**
 * A stable discriminator so one file's several sinks stay separate routes.
 *
 * NOT the line number: lines drift on every edit, and a routeId that changes
 * when you add an import is not stable. The called symbol is the durable
 * identity of a sink, so prefer the first call expression named in the
 * observation and fall back to a normalised prefix of its description.
 */
function symbolOf(what, location) {
  const calls = [...String(what).matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  const meaningful = calls.find((c) => !['join', 'resolve', 'if', 'for', 'return'].includes(c));
  if (meaningful) return meaningful;
  const named = /—\s*([A-Za-z_$][\w$]*)\(/.exec(String(what));
  if (named) return named[1];
  return String(what).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40) || sinkOf(location);
}

function routeId(sink, kind, symbol) {
  const h = createHash('sha256').update(`${sink}|${kind}|${symbol}`).digest('hex').slice(0, 8);
  return `R-${h}`;
}

/**
 * Adjudication. Each rule states the enforcement point and the test that proves
 * it, or explicitly records that the route is still open and why.
 */
function adjudicate(sink, kind, risks) {
  const t = 'packages/runner/test/firewall.test.ts';
  if (sink.startsWith('packages/core/')) {
    return { disposition: 'no-action', enforcementPoint: 'n/a — pure computation, no I/O', test: null,
      rationale: 'packages/core performs no filesystem or network I/O.' };
  }
  if (/openrouter\.ts/.test(sink)) {
    const isCatalog = risks.includes('unauthorised-inference') === false && kind === 'network-out';
    return { disposition: 'open', enforcementPoint: 'guarded client construction — NOT YET WIRED', test: null,
      capabilities: isCatalog ? ['catalog-read'] : ['candidate-inference', 'judge-inference', 'catalog-read'],
      rationale: 'Network clients are still directly constructible; requireCapability is not yet on this path.' };
  }
  if (/budget\.ts/.test(sink)) {
    return { disposition: 'open', enforcementPoint: 'atomic reservation ledger — NOT YET BUILT', test: null,
      capabilities: ['candidate-inference', 'judge-inference'],
      rationale: 'check-then-record remains; concurrent calls can still exceed the cap.' };
  }
  if (/supabase|sync|publish/i.test(sink)) {
    return { disposition: 'open', enforcementPoint: 'assertPublishable at sync/publish adapters — NOT YET WIRED', test: null,
      capabilities: ['publication', 'result-sync', 'live-db-write'],
      rationale: 'Publication paths do not yet require a validated manifest or a permit.' };
  }
  if (/taste\.ts/.test(sink)) {
    return { disposition: 'closed', enforcementPoint: "firewall.resolveOutputPath('taste', …)", test: t,
      rationale: 'Taste archive writes now resolve through the shared root-scoped guard.' };
  }
  if (/store\.ts|analyze\.ts|calibration\.ts/.test(sink)) {
    return { disposition: 'closed', enforcementPoint: 'firewall.resolveRunDir / resolveRunFile / assertSafePathComponent', test: t,
      rationale: 'Run-scoped paths are confined, identity is taken from the real path, and frozen runs refuse writes.' };
  }
  if (/apps\/web/.test(sink)) {
    return { disposition: 'open', enforcementPoint: 'web publication gate — NOT YET WIRED', test: null,
      capabilities: ['publication'],
      rationale: 'The site still selects a board heuristically rather than from an approved manifest.' };
  }
  if (risks.every((r) => r === 'benign')) {
    return { disposition: 'no-action', enforcementPoint: 'n/a', test: null,
      rationale: 'Writes only to scratch/test/gitignored paths, or pure computation.' };
  }
  return { disposition: 'open', enforcementPoint: 'unassigned', test: null,
    rationale: 'Not yet adjudicated to a specific enforcement point.' };
}

const journal = process.argv[2];
if (!journal || !existsSync(journal)) {
  console.error('usage: normalise-route-inventory.mjs <journal.jsonl>');
  process.exit(1);
}

const observations = [];
for (const line of readFileSync(journal, 'utf8').split('\n').filter(Boolean)) {
  let entry;
  try { entry = JSON.parse(line); } catch { continue; }
  if (entry.type !== 'result') continue;
  let r = entry.result;
  if (typeof r === 'string') { try { r = JSON.parse(r); } catch { continue; } }
  if (!r || !Array.isArray(r.routes)) continue;
  const auditor = (r.surface || '').split('\n')[0].slice(0, 120);
  for (const route of r.routes) {
    observations.push({
      auditor,
      agentId: entry.agentId,
      location: route.location || 'unknown',
      kind: route.kind,
      risk: route.risk,
      what: route.what || '',
      reachableFrom: route.reachableFrom || '',
      notes: route.notes || '',
    });
  }
}

const byRoute = new Map();
for (const o of observations) {
  const sink = sinkOf(o.location);
  const symbol = symbolOf(o.what, o.location);
  const id = routeId(sink, o.kind, symbol);
  if (!byRoute.has(id)) {
    byRoute.set(id, { routeId: id, sink, kind: o.kind, symbol, riskTags: new Set(), observations: [] });
  }
  const route = byRoute.get(id);
  route.riskTags.add(o.risk);
  route.observations.push(o); // untruncated
}

const routes = [...byRoute.values()].map((r) => {
  const riskTags = [...r.riskTags].sort();
  const verdict = adjudicate(r.sink, r.kind, riskTags);
  return {
    routeId: r.routeId,
    sink: r.sink,
    symbol: r.symbol,
    kind: r.kind,
    riskTags,
    capabilities: verdict.capabilities ?? [],
    disposition: verdict.disposition,
    enforcementPoint: verdict.enforcementPoint,
    test: verdict.test,
    rationale: verdict.rationale,
    sinkExists: existsSync(join(REPO, r.sink)),
    observationCount: r.observations.length,
    observations: r.observations,
  };
});

const count = (pred) => routes.filter(pred).length;
const inventory = {
  requirement: 'RUN-001A',
  schemaVersion: 2,
  generatedBy: 'scripts/normalise-route-inventory.mjs',
  baseCommit: '980dfcb5e3ff920fe1a3231121a6115e3fa48dcb',
  method:
    '4 parallel read-only inventory agents (runner/core filesystem, runner network+budget, apps/web writes, entry points) plus 3 adversarial red-team sweeps. Raw agent observations are retained per route; counts below are ROUTES, not observations.',
  vocabularies: { riskTags: RISK_TAGS, capabilities: CAPABILITIES, dispositions: DISPOSITIONS },
  identityNote:
    'routeId = sha256(sink file | kind | called symbol). Deliberately NOT line-based: line numbers drift on every edit, so a line-keyed id is not stable across refactors. This yields fewer routes than the 95 unique file:line locations in the raw observations, because several auditors reported the same sink at different lines.',
  totals: {
    routes: routes.length,
    observations: observations.length,
    dangerousRoutes: count((r) => !r.riskTags.every((t) => t === 'benign')),
    closed: count((r) => r.disposition === 'closed'),
    open: count((r) => r.disposition === 'open'),
    noAction: count((r) => r.disposition === 'no-action'),
  },
  routes: routes.sort((a, b) => a.disposition.localeCompare(b.disposition) || a.sink.localeCompare(b.sink)),
};

writeFileSync(OUT, `${JSON.stringify(inventory, null, 2)}\n`);
console.log(`${observations.length} observations -> ${routes.length} routes`);
console.log(JSON.stringify(inventory.totals, null, 2));
