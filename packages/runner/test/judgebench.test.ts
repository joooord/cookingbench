import { describe, expect, it } from 'vitest';
import {
  DEVELOPMENT_POOL_MULTIPLE,
  EMPTY_SEALED_HISTORY,
  JudgeBenchError,
  JUDGEBENCH_STRATA,
  assertBanksDisjoint,
  assertFreshHoldoutPermitted,
  assertHarnessComplete,
  assessDevelopmentSizing,
  assessSealedComposition,
  bankHash,
  buildHarnessPlan,
  commitmentFor,
  contentKey,
  formatBankSummary,
  harnessRatings,
  openSealedBank,
  parseSealedCommitment,
  parseSealedHistory,
  protocolClaimStatus,
  readDevelopmentBank,
  readSealedBank,
  recordHoldoutVerdict,
  type FreshHoldoutProposal,
  type HarnessResult,
  type JudgeBenchTranche,
  type SealedCommitment,
  type SealedHistory,
  type SealedRequirement,
} from '../src/judgebench.js';

/**
 * These tests try to get sealed material judged twice, to get development
 * material into the holdout, to get a gold label into a bank file, and to get a
 * failed protocol a second attempt under a new name. The passing cases exist to
 * prove the refusals are discriminating rather than total.
 */

const HEX_A = 'a'.repeat(64);
const HEX_B = 'b'.repeat(64);
const HEX_C = 'c'.repeat(64);

function rawCase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    caseId: 'dev-001',
    tranche: 'development',
    strata: ['capability-axis'],
    capabilityAxis: 'technique',
    severity: 'minor',
    mode: 'dimension',
    prompt: 'Why did the hollandaise split?',
    answers: [{ text: 'The butter went in too fast and too hot.', origin: 'authored' }],
    critical: false,
    label: null,
    ...over,
  };
}

function rawBank(
  tranche: JudgeBenchTranche,
  cases: Record<string, unknown>[],
  bankId = `bank-${tranche}`,
): Record<string, unknown> {
  return {
    version: 1,
    bankId,
    tranche,
    authoredBy: 'panel of two chefs and a food scientist',
    createdAt: '2026-08-01',
    cases: cases.map((c) => ({ ...c, tranche })),
  };
}

const devBank = (cases: Record<string, unknown>[] = [rawCase()]) => readDevelopmentBank(rawBank('development', cases));
const sealedBank = (cases: Record<string, unknown>[]) => readSealedBank(rawBank('sealed-holdout', cases));

/** A minimal two-case sealed bank: one dimension case and one pairwise pair. */
function sealedTwo() {
  return sealedBank([
    rawCase({ caseId: 'seal-001', prompt: 'Sealed: why did the custard curdle?' }),
    rawCase({
      caseId: 'seal-002',
      mode: 'pairwise',
      strata: ['close-valid-pair'],
      prompt: 'Sealed: which braise is better?',
      answers: [
        { text: 'Sear first, then braise at 150 °C.', origin: 'authored', candidateFamily: 'fam-x' },
        { text: 'Braise low from cold, finish under the grill.', origin: 'authored', candidateFamily: 'fam-y' },
      ],
    }),
  ]);
}

function commitment(over: Partial<SealedCommitment> = {}): SealedCommitment {
  return commitmentFor(sealedTwo(), {
    commitmentId: 'commit-1',
    preregistration: 'prereg-1',
    criteriaHash: HEX_B,
    protocolHash: HEX_C,
    frozenAt: '2026-08-01T00:00:00Z',
    frozenBy: 'measurement lead',
    witnessedBy: 'independent statistician',
    ...over,
  });
}

/* -------------------------------------------------------------------------- */

describe('the label field', () => {
  it('refuses a case that carries a gold label', () => {
    expect(() => devBank([rawCase({ label: 'a' })])).toThrowError(/gold labels come from qualified humans/);
  });

  it('refuses a case with no label field at all', () => {
    const { label: _dropped, ...noLabel } = rawCase();
    expect(() => devBank([noLabel])).toThrowError(/label: required, and must be null/);
  });

  it('refuses a label smuggled under another key rather than ignoring it', () => {
    // The realistic failure: a permissive reader drops `expected`, the bank
    // looks unlabelled, and the file on disk tells any other reader the answer.
    expect(() => devBank([rawCase({ expected: 'a' })])).toThrowError(/expected: unknown field/);
    expect(() => devBank([rawCase({ goldLabel: 4 })])).toThrowError(/goldLabel: unknown field/);
  });

  it('says so in the printed summary', () => {
    expect(formatBankSummary(devBank()).join('\n')).toMatch(/label: null by construction/);
  });
});

