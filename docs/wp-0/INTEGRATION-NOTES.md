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

## packages/runner — M4.1/M4.7/M4.8 manifest, derivation and run lifecycle

New: `packages/runner/src/manifest.ts`, `src/derive.ts`, `src/lifecycle.ts`,
`test/manifest.test.ts` (58 tests, passing). Nothing existing changed shape;
`cli.ts` was not touched. Every write goes through `writeRunFileAtomic`,
`writeOutputFileAtomic`, `appendRunFileLine` or a `resolveRunFile`-guarded path,
so the DATA-001 refusal on published runs holds unchanged (there is a test that
`writeRunManifest('canary', …)` throws `FirewallError`).

`manifestHash` and `canonicalJson` are imported and used verbatim. The golden
digests in `test/golden-hashes.test.ts` are untouched and must stay that way — a
second canonicalisation would invalidate every issued permit.

### Commands the integration pass should add

    pnpm bench manifest --run <id> [--tier all|active] [--limit N] \
        --evidence-class <c> --origin <o,…> --methodology <v> --git-commit <sha> \
        --candidate-models a,b --judge-models c,d --budget <usd> [--dry-run]
      → buildRunManifest(draft, questions) then writeRunManifest(runId, manifest, questions)
      The item set passed to BOTH calls must be the exact set the run executes
      (`runnableQuestions(tier)` sliced by `--limit`), not the whole dataset:
      the manifest declares what actually runs, and the verifier reconciles
      against that set.

    pnpm bench verify --run <id> [--complete] [--no-recompute]
      → verifyRunManifest(runId, { expectComplete, recompute }); non-zero exit
      when `ok` is false. Print `findings[]`. Use `--no-recompute` only to audit
      a frozen run whose bank has legitimately moved on.

    pnpm bench derive --from <src> --run <new> --reason "<why>" [--hardlink]
      → deriveRun({ sourceRunId, targetRunId, reason, mode })
      Refuses an uncommitted source, a same-id derivation, an occupied target.
      Copy is the default; `--hardlink` shares inodes with a published run, which
      is safe only because every writer here replaces by rename.

    pnpm bench release --run <id> --actor <who> --evidence "<link>"
      → buildReleaseChecklist(...) → writeReleaseChecklist(...) →
        transitionRun({ to: 'audited' | 'released', checklist })
    pnpm bench current-run --run <id> --reviewed-by <who> --evidence "<link>"
      → setCurrentRun({ runId, reviewedBy, reviewEvidence, checklist })

### The two behavioural changes that matter

1. **`cmdGrade` must stop preserving judge results unconditionally.** Route the
   prior `scores.json` through

       const verdict = staleScoresForRun(runId, { manifest, digest });
       const { retained, dropped } = retainableScores(priorScores, verdict);

   and write back only `retained`. There is deliberately no override flag. A
   validator change drops judged rows too — the graders module owns blending and
   cascade routing, and the 2026-07 audit's grader fix moved six of thirteen
   positions.

2. **`apps/web` should stop selecting a board by newest `generatedAt`.** The
   reviewed pointer lives in `data/runs/REGISTER.json` (`currentRun`), written
   only by `setCurrentRun` against a released entry and a complete checklist, and
   cleared automatically when that run is quarantined or retired. `readCurrentRun`
   THROWS when no pointer exists — that is the fail-closed reading, and the site
   should render "no current result" rather than falling back to the heuristic.
   The register is a plain JSON file in `data/runs/`; nothing else in the repo
   treats a non-directory entry there as a run.

### Wiring for M4.8 (cheap, and worth doing at the same time)

- `cmdRun`: after `writeResponse`, call `appendRawAnswer(response)`. The id is
  `responseIdentity`, which is also `candidateRetryKey`, so a retried or resumed
  batch appends nothing the second time.
- `cmdJudge`: after each ballot, `appendBallot(key, ballot)` with
  `promptVersion: JUDGE_PROMPT_VERSIONS[mode]`.
