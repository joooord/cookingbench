# Integration defects — hostile review of the 2026-07-30 eleven-package landing

Reviewed at `29a4039` (branch `v3/wp-0-evidence-firewall`), reading code against
`git diff 8a63101..HEAD`. **The tree moved during the review**: commits
`8efd1ee`, `c7645cb`, `60888df` landed mid-read (autopsy revision, manifest.ts,
derive.ts, a simulate.ts rewrite). Findings below were re-checked against the
files as they stood at `60888df` where marked; the three newest modules were
not reviewed (see "Not reviewed").

Every CONFIRMED finding was reproduced either by executing the code or by a
line-by-line trace with the triggering input written out. PLAUSIBLE means the
defect is visible in the code but I could not (or did not) construct a
triggering input end to end.

---

## CONFIRMED — ranked by severity

### 1. The "no safety-critical case on an LLM judge alone" rule is defeated by any deterministic evidence, however irrelevant

`packages/core/src/graders/index.ts:409-414`

```ts
const safetyConfirmed =
  request.humanConfirmed === true ||
  request.deterministic !== undefined ||          // <-- this line
  caps.applied.some((c) => c.evidence === 'deterministic' || c.evidence === 'human');
```

The mere *presence* of deterministic evidence counts as safety confirmation —
including a non-resolving constraint check that has nothing to do with safety
(a units check, a required-sections check). The module's own header
(lines 101-108) claims the opposite: *"The router forces `human-escalation` on
a safety-critical item whose only evidence is a judge panel, whatever that
panel concluded — including, and especially, when it concluded the answer was
fine."*

Executed reproduction (script, not a thought experiment):

```
safetyCritical: true, LLM panel says fine, plus a non-resolving
keyword-format check (resolves:false, nothing about safety):
  route = structured-judgement, escalations = [], score = 100
control — same item without the deterministic check:
  route = human-escalation, escalations = ["safety-critical-requires-confirmation"]
```

Why it matters: in this dataset the safety-shaped items that will use the v3
routes are `llm-judge` items **with constraintChecks** — exactly the shape that
silently switches the rule off. M2.2's one non-negotiable rule is dead on
arrival for the items it exists for. The fix direction is that the
deterministic evidence must *confirm the safety property* (or at least the
caller must say it does), not merely exist.

### 2. A `critical` criterion abstained/"unclear" by every seat vanishes — score 100, no breach, no escalation

Two independent implementations share the hole:

- `packages/core/src/graders/dimension.ts:269` — a breach is only recorded
  when `band !== null`; `band: null` (abstain) on a `critical` criterion drops
  it from the denominator and from `criticalBreaches`.
- `packages/runner/src/judge.ts:1921-1929` — `aggregateDimension` escalates a
  critical criterion only when the seats *split*; a unanimous `unclear` is a
  clean majority and triggers nothing.

Executed reproduction (core path): three seats, criteria
`[critical 'safety', include 'flavour']`, every seat bands `safety: null`,
`flavour: 4` →

```
panel.criticalBreaches = []   panel score = 100
routeCascade: route = structured-judgement, escalations = [], score = 100
```

The schema's own comment (schema.ts:44-48) says a critical miss is a cap, not
a weight. Here it is neither — it is silence. The module refuses a *silently
omitted* criterion but accepts a *written-down* abstention on the one criterion
kind whose whole point is "must hold". An abstained/unclear critical criterion
should escalate (`unhandled-critical-criterion` or a new reason), in both
implementations.

### 3. Dimension mode is two incompatible half-implementations; the declared weights are still never read end to end

The scoring side and the judging side of the same M2.1 mode were built against
different ballot shapes and nothing connects them:

- `packages/core/src/graders/dimension.ts:62-75` — `combineDimensions`
  requires a 0–4 band **per criterion** (`CriterionBand { criterion, band }`),
  and that is where the declared weights are finally applied.
