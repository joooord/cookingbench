import { describe, expect, it } from 'vitest';
import {
  RESIDUAL_LABEL,
  assessIncrementalValidity,
  formatSpecificityReport,
  parseGeneralPredictorDocument,
  specificityAnalysis,
  type GeneralPredictorDocument,
  type OutcomeRow,
  type SnapshotMapping,
} from '../src/specificity.js';

/**
 * These tests are attempts to get a residual table out of the module when it
 * should not produce one — an unverified mapping, a saturated board, a second
 * predictor column smuggled into a mapping row — plus the arithmetic checks
 * that would let a sign error through unnoticed.
 */

/** Ten models over four providers, so the provider cluster bootstrap is usable. */
const ROSTER: Array<{ modelId: string; x: number }> = [
  { modelId: 'openai/a', x: 1200 },
  { modelId: 'openai/b', x: 1180 },
  { modelId: 'openai/c', x: 1150 },
  { modelId: 'anthropic/a', x: 1230 },
  { modelId: 'anthropic/b', x: 1190 },
  { modelId: 'anthropic/c', x: 1120 },
  { modelId: 'google/a', x: 1210 },
  { modelId: 'google/b', x: 1100 },
  { modelId: 'x-ai/a', x: 1250 },
  { modelId: 'x-ai/b', x: 1060 },
];

function mapping(modelId: string, x: number, over: Partial<SnapshotMapping> = {}): SnapshotMapping {
  return {
    route: modelId,
    snapshot: `${modelId}-2026-06-01`,
    value: x,
    vintage: '2026-06-01',
    evidence: {
      status: 'verified',
      source: 'https://example.invalid/mapping-note',
      verifiedBy: 'measurement review',
      verifiedAt: '2026-06-02',
    },
    ...over,
  };
}

function predictor(over: Partial<GeneralPredictorDocument> = {}): GeneralPredictorDocument {
  return {
    predictorId: 'general-v1',
    predictorName: 'External general-capability composite',
    publishedBy: 'External authority',
    direction: 'higher-is-better',
    frozenAt: '2026-05-01',
    mappings: ROSTER.map((r) => mapping(r.modelId, r.x)),
    ...over,
  };
}

/** y = 60 + 0.025x plus a per-model wobble, so residuals are non-trivial. */
function outcomes(wobble: Record<string, number> = {}, ci?: number): OutcomeRow[] {
  return ROSTER.map((r) => ({
    modelId: r.modelId,
    overall: 60 + 0.025 * r.x + (wobble[r.modelId] ?? 0),
    ...(ci === undefined
      ? {}
      : { ci95: [60 + 0.025 * r.x - ci, 60 + 0.025 * r.x + ci] as [number, number] }),
  }));
}

describe('predictor document parsing', () => {
  it('refuses a mapping row carrying a second numeric column', () => {
    // The realistic way M1.10's one-predictor rule gets broken: not a second
    // document, a second column beside the first.
    const doc = predictor();
    const rows = doc.mappings.map((m, i) => (i === 0 ? { ...m, mmlu: 88.4 } : m));
    expect(() => parseGeneralPredictorDocument({ ...doc, mappings: rows })).toThrowError(
      /second numeric column 'mmlu'/,
    );
  });

  it('refuses a verified status with nobody named', () => {
    const doc = predictor();
    const rows = doc.mappings.map((m, i) =>
      i === 0 ? { ...m, evidence: { status: 'verified', source: 'a note' } } : m,
    );
    expect(() => parseGeneralPredictorDocument({ ...doc, mappings: rows })).toThrowError(
      /verifiedBy/,
    );
  });

  it('refuses the same route mapped to two snapshots', () => {
    const doc = predictor();
    const rows = [...doc.mappings, mapping('openai/a', 999)];
    expect(() => parseGeneralPredictorDocument({ ...doc, mappings: rows })).toThrowError(
      /mapped twice/,
    );
  });

  it('refuses a vintage that is not a comparable date', () => {
    const doc = predictor();
    const rows = doc.mappings.map((m, i) => (i === 0 ? { ...m, vintage: 'Q2 2026' } : m));
    expect(() => parseGeneralPredictorDocument({ ...doc, mappings: rows })).toThrowError(/ISO date/);
  });

  it('refuses a mapping with no evidence block at all', () => {
    const doc = predictor();
    const rows = doc.mappings.map((m, i) => {
      if (i !== 0) return m;
      const { evidence: _dropped, ...rest } = m;
      return rest;
    });
    expect(() => parseGeneralPredictorDocument({ ...doc, mappings: rows })).toThrowError(
      /no evidence block/,
    );
  });

  it('refuses an unknown direction rather than assuming higher is better', () => {
    expect(() => parseGeneralPredictorDocument({ ...predictor(), direction: 'unknown' })).toThrowError(
      /higher-is-better/,
    );
  });

  it('accepts a well-formed document unchanged', () => {
    const parsed = parseGeneralPredictorDocument(predictor());
    expect(parsed.mappings).toHaveLength(ROSTER.length);
    expect(parsed.mappings[0]!.evidence.status).toBe('verified');
  });
});