- Both journals are hash-chained. `verifyJournal` catches edits, reordering and
  interior deletion; it CANNOT catch suffix truncation — pin `journalHead` or
  rely on the checklist's `artifacts-committed` item, which compares against git.

### Not done, and why

- **`traceability.yaml` is not updated.** It belongs to another workstream. Its
  DATA-002 gaps are now closed in code; the entry should gain
  `packages/runner/src/manifest.ts — computeContentDigest / writeRunManifest /
  verifyRunManifest` as enforcement points and cite these exact test names:
  - `DATA-002 — a command writes the manifest, and it must be true > refuses a manifest whose declared hashes do not describe the supplied items`
  - `DATA-002 — a changed bank cannot masquerade as the manifested one > reports drift, and names the items that moved`
  - `DATA-002 — a changed bank cannot masquerade as the manifested one > never reports ok when it could not check`
  RELEASE-002's second gap (`apps/web` selects by newest generatedAt) closes only
  once the site reads the pointer.
- **`RunConfig` gained no field.** A derived run's `config.json` carries
  `derivedFrom` and `releaseState: 'draft'` as additive JSON via a local
  `DerivedRunConfig` interface in derive.ts, because `packages/core/src/types.ts`
  is owned elsewhere. Fold them into `RunConfig` if that is tidier; `readRunConfig`
  already casts, so nothing breaks either way.
- **`RELEASED` is written by `transitionRun`, last.** It is what `isReleasedOnDisk`
  reads to freeze a run, so writing it any earlier would lock the run out of
  recording its own release in `lifecycle.ndjson`. Do not reorder that.

## packages/runner — M2.6 adjudication and M2.7 Culinary JudgeBench

New: `src/adjudicate.ts` and `src/judgebench.ts`, with
`test/adjudicate.test.ts` (72) and `test/judgebench.test.ts` (75). Both modules
are pure apart from four firewall-guarded I/O helpers at the bottom of
`adjudicate.ts`; neither calls a model, reads a clock or uses unseeded
randomness, so a queue and an adjudication verdict are reproducible from
artifacts.

**No zod in these files, and not by preference.** `packages/runner` does not
depend on zod — only `packages/core` does, and under pnpm's strict layout
`import { z } from 'zod'` does not resolve inside the runner at all. Both
modules validate by hand in the style of `firewall.ts`'s registry reader,
collecting every fault and throwing once. If the integration pass adds zod to
`packages/runner/package.json`, these parsers can be replaced one for one; the
exported function names (`parseAdjudicationRecord`, `readDevelopmentBank`,
`readSealedBank`, `parseSealedCommitment`, `parseSealedHistory`) are the seam.

### The report gate — the one thing that MUST be wired

`cmdReport` currently generates a leaderboard with no reference to the 73
disputes `2026-07-v2.1` flagged. M2.6 forbids that. The wiring is:

```ts
const queue = buildAdjudicationQueue({ runId, observations, policy });   // or read the persisted one
const record = readAdjudicationRecord(runId, family);                    // null when absent
assertReportPermitted({ queue, record });                                // throws AdjudicationError('REPORT_BLOCKED')
```

`reportPermitted` is the non-throwing form and returns publishable reason
strings. **It refuses on `queue: null`.** A report path that skips the queue has
not shown there is nothing to review, and the whole module exists because
absence read as permission once already.

Suggested commands (this workstream adds none):

- `pnpm bench adjudicate open --run <id> [--family runs|shadow]` →
  `buildAdjudicationQueue` + `writeAdjudicationQueue`, then
  `writeAdjudicationRecord(blankRecordFor(queue))` as the worksheet, and print
  `formatAdjudicationQueue(queue)`.
- `pnpm bench adjudicate show --run <id> --case <caseId> [--reveal]` →
  `presentCase(c, { identity: 'blind', anonymise })`. `identity` has **no
  default**; blind mode **requires** an anonymiser, so pass
  `(t) => anonymizeAnswer(t, blindingLexicon(loadModels()))` from `judge.ts`.
  Candidate ids, seat ids and judge families are all hidden when blind, and
  `presentCase` is tested for not leaking them.