- `packages/runner/src/judge.ts:696-708, 718-771` — the actual judge prompt
  and parser (`buildDimensionJudgeMessages`, `parseDimensionBallot`) collect a
  0–4 band **per anchored dimension** plus a categorical
  `met | missed | unclear` **per criterion**. No numeric band per criterion is
  ever requested; `band: null` abstention (which dimension.ts supports) is
  unreachable — `parseDimensionBallot` rejects anything but an integer 0–4.

There is no adapter in the tree. `combineDimensions`, `combineDimensionPanel`,
`routeCascade`, `applyCaps` and `capDimensions` are called **only by
`packages/core/test/graders-v3.test.ts`** — no runner code imports them
(verified by grep). Consequences:

- The "headline defect" dimension.ts says it fixes (dimension.ts:5-9: the
  dataset declares 97 weights and the pipeline drops every one) is **still
  unfixed on any executable path** — `aggregateDimension` is unweighted
  majority per dimension and produces no 0–100 score at all.
- The entire M2.2 cap machinery (caps.ts, `capDimensions`, the cascade
  router) is unreachable from any real judge ballot. Nothing converts
  `judge.ts` `criticalTags` or criterion decisions into `CapFinding`s.
- The two agents' own wiring instructions contradict each other:
  `docs/wp-0/INTEGRATION-NOTES.md:60-67` (graders section) instructs the
  integrator to "collect anchored 0–4 bands per criterion and call
  `combineDimensions(criteria, bands)`", while the judge section (106-158)
  documents the shipped per-dimension ballot as the finished contract. Both
  cannot be satisfied without redesigning one side.

Fail-closed today (v3 items simply cannot be scored), but this is the largest
seam gap in the landing and it invalidates several confident comments on both
sides.

### 4. Two contradictory implementations of the M2.5 rater-unit fold — winner-vs-equal is "no outcome" in one and a counted tie vote in the other

- `packages/core/src/graders/pairwise.ts:158-163, 191-195` (`foldRaterUnit`):
  *"Any post-canonicalisation difference counts as instability, including `a`
  versus `equal`"* → outcome `null`, contributes nothing to any tally.
- `packages/runner/src/judge.ts:1550-1554` (`resolveRaterUnit`): winner in one
  order + `equal` in the other → `outcome = { kind: 'equal' }` — a **decided
  vote** that enters `tallyUnits`' majority denominator (it does also
  escalate as `presentation-inconsistent`).

Same rule, opposite arithmetic. It is not hypothetical drift:
`agreement.ts` (`pairwiseRatingsForAgreement`, line 909-928) folds ballots
with the **core** rule, so the agreement statistics computed over a run's
ballots will treat as missing exactly the units the verdict machinery counted
as ties. With three seats, one A-then-equal seat plus one equal-equal seat
yields an `equal` majority in judge.ts and only one usable rating in
agreement.ts.

Related, same seam: the two modules also use different positional vocabularies
(`'a'/'b'`, `'ab'/'ba'` in core vs `'A'/'B'`, `'AB'/'BA'` in runner), so the
wiring INTEGRATION-NOTES.md:388-391 prescribes — "use `canonicalise` from
graders/pairwise.ts" to feed `fitDavidson` — fails twice: the function is
named `canonicaliseOutcome`, and it **throws** on a runner ballot's `'A'`
(`assertOutcome`, pairwise.ts:65-72). Fail-closed, but the prescribed
integration path does not run.

### 5. keyword.ts: the new hedged-containment carve-out excuses answers that *recommend* the forbidden ingredient

`packages/core/src/graders/keyword.ts:150-163` — the containment-warning rule
(`HEDGE` + `CONTAINMENT_VERB`) is meant for *"a warning that some THIRD
product secretly carries the banned term"*, and the comment at 147-149 insists
a bare "contains" is left alone because *"'this blend contains cayenne' is an
author describing their own recipe — a genuine violation"*. But `HEDGE`
includes `do, does, will, can, still, most, many, all, always`, which are
exactly the words a first-person recommendation uses. Executed:

