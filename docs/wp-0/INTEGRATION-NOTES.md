# WP-0 / v3 integration notes

Appended by each workstream, never overwritten. Each section says what the
integration pass must wire up or repair for that workstream's code.

## packages/core — v3 domain contract (schema.ts, types.ts, constructs.ts)

No new CLI command. The contract is types, zod schemas and pure predicates; every
v3 field is optional, so `bench validate` still reports 184 questions valid and
184 reference answers scoring 100 with no wiring change.

Two things the integration pass has to do:

1. **`packages/runner/src/judge.ts:47` will no longer typecheck.** The llm-judge
   `rubric` array is now `(RubricCriterion | AtomicCriterion)[]`, and an atomic
   criterion has no `name` or `description`. Replace

   ```ts
   return question.grader.rubric.map((c) => `${c.name}: ${c.description.trim()}`).join('\n');
   ```

   with

   ```ts
   return question.grader.rubric.map(criterionAttentionHint).join('\n');
   ```

   `criterionAttentionHint` is exported from `@cookingbench/core` and renders
   either shape. `isAtomicCriterion` is exported as a type guard if the judge
   needs to branch further (atomic criteria carry `kind`, `statement`, `weight`
   and an optional `dimension`).

2. **`questionSchema` is now a `ZodEffects`, not a `ZodObject`**, because the
   cross-field rules (dimension mode requires anchors; a KitchenPlan output
   contract requires a `kitchenPlanContract`; a criterion may not name an
   unanchored dimension) cannot live on the individual blocks. `.parse` and
   `.safeParse` are unaffected. Anything needing `.extend()`, `.pick()` or
   `.partial()` — authoring drafts, for instance — should use the exported
   `questionObjectSchema`, remembering that it does not carry those refinements.

Also worth knowing: `addedIn` now accepts `'v3'` (default is still `'v1'`), and
`resolveCraftWeights` throws unless given a full approval record. There is
deliberately no importable `CRAFT_WEIGHTS` constant — M1.5's weights are an
unapproved proposal and reaching them requires
`proposedCraftWeights('documentation-only' | 'sensitivity-analysis')`.

## packages/core — M2.1/M2.2 grading modes and hard caps (graders/)

New: `graders/dimension.ts`, `graders/pairwise.ts`, `graders/caps.ts`. The
cascade router lives in `graders/index.ts` (`routeCascade`, `routeDimensionMode`)
rather than a fourth file, and everything is re-exported through
`@cookingbench/core`. All of it is pure — no I/O, no model calls — so the routing
decision is reproducible from stored artifacts.

**No new CLI command.** These are libraries the judge pipeline calls. There is
nothing for `cli.ts` to add a verb for.

What the integration pass has to wire up:

1. **`judge.ts` must stop dropping the declared weights.** This is the headline
   defect: the dataset declares 97 rubric weights and the judge pipeline reads
   none of them, because judge-v2 scores by deduction from 100 and uses the
   rubric only as attention hints. For an item with
   `grader.judgeMode === 'dimension'`, collect anchored 0–4 bands per criterion
   and call `combineDimensions(criteria, bands)` (or
   `combineDimensionPanel(criteria, seats)` for a panel). Items with no
   `judgeMode` keep the legacy deduction route untouched.

2. **Order of operations is fixed and must not be rearranged**:
   weighted score → dimension ceilings (`capDimensions`) → task caps
   (`applyCaps`) → route. `routeCascade` already does this; a caller assembling
   the pieces by hand must follow it. Caps are non-compensatory and are applied
   after the weighted score, never folded in as a negative weight.

3. **The judge ballot schema needs three fields it does not have**: a per-seat
   `confidence` (absent escalates — it is never read as certainty), an anchored
   `band` per criterion with `null` for abstain (a silently omitted criterion is
   refused), and cap findings carrying `evidence:
   'deterministic' | 'human' | 'llm-judge'`. Provenance on a safety finding is
   what makes M2.2's "never LLM-only" rule enforceable.

4. **`routeCascade` refuses a resolving deterministic check served together with
   a judge panel.** Pass `resolves: false` to blend a constraint-check component
   in at `policy.judgeWeight` (default 0.7, matching `blendJudgeScore`), or omit
   the judgement.

5. **Storage.** `CascadeResult` carries the four things M2.1 requires of every
   automated result — `route`, `confidence`, `judgeDisagreement`,
   `humanCouldChange` — plus `escalations` and the cap record. These belong in
   the run artifacts; an escalated item has `score: null` and its automation
   number preserved as `provisionalScore`, and the reporting layer must not
   publish the latter as a score.

