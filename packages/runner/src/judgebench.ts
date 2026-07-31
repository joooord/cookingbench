import { canonicalJson } from '@cookingbench/core';
import { sha256Hex } from './permit.js';
// Type-only, and by relative path for the reason `analyze.ts` documents: core's
// `exports` map exposes only `.`, and `index.ts` does not re-export
// `agreement.ts`. One line to change when it does.
import type { AgreementRating, AuditBallot } from '../../core/src/agreement.js';

/**
 * M2.7 — Culinary JudgeBench: the fixture format, the development/sealed split
 * and the harness that presents the bank to a panel.
 *
 * What this file will not do, and why it is written the way it is:
 *
 * **It cannot produce a gold label, and it is built so that nothing pretends
 * otherwise.** Every case declares `label: null` — a required, always-empty
 * field — and unknown keys are refused, so a case that arrives carrying
 * `expected`, `goldLabel` or any other smuggled answer key fails to load rather
 * than being merged. Gate 2 requires JudgeBench gold to come from independent
 * qualified humans; labels arrive separately through `judgeBenchLabelSetSchema`
 * in `agreement.ts`, which refuses `provenance: 'model'`. A jury validated
 * against labels a model produced is not validated, it is circular, and the
 * circularity would be invisible in the statistics.
 *
 * **Development and sealed material are separated by the type system, not by a
 * convention.** `DevelopmentBank` and `SealedBank` are distinct branded types
 * from distinct readers, neither assignable to the other, and the harness
 * accepts only a `DevelopmentBank` or an `OpenedSealedBank` — a brand reachable
 * *only* through `openSealedBank`, which enforces the pre-run hash commitment
 * and single-open. There is no path from a sealed bank file to a judged ballot
 * that does not pass the gate. `assertBanksDisjoint` closes the other leak,
 * which is not id collision but content: the same archived answer sitting in
 * both banks under two ids is a holdout that was not held out, and only a
 * content hash catches it.
 *
 * **A failed holdout is terminal.** `protocolClaimStatus` marks a protocol hash
 * permanently once an attempt under it fails, and `assertFreshHoldoutPermitted`
 * refuses a fresh tranche unless the protocol hash actually changed, the sealed
 * material actually changed, every prior attempt is disclosed by id, and the
 * re-freeze was done by somebody who did not do the last one. Re-running an
 * unchanged design until it passes is the easiest way there is to manufacture a
 * validated jury, and it leaves no trace unless the attempts are recorded.
 *
 * Everything here is pure: no I/O, no model calls, no clock, no unseeded
 * randomness. The harness plans and audits ballots; it does not fetch them.
 */

export type JudgeBenchErrorCode =
  | 'INVALID_BANK'
  | 'WRONG_TRANCHE'
  | 'BANK_OVERLAP'
  | 'INVALID_COMMITMENT'
  | 'COMMITMENT_MISMATCH'
  | 'ALREADY_OPENED'
  | 'TERMINAL_CLAIM'
  | 'DISCLOSURE_INCOMPLETE'
  | 'INVALID_HISTORY'
  | 'INVALID_PLAN'
  | 'BALLOT_CAPTURE';

export class JudgeBenchError extends Error {
  constructor(
    message: string,
    readonly code: JudgeBenchErrorCode,
  ) {
    super(message);
    this.name = 'JudgeBenchError';
  }
}

const HEX64 = /^[0-9a-f]{64}$/;

/* -------------------------------------------------------------------------- */
/* a hand-rolled validator, and why                                           */
/* -------------------------------------------------------------------------- */

/*
 * Same reason as `adjudicate.ts`: `packages/runner` does not depend on zod —
 * only `packages/core` does — so `import { z } from 'zod'` does not resolve in
 * this package at all. `firewall.ts` validates its registry by hand for the
 * same reason. The convention kept from the zod files is collecting every fault
 * and throwing once; an authored bank corrected one message per run takes as
 * many passes as it has mistakes.
 */

type Faults = string[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The `.strict()` equivalent, and load-bearing rather than tidy.
 *
 * The specific thing it stops: a case file that carries the answer under a key
 * this module does not know about — `expected`, `gold`, `correctOutcome`. A
 * permissive reader would drop it silently and the bank would look unlabelled
 * while the file on disk told any other reader what the answer was.
 */
function rejectUnknownKeys(o: Record<string, unknown>, allowed: readonly string[], path: string, faults: Faults): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) faults.push(`${path}.${key}: unknown field`);
  }
}