describe('mapping evidence gates the whole analysis', () => {
  it('refuses when a model in scope has no mapping, and names it', () => {
    const doc = predictor({ mappings: predictor().mappings.slice(0, 9) });
    const result = specificityAnalysis({ runId: 'r', outcomes: outcomes(), predictor: doc });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0]!.code).toBe('MAPPING_MISSING');
    expect(result.refusals[0]!.routes).toEqual(['x-ai/b']);
    // The dangerous alternative is regressing on the nine that mapped.
    expect('residuals' in result).toBe(false);
  });

  it('refuses an asserted mapping even when everything else is perfect', () => {
    const rows = predictor().mappings.map((m, i) =>
      i === 0 ? { ...m, evidence: { status: 'asserted' as const, source: 'looks right' } } : m,
    );
    const result = specificityAnalysis({
      runId: 'r',
      outcomes: outcomes(),
      predictor: predictor({ mappings: rows }),
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals.map((r) => r.code)).toContain('MAPPING_UNVERIFIED');
  });

  it('does not quietly narrow scope to the verified subset', () => {
    const rows = predictor().mappings.map((m, i) =>
      i < 2 ? { ...m, evidence: { status: 'absent' as const, source: 'none' } } : m,
    );
    const result = specificityAnalysis({
      runId: 'r',
      outcomes: outcomes(),
      predictor: predictor({ mappings: rows }),
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0]!.routes).toHaveLength(2);
  });

  it('refuses a scope naming a model with no CookingBench outcome', () => {
    const result = specificityAnalysis({
      runId: 'r',
      outcomes: outcomes(),
      predictor: predictor(),
      scope: [...ROSTER.map((r) => r.modelId), 'ghost/model'],
    });
    expect(result.status).toBe('refused');
  });

  it('refuses fewer than eight mapped models', () => {
    const subset = ROSTER.slice(0, 5);
    const result = specificityAnalysis({
      runId: 'r',
      outcomes: outcomes().filter((o) => subset.some((s) => s.modelId === o.modelId)),
      predictor: predictor({ mappings: subset.map((r) => mapping(r.modelId, r.x)) }),
    });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0]!.code).toBe('INSUFFICIENT_MODELS');
  });
});

describe('degenerate inputs', () => {
  it('refuses a predictor with no spread', () => {
    const flat = predictor({ mappings: ROSTER.map((r) => mapping(r.modelId, 1200)) });
    const result = specificityAnalysis({ runId: 'r', outcomes: outcomes(), predictor: flat });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0]!.code).toBe('PREDICTOR_DEGENERATE');
  });

  it('refuses a saturated board, where every residual is rounding', () => {
    const flatOutcomes = ROSTER.map((r) => ({ modelId: r.modelId, overall: 96 }));
    const result = specificityAnalysis({ runId: 'r', outcomes: flatOutcomes, predictor: predictor() });
    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('unreachable');
    expect(result.refusals[0]!.code).toBe('OUTCOME_DEGENERATE');
  });
});

