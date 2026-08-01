# Authoring templates (M3.2)

Skeletons for the item shapes Stage 3 authors. The master plan lists nine;
**seven are built here.** Two are deferred with reasons:

- **Pairwise creative comparison** — pairwise judge mode is blocked by KI-004
  (the rater-unit fold contradicts itself); Palate/preference judging is Stage 5.
- **Sensory / image-supported** — the plan defers these to "later tracks".

Every template assumes the shared rules in `authoring-guide.md`: validity-first
authoring, the judge-dominance rule, granular provenance, a registered
`scenarioFamily`, `-101+` ids, and a canary line. All items are `status:
candidate`, `verificationState: draft`.

The adversarial-fixture vocabulary (`adversarialCases[].kind`) covers the M3.5
twelve attack classes exactly: `correct-concise`, `correct-unconventional`,
`polished-but-wrong`, `verbose-non-answer`, `hedged-contradictory`,
`keyword-stuffing`, `negation-abuse`, `judge-influence`, `hard-constraint-miss`,
`style-variation`, `semantic-equivalent-prompt`, `alternative-valid-plan`,
`invalid-plan-convincing-answer`. A `correct-*` fixture must use `expect:
at-least` (the schema refuses `at-most` on a correct answer); a wrong/attack
fixture uses `expect: at-most`.

## Shared block skeleton

Every v3 item carries these blocks (fields elided with `…`):

```yaml
- id: <prefix>-1NN
  category: <one of the 8 CATEGORY_IDS — nearest for KitchenPlan/Interactive>
  difficulty: 4            # 1–5, a hypothesis
  status: candidate
  addedIn: v3
  public: true
  prompt: >
    <the scenario, in ordinary language>
  classification:
    primaryCapability: <one CRAFT_AXIS_ID>
    evidenceLayer: <fundamentals-gate | kitchen-plan | interactive-kitchen | craft-prose | palate>
    taskFamily: <free string naming the archetype>
    scenarioFamily: <registered id from scenario-families.yaml>
    stratumHypothesis: { stratum: chef-frontier, rationale: "hypothesis: …", certified: false }
    shortcutBlocked: >
      <the failure mode this item exists to block>
  provenance:
    authoringChain:
      - { stage: human-seed, actor: "jordan", note: "…" }      # if seeded
      - { stage: agent-draft, actor: "claude", actorVersion: "<exact model id>" }
    modelExposures:
      - { model: "<exact model id>", actorVersion: "…", purpose: authoring }
    verificationState: draft
  grader: { … }            # see per-template
  referenceAnswer: >        # required by schema even for judge-first items
    <one fully correct answer — NOT the only acceptable one>
  failingAnswer: >          # required on every llm-judge candidate
    <a plausible wrong answer that must score low>
  judgePack: { … }         # see below
  adversarialCases: [ … ]  # ≥ the family's required attack classes
```

### judgePack skeleton (required on judge-graded items)

```yaml
  judgePack:
    capabilityUnderTest: >
      <the one thing this item measures>
    hardConstraints:        # may be empty, but must be present
      - "<a constraint any acceptable answer must satisfy>"
    criteria:               # atomic; at least one; kinds include/avoid/critical/exceptional
      - { id: c1, kind: critical, statement: "<applies the defeating fact>", weight: 1, dimension: <name> }
    intendedOutcome: [ practical ]         # ≥1 of sensory/practical/historical
    solutionFamilies:       # ≥2, OR one + singleFamilyJustification
      - "<acceptable approach A>"
      - "<materially different acceptable approach B>"
    commonFailureModes:
      - "<the canonical trap, named>"
    workedExamples:         # ALL FOUR kinds required by schema
      - { kind: passing, answer: "…" }
      - { kind: ordinary, answer: "…" }
      - { kind: plausible-wrong, answer: "<= the canonical trap, written well>" }
      - { kind: failing, answer: "…" }
    sources:
      - { citation: "…", confidence: high }
```

For `judgeMode: dimension` items, `anchors` (five 0–4 bands per scored
dimension, observability-checked) are **required** by the schema. The 0–4 bands
describe what *applying the defeating fact* looks like at each level.

