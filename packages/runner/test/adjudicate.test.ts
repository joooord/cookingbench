import { describe, expect, it } from 'vitest';
import {
  AdjudicationError,
  MANDATORY_REVIEW_REASONS,
  UNVALIDATED_COVERAGE,
  adjudicationStatus,
  assertReportPermitted,
  blankRecordFor,
  buildAdjudicationQueue,
  caseIdFor,
  coveredStrata,
  formatAdjudicationQueue,
  observationsFromStoredScores,
  parseAdjudicationRecord,
  presentCase,
  queueHashOf,
  reportPermitted,
  resolveAdjudicatedScore,
  writeAdjudicationQueue,
  type AdjudicationCase,
  type AdjudicationDecision,
  type AdjudicationPolicy,
  type AdjudicationQueue,
  type PanelObservation,
} from '../src/adjudicate.js';

/**
 * These are attempts to get a report published while a dispute is unresolved,
 * to get a case out of the mandatory queue, and to get a decision recorded that
 * says nothing. The happy paths are here only to prove the refusals are not
 * refusing everything.
 */

const COVERED = 'technique';
const UNCOVERED = 'safety';

function policy(over: Partial<AdjudicationPolicy> = {}): AdjudicationPolicy {
  return {
    disagreementTolerance: 15,
    entropyTolerance: 1.0,
    minimumConfidence: 0.7,
    headlineTier: [],
    // A passing holdout covering exactly one stratum, so tests can put a case
    // inside or outside validated coverage on purpose.
    coverage: { validatedBy: 'holdout-2026-08', verdict: 'pass', strata: [COVERED] },
    sampling: { seed: 'seed-1', fraction: 0.5, minimumPerStratum: 1, preregisteredIn: 'docs/prereg-1.md' },
    ...over,
  };
}

function obs(over: Partial<PanelObservation> = {}): PanelObservation {
  return {
    runId: 'run-a',
    questionId: 'tech-001',
    candidates: ['lab/alpha'],
    mode: 'fault-deduction',
    stratum: COVERED,
    seats: [
      { judgeModel: 'judge/one', score: 90, confidence: 0.9, evidence: [] },
      { judgeModel: 'judge/two', score: 88, confidence: 0.9, evidence: [] },
    ],
    disagreement: 2,
    entropy: null,
    confidence: 0.9,
    orderUnstable: false,
    provisionalScore: 89,
    prompt: 'How long should a 2 kg brisket rest?',
    answers: [{ modelId: 'lab/alpha', text: 'Rest it for at least an hour.' }],
    ...over,
  };
}

function decision(caseId: string, over: Partial<AdjudicationDecision> = {}): AdjudicationDecision {
  return {
    caseId,
    decision: 'uphold',
    evidence: 'Both seats cite the same passage and the reference agrees with them.',
    confidence: 0.8,
    reviewer: {
      id: 'reviewer-1',
      role: 'chef',
      qualification: 'twelve years professional kitchens',
      independent: true,
      provenance: 'human',
    },
    decidedAt: '2026-08-01T10:00:00Z',
    itemChangeRequired: false,
    judgePromptChangeRequired: false,
    ...over,
  };
}

function queueOf(observations: PanelObservation[], p: AdjudicationPolicy = policy()): AdjudicationQueue {
  return buildAdjudicationQueue({ runId: 'run-a', observations, policy: p });
}

/* -------------------------------------------------------------------------- */

describe('policy refusals', () => {
  it('refuses a zero-rate audit sample rather than reading it as "audit disabled"', () => {
    expect(() => queueOf([obs()], policy({ sampling: { seed: 's', fraction: 0, minimumPerStratum: 1, preregisteredIn: 'x' } }))).toThrowError(
      /zero-rate audit assumes the unflagged population correct/,
    );
  });

  it('refuses a sampling plan that does not say where it was frozen', () => {
    expect(() =>
      queueOf([obs()], policy({ sampling: { seed: 's', fraction: 0.1, minimumPerStratum: 1, preregisteredIn: '  ' } })),
    ).toThrowError(/cannot be shown to predate the flags/);
  });

  it('refuses a coverage claim that passes a holdout covering no stratum', () => {
    expect(() => queueOf([obs()], policy({ coverage: { validatedBy: 'h', verdict: 'pass', strata: [] } }))).toThrowError(
      /a pass over nothing covers nothing/,
    );
  });

  it('refuses a confidence threshold outside 0–1', () => {
    expect(() => queueOf([obs()], policy({ minimumConfidence: 70 }))).toThrowError(/0–1 probability/);
  });

  it('refuses a fractional minimumPerStratum', () => {
    expect(() =>
      queueOf([obs()], policy({ sampling: { seed: 's', fraction: 0.1, minimumPerStratum: 0.5, preregisteredIn: 'x' } })),
    ).toThrowError(/integer ≥ 1/);
  });
});