```
forbidden: ['peanut butter']
"Go with my satay dip: it always contains peanut butter, and that is exactly
 what makes it work for this dish. Serve it to everyone."      → score 100
"The sauce does contain peanut butter, which is the point. Spread it thick."
                                                               → score 100
"Most of my best marinades include peanut butter, so use one of those here."
                                                               → score 100
control: "Add two spoons of peanut butter to the sauce."       → score 0
```

All three excused answers are instructions to serve the allergen. The pre-v3
grader zeroed them. This is a forbidden-term bypass on allergen items — the
one direction (fail-open on safety) the file's other rules were carefully
built to avoid. The carve-out needs an incorporation/recommendation veto (the
`INCORPORATION_AFTER` idea) on the containment path too, or the hedge list
needs `does/do/will/still/all/always` removed.

### 6. The autopsy paper states two different "published" orderings, and the leaderboard's own row order is an artifact of rounding

- `docs/papers/01-autopsy.md:109` (§2): *"The board as published
  (leaderboard.json): GPT-5.4 Mini 96.0, GPT-5.6 Sol Pro 96.0, …"* — matches
  `leaderboard.json` row order (Mini first).
- `docs/papers/01-autopsy.md:354-355` (§4.6): the "Published (102)" column has
  **Sol Pro 96.04 first, Mini 96.04 second**, and the rank-move claims
  ("Sol Pro 1→3, GPT-5.4 Mini 2→1") are derived from that ordering.

Both are defensible individually — recomputing exact active means from
`scores.json` gives Sol Pro 96.0441 > Mini 96.0384, while
`packages/runner/src/report.ts:167,181` rounds `overall` to one decimal
*before* sorting, so the published row order inside the 96.0 trio is stable
insertion order, i.e. arbitrary. But the paper cannot call two different
orderings "published"/"Published" three hundred lines apart, in a paper whose
thesis is that rendering unsupported orderings is the sin. One sentence
reconciling the two (and ideally a note that report.ts sorts on the rounded
value) fixes it. All other spot-checked numbers reproduce — see "Clean" below.

### 7. Comments that claim the opposite of the code (each verified against the code)

1. `packages/core/src/graders/caps.ts:302-306` — dimension-scope
   `AppliedCap.binding` is hardcoded `true` with the comment *"Whether it
   binds depends on the dimension's own score… Reported by the combiner that
   enforces it."* `capDimensions` (dimension.ts:351-378) never touches any
   `AppliedCap` — nothing ever reports it. Every dimension cap in an artifact
   will read `binding: true` whether it bound or not.
2. `packages/core/src/graders/index.ts:297-299` — *"the second call is what
   produces the authoritative `binding` flags"* — true for task-scope caps
   only; dimension-scope flags stay unconditionally `true` (see 1).
3. `packages/core/src/agreement.ts:437-442` — *"Unobserved levels have
   marginal 0 … they keep the ordinal cumulative sums honest and the reported
   `levels` stable"* — the very next line **filters unobserved levels out**
   (`options.domain.filter((d) => observed.has(d))`). Numerically harmless for
   the ordinal metric (zero marginals contribute zero to the cumulative sums),
   but the claim about the code and the `levels` output is false.
4. `packages/core/src/graders/index.ts:252-253 vs 347` —
   `CascadeResult.dimension` is documented as *"Per-seat detail after any
   dimension ceiling, for the adjudication record"* but is `null` whenever the
   panel has more than one seat (`capped.length === 1 ? capped[0]! : null`) —
   i.e. the adjudication record loses the detail exactly when a panel exists.
5. `packages/runner/src/judge.ts:1902-1906` — a *dimension band gap* escalates
   under the reason code `'criterion-gap'`. Mislabeled escalation reason in
   the stored artifact; there is no dimension-gap reason.

---

## CONFIRMED — minor