describe('case fixture refusals', () => {
  it('refuses an identical-answer control whose answers are not identical', () => {
    expect(() =>
      devBank([
        rawCase({
          mode: 'pairwise',
          strata: ['identical-answer-control'],
          answers: [
            { text: 'Rest the meat for 20 minutes.', origin: 'authored' },
            { text: 'Rest the meat for 20 min.', origin: 'authored' },
          ],
        }),
      ]),
    ).toThrowError(/byte-identical/);
  });

  it('accepts an identical-answer control that really is identical', () => {
    const text = 'Rest the meat for 20 minutes.';
    const bank = devBank([
      rawCase({
        mode: 'pairwise',
        strata: ['identical-answer-control'],
        answers: [
          { text, origin: 'authored' },
          { text, origin: 'authored' },
        ],
      }),
    ]);
    expect(bank.cases).toHaveLength(1);
  });

  it('refuses a two-answer stratum on a single-answer mode', () => {
    expect(() => devBank([rawCase({ strata: ['concise-vs-padded'] })])).toThrowError(/cannot be exercised by a dimension case/);
  });

  it('refuses a pairwise case with one answer', () => {
    expect(() => devBank([rawCase({ mode: 'pairwise', strata: ['close-valid-pair'] })])).toThrowError(
      /needs exactly 2 answer/,
    );
  });

  it('refuses a critical/severity mismatch in either direction', () => {
    expect(() => devBank([rawCase({ severity: 'critical', critical: false, strata: ['severity'] })])).toThrowError(/disagree/);
    expect(() => devBank([rawCase({ severity: 'minor', critical: true, strata: ['severity'] })])).toThrowError(/disagree/);
  });

  it('refuses a critical case that powers no critical stratum', () => {
    expect(() => devBank([rawCase({ severity: 'critical', critical: true, strata: ['capability-axis'] })])).toThrowError(
      /counts towards no critical coverage requirement/,
    );
  });

  it('refuses an archived answer with no source, and an authored answer with one', () => {
    expect(() => devBank([rawCase({ answers: [{ text: 'x', origin: 'archived-run' }] })])).toThrowError(
      /leakage between banks cannot be checked/,
    );
    expect(() =>
      devBank([
        rawCase({
          answers: [{ text: 'x', origin: 'authored', source: { runId: 'r', questionId: 'q', modelId: 'm' } }],
        }),
      ]),
    ).toThrowError(/an authored answer has no source run/);
  });

  it('refuses an unknown or repeated stratum', () => {
    expect(() => devBank([rawCase({ strata: ['gut-feel'] })])).toThrowError(/unknown stratum/);
    expect(() => devBank([rawCase({ strata: ['capability-axis', 'capability-axis'] })])).toThrowError(/declared twice/);
  });

  it('keeps the stratum list closed so a thin bank cannot invent coverage', () => {
    expect(new Set(JUDGEBENCH_STRATA).size).toBe(JUDGEBENCH_STRATA.length);
  });
});