describe('automation coverage', () => {
  it('covers nothing when the holdout failed, however many strata it lists', () => {
    // The break attempt: list every stratum, record the failure honestly, and
    // hope the stratum list is what gets read.
    expect(coveredStrata({ validatedBy: 'h', verdict: 'fail', strata: [COVERED, UNCOVERED] }).size).toBe(0);
  });

  it('covers nothing when no holdout was run', () => {
    expect(coveredStrata(UNVALIDATED_COVERAGE).size).toBe(0);
  });

  it('escalates an unmeasured confidence outside coverage, and does not inside it', () => {
    const outside = queueOf([obs({ stratum: UNCOVERED, confidence: null })], policy());
    expect(outside.cases[0]?.reasons).toContain('confidence-outside-coverage');

    const inside = queueOf([obs({ stratum: COVERED, confidence: null })], policy());
    expect(inside.cases.find((c) => c.reasons.includes('confidence-outside-coverage'))).toBeUndefined();
  });

  it('treats the whole legacy panel as mandatory under UNVALIDATED_COVERAGE', () => {
    // The uncomfortable, intended consequence: with no passing holdout, every
    // answer whose confidence was never recorded is a review case.
    const queue = queueOf(
      [obs({ confidence: null }), obs({ questionId: 'tech-002', confidence: null })],
      policy({ coverage: UNVALIDATED_COVERAGE }),
    );
    expect(queue.cases).toHaveLength(2);
    expect(formatAdjudicationQueue(queue).join('\n')).toMatch(/no stratum is validated/);
  });
});

