export type Dimension = 'mass' | 'volume' | 'temperature' | 'energy' | 'count' | 'time';

interface UnitDef {
  dimension: Dimension;
  /** Multiplier to the dimension's base unit (g, ml, kcal, minutes). Temp handled separately. */
  toBase: number;
}

const UNIT_DEFS: Record<string, UnitDef> = {
  // mass (base: g)
  g: { dimension: 'mass', toBase: 1 },
  kg: { dimension: 'mass', toBase: 1000 },
  mg: { dimension: 'mass', toBase: 0.001 },
  oz: { dimension: 'mass', toBase: 28.3495 },
  lb: { dimension: 'mass', toBase: 453.592 },
  // volume (base: ml). US customary cup; tolerances absorb the 236.6 vs 240 ml debate.
  ml: { dimension: 'volume', toBase: 1 },
  l: { dimension: 'volume', toBase: 1000 },
  tsp: { dimension: 'volume', toBase: 4.92892 },
  tbsp: { dimension: 'volume', toBase: 14.7868 },
  cup: { dimension: 'volume', toBase: 236.588 },
  floz: { dimension: 'volume', toBase: 29.5735 },
  pint: { dimension: 'volume', toBase: 473.176 },
  quart: { dimension: 'volume', toBase: 946.353 },
  gallon: { dimension: 'volume', toBase: 3785.41 },
  // temperature (affine — toBase unused)
  c: { dimension: 'temperature', toBase: 1 },
  f: { dimension: 'temperature', toBase: 1 },
  // energy (base: kcal; dietary "calories" are kcal)
  kcal: { dimension: 'energy', toBase: 1 },
  kj: { dimension: 'energy', toBase: 0.239006 },
  // time (base: minutes)
  min: { dimension: 'time', toBase: 1 },
  hour: { dimension: 'time', toBase: 60 },
  sec: { dimension: 'time', toBase: 1 / 60 },
  day: { dimension: 'time', toBase: 1440 },
  // count
  serving: { dimension: 'count', toBase: 1 },
};

const ALIASES: Record<string, string> = {
  gram: 'g', grams: 'g', gramme: 'g', grammes: 'g',
  kilogram: 'kg', kilograms: 'kg', kilo: 'kg', kilos: 'kg',
  milligram: 'mg', milligrams: 'mg',
  ounce: 'oz', ounces: 'oz',
  pound: 'lb', pounds: 'lb', lbs: 'lb',
  milliliter: 'ml', milliliters: 'ml', millilitre: 'ml', millilitres: 'ml', mls: 'ml',
  liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  teaspoon: 'tsp', teaspoons: 'tsp', tsps: 'tsp',
  tablespoon: 'tbsp', tablespoons: 'tbsp', tbsps: 'tbsp', tbs: 'tbsp', tb: 'tbsp',
  cups: 'cup',
  'fl oz': 'floz', 'fluid ounce': 'floz', 'fluid ounces': 'floz', 'fl. oz': 'floz', 'fl. oz.': 'floz',
  pints: 'pint', pt: 'pint',
  quarts: 'quart', qt: 'quart',
  gallons: 'gallon', gal: 'gallon',
  '°c': 'c', celsius: 'c', centigrade: 'c', '°f': 'f', fahrenheit: 'f',
  kcals: 'kcal', calorie: 'kcal', calories: 'kcal', cal: 'kcal', cals: 'kcal',
  kilojoule: 'kj', kilojoules: 'kj',
  minute: 'min', minutes: 'min', mins: 'min',
  hours: 'hour', hr: 'hour', hrs: 'hour', h: 'hour',
  second: 'sec', seconds: 'sec', secs: 'sec', s: 'sec',
  days: 'day',
  servings: 'serving', portion: 'serving', portions: 'serving',
};

/** Normalize a raw unit token to a canonical unit id, or undefined if unknown. */
export function normalizeUnit(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .toLowerCase()
    .replace(/degrees?\s*/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.$/, '')
    .trim();
  if (cleaned in UNIT_DEFS) return cleaned;
  if (cleaned in ALIASES) return ALIASES[cleaned];
  return undefined;
}

export function dimensionOf(unit: string): Dimension | undefined {
  return UNIT_DEFS[unit]?.dimension;
}

/**
 * Convert a value between two canonical units of the same dimension.
 * Returns undefined if the units are unknown or incompatible.
 */
export function convert(value: number, from: string, to: string): number | undefined {
  const fromDef = UNIT_DEFS[from];
  const toDef = UNIT_DEFS[to];
  if (!fromDef || !toDef || fromDef.dimension !== toDef.dimension) return undefined;
  if (fromDef.dimension === 'temperature') {
    if (from === to) return value;
    return from === 'f' ? ((value - 32) * 5) / 9 : (value * 9) / 5 + 32;
  }
  return (value * fromDef.toBase) / toDef.toBase;
}
