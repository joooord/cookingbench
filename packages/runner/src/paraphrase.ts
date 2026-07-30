/**
 * Paraphrase robustness — M3.4 ("repeat byte-identical prompts on a stratified
 * sacrificial subset and test semantic paraphrases on a separate development
 * subset") and M4.6's prompt-form variance component.
 *
 * The claim under test is simple and unforgiving: if an item is reworded
 * without changing its culinary content and the scores move, the item was
 * measuring wording. Stage 3's acceptance rule says the same thing from the
 * other side — "no known wording trick determines success".
 *
 * This module does the comparison and the reporting. It NEVER calls a model:
 * it consumes stored responses from an archived run, or fixtures supplied by
 * whoever ran the development probe. Generating the paraphrased answers is a
 * permitted, budgeted, out-of-band activity; deciding what they mean is this.
 *
 * Two fail-closed rules shape everything below.
 *
 *  1. **A paraphrase must be attested, and the attestation is checked.** A
 *     human says "only the wording changed"; `contentDrift` then looks for
 *     quantities, units and constraint terms that appeared, vanished or
 *     changed value. If the mechanical check disagrees with the human, the
 *     comparison refuses until the drift is explicitly accepted item by item.
 *     The check is necessary, not sufficient — it cannot see that "fold" became
 *     "stir" — which is exactly why the human attestation is also mandatory.
 *  2. **Not finding a difference is not robustness.** A two-model comparison
 *     finds nothing whatever the truth is. `wording-robust` requires a
 *     preregistered equivalence margin and an interval that fits inside it;
 *     everything else is `inconclusive`, which is a different word on purpose.
 */

import type { Score } from '@cookingbench/core';
// Relative import, as in analyze.ts and simulate.ts: core's `exports` map does
// not expose stats.ts yet.
import { clusterBootstrapMean } from '../../core/src/stats.js';

export class ParaphraseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParaphraseError';
  }
}

/* -------------------------------------------------------------------------- */
/* Culinary content fingerprint                                               */
/* -------------------------------------------------------------------------- */

/**
 * Unit spellings collapsed to one token each. Without this, "180 °C" and
 * "180 degrees Celsius" read as different content and every honest paraphrase
 * would be refused — which trains reviewers to click past the refusal, the
 * worst possible outcome for a guard.
 */
const UNIT_SYNONYMS: Record<string, string> = {
  g: 'g', gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kg: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', millilitre: 'ml', millilitres: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l',
  tsp: 'tsp', teaspoon: 'tsp', teaspoons: 'tsp',
  tbsp: 'tbsp', tablespoon: 'tbsp', tablespoons: 'tbsp',
  cup: 'cup', cups: 'cup',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  pint: 'pint', pints: 'pint', quart: 'quart', quarts: 'quart', gallon: 'gallon',
  c: 'degC', celsius: 'degC', centigrade: 'degC', '°c': 'degC',
  f: 'degF', fahrenheit: 'degF', '°f': 'degF',
  min: 'min', minute: 'min', minutes: 'min', mins: 'min',
  hr: 'hr', hour: 'hr', hours: 'hr', hrs: 'hr',
  day: 'day', days: 'day', week: 'week', weeks: 'week',
  serving: 'serving', servings: 'serving', portion: 'serving', portions: 'serving',
  kcal: 'kcal', calorie: 'kcal', calories: 'kcal', cal: 'kcal',
};

/** Written numbers a paraphrase legitimately swaps for digits, and vice versa. */
const WORD_NUMBERS: Record<string, number> = {
  half: 0.5, quarter: 0.25, third: 1 / 3, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, dozen: 12,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, hundred: 100,
};

const VULGAR_FRACTIONS: Record<string, number> = {
  '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 0.125,
};

/**
 * Terms whose presence or absence changes the culinary task rather than the
 * prose: allergens, dietary constraints, locale markers and safety anchors.
 *
 * Deliberately a closed list. An open heuristic ("content words") would flag
 * every synonym a paraphrase is supposed to change, and a guard that fires on
 * correct input is a guard that gets disabled.
 */
const CONSTRAINT_TERMS = [
  'peanut', 'peanuts', 'tree nut', 'nut-free', 'gluten', 'coeliac', 'celiac', 'wheat',
  'dairy', 'lactose', 'egg', 'eggs', 'soy', 'soya', 'shellfish', 'sesame', 'fish',
  'vegan', 'vegetarian', 'halal', 'kosher', 'pescatarian',
  'australian', 'australia', 'uk', 'british', 'us', 'american', 'imperial', 'metric',
  'gas mark', 'fan', 'convection', 'sous vide', 'pressure cooker', 'air fryer',
  'pregnant', 'pregnancy', 'immunocompromised', 'infant', 'raw', 'undercooked',
  'refrigerate', 'freeze', 'danger zone', 'pasteurised', 'pasteurized',
];

