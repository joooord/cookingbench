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

## packages/core — M1.2 KitchenPlan validator and TRN renderer (kitchenplan.ts, trn.ts)

New: `packages/core/src/kitchenplan.ts` (graph validator, scaling) and
`packages/core/src/trn.ts` (pure table model). Both are pure — no I/O, no model
calls — so a stored plan re-validates and re-renders identically from artifacts.

**No new CLI command.** These are libraries. If a verb is ever wanted for
authoring work, the entry points are `readKitchenPlan(raw)` →
`validateKitchenPlan(plan, constraints, { contract })` → `buildTrnTable(plan)`;
nothing in them needs argv.

What the integration pass has to wire up:

1. **`packages/core/src/index.ts` does not re-export either module.** Add
   `export * from './kitchenplan.js';` and `export * from './trn.js';`. That file
   belongs to another workstream, so it was left alone. Nothing outside the
   package can import them until this lands.

2. **`kitchenPlanContractSchema` needs an optional machine-readable constraint
   block.** The contract currently carries `verifiedLimits` as free-text
   statements, which a validator cannot measure against. The validator takes a
   `VerifiedConstraints` object (`verifiedConstraintsSchema`, exported from
   `kitchenplan.ts`) whose `source` enum is restricted to `prompt | judge-pack`.
   Suggested additive field: `kitchenPlanContract.constraints?:
   VerifiedConstraints`, parsed with `readVerifiedConstraints`. Until then a
   caller must build the pack itself, and it must build it **from the item**.
   Passing anything a candidate produced defeats M1.2's firewall — the enum is
   the only thing standing between the benchmark and plans that validate
   themselves.

3. **Three layers must be stored and reported separately**, never summed:
   `PlanValidation.format`, `.structure`, `.culinary`. `format` is output-contract
   failure (bad JSON, missing required object), `structure` is the plan against
   itself, `culinary` is the plan against the stated kitchen. Each layer's
   verdict is `pass | fail | unvalidatable`; `unvalidatable` means a limit was
   never stated and must not be scored as either competence or failure. A
   response whose plan never parsed yields `formatFailure(findings)`, whose
   culinary verdict is `unvalidatable` — a culinary `pass` there would read as
   "cooks fine" on the strength of having produced no plan.

4. **Findings carry `severity: 'violation' | 'warning'`.** Warnings are the
   M1.2 "never reject a viable approach" valve: a schedule that only collides
   when every step runs long, a scaled plan that lengthens a braise, a
   provenance claim the pack cannot corroborate. They must not fail an item.

5. **`bench validate` should call the validator's item-side refusals.** It
   throws `KitchenPlanValidationError` — not a finding against the candidate —
   when an item requires an unknown plan object or pins an incompatible
   `validatorVersion` (`PLAN_VALIDATOR_VERSION`, currently `kitchenplan-1.0.0`;
   major must match, the validator may be newer within it). Those are authoring
   bugs and should die in validate, not silently score a model down.

6. **`VerifiedEquipment.countAvailable` is concurrent uses, not appliances.** An
   oven that takes two trays at once is `countAvailable: 2`. Item authors need
   telling; the contention check counts simultaneous operations against it.

7. **The web app renders `TrnTable`, it does not build one.** `buildTrnTable`
   returns rows/cells/steps or a refusal (`cycle`, `unresolved-input`,
   `duplicate-id`, `no-root`) — render the refusal, never a partial table, and
   keep `orphanRows` visible: hiding a declared-but-unused ingredient conceals
   the fault the validator reports.

The trajectory check's modelling limits are real and belong next to any number
it produces: it counts declared minutes only and knows nothing about thermal
mass, so a violation is strong evidence and a pass is not a safety certificate.

Tests: `packages/core/test/kitchenplan.test.ts` (72), covering both modules.

## packages/core — M2.7/M2.8 jury-fitness statistics (agreement.ts)