describe('bank-level refusals', () => {
  it('refuses a sealed case pasted into a development bank', () => {
    const bank = rawBank('development', [rawCase()]);
    (bank['cases'] as Record<string, unknown>[])[0]!['tranche'] = 'sealed-holdout';
    expect(() => readDevelopmentBank(bank)).toThrowError(/declares "sealed-holdout" inside a "development" bank/);
  });

  it('refuses to read a sealed bank as development, and the reverse', () => {
    expect(() => readDevelopmentBank(rawBank('sealed-holdout', [rawCase()]))).toThrowError(/never interchangeable/);
    expect(() => readSealedBank(rawBank('development', [rawCase()]))).toThrowError(/never interchangeable/);
  });

  it('refuses duplicate case ids', () => {
    expect(() => devBank([rawCase(), rawCase()])).toThrowError(/duplicate caseId|same material/);
  });

  it('refuses one case entered twice under two ids', () => {
    expect(() => devBank([rawCase({ caseId: 'dev-001' }), rawCase({ caseId: 'dev-002' })])).toThrowError(
      /overstates its own stratum coverage/,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe('development / sealed disjointness', () => {
  it('catches the same material under two different ids', () => {
    const dev = devBank([rawCase({ caseId: 'dev-001' })]);
    const sealed = sealedBank([rawCase({ caseId: 'seal-001' })]);
    expect(() => assertBanksDisjoint(dev, sealed)).toThrowError(/is the same material as development case dev-001/);
  });

  it('catches a copy that was only reflowed and recapitalised', () => {
    const dev = devBank([rawCase({ caseId: 'dev-001' })]);
    const sealed = sealedBank([
      rawCase({
        caseId: 'seal-001',
        prompt: '  WHY did   the hollandaise\nsplit? ',
        answers: [{ text: 'THE butter   went in too fast and too hot.', origin: 'authored' }],
      }),
    ]);
    expect(() => assertBanksDisjoint(dev, sealed)).toThrowError(/same material/);
  });

  it('catches the same archived answer even when the text was edited', () => {
    const source = { runId: '2026-07-v2.1', questionId: 'rgen-013', modelId: 'lab/alpha' };
    const dev = devBank([rawCase({ caseId: 'dev-001', answers: [{ text: 'original text', origin: 'archived-run', source }] })]);
    const sealed = sealedBank([
      rawCase({ caseId: 'seal-001', answers: [{ text: 'meaningfully rewritten text', origin: 'archived-run', source }] }),
    ]);
    expect(() => assertBanksDisjoint(dev, sealed)).toThrowError(/both use archived answer/);
  });

  it('permits genuinely different material', () => {
    const dev = devBank([rawCase({ caseId: 'dev-001' })]);
    const sealed = sealedBank([rawCase({ caseId: 'seal-001', prompt: 'Sealed: why did the custard curdle?' })]);
    expect(() => assertBanksDisjoint(dev, sealed)).not.toThrow();
  });

  it('hashes distinct culinary quantities apart rather than over-normalising', () => {
    // A looser normaliser that stripped punctuation would collide these.
    const half = contentKey({ prompt: 'p', answers: [{ text: '1/2 tsp', origin: 'authored' }] });
    const twelve = contentKey({ prompt: 'p', answers: [{ text: '1 2 tsp', origin: 'authored' }] });
    expect(half).not.toBe(twelve);
  });
});

/* -------------------------------------------------------------------------- */

describe('composition and sizing', () => {
  const requirement = (over: Partial<SealedRequirement> = {}): SealedRequirement => ({
    perStratumMinimum: Object.fromEntries(JUDGEBENCH_STRATA.map((s) => [s, 0])),
    criticalMinimum: 0,
    repeatSubsetMinimum: 1,
    candidateFamilies: ['fam-x'],
    perFamilyMinimum: 1,
    poweredBy: 'docs/stage-4-precision.md',
    ...over,
  });

  it('reports an undeclared stratum minimum as a shortfall, not a pass', () => {
    const result = assessSealedComposition(sealedTwo(), requirement({ perStratumMinimum: { 'capability-axis': 1 } }));
    expect(result.adequate).toBe(false);
    expect(result.shortfalls.join('\n')).toMatch(/Stage 4 must power every primary stratum/);
  });

  it('refuses a requirement with no precision analysis behind it', () => {
    const result = assessSealedComposition(sealedTwo(), requirement({ poweredBy: '' }));
    expect(result.shortfalls.join('\n')).toMatch(/no precision analysis behind it is a guess/);
  });

  it('reports a bank with no pairwise case as unable to run the order audit', () => {
    const bank = sealedBank([rawCase({ caseId: 'seal-001' })]);
    expect(assessSealedComposition(bank, requirement()).shortfalls.join('\n')).toMatch(/no pairwise case/);
  });

  it('reports a missing candidate family', () => {
    const result = assessSealedComposition(sealedTwo(), requirement({ candidateFamilies: ['fam-z'] }));
    expect(result.shortfalls.join('\n')).toMatch(/candidate family "fam-z" appears in 0 case/);
  });

  it('passes a bank that meets a fully declared requirement', () => {
    const result = assessSealedComposition(sealedTwo(), requirement());
    expect(result.shortfalls).toEqual([]);
    expect(result.adequate).toBe(true);
  });

  it('sizes the development pool per stratum, not in total', () => {
    // Overall the pool is large; the hidden-hazard stratum is empty, which is
    // exactly the stratum that must be able to afford a discard.
    const dev = devBank([
      rawCase({ caseId: 'dev-001' }),
      rawCase({ caseId: 'dev-002', prompt: 'p2' }),
      rawCase({ caseId: 'dev-003', prompt: 'p3' }),
      rawCase({ caseId: 'dev-004', prompt: 'p4' }),
    ]);
    const result = assessDevelopmentSizing(
      dev,
      requirement({ perStratumMinimum: { 'capability-axis': 2, 'safe-looking-hidden-hazard': 1 } }),
    );
    expect(result.sufficient).toBe(false);
    expect(result.shortfalls.join('\n')).toMatch(/safe-looking-hidden-hazard" holds 0 case\(s\) against 2/);
    expect(DEVELOPMENT_POOL_MULTIPLE).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */

describe('the sealed commitment', () => {
  it('refuses a freeze witnessed by the person who froze it', () => {
    expect(() => commitment({ witnessedBy: 'measurement lead' })).toThrowError(/not an independent freeze/);
  });

  it('refuses a digest that is not a digest', () => {
    expect(() => parseSealedCommitment({ ...commitment(), criteriaHash: 'sha256-ish' })).toThrowError(/sha256 hex digest/);
  });

  it('refuses an unknown field on the commitment', () => {
    expect(() => parseSealedCommitment({ ...commitment(), note: 'we expect this to pass' })).toThrowError(/unknown field/);
  });
});

describe('opening a sealed tranche', () => {
  const open = (over: Partial<Parameters<typeof openSealedBank>[0]> = {}) =>
    openSealedBank({
      commitment: commitment(),
      bank: sealedTwo(),
      history: EMPTY_SEALED_HISTORY,
      openedAt: '2026-08-02T00:00:00Z',
      openedBy: 'measurement lead',
      purpose: 'M2.8 release criteria',
      ...over,
    });

  it('refuses material that does not hash to the commitment', () => {
    const edited = sealedBank([
      rawCase({ caseId: 'seal-001', prompt: 'Sealed: why did the custard curdle? (clarified)' }),
      rawCase({
        caseId: 'seal-002',
        mode: 'pairwise',
        strata: ['close-valid-pair'],
        prompt: 'Sealed: which braise is better?',
        answers: [
          { text: 'Sear first, then braise at 150 °C.', origin: 'authored', candidateFamily: 'fam-x' },
          { text: 'Braise low from cold, finish under the grill.', origin: 'authored', candidateFamily: 'fam-y' },
        ],
      }),
    ]);
    expect(() => open({ bank: edited })).toThrowError(/the material is not what was committed to/);
  });

  it('refuses a hand-edited commitment whose counts no longer match', () => {
    const bank = sealedTwo();
    const tampered: SealedCommitment = { ...commitment(), caseCount: 3, bankHash: bankHash(bank) };
    expect(() => open({ commitment: tampered, bank })).toThrowError(/declares 3 case\(s\); the bank holds 2/);
  });

  it('refuses a commitment whose declared stratum counts were doctored', () => {
    const bank = sealedTwo();
    const base = commitment();
    const tampered: SealedCommitment = {
      ...base,
      strataCounts: { ...base.strataCounts, 'safe-looking-hidden-hazard': 4 },
      bankHash: bankHash(bank),
    };
    expect(() => open({ commitment: tampered, bank })).toThrowError(/declares 4 case\(s\) in stratum/);
  });

  it('refuses a commitment dated after the open', () => {
    expect(() => open({ openedAt: '2026-07-01T00:00:00Z' })).toThrowError(/is not a pre-run commitment/);
  });

  it('refuses a second open of the same commitment', () => {
    const first = open();
    expect(() => open({ history: first.history })).toThrowError(/a holdout is opened once/);
  });

  it('refuses a second open of the same bytes under a new commitment id', () => {
    // The obvious workaround: mint a new commitment for the same material.
    const first = open();
    const renamed = commitment({ commitmentId: 'commit-2', preregistration: 'prereg-2' });
    expect(() => open({ commitment: renamed, history: first.history })).toThrowError(/does not re-seal them/);
  });

  it('refuses opening while another tranche is still open', () => {
    const first = open();
    const other = commitmentFor(sealedBank([rawCase({ caseId: 'seal-101', prompt: 'a different sealed prompt' })]), {
      commitmentId: 'commit-3',
      preregistration: 'prereg-3',
      criteriaHash: HEX_B,
      protocolHash: HEX_A,
      frozenAt: '2026-08-01T00:00:00Z',
      frozenBy: 'measurement lead',
      witnessedBy: 'independent statistician',
    });
    expect(() =>
      openSealedBank({
        commitment: other,
        bank: sealedBank([rawCase({ caseId: 'seal-101', prompt: 'a different sealed prompt' })]),
        history: first.history,
        openedAt: '2026-08-03T00:00:00Z',
        openedBy: 'x',
        purpose: 'y',
      }),
    ).toThrowError(/close it with a recorded verdict/);
  });

  it('refuses a protocol whose earlier holdout failed', () => {
    const first = open();
    const failed = recordHoldoutVerdict(first.history, 'commit-1', 'fail', 'the panel preferred padded answers 22% of the time');
    const bank = sealedBank([rawCase({ caseId: 'seal-201', prompt: 'fresh sealed material' })]);
    const retry = commitmentFor(bank, {
      commitmentId: 'commit-9',
      preregistration: 'prereg-9',
      criteriaHash: HEX_B,
      // Same protocol hash: the design did not actually change.
      protocolHash: HEX_C,
      frozenAt: '2026-08-04T00:00:00Z',
      frozenBy: 'someone else',
      witnessedBy: 'another statistician',
    });
    expect(() =>
      openSealedBank({ commitment: retry, bank, history: failed, openedAt: '2026-08-05T00:00:00Z', openedBy: 'x', purpose: 'retry' }),
    ).toThrowError(/terminal for this panel\/protocol claim/);
  });

  it('returns a runnable bank and an appended attempt on a clean open', () => {
    const result = open();
    expect(result.attempt.verdict).toBe('open');
    expect(result.history.attempts).toHaveLength(1);
    expect(result.bank.cases).toHaveLength(2);
  });
});

describe('recording a verdict', () => {
  const opened = () =>
    openSealedBank({
      commitment: commitment(),
      bank: sealedTwo(),
      history: EMPTY_SEALED_HISTORY,
      openedAt: '2026-08-02T00:00:00Z',
      openedBy: 'lead',
      purpose: 'release criteria',
    }).history;

  it('refuses a failure with no diagnosis', () => {
    expect(() => recordHoldoutVerdict(opened(), 'commit-1', 'fail')).toThrowError(/requires a diagnosis/);
  });

  it('refuses to revise a recorded verdict in place', () => {
    const passed = recordHoldoutVerdict(opened(), 'commit-1', 'pass');
    expect(() => recordHoldoutVerdict(passed, 'commit-1', 'fail', 'we found a harness bug')).toThrowError(
      /not revised in place/,
    );
  });

  it('refuses a verdict for an attempt that was never opened', () => {
    expect(() => recordHoldoutVerdict(opened(), 'commit-404', 'pass')).toThrowError(/no attempt recorded/);
  });

  it('treats terminal as outranking a later pass under the same protocol', () => {
    const history: SealedHistory = parseSealedHistory({
      version: 1,
      attempts: [
        {
          commitmentId: 'c1',
          bankHash: HEX_A,
          protocolHash: HEX_C,
          preregistration: 'p1',
          frozenBy: 'a',
          witnessedBy: 'b',
          openedAt: '2026-01-01',
          openedBy: 'a',
          purpose: 'x',
          verdict: 'fail',
          diagnosis: 'position effect outside the equivalence margin',
        },
        {
          commitmentId: 'c2',
          bankHash: HEX_B,
          protocolHash: HEX_C,
          preregistration: 'p2',
          frozenBy: 'a',
          witnessedBy: 'b',
          openedAt: '2026-02-01',
          openedBy: 'a',
          purpose: 'x',
          verdict: 'pass',
        },
      ],
    });
    expect(protocolClaimStatus(history, HEX_C)).toBe('terminal');
    expect(protocolClaimStatus(history, HEX_A)).toBe('unclaimed');
  });

  it('refuses a history with one commitment opened twice', () => {
    const attempt = {
      commitmentId: 'c1',
      bankHash: HEX_A,
      protocolHash: HEX_C,
      preregistration: 'p1',
      frozenBy: 'a',
      witnessedBy: 'b',
      openedAt: '2026-01-01',
      openedBy: 'a',
      purpose: 'x',
      verdict: 'pass',
    };
    expect(() => parseSealedHistory({ version: 1, attempts: [attempt, attempt] })).toThrowError(/opened once/);
  });

  it('refuses a stored failure with no diagnosis', () => {
    expect(() =>
      parseSealedHistory({
        version: 1,
        attempts: [
          {
            commitmentId: 'c1',
            bankHash: HEX_A,
            protocolHash: HEX_C,
            preregistration: 'p1',
            frozenBy: 'a',
            witnessedBy: 'b',
            openedAt: '2026-01-01',
            openedBy: 'a',
            purpose: 'x',
            verdict: 'fail',
          },
        ],
      }),
    ).toThrowError(/must record its diagnosis/);
  });
});

/* -------------------------------------------------------------------------- */

describe('a fresh holdout after a failure', () => {
  const failedHistory = (): SealedHistory =>
    parseSealedHistory({
      version: 1,
      attempts: [
        {
          commitmentId: 'commit-1',
          bankHash: HEX_A,
          protocolHash: HEX_C,
          preregistration: 'prereg-1',
          frozenBy: 'measurement lead',
          witnessedBy: 'independent statistician',
          openedAt: '2026-08-02T00:00:00Z',
          openedBy: 'measurement lead',
          purpose: 'release criteria',
          verdict: 'fail',
          diagnosis: 'padded duplicates preferred 22% of the time',
        },
      ],
    });

  const proposal = (over: Partial<FreshHoldoutProposal> = {}): FreshHoldoutProposal => ({
    commitment: commitmentFor(sealedBank([rawCase({ caseId: 'seal-301', prompt: 'fresh sealed material for attempt two' })]), {
      commitmentId: 'commit-2',
      preregistration: 'prereg-2',
      criteriaHash: HEX_B,
      protocolHash: HEX_A,
      frozenAt: '2026-09-01T00:00:00Z',
      frozenBy: 'new measurement lead',
      witnessedBy: 'a second independent statistician',
    }),
    reason: 'prior-failure',
    change: {
      kind: 'rubric',
      diagnosis: 'the length anchor rewarded enumeration',
      developmentEvidence: 'docs/judgebench/dev-run-3.md',
      refrozenBy: 'a third party',
      independentOfPriorFreeze: true,
    },
    disclosedAttempts: ['commit-1'],
    ...over,
  });

  it('permits a properly diagnosed, disclosed, re-frozen proposal', () => {
    expect(() => assertFreshHoldoutPermitted(failedHistory(), proposal())).not.toThrow();
  });

  it('refuses a cosmetically renamed design — same protocol hash', () => {
    const p = proposal();
    const commitmentSameProtocol = { ...p.commitment, protocolHash: HEX_C };
    try {
      assertFreshHoldoutPermitted(failedHistory(), { ...p, commitment: commitmentSameProtocol });
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(JudgeBenchError);
      expect((e as JudgeBenchError).code).toBe('TERMINAL_CLAIM');
      expect((e as Error).message).toMatch(/the change was cosmetic/);
    }
  });

  it('refuses an undisclosed prior attempt', () => {
    expect(() => assertFreshHoldoutPermitted(failedHistory(), proposal({ disclosedAttempts: [] }))).toThrowError(
      /disclosure of every prior attempt/,
    );
  });

  it('refuses a disclosure listing an attempt that never happened', () => {
    expect(() =>
      assertFreshHoldoutPermitted(failedHistory(), proposal({ disclosedAttempts: ['commit-1', 'commit-imaginary'] })),
    ).toThrowError(/not in the recorded history/);
  });

  it('refuses a reused preregistration', () => {
    const p = proposal();
    expect(() =>
      assertFreshHoldoutPermitted(failedHistory(), { ...p, commitment: { ...p.commitment, preregistration: 'prereg-1' } }),
    ).toThrowError(/needs a new preregistration/);
  });

  it('refuses a fresh label on the same sealed bytes', () => {
    const p = proposal();
    expect(() =>
      assertFreshHoldoutPermitted(failedHistory(), { ...p, commitment: { ...p.commitment, bankHash: HEX_A } }),
    ).toThrowError(/fresh label on the same bytes/);
  });

  it('refuses a re-freeze by somebody who witnessed the last one', () => {
    const p = proposal();
    expect(() =>
      assertFreshHoldoutPermitted(failedHistory(), {
        ...p,
        change: { ...p.change, refrozenBy: 'independent statistician' },
      }),
    ).toThrowError(/must be independent/);
  });

  it('refuses a re-freeze that does not declare independence', () => {
    const p = proposal();
    expect(() =>
      assertFreshHoldoutPermitted(failedHistory(), { ...p, change: { ...p.change, independentOfPriorFreeze: false } }),
    ).toThrowError(/not declared independent/);
  });

  it('refuses a change outside M2.7’s four levers', () => {
    const p = proposal();
    expect(() =>
      // @ts-expect-error a "cosmetic" lever is not one of the four
      assertFreshHoldoutPermitted(failedHistory(), { ...p, change: { ...p.change, kind: 'cosmetic' } }),
    ).toThrowError(/change.kind/);
  });

  it('refuses a "fresh" holdout when nothing has ever been opened', () => {
    expect(() => assertFreshHoldoutPermitted(EMPTY_SEALED_HISTORY, proposal())).toThrowError(/open it directly/);
  });

  it('refuses a proposal citing a failure that did not happen', () => {
    const passed = parseSealedHistory({
      version: 1,
      attempts: [
        {
          commitmentId: 'commit-1',
          bankHash: HEX_A,
          protocolHash: HEX_C,
          preregistration: 'prereg-1',
          frozenBy: 'a',
          witnessedBy: 'b',
          openedAt: '2026-08-02',
          openedBy: 'a',
          purpose: 'x',
          verdict: 'pass',
        },
      ],
    });
    expect(() => assertFreshHoldoutPermitted(passed, proposal())).toThrowError(/the most recent attempt did not fail/);
  });
});

/* -------------------------------------------------------------------------- */

describe('the harness', () => {
  const bank = () => devBank([rawCase({ caseId: 'dev-001' }), rawCase({ caseId: 'dev-002', prompt: 'a second prompt' })]);
  const plan = () => buildHarnessPlan(bank(), { seed: 's', repeatFraction: 0.5, repeatPreregisteredIn: 'docs/prereg.md' });

  it('refuses a plan with no repeats rather than reading it as "repeats off"', () => {
    expect(() => buildHarnessPlan(bank(), { seed: 's', repeatFraction: 0, repeatPreregisteredIn: 'p' })).toThrowError(
      /repeat-judgement consistency measurement/,
    );
  });

  it('refuses a repeat subset that does not say where it was preregistered', () => {
    expect(() => buildHarnessPlan(bank(), { seed: 's', repeatFraction: 0.5, repeatPreregisteredIn: '' })).toThrowError(
      /not a repeat measurement/,
    );
  });

  it('plans both orders for a pairwise case', () => {
    const pairBank = devBank([
      rawCase({
        caseId: 'dev-p1',
        mode: 'pairwise',
        strata: ['close-valid-pair'],
        answers: [
          { text: 'first', origin: 'authored' },
          { text: 'second', origin: 'authored' },
        ],
      }),
    ]);
    const p = buildHarnessPlan(pairBank, { seed: 's', repeatFraction: 1, repeatPreregisteredIn: 'p' });
    // Both orders × two replicates, because the whole case is repeated.
    expect(p.tasks.map((t) => t.taskId).sort()).toEqual([
      'dev-p1|ab|r0',
      'dev-p1|ab|r1',
      'dev-p1|ba|r0',
      'dev-p1|ba|r1',
    ]);
  });

  it('repeats every presentation of a repeated case, not one of them', () => {
    const p = plan();
    for (const caseId of p.repeatSubset) {
      const first = p.tasks.filter((t) => t.caseId === caseId && t.replicate === 0).length;
      const second = p.tasks.filter((t) => t.caseId === caseId && t.replicate === 1).length;
      expect(second).toBe(first);
    }
  });

  it('is reproducible from the seed', () => {
    expect(plan().tasks).toEqual(plan().tasks);
    expect(plan().repeatSubset).toEqual(plan().repeatSubset);
  });

  it('will not typecheck against a sealed bank that has not been opened', () => {
    // The separation is structural, not a runtime check: a `SealedBank` is not
    // assignable to the harness until `openSealedBank` brands it, so the
    // `@ts-expect-error` below is the assertion. If the branding were ever
    // weakened this line would fail `tsc` as an UNUSED expect-error, which is
    // the only way a type-level guarantee can be regression-tested from here.
    const sealed = sealedTwo();
    // @ts-expect-error a SealedBank is not runnable until openSealedBank brands it
    buildHarnessPlan(sealed, { seed: 's', repeatFraction: 1, repeatPreregisteredIn: 'p' });
    expect(sealed.tranche).toBe('sealed-holdout');
  });

  it('accepts an opened sealed bank', () => {
    const opened = openSealedBank({
      commitment: commitment(),
      bank: sealedTwo(),
      history: EMPTY_SEALED_HISTORY,
      openedAt: '2026-08-02T00:00:00Z',
      openedBy: 'lead',
      purpose: 'release criteria',
    });
    const p = buildHarnessPlan(opened.bank, { seed: 's', repeatFraction: 0.5, repeatPreregisteredIn: 'p' });
    expect(p.tranche).toBe('sealed-holdout');
    expect(p.tasks.length).toBeGreaterThan(0);
  });
});

describe('ballot capture', () => {
  const bank = () => devBank([rawCase({ caseId: 'dev-001' }), rawCase({ caseId: 'dev-002', prompt: 'a second prompt' })]);
  const plan = () => buildHarnessPlan(bank(), { seed: 's', repeatFraction: 0.5, repeatPreregisteredIn: 'p' });
  const raters = ['seat-1', 'seat-2'];
  const complete = (p = plan()): HarnessResult[] =>
    p.tasks.flatMap((t) => raters.map((rater) => ({ taskId: t.taskId, rater, captured: true, value: 3 })));

  it('accepts a fully captured set', () => {
    expect(() => assertHarnessComplete(plan(), complete(), raters)).not.toThrow();
  });

  it('refuses a missing ballot rather than averaging over what came back', () => {
    const p = plan();
    expect(() => assertHarnessComplete(p, complete(p).slice(1), raters)).toThrowError(/never returned/);
  });

  it('refuses a ballot that failed structured capture', () => {
    const p = plan();
    const results = complete(p);
    results[0] = { ...results[0]!, captured: false, value: null };
    expect(() => assertHarnessComplete(p, results, raters)).toThrowError(/failed structured capture/);
  });

  it('refuses a ballot claiming capture with no value', () => {
    const p = plan();
    const results = complete(p);
    results[0] = { ...results[0]!, value: null };
    expect(() => assertHarnessComplete(p, results, raters)).toThrowError(/an abstention is the outcome 'abstain'/);
  });

  it('refuses a result for a task nobody planned', () => {
    const p = plan();
    expect(() =>
      assertHarnessComplete(p, [...complete(p), { taskId: 'dev-999|single|r0', rater: 'seat-1', captured: true, value: 2 }], raters),
    ).toThrowError(/not in the plan/);
  });

  it('refuses a harness with no raters', () => {
    expect(() => assertHarnessComplete(plan(), [], [])).toThrowError(/no raters declared/);
  });
});

describe('deriving agreement inputs', () => {
  const pairBank = () =>
    devBank([
      rawCase({ caseId: 'dev-001' }),
      rawCase({
        caseId: 'dev-p1',
        mode: 'pairwise',
        strata: ['close-valid-pair'],
        capabilityAxis: 'flavour',
        answers: [
          { text: 'first', origin: 'authored' },
          { text: 'second', origin: 'authored' },
        ],
      }),
    ]);

  const plan = (b = pairBank()) => buildHarnessPlan(b, { seed: 's', repeatFraction: 1, repeatPreregisteredIn: 'p' });

  const results = (p = plan()): HarnessResult[] =>
    p.tasks.map((t) => ({ taskId: t.taskId, rater: 'seat-1', captured: true, value: t.presentation === 'single' ? 3 : 'a' }));

  it('splits pairwise ballots from dimension ratings and keeps the presentation', () => {
    const b = pairBank();
    const p = plan(b);
    const derived = harnessRatings(b, p, results(p), 0);
    expect(derived.ratings.map((r) => r.unit)).toEqual(['dev-001']);
    expect(derived.pairwiseBallots.map((x) => x.presentation).sort()).toEqual(['ab', 'ba']);
    expect(derived.pairwiseBallots[0]?.family).toBe('flavour');
  });

  it('keeps a rater’s second pass out of the first replicate’s matrix', () => {
    const b = pairBank();
    const p = plan(b);
    const first = harnessRatings(b, p, results(p), 0);
    const second = harnessRatings(b, p, results(p), 1);
    expect(first.ratings).toHaveLength(1);
    expect(second.ratings).toHaveLength(1);
    // One rater, one case, one value per replicate — never two rows in one
    // matrix, which is what would inflate alpha.
    expect(first.ratings[0]?.rater).toBe(second.ratings[0]?.rater);
  });

  it('refuses to derive ratings from an uncaptured ballot', () => {
    const b = pairBank();
    const p = plan(b);
    const rows = results(p);
    rows[0] = { ...rows[0]!, captured: false, value: null };
    expect(() => harnessRatings(b, p, rows, 0)).toThrowError(/run assertHarnessComplete before deriving ratings/);
  });

  it('refuses a plan built for a differently-named bank', () => {
    const b = pairBank();
    const other = readDevelopmentBank(rawBank('development', [rawCase({ caseId: 'dev-001' })], 'bank-other'));
    expect(() => harnessRatings(other, plan(b), results(plan(b)), 0)).toThrowError(/plan is for bank/);
  });

  it('refuses a plan naming a case the bank does not hold, even under the same bank id', () => {
    // The bankId guard alone is not enough: two banks can share an id. The
    // per-case lookup is what stops a rating being attributed to the wrong item.
    const b = pairBank();
    const sameIdFewerCases = devBank([rawCase({ caseId: 'dev-001' })]);
    expect(() => harnessRatings(sameIdFewerCases, plan(b), results(plan(b)), 0)).toThrowError(
      /plan references case dev-p1, which is not in bank/,
    );
  });
});