- **Abstain leaks into the pairwise disagreement denominator.**
  `packages/core/src/graders/index.ts:352-357` — the `outcome-split` metric
  counts stable `abstain` and `both_unacceptable` units as "decided" outcomes
  (`u.outcome !== null` — core outcomes are strings, never null here except
  via `orderUnstable`). Three abstains read as a modal outcome with split 0
  ("perfect agreement"). Contained: the verdict path (`pairwiseVerdict`)
  excludes them correctly and an all-abstain pair is `insufficient` anyway,
  but the recorded `judgeDisagreement` number treats missingness as agreement.
- **`ceilingProbe` artifacts leak when `baseScore === null`.**
  `packages/core/src/graders/index.ts:300, 387, 434, 450` — when caps
  findings exist but no score does, the returned `CapOutcome` is the probe
  computed against `weightedScore = 0`: `caps.score = 0` and every task cap's
  `binding` computed against 0 (all false). For a caps-carrying item with no
  automated evidence, `provisionalScore` is `0` — "what the automation would
  have said" when the automation said nothing.
- **Duplicate exported names with different meanings across packages.**
  `ESCALATION_REASONS` / `EscalationReason` exist in
  `packages/core/src/graders/index.ts:121-135` (cascade vocabulary) and
  `packages/runner/src/judge.ts:1344-1354` (jury vocabulary) with disjoint
  value sets; likewise `PAIRWISE_OUTCOMES` (`'a'/'b'` in core pairwise.ts:27
  vs `'A'/'B'` in judge.ts:808) and two unrelated `RaterUnit` interfaces.
  Nothing breaks today; the first file to import both will pick one silently.
- `docs/wp-0/INTEGRATION-NOTES.md:390` names a function `canonicalise` that
  does not exist (`canonicaliseOutcome`).

---

## PLAUSIBLE / UNCONFIRMED

- **Case-sensitive dimension matching between caps and items.** The
  `unsupported-historical-claim` cap binds to the literal dimension id
  `'context'` (caps.ts:127); `capDimensions` ignores ceilings for dimensions
  the result does not carry (documented), and `combineDimensions` buckets by
  the criterion's raw `dimension` string, while the schema's anchor
  cross-check lowercases (`schema.ts:1383, 1407-1410`). An item writing
  `dimension: Context` on its criteria would parse cleanly and silently
  never receive the cap. No such item exists yet; the trigger is authoring,
  not code, so unconfirmed.
- **`hasRequiredTerm` inflection list over-matches short terms.**
  keyword.ts:268 — `INFLECTIONS` includes `'n'`, so required synonym `'no'`
  matches `"non-dairy"` (tail `n`). Semantically usually harmless (often even
  correct); no active item is wrongly credited that I could find.
- **Site places remain screening-derived.** `apps/web/lib/data.ts`
  `getStandings` → `getTiedRanks` → `analysis.separation` — the uncorrected
  91-test family analyze.ts itself now labels "SCREENING … nothing in
  `separation` may be quoted as an ordering" (analyze.ts:109-115). The
  homepage's "=1st" badge and every model page rank are quoted from it. The
  confirmatory places exist in the same artifact and are unused by the site.
  Pre-existing behaviour, now contradicted by tonight's own comments; flagged
  as a claims/code tension rather than a new bug.

---

## Clean areas (checked, nothing found)

- **stats.ts** — Holm is correct (ascending sort, step-down multipliers,
  running-max monotonicity, deterministic tie-break, duplicate-key refusal);
  `supportedTiers` computes places over the **full** pair matrix with a
  contradiction check and splits internally-ordered place groups (ties do not
  chain); the Davidson fit excludes `both_unacceptable` and `abstain` from the
  likelihood, checks real-graph connectivity *before* the phantom, and keeps
  the phantom out of the ν equation as claimed; `smallestFlipSet`'s minimality
  argument holds; bootstrap quantile-resolution guards are real.