describe('the descriptive fit', () => {
  it('recovers a known line and leaves zero residuals', () => {
    const result = specificityAnalysis({ runId: 'r', outcomes: outcomes(), predictor: predictor() });
    if (result.status !== 'descriptive') throw new Error('expected a descriptive result');
    expect(result.association.slope).toBeCloseTo(0.025, 6);
    expect(result.association.r2).toBeCloseTo(1, 6);
    for (const row of result.residuals) expect(Math.abs(row.residual)).toBeLessThan(1e-6);
  });

  it('flips nothing when the predictor is lower-is-better, only the sign convention', () => {
    // Same data, predictor negated and declared lower-is-better: residuals must
    // be identical. A missing orientation step shows up here as a sign flip on
    // every residual, which is invisible in the table itself.
    const wobble = { 'openai/a': 2, 'x-ai/b': -3, 'google/b': 1.5 };
    const higher = specificityAnalysis({
      runId: 'r',
      outcomes: outcomes(wobble),
      predictor: predictor(),
    });
    const lower = specificityAnalysis({
      runId: 'r',
      outcomes: outcomes(wobble),
      predictor: predictor({
        direction: 'lower-is-better',
        mappings: ROSTER.map((r) => mapping(r.modelId, -r.x)),
      }),
    });
    if (higher.status !== 'descriptive' || lower.status !== 'descriptive') {
      throw new Error('expected descriptive results');
    }
    expect(lower.residuals.map((r) => r.residual)).toEqual(higher.residuals.map((r) => r.residual));
    expect(lower.association.pearsonR).toBeCloseTo(higher.association.pearsonR, 9);
  });

  it('orders residuals by model id, never by residual', () => {
    // The wobble makes the residual order differ from the id order, so a
    // "helpful" sort would be visible.
    const wobble = { 'anthropic/a': -4, 'x-ai/b': 4, 'google/b': 2 };
    const result = specificityAnalysis({
      runId: 'r',
      outcomes: outcomes(wobble),
      predictor: predictor(),
    });
    if (result.status !== 'descriptive') throw new Error('expected a descriptive result');
    const ids = result.residuals.map((r) => r.modelId);
    expect(ids).toEqual([...ids].sort());
    const residualOrder = [...result.residuals].sort((a, b) => b.residual - a.residual).map((r) => r.modelId);
    expect(ids).not.toEqual(residualOrder);
    expect(result.ranked).toBe(false);
    expect(result.orderedBy).toBe('modelId');
    expect(result.label).toBe(RESIDUAL_LABEL);
  });

  it('is deterministic, intervals included', () => {
    const wobble = { 'openai/b': 1.7, 'google/a': -2.2 };
    const a = specificityAnalysis({ runId: 'r', outcomes: outcomes(wobble), predictor: predictor(), reps: 500 });
    const b = specificityAnalysis({ runId: 'r', outcomes: outcomes(wobble), predictor: predictor(), reps: 500 });
    expect(a).toEqual(b);
  });

  it('reports no slope interval when there are too few provider clusters', () => {
    // Every model under one vendor prefix: nine of the ten "clusters" vanish.
    const single = ROSTER.map((r, i) => ({ modelId: `solo/m${i}`, x: r.x }));
    const result = specificityAnalysis({
      runId: 'r',
      outcomes: single.map((s) => ({ modelId: s.modelId, overall: 60 + 0.025 * s.x })),
      predictor: predictor({ mappings: single.map((s) => mapping(s.modelId, s.x)) }),
    });
    if (result.status !== 'descriptive') throw new Error('expected a descriptive result');
    expect(result.association.slopeCi).toBeNull();
    expect(result.association.intervalRefusal).toMatch(/cluster/);
  });
});

describe('omission triggers', () => {
  it('recommends omission when per-model uncertainty swamps the roster spread', () => {
    // The shape of run 2026-07-v2.1: mean half-width 3.58 against an SD of 3.42.
    const result = specificityAnalysis({
      runId: '2026-07-v2.1-shaped',
      outcomes: outcomes({}, 3.6),
      predictor: predictor(),
    });
    if (result.status !== 'descriptive') throw new Error('expected a descriptive result');
    expect(result.diagnostics.uncertaintyRatio).toBeGreaterThan(0.6);
    expect(result.omissionRecommended).toBe(true);
    expect(result.omissionReasons.join(' ')).toMatch(/measurement noise/);
  });

  it('recommends omission when the predictor values are not one vintage', () => {
    const staggered = ROSTER.map((r, i) =>
      mapping(r.modelId, r.x, { vintage: i === 0 ? '2025-01-01' : '2026-06-01' }),
    );
    const result = specificityAnalysis({
      runId: 'r',
      outcomes: outcomes(),
      predictor: predictor({ mappings: staggered }),
    });
    if (result.status !== 'descriptive') throw new Error('expected a descriptive result');
    expect(result.omissionRecommended).toBe(true);
    expect(result.omissionReasons.join(' ')).toMatch(/vintage/);
  });

  it('recommends omission when one provider dominates the fit', () => {
    const lopsided = ROSTER.map((r, i) => ({ modelId: i < 6 ? `openai/m${i}` : r.modelId, x: r.x }));
    const result = specificityAnalysis({
      runId: 'r',
      outcomes: lopsided.map((s) => ({ modelId: s.modelId, overall: 60 + 0.025 * s.x })),
      predictor: predictor({ mappings: lopsided.map((s) => mapping(s.modelId, s.x)) }),
    });
    if (result.status !== 'descriptive') throw new Error('expected a descriptive result');
    expect(result.omissionRecommended).toBe(true);
    expect(result.omissionReasons.join(' ')).toMatch(/provider/);
  });

  it('notes that a late predictor freeze can never become confirmatory', () => {
    const result = specificityAnalysis({
      runId: 'r',
      outcomes: outcomes(),
      predictor: predictor({ frozenAt: '2026-07-01' }),
      inferenceStartedAt: '2026-06-01',
    });
    if (result.status !== 'descriptive') throw new Error('expected a descriptive result');
    expect(result.diagnostics.predictorFrozenBeforeInference).toBe(false);
    expect(result.caveats.join(' ')).toMatch(/confirmatory/);
  });
});