Two thresholds are **declared, not measured**, and both are named constants so a
report can print them with the caveat: `DEFAULT_DISAGREEMENT_TOLERANCE = 15`
(carried over from v2 practice) and `DEFAULT_MINIMUM_CONFIDENCE = 0.7`. The cap
ceilings themselves are the plan's own proposed policy parameters pending
independent food-safety and measurement review — see `CAP_POLICY_STATUS`.

The `unsupported-historical-claim` cap has **no numeric ceiling in the plan**, so
the item must declare one via `dimensionCeiling` on the finding; `applyCaps`
throws rather than defaulting.

Tests: `packages/core/test/graders-v3.test.ts` (67).

## packages/runner/src/judge.ts — M2.1 grading modes and the M2.5 jury

Nothing existing changes shape. `judgeAnswerPanel`, `judgeAnswer`, `panelSeats`,
`identityIndex`, `buildJudgeMessages`, `parseJudgeResponse` and
`JUDGE_PROMPT_VERSION` keep their signatures, so `cli.ts` and `calibration.ts`
compile and behave as before. Two behavioural changes to know about:

1. **The v2 route now refuses a v3 item.** `buildJudgeMessages`,
   `parseJudgeResponse` and `judgeAnswerPanel` throw when the item declares
   `judgeMode: dimension | pairwise`. `cmdJudge` already catches per-answer
   errors and leaves the row `judgePending`, so an unwired v3 item shows up as
   an unjudged row rather than as a silently downgraded score. Wire the v3
   routes before authoring v3 items into a paid run.
2. **Prompts are now blind-checked at build time.** `buildJudgeMessages` calls
   `assertPromptBlind`, which throws if the assembled prompt names a vendor or
   model outright. Today's 184 items pass (there is a standing test); a new item
   whose reference answer says "unlike Gemini 3.1…" will fail at judging.

### What the CLI should call

Pass the roster-derived lexicon everywhere, so blinding covers the live roster
and not just the static vendor list:

```ts
const lexicon = blindingLexicon(loadModels());          // optional last arg on
judgeAnswerPanel(client, panel, modelId, q, text, identify, spend, lexicon);
judgeAnswer(client, judgeModel, q, text, spend, lexicon);
```

The v3 flow is three steps, and the middle one is the preregistration:

```ts
const identify = identityIndex(loadModels());
const pool: JuryPool = { version: 'pool-2026-07', seats: [...] };   // versioned
assertPoolAdmissible(pool, identify);          // ≥5 distinct families, or throw

const design = buildJuryDesign({ pool, comparisons, identify, seed: runId });
// persist design.assignments + design.balance into the run directory BEFORE any
// paid judging: a balanced incomplete-block assignment that is only computed at
// spend time is not preregistered. `design.balance.balanced` must be true and
// `design.balance.routedToHuman` is the adjudication queue.

const seating = juryFor(design, key);          // { ok: false, routeTo: 'human' }
if (!seating.ok) { /* queue for M2.6 adjudication — never seat two */ }
else if (mode === 'dimension') {
  await judgeDimensionAnswer(client, seating, question, answerText,
    { spend, lexicon, thresholds });
} else {
  await judgePairwiseComparison(client, seating, question,
    { modelId: a, answerText: aText }, { modelId: b, answerText: bText },
    { spend, lexicon, thresholds });
}
```

Suggested commands (this module deliberately adds none):

- `pnpm bench jury-design --run <id> --pool-version <v> [--seed <s>]` →
  `buildJuryDesign(...)`, writes `jury-design.json` + the balance report.
- `pnpm bench judge --run <id>` → unchanged for fault items; for v3 items reads
  `jury-design.json` and calls `judgeDimensionAnswer` /
  `judgePairwiseComparison` as above.

### What the artifacts must retain

M2.5 asks for criterion decisions, evidence, individual verdicts, confidence and
vote entropy — not the mean. Both aggregates return all of it; persist the whole
object, including `escalations` (M2.6's queue), `leaveOneFamilyOut` (M2.8's
sensitivity) and `thresholds` (the provisional policy numbers the run used).
Record `JUDGE_PROMPT_VERSIONS[mode]`, not the single `JUDGE_PROMPT_VERSION`
constant: a ballot is only comparable within its own mode's version.

`applySeverityCorrection` exists but throws unless it is declared
`appliedAs: 'sensitivity'` and `learnedOn: 'development'`. There is no code path
that makes a severity-weighted number the primary; do not add one.

### Known limitation, for whoever picks this up

`data/models.yaml`'s `family` is a **marketing tier** (`claude-frontier`,
`gpt-mid`), not a base-model identity. Seating, `judgeFamilyGroups` and the
balanced design all treat it as one, so cross-provider rebadge detection is
correct in code and unexercised on the real roster — the tests cover it with
synthetic rosters. A real registry of base-model identities is the proper fix
and belongs with the model registry, not here.