export interface ContentFingerprint {
  /** Canonicalised "value unit" pairs, e.g. "180 degC", "2 tsp". */
  quantities: string[];
  /** Bare numbers with no unit attached, canonicalised to a fixed precision. */
  numbers: string[];
  /** Constraint terms present, deduplicated and sorted. */
  constraints: string[];
}

function canonicalNumber(v: number): string {
  // Three decimals: enough to keep 1/3 distinct from 0.33, not so many that
  // floating-point noise makes two equal quantities differ.
  return v.toFixed(3);
}

function parseNumberToken(token: string): number | null {
  if (VULGAR_FRACTIONS[token] !== undefined) return VULGAR_FRACTIONS[token]!;
  if (WORD_NUMBERS[token] !== undefined) return WORD_NUMBERS[token]!;
  const fraction = /^(\d+)\/(\d+)$/.exec(token);
  if (fraction) {
    const d = Number(fraction[2]);
    return d === 0 ? null : Number(fraction[1]) / d;
  }
  const plain = /^\d+(?:\.\d+)?$/.exec(token.replace(/,/g, ''));
  return plain ? Number(plain[0]) : null;
}

/**
 * Extract the culinary content a paraphrase must preserve.
 *
 * Quantities are matched as "number [unit]" with the unit optional, so
 * "180 °C" and "180 degrees Celsius" both become "180.000 degC", while a
 * paraphrase that turned 180 °C into 350 °F changes the fingerprint — correctly.
 * An equivalent conversion IS a content change: the item now tests a different
 * conversion, and whether that is acceptable is a judgement for the attestation
 * to record, not for this function to wave through.
 */