---

## 1. Single-turn structured decision
Families: applied theory, adaptation. Home of the canonical-trap pattern.
Grader: `llm-judge`, `judgeMode: dimension`, `judgeWeight: 0.8–1.0`.
Required adversarial kinds: `correct-concise` (at-least), `polished-but-wrong`
(at-most, carrying the trap), `style-variation`, `semantic-equivalent-prompt`.
See `frontier-item-principle.md` for the full recipe.

## 2. Multi-turn diagnosis
Family: diagnosis & recovery. Grader: `llm-judge` + a feasibility/safety
deterministic check (NOT judge-only, per the judge-dominance rule). The
"correct-except-one-detail" shape: everything the cook did is right except one
thing; **blaming a correct step is the critical fault** (a `critical` criterion).
Required adversarial kinds add `hard-constraint-miss` and
`invalid-plan-convincing-answer`.

## 3. Historical / contextual analysis
Family: history & context. Grader: `llm-judge`, judge-dominant permitted.
Sources are mandatory and `source.confidence: contested` is legal — a contested
origin is a good item only when flagging the disagreement IS the expected
answer. `hardConstraints` include "cites credible sources" and "does not present
a myth as documented fact". Required adversarial kinds add
`hedged-contradictory`.

## 4. Service timeline
Family: KitchenPlan (scheduling archetype). Maps to `category: technique` or
`recipe-generation`; `evidenceLayer: kitchen-plan`. Grader gate is
`validatePlan` via `outputContract: { format: kitchen-plan }` +
`kitchenPlanContract`. **Author the reference plan first**, run it through
`validatePlan` and the TRN renderer until clean, then write the prompt backwards
from it. At least two service-timeline items use shared equipment and fragile
holding windows. Required: `validatorFixtures` with ≥1 declared-invalid plan
that must fail, plus an `alternative-valid-plan` fixture that must pass (the
validator must never reject a viable different path).

## 5. KitchenPlan compile / audit / repair / state
Family: KitchenPlan. Same gate and output contract as the timeline template.
- **compile**: prose recipe → plan object.
- **audit**: find the missing/unsafe/impossible edge.
- **repair**: smallest viable change to fix a broken plan.
- **state probe**: what exists, where, and in what state at minute X.
Each ships declared-invalid fixtures naming the `expectedFinding`.

## 6. Paired ambiguity + interactive recovery
Family: interactive ambiguity. Maps to nearest category;
`evidenceLayer: interactive-kitchen`; uses `interactiveScript` (fixed two-turn).
**Author in pairs** sharing one `scenarioFamily`: an ambiguous prompt and a
clear counterpart. The ambiguous item penalises reckless guessing; the clear
item penalises needless questioning (M1.6 — asking when the answer is
determined is a fault). Grader is NOT judge-only: an initial-action / final-state
check gates the recovery-quality judgement. Represent preference, common-sense
and safety ambiguity as *separate* families (the registry does this).

## 7. Recipe critique
Families: flavour/sensory, adaptation. Grader: `llm-judge`, judge-dominant
permitted for flavour; a hard-constraint gate for allergen/diet items. The
"construction under absence" shape (a common flavour lever forbidden) and the
"defend or reject an unusual combination" shape live here. Palate/pairwise
judging is deferred to Stage 5; for now these are single-answer dimension items.

---

## The true-premise twin (cross-cutting feature)

A false-premise trap item may declare a **twin** sharing its `scenarioFamily`,
where the premise is *true* and the canonical answer is *correct*. This
penalises reflexive premise-contradiction — the FalseQA/AbstentionBench finding
(see `docs/research/eval-research-2026-06.md`) that traps are farmable by a
model that reflexively rejects premises. **Judge-first only**: the pre-pivot
branches' 15 keyword twins were affirmation gates a premise-rejecting answer
passed on the word "right", and are not salvageable. Author the twin so that the
*confident, correct* answer scores top and a hedging premise-doubt scores low —
the mirror image of the trap item's rubric.