New: `packages/core/src/agreement.ts` + `packages/core/test/agreement.test.ts`
(100 tests, passing). Pure functions only — no I/O, no model calls, no unseeded
randomness — so a judge-validation report is reproducible from committed
fixtures.

**`src/index.ts` needs `export * from './agreement.js';`.** index.ts is owned by
the integration pass, so this workstream did not touch it. Nothing else in the
repo imports agreement.ts yet.

**No CLI command was added.** If one is wanted later, the shape is:

    pnpm bench judge-validate --labels <path> --ballots <path> \
                              --criteria <path> --out <path>

which should read a `judgeBenchLabelSetSchema` file, call the statistics below,
assemble a `Record<string, Measurement>` and hand it to
`evaluateReleaseCriteria(criteria, measurements)`. The criteria must come from a
**file**, not from code: `provisionalM28Criteria('documentation-only' | 'dry-run')`
returns M2.8's list for seeding that file, and deliberately refuses any other
argument, because a gate whose thresholds are compiled into the evaluator cannot
be shown to have been frozen before the holdout was opened.

Entry points the wiring will want:

- `krippendorffAlpha(ratings, { metric: 'ordinal', domain: [0,1,2,3,4] })` for
  anchored dimension bands; `metric: 'nominal'` (or `'custom'` with a distance
  vetted by `assertPairwiseDistance`) for canonicalised pairwise outcomes.
- `bootstrapAlpha(ratings, { clusterBy: 'rater' | 'family' | 'unit', ... })`.
- `pairwiseRatingsForAgreement(ballots)` — canonicalises presentation to
  candidate identity, maps `abstain` and order-unstable rater units to `null`.
- `humanParity`, `orderEffect`, `repeatConsistency`, `identicalAnswerControl`,
  `paddedDuplicatePreference`, `styleInvariance`, `safetyRates`,
  `agreementRate`, `macroF1`, `stratumAgreement`, `clopperPearson`.

Three things the integration pass must not "tidy":

1. **`alpha` is `number | null`.** A constant matrix (every seat gave every case
   a 4) has expected disagreement 0 and no defined coefficient. It returns
   `null` with `degenerate: 'no-variation'`, never 1.0 — and the release
   evaluator treats a null measurement as `not-measured`, which makes the
   verdict `incomplete`, never `pass`.
2. **`evaluateReleaseCriteria` has no default criteria argument** and returns
   `incomplete` on a missing measurement. Do not add a fallback list.
3. **`orderEffect` requires a preregistered `equivalenceMarginPoints`** and
   decides equivalence on the bootstrap interval, not the point estimate.

Human labels are an input, not an output: `judgeBenchLabelSetSchema` refuses any
label whose `provenance` is `model`, refuses a set with fewer than two raters,
refuses the same rater labelling a case twice, and refuses a `sealed-holdout`
tranche with no preregistration id. There is no fixture data in the repo yet —
that is Gate 2 work for qualified humans.

Possible overlap to check at integration time: another workstream added
`packages/core/src/stats.ts` in the same window. If it also exports a bootstrap
helper, reconcile the two rather than letting both ship; agreement.ts's
`clusteredBootstrap` requires an explicit `relabel` function for a reason
(duplicate cluster draws must not merge into one unit) and that requirement
should survive any merge.

## packages/core/src/stats.ts + packages/runner/src/analyze.ts — M4.3/M4.4 statistics

New: `packages/core/src/stats.ts` (pure; no I/O, no model calls). `analyze.ts`
gains a `confirmatory` block alongside the existing `separation` array. Nothing
existing changed shape: `analyzeRun`, `tiedRanks`, `writeAnalysis` and
`PairSeparation` keep their signatures and their numbers, so `cli.ts`,
`apps/web/lib/data.ts` and every committed `analysis.json` are unaffected.

Three things the integration pass has to do:

1. **`packages/core/src/index.ts` does not re-export stats.ts**, and that file
   belongs to another workstream. Until it gains `export * from './stats.js';`,
   `analyze.ts` imports it by relative path (`../../core/src/stats.js`) with a
   comment saying so. Add the re-export, then change that one import line to
   `@cookingbench/core`. `packages/runner/test/analyze.test.ts` has the same
   import and needs the same edit.