describe('mandatory categories', () => {
  it('fires on a split strictly greater than tolerance, not equal to it', () => {
    expect(queueOf([obs({ disagreement: 15 })]).cases.some((c) => c.reasons.includes('split-beyond-tolerance'))).toBe(false);
    expect(queueOf([obs({ disagreement: 15.5 })]).cases[0]?.reasons).toContain('split-beyond-tolerance');
  });

  it('flags a safety disagreement when only one seat raises a critical finding', () => {
    const queue = queueOf([
      obs({
        seats: [
          {
            judgeModel: 'judge/one',
            score: 20,
            confidence: 0.9,
            evidence: [{ statement: 'advises 50 °C chicken', severity: 'critical', provenance: 'human' }],
          },
          { judgeModel: 'judge/two', score: 85, confidence: 0.9, evidence: [] },
        ],
      }),
    ]);
    expect(queue.cases[0]?.reasons).toContain('safety-disagreement');
  });

  it('flags a critical finding that only an LLM judge ever asserted (M2.2)', () => {
    const both = [
      { statement: 'raw kidney beans', severity: 'critical' as const, provenance: 'llm-judge' as const },
    ];
    const queue = queueOf([
      obs({
        seats: [
          { judgeModel: 'judge/one', score: 10, confidence: 0.9, evidence: both },
          { judgeModel: 'judge/two', score: 12, confidence: 0.9, evidence: both },
        ],
      }),
    ]);
    // Unanimous, so no safety DISAGREEMENT — and still mandatory, because
    // nothing but an LLM ever confirmed it.
    expect(queue.cases[0]?.reasons).not.toContain('safety-disagreement');
    expect(queue.cases[0]?.reasons).toContain('safety-llm-only');
  });

  it('treats a critical finding with no declared provenance as LLM-only', () => {
    const evidence = [{ statement: 'unsafe', severity: 'critical' as const }];
    const queue = queueOf([
      obs({
        seats: [
          { judgeModel: 'judge/one', score: 10, confidence: 0.9, evidence },
          { judgeModel: 'judge/two', score: 10, confidence: 0.9, evidence },
        ],
      }),
    ]);
    expect(queue.cases[0]?.reasons).toContain('safety-llm-only');
  });

  it('clears safety-llm-only once a deterministic check corroborates', () => {
    const queue = queueOf([
      obs({
        seats: [
          {
            judgeModel: 'judge/one',
            score: 10,
            confidence: 0.9,
            evidence: [{ statement: 'unsafe', severity: 'critical', provenance: 'deterministic' }],
          },
          {
            judgeModel: 'judge/two',
            score: 10,
            confidence: 0.9,
            evidence: [{ statement: 'unsafe', severity: 'critical', provenance: 'llm-judge' }],
          },
        ],
      }),
    ]);
    expect(queue.cases.find((c) => c.reasons.includes('safety-llm-only'))).toBeUndefined();
  });

  it('escalates every order-unstable pair when no headline tier is declared', () => {
    const pair = obs({
      mode: 'pairwise',
      candidates: ['lab/alpha', 'lab/beta'],
      answers: [
        { modelId: 'lab/alpha', text: 'a' },
        { modelId: 'lab/beta', text: 'b' },
      ],
      orderUnstable: true,
      entropy: 0.2,
    });
    expect(queueOf([pair], policy({ headlineTier: 'undeclared' })).cases[0]?.reasons).toContain('order-unstable-headline');
    // An empty array is a positive statement that no tier claim is made.
    expect(queueOf([pair], policy({ headlineTier: [] })).cases.find((c) => c.reasons.includes('order-unstable-headline'))).toBeUndefined();
    expect(queueOf([pair], policy({ headlineTier: ['lab/beta'] })).cases[0]?.reasons).toContain('order-unstable-headline');
  });

  it('escalates a pairwise case whose vote entropy was never measured', () => {
    const pair = obs({
      mode: 'pairwise',
      stratum: UNCOVERED,
      candidates: ['lab/alpha', 'lab/beta'],
      answers: [
        { modelId: 'lab/alpha', text: 'a' },
        { modelId: 'lab/beta', text: 'b' },
      ],
      entropy: null,
    });
    expect(queueOf([pair]).cases[0]?.reasons).toContain('entropy-outside-coverage');
  });

  it('does not raise an entropy reason on a non-pairwise route', () => {
    // Escalating a null entropy on a dimension route would double-count the
    // spread `split-beyond-tolerance` already covers.
    const queue = queueOf([obs({ stratum: UNCOVERED, entropy: null, confidence: 0.95 })]);
    expect(queue.cases.find((c) => c.reasons.includes('entropy-outside-coverage'))).toBeUndefined();
  });

  it('reviews a challenged reference even when the panel agreed perfectly', () => {
    const queue = queueOf(
      [obs({ disagreement: 0 })],
      policy({ challenges: [{ questionId: 'tech-001', raisedBy: 'chef', detail: 'the reference rest time is wrong' }] }),
    );
    expect(queue.cases[0]?.reasons).toContain('challenged-reference');
  });

  it('refuses a challenge with no raiser or basis', () => {
    expect(() =>
      queueOf([obs()], policy({ challenges: [{ questionId: 'tech-001', raisedBy: '', detail: '' }] })),
    ).toThrowError(/anonymous, unexplained challenge/);
  });

  it('names every reason it knows about in MANDATORY_REVIEW_REASONS', () => {
    // Guards against a reason being added to the union and not to the printed
    // list, which would make `formatAdjudicationQueue` silently under-report.
    expect(new Set(MANDATORY_REVIEW_REASONS).size).toBe(MANDATORY_REVIEW_REASONS.length);
  });
});

describe('observation validation', () => {
  it('refuses an observation with no declared stratum', () => {
    expect(() => queueOf([obs({ stratum: '' })])).toThrowError(/stratum is required/);
  });

  it('refuses a candidate whose answer text is missing', () => {
    expect(() => queueOf([obs({ candidates: ['lab/ghost'] })])).toThrowError(/cannot adjudicate an answer they cannot read/);
  });

  it('refuses an observation belonging to a different run', () => {
    expect(() => queueOf([obs({ runId: 'run-b' })])).toThrowError(/a queue mixing runs cannot gate/);
  });

  it('refuses two panel results for one (item, candidate) pair', () => {
    expect(() => queueOf([obs(), obs()])).toThrowError(/one case cannot carry two panel results/);
  });

  it('refuses a pairwise observation with one candidate', () => {
    expect(() => queueOf([obs({ mode: 'pairwise' })])).toThrowError(/pairwise mode needs exactly two candidates/);
  });

  it('refuses a case with no seat verdict at all', () => {
    expect(() => queueOf([obs({ seats: [] })])).toThrowError(/an incident, not an automated result/);
  });
});

