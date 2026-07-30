/**
 * M4.10 / M1.10 — the specificity analyses.
 *
 * The question this module exists to answer is the only one that justifies
 * CookingBench existing at all: does a model's cooking score tell you anything
 * its general capability did not already tell you? Regress the CookingBench
 * Overall column on ONE externally defined general-capability predictor and
 * look at what is left over.
 *
 * Everything below is built to make the honest answer easy and the flattering
 * answer hard, because the flattering answer is one line of arithmetic away:
 *
 *  1. **The mapping is the whole study.** A residual is only meaningful if the
 *     predictor value really belongs to the snapshot that answered the
 *     questions. Nobody has verified that CookingBench's OpenRouter routes
 *     correspond to specific Arena snapshots — M4.10 says so explicitly — so
 *     an unevidenced or absent mapping REFUSES here rather than falling back
 *     to a plausible guess. A guessed mapping produces exactly the same shaped
 *     table as a verified one, which is what makes it dangerous.
 *  2. **Dropping the awkward models is selection.** A refusal names every
 *     unmapped route instead of quietly regressing on the ten that mapped
 *     cleanly; which models a lab publishes an Arena snapshot for is not
 *     random with respect to how good they are.
 *  3. **Residuals are never a ranking.** `residuals` is ordered by model id,
 *     deliberately, and `orderedBy` records that. Sorting a residual column
 *     descending IS ranking by it, whatever the surrounding prose says, and
 *     M4.10 forbids the ranking, not merely the word.
 *  4. **One predictor, externally preweighted.** Fourteen observations cannot
 *     support a fitted capability stack. A mapping entry carrying a second
 *     numeric column is refused at parse time.
 *
 * The confirmatory incremental-validity path is deliberately NOT implemented
 * as an estimator — see `assessIncrementalValidity`. It needs a predictor
 * frozen before inference and a culinary criterion that was not used to build
 * the benchmark, and neither exists.
 */

// Relative rather than `@cookingbench/core`, matching analyze.ts: the package's
// `exports` map exposes only `.` and index.ts does not re-export stats.ts yet.
// Becomes a package import the moment it does.
import { fnv1a32, seededUniform } from '../../core/src/stats.js';

export class SpecificityError extends Error {
  constructor(
    message: string,
    readonly code: SpecificityRefusalCode,
  ) {
    super(message);
    this.name = 'SpecificityError';
  }
}

export type SpecificityRefusalCode =
  | 'PREDICTOR_INVALID'
  | 'MULTIPLE_PREDICTORS'
  | 'MAPPING_MISSING'
  | 'MAPPING_UNVERIFIED'
  | 'MAPPING_DUPLICATE'
  | 'PREDICTOR_DEGENERATE'
  | 'OUTCOME_DEGENERATE'
  | 'INSUFFICIENT_MODELS';

/**
 * The only permitted label for the residual column (M4.10). Exported so a
 * report cannot invent a shorter, friendlier one — "cooking-specific ability"
 * is the phrase this constant exists to keep out of the site.
 */
export const RESIDUAL_LABEL = 'general-score-adjusted CookingBench residual';

/** Printed beside every residual table. Not decoration; it is the claim limit. */
export const RESIDUAL_DISCLAIMER =
  'Descriptive only. Not a ranking, not culinary ability, and not evidence that CookingBench measures anything beyond general capability.';

/* -------------------------------------------------------------------------- */
/* The predictor document                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `verified` demands a named human and a date. `asserted` is what an
 * unreviewed "this route is probably that snapshot" note is worth, and it is
 * treated as no evidence at all — the distinction between the two is the
 * entire content of M4.10's first bullet.
 */
export type MappingEvidenceStatus = 'verified' | 'asserted' | 'absent';

export interface SnapshotMapping {
  /** OpenRouter route, exactly as it appears in the run's scores. */
  route: string;
  /** The external provider's snapshot identifier, verbatim. */
  snapshot: string;
  /** The single predictor value for that snapshot. */
  value: number;
  /** Data vintage of the value (ISO date). Not the date it was copied here. */
  vintage: string;
  evidence: {
    status: MappingEvidenceStatus;
    /** Where route == snapshot was established. A URL, a ticket, a filing. */
    source: string;
    /** Required when status is 'verified'. A verification with no verifier is a claim. */
    verifiedBy?: string;
    verifiedAt?: string;
  };
}

export interface GeneralPredictorDocument {
  predictorId: string;
  predictorName: string;
  /** The external authority that defined and weighted it. */
  publishedBy: string;
  /**
   * Declared, not inferred. A lower-is-better metric silently inverts every
   * residual sign, and nothing downstream would look wrong.
   */
  direction: 'higher-is-better' | 'lower-is-better';
  /** When the predictor definition and values were frozen (ISO date-time). */
  frozenAt: string;
  mappings: SnapshotMapping[];
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new SpecificityError(
      `Predictor document: '${field}' must be a non-empty string.`,
      'PREDICTOR_INVALID',
    );
  }
  return value;
}