2. **`analyzeRun` takes an optional 5th argument.** `cli.ts` calls it with four
   and keeps working, but with no options no practical margin is preregistered,
   so `confirmatory[].soleWinner.model` is always `null` — deliberately. To
   allow a sole-winner claim the run must pass
   `{ confirmatory: { practicalMargin: { points, preregisteredIn, approvedBy,
   rationale } } }`, and the margin must be frozen **before** the run under
   M4.3. `resolvePracticalMargin` refuses anything less, including a margin of
   zero.

3. **`cmdAnalyze` should print the confirmatory block.** `formatConfirmatory`
   (exported from `analyze.ts`) returns the lines; there is no argv in it.

       for (const scope of ['active', 'frontier'] as const) {
         for (const line of formatConfirmatory(analysis, scope)) console.log(line);
       }

   No new verb. Suggested flags if any are ever wanted:
   `pnpm bench analyze --run <id> [--margin <points>] [--alpha 0.05]`.

### What the existing CLI output now contradicts

`cmdAnalyze` prints `separated`/`tied` off `separation`, which is **91
uncorrected tests at alpha 0.05** — the defect this workstream exists for. The
line `places (48/91 of all pairs separated)` should be relabelled as screening
and the places taken from `confirmatory[].places`. `tiedRanks` still works and
is still built from the full matrix (its one correct property), but its doc
comment no longer says "proven": M4.4 forbids that phrase for an unadjusted 95%
result and it was in this repo's own comments, CLI output and CLAUDE.md.
`assertClaimLanguage` will throw on it, and there is a standing test that every
line `formatConfirmatory` produces passes that check.

### Behaviour worth knowing before reading the numbers

- **Clustering is by `classification.scenarioFamily`.** None of the 184 current
  items declares one, so today every run reports `clustering:
  'item-unclustered'`, records a refusal, and **cannot name a sole winner
  whatever the gap**. That is the designed outcome, not a wiring gap: an item
  bootstrap treats variants of one scenario as independent evidence.
- **Repeats are averaged into their item**, so a twice-generated item is one
  item, not two. `confirmatory[].repeats` reports how many were folded.
- Two Holm families: all pairs (drives tiers/places) and leader-vs-rest (drives
  the sole-winner claim, with Bonferroni simultaneous intervals). A pair outside
  a declared `confirmatoryFamily` gets `pAdjusted: null` and `ordered: false` —
  untested is never treated as ordered.
- Every failure inside the confirmatory pass becomes a string in `refusals`; it
  never throws, and it never falls back to a permissive default.

### Available and not yet wired anywhere