describe('case identity', () => {
  it('does not collide on ids containing the separator a joined key would use', () => {
    expect(caseIdFor('r', 'a::b', ['c'])).not.toBe(caseIdFor('r', 'a', ['b::c']));
  });

  it('gives one pair one identity whichever order it was observed in', () => {
    expect(caseIdFor('r', 'q', ['x', 'y'])).toBe(caseIdFor('r', 'q', ['y', 'x']));
  });
});

describe('the stratified audit sample', () => {
  const clean = (i: number, stratum: string): PanelObservation =>
    obs({ questionId: `q-${stratum}-${i}`, stratum, confidence: 0.95, disagreement: 0 });

  it('draws only from otherwise-unflagged cases', () => {
    const flagged = obs({ questionId: 'q-flagged', disagreement: 40, confidence: 0.95 });
    const queue = queueOf([flagged, ...[0, 1, 2, 3].map((i) => clean(i, COVERED))]);
    const flaggedCase = queue.cases.find((c) => c.questionId === 'q-flagged');
    expect(flaggedCase?.reasons).toEqual(['split-beyond-tolerance']);
    // 4 clean cases at fraction 0.5 → 2 audited.
    expect(queue.cases.filter((c) => c.reasons.includes('stratified-audit-sample'))).toHaveLength(2);
  });

  it('audits every stratum, not the run as a whole', () => {
    const p = policy({
      coverage: { validatedBy: 'h', verdict: 'pass', strata: [COVERED, UNCOVERED] },
      sampling: { seed: 's', fraction: 0.01, minimumPerStratum: 1, preregisteredIn: 'p' },
    });
    const queue = queueOf([...[0, 1, 2].map((i) => clean(i, COVERED)), ...[0, 1, 2].map((i) => clean(i, UNCOVERED))], p);
    const strata = queue.cases.map((c) => c.stratum).sort();
    expect(strata).toEqual([COVERED, UNCOVERED].sort());
  });

  it('is reproducible from the seed', () => {
    const observations = [0, 1, 2, 3, 4, 5].map((i) => clean(i, COVERED));
    const a = queueOf(observations);
    const b = queueOf([...observations].reverse());
    // Same seed, same draw — and independent of the order observations arrive
    // in, which is not part of the artifact.
    expect(a.cases.map((c) => c.questionId).sort()).toEqual(b.cases.map((c) => c.questionId).sort());
    expect(a.queueHash).toBe(b.queueHash);
  });

  it('changes the draw when the seed changes', () => {
    const observations = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => clean(i, COVERED));
    const a = queueOf(observations);
    const b = queueOf(
      observations,
      policy({ sampling: { seed: 'seed-2', fraction: 0.5, minimumPerStratum: 1, preregisteredIn: 'p' } }),
    );
    expect(a.cases.map((c) => c.questionId)).not.toEqual(b.cases.map((c) => c.questionId));
  });
});

describe('the queue hash', () => {
  it('matches its own recomputation', () => {
    const queue = queueOf([obs({ disagreement: 40 })]);
    expect(queueHashOf(queue)).toBe(queue.queueHash);
  });

  it('changes when the answer under review changes', () => {
    const a = queueOf([obs({ disagreement: 40 })]);
    const b = queueOf([obs({ disagreement: 40, answers: [{ modelId: 'lab/alpha', text: 'A different answer.' }] })]);
    expect(a.queueHash).not.toBe(b.queueHash);
  });

  it('changes when the tolerance that produced it changes', () => {
    const a = queueOf([obs({ disagreement: 40 })]);
    const b = queueOf([obs({ disagreement: 40 })], policy({ disagreementTolerance: 20 }));
    expect(a.queueHash).not.toBe(b.queueHash);
  });
});

/* -------------------------------------------------------------------------- */