function requireIsoDate(value: unknown, field: string): string {
  const s = requireString(value, field);
  // Refuse anything Date.parse merely tolerates. "2026" parses; "Q2 2026" does
  // not, and a vintage that cannot be compared cannot be checked for drift.
  if (!/^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/.test(s) || Number.isNaN(Date.parse(s))) {
    throw new SpecificityError(
      `Predictor document: '${field}' must be an ISO date (got ${JSON.stringify(s)}).`,
      'PREDICTOR_INVALID',
    );
  }
  return s;
}

/** Fields a mapping is allowed to carry. Anything else numeric is a second predictor. */
const MAPPING_KNOWN_KEYS = new Set(['route', 'snapshot', 'value', 'vintage', 'evidence', 'note']);

/**
 * Parse and validate a predictor document. Throws on anything it cannot fully
 * understand; there is no lenient mode.
 *
 * The multi-column check is the interesting one. M1.10 permits "at most one
 * externally defined, preweighted general-capability proxy", and the natural
 * way to violate that is not a second document — it is a mapping row carrying
 * `arenaElo`, `mmlu` and `gpqa` side by side, followed by a regression on all
 * three. Fourteen observations, three predictors and a free intercept is four
 * parameters on fourteen points; it will fit, and it will mean nothing.
 */
export function parseGeneralPredictorDocument(input: unknown): GeneralPredictorDocument {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new SpecificityError('Predictor document must be an object.', 'PREDICTOR_INVALID');
  }
  const doc = input as Record<string, unknown>;
  const direction = requireString(doc.direction, 'direction');
  if (direction !== 'higher-is-better' && direction !== 'lower-is-better') {
    throw new SpecificityError(
      `Predictor document: 'direction' must be 'higher-is-better' or 'lower-is-better'.`,
      'PREDICTOR_INVALID',
    );
  }
  if (!Array.isArray(doc.mappings) || doc.mappings.length === 0) {
    throw new SpecificityError(
      `Predictor document: 'mappings' must be a non-empty array.`,
      'PREDICTOR_INVALID',
    );
  }

  const seen = new Set<string>();
  const mappings: SnapshotMapping[] = doc.mappings.map((raw, i) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new SpecificityError(`Predictor document: mappings[${i}] must be an object.`, 'PREDICTOR_INVALID');
    }
    const m = raw as Record<string, unknown>;
    for (const [key, v] of Object.entries(m)) {
      if (!MAPPING_KNOWN_KEYS.has(key) && typeof v === 'number') {
        throw new SpecificityError(
          `Predictor document: mappings[${i}] carries a second numeric column '${key}'. ` +
            `M1.10 permits exactly one externally preweighted predictor; a capability stack fitted to 14 observations is not identifiable.`,
          'MULTIPLE_PREDICTORS',
        );
      }
    }
    const route = requireString(m.route, `mappings[${i}].route`);
    if (seen.has(route)) {
      throw new SpecificityError(
        `Predictor document: route ${route} mapped twice. Which snapshot answered the questions is then undefined.`,
        'MAPPING_DUPLICATE',
      );
    }
    seen.add(route);
    if (typeof m.value !== 'number' || !Number.isFinite(m.value)) {
      throw new SpecificityError(
        `Predictor document: mappings[${i}].value must be a finite number.`,
        'PREDICTOR_INVALID',
      );
    }
    const ev = m.evidence;
    if (typeof ev !== 'object' || ev === null || Array.isArray(ev)) {
      throw new SpecificityError(
        `Predictor document: mappings[${i}] has no evidence block. An unevidenced mapping is the failure mode M4.10 names.`,
        'PREDICTOR_INVALID',
      );
    }
    const evidence = ev as Record<string, unknown>;
    const status = requireString(evidence.status, `mappings[${i}].evidence.status`);
    if (status !== 'verified' && status !== 'asserted' && status !== 'absent') {
      throw new SpecificityError(
        `Predictor document: mappings[${i}].evidence.status must be verified | asserted | absent.`,
        'PREDICTOR_INVALID',
      );
    }
    if (status === 'verified') {
      // A "verified" flag with nobody's name on it is an assertion wearing a
      // better word. Demote-by-throwing rather than silently accepting it.
      requireString(evidence.verifiedBy, `mappings[${i}].evidence.verifiedBy`);
      requireIsoDate(evidence.verifiedAt, `mappings[${i}].evidence.verifiedAt`);
    }
    return {
      route,
      snapshot: requireString(m.snapshot, `mappings[${i}].snapshot`),
      value: m.value,
      vintage: requireIsoDate(m.vintage, `mappings[${i}].vintage`),
      evidence: {
        status: status as MappingEvidenceStatus,
        source: requireString(evidence.source, `mappings[${i}].evidence.source`),
        ...(typeof evidence.verifiedBy === 'string' ? { verifiedBy: evidence.verifiedBy } : {}),
        ...(typeof evidence.verifiedAt === 'string' ? { verifiedAt: evidence.verifiedAt } : {}),
      },
    };
  });

  return {
    predictorId: requireString(doc.predictorId, 'predictorId'),
    predictorName: requireString(doc.predictorName, 'predictorName'),
    publishedBy: requireString(doc.publishedBy, 'publishedBy'),
    direction: direction as GeneralPredictorDocument['direction'],
    frozenAt: requireIsoDate(doc.frozenAt, 'frozenAt'),
    mappings,
  };
}