- `pnpm bench adjudicate status --run <id>` → `adjudicationStatus` +
  `formatAdjudicationStatus`.
- `pnpm bench judgebench plan --bank <path> --seed <s> --repeat-fraction <f>` →
  `buildHarnessPlan`.
- `pnpm bench judgebench open --commitment <path> --bank <path> --history <path>`
  → `openSealedBank`, writing the appended history back. This is the ONLY way
  to obtain a runnable sealed bank.

**`--family`**: `runs` writes into the run directory, which the firewall refuses
for a published run — correct, and there is a test asserting it for
`2026-07-v2.1`. Retro-adjudicating a frozen run writes to `shadow/<runId>/`.

### The number the queue will produce, so it is not a surprise

`UNVALIDATED_COVERAGE` is the honest state of this repository: no sealed
JudgeBench holdout has been opened, so **no stratum is inside validated
automation coverage**, so every case whose panel confidence was never recorded
is mandatory review. The legacy two-seat panel records no per-seat confidence at
all, so on `2026-07-v2.1` the queue is **all 630 judged answers, not the 73
flagged ones**. That is the size of the automatic acceptance nobody has
validated, not a bug in the module. The escape is the designed one: a passing
holdout that names the strata it powered.

Related: `observationsFromStoredScores` takes `stratumOf` as a required
callback and refuses an empty return. It deliberately does not default to
`question.category` — the audit sample and the coverage claim would then rest on
a field nobody chose as a stratum.

### Storage shapes

`AdjudicationQueue.queueHash` is sha256 over the whole queue minus the hash, and
`AdjudicationRecord.queueHash` binds to it. A re-judged answer or a re-authored
item changes the hash and reopens the gate; decisions taken against a different
queue never clear the current one. `resolveAdjudicatedScore` maps a decision to
a number — and `item-defective` **excludes, it does not score zero**, because
scoring zero charges the model for the benchmark's own fault (`subs-020`, twelve
of thirteen models).

### JudgeBench: what is deliberately absent

There is **no fixture data in the repository, and no gold label anywhere**.
Every case declares `label: null` (required, and the case object refuses unknown
keys, so an answer smuggled in as `expected` or `goldLabel` fails to load).
Labels are a separate human input joined by `caseId` through
`judgeBenchLabelSetSchema` in `packages/core/src/agreement.ts`, which refuses
`provenance: 'model'`. Authoring the banks and commissioning the labels is Gate 2
work for qualified humans; this workstream built the format and the harness.

`DevelopmentBank`, `SealedBank` and `OpenedSealedBank` are distinct branded
types. `buildHarnessPlan` and `harnessRatings` accept only
`DevelopmentBank | OpenedSealedBank`, so sealed material cannot reach a ballot
without passing `openSealedBank` — which verifies the pre-run hash commitment,
the declared composition, that the commitment predates the open, single-open by
commitment id AND by bank bytes, that no other tranche is open, and that the
protocol is not terminal. `assertFreshHoldoutPermitted` encodes M2.7's
fresh-tranche conditions: a different protocol hash (an identical one means the
change was cosmetic), fresh material, a new preregistration, full disclosure of
every prior attempt by id, and a re-freeze by somebody not involved in the last
one.

`harnessRatings` returns `AgreementRating[]` for non-pairwise cases and raw
`AuditBallot[]` for pairwise ones — it does NOT fold the two presentations into
a rater unit, because `pairwiseRatingsForAgreement` in `agreement.ts` already
does and a second copy would drift. Both types are imported type-only from
`../../core/src/agreement.js` by relative path, for the reason `analyze.ts`
documents; two one-line changes when `index.ts` gains
`export * from './agreement.js'`.

### Defect noticed elsewhere (not fixed — not this workstream's files)