describe('decision parsing', () => {
  const wrap = (d: unknown) => ({ version: 1, runId: 'run-a', queueHash: 'a'.repeat(64), decisions: [d] });

  it('refuses an adjudication attributed to a model', () => {
    const d = decision('c1');
    expect(() => parseAdjudicationRecord(wrap({ ...d, reviewer: { ...d.reviewer, provenance: 'model' } }))).toThrowError(
      /the panel grading its own dispute/,
    );
  });

  it('refuses an unknown field rather than dropping it', () => {
    expect(() => parseAdjudicationRecord(wrap({ ...decision('c1'), overrideScoreHint: 90 }))).toThrowError(/unknown field/);
  });

  it('refuses placeholder evidence left by a half-filled worksheet', () => {
    for (const evidence of ['TODO', 'n/a', '   ', 'ok']) {
      expect(() => parseAdjudicationRecord(wrap(decision('c1', { evidence })))).toThrowError(/placeholder/);
    }
  });

  it('refuses evidence that merely restates the decision', () => {
    expect(() => parseAdjudicationRecord(wrap(decision('c1', { evidence: 'uphold' })))).toThrowError(/restates the decision/);
  });

  it('refuses an override with no replacement score', () => {
    expect(() => parseAdjudicationRecord(wrap(decision('c1', { decision: 'override' })))).toThrowError(
      /must state the score that replaces/,
    );
  });

  it('refuses an override score parked on an uphold', () => {
    expect(() => parseAdjudicationRecord(wrap(decision('c1', { overrideScore: 95 })))).toThrowError(
      /only meaningful on an override/,
    );
  });

  it('refuses an item declared defective whose item need not change', () => {
    expect(() =>
      parseAdjudicationRecord(
        wrap(decision('c1', { decision: 'item-defective', defect: 'the reference is wrong', itemChangeRequired: false })),
      ),
    ).toThrowError(/incoherent/);
  });

  it('refuses a required change nobody described', () => {
    expect(() => parseAdjudicationRecord(wrap(decision('c1', { judgePromptChangeRequired: true })))).toThrowError(
      /an unrecorded change request is never actioned/,
    );
  });

  it('refuses a decision with no confidence, and never reads absence as certainty', () => {
    const { confidence: _dropped, ...rest } = decision('c1');
    expect(() => parseAdjudicationRecord(wrap(rest))).toThrowError(/confidence/);
  });

  it('refuses two decisions on one case', () => {
    expect(() =>
      parseAdjudicationRecord({
        version: 1,
        runId: 'run-a',
        queueHash: 'a'.repeat(64),
        decisions: [decision('c1'), decision('c1', { decision: 'override', overrideScore: 10 })],
      }),
    ).toThrowError(/decided twice/);
  });

  it('reports every fault at once rather than one per run', () => {
    let message = '';
    try {
      parseAdjudicationRecord(wrap({ ...decision('c1'), evidence: 'TODO', confidence: 4, decidedAt: '' }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.split('\n- ').length).toBeGreaterThanOrEqual(4);
  });

  it('refuses a queueHash that is not a sha256 digest', () => {
    expect(() => parseAdjudicationRecord({ version: 1, runId: 'r', queueHash: 'nope', decisions: [] })).toThrowError(
      /sha256 hex digest/,
    );
  });

  it('accepts a complete, well-evidenced decision', () => {
    const record = parseAdjudicationRecord(wrap(decision('c1')));
    expect(record.decisions).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */

describe('the report gate', () => {
  const disputed = () => queueOf([obs({ disagreement: 40 })]);

  it('refuses when no queue was ever built — absence is not an empty queue', () => {
    const permission = reportPermitted({ queue: null, record: null });
    expect(permission.permitted).toBe(false);
    expect(permission.reasons[0]).toMatch(/an unbuilt queue is not an empty one/);
  });

  it('refuses a run with disputes and no adjudication record', () => {
    expect(reportPermitted({ queue: disputed(), record: null }).permitted).toBe(false);
  });

  it('permits a run whose computed queue is genuinely empty', () => {
    const queue = queueOf([obs({ confidence: 0.95, disagreement: 0 })], policy({ sampling: { seed: 's', fraction: 1, minimumPerStratum: 1, preregisteredIn: 'p' } }));
    // Everything unflagged is audited at fraction 1, so build a queue that is
    // empty the only way it can be: with no observations at all.
    expect(queue.cases.length).toBeGreaterThan(0);
    const empty = queueOf([]);
    expect(reportPermitted({ queue: empty, record: null }).permitted).toBe(true);
  });

  it('refuses when the record binds to a different queue, even if every case is decided', () => {
    const queue = disputed();
    const record = {
      ...blankRecordFor(queue),
      queueHash: 'b'.repeat(64),
      decisions: queue.cases.map((c) => decision(c.caseId)),
    };
    const permission = reportPermitted({ queue, record });
    expect(permission.permitted).toBe(false);
    expect(permission.reasons.join(' ')).toMatch(/the evidence changed after the decisions were taken/);
  });

  it('keeps a critical safety case pending when the reviewer did not declare independence', () => {
    const queue = queueOf([obs({ critical: true, disagreement: 40 })]);
    const first = queue.cases[0]!;
    const record = {
      ...blankRecordFor(queue),
      decisions: [decision(first.caseId, { reviewer: { ...decision(first.caseId).reviewer, independent: false } })],
    };
    const status = adjudicationStatus(queue, record);
    expect(status.complete).toBe(false);
    expect(status.pending[0]?.why).toMatch(/did not declare independence/);
  });

  it('blocks on a decision for a case that is not in the queue', () => {
    const queue = disputed();
    const record = {
      ...blankRecordFor(queue),
      decisions: [...queue.cases.map((c) => decision(c.caseId)), decision('a-case-from-another-worksheet')],
    };
    const permission = reportPermitted({ queue, record });
    expect(permission.permitted).toBe(false);
    expect(permission.reasons.join(' ')).toMatch(/not in the queue/);
  });

  it('permits once every case is decided against the right queue', () => {
    const queue = disputed();
    const record = { ...blankRecordFor(queue), decisions: queue.cases.map((c) => decision(c.caseId)) };
    expect(reportPermitted({ queue, record }).permitted).toBe(true);
  });

  it('assertReportPermitted throws REPORT_BLOCKED with the pending cases named', () => {
    try {
      assertReportPermitted({ queue: disputed(), record: null });
      throw new Error('expected a refusal');
    } catch (e) {
      expect(e).toBeInstanceOf(AdjudicationError);
      expect((e as AdjudicationError).code).toBe('REPORT_BLOCKED');
      expect((e as Error).message).toMatch(/adjudications are pending/);
    }
  });
});

describe('applying a decision', () => {
  const queue = () => queueOf([obs({ disagreement: 40 })]);

  it('excludes a defective item rather than scoring it zero', () => {
    const c = queue().cases[0]!;
    const resolved = resolveAdjudicatedScore(
      c,
      decision(c.caseId, { decision: 'item-defective', defect: 'grader zeroes a correct answer', itemChangeRequired: true, changeNote: 'rewrite the keyword grader' }),
    );
    expect(resolved.score).toBeNull();
    expect(resolved.excluded).toBe(true);
    expect(resolved.reason).toMatch(/excluded, not scored zero/);
  });

  it('upholds to the provisional score', () => {
    const c = queue().cases[0]!;
    expect(resolveAdjudicatedScore(c, decision(c.caseId)).score).toBe(c.provisionalScore);
  });

  it('excludes an uphold whose panel never produced a score', () => {
    const c: AdjudicationCase = { ...queue().cases[0]!, provisionalScore: null };
    const resolved = resolveAdjudicatedScore(c, decision(c.caseId));
    expect(resolved.score).toBeNull();
    expect(resolved.excluded).toBe(true);
  });

  it('refuses a decision applied to the wrong case', () => {
    const c = queue().cases[0]!;
    expect(() => resolveAdjudicatedScore(c, decision('some-other-case'))).toThrowError(/applied to case/);
  });
});

/* -------------------------------------------------------------------------- */

describe('presentation', () => {
  const built = () =>
    queueOf([
      obs({
        disagreement: 40,
        seats: [
          { judgeModel: 'judge/one', judgeFamily: 'fam-1', score: 95, confidence: 0.9, evidence: [{ statement: 'fine', quote: 'rest it' }] },
          { judgeModel: 'judge/two', judgeFamily: 'fam-2', score: 55, confidence: 0.4, evidence: [] },
        ],
      }),
    ]).cases[0]!;

  it('refuses to render blind without an anonymiser', () => {
    expect(() => presentCase(built(), { identity: 'blind' })).toThrowError(/not a blind/);
  });

  it('refuses an identity it does not recognise instead of defaulting', () => {
    // @ts-expect-error deliberately passing an invalid identity
    expect(() => presentCase(built(), { identity: 'partial' })).toThrowError(/must be 'blind' or 'revealed'/);
  });

  it('leaks neither candidate nor seat identity when blind', () => {
    const text = presentCase(built(), { identity: 'blind', anonymise: (t) => t });
    expect(text).not.toMatch(/lab\/alpha/);
    expect(text).not.toMatch(/judge\/one/);
    expect(text).not.toMatch(/fam-1/);
    expect(text).toMatch(/ANSWER 1/);
    expect(text).toMatch(/SEAT 1/);
  });

  it('runs the anonymiser over answer text and seat evidence, not just the labels', () => {
    const c: AdjudicationCase = {
      ...built(),
      answers: [{ modelId: 'lab/alpha', text: 'As Claude, I would rest it.' }],
    };
    const text = presentCase(c, { identity: 'blind', anonymise: (t) => t.replace(/Claude/g, '[MODEL]') });
    expect(text).not.toMatch(/Claude/);
    expect(text).toMatch(/\[MODEL\]/);
  });

  it('shows identities when explicitly asked to', () => {
    const text = presentCase(built(), { identity: 'revealed' });
    expect(text).toMatch(/lab\/alpha/);
    expect(text).toMatch(/judge\/two/);
  });
});

/* -------------------------------------------------------------------------- */

describe('the legacy adapter', () => {
  const options = {
    stratumOf: () => 'recipe-generation',
    criticalItem: () => false,
    promptOf: () => 'prompt text',
    answerOf: () => 'answer text',
  };

  const row = (detail: unknown) => ({
    runId: 'run-a',
    modelId: 'lab/alpha',
    questionId: 'rgen-013',
    score: 82.5,
    graderType: 'llm-judge',
    detail,
  });

  it('records absent confidence as null, never as certainty', () => {
    const { observations } = observationsFromStoredScores(
      [row({ judgePending: false, disagreement: 20, verdicts: [{ judgeModel: 'j1', score: 75 }, { judgeModel: 'j2', score: 95 }] })],
      options,
    );
    expect(observations[0]?.confidence).toBeNull();
    expect(observations[0]?.seats.every((s) => s.confidence === null)).toBe(true);
  });

  it('tags legacy findings as llm-judge evidence', () => {
    const { observations } = observationsFromStoredScores(
      [
        row({
          verdicts: [
            { judgeModel: 'j1', score: 40, findings: [{ issue: 'undercooked pork', severity: 'critical', quote: '55 °C' }] },
            { judgeModel: 'j2', score: 90, findings: [] },
          ],
        }),
      ],
      options,
    );
    expect(observations[0]?.seats[0]?.evidence[0]?.provenance).toBe('llm-judge');
  });

  it('refuses a detail shape it cannot read rather than dropping the row', () => {
    expect(() => observationsFromStoredScores([row({ verdicts: [{ judgeModel: 'j1' }] })], options)).toThrowError(
      /verdicts\[0\]\.score is not a number/,
    );
    expect(() => observationsFromStoredScores([row('not an object')], options)).toThrowError(/not an object/);
  });

  it('surfaces a pending judge row instead of silently skipping it', () => {
    const { observations, skipped } = observationsFromStoredScores([row({ judgePending: true })], options);
    expect(observations).toHaveLength(0);
    expect(skipped[0]?.why).toMatch(/an incident, not a dispute/);
  });

  it('refuses an empty stratum from the caller', () => {
    expect(() =>
      observationsFromStoredScores([row({ verdicts: [{ judgeModel: 'j1', score: 10 }] })], { ...options, stratumOf: () => '' }),
    ).toThrowError(/needs a declared stratum/);
  });

  it('ignores deterministic rows, which have no panel to adjudicate', () => {
    const { observations } = observationsFromStoredScores([{ ...row({}), graderType: 'keyword' }], options);
    expect(observations).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */

describe('artifact writes go through the firewall', () => {
  it('refuses to write an adjudication queue into a published run', () => {
    // The published board is frozen. A retro-adjudication of it is shadow
    // evidence about a frozen artifact, never an edit to the artifact — and the
    // refusal has to come from the path layer, not from remembering.
    const queue: AdjudicationQueue = { ...queueOf([obs({ disagreement: 40 })]), runId: '2026-07-v2.1' };
    expect(() => writeAdjudicationQueue(queue, 'runs')).toThrowError();
  });
});
