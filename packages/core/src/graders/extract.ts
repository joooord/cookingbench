import { normalizeUnit } from './units.js';

export interface Quantity {
  value: number;
  /** Canonical unit id (g, ml, c, f, …) or undefined when none/unrecognized. */
  unit?: string;
  raw: string;
  index: number;
}

const UNICODE_FRACTIONS: Record<string, number> = {
  '½': 1 / 2, '⅓': 1 / 3, '⅔': 2 / 3, '¼': 1 / 4, '¾': 3 / 4,
  '⅕': 1 / 5, '⅖': 2 / 5, '⅗': 3 / 5, '⅘': 4 / 5,
  '⅙': 1 / 6, '⅚': 5 / 6, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
};

const FRACTION_CHARS = Object.keys(UNICODE_FRACTIONS).join('');

// Quantity token alternatives, in priority order:
//   1 1/2     mixed vulgar fraction
//   3/4       vulgar fraction
//   1,250.5   number with thousands separators
//   2½        number + unicode fraction (or bare number)
//   ½         bare unicode fraction
const NUMBER_RE = new RegExp(
  String.raw`(?<mixedWhole>\d+)\s+(?<mixedNum>\d+)\s*\/\s*(?<mixedDen>\d+)` +
    String.raw`|(?<fracNum>\d+)\s*\/\s*(?<fracDen>\d+)` +
    String.raw`|(?<thousands>\d{1,3}(?:,\d{3})+(?:\.\d+)?)` +
    String.raw`|(?<plain>\d+(?:\.\d+)?)\s?(?<plainFrac>[${FRACTION_CHARS}])?` +
    String.raw`|(?<bareFrac>[${FRACTION_CHARS}])`,
  'g',
);

// A unit token directly after a number: "g", "°F", "fl oz", "degrees Celsius"…
const UNIT_AFTER_RE = new RegExp(
  String.raw`^\s*(?:degrees?\s+)?(°\s*[A-Za-z]|fl\.?\s?oz\.?|[A-Za-z°]+)`,
);

function parseUnitAfter(text: string, from: number): { unit?: string; rawLen: number } {
  const slice = text.slice(from, from + 24);
  const m = UNIT_AFTER_RE.exec(slice);
  if (!m) return { rawLen: 0 };
  const unit = normalizeUnit(m[1]);
  // Unrecognized words after a number (e.g. "2 loaves") are not units — leave undefined.
  return unit ? { unit, rawLen: m[0].length } : { rawLen: 0 };
}

/** Extract all quantities (number + optional unit) from a piece of text. */
export function extractQuantities(text: string): Quantity[] {
  const out: Quantity[] = [];
  NUMBER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = NUMBER_RE.exec(text)) !== null) {
    const g = m.groups!;
    let value: number;
    if (g.mixedWhole !== undefined) {
      value = Number(g.mixedWhole) + Number(g.mixedNum) / Number(g.mixedDen);
    } else if (g.fracNum !== undefined) {
      value = Number(g.fracNum) / Number(g.fracDen);
    } else if (g.thousands !== undefined) {
      value = Number(g.thousands.replace(/,/g, ''));
    } else if (g.plain !== undefined) {
      value = Number(g.plain) + (g.plainFrac ? UNICODE_FRACTIONS[g.plainFrac]! : 0);
    } else {
      value = UNICODE_FRACTIONS[g.bareFrac!]!;
    }
    const end = m.index + m[0].length;
    const { unit, rawLen } = parseUnitAfter(text, end);
    out.push({
      value,
      unit,
      raw: text.slice(m.index, end + rawLen),
      index: m.index,
    });
  }
  return expandRanges(text, out);
}

// "165–170°F", "165-170 °F", "165 to 170°F": endpoints share the trailing unit,
// and a midpoint candidate is added (plan: ranges grade against midpoint or endpoints).
function expandRanges(text: string, quantities: Quantity[]): Quantity[] {
  const out: Quantity[] = [];
  for (let i = 0; i < quantities.length; i++) {
    const a = quantities[i]!;
    const b = quantities[i + 1];
    out.push(a);
    if (!b) continue;
    const between = text.slice(a.index + a.raw.length, b.index);
    if (/^\s*(?:[-–—]|to)\s*$/.test(between) && !a.unit && b.unit) {
      out.push({ ...a, unit: b.unit });
      out.push({
        value: (a.value + b.value) / 2,
        unit: b.unit,
        raw: `${a.raw}${between}${b.raw} (midpoint)`,
        index: a.index,
      });
    }
  }
  return out;
}

/**
 * Find the model's explicit final answer line, e.g. "Answer: 875 g".
 * Returns the text after the marker on the LAST such line, or undefined.
 */
export function findAnswerLine(text: string): string | undefined {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*\**\s*(?:final\s+)?answer\s*\**\s*[:=]\s*\**\s*(.+)$/i.exec(lines[i]!);
    if (m) return m[1]!.trim();
  }
  return undefined;
}

/**
 * The text to grade: the explicit answer line when present, otherwise the full
 * text (with quantities that literally restate prompt values excluded upstream).
 */
export function gradableScope(answerText: string): { text: string; usedAnswerLine: boolean } {
  const line = findAnswerLine(answerText);
  if (line) return { text: line, usedAnswerLine: true };
  return { text: answerText, usedAnswerLine: false };
}