- **analyze.ts confirmatory layer** — refusal-based fail-closed throughout;
  per-pair seeding; sole-winner requires margin + Holm + Bonferroni intervals
  + a singleton top tier; unclustered items force a recorded refusal.
- **Krippendorff's alpha** (agreement.ts) — coincidence matrix with
  1/(m−1) weighting, units with <2 ratings dropped and *reported*, ordinal
  distance is the marginal-cumulative one (genuinely ordinal), degenerate
  matrices return `null`, never 1.0. The clustered bootstrap's mandatory
  `relabel` correctly prevents duplicate cluster draws from merging.
- **Dataset edits** — `bench validate` passes at HEAD: 184 items parse, all
  184 reference answers score 100 against their own graders. The flav-014
  keyword→llm-judge conversion carries a legacy rubric summing to 1.0, a
  constraint backstop, judgingNotes, and a failingAnswer wired to the
  quantity-anchored forbidden list; safe-021, subs-007, subs-018, tech-*
  repairs widen synonym groups without weakening the trap (each adds a
  failingAnswer that encodes the trap-accepting answer). Prompts unchanged —
  grader-only edits.
- **Composite keys** — the NUL-byte defect the briefing warned about was in
  simulate.ts and is already fixed (`JSON.stringify([modelId, questionId])`);
  agreement.ts's ` ` separator is an escape sequence (source stays text)
  and is injective for NUL-free ids; remaining joins (`a>b`, `a|q`, `a b`)
  use characters the id schemas forbid. No source file contains a literal NUL
  (checked with `grep -P '\x00'`).
- **The paper's arithmetic** — reproduced against the committed artifacts:
  effectiveItems 24.2, activeWithSignal 64, activeAllPerfect 33, grader
  distribution 45/34/22/1, keyword ≈47% variance share, top-1/3/6/10
  concentration 9.1/25.4/41.6/54.6%, 12 negative-discrimination items at
  15.4%, 38 contradictions out of exactly 280 constraint-checked judged
  answers, flav-014 (mean 33.3, sd 45.4, disc −9.5, 9 zeroes, gpt-5.4-mini
  100), safe-021 mistral = 100, calibration MAE 8.5/3.3/6.0 on 12 anchors,
  the five-way tie for first (verified: exactly those five models are beaten
  by nobody in `analysis.separation`), frontier Grok separating from 12 of 13
  with Sol Pro at 0.931, and the "−12 anti-correlated" counterfactual board
  digit-for-digit. The paper does **not** assert the de-noised ordering is
  true — §4.6, §6 and the abstract all place both orderings inside the
  five-way tie. Only defect: finding 6 above.
- **trn.ts** — refusals before rendering, back-references terminate the DFS,
  deterministic root order.
- **Web changes** (data.ts, page.tsx, models/[slug], methodology) — one rank
  source, tested-only highlighting, run-cost componentised with unknown ≠ 0.
- Targeted suites all pass: graders-v3 (67), stats, schema-v3, agreement
  (100), kitchenplan (72), keyword, judge, jury, analyze, specificity, report
  — 567 tests across the two packages. (Passing tests were not treated as
  evidence for anything above; every finding is from the code.)

## Not reviewed, and why

- `packages/runner/src/derive.ts` (396 lines), `manifest.ts` (838),
  the simulate.ts rewrite and the final autopsy revision — landed in commits
  `8efd1ee`/`c7645cb`/`60888df` while this review was in progress; reviewing
  a file mid-write produces findings about a version that no longer exists.
  The paper's key numbers were re-verified at `60888df` (they held).
- `packages/core/src/kitchenplan.ts` beyond ~line 1100 (equipment/cook
  contention, trajectory invariants, scaling) and `agreement.ts` beyond
  ~line 1000 (orderEffect, humanParity, repeatConsistency, release criteria)
  — skimmed for shape only; no line-by-line trace. Both are self-contained
  pure modules with dedicated suites, the lowest-risk unreviewed surface.
- `apps/web` render paths were read, not executed.
