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
