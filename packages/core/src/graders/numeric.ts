import type { GradeResult, GraderSpec, NumericTarget } from '../types.js';
import { extractQuantities, gradableScope, type Quantity } from './extract.js';
import { convert, dimensionOf } from './units.js';

const DEFAULT_TOLERANCE_PCT = 1;

type NumericSpec = Extract<GraderSpec, { type: 'numeric' }>;
type NumericMultiSpec = Extract<GraderSpec, { type: 'numeric-multi' }>;
type RangeSpec = Extract<GraderSpec, { type: 'range' }>;

function withinTolerance(
  candidate: number,
  expected: number,
  tolerancePct: number | undefined,
  toleranceAbs: number | undefined,
): boolean {
  const abs =
    toleranceAbs ??
    (Math.abs(expected) * (tolerancePct ?? DEFAULT_TOLERANCE_PCT)) / 100;
  return Math.abs(candidate - expected) <= abs + 1e-9;
}

/**
 * Convert a candidate quantity into the expected unit's terms.
 * Unitless candidates are compared as-is. Returns undefined if incompatible.
 */
function candidateInExpectedUnit(
  q: Quantity,
  expectedUnit: string | undefined,
  acceptEquivalentUnits: boolean,
): number | undefined {
  if (!expectedUnit || !q.unit) return q.value;
  if (q.unit === expectedUnit) return q.value;
  if (!acceptEquivalentUnits) return undefined;
  return convert(q.value, q.unit, expectedUnit);
}

/** Quantities restating the prompt verbatim (same value+unit) only count on an explicit answer line. */
function filterPromptEchoes(
  candidates: Quantity[],
  promptText: string | undefined,
  usedAnswerLine: boolean,
): Quantity[] {
  if (usedAnswerLine || !promptText) return candidates;
  const promptQuantities = extractQuantities(promptText);
  return candidates.filter(
    (c) => !promptQuantities.some((p) => p.value === c.value && p.unit === c.unit),
  );
}

export function gradeNumeric(
  spec: NumericSpec,
  answerText: string,
  promptText?: string,
): GradeResult {
  const scope = gradableScope(answerText);
  const candidates = filterPromptEchoes(
    extractQuantities(scope.text),
    promptText,
    scope.usedAnswerLine,
  );
  const accept = spec.acceptEquivalentUnits ?? true;
  for (const q of candidates) {
    if (spec.unit && q.unit && dimensionOf(q.unit) !== dimensionOf(spec.unit)) continue;
    const value = candidateInExpectedUnit(q, spec.unit, accept);
    if (value === undefined) continue;
    if (withinTolerance(value, spec.expected, spec.tolerancePct, spec.toleranceAbs)) {
      return {
        score: 100,
        detail: { matched: q.raw, value, expected: spec.expected, unit: spec.unit },
      };
    }
  }
  return {
    score: 0,
    detail: {
      expected: spec.expected,
      unit: spec.unit,
      candidates: candidates.map((c) => c.raw).slice(0, 12),
      usedAnswerLine: scope.usedAnswerLine,
    },
  };
}

export function gradeNumericMulti(
  spec: NumericMultiSpec,
  answerText: string,
  promptText?: string,
): GradeResult {
  const lines = answerText.split('\n');
  const results = spec.targets.map((target) => gradeTarget(target, lines, answerText, promptText));
  const hits = results.filter((r) => r.pass).length;
  const score =
    spec.scoring === 'all-or-nothing'
      ? hits === spec.targets.length
        ? 100
        : 0
      : (hits / spec.targets.length) * 100;
  return {
    score,
    detail: {
      targets: results.map((r, i) => ({
        label: spec.targets[i]!.label,
        expected: spec.targets[i]!.expected,
        unit: spec.targets[i]!.unit,
        pass: r.pass,
        matched: r.matched,
      })),
    },
  };
}

function gradeTarget(
  target: NumericTarget,
  lines: string[],
  fullText: string,
  promptText: string | undefined,
): { pass: boolean; matched?: string } {
  const label = target.label.toLowerCase();
  const labelledLines = lines.filter((l) => l.toLowerCase().includes(label));
  // Prefer quantities on lines naming the ingredient; fall back to the whole
  // answer (minus prompt echoes) if the label never appears.
  const scopes =
    labelledLines.length > 0
      ? labelledLines.map((text) => ({ quantities: extractQuantities(text) }))
      : [{
          quantities: filterPromptEchoes(extractQuantities(fullText), promptText, false),
        }];
  for (const scope of scopes) {
    for (const q of scope.quantities) {
      if (target.unit && q.unit && dimensionOf(q.unit) !== dimensionOf(target.unit)) continue;
      const value = candidateInExpectedUnit(q, target.unit, true);
      if (value === undefined) continue;
      if (withinTolerance(value, target.expected, target.tolerancePct, target.toleranceAbs)) {
        return { pass: true, matched: q.raw };
      }
    }
  }
  return { pass: false };
}

export function gradeRange(
  spec: RangeSpec,
  answerText: string,
  promptText?: string,
): GradeResult {
  const scope = gradableScope(answerText);
  const candidates = filterPromptEchoes(
    extractQuantities(scope.text),
    promptText,
    scope.usedAnswerLine,
  );
  for (const q of candidates) {
    if (spec.unit && q.unit && dimensionOf(q.unit) !== dimensionOf(spec.unit)) continue;
    const value = candidateInExpectedUnit(q, spec.unit, true);
    if (value === undefined) continue;
    if (value >= spec.min - 1e-9 && value <= spec.max + 1e-9) {
      return { score: 100, detail: { matched: q.raw, value, min: spec.min, max: spec.max } };
    }
  }
  return {
    score: 0,
    detail: {
      min: spec.min,
      max: spec.max,
      unit: spec.unit,
      candidates: candidates.map((c) => c.raw).slice(0, 12),
    },
  };
}