**The pairwise vocabulary exists twice with different spellings.**
`packages/core/src/graders/pairwise.ts` uses `PAIRWISE_OUTCOMES = ['a','b',
'equal','both_unacceptable','abstain']` with `presentation: 'ab' | 'ba'`, while
`packages/runner/src/judge.ts` exports its own `PAIRWISE_OUTCOMES = ['A','B',
'equal','both_unacceptable','abstain']` with `PresentationOrder = 'AB' | 'BA'`.
Two spellings of one enum across the modules that hand ballots to each other is
one `===` away from silently dropping every ballot, or from canonicalising an
order twice. `judgebench.ts` follows the core/agreement spelling because that is
its consumer. They should be reconciled to one vocabulary before pairwise
ballots are persisted in any run artifact.

## packages/runner — WP-0 evidence firewall, six self-review defects

No new CLI command and no new entry function. Everything here is a repair to
modules `cli.ts` already imports (`ledger.ts`, `firewall.ts`, `openrouter.ts`),
so the integration pass has call sites to update rather than wiring to add.

### 1. `client.complete` now REQUIRES a cell and an estimate — four call sites

`questionId` and `estimateUsd` were optional on `CompletionOpts`, which meant a
caller that omitted `questionId` skipped `requireCell` entirely and a caller
that omitted `estimateUsd` reserved `?? 0` against the budget. Both are now
required, on a new `GuardedCompletionOpts`, and both are re-checked at runtime
because the type is erased. `CompletionOpts` still exists and still holds only
the transport knobs (`temperature`, `maxTokens`, `reasoning`).

The cell names the **candidate**, never the judge seat. Replace

```ts
questionId: question.id,
estimateUsd: worstCase,
```

with

```ts
cell: { modelId, questionId: question.id },
estimateUsd: worstCase,
```

- `src/cli.ts:640` and `src/cli.ts:651` (cmdRun, first attempt and retry) —
  `modelId` is the candidate being called, so `cell.modelId` is that same
  `modelId`. A candidate call whose cell names a different model is now refused.
- `src/cli.ts:1270` (cmdPilot) — same shape, `cell: { modelId, questionId: q.id }`.
- `src/judge.ts:2064` (`askJudge`) — **this one needs a new argument.** The first
  argument to `complete` is the SEAT; the cell must name the candidate whose
  answer is being scored, which `askJudge` does not currently receive. Thread the
  candidate model id down (`judgeAnswer` and friends already know it — it is the
  `modelId` on the stored response) and pass
  `cell: { modelId: candidateModelId, questionId: question.id }`.

That last change is the point of defect 4, not an incidental. Passing the seat
meant a judging permit had to enumerate seat × question — roughly 552 pairs for
a three-seat panel over 184 items — each precomputed by reproducing the panel's
FNV-1a seat hash by hand, and a change to that hash would have silently voided a
signed approval. A permit now authorises **which answers may be scored**, which
is what an approver actually decides.

`MockClient` needs no change: its `_opts` parameter is a supertype of the new
options, so it still satisfies `CompletionClient`.

### 2. `Firewall.requireCell` changed shape — `packages/runner/test/firewall.test.ts`

`requireCell(modelId, questionId, context)` is now
`requireCell({ kind, modelId, questionId }, context)`, where `kind` is
`'candidate' | 'judge'` and maps to the capability that authorises it. Three
lines in a file this workstream does not own need the new call shape (the
`.toThrow` assertions still hold; the `.not.toThrow` ones do not):

- `firewall.test.ts:240` → `fw.requireCell({ kind: 'candidate', modelId: 'openai/gpt-5.5', questionId: 'conv-001' }, 'probe')`
- `firewall.test.ts:264` → `fw.requireCell({ kind: 'candidate', modelId: 'ab', questionId: 'c' }, 'probe')`
- `firewall.test.ts:241`, `:242`, `:251`, `:265` still throw and only need the
  object form for consistency.

### 3. Follow-up owed by whoever owns the permit contract