describe('reporting language', () => {
  it('never prints a residual table for a refusal', () => {
    const doc = predictor({ mappings: predictor().mappings.slice(0, 8) });
    const text = formatSpecificityReport(
      specificityAnalysis({ runId: 'r', outcomes: outcomes(), predictor: doc }),
    );
    expect(text).toMatch(/REFUSED/);
    expect(text).not.toMatch(/Residuals/);
  });

  it('leads with the label and the disclaimer, and never claims a ranking', () => {
    const text = formatSpecificityReport(
      specificityAnalysis({ runId: 'r', outcomes: outcomes({ 'openai/a': 2 }), predictor: predictor(), reps: 500 }),
    );
    expect(text).toContain(RESIDUAL_LABEL);
    expect(text).toMatch(/Descriptive only/);
    expect(text).toMatch(/NOT a ranking/);
    expect(text.toLowerCase()).not.toMatch(/culinary ability(?! )/);
  });
});

describe('confirmatory incremental validity', () => {
  it('refuses with nothing supplied and lists every missing precondition', () => {
    const status = assessIncrementalValidity();
    expect(status.eligible).toBe(false);
    expect(status.claimPermitted).toBe(false);
    expect(status.blockers.length).toBeGreaterThanOrEqual(3);
  });

  it('treats unknown inference timing as a blocker, not as a pass', () => {
    const status = assessIncrementalValidity({
      predictor: { predictorId: 'p', contentHash: 'abc', frozenAt: '2026-01-01' },
    });
    expect(status.blockers.join(' ')).toMatch(/inference start time unknown/i);
  });

  it('blocks a criterion that helped build the benchmark', () => {
    const status = assessIncrementalValidity({
      predictor: { predictorId: 'p', contentHash: 'abc', frozenAt: '2026-01-01' },
      inferenceStartedAt: '2026-02-01',
      criterion: {
        criterionId: 'chef-panel',
        source: 'expert panel',
        usedInAuthoring: true,
        usedInSelection: false,
        usedInWeighting: false,
        usedInTuning: true,
        units: 120,
        frozenAt: '2026-01-15',
      },
      crossValidation: { folds: 5, repeats: 10, preregistrationId: 'PRE-1' },
    });
    expect(status.eligible).toBe(false);
    expect(status.blockers.join(' ')).toMatch(/authoring, tuning/);
  });

  it('still permits no claim when every precondition is met', () => {
    // Eligibility is not a result. The estimator is deliberately unbuilt, and
    // this test is what stops a later change quietly turning eligibility into
    // a published specificity claim.
    const status = assessIncrementalValidity({
      predictor: { predictorId: 'p', contentHash: 'abc', frozenAt: '2026-01-01' },
      inferenceStartedAt: '2026-02-01',
      criterion: {
        criterionId: 'kitchen-outcome',
        source: 'kitchen outcome trial',
        usedInAuthoring: false,
        usedInSelection: false,
        usedInWeighting: false,
        usedInTuning: false,
        units: 200,
        frozenAt: '2026-01-15',
      },
      crossValidation: { folds: 5, repeats: 10, preregistrationId: 'PRE-1' },
    });
    expect(status.eligible).toBe(true);
    expect(status.claimPermitted).toBe(false);
    expect(status.requiredProcedure.join(' ')).toMatch(/out-of-sample/);
  });

  it('blocks cross-validation that is not preregistered', () => {
    const status = assessIncrementalValidity({
      predictor: { predictorId: 'p', contentHash: 'abc', frozenAt: '2026-01-01' },
      inferenceStartedAt: '2026-02-01',
      criterion: {
        criterionId: 'kitchen-outcome',
        source: 'kitchen outcome trial',
        usedInAuthoring: false,
        usedInSelection: false,
        usedInWeighting: false,
        usedInTuning: false,
        units: 200,
        frozenAt: '2026-01-15',
      },
      crossValidation: { folds: 5, repeats: 10 },
    });
    expect(status.eligible).toBe(false);
    expect(status.blockers.join(' ')).toMatch(/preregistered/);
  });
});