/* -------------------------------------------------------------------------- */
/* Review triggers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Every threshold here is a REVIEW TRIGGER, not a scientific constant — the
 * master plan says the same of its own numbers. They decide whether the
 * analysis is flagged for omission, never whether a claim is true.
 */
/** Below this many mapped models a two-parameter fit is not worth reporting. */
const MIN_MODELS = 8;
/** Predictor spread below this (in its own units) makes the slope arbitrary. */
const MIN_PREDICTOR_SD = 1e-9;
/** Outcome spread below this (score points) means every residual is rounding. */
const MIN_OUTCOME_SD = 0.5;
/**
 * Mean CI half-width ÷ between-model SD. At 1.0 the typical model's own
 * uncertainty covers the whole roster spread, so residuals are measurement
 * noise wearing a model's name. Run 2026-07-v2.1 sits at 1.05 (mean half-width
 * 3.58 points against an SD of 3.42) — which is precisely why this module's
 * first real output is expected to be an omission recommendation.
 */
const MAX_UNCERTAINTY_RATIO = 0.6;
/** Predictor values gathered more than this far apart are not one vintage. */
const MAX_VINTAGE_SPREAD_DAYS = 120;
/** One provider holding more than this share makes the fit a provider effect. */
const MAX_CLUSTER_SHARE = 0.4;
/** Share of degenerate cluster-bootstrap draws above which no interval is reported. */
const MAX_DEGENERATE_DRAW_SHARE = 0.05;

const DEFAULT_REPS = 4000;

/* -------------------------------------------------------------------------- */
/* Inputs and results                                                         */
/* -------------------------------------------------------------------------- */

export interface OutcomeRow {
  modelId: string;
  /** Absolute CookingBench performance. Reported in full, separately (M1.10). */
  overall: number;
  /** The board's marginal interval, used only for the uncertainty diagnostic. */
  ci95?: [number, number];
  /** Defaults to the OpenRouter route prefix, which really is the provider. */
  provider?: string;
}

export interface SpecificityInput {
  runId: string;
  outcomes: OutcomeRow[];
  predictor: GeneralPredictorDocument;
  /**
   * Models the analysis claims to cover. Defaults to every model with an
   * outcome. Present so a narrowed scope has to be stated up front rather
   * than emerging from whichever mappings happened to verify.
   */
  scope?: string[];
  /** When candidate inference began, for the frozen-before-inference note. */
  inferenceStartedAt?: string;
  seed?: string;
  reps?: number;
}

export interface SpecificityRefusal {
  code: SpecificityRefusalCode;
  message: string;
  /** Routes responsible, so the fix is mechanical. */
  routes?: string[];
}

export interface ResidualRow {
  modelId: string;
  provider: string;
  snapshot: string;
  predictorValue: number;
  overall: number;
  fitted: number;
  /** overall − fitted. The quantity M4.10 allows to be reported, and only descriptively. */
  residual: number;
  /** Standard error of THIS residual (s·√(1−h_i)), so its size can be judged. */
  residualSe: number;
  /** |residual| ≤ 2·se. True for a model that is exactly where its general score puts it. */
  withinNoise: boolean;
  /** Hat value. A high-leverage model drags the line it is then judged against. */
  leverage: number;
}

export interface AssociationSummary {
  slope: number;
  intercept: number;
  pearsonR: number;
  /** Share of CookingBench variance the general predictor already explains. */
  r2: number;
  residualSd: number;
  /** Provider-cluster bootstrap interval on the slope, or null when refused. */
  slopeCi: [number, number] | null;
  r2Ci: [number, number] | null;
  /** Draws discarded because the resampled predictor had no spread. */
  degenerateDraws: number;
  reps: number;
  intervalRefusal: string | null;
}

export interface SpecificityDiagnostics {
  models: number;
  providerClusters: number;
  largestClusterShare: number;
  outcomeSd: number;
  predictorSd: number;
  /** Mean CI half-width ÷ outcome SD, when the board supplied intervals. */
  uncertaintyRatio: number | null;
  vintageSpreadDays: number;
  maxLeverage: number;
  /** Null when inference timing was not supplied — unknown, not "yes". */
  predictorFrozenBeforeInference: boolean | null;
}

