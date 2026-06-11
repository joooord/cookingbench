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

/**
 * required: outer AND, inner OR (synonym groups). Score is the fraction of
 * groups satisfied. Any forbidden term present zeroes the question — used for
 * actively unsafe advice.
 */
export function gradeKeyword(spec: KeywordSpec, answerText: string): GradeResult {
  const haystack = normalize(answerText);

  const forbiddenHits = (spec.forbidden ?? []).filter((term) =>
    haystack.includes(normalize(term)),
  );
  if (forbiddenHits.length > 0) {
    return { score: 0, detail: { forbiddenHits } };
  }

  const groups = spec.required.map((synonyms) => {
    const hit = synonyms.find((term) => haystack.includes(normalize(term)));
    return { synonyms, hit: hit ?? null };
  });
  const satisfied = groups.filter((g) => g.hit !== null).length;
  return {
    score: (satisfied / spec.required.length) * 100,
    detail: { groups },
  };
}