`packages/core/src/evidence.ts` `permitSchema.cells` is
`{ modelId, questionId }` with no kind, so today a permit's **capabilities**
decide which kinds its cells authorise: `judge-inference` alone authorises judge
cells only, `candidate-inference` alone authorises candidate cells only, and a
development-probe granting both authorises both at the coordinates it lists.
That is coherent and fail-closed, and it is what the plan's "exact model–item or
judge–answer cells" describes.

It cannot express one thing: *generate this cell but do not judge it*. If that
is ever needed, add an optional `kind` to the cell object in `permitSchema`,
carry it through `permit.ts`'s grant construction (which currently rebuilds each
cell as `{ modelId, questionId }` and would otherwise drop it), and index it in
`Firewall`'s `#cellIndex`. Note that `permitSchema` is a plain `z.object`, so a
`kind` added to a permit file today is silently STRIPPED — it would be signed and
then discarded, which is worse than not having it.

### 4. Ledger settle ordering — no call-site change, but do not "tidy" it back

`settle()` now validates the reservation, then journals, then moves the books.
The comment above it used to claim it journalled first while the code closed the
reservation first, so a throwing append (symlinked journal, full disk, a run
frozen mid-batch) deleted the hold and never recorded the settlement — money
that had genuinely been spent vanished from the accounting and its headroom
became spendable again. Journalling first over-counts on failure, which is the
only safe direction. Validation has to stay ahead of the append or a refused
double settle leaves a phantom charge in the journal for the next resume.

### 5. Defect noticed elsewhere (not fixed — reported only)

`packages/runner/src/openrouter.ts` calls `apiKey()` inside `post`, which is
inside `#request`'s try/catch, so a **missing `OPENROUTER_API_KEY` is retried as
a network error**: five attempts with exponential backoff before the operator is
told their configuration is wrong. It cost this workstream a 5-second test
timeout to notice. Hoisting `apiKey()` to the top of `complete` would fail fast,
but it changes retry behaviour on a paid path, so it is left for a deliberate
decision rather than folded into a defect-fix pass.

---

## Stage 5 — Taste Test redesign (Tasting Flight)

Owner of: `apps/web/app/tastetest/**`, `apps/web/app/taste/**`,
`apps/web/lib/supabase.ts`, the taste components, `packages/core/src/taste.ts`,
`packages/core/test/taste.test.ts`, `supabase/migrations/0008_*.sql`.

### Required deployment configuration — the site now reads one env var

`TASTE_BALLOT_SECRET`, at least 32 characters, set on the Vercel project.

CLAUDE.md records "the web app reads zero env vars" as a deliberate property.
M5.4 requires signed, single-use, expiring ballots with model ids held
server-side, and a sealed ballot needs a key. There is **no development
fallback**: a hardcoded default would be committed, every deployment would share
it, and the blinding would be decorative. Without the variable `/tastetest`
refuses to serve a flight and says so; nothing is recorded. Update the CLAUDE.md
sentence when this lands.

### No CLI command is needed, but two analyses have no runner yet

`packages/core/src/taste.ts` exports `analyseTaste(ballots, { cohort })`, which
is the M5.6 analysis: per-axis Davidson fits (delegated to `stats.ts`), the
position/length/control diagnostics, and the publication gate. **Nothing calls
it yet.** It needs a `bench` command because the public read view deliberately
cannot supply its inputs:

    pnpm bench taste-analyse [--cohort public|professional] [--exclude-suspect]
      → read taste_flight_ballots with SUPABASE_SERVICE_ROLE_KEY (NOT the
        publishable key — the view withholds dwell_ms and session_id)
      → map rows to TasteFlightBallot (camelCase; the web's `toBallot` in
        apps/web/app/taste/page.tsx is the same mapping minus those two fields)
      → analyseTaste(ballots, { cohort, seed: 'taste:<cohort>' })
      → write data/taste/analysis-<date>.json, print the blockers