export interface SpecificityAnalysis {
  status: 'descriptive';
  label: typeof RESIDUAL_LABEL;
  disclaimer: typeof RESIDUAL_DISCLAIMER;
  /** Structural, not stylistic: residuals are emitted in model-id order. */
  orderedBy: 'modelId';
  ranked: false;
  runId: string;
  predictor: {
    id: string;
    name: string;
    publishedBy: string;
    direction: GeneralPredictorDocument['direction'];
    frozenAt: string;
  };
  /** Reported separately from the association and the residuals (M1.10). */
  absolute: Array<{ modelId: string; overall: number; ci95?: [number, number] }>;
  association: AssociationSummary;
  residuals: ResidualRow[];
  diagnostics: SpecificityDiagnostics;
  caveats: string[];
  /** True when mapping or measurement uncertainty makes publication misleading. */
  omissionRecommended: boolean;
  omissionReasons: string[];
}

export interface SpecificityRefused {
  status: 'refused';
  runId: string;
  refusals: SpecificityRefusal[];
}

export type SpecificityResult = SpecificityAnalysis | SpecificityRefused;

/* -------------------------------------------------------------------------- */
/* The analysis                                                               */
/* -------------------------------------------------------------------------- */

function providerOf(row: OutcomeRow): string {
  if (row.provider && row.provider.trim() !== '') return row.provider;
  const slash = row.modelId.indexOf('/');
  // On OpenRouter the prefix IS the provider, so this is evidence rather than
  // a guess. A route with no prefix gets its own cluster of one, which is the
  // conservative direction: it can only make the clustering look worse.
  return slash > 0 ? row.modelId.slice(0, slash) : row.modelId;
}

function mean(v: readonly number[]): number {
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function sd(v: readonly number[]): number {
  const m = mean(v);
  return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
}

function fitLine(x: readonly number[], y: readonly number[]): { slope: number; intercept: number } | null {
  const mx = mean(x);
  const my = mean(y);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < x.length; i++) {
    sxx += (x[i]! - mx) ** 2;
    sxy += (x[i]! - mx) * (y[i]! - my);
  }
  if (sxx <= MIN_PREDICTOR_SD) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx };
}

function pearson(x: readonly number[], y: readonly number[]): number {
  const mx = mean(x);
  const my = mean(y);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    sxy += (x[i]! - mx) * (y[i]! - my);
    sxx += (x[i]! - mx) ** 2;
    syy += (y[i]! - my) ** 2;
  }
  return sxx <= 0 || syy <= 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