`fitDavidson` / `davidsonSummary` / `davidsonClusterBootstrap` implement M4.4's
tie-aware pairwise summarisation over `PairwiseOutcome` from
`graders/pairwise.ts`. They need pairwise ballots, which no run artifact carries
yet, so nothing calls them. When the M2.1 pairwise route produces ballots, feed
them in as `{ a, b, outcome, cluster }` with candidate-identity outcomes (use
`canonicalise` from graders/pairwise.ts first — an `a` in a ballot means "the
first answer shown"). `both_unacceptable` is excluded from the fit and reported
per model as a release-gating signal; `davidsonSummary` runs the declared
exclusion sensitivity. `taste.ts` should import `ratingFromStrength` from here
rather than keeping its private copy of the same transform.

## M4.6 / M4.10 — specificity, simulation and paraphrase (packages/runner/src)

Three new modules, no CLI wiring (cli.ts belongs to the integration pass). All
three are pure: they take already-loaded data, never read or write the
filesystem, and never call a model or the network.

**`specificity.ts` — `bench specificity --run <id> --predictor <path.json>
[--scope a,b] [--seed <s>] [--reps <n>] [--inference-started-at <iso>]`**

1. `parseGeneralPredictorDocument(JSON.parse(readFileSync(predictorPath)))` —
   throws `SpecificityError` on anything malformed; print `.message` and exit
   non-zero.
2. `specificityAnalysis({ runId, outcomes, predictor, scope?, inferenceStartedAt?,
   seed?, reps? })` where `outcomes` are `{ modelId, overall, ci95, provider? }`
   taken from the run's `leaderboard.json` rows (`overallCi` → `ci95`).
3. Print `formatSpecificityReport(result)`.

Expect a REFUSAL today, and do not route around it: no verified OpenRouter →
Arena snapshot mapping exists, so every mapping is `asserted` and the module
refuses by design (M4.10). Run against the archived board it prints
`MAPPING_UNVERIFIED` for all 14 routes and produces no residual table. Even with
a verified mapping the archived run trips `omissionRecommended`: mean CI
half-width 3.58 points against a between-model SD of 3.42.

If the result is persisted, it must NOT go into `data/runs/**` — those are
frozen. Route it through a firewall output family; there is no `analysis`
family in `firewall.ts` today, so either add one or write under `shadow`.

`assessIncrementalValidity(inputs)` is the confirmatory gate and returns
`claimPermitted: false` unconditionally. There is deliberately no
incremental-validity estimator: the only culinary criterion available is the
benchmark's own scores, which were used to author and tune it. Do not "finish"
it during integration.

**`simulate.ts` — `bench simulate --run <id> [--seed <s>] [--reps <n>]
[--sims <n>] [--margin <points>]`**

`runSimulationSuite({ seed, matrix, judgedItems?, practicalMarginPoints?, reps?,
sims? })` then `formatSimulationReport(report)`. Build the matrix with
`matrixFromScores(readScores(runId))` — read-only — and pass the llm-judge item
ids as `judgedItems`. Two constraints: `reps` below ~400 is refused by
`clusterBootstrapMean` (a 0.025 quantile needs ten order statistics), and
`multiplicityCheck` reports `holmResolvable: false` below ~1,800 resamples for a
91-pair family, where a Holm error rate of 0 is a resolution artefact rather
than a result.

Measured on `2026-07-v2.1` (read-only, nothing written): median interval
half-width 2.12 against a between-model SD of 1.94 (ratio 1.10); the smallest
audited deletion that flips the leader is ONE item (0.5% of the evidence);
111 of 184 items are dead (identical for every model); 20 have non-positive
item-total correlation, `nutr-036` among them; top-group stability 0.36 against
M4.5's 0.90 target; a −15-point judge severity shift changes the leader. On a
null roster of 14 clones the uncorrected 91-pair family separates 12.6 pairs per
run with a family-wise error of 1.00, and Holm removes all of them.

**`paraphrase.ts` — `bench paraphrase --fixtures <path.json>`**

`compareParaphrase(pair)` per pair, then `summariseParaphraseSet` and
`formatParaphraseReport`. It consumes stored scores or fixtures and never calls
a model; generating the paraphrased answers is a separate, permitted activity.
Each pair needs an `attestation`, and `contentDrift` refuses a variant whose
quantities, units or constraint terms changed unless the attester listed the
difference verbatim in `acceptedDrift`. `wording-robust` additionally requires a
preregistered `equivalenceMarginPoints`; without one the verdict is
`inconclusive`, never robust.

Tests: `packages/runner/test/specificity.test.ts` and
`packages/runner/test/simulate.test.ts`. The paraphrase cases live in the latter
because this workstream was allocated two test files for three modules — move
them to `paraphrase.test.ts` when convenient.

Both modules import `fnv1a32`, `seededUniform`, `clusterBootstrapMean`,
`holmAdjust`, `rankFragility` and `smallestFlipSet` from
`../../core/src/stats.js` by relative path, for the reason `analyze.ts` already
documents: core's `exports` map does not expose stats.ts. Three one-line changes
when `index.ts` gains `export * from './stats.js'`.