export function culinaryContentFingerprint(prompt: string): ContentFingerprint {
  const lower = prompt.toLowerCase().replace(/\s+/g, ' ');
  const quantities: string[] = [];
  const numbers: string[] = [];

  // Split on whitespace but keep °C/°F attached, and separate trailing
  // punctuation so "180°C." does not become its own unit.
  const tokens = lower
    .replace(/([°]?[cf])\b/g, ' $1 ')
    .replace(/(\d)([a-z°])/g, '$1 $2')
    .split(/[\s,;:()\[\]]+/)
    .map((t) => t.replace(/[.!?]+$/, ''))
    .filter((t) => t !== '');

  for (let i = 0; i < tokens.length; i++) {
    const value = parseNumberToken(tokens[i]!);
    if (value === null) continue;
    const next = tokens[i + 1];
    const unit = next ? UNIT_SYNONYMS[next] : undefined;
    if (unit) {
      quantities.push(`${canonicalNumber(value)} ${unit}`);
      i++;
    } else {
      numbers.push(canonicalNumber(value));
    }
  }

  const constraints = CONSTRAINT_TERMS.filter((term) =>
    new RegExp(`(^|[^a-z])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(lower),
  );

  return {
    quantities: quantities.sort(),
    numbers: numbers.sort(),
    constraints: [...new Set(constraints)].sort(),
  };
}

export interface ContentDrift {
  changed: boolean;
  /** Human-readable, one per differing token, ready to paste into a refusal. */
  differences: string[];
}

/** Multiset difference in both directions, so a duplicated quantity is caught. */
function diffMultiset(kind: string, a: readonly string[], b: readonly string[]): string[] {
  const count = (list: readonly string[]) => {
    const m = new Map<string, number>();
    for (const v of list) m.set(v, (m.get(v) ?? 0) + 1);
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  const out: string[] = [];
  for (const key of new Set([...ca.keys(), ...cb.keys()])) {
    const na = ca.get(key) ?? 0;
    const nb = cb.get(key) ?? 0;
    if (na !== nb) out.push(`${kind} ${JSON.stringify(key)}: ${na} → ${nb}`);
  }
  return out.sort();
}

export function contentDrift(basePrompt: string, variantPrompt: string): ContentDrift {
  const a = culinaryContentFingerprint(basePrompt);
  const b = culinaryContentFingerprint(variantPrompt);
  const differences = [
    ...diffMultiset('quantity', a.quantities, b.quantities),
    ...diffMultiset('number', a.numbers, b.numbers),
    ...diffMultiset('constraint', a.constraints, b.constraints),
  ];
  return { changed: differences.length > 0, differences };
}

/* -------------------------------------------------------------------------- */
/* Evidence                                                                   */
/* -------------------------------------------------------------------------- */

export interface ParaphraseAttestation {
  /** Who confirmed the culinary content is unchanged. */
  by: string;
  at: string;
  /** What was changed, in the attester's words. */
  note?: string;
  /**
   * Drift the reviewer looked at and accepted, verbatim as `contentDrift`
   * reports it. Unlisted drift refuses; there is no blanket override.
   */
  acceptedDrift?: string[];
}

export interface ParaphraseObservation {
  modelId: string;
  score: number;
  graderType: string;
  /** Judge prompt/panel version, when the item was judged. */
  judgeProtocol?: string;
}

export interface ParaphrasePair {
  baseItemId: string;
  variantId: string;
  basePrompt: string;
  variantPrompt: string;
  attestation?: ParaphraseAttestation;
  baseScores: readonly ParaphraseObservation[];
  variantScores: readonly ParaphraseObservation[];
  /**
   * Preregistered equivalence margin, in score points. Without it no comparison
   * may conclude `wording-robust`, however tight the interval — see the header.
   */
  equivalenceMarginPoints?: number;
  seed?: string;
  reps?: number;
  alpha?: number;
}

export type ParaphraseVerdict = 'refused' | 'wording-sensitive' | 'wording-robust' | 'inconclusive';

export interface ModelDelta {
  modelId: string;
  base: number;
  variant: number;
  /** variant − base. Positive means the rewording made the model look better. */
  delta: number;
}

export interface ParaphraseComparison {
  baseItemId: string;
  variantId: string;
  verdict: ParaphraseVerdict;
  refusals: string[];
  drift: ContentDrift;
  models: ModelDelta[];
  meanDelta: number | null;
  meanAbsDelta: number | null;
  maxAbsDelta: number | null;
  /** Models whose score moved at all between the two wordings. */
  movedModels: number;
  /** Percentile interval on the mean delta, resampling models. */
  ci: [number, number] | null;
  equivalenceMarginPoints: number | null;
  notes: string[];
}

/**
 * Below this many paired models no verdict is issued.
 *
 * Five is not a power calculation — it is the point below which the resample
 * has fewer distinct values than the interval has ends. A real development
 * probe should size this from `simulate.ts`, and the note says so.
 */
const MIN_MODELS_FOR_VERDICT = 5;

/**
 * A mean absolute movement at or above this is called wording-sensitive on its
 * own, regardless of the interval. A 5-point average swing from rewording is
 * larger than the entire gap between adjacent models on the published board.
 */
const SENSITIVITY_POINTS = 5;

/**
 * Compare an item against a paraphrase of itself.
 *
 * Refuses, rather than reporting, when the two sides are not comparable:
 * unattested content drift, a model present on one side only, or a grader or
 * judge protocol that changed between them. That last one matters more than it
 * looks — regrading the paraphrase under a newer judge prompt and calling the
 * difference "wording sensitivity" would be measuring the panel.
 */
export function compareParaphrase(pair: ParaphrasePair): ParaphraseComparison {
  const refusals: string[] = [];
  const notes: string[] = [];
  const drift = contentDrift(pair.basePrompt, pair.variantPrompt);

  if (!pair.attestation) {
    refusals.push(
      'No attestation that the culinary content is unchanged. A paraphrase nobody vouched for is a different item.',
    );
  }
  if (drift.changed) {
    const accepted = new Set(pair.attestation?.acceptedDrift ?? []);
    const unaccepted = drift.differences.filter((d) => !accepted.has(d));
    if (unaccepted.length > 0) {
      refusals.push(
        `Culinary content drifted and was not accepted by the attester: ${unaccepted.join('; ')}.`,
      );
    } else {
      notes.push(`Attester accepted ${drift.differences.length} content difference(s); the comparison is weaker for it.`);
    }
  }

  const baseByModel = new Map<string, ParaphraseObservation>();
  for (const o of pair.baseScores) {
    if (baseByModel.has(o.modelId)) {
      refusals.push(`Model ${o.modelId} has more than one base score; repeated generations must be collapsed deliberately.`);
    }
    baseByModel.set(o.modelId, o);
  }
  const variantByModel = new Map<string, ParaphraseObservation>();
  for (const o of pair.variantScores) {
    if (variantByModel.has(o.modelId)) {
      refusals.push(`Model ${o.modelId} has more than one variant score.`);
    }
    variantByModel.set(o.modelId, o);
  }

  const onlyBase = [...baseByModel.keys()].filter((m) => !variantByModel.has(m));
  const onlyVariant = [...variantByModel.keys()].filter((m) => !baseByModel.has(m));
  if (onlyBase.length > 0 || onlyVariant.length > 0) {
    // Dropping the unpaired models would compare two different rosters and
    // attribute the difference to wording.
    refusals.push(
      `Roster mismatch: ${onlyBase.length} model(s) scored only on the base item, ${onlyVariant.length} only on the variant.`,
    );
  }

  const models: ModelDelta[] = [];
  for (const modelId of [...baseByModel.keys()].filter((m) => variantByModel.has(m)).sort()) {
    const b = baseByModel.get(modelId)!;
    const v = variantByModel.get(modelId)!;
    if (b.graderType !== v.graderType) {
      refusals.push(`Model ${modelId}: grader changed (${b.graderType} → ${v.graderType}); that measures the grader, not the wording.`);
    }
    if ((b.judgeProtocol ?? null) !== (v.judgeProtocol ?? null)) {
      refusals.push(
        `Model ${modelId}: judge protocol changed (${b.judgeProtocol ?? 'none'} → ${v.judgeProtocol ?? 'none'}); rescoring under a new panel is not a paraphrase effect.`,
      );
    }
    if (!Number.isFinite(b.score) || !Number.isFinite(v.score)) {
      refusals.push(`Model ${modelId} has a non-finite score.`);
      continue;
    }
    models.push({ modelId, base: b.score, variant: v.score, delta: round(v.score - b.score, 3) });
  }

  const base = {
    baseItemId: pair.baseItemId,
    variantId: pair.variantId,
    drift,
    models,
    equivalenceMarginPoints: pair.equivalenceMarginPoints ?? null,
  };

  if (refusals.length > 0) {
    return {
      ...base,
      verdict: 'refused',
      refusals,
      meanDelta: null,
      meanAbsDelta: null,
      maxAbsDelta: null,
      movedModels: models.filter((m) => m.delta !== 0).length,
      ci: null,
      notes,
    };
  }

  const deltas = models.map((m) => m.delta);
  const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const meanAbsDelta = deltas.reduce((a, b) => a + Math.abs(b), 0) / deltas.length;
  const maxAbsDelta = Math.max(...deltas.map(Math.abs));
  const movedModels = deltas.filter((d) => d !== 0).length;

  let ci: [number, number] | null = null;
  if (models.length >= 2) {
    // Cluster = model: the resampling unit is the model, since one model's two
    // scores are the paired observation. Items are fixed here (it is one item),
    // so there is nothing else to resample.
    const r = clusterBootstrapMean(
      models.map((m) => ({ cluster: m.modelId, id: m.modelId, value: m.delta })),
      {
        seed: pair.seed ?? `paraphrase:${pair.baseItemId}:${pair.variantId}`,
        reps: pair.reps ?? 4000,
        alpha: pair.alpha ?? 0.05,
      },
    );
    ci = [round(r.lower, 3), round(r.upper, 3)];
  }

  let verdict: ParaphraseVerdict;
  const intervalExcludesZero = ci !== null && (ci[0] > 0 || ci[1] < 0);
  if (models.length < MIN_MODELS_FOR_VERDICT) {
    verdict = 'inconclusive';
    notes.push(
      `${models.length} paired model(s); at least ${MIN_MODELS_FOR_VERDICT} are needed before a verdict, and simulate.ts should size this properly for a real probe.`,
    );
  } else if (meanAbsDelta >= SENSITIVITY_POINTS || intervalExcludesZero) {
    verdict = 'wording-sensitive';
  } else if (
    pair.equivalenceMarginPoints !== undefined &&
    ci !== null &&
    Math.abs(ci[0]) <= pair.equivalenceMarginPoints &&
    Math.abs(ci[1]) <= pair.equivalenceMarginPoints
  ) {
    verdict = 'wording-robust';
  } else {
    verdict = 'inconclusive';
    notes.push(
      pair.equivalenceMarginPoints === undefined
        ? 'No preregistered equivalence margin, so robustness cannot be concluded — only "no difference was detected".'
        : 'The interval is wider than the equivalence margin; the item is neither shown sensitive nor shown robust.',
    );
  }

  return {
    ...base,
    verdict,
    refusals,
    meanDelta: round(meanDelta, 3),
    meanAbsDelta: round(meanAbsDelta, 3),
    maxAbsDelta: round(maxAbsDelta, 3),
    movedModels,
    ci,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* Loading evidence                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Pull both sides out of an archived run's scores, where the paraphrase was run
 * as its own question id. READ-ONLY: takes an already-loaded array.
 *
 * Throws when either id is absent, rather than returning an empty side that
 * `compareParaphrase` would then report as a roster mismatch — the two failures
 * have different fixes and should not look the same.
 */
export function paraphraseObservationsFromScores(
  scores: readonly Score[],
  itemId: string,
): ParaphraseObservation[] {
  const rows = scores.filter((s) => s.questionId === itemId);
  if (rows.length === 0) {
    throw new ParaphraseError(`No scores for item ${itemId} in the supplied run.`);
  }
  return rows
    .map((s) => ({
      modelId: s.modelId,
      score: s.score,
      graderType: s.graderType as string,
      ...(s.judgeModel ? { judgeProtocol: s.judgeModel } : {}),
    }))
    .sort((a, b) => a.modelId.localeCompare(b.modelId));
}

/* -------------------------------------------------------------------------- */
/* Set-level reporting                                                        */
/* -------------------------------------------------------------------------- */

export interface ParaphraseSetSummary {
  pairs: number;
  refused: number;
  sensitive: number;
  robust: number;
  inconclusive: number;
  /** Mean of the per-item mean absolute deltas, over comparable pairs only. */
  meanAbsDelta: number | null;
  /** Items to inspect first: the largest movers, sensitive ones first. */
  worst: Array<{ itemId: string; variantId: string; meanAbsDelta: number; verdict: ParaphraseVerdict }>;
}

/**
 * Aggregate a set of comparisons.
 *
 * `robust` counts only items that cleared a declared equivalence margin, so
 * this summary can never be read as "most items are fine" on the strength of
 * small samples. A set that is mostly `inconclusive` has not been tested; it
 * has been looked at.
 */
export function summariseParaphraseSet(comparisons: readonly ParaphraseComparison[]): ParaphraseSetSummary {
  const comparable = comparisons.filter((c) => c.meanAbsDelta !== null);
  const worst = comparable
    .map((c) => ({
      itemId: c.baseItemId,
      variantId: c.variantId,
      meanAbsDelta: c.meanAbsDelta!,
      verdict: c.verdict,
    }))
    .sort((a, b) => b.meanAbsDelta - a.meanAbsDelta || a.itemId.localeCompare(b.itemId))
    .slice(0, 10);
  return {
    pairs: comparisons.length,
    refused: comparisons.filter((c) => c.verdict === 'refused').length,
    sensitive: comparisons.filter((c) => c.verdict === 'wording-sensitive').length,
    robust: comparisons.filter((c) => c.verdict === 'wording-robust').length,
    inconclusive: comparisons.filter((c) => c.verdict === 'inconclusive').length,
    meanAbsDelta: comparable.length
      ? round(comparable.reduce((a, c) => a + c.meanAbsDelta!, 0) / comparable.length, 3)
      : null,
    worst,
  };
}

export function formatParaphraseReport(
  comparisons: readonly ParaphraseComparison[],
  summary = summariseParaphraseSet(comparisons),
): string {
  const lines = [
    `Paraphrase robustness — ${summary.pairs} pair(s): ${summary.sensitive} wording-sensitive, ${summary.robust} robust, ${summary.inconclusive} inconclusive, ${summary.refused} refused.`,
  ];
  if (summary.meanAbsDelta !== null) {
    lines.push(`Mean absolute score movement across comparable pairs: ${summary.meanAbsDelta} points.`);
  }
  for (const c of comparisons) {
    lines.push(
      `  ${c.baseItemId} → ${c.variantId}: ${c.verdict}` +
        (c.meanAbsDelta === null
          ? ''
          : ` (mean Δ ${c.meanDelta}, |Δ| ${c.meanAbsDelta}, max ${c.maxAbsDelta}, ${c.movedModels}/${c.models.length} models moved` +
            (c.ci ? `, CI [${c.ci[0]}, ${c.ci[1]}]` : '') +
            ')'),
    );
    for (const r of c.refusals) lines.push(`      REFUSED: ${r}`);
    for (const n of c.notes) lines.push(`      note: ${n}`);
  }
  return lines.join('\n');
}

function round(v: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}