`SUPABASE_SERVICE_ROLE_KEY` is still not in `.env` — the same gap that blocks
`bench taste-archive`. Until it is, the admissibility gate and the abuse screen
cannot run at all, and `/taste` says so on the page rather than reporting
"0 admissible ballots" as if it were a finding about voters.

A second, smaller command would be worth having:

    pnpm bench taste-fixtures --check
      → apps/web/app/tastetest/flight.ts `trackAvailability()`
      → fails if any authored track has <5 admissible items, if any proposal
        leaves the 120–160 word budget, if a flavour item lacks a matched
        sensory card, or if an item carries no recorded safety review.
      All of those already refuse at serve time; a CI check would catch an
      edit to the fixture bank before it silently disables a track.

### Migration 0008 is WRITTEN, NOT APPLIED

`supabase/migrations/0008_taste_flight_ballots.sql`. Creates `taste_sources`,
`taste_flight_ballots`, `taste_ballot_reasons`, and the two read-only views
`taste_flight_reads` / `taste_flight_reason_reads`. It carries its own
verification checklist at the foot — **run it**, including
`information_schema.views.is_updatable`, before believing it is safe. 0006
exists because a migration that looked obviously correct was not checked.

Three things in it that a reviewer should look at specifically:

1. Anonymous inserts are pinned to `evidence_class = 'development'` and
   `cohort = 'public'` by the RLS policy. Nothing a visitor can insert is ever
   rank-bearing or ever claims professional status. Promoting to `public-taste`
   is a later, reviewed migration once a permitted Taste response bank exists.
2. The post-vote reason is an `smallint` INDEX in a separate append-only table,
   not free text and not an UPDATE on the ballot. Granting anon UPDATE to carry
   a reason code would hand back exactly the write surface 0006 removed.