function reqString(o: Record<string, unknown>, key: string, path: string, faults: Faults): string | undefined {
  const v = o[key];
  if (typeof v !== 'string' || v.trim() === '') {
    faults.push(`${path}.${key}: expected a non-empty string, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

function optString(o: Record<string, unknown>, key: string, path: string, faults: Faults): string | undefined {
  if (o[key] === undefined) return undefined;
  return reqString(o, key, path, faults);
}

function reqBoolean(o: Record<string, unknown>, key: string, path: string, faults: Faults): boolean | undefined {
  const v = o[key];
  if (typeof v !== 'boolean') {
    faults.push(`${path}.${key}: expected a boolean, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

function reqInt(
  o: Record<string, unknown>,
  key: string,
  path: string,
  faults: Faults,
  min: number,
): number | undefined {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) {
    faults.push(`${path}.${key}: expected an integer ≥ ${min}, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

function reqEnum<T extends string>(
  o: Record<string, unknown>,
  key: string,
  path: string,
  faults: Faults,
  allowed: readonly T[],
): T | undefined {
  const v = o[key];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) {
    faults.push(`${path}.${key}: expected one of ${allowed.join(' | ')}, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v as T;
}

function reqHex64(o: Record<string, unknown>, key: string, path: string, faults: Faults): string | undefined {
  const v = o[key];
  if (typeof v !== 'string' || !HEX64.test(v)) {
    faults.push(`${path}.${key}: expected a 64-character sha256 hex digest, got ${JSON.stringify(v)}`);
    return undefined;
  }
  return v;
}

/* -------------------------------------------------------------------------- */
/* strata — M2.7's list, as a closed set                                      */
/* -------------------------------------------------------------------------- */

/**
 * The strata M2.7 names, plus `identical-answer-control`, which M2.7's sealed
 * composition list requires ("identical-answer and genuine-tie controls") even
 * though the development list folds it into "tie".
 *
 * A closed set on purpose. An open string would let a thin bank invent a
 * stratum name per case and report full coverage of everything.
 */
export const JUDGEBENCH_STRATA = [
  /** One of the declared capability axes — the ordinary content of the bank. */
  'capability-axis',
  /** Severity coverage: an item whose fault sits in a named severity band. */
  'severity',
  /** Two valid answers close enough that a coin-flip judge would look fine. */
  'close-valid-pair',
  /** Reads as sensible; contains a hazard. The set that must never false-accept. */
  'safe-looking-hidden-hazard',
  /** Same substance, one terse and one padded. Tests verbosity preference. */
  'concise-vs-padded',
  /** Plainly correct against polished and wrong. Tests style preference. */
  'plain-correct-vs-polished-wrong',
  /** An answer that names its own model or vendor. Tests blinding. */
  'self-identification',
  /** An answer instructing the judge. Tests prompt-injection resistance. */
  'prompt-injection',
  /** Right answer depends on culinary context, not a single global fact. */
  'culturally-contextual',
  /** Several legitimately correct answers. A judge insisting on one is wrong. */
  'multiple-legitimate-answers',
  /** A genuine tie: neither answer better. */
  'tie-control',
  /** Both answers unacceptable. Never storable as an ordinary tie (M2.1). */
  'both-bad',
  /** The right ballot is abstain — outside the judge's competence or coverage. */
  'abstention',
  /** Byte-identical answers. The panel must call it a tie ≥95% of the time. */
  'identical-answer-control',
] as const;
export type JudgeBenchStratum = (typeof JUDGEBENCH_STRATA)[number];

/** Strata that are meaningless without two answers to compare. */
const PAIR_STRATA: ReadonlySet<string> = new Set<JudgeBenchStratum>([
  'close-valid-pair',
  'concise-vs-padded',
  'plain-correct-vs-polished-wrong',
  'multiple-legitimate-answers',
  'tie-control',
  'both-bad',
  'identical-answer-control',
]);

export const JUDGEBENCH_TRANCHES = ['development', 'sealed-holdout'] as const;
export type JudgeBenchTranche = (typeof JUDGEBENCH_TRANCHES)[number];

export const JUDGEBENCH_MODES = ['fault-deduction', 'dimension', 'pairwise'] as const;
export type JudgeBenchMode = (typeof JUDGEBENCH_MODES)[number];

export const JUDGEBENCH_SEVERITIES = ['none', 'minor', 'major', 'critical'] as const;
export type JudgeBenchSeverity = (typeof JUDGEBENCH_SEVERITIES)[number];

/* -------------------------------------------------------------------------- */
/* the fixture                                                                */
/* -------------------------------------------------------------------------- */

export interface JudgeBenchAnswerSource {
  runId: string;
  questionId: string;
  modelId: string;
}

export interface JudgeBenchAnswer {
  text: string;
  origin: 'authored' | 'archived-run';
  /** Where an archived answer came from. Required when origin says so. */
  source?: JudgeBenchAnswerSource;
  /**
   * Candidate provider/base family. Used only for the sealed composition check
   * — M2.7 requires evidence for every candidate provider/base family — and
   * never shown to a judge.
   */
  candidateFamily?: string;
}

export interface JudgeBenchCase {
  caseId: string;
  /** Repeated on every case so a case cannot be moved between banks silently. */
  tranche: JudgeBenchTranche;
  strata: readonly JudgeBenchStratum[];
  /** The capability axis under test, from the approved axis list. */
  capabilityAxis: string;
  severity: JudgeBenchSeverity;
  mode: JudgeBenchMode;
  prompt: string;
  answers: readonly JudgeBenchAnswer[];
  /** Member of the critical safety/allergen set. */
  critical: boolean;
  /**
   * THE GOLD LABEL, AND IT IS ALWAYS NULL HERE.
   *
   * Required rather than absent, so every authored case has to state in the
   * file that it carries no answer key. Real labels arrive as a separate
   * `JudgeBenchLabelSet` from qualified humans and are joined at analysis time
   * by `caseId`; nothing in this repository writes one back into a bank.
   */
  label: null;
  notes?: string;
}

export interface JudgeBenchBank {
  version: 1;
  bankId: string;
  tranche: JudgeBenchTranche;
  authoredBy: string;
  createdAt: string;
  cases: readonly JudgeBenchCase[];
}

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;
const ANSWER_KEYS = ['text', 'origin', 'source', 'candidateFamily'] as const;
const SOURCE_KEYS = ['runId', 'questionId', 'modelId'] as const;
const CASE_KEYS = [
  'caseId',
  'tranche',
  'strata',
  'capabilityAxis',
  'severity',
  'mode',
  'prompt',
  'answers',
  'critical',
  'label',
  'notes',
] as const;
const BANK_KEYS = ['version', 'bankId', 'tranche', 'authoredBy', 'createdAt', 'cases'] as const;

function parseAnswer(value: unknown, path: string, faults: Faults): JudgeBenchAnswer | undefined {
  if (!isRecord(value)) {
    faults.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ANSWER_KEYS, path, faults);
  const text = reqString(value, 'text', path, faults);
  const origin = reqEnum(value, 'origin', path, faults, ['authored', 'archived-run'] as const);
  const candidateFamily = optString(value, 'candidateFamily', path, faults);
  let source: JudgeBenchAnswerSource | undefined;
  if (value['source'] !== undefined) {
    if (!isRecord(value['source'])) {
      faults.push(`${path}.source: expected an object`);
    } else {
      const s = value['source'];
      rejectUnknownKeys(s, SOURCE_KEYS, `${path}.source`, faults);
      const runId = reqString(s, 'runId', `${path}.source`, faults);
      const questionId = reqString(s, 'questionId', `${path}.source`, faults);
      const modelId = reqString(s, 'modelId', `${path}.source`, faults);
      if (runId && questionId && modelId) source = { runId, questionId, modelId };
    }
  }
  if (origin === 'archived-run' && source === undefined) {
    // Without the source triple the disjointness check degenerates to text
    // comparison alone, and a lightly reworded reuse slips between the banks.
    faults.push(
      `${path}.source: an archived answer must record the run, item and model it came from, or leakage between banks cannot be checked`,
    );
  }
  if (origin === 'authored' && value['source'] !== undefined) {
    faults.push(`${path}.source: an authored answer has no source run`);
  }
  if (text === undefined || origin === undefined) return undefined;
  return {
    text,
    origin,
    ...(source === undefined ? {} : { source }),
    ...(candidateFamily === undefined ? {} : { candidateFamily }),
  };
}

function parseCase(value: unknown, path: string, faults: Faults): JudgeBenchCase | undefined {
  if (!isRecord(value)) {
    faults.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(value, CASE_KEYS, path, faults);
  const caseId = value['caseId'];
  if (typeof caseId !== 'string' || !CASE_ID.test(caseId)) {
    faults.push(`${path}.caseId: must be 3–64 chars of [A-Za-z0-9._-] starting alphanumeric, got ${JSON.stringify(caseId)}`);
  }
  const tranche = reqEnum(value, 'tranche', path, faults, JUDGEBENCH_TRANCHES);
  const capabilityAxis = reqString(value, 'capabilityAxis', path, faults);
  const severity = reqEnum(value, 'severity', path, faults, JUDGEBENCH_SEVERITIES);
  const mode = reqEnum(value, 'mode', path, faults, JUDGEBENCH_MODES);
  const prompt = reqString(value, 'prompt', path, faults);
  const critical = reqBoolean(value, 'critical', path, faults);
  const notes = optString(value, 'notes', path, faults);

  if (!('label' in value)) {
    faults.push(`${path}.label: required, and must be null — every case states in the file that it carries no answer key`);
  } else if (value['label'] !== null) {
    faults.push(
      `${path}.label: must be null, got ${JSON.stringify(value['label'])} — gold labels come from qualified humans through a JudgeBench label set, never from a bank file`,
    );
  }

  const strata: JudgeBenchStratum[] = [];
  const rawStrata = value['strata'];
  if (!Array.isArray(rawStrata) || rawStrata.length === 0) {
    faults.push(`${path}.strata: expected a non-empty array`);
  } else {
    for (const [i, s] of rawStrata.entries()) {
      if (typeof s !== 'string' || !(JUDGEBENCH_STRATA as readonly string[]).includes(s)) {
        faults.push(`${path}.strata[${i}]: unknown stratum ${JSON.stringify(s)}`);
        continue;
      }
      if (strata.includes(s as JudgeBenchStratum)) {
        faults.push(`${path}.strata[${i}]: ${s} is declared twice, which would double-count its coverage`);
        continue;
      }
      strata.push(s as JudgeBenchStratum);
    }
  }

  const answers: JudgeBenchAnswer[] = [];
  const rawAnswers = value['answers'];
  if (!Array.isArray(rawAnswers) || rawAnswers.length === 0 || rawAnswers.length > 2) {
    faults.push(`${path}.answers: expected one or two answers, got ${Array.isArray(rawAnswers) ? rawAnswers.length : JSON.stringify(rawAnswers)}`);
  } else {
    rawAnswers.forEach((raw, i) => {
      const parsed = parseAnswer(raw, `${path}.answers[${i}]`, faults);
      if (parsed) answers.push(parsed);
    });
  }

  if (mode !== undefined && answers.length > 0) {
    const wanted = mode === 'pairwise' ? 2 : 1;
    if (answers.length !== wanted) {
      faults.push(`${path}.answers: a ${mode} case needs exactly ${wanted} answer(s), got ${answers.length}`);
    }
  }
  for (const stratum of strata) {
    if (PAIR_STRATA.has(stratum) && mode !== 'pairwise') {
      faults.push(`${path}.strata: stratum "${stratum}" compares two answers and cannot be exercised by a ${mode} case`);
    }
  }
  if (strata.includes('identical-answer-control')) {
    const [a, b] = answers;
    if (!a || !b || a.text !== b.text) {
      // The control's whole content is that the two texts are the same. A
      // "nearly identical" control measures nothing and would quietly relax
      // M2.8's ≥95% tie requirement into a similarity threshold.
      faults.push(`${path}.answers: an identical-answer control must carry two byte-identical answers`);
    }
  }
  if (severity !== undefined && critical !== undefined && (severity === 'critical') !== critical) {
    faults.push(
      `${path}.critical: severity ${severity} and critical=${critical} disagree; the critical set is defined by the severity, so one of the two is wrong`,
    );
  }
  if (critical === true && !strata.includes('safe-looking-hidden-hazard') && !strata.includes('severity')) {
    faults.push(
      `${path}.strata: a critical case must declare the stratum it powers (safe-looking-hidden-hazard or severity), or it counts towards no critical coverage requirement`,
    );
  }

  if (
    typeof caseId !== 'string' ||
    !CASE_ID.test(caseId) ||
    tranche === undefined ||
    capabilityAxis === undefined ||
    severity === undefined ||
    mode === undefined ||
    prompt === undefined ||
    critical === undefined ||
    strata.length === 0 ||
    answers.length === 0
  ) {
    return undefined;
  }
  return {
    caseId,
    tranche,
    strata,
    capabilityAxis,
    severity,
    mode,
    prompt,
    answers,
    critical,
    label: null,
    ...(notes === undefined ? {} : { notes }),
  };
}

function parseBank(value: unknown, expected: JudgeBenchTranche): JudgeBenchBank {
  const faults: Faults = [];
  if (!isRecord(value)) throw new JudgeBenchError('invalid JudgeBench bank: expected an object', 'INVALID_BANK');
  rejectUnknownKeys(value, BANK_KEYS, '(root)', faults);
  if (value['version'] !== 1) faults.push(`(root).version: expected 1, got ${JSON.stringify(value['version'])}`);
  const bankId = reqString(value, 'bankId', '(root)', faults);
  const tranche = reqEnum(value, 'tranche', '(root)', faults, JUDGEBENCH_TRANCHES);
  const authoredBy = reqString(value, 'authoredBy', '(root)', faults);
  const createdAt = reqString(value, 'createdAt', '(root)', faults);

  const cases: JudgeBenchCase[] = [];
  const rawCases = value['cases'];
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    faults.push('(root).cases: expected a non-empty array');
  } else {
    const ids = new Set<string>();
    const contents = new Map<string, string>();
    rawCases.forEach((raw, i) => {
      const parsed = parseCase(raw, `cases[${i}]`, faults);
      if (!parsed) return;
      if (tranche !== undefined && parsed.tranche !== tranche) {
        // The structural half of "development and sealed must not mix": a case
        // states its own tranche, so a copy-paste out of the sealed file into
        // the development file fails to load rather than joining the pool.
        faults.push(`cases[${i}].tranche: case ${parsed.caseId} declares "${parsed.tranche}" inside a "${tranche}" bank`);
        return;
      }
      if (ids.has(parsed.caseId)) {
        faults.push(`cases[${i}].caseId: duplicate caseId ${parsed.caseId}`);
        return;
      }
      ids.add(parsed.caseId);
      const key = contentKey(parsed);
      const prior = contents.get(key);
      if (prior) {
        // Two ids over one case inflates whatever stratum they both declare and
        // makes a repeat measurement look like independent evidence.
        faults.push(
          `cases[${i}]: case ${parsed.caseId} is the same material as ${prior}; a bank counting one case twice overstates its own stratum coverage`,
        );
        return;
      }
      contents.set(key, parsed.caseId);
      cases.push(parsed);
    });
  }

  if (faults.length > 0) {
    throw new JudgeBenchError(`invalid JudgeBench bank:\n- ${faults.join('\n- ')}`, 'INVALID_BANK');
  }
  if (tranche !== expected) {
    throw new JudgeBenchError(
      `bank ${bankId} is a "${tranche}" tranche and was read as "${expected}"; the two are never interchangeable`,
      'WRONG_TRANCHE',
    );
  }
  return { version: 1, bankId: bankId!, tranche: tranche!, authoredBy: authoredBy!, createdAt: createdAt!, cases };
}

/**
 * Identity of the *material*, not of the record.
 *
 * Case ids are free, so a sealed answer reappearing in the development pool
 * under a new id is invisible to an id check. Normalisation is deliberately
 * minimal — case-folding and whitespace collapse — because the aim is to catch
 * a copy that was reflowed or retitled, not to declare two genuinely different
 * answers the same. Stripping punctuation, for instance, would collide "1/2
 * tsp" with "1 2 tsp".
 */
export function contentKey(c: Pick<JudgeBenchCase, 'prompt' | 'answers'>): string {
  const normalise = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return sha256Hex(canonicalJson({ prompt: normalise(c.prompt), answers: c.answers.map((a) => normalise(a.text)) }));
}

/** Source triple of each archived answer. Authored answers contribute none. */
function sourceKeys(c: JudgeBenchCase): string[] {
  return c.answers
    .filter((a): a is JudgeBenchAnswer & { source: JudgeBenchAnswerSource } => a.source !== undefined)
    .map((a) => canonicalJson([a.source.runId, a.source.questionId, a.source.modelId]));
}

/* -------------------------------------------------------------------------- */
/* the branded banks                                                          */
/* -------------------------------------------------------------------------- */

declare const DEVELOPMENT_BRAND: unique symbol;
declare const SEALED_BRAND: unique symbol;
declare const OPENED_BRAND: unique symbol;

/** Material the panel may be tuned on. */
export type DevelopmentBank = JudgeBenchBank & { readonly [DEVELOPMENT_BRAND]: true };
/** Sealed material. Loaded, hashed and committed to — but NOT runnable. */
export type SealedBank = JudgeBenchBank & { readonly [SEALED_BRAND]: true };
/** Sealed material after a verified single open. The only runnable sealed form. */
export type OpenedSealedBank = SealedBank & { readonly [OPENED_BRAND]: true };

export function readDevelopmentBank(value: unknown): DevelopmentBank {
  return parseBank(value, 'development') as DevelopmentBank;
}

/**
 * Read sealed material.
 *
 * Note what this does NOT return: something the harness will accept. A sealed
 * bank has to go through `openSealedBank` first, which is where the commitment
 * check and the single-open rule live. Making the runnable form unreachable
 * except through that call is the difference between a rule and a habit.
 */
export function readSealedBank(value: unknown): SealedBank {
  return parseBank(value, 'sealed-holdout') as SealedBank;
}

/** sha256 over the canonical bank — what a pre-run commitment pins. */
export function bankHash(bank: JudgeBenchBank): string {
  return sha256Hex(canonicalJson(bank));
}

/**
 * Refuse any overlap between the two banks.
 *
 * Three separate leaks, because they fail differently:
 *  - a shared case id (the obvious one, and the least likely);
 *  - shared *content*, which is how a copy-paste with a new id gets in;
 *  - a shared archived source triple, which catches the same model answer to
 *    the same item pulled twice from the same run even if one copy was edited
 *    enough to change its content hash.
 */
export function assertBanksDisjoint(development: DevelopmentBank, sealed: SealedBank): void {
  const devIds = new Set(development.cases.map((c) => c.caseId));
  const devContent = new Map(development.cases.map((c) => [contentKey(c), c.caseId]));
  const devSources = new Map<string, string>();
  for (const c of development.cases) for (const key of sourceKeys(c)) devSources.set(key, c.caseId);

  const faults: string[] = [];
  for (const c of sealed.cases) {
    if (devIds.has(c.caseId)) faults.push(`case id ${c.caseId} appears in both banks`);
    const contentClash = devContent.get(contentKey(c));
    if (contentClash) {
      faults.push(`sealed case ${c.caseId} is the same material as development case ${contentClash}`);
    }
    for (const key of sourceKeys(c)) {
      const sourceClash = devSources.get(key);
      if (sourceClash) {
        faults.push(`sealed case ${c.caseId} and development case ${sourceClash} both use archived answer ${key}`);
      }
    }
  }
  if (faults.length > 0) {
    throw new JudgeBenchError(
      `development and sealed material overlap; the holdout would not be held out:\n- ${faults.join('\n- ')}`,
      'BANK_OVERLAP',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* sizing and composition                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The powered requirement Stage 4 fixes before the holdout is opened.
 *
 * Every number is declared. There is deliberately no default composition,
 * because M2.7 is explicit that "300 pairs × three labels = 900 expert
 * judgements" is planning arithmetic rather than a scientific constant, and a
 * default here would be exactly that number wearing a different hat.
 */
export interface SealedRequirement {
  /** Minimum cases per stratum. Every stratum needs an entry — see below. */
  perStratumMinimum: Partial<Record<JudgeBenchStratum, number>>;
  /** Minimum critical safety/allergen cases. */
  criticalMinimum: number;
  /** Preregistered repeat-judgement subset size. */
  repeatSubsetMinimum: number;
  /** Candidate provider/base families that must each be represented. */
  candidateFamilies: readonly string[];
  perFamilyMinimum: number;
  /** Where the precision analysis that produced these numbers lives. */
  poweredBy: string;
}

export interface CompositionAssessment {
  adequate: boolean;
  /** One line per shortfall, publishable as-is. Empty iff adequate. */
  shortfalls: readonly string[];
  counts: Readonly<Record<string, number>>;
}

/**
 * Does the sealed material actually support the claims M2.7 asks of it?
 *
 * An undeclared stratum minimum is a shortfall, not a pass. "Stage 4 never
 * powered this stratum" and "this stratum needs nothing" look identical in a
 * partial requirement object, and the first is by far the more likely.
 */
export function assessSealedComposition(bank: SealedBank, requirement: SealedRequirement): CompositionAssessment {
  const shortfalls: string[] = [];
  const counts: Record<string, number> = {};
  for (const stratum of JUDGEBENCH_STRATA) {
    counts[stratum] = bank.cases.filter((c) => c.strata.includes(stratum)).length;
  }
  counts['critical'] = bank.cases.filter((c) => c.critical).length;

  if (!requirement.poweredBy?.trim()) {
    shortfalls.push(
      'the requirement does not say where its powered numbers came from; a composition target with no precision analysis behind it is a guess',
    );
  }
  for (const stratum of JUDGEBENCH_STRATA) {
    const minimum = requirement.perStratumMinimum[stratum];
    if (minimum === undefined) {
      shortfalls.push(
        `stratum "${stratum}" has no declared minimum; Stage 4 must power every primary stratum before the holdout is opened`,
      );
      continue;
    }
    if (!Number.isInteger(minimum) || minimum < 0) {
      shortfalls.push(`stratum "${stratum}" has a non-integer or negative minimum (${minimum})`);
      continue;
    }
    if ((counts[stratum] ?? 0) < minimum) {
      shortfalls.push(`stratum "${stratum}" holds ${counts[stratum]} case(s) against a required ${minimum}`);
    }
  }
  if ((counts['critical'] ?? 0) < requirement.criticalMinimum) {
    shortfalls.push(`the critical safety set holds ${counts['critical']} case(s) against a required ${requirement.criticalMinimum}`);
  }
  if (requirement.candidateFamilies.length === 0) {
    shortfalls.push('no candidate provider/base families are declared, so per-family coverage cannot be checked');
  }
  for (const family of requirement.candidateFamilies) {
    const n = bank.cases.filter((c) => c.answers.some((a) => a.candidateFamily === family)).length;
    counts[`family:${family}`] = n;
    if (n < requirement.perFamilyMinimum) {
      shortfalls.push(`candidate family "${family}" appears in ${n} case(s) against a required ${requirement.perFamilyMinimum}`);
    }
  }
  if (bank.cases.filter((c) => c.mode === 'pairwise').length === 0) {
    shortfalls.push('the sealed bank holds no pairwise case, so neither the order audit nor the tie and both-bad controls can be run');
  }
  if (requirement.repeatSubsetMinimum > bank.cases.length) {
    shortfalls.push(`the preregistered repeat subset (${requirement.repeatSubsetMinimum}) is larger than the bank (${bank.cases.length})`);
  }
  return { adequate: shortfalls.length === 0, shortfalls, counts };
}

export interface DevelopmentSizing {
  sufficient: boolean;
  shortfalls: readonly string[];
}

/**
 * M2.7: author the development pool at two to three times the powered sealed
 * requirement, so weak, ambiguous or duplicative cases can be removed without
 * hollowing out a stratum.
 *
 * Checked per stratum rather than in total. A pool three times the size overall
 * but 1.1× on the hidden-hazard stratum is a pool that cannot afford to discard
 * a single bad hazard case, which is the stratum where discarding matters most.
 */
export const DEVELOPMENT_POOL_MULTIPLE = 2;

export function assessDevelopmentSizing(
  development: DevelopmentBank,
  requirement: SealedRequirement,
): DevelopmentSizing {
  const shortfalls: string[] = [];
  for (const stratum of JUDGEBENCH_STRATA) {
    const minimum = requirement.perStratumMinimum[stratum];
    if (minimum === undefined) {
      shortfalls.push(`stratum "${stratum}" has no declared sealed minimum, so the development pool cannot be sized against it`);
      continue;
    }
    const have = development.cases.filter((c) => c.strata.includes(stratum)).length;
    const want = minimum * DEVELOPMENT_POOL_MULTIPLE;
    if (have < want) {
      shortfalls.push(
        `development stratum "${stratum}" holds ${have} case(s) against ${want} (${DEVELOPMENT_POOL_MULTIPLE}× the sealed requirement of ${minimum})`,
      );
    }
  }
  return { sufficient: shortfalls.length === 0, shortfalls };
}

/* -------------------------------------------------------------------------- */
/* the pre-run commitment and single-open semantics                           */
/* -------------------------------------------------------------------------- */

export interface SealedCommitment {
  version: 1;
  commitmentId: string;
  bankId: string;
  /** sha256 of the canonical sealed bank, published BEFORE the holdout runs. */
  bankHash: string;
  /** Declared composition, so adequacy can be judged without opening. */
  caseCount: number;
  strataCounts: Readonly<Record<string, number>>;
  /** The preregistration this holdout is frozen against. */
  preregistration: string;
  /** sha256 of the frozen M2.8 release criteria, frozen before opening. */
  criteriaHash: string;
  /**
   * sha256 over the panel/protocol under test — seats, prompt versions, retry
   * policy, rubric. A failed holdout is terminal for THIS hash, which is why it
   * has to identify the design rather than name it.
   */
  protocolHash: string;
  frozenAt: string;
  frozenBy: string;
  /** M2.7's independent re-freeze. Must not be the person who froze it. */
  witnessedBy: string;
}

const COMMITMENT_KEYS = [
  'version',
  'commitmentId',
  'bankId',
  'bankHash',
  'caseCount',
  'strataCounts',
  'preregistration',
  'criteriaHash',
  'protocolHash',
  'frozenAt',
  'frozenBy',
  'witnessedBy',
] as const;

export function parseSealedCommitment(value: unknown): SealedCommitment {
  const faults: Faults = [];
  if (!isRecord(value)) throw new JudgeBenchError('invalid sealed commitment: expected an object', 'INVALID_COMMITMENT');
  rejectUnknownKeys(value, COMMITMENT_KEYS, '(root)', faults);
  if (value['version'] !== 1) faults.push(`(root).version: expected 1, got ${JSON.stringify(value['version'])}`);
  const commitmentId = reqString(value, 'commitmentId', '(root)', faults);
  const bankId = reqString(value, 'bankId', '(root)', faults);
  const hash = reqHex64(value, 'bankHash', '(root)', faults);
  const caseCount = reqInt(value, 'caseCount', '(root)', faults, 1);
  const preregistration = reqString(value, 'preregistration', '(root)', faults);
  const criteriaHash = reqHex64(value, 'criteriaHash', '(root)', faults);
  const protocolHash = reqHex64(value, 'protocolHash', '(root)', faults);
  const frozenAt = reqString(value, 'frozenAt', '(root)', faults);
  const frozenBy = reqString(value, 'frozenBy', '(root)', faults);
  const witnessedBy = reqString(value, 'witnessedBy', '(root)', faults);

  const strataCounts: Record<string, number> = {};
  const rawCounts = value['strataCounts'];
  if (!isRecord(rawCounts)) {
    faults.push('(root).strataCounts: expected an object');
  } else {
    for (const [key, n] of Object.entries(rawCounts)) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
        faults.push(`(root).strataCounts.${key}: expected a non-negative integer, got ${JSON.stringify(n)}`);
        continue;
      }
      strataCounts[key] = n;
    }
  }
  if (frozenBy !== undefined && frozenBy === witnessedBy) {
    faults.push('(root).witnessedBy: a freeze witnessed by the person who froze it is not an independent freeze');
  }
  if (faults.length > 0) {
    throw new JudgeBenchError(`invalid sealed commitment:\n- ${faults.join('\n- ')}`, 'INVALID_COMMITMENT');
  }
  return {
    version: 1,
    commitmentId: commitmentId!,
    bankId: bankId!,
    bankHash: hash!,
    caseCount: caseCount!,
    strataCounts,
    preregistration: preregistration!,
    criteriaHash: criteriaHash!,
    protocolHash: protocolHash!,
    frozenAt: frozenAt!,
    frozenBy: frozenBy!,
    witnessedBy: witnessedBy!,
  };
}

/** Build the commitment body for a bank. The caller publishes/signs it. */
export function commitmentFor(
  bank: SealedBank,
  meta: Omit<SealedCommitment, 'version' | 'bankHash' | 'bankId' | 'caseCount' | 'strataCounts'>,
): SealedCommitment {
  const strataCounts: Record<string, number> = {};
  for (const stratum of JUDGEBENCH_STRATA) {
    strataCounts[stratum] = bank.cases.filter((c) => c.strata.includes(stratum)).length;
  }
  return parseSealedCommitment({
    version: 1,
    bankId: bank.bankId,
    bankHash: bankHash(bank),
    caseCount: bank.cases.length,
    strataCounts,
    ...meta,
  });
}

export interface SealedAttempt {
  commitmentId: string;
  bankHash: string;
  protocolHash: string;
  preregistration: string;
  frozenBy: string;
  witnessedBy: string;
  openedAt: string;
  openedBy: string;
  /** Why this tranche was opened. */
  purpose: string;
  /** `open` until the holdout is scored. `fail` is terminal for the protocol. */
  verdict: 'open' | 'pass' | 'fail';
  /** Required on `fail`: what was diagnosed. */
  diagnosis?: string;
}

export interface SealedHistory {
  version: 1;
  attempts: readonly SealedAttempt[];
}

const ATTEMPT_KEYS = [
  'commitmentId',
  'bankHash',
  'protocolHash',
  'preregistration',
  'frozenBy',
  'witnessedBy',
  'openedAt',
  'openedBy',
  'purpose',
  'verdict',
  'diagnosis',
] as const;

function parseAttempt(value: unknown, path: string, faults: Faults): SealedAttempt | undefined {
  if (!isRecord(value)) {
    faults.push(`${path}: expected an object`);
    return undefined;
  }
  rejectUnknownKeys(value, ATTEMPT_KEYS, path, faults);
  const commitmentId = reqString(value, 'commitmentId', path, faults);
  const hash = reqHex64(value, 'bankHash', path, faults);
  const protocolHash = reqHex64(value, 'protocolHash', path, faults);
  const preregistration = reqString(value, 'preregistration', path, faults);
  const frozenBy = reqString(value, 'frozenBy', path, faults);
  const witnessedBy = reqString(value, 'witnessedBy', path, faults);
  const openedAt = reqString(value, 'openedAt', path, faults);
  const openedBy = reqString(value, 'openedBy', path, faults);
  const purpose = reqString(value, 'purpose', path, faults);
  const verdict = reqEnum(value, 'verdict', path, faults, ['open', 'pass', 'fail'] as const);
  const diagnosis = optString(value, 'diagnosis', path, faults);
  if (verdict === 'fail' && diagnosis === undefined) {
    // M2.7 permits a fresh holdout only after a *diagnosed* change. An
    // undiagnosed failure leaves nothing for the next attempt to change.
    faults.push(
      `${path}.diagnosis: a failed holdout must record its diagnosis; a fresh tranche is only permitted after a substantive diagnosed change`,
    );
  }
  if (
    commitmentId === undefined ||
    hash === undefined ||
    protocolHash === undefined ||
    preregistration === undefined ||
    frozenBy === undefined ||
    witnessedBy === undefined ||
    openedAt === undefined ||
    openedBy === undefined ||
    purpose === undefined ||
    verdict === undefined
  ) {
    return undefined;
  }
  return {
    commitmentId,
    bankHash: hash,
    protocolHash,
    preregistration,
    frozenBy,
    witnessedBy,
    openedAt,
    openedBy,
    purpose,
    verdict,
    ...(diagnosis === undefined ? {} : { diagnosis }),
  };
}

export const EMPTY_SEALED_HISTORY: SealedHistory = Object.freeze({
  version: 1 as const,
  attempts: Object.freeze([]) as readonly SealedAttempt[],
});

export function parseSealedHistory(value: unknown): SealedHistory {
  const faults: Faults = [];
  if (!isRecord(value)) throw new JudgeBenchError('invalid sealed-holdout history: expected an object', 'INVALID_HISTORY');
  rejectUnknownKeys(value, ['version', 'attempts'], '(root)', faults);
  if (value['version'] !== 1) faults.push(`(root).version: expected 1, got ${JSON.stringify(value['version'])}`);
  const attempts: SealedAttempt[] = [];
  const raw = value['attempts'];
  if (!Array.isArray(raw)) {
    faults.push('(root).attempts: expected an array');
  } else {
    const ids = new Set<string>();
    raw.forEach((entry, i) => {
      const parsed = parseAttempt(entry, `attempts[${i}]`, faults);
      if (!parsed) return;
      if (ids.has(parsed.commitmentId)) {
        // Two attempts under one commitment IS the second open. It is refused
        // at write time by `openSealedBank`; refusing it at read time too means
        // a hand-edited history cannot smuggle one back in.
        faults.push(`attempts[${i}].commitmentId: commitment ${parsed.commitmentId} appears twice; a sealed tranche is opened once`);
        return;
      }
      ids.add(parsed.commitmentId);
      attempts.push(parsed);
    });
    if (attempts.filter((a) => a.verdict === 'open').length > 1) {
      faults.push('(root).attempts: more than one holdout is open at once; parallel tranches make "the attempt that was disclosed" ambiguous');
    }
  }
  if (faults.length > 0) {
    throw new JudgeBenchError(`invalid sealed-holdout history:\n- ${faults.join('\n- ')}`, 'INVALID_HISTORY');
  }
  return { version: 1, attempts };
}

export type ProtocolClaimStatus = 'unclaimed' | 'open' | 'validated' | 'terminal';

/**
 * What may still be claimed for a given panel/protocol.
 *
 * `terminal` outranks `validated` deliberately. If a protocol failed a holdout
 * and later passed one under the same hash, the later attempt should never have
 * been permitted — and reporting it as validated would launder exactly the
 * retry-until-it-passes pattern M2.7 forbids.
 */
export function protocolClaimStatus(history: SealedHistory, protocolHash: string): ProtocolClaimStatus {
  const mine = history.attempts.filter((a) => a.protocolHash === protocolHash);
  if (mine.some((a) => a.verdict === 'fail')) return 'terminal';
  if (mine.some((a) => a.verdict === 'open')) return 'open';
  if (mine.some((a) => a.verdict === 'pass')) return 'validated';
  return 'unclaimed';
}

export interface OpenSealedInput {
  commitment: SealedCommitment;
  bank: SealedBank;
  history: SealedHistory;
  openedAt: string;
  openedBy: string;
  purpose: string;
}

export interface OpenSealedResult {
  bank: OpenedSealedBank;
  attempt: SealedAttempt;
  /** History with the attempt appended. The caller persists it. */
  history: SealedHistory;
}

/**
 * Open a sealed tranche, once.
 *
 * Every check here is a way the "held-out" claim can actually be broken, so
 * none of them are ceremonial:
 *
 *  - the bank must hash to the commitment. Otherwise "sealed" means "sealed
 *    until somebody edited it", and an edit after a disappointing dry run is
 *    both easy and invisible;
 *  - the declared composition must match the bank, which catches a hand-edited
 *    commitment whose hash was recomputed but whose counts were not;
 *  - the commitment must predate the open. A commitment timestamped after the
 *    material was seen is not a pre-run commitment;
 *  - the commitment id must not appear in the history. This is single-open, and
 *    it is enforced against the recorded attempts rather than a flag on the
 *    bank, because a flag lives in the same file somebody would edit;
 *  - the same bytes must not have been opened before under another id;
 *  - the protocol must not be terminal, and no other tranche may be open.
 */
export function openSealedBank(input: OpenSealedInput): OpenSealedResult {
  const { commitment, bank, history } = input;
  const actual = bankHash(bank);
  if (actual !== commitment.bankHash) {
    throw new JudgeBenchError(
      `sealed bank ${bank.bankId} hashes to ${actual.slice(0, 12)}… but commitment ${commitment.commitmentId} pins ${commitment.bankHash.slice(0, 12)}…; the material is not what was committed to`,
      'COMMITMENT_MISMATCH',
    );
  }
  if (commitment.bankId !== bank.bankId) {
    throw new JudgeBenchError(
      `commitment ${commitment.commitmentId} names bank ${commitment.bankId}, not ${bank.bankId}`,
      'COMMITMENT_MISMATCH',
    );
  }
  if (commitment.caseCount !== bank.cases.length) {
    throw new JudgeBenchError(
      `commitment ${commitment.commitmentId} declares ${commitment.caseCount} case(s); the bank holds ${bank.cases.length}`,
      'COMMITMENT_MISMATCH',
    );
  }
  for (const [stratum, declared] of Object.entries(commitment.strataCounts)) {
    const actualCount = bank.cases.filter((c) => (c.strata as readonly string[]).includes(stratum)).length;
    if (actualCount !== declared) {
      throw new JudgeBenchError(
        `commitment ${commitment.commitmentId} declares ${declared} case(s) in stratum "${stratum}"; the bank holds ${actualCount}`,
        'COMMITMENT_MISMATCH',
      );
    }
  }
  if (!(commitment.frozenAt <= input.openedAt)) {
    // ISO-8601 UTC strings compare lexicographically; anything that does not
    // compare fails this check, which is the safe direction.
    throw new JudgeBenchError(
      `commitment ${commitment.commitmentId} is dated ${commitment.frozenAt} but the open is dated ${input.openedAt}; a commitment made after the material was seen is not a pre-run commitment`,
      'INVALID_COMMITMENT',
    );
  }
  if (history.attempts.some((a) => a.commitmentId === commitment.commitmentId)) {
    throw new JudgeBenchError(
      `sealed tranche ${commitment.commitmentId} has already been opened; a holdout is opened once, and a second open is a development run wearing a holdout's name`,
      'ALREADY_OPENED',
    );
  }
  if (history.attempts.some((a) => a.bankHash === commitment.bankHash)) {
    throw new JudgeBenchError(
      `the material behind commitment ${commitment.commitmentId} has been opened before under a different commitment id; re-committing to the same bytes does not re-seal them`,
      'ALREADY_OPENED',
    );
  }
  if (protocolClaimStatus(history, commitment.protocolHash) === 'terminal') {
    throw new JudgeBenchError(
      `protocol ${commitment.protocolHash.slice(0, 12)}… already failed a sealed holdout; that failure is terminal for this panel/protocol claim and an unchanged design may not be retried`,
      'TERMINAL_CLAIM',
    );
  }
  if (history.attempts.some((a) => a.verdict === 'open')) {
    throw new JudgeBenchError(
      'another sealed tranche is still open; close it with a recorded verdict before opening a second',
      'ALREADY_OPENED',
    );
  }
  const attempt: SealedAttempt = {
    commitmentId: commitment.commitmentId,
    bankHash: commitment.bankHash,
    protocolHash: commitment.protocolHash,
    preregistration: commitment.preregistration,
    frozenBy: commitment.frozenBy,
    witnessedBy: commitment.witnessedBy,
    openedAt: input.openedAt,
    openedBy: input.openedBy,
    purpose: input.purpose,
    verdict: 'open',
  };
  return {
    bank: bank as OpenedSealedBank,
    attempt,
    history: { version: 1, attempts: [...history.attempts, attempt] },
  };
}

/**
 * Close an open attempt with its verdict.
 *
 * A recorded verdict is never rewritten. "It failed but we found a bug in the
 * harness" is the sentence this refusal exists to make somebody write down as a
 * new attempt rather than as an edit.
 */
export function recordHoldoutVerdict(
  history: SealedHistory,
  commitmentId: string,
  verdict: 'pass' | 'fail',
  diagnosis?: string,
): SealedHistory {
  const index = history.attempts.findIndex((a) => a.commitmentId === commitmentId);
  if (index < 0) {
    throw new JudgeBenchError(`no attempt recorded for commitment ${commitmentId}`, 'INVALID_HISTORY');
  }
  const attempt = history.attempts[index]!;
  if (attempt.verdict !== 'open') {
    throw new JudgeBenchError(
      `attempt ${commitmentId} already recorded a verdict of "${attempt.verdict}"; a sealed result is not revised in place`,
      'INVALID_HISTORY',
    );
  }
  if (verdict === 'fail' && (diagnosis === undefined || diagnosis.trim() === '')) {
    throw new JudgeBenchError(
      `recording a failure for ${commitmentId} requires a diagnosis; M2.7 permits a fresh tranche only after a substantive diagnosed change`,
      'INVALID_HISTORY',
    );
  }
  const updated: SealedAttempt = { ...attempt, verdict, ...(diagnosis === undefined ? {} : { diagnosis }) };
  const attempts = [...history.attempts];
  attempts[index] = updated;
  return { version: 1, attempts };
}

export interface FreshHoldoutChange {
  /** M2.7's four levers, exactly. Anything else is not a substantive change. */
  kind: 'panel' | 'prompt' | 'retry-policy' | 'rubric';
  diagnosis: string;
  /** Development evidence that the change addresses the diagnosis. */
  developmentEvidence: string;
  refrozenBy: string;
  independentOfPriorFreeze: boolean;
}

export interface FreshHoldoutProposal {
  commitment: SealedCommitment;
  /** Why a fresh tranche is being sought at all. */
  reason: 'prior-failure' | 'methodology-change';
  change: FreshHoldoutChange;
  /** Every prior attempt, by commitment id. M2.7 requires full disclosure. */
  disclosedAttempts: readonly string[];
}

const CHANGE_KINDS = ['panel', 'prompt', 'retry-policy', 'rubric'] as const;

function assertProposalShape(proposal: FreshHoldoutProposal): void {
  const faults: Faults = [];
  if (!proposal || typeof proposal !== 'object') {
    throw new JudgeBenchError('invalid fresh-holdout proposal: expected an object', 'INVALID_COMMITMENT');
  }
  if (proposal.reason !== 'prior-failure' && proposal.reason !== 'methodology-change') {
    faults.push(`reason: expected prior-failure | methodology-change, got ${JSON.stringify(proposal.reason)}`);
  }
  const c = proposal.change;
  if (!c || typeof c !== 'object') {
    faults.push('change: required');
  } else {
    if (!(CHANGE_KINDS as readonly string[]).includes(c.kind)) {
      faults.push(`change.kind: expected one of ${CHANGE_KINDS.join(' | ')}, got ${JSON.stringify(c.kind)}`);
    }
    if (!c.diagnosis?.trim()) faults.push('change.diagnosis: required');
    if (!c.developmentEvidence?.trim()) faults.push('change.developmentEvidence: required');
    if (!c.refrozenBy?.trim()) faults.push('change.refrozenBy: required');
    if (typeof c.independentOfPriorFreeze !== 'boolean') faults.push('change.independentOfPriorFreeze: expected a boolean');
  }
  if (!Array.isArray(proposal.disclosedAttempts) || proposal.disclosedAttempts.some((id) => typeof id !== 'string' || !id.trim())) {
    faults.push('disclosedAttempts: expected an array of non-empty commitment ids (pass [] only when there are genuinely none)');
  }
  if (faults.length > 0) {
    throw new JudgeBenchError(`invalid fresh-holdout proposal:\n- ${faults.join('\n- ')}`, 'INVALID_COMMITMENT');
  }
  // Re-parsing the commitment here rather than trusting the caller: a proposal
  // is the one place a commitment arrives having never been read from a file.
  parseSealedCommitment(proposal.commitment);
}

/**
 * May a fresh sealed tranche be opened at all?
 *
 * M2.7's conditions, each turned into something checkable rather than asserted:
 * a substantive diagnosed change (the protocol hash must actually differ — a
 * cosmetically renamed design hashes the same), development evidence, full
 * disclosure of every prior attempt (checked by id against the history, so an
 * omission is caught rather than trusted), independent re-freeze, and new
 * preregistration. The sealed material itself must also be new: reopening the
 * same bytes under a new commitment is the same holdout twice.
 */
export function assertFreshHoldoutPermitted(history: SealedHistory, proposal: FreshHoldoutProposal): void {
  assertProposalShape(proposal);
  const faults: string[] = [];

  if (history.attempts.length === 0) {
    faults.push('no prior attempt exists, so this is a first holdout rather than a fresh one; open it directly');
  }
  if (history.attempts.some((a) => a.verdict === 'open')) {
    faults.push('a prior tranche is still open; its verdict must be recorded before a fresh one is proposed');
  }

  const last = history.attempts[history.attempts.length - 1];
  if (proposal.reason === 'prior-failure') {
    if (!last || last.verdict !== 'fail') {
      faults.push('the proposal cites a prior failure, but the most recent attempt did not fail');
    } else if (!last.diagnosis) {
      faults.push('the prior failure has no recorded diagnosis, so no change can be shown to address it');
    }
  }

  const priorIds = history.attempts.map((a) => a.commitmentId);
  const disclosed = new Set(proposal.disclosedAttempts);
  const undisclosed = priorIds.filter((id) => !disclosed.has(id));
  if (undisclosed.length > 0) {
    faults.push(`prior attempt(s) ${undisclosed.join(', ')} are not disclosed; M2.7 requires disclosure of every prior attempt`);
  }
  const invented = proposal.disclosedAttempts.filter((id) => !priorIds.includes(id));
  if (invented.length > 0) {
    faults.push(`disclosed attempt(s) ${invented.join(', ')} are not in the recorded history`);
  }

  if (priorIds.includes(proposal.commitment.commitmentId)) {
    faults.push(`commitment ${proposal.commitment.commitmentId} has been used before`);
  }
  if (history.attempts.some((a) => a.preregistration === proposal.commitment.preregistration)) {
    faults.push(
      `preregistration ${proposal.commitment.preregistration} was used for an earlier attempt; a fresh tranche needs a new preregistration`,
    );
  }
  if (history.attempts.some((a) => a.bankHash === proposal.commitment.bankHash)) {
    faults.push('the proposed sealed material has been opened before; fresh material is required, not a fresh label on the same bytes');
  }
  const terminal = protocolClaimStatus(history, proposal.commitment.protocolHash) === 'terminal';
  if (terminal) {
    faults.push(
      `protocol ${proposal.commitment.protocolHash.slice(0, 12)}… already failed; an identical protocol hash means the change was cosmetic, and the failure is terminal for it`,
    );
  }
  if (!proposal.change.independentOfPriorFreeze) {
    faults.push('the re-freeze is not declared independent of the prior one');
  }
  const priorFreezers = new Set(history.attempts.flatMap((a) => [a.frozenBy, a.witnessedBy]));
  if (priorFreezers.has(proposal.change.refrozenBy)) {
    faults.push(`${proposal.change.refrozenBy} was involved in an earlier freeze; the re-freeze must be independent`);
  }

  if (faults.length > 0) {
    throw new JudgeBenchError(
      `a fresh sealed holdout is not permitted:\n- ${faults.join('\n- ')}`,
      terminal ? 'TERMINAL_CLAIM' : 'DISCLOSURE_INCOMPLETE',
    );
  }
}

/* -------------------------------------------------------------------------- */
/* the harness                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `'ab' | 'ba'` to match `graders/pairwise.ts` and `agreement.ts`, which is
 * where these ballots go.
 *
 * NOTE for the integration pass: `judge.ts` spells the same concept
 * `'AB' | 'BA'`. Two spellings of one enum across three modules is a bug
 * waiting for an `===`; they should be reconciled. This module follows the
 * agreement path because that is its consumer.
 */
export type HarnessPresentation = 'ab' | 'ba' | 'single';

export interface HarnessTask {
  /** `${caseId}|${presentation}|r${replicate}`. Stable and readable. */
  taskId: string;
  caseId: string;
  presentation: HarnessPresentation;
  /** 0 for the first pass, 1 for the preregistered repeat. */
  replicate: 0 | 1;
}

export interface HarnessPlan {
  bankId: string;
  tranche: JudgeBenchTranche;
  seed: string;
  /** Cases in the preregistered repeat subset, sorted. */
  repeatSubset: readonly string[];
  repeatPreregisteredIn: string;
  tasks: readonly HarnessTask[];
}

export interface HarnessOptions {
  seed: string;
  /** Share of cases judged twice. Declared, and must be > 0 — see below. */
  repeatFraction: number;
  /** Where the repeat subset was preregistered. */
  repeatPreregisteredIn: string;
}

function taskIdFor(caseId: string, presentation: HarnessPresentation, replicate: number): string {
  return `${caseId}|${presentation}|r${replicate}`;
}

/**
 * FNV-1a over a per-task string, mapped to [0,1).
 *
 * A private copy rather than an import, for the reason `agreement.ts` documents
 * about its own: this module has no other dependency on `stats.ts`, and the
 * hash has to stay byte-stable for the repeat subset to be reproducible.
 */
function hash01(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/**
 * Plan every ballot the bank requires.
 *
 * Two things this does that a naive loop would not:
 *
 *  - every pairwise case is planned in BOTH orders. M2.8 requires both answer
 *    orders (or a separately powered order audit), and the two presentations
 *    fold into one rater unit downstream — so a plan emitting one order
 *    silently converts an order audit into extra apparent sample size;
 *  - the repeat subset is drawn per case from a seeded hash, and when a case is
 *    repeated, ALL of its presentations are repeated. Repeating one order of a
 *    pair measures neither repeat consistency nor order stability cleanly.
 *
 * Accepts a development bank or an OPENED sealed bank. A `SealedBank` that has
 * not been through `openSealedBank` is not assignable here, which is the point.
 */
export function buildHarnessPlan(bank: DevelopmentBank | OpenedSealedBank, options: HarnessOptions): HarnessPlan {
  if (!options?.seed?.trim()) throw new JudgeBenchError('harness seed must be a non-empty string', 'INVALID_PLAN');
  if (
    typeof options.repeatFraction !== 'number' ||
    !Number.isFinite(options.repeatFraction) ||
    options.repeatFraction <= 0 ||
    options.repeatFraction > 1
  ) {
    // Zero is refused rather than read as "repeats off": M2.8 requires a
    // repeat-judgement consistency figure, and a plan with no repeats cannot
    // produce one — it produces a missing measurement, which the release
    // evaluator turns into `incomplete`, not into a pass.
    throw new JudgeBenchError(
      `repeatFraction must be in (0, 1]; got ${JSON.stringify(options.repeatFraction)} (M2.8 requires a repeat-judgement consistency measurement, which a plan with no repeats cannot supply)`,
      'INVALID_PLAN',
    );
  }
  if (!options.repeatPreregisteredIn?.trim()) {
    throw new JudgeBenchError(
      'the repeat subset must name where it was preregistered; a subset chosen after the first pass is not a repeat measurement',
      'INVALID_PLAN',
    );
  }

  const ordered = [...bank.cases].sort((a, b) => a.caseId.localeCompare(b.caseId));
  const target = Math.max(1, Math.min(ordered.length, Math.ceil(options.repeatFraction * ordered.length)));
  const repeatSubset = [...ordered]
    .sort((a, b) => {
      const ha = hash01(`${options.seed}:repeat:${a.caseId}`);
      const hb = hash01(`${options.seed}:repeat:${b.caseId}`);
      return ha === hb ? a.caseId.localeCompare(b.caseId) : ha - hb;
    })
    .slice(0, target)
    .map((c) => c.caseId)
    .sort();
  const repeated = new Set(repeatSubset);

  const tasks: HarnessTask[] = [];
  for (const c of ordered) {
    const presentations: HarnessPresentation[] = c.mode === 'pairwise' ? ['ab', 'ba'] : ['single'];
    const replicates: Array<0 | 1> = repeated.has(c.caseId) ? [0, 1] : [0];
    for (const replicate of replicates) {
      for (const presentation of presentations) {
        tasks.push({ taskId: taskIdFor(c.caseId, presentation, replicate), caseId: c.caseId, presentation, replicate });
      }
    }
  }
  return {
    bankId: bank.bankId,
    tranche: bank.tranche,
    seed: options.seed,
    repeatSubset,
    repeatPreregisteredIn: options.repeatPreregisteredIn,
    tasks,
  };
}

export interface HarnessResult {
  taskId: string;
  /** The seat that produced it. One rater unit per (case, rater). */
  rater: string;
  /**
   * Did a structured ballot come back after the documented retry rule? `false`
   * is a capture failure — distinct from a captured abstention, which is `true`
   * with the value `'abstain'`.
   */
  captured: boolean;
  /**
   * The ballot value: a positional pairwise outcome from core's
   * `PAIRWISE_OUTCOMES` (`a`, `b`, `equal`, `both_unacceptable`, `abstain`) or
   * an anchored 0–4 band. `null` only when `captured` is false.
   *
   * `a` here means "the answer shown first", not candidate A — canonicalisation
   * happens downstream in `agreement.ts`, and doing it twice would undo it.
   */
  value: number | string | null;
}

/**
 * M2.8's first release criterion: 100% structured ballot capture after the
 * documented retry rule.
 *
 * Enforced as an assertion rather than as a percentage, because a bank judged
 * at 98% capture has 2% of its cases missing non-randomly — the ones that broke
 * the parser, which skew hard towards the long, the adversarial and the
 * prompt-injecting. Averaging over what came back reports the easy subset.
 */
export function assertHarnessComplete(
  plan: HarnessPlan,
  results: readonly HarnessResult[],
  raters: readonly string[],
): void {
  if (raters.length === 0) throw new JudgeBenchError('no raters declared for the harness', 'INVALID_PLAN');
  const seen = new Set(results.map((r) => `${r.taskId} ${r.rater}`));
  const planned = new Set(plan.tasks.map((t) => t.taskId));
  const missing: string[] = [];
  for (const task of plan.tasks) {
    for (const rater of raters) {
      if (!seen.has(`${task.taskId} ${rater}`)) missing.push(`${task.taskId} / ${rater}`);
    }
  }
  const uncaptured = results.filter((r) => !r.captured).map((r) => `${r.taskId} / ${r.rater}`);
  const unknown = [...new Set(results.filter((r) => !planned.has(r.taskId)).map((r) => r.taskId))];
  const valueless = results.filter((r) => r.captured && r.value === null).map((r) => `${r.taskId} / ${r.rater}`);

  const faults: string[] = [];
  if (missing.length > 0) {
    faults.push(`${missing.length} planned ballot(s) never returned: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''}`);
  }
  if (uncaptured.length > 0) {
    faults.push(
      `${uncaptured.length} ballot(s) failed structured capture: ${uncaptured.slice(0, 5).join(', ')}${uncaptured.length > 5 ? ', …' : ''}`,
    );
  }
  if (unknown.length > 0) {
    faults.push(`${unknown.length} result(s) are for tasks not in the plan: ${unknown.slice(0, 5).join(', ')}`);
  }
  if (valueless.length > 0) {
    faults.push(
      `${valueless.length} ballot(s) claim capture with no value; an abstention is the outcome 'abstain', not an absent value`,
    );
  }
  if (faults.length > 0) {
    throw new JudgeBenchError(
      `harness ballot capture is incomplete (M2.8 requires 100% after the documented retry rule):\n- ${faults.join('\n- ')}`,
      'BALLOT_CAPTURE',
    );
  }
}

export interface HarnessRatings {
  /** Non-pairwise cases, one rating per (case, rater), ready for alpha. */
  ratings: readonly AgreementRating[];
  /**
   * Pairwise ballots, uncanonicalised and unfolded, for
   * `pairwiseRatingsForAgreement` in agreement.ts. Deliberately NOT folded
   * here: collapsing two presentations into a rater unit is one implementation
   * in agreement.ts and a second copy would drift.
   */
  pairwiseBallots: readonly AuditBallot[];
  /** Which replicate these came from, so repeat consistency is measurable. */
  replicate: 0 | 1;
}

/**
 * Turn captured ballots into the shapes `agreement.ts` consumes, for ONE
 * replicate.
 *
 * Split by replicate rather than merged: a rater's second pass over the same
 * case is a repeat-judgement observation, and `judgeBenchLabelSetSchema`
 * already refuses the same rater labelling a case twice for exactly this reason
 * — folding it into the reliability matrix counts one person as two and
 * inflates alpha.
 */
export function harnessRatings(
  bank: DevelopmentBank | OpenedSealedBank,
  plan: HarnessPlan,
  results: readonly HarnessResult[],
  replicate: 0 | 1,
): HarnessRatings {
  if (plan.bankId !== bank.bankId) {
    throw new JudgeBenchError(`plan is for bank ${plan.bankId}, not ${bank.bankId}`, 'INVALID_PLAN');
  }
  const caseById = new Map(bank.cases.map((c) => [c.caseId, c]));
  const taskById = new Map(plan.tasks.map((t) => [t.taskId, t]));
  const ratings: AgreementRating[] = [];
  const pairwiseBallots: AuditBallot[] = [];
  for (const r of results) {
    const task = taskById.get(r.taskId);
    if (!task) {
      throw new JudgeBenchError(`result references task ${r.taskId}, which is not in the plan`, 'INVALID_PLAN');
    }
    if (task.replicate !== replicate) continue;
    const c = caseById.get(task.caseId);
    if (!c) {
      throw new JudgeBenchError(`plan references case ${task.caseId}, which is not in bank ${bank.bankId}`, 'INVALID_PLAN');
    }
    if (!r.captured || r.value === null) {
      throw new JudgeBenchError(
        `ballot ${r.taskId} / ${r.rater} was never captured; run assertHarnessComplete before deriving ratings rather than analysing whatever came back`,
        'BALLOT_CAPTURE',
      );
    }
    if (c.mode === 'pairwise') {
      if (task.presentation === 'single') {
        throw new JudgeBenchError(`pairwise case ${c.caseId} has a 'single' presentation task`, 'INVALID_PLAN');
      }
      pairwiseBallots.push({
        unit: c.caseId,
        family: c.capabilityAxis,
        judge: r.rater,
        presentation: task.presentation,
        outcome: r.value as AuditBallot['outcome'],
      });
    } else {
      ratings.push({ unit: c.caseId, rater: r.rater, value: r.value, family: c.capabilityAxis });
    }
  }
  return { ratings, pairwiseBallots, replicate };
}

/* -------------------------------------------------------------------------- */
/* reporting                                                                  */
/* -------------------------------------------------------------------------- */

export function formatBankSummary(bank: JudgeBenchBank): string[] {
  const lines: string[] = [];
  lines.push(
    `JudgeBench bank ${bank.bankId} — ${bank.tranche}, ${bank.cases.length} case(s), authored by ${bank.authoredBy}`,
  );
  for (const stratum of JUDGEBENCH_STRATA) {
    lines.push(`  ${stratum.padEnd(34)} ${bank.cases.filter((c) => c.strata.includes(stratum)).length}`);
  }
  lines.push(`  ${'critical safety cases'.padEnd(34)} ${bank.cases.filter((c) => c.critical).length}`);
  lines.push(
    '  NOTE: every case carries label: null by construction. Gold labels are an input from qualified humans ' +
      '(agreement.ts judgeBenchLabelSetSchema), never a product of this repository.',
  );
  return lines;
}

export function formatSealedHistory(history: SealedHistory): string[] {
  if (history.attempts.length === 0) return ['No sealed holdout has ever been opened.'];
  const lines = [`${history.attempts.length} sealed holdout attempt(s), oldest first:`];
  for (const a of history.attempts) {
    lines.push(
      `  ${a.commitmentId}  protocol ${a.protocolHash.slice(0, 12)}…  opened ${a.openedAt} by ${a.openedBy}  verdict ${a.verdict}` +
        (a.diagnosis ? `\n    diagnosis: ${a.diagnosis}` : ''),
    );
  }
  return lines;
}
