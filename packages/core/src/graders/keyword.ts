import type { GradeResult, GraderSpec } from '../types.js';

type KeywordSpec = Extract<GraderSpec, { type: 'keyword' }>;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ');
}

const NEGATION_BEFORE = /(?:\bno\b|\bnot\b|\bnever\b|\bwithout\b|\bavoid(?:ing|s)?\b|\bfree of\b|\binstead of\b|\bskip(?:ping)?\b|\bomit(?:ting)?\b|\bzero\b|\bdon'?t\b|\bcannot\b|\bcan'?t\b)[^.!?\n]*$/;

/**
 * A forbidden term only counts when it is actually being used, not negated:
 * "ensure it's peanut-free" or "avoid whole grapes" must not zero the answer.
 */
function isNegatedAt(haystack: string, index: number, termLength: number): boolean {
  const before = haystack.slice(Math.max(0, index - 60), index);
  if (NEGATION_BEFORE.test(before)) return true;
  const after = haystack.slice(index + termLength, index + termLength + 8);
  return /^[\s-]*free\b/.test(after);
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[a-z0-9]/.test(ch);
}

// Forbidden terms match whole words only: 'ice' must not hit "rice", and
// 'onion' must not hit "spring onions". List plurals explicitly when needed.
function hasForbiddenUse(haystack: string, term: string): boolean {
  let from = 0;
  while (true) {
    const index = haystack.indexOf(term, from);
    if (index === -1) return false;
    const bounded =
      !isWordChar(haystack[index - 1]) && !isWordChar(haystack[index + term.length]);
    if (bounded && !isNegatedAt(haystack, index, term.length)) return true;
    from = index + term.length;
  }
}

/**
 * required: outer AND, inner OR (synonym groups). Score is the fraction of
 * groups satisfied. Any forbidden term present (and not negated) zeroes the
 * question — used for actively unsafe advice and constraint violations.
 */
export function gradeKeyword(spec: KeywordSpec, answerText: string): GradeResult {
  const haystack = normalize(answerText);

  const forbiddenHits = (spec.forbidden ?? []).filter((term) =>
    hasForbiddenUse(haystack, normalize(term)),
  );
  if (forbiddenHits.length > 0) {
    return { score: 0, detail: { forbiddenHits } };
  }

  const required = spec.required ?? [];
  // Forbidden-only graders (common in recipe constraint checks): passing means
  // no banned term was used.
  if (required.length === 0) {
    return { score: 100, detail: { forbiddenOnly: true } };
  }
  const groups = required.map((synonyms) => {
    const hit = synonyms.find((term) => haystack.includes(normalize(term)));
    return { synonyms, hit: hit ?? null };
  });
  const satisfied = groups.filter((g) => g.hit !== null).length;
  return {
    score: (satisfied / required.length) * 100,
    detail: { groups },
  };
}