3. Every policy predicate uses `IN (subquery)`. The correlated-`EXISTS` form
   silently rejects everything (0007's lesson); do not tidy them.

### `packages/core/src/index.ts` does not export `stats.ts`

`taste.ts` imports `fitDavidson`, `comparisonGraph`, `davidsonClusterBootstrap`,
`fnv1a32` and `seededUniform` from `./stats.js` and does **not** re-export them,
because `export * from './stats.js'` in index.ts would then collide. The web app
therefore reaches Davidson types structurally, through the `TasteAnalysis`
return type, rather than by naming them. If stats.ts is added to index.ts, check
for duplicate-export errors first — `taste.ts` exports `tasteComparisonGraph`
(a Taste-vocabulary wrapper) rather than `comparisonGraph` for this reason.

### `apps/web/components/TasteDuel.tsx` is deleted

Replaced by `TastingFlight.tsx` + `ProposalCard.tsx`. The two hard-won
behaviours are carried forward: the whole card is the tap target, and a vote is
unconfirmed until the insert succeeds. The retry loop now distinguishes three
outcomes rather than a boolean (`saved` / `duplicate` / `rejected` /
`unreachable` in `castFlightBallot`) — a duplicate means the vote IS recorded
and must not be retried, and a rejected ballot will be rejected identically
forever. Only `unreachable` offers "Try again".

`apps/web/components/BriefLabel.tsx` is now unused (its only consumer was the
old duel page). Left in place rather than deleted so as not to remove a file
another workstream might be about to reference; delete it at integration if
nothing picks it up.

### What is deliberately NOT built

- **`service` and `surprise` tracks have no authored fixture items.** They are
  declared, shown disabled with a reason, and `buildFlight` refuses them. A
  four-round "five-round flight" would be a protocol change without a label
  change. `flavour` and `rescue` are fully authored (5 items × 3 voices each).
- **M5.5 usability sessions.** They need human participants; the fixture bank
  and the flight exist so they can be run.
- **Cohort verification.** `professional` exists in the schema and in the
  analysis and is unreachable from the public path by construction.

### Defect found in another workstream (NOT fixed)

`packages/core/src/stats.ts` — `fitDavidson` needs iterations roughly
**proportional to the observation count** when one model is undefeated, against
a fixed 10,000-iteration cap, so the cap behaves as a data-size limit rather
than a convergence guard. Measured on a clean 3-model ladder with a tie in one
round of five and the favourite never losing:

    150 observations →  2,724 iterations
    300 observations →  5,360
    450 observations →  8,761
    675 observations →  REFUSED, "no convergence in 10000 iterations"
    900 observations →  REFUSED

The same data shape with the favourite losing one round in five converges in
6,490 iterations at 3,000 observations, so it is the undefeated case that
degrades. The stopping rule looks like an absolute tolerance on a quantity that
grows with the counts. A real Taste bank will exceed 400 ballots per axis by
design, so this will bite. `fitAxis` in `taste.ts` catches the refusal and
reports it as a publication blocker rather than throwing, so the site degrades
correctly — but the refusal is spurious.

---

## RUN-001 closure — permit trust root, run binding, database operations

Owner of this section: the agent that rewrote `permit.ts`, `supabase.ts`,
`sync.ts`, `data/permits/**` and the two permit test files. Everything below is
work in files that agent does NOT own.

### 1. `taste.ts` MUST be migrated — it currently does not compile

`serviceRoleClient` no longer returns a Supabase client. Returning one meant a
capability check whose reward was unrestricted power: a `result-sync` permit
received an object that could delete the ballot table. It now returns a fixed,
capability-specific set of operations bound to the grant's run id.

`packages/runner/src/taste.ts:73` is the only remaining caller that uses the old
shape (`tsc` reports exactly one error: `Property 'from' does not exist on type
'ServiceRoleOperations'`). The replacement is a drop-in:

```ts
  const db = serviceRoleClient(grant, TASTE_ARCHIVE_CAPABILITY, 'archiveTasteVotes');
  const votes: TasteVoteRecord[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const page = (await db.readTasteVotes({ from, to: from + pageSize - 1 })) as TasteVoteRecord[];
    votes.push(...page);
    if (page.length < pageSize) break;
  }
```

`readTasteVotes` keeps the same ordering (`created_at`, then `id`) that made the
archive diffs append-only, so the committed `votes.ndjson` is unaffected.

### 2. `cli.ts` — three small wirings, none of them optional

- `requireGrant(context)` should pass `expectedRunId` when the command has a run
  in hand (`--run` / `--run-id`), i.e. `verifyPermitFile(resolvedPermit, {
  manifest, expectedMethodologyHash: frozenMethodologyHash(), expectedRunId })`.
  Without it the run binding is enforced only at `syncRun`/`publishRun`; with it
  the mismatch is caught before anything opens.
- `verifyPermitFile` now REFUSES unknown options (`PERMIT_MALFORMED`) and trust
  options (`PERMIT_TRUST_INPUT_REJECTED`). The current call site passes exactly
  the two allowed keys, so it is already correct — do not "helpfully" add a
  `now` for testing.
- Long-running commands should call `assertGrantStillValid(grant, context)` at
  each batch boundary. `bench run` over 14 models is hours; a permit that
  expires or is revoked mid-run currently keeps spending until the next
  capability check happens to run through `supabase.ts` (which does re-check).

### 3. `openrouter.ts`, `ledger.ts`, `firewall.ts` — the exercise-time check

Expiry and revocation are now re-checked where authority is EXERCISED, not only
where it was loaded (`assertGrantStillValid`, exported from `permit.ts`). It is
wired into every database operation. It is NOT wired into:

- `OpenRouterClient.complete` — the natural place is immediately before the
  reservation, so a revoked permit cannot buy one more call.
- `ReservationLedger.reserve` — same reasoning for spend.
- `Firewall.requireCapability` / `requireCell` — cheapest place to put it, but
  it makes the firewall do file I/O, which is a design call for that file's
  owner rather than something to impose from here.

Also: `ReservationLedger.forGrant(grant, runId)` does not compare `runId` with
`grant.runId`. `assertGrantForRun(grant, runId, 'ReservationLedger.forGrant')`
is a one-line fix and completes the "one run id everywhere" binding (permit →
manifest → grant → ledger → command). Today the ledger will happily open a
journal for a run the permit does not authorise.

### 4. `docs/wp-0/routes.yaml` — two routes can now close, one entry can update

- `runner:permit:keyring:read` (`loadPublicKey`) and
  `runner:permit:revocation:read` (`revokedPermitIds`) are open with the reason
  "UNPROVEN AT THE PRODUCTION BOUNDARY — every citation runs through a test
  wrapper that supplies its own keyringDir". That is fixed: the production API
  has no such parameter, and the committed fixtures exercise the real loader.
  The tests that call these routes through the production entry point are:
  - `"the committed keyring and revocation list are the production trust root > verifies a signature made off this machine, then refuses it for being expired"`
  - `"the committed keyring and revocation list are the production trust root > reads the committed revocation list, before it looks at the clock"`

  Note the registry's own rule (a closed risk must cite a test that CALLS the
  route's function): both tests reach `loadPublicKey`/`revokedPermitIds` only
  through `verifyPermitFile`, so under the current `callsSymbol` rule they still
  do not "call" the route by name. Either the routes are re-keyed onto
  `verifyPermitFile`, or the rule needs an explicit note for private helpers
  that have no other entry point. This is a registry decision, not an
  implementation one — flagged, not decided.
- `runner:sync:run:upsert` and `runner:sync:run:publish` now have tests that
  CALL `syncRun` and `publishRun` directly, against a mock PostgREST:
  - `"the live-data chain refuses authority meant for another run > syncs a run through fixed operations, and never hands out a client"`
  - `"the live-data chain refuses authority meant for another run > refuses to sync a run the permit was not issued for, before opening a connection"`
  - `"the live-data chain refuses authority meant for another run > refuses a payload carrying rows from another run under an approved run id"`
  - `"the live-data chain refuses authority meant for another run > refuses to publish another run, and refuses to publish an unreleased one"`
  - `"the live-data chain refuses authority meant for another run > stops mid-sync when the permit is revoked while it is being used"`

  `syncDataset` still has no test that calls it; its risk stays open.
- `runner:supabase:service-client:construct` keeps its symbol
  (`serviceRoleClient` is still declared and still exported) but its
  `operation:` text is now wrong — it does not construct a client that escapes.

### 5. Proposed rename, deliberately not done here

`serviceRoleClient` should be `serviceRoleOperations`. It was left alone because
`routes.yaml` and `guarded-clients.test.ts` both cite the name, and renaming it
in the same change that narrows it would have broken the registry's ability to
see the route while the route was changing. Rename it and the registry entry
together, in one commit, with no behaviour change.

### 6. `packages/core/src/evidence.ts` — remove `revocationListUrl`

`permitSchema` has an optional `revocationListUrl`. A permit that names where its
own revocation is checked cannot be revoked. `permit.ts` now REFUSES any permit
carrying the field (`PERMIT_CHOOSES_OWN_TRUST`) rather than ignoring it, but the
field should come out of the schema so nobody signs one believing it works.

### 7. `test/support/grant.ts` was edited by this workstream

One call changed: `verifyPermit({..., keyringDir, revocationListPath})` →
`verifyPermitForTests({keyringDir, revocationListPath}, {...})`. Behaviour is
identical. It had to change because the production entry point no longer accepts
trust inputs from anyone, and `mintTestGrant` is the shared helper eight suites
use. Suites re-run and green after the change: `guarded-clients`, `redemption`,
`firewall`, `golden-hashes`, `permit`, `permit-e2e`.

### 8. `data/permits/` now holds committed material

A fixture verification key (`keys/wp0-fixture-2026-07.pub`) and three expired
permits under `fixtures/`. No private key — the private half was generated in an
ephemeral sandbox, used once, and destroyed. `revoked.json` gained one entry
(`wp0-fixture-revoked-0001`) so the revocation path is proved against the real
committed list. See `data/permits/fixtures/README.md`, including the instruction
to delete the fixture key once a real approver key exists.