function dayDiff(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

/**
 * The archived descriptive analysis.
 *
 * Returns a refusal object rather than throwing for POLICY failures (missing
 * or unverified mappings, a degenerate fit): those are expected outcomes with
 * a fix attached, and a caller that wants a report should be able to print
 * the reasons. Malformed input still throws, from the parser.
 */
export function specificityAnalysis(input: SpecificityInput): SpecificityResult {
  const refusals: SpecificityRefusal[] = [];
  const scope = input.scope ?? input.outcomes.map((o) => o.modelId);
  const scopeSet = new Set(scope);
  const outcomeById = new Map(input.outcomes.map((o) => [o.modelId, o]));
  const mappingByRoute = new Map(input.predictor.mappings.map((m) => [m.route, m]));

  const duplicateOutcomes = input.outcomes
    .map((o) => o.modelId)
    .filter((id, i, all) => all.indexOf(id) !== i);
  if (duplicateOutcomes.length > 0) {
    // A Map would silently keep the last row, so a run listed twice under two
    // scores would quietly regress on whichever happened to be second.
    refusals.push({
      code: 'PREDICTOR_INVALID',
      message: 'The same model appears twice in the outcomes.',
      routes: [...new Set(duplicateOutcomes)],
    });
  }

  const missingOutcome = scope.filter((m) => !outcomeById.has(m));
  if (missingOutcome.length > 0) {
    refusals.push({
      code: 'MAPPING_MISSING',
      message: `No CookingBench outcome for ${missingOutcome.length} model(s) named in scope.`,
      routes: missingOutcome,
    });
  }

  const unmapped: string[] = [];
  const unverified: string[] = [];
  for (const modelId of scope) {
    const m = mappingByRoute.get(modelId);
    if (!m) {
      unmapped.push(modelId);
    } else if (m.evidence.status !== 'verified') {
      unverified.push(`${modelId} (${m.evidence.status})`);
    }
  }
  if (unmapped.length > 0) {
    refusals.push({
      code: 'MAPPING_MISSING',
      message:
        `${unmapped.length} model(s) in scope have no snapshot mapping. ` +
        `Regressing on the remainder would select models on the predictor: which routes a lab publishes an external snapshot for is not random with respect to capability.`,
      routes: unmapped,
    });
  }
  if (unverified.length > 0) {
    refusals.push({
      code: 'MAPPING_UNVERIFIED',
      message:
        `${unverified.length} mapping(s) are asserted rather than verified. ` +
        `M4.10 permits this analysis only on exact, evidenced model-snapshot mappings; a guessed mapping produces an identically shaped table to a correct one.`,
      routes: unverified,
    });
  }
  if (refusals.length > 0) return { status: 'refused', runId: input.runId, refusals };

  const rows = scope
    .map((modelId) => ({ outcome: outcomeById.get(modelId)!, mapping: mappingByRoute.get(modelId)! }))
    .sort((a, b) => a.outcome.modelId.localeCompare(b.outcome.modelId));

  if (rows.length < MIN_MODELS) {
    return {
      status: 'refused',
      runId: input.runId,
      refusals: [
        {
          code: 'INSUFFICIENT_MODELS',
          message: `${rows.length} mapped model(s); at least ${MIN_MODELS} are needed before a two-parameter fit is worth reporting.`,
        },
      ],
    };
  }

  // A lower-is-better predictor is negated once, here, so that every slope,
  // correlation and residual sign downstream reads the same way regardless of
  // which external metric was supplied.
  const orient = input.predictor.direction === 'higher-is-better' ? 1 : -1;
  const x = rows.map((r) => orient * r.mapping.value);
  const y = rows.map((r) => r.outcome.overall);

  const predictorSd = sd(x);
  const outcomeSd = sd(y);
  if (predictorSd <= MIN_PREDICTOR_SD) {
    return {
      status: 'refused',
      runId: input.runId,
      refusals: [
        {
          code: 'PREDICTOR_DEGENERATE',
          message: 'The general predictor has no spread across the mapped models; the fitted line is arbitrary.',
        },
      ],
    };
  }
  if (outcomeSd < MIN_OUTCOME_SD) {
    return {
      status: 'refused',
      runId: input.runId,
      refusals: [
        {
          code: 'OUTCOME_DEGENERATE',
          message:
            `CookingBench Overall varies by ${outcomeSd.toFixed(2)} points across the mapped models. ` +
            `On a saturated board every residual is grader rounding, not culinary over-performance.`,
        },
      ],
    };
  }

  const fit = fitLine(x, y)!;
  const fitted = x.map((v) => fit.intercept + fit.slope * v);
  const resid = y.map((v, i) => v - fitted[i]!);
  const r = pearson(x, y);
  // n − 2: the line consumed two degrees of freedom.
  const rss = resid.reduce((a, b) => a + b * b, 0);
  const s = Math.sqrt(rss / (rows.length - 2));
  const mx = mean(x);
  const sxx = x.reduce((a, v) => a + (v - mx) ** 2, 0);

  const providers = rows.map((row) => providerOf(row.outcome));
  const clusterCounts = new Map<string, number>();
  for (const p of providers) clusterCounts.set(p, (clusterCounts.get(p) ?? 0) + 1);
  const largestClusterShare = Math.max(...clusterCounts.values()) / rows.length;

  const interval = clusterBootstrapFit(
    x,
    y,
    providers,
    input.seed ?? `specificity:${input.runId}:${input.predictor.predictorId}`,
    input.reps ?? DEFAULT_REPS,
  );

  const residuals: ResidualRow[] = rows.map((row, i) => {
    const leverage = 1 / rows.length + (x[i]! - mx) ** 2 / sxx;
    // s·√(1−h_i): a model near the ends of the predictor range pulls the line
    // towards itself, so its residual is shrunk and looks reassuringly small.
    const residualSe = s * Math.sqrt(Math.max(0, 1 - leverage));
    return {
      modelId: row.outcome.modelId,
      provider: providers[i]!,
      snapshot: row.mapping.snapshot,
      predictorValue: row.mapping.value,
      overall: row.outcome.overall,
      fitted: round(fitted[i]!, 3),
      residual: round(resid[i]!, 3),
      residualSe: round(residualSe, 3),
      // Two standard errors, deliberately approximate. A t-quantile here would
      // dress a descriptive quantity as an inferential one, and the analysis is
      // not entitled to that; the flag exists to stop a reader treating a
      // 0.4-point residual as a finding.
      withinNoise: Math.abs(resid[i]!) <= 2 * residualSe,
      leverage: round(leverage, 4),
    };
  });

  const halfWidths = rows
    .map((row) => row.outcome.ci95)
    .filter((c): c is [number, number] => Array.isArray(c) && c.length === 2)
    .map((c) => (c[1] - c[0]) / 2);
  const uncertaintyRatio =
    halfWidths.length === rows.length && outcomeSd > 0 ? mean(halfWidths) / outcomeSd : null;

  const vintages = rows.map((row) => row.mapping.vintage).sort();
  const vintageSpreadDays = dayDiff(vintages[0]!, vintages[vintages.length - 1]!);

  const frozenBefore =
    input.inferenceStartedAt === undefined
      ? null
      : Date.parse(input.predictor.frozenAt) < Date.parse(input.inferenceStartedAt);

  const caveats: string[] = [
    'The route → snapshot mapping is the load-bearing assumption; every residual inherits its errors.',
    `${rows.length} provider-clustered observations over ${clusterCounts.size} lab(s) cannot separate a lab effect from a cooking effect.`,
    'Residuals are reported in model-id order because sorting them is ranking them.',
  ];
  const omissionReasons: string[] = [];

  const excluded = input.outcomes.map((o) => o.modelId).filter((id) => !scopeSet.has(id));
  if (excluded.length > 0) {
    // A narrowed scope is declared rather than emergent, which is the point of
    // the parameter — but it is still selection, and the models most likely to
    // be dropped are the ones with no published external snapshot. Naming them
    // is the minimum; recommending omission is the honest reading of M4.10's
    // "may be omitted entirely if mapping uncertainty makes it misleading".
    caveats.push(`Scope excludes ${excluded.length} model(s) with CookingBench outcomes: ${excluded.join(', ')}.`);
    omissionReasons.push(
      `${excluded.length} model(s) with CookingBench scores are outside the analysed scope; the fit describes a selected subset of the roster.`,
    );
  }

  if (uncertaintyRatio !== null && uncertaintyRatio > MAX_UNCERTAINTY_RATIO) {
    omissionReasons.push(
      `Mean per-model CI half-width is ${(uncertaintyRatio * 100).toFixed(0)}% of the between-model SD; residuals would mostly be measurement noise.`,
    );
  }
  if (uncertaintyRatio === null) {
    caveats.push('Not every model supplied a CookingBench interval, so residual size could not be compared against measurement noise.');
  }
  if (vintageSpreadDays > MAX_VINTAGE_SPREAD_DAYS) {
    omissionReasons.push(
      `Predictor values span ${Math.round(vintageSpreadDays)} days of vintage; that is several external metrics, not one.`,
    );
  }
  if (largestClusterShare > MAX_CLUSTER_SHARE) {
    omissionReasons.push(
      `One provider supplies ${(largestClusterShare * 100).toFixed(0)}% of the observations; the fit would largely describe that lab.`,
    );
  }
  if (interval.refusal !== null) {
    caveats.push(`No interval on the slope: ${interval.refusal}`);
  }
  if (frozenBefore === false) {
    caveats.push(
      'The predictor was frozen after candidate inference began, so this can never be upgraded to a confirmatory result on this run.',
    );
  }

  return {
    status: 'descriptive',
    label: RESIDUAL_LABEL,
    disclaimer: RESIDUAL_DISCLAIMER,
    orderedBy: 'modelId',
    ranked: false,
    runId: input.runId,
    predictor: {
      id: input.predictor.predictorId,
      name: input.predictor.predictorName,
      publishedBy: input.predictor.publishedBy,
      direction: input.predictor.direction,
      frozenAt: input.predictor.frozenAt,
    },
    absolute: rows.map((row) => ({
      modelId: row.outcome.modelId,
      overall: row.outcome.overall,
      ...(row.outcome.ci95 ? { ci95: row.outcome.ci95 } : {}),
    })),
    association: {
      slope: round(fit.slope, 5),
      intercept: round(fit.intercept, 3),
      pearsonR: round(r, 4),
      r2: round(r * r, 4),
      residualSd: round(s, 3),
      slopeCi: interval.slopeCi,
      r2Ci: interval.r2Ci,
      degenerateDraws: interval.degenerateDraws,
      reps: interval.reps,
      intervalRefusal: interval.refusal,
    },
    residuals,
    diagnostics: {
      models: rows.length,
      providerClusters: clusterCounts.size,
      largestClusterShare: round(largestClusterShare, 3),
      outcomeSd: round(outcomeSd, 3),
      predictorSd: round(predictorSd, 3),
      uncertaintyRatio: uncertaintyRatio === null ? null : round(uncertaintyRatio, 3),
      vintageSpreadDays: Math.round(vintageSpreadDays),
      maxLeverage: round(Math.max(...residuals.map((row) => row.leverage)), 4),
      predictorFrozenBeforeInference: frozenBefore,
    },
    caveats,
    omissionRecommended: omissionReasons.length > 0,
    omissionReasons,
  };
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * Cluster bootstrap by provider for the slope and R².
 *
 * Provider, not model: three Anthropic snapshots share a training pipeline and
 * a house style, so resampling them independently pretends there are fourteen
 * pieces of evidence when there are nine at best.
 *
 * A resample can draw the same provider repeatedly and end up with no
 * predictor spread. Those draws are counted and discarded rather than
 * substituted with a slope of zero — silently mixing degenerate draws into the
 * distribution pulls every interval towards nothing and would make a
 * badly-clustered roster look better behaved than a well-spread one.
 */
function clusterBootstrapFit(
  x: readonly number[],
  y: readonly number[],
  clusters: readonly string[],
  seed: string,
  reps: number,
): { slopeCi: [number, number] | null; r2Ci: [number, number] | null; degenerateDraws: number; reps: number; refusal: string | null } {
  const byCluster = new Map<string, number[]>();
  clusters.forEach((c, i) => {
    let bucket = byCluster.get(c);
    if (!bucket) byCluster.set(c, (bucket = []));
    bucket.push(i);
  });
  const keys = [...byCluster.keys()].sort();
  if (keys.length < 3) {
    return {
      slopeCi: null,
      r2Ci: null,
      degenerateDraws: 0,
      reps: 0,
      refusal: `${keys.length} provider cluster(s); resampling that few reproduces the sample rather than describing its uncertainty.`,
    };
  }

  const rnd = seededUniform(fnv1a32(seed));
  const slopes: number[] = [];
  const r2s: number[] = [];
  let degenerate = 0;
  for (let rep = 0; rep < reps; rep++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (let k = 0; k < keys.length; k++) {
      for (const i of byCluster.get(keys[(rnd() * keys.length) | 0]!)!) {
        xs.push(x[i]!);
        ys.push(y[i]!);
      }
    }
    const f = fitLine(xs, ys);
    if (!f) {
      degenerate++;
      continue;
    }
    slopes.push(f.slope);
    const rr = pearson(xs, ys);
    r2s.push(rr * rr);
  }
  const share = degenerate / reps;
  if (share > MAX_DEGENERATE_DRAW_SHARE) {
    return {
      slopeCi: null,
      r2Ci: null,
      degenerateDraws: degenerate,
      reps,
      refusal: `${(share * 100).toFixed(1)}% of resamples had no predictor spread; the clustering is too coarse for an interval.`,
    };
  }
  const pct = (v: number[], q: number): number => {
    const sorted = [...v].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
  };
  return {
    slopeCi: [round(pct(slopes, 0.025), 5), round(pct(slopes, 0.975), 5)],
    r2Ci: [round(pct(r2s, 0.025), 4), round(pct(r2s, 0.975), 4)],
    degenerateDraws: degenerate,
    reps,
    refusal: null,
  };
}

/* -------------------------------------------------------------------------- */
/* Confirmatory incremental validity — deliberately not an estimator          */
/* -------------------------------------------------------------------------- */

export interface FrozenPredictorDeclaration {
  predictorId: string;
  /** Hash of the frozen predictor values, so "frozen" is checkable. */
  contentHash: string;
  frozenAt: string;
}

export interface CulinaryCriterionDeclaration {
  criterionId: string;
  /** Expert panel, Kitchen Outcome trial, or another untouched source. */
  source: string;
  /** Each of these being false is what "untouched" means. */
  usedInAuthoring: boolean;
  usedInSelection: boolean;
  usedInWeighting: boolean;
  usedInTuning: boolean;
  /** Number of independent units in the criterion. */
  units: number;
  frozenAt: string;
}

export interface IncrementalValidityInputs {
  predictor?: FrozenPredictorDeclaration;
  criterion?: CulinaryCriterionDeclaration;
  /** When the run's first candidate call was made. */
  inferenceStartedAt?: string;
  /** Declared cross-validation design; the claim needs out-of-sample prediction. */
  crossValidation?: { folds: number; repeats: number; preregistrationId?: string };
}

export interface IncrementalValidityStatus {
  /** Whether the preconditions for even attempting the study are met. */
  eligible: boolean;
  /**
   * Always false in this build. Eligibility is not a result: no estimator is
   * implemented, on purpose (see below).
   */
  claimPermitted: false;
  blockers: string[];
  /** What the study must do once the preconditions exist. */
  requiredProcedure: string[];
}

/**
 * The confirmatory path, kept as a GATE rather than a calculator.
 *
 * There is no incremental-validity estimator in this module, and that is a
 * decision rather than an omission. The only culinary criterion in existence
 * here is the benchmark's own scores, which were used to author, select and
 * tune the items; fitting a cross-validated model against them would produce a
 * number, and the number would be a measure of how hard the authors had
 * already fitted the dataset. Building the estimator before the criterion is
 * frozen invites exactly that — the only data available to test it on is the
 * data it must not be tuned to.
 *
 * So this reports what is missing. When a frozen predictor and an untouched
 * criterion exist, `eligible` turns true, `claimPermitted` stays false, and
 * somebody writes the estimator against a preregistered analysis plan.
 */
export function assessIncrementalValidity(
  inputs: IncrementalValidityInputs = {},
): IncrementalValidityStatus {
  const blockers: string[] = [];

  if (!inputs.predictor) {
    blockers.push('No frozen general-capability predictor declared (M4.10 requires freezing it before candidate inference).');
  } else if (inputs.inferenceStartedAt === undefined) {
    // Unknown timing is not "probably fine". A predictor chosen after seeing
    // which models did well is the failure this precondition exists to catch,
    // and it is invisible from the values alone.
    blockers.push('Candidate inference start time unknown, so the predictor freeze cannot be shown to precede it.');
  } else if (Date.parse(inputs.predictor.frozenAt) >= Date.parse(inputs.inferenceStartedAt)) {
    blockers.push(
      `Predictor frozen at ${inputs.predictor.frozenAt}, at or after inference began at ${inputs.inferenceStartedAt}.`,
    );
  }

  const c = inputs.criterion;
  if (!c) {
    blockers.push('No untouched culinary-expert or Kitchen Outcome criterion declared.');
  } else {
    const touched = (
      [
        ['authoring', c.usedInAuthoring],
        ['selection', c.usedInSelection],
        ['weighting', c.usedInWeighting],
        ['tuning', c.usedInTuning],
      ] as const
    )
      .filter(([, used]) => used)
      .map(([what]) => what);
    if (touched.length > 0) {
      blockers.push(
        `Criterion ${c.criterionId} was used in ${touched.join(', ')}; it cannot then test whether the benchmark predicts it.`,
      );
    }
    if (!Number.isFinite(c.units) || c.units < MIN_MODELS) {
      blockers.push(
        `Criterion ${c.criterionId} has ${c.units} unit(s); cross-validated incremental prediction needs more than the ${MIN_MODELS} the descriptive fit already refuses below.`,
      );
    }
  }

  if (!inputs.crossValidation) {
    blockers.push('No cross-validation design declared; low correlation with a general score is not by itself a specificity claim.');
  } else if (!inputs.crossValidation.preregistrationId) {
    blockers.push('Cross-validation design is not preregistered, so fold choice remains a researcher degree of freedom.');
  }

  return {
    eligible: blockers.length === 0,
    claimPermitted: false,
    blockers,
    requiredProcedure: [
      'Report absolute CookingBench performance, shared general-capability variance and incremental prediction separately.',
      'Predict the untouched criterion from the frozen general predictor alone, then from predictor + CookingBench.',
      'Compare out-of-sample error across the preregistered folds; in-sample R² gain is not incremental validity.',
      'Cluster folds by provider family so a lab effect cannot be read as culinary information.',
      'Publish the null result with the same prominence as a positive one.',
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Reporting                                                                  */
/* -------------------------------------------------------------------------- */

/** Plain-text report. Leads with the limits, because the table is persuasive. */
export function formatSpecificityReport(result: SpecificityResult): string {
  const lines: string[] = [];
  if (result.status === 'refused') {
    lines.push(`Specificity analysis REFUSED for run ${result.runId}.`);
    for (const r of result.refusals) {
      lines.push(`  [${r.code}] ${r.message}`);
      if (r.routes?.length) lines.push(`      ${r.routes.join(', ')}`);
    }
    lines.push('No residual table is produced. This is the intended outcome of an unverified mapping.');
    return lines.join('\n');
  }

  lines.push(`${RESIDUAL_LABEL} — run ${result.runId}`);
  lines.push(RESIDUAL_DISCLAIMER);
  if (result.omissionRecommended) {
    lines.push('OMISSION RECOMMENDED — publishing this table would mislead:');
    for (const reason of result.omissionReasons) lines.push(`  • ${reason}`);
  }
  // Absolute performance first, association second, residuals last: M1.10 asks
  // for the three to be reported separately, and this is the order in which
  // each is least likely to be mistaken for the next.
  lines.push('Absolute CookingBench performance:');
  for (const row of result.absolute) {
    lines.push(
      `  ${row.modelId.padEnd(32)} ${row.overall.toFixed(1)}` +
        (row.ci95 ? ` [${row.ci95[0].toFixed(1)}, ${row.ci95[1].toFixed(1)}]` : ''),
    );
  }
  const a = result.association;
  lines.push(
    `Association: r = ${a.pearsonR.toFixed(3)}, R² = ${a.r2.toFixed(3)} (the share of CookingBench spread the general score already explains).`,
  );
  lines.push(
    a.slopeCi
      ? `Slope ${a.slope} [${a.slopeCi[0]}, ${a.slopeCi[1]}] (provider-clustered bootstrap, ${a.reps} reps).`
      : `Slope ${a.slope}; no interval — ${a.intervalRefusal}`,
  );
  lines.push(`Residuals (model-id order, NOT a ranking):`);
  for (const row of result.residuals) {
    lines.push(
      `  ${row.modelId.padEnd(32)} ${row.residual >= 0 ? '+' : ''}${row.residual.toFixed(2)} ` +
        `(se ${row.residualSe.toFixed(2)}${row.withinNoise ? ', within noise' : ''})`,
    );
  }
  for (const caveat of result.caveats) lines.push(`  ! ${caveat}`);
  return lines.join('\n');
}
