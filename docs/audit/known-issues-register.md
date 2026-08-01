# Known-issues register

The M0.3 control the master plan requires: every known defect, with an explicit
state, so that "the traceability matrix is green" can never again be misread as
"nothing known is wrong". The WP-0 matrix tracks WP-0's ten requirements;
*this* file tracks defects, wherever they were found.

**States:** `Open → Fixed → Independently verified` (master plan M0.3). A fix
without independent re-verification stays at `Fixed`. Nothing may be moved to
`Independently verified` by the author of the fix.

**Change classes** (M0.3): A wording/docs only · B non-semantic pipeline,
targeted replay · C scoring-semantics change, affected gates reopen · D
integrity/safety, rotate material and repeat approval.

Seeded 2026-08-01 from the adversarial sweep of 2026-07-30
(`docs/audit/integration-defects.md`, commit `5e364f8`, "Nothing here is fixed.
All of it goes to the integration pass") plus later findings. Status column
verified against tip `309f43f` on 2026-08-01; each verification records how.

## Major

| ID | Defect | State at `309f43f` | Class | Exposure | Verification 2026-08-01 |
|---|---|---|---|---|---|
| KI-001 | Safety-confirmation rule satisfied by the mere *presence* of deterministic evidence, however irrelevant (`graders/index.ts:409-414`) | **Open** | C | Latent — cascade router unwired | Code unchanged at tip; `graders-v3.test.ts` "accepts a safety-critical item once a deterministic rule confirms it" now asserts acceptance with `resolves: false` evidence, i.e. the test bakes the defect in. Fix direction per sweep: evidence must confirm the safety property, not merely exist. |
| KI-002 | `critical` criterion abstained/"unclear" by every seat vanishes — no breach, no escalation, score can be 100 (`dimension.ts:269`; twin in `judge.ts` `aggregateDimension`) | **Open** | C | Latent — dimension mode unwired | `band !== null` guard unchanged; `aggregateDimension` escalates only on a *split* (`split-critical-tag`), never on unanimous `unclear`. Grep at tip: no unanimous-unclear escalation path in either module. |
| KI-003 | Dimension mode is two incompatible half-implementations; the 97 declared rubric weights still reach no executable path | **Open** | C | Latent — fail-closed (v3 items cannot be scored at all) | `routeCascade` / `routeDimensionMode` / `combineDimensions` / `aggregateDimension` have zero callers outside tests at tip (grep across packages and apps). The two INTEGRATION-NOTES wiring prescriptions still contradict. |
| KI-004 | Rater-unit fold contradicts itself: winner-vs-equal is "no outcome" in `pairwise.ts:158-163` and a counted `equal` vote in `judge.ts` (`resolveRaterUnit`) | **Open** | C | Latent — pairwise mode unwired | Both implementations unchanged at tip (`pairwise.ts:159-160`; `judge.ts:1629`). Agreement statistics and verdict machinery would still disagree about the same ballots. |
| KI-005 | Keyword hedged-containment carve-out excuses a *prescription* of the forbidden ingredient ("it always contains peanut butter — serve it to everyone" → 100) | **Open** | C | **Live** — keyword grader is wired into `bench grade` and `bench validate` | Reproduced at tip (node, `gradeKeyword`, forbidden `['peanut butter']`): prescription 100, genuine warning 100, bare prescription 0. `HEDGE` still contains `do/does/will/still/all/always/most/many`. Mitigation: no-run rule means no rank-bearing use before v3 replaces keyword grading; do not patch without the incorporation-veto design the sweep proposed — the fix and the defect are the same rule. |
| KI-006 | The autopsy paper states two different "published" orderings (§2: Mini first; §4.6: Sol Pro first) because `report.ts` sorts on one-decimal-rounded scores | Paper half **Fixed** (2026-08-01, reconciling note added to §2 + dated amendment; awaiting independent re-verification and a site redeploy to reach the published copy). `report.ts` rounded-sort half still **Open**. | A (paper wording) + B (report.ts sort) | **Live** — the deployed paper predates the fix until redeployed | Both passages verified divergent at `309f43f`; §2 now carries the full-precision reconciliation. |

## Minor (from the sweep; not re-verified at tip except where noted)

| ID | Defect | State | Notes |
|---|---|---|---|
| KI-007 | Dimension-scope `AppliedCap.binding` hardcoded `true`; no combiner ever reports it | **Open** (verified at tip: `caps.ts:296-307` unchanged) | Comment claims the opposite of the code. |
| KI-008 | Comment/code mismatches: `agreement.ts:437-442` unobserved-levels claim; `CascadeResult.dimension` null for real panels; `criterion-gap` reason used for dimension gaps | Open (not re-verified) | Class A each. |
| KI-009 | `outcome-split` counts stable abstain/both-unacceptable as decided outcomes — missingness reads as agreement | Open (not re-verified) | Contained: verdict path excludes them. |
| KI-010 | `ceilingProbe` leaks `caps.score = 0` / `provisionalScore = 0` when `baseScore === null` | Open (not re-verified) | "What the automation would have said" when it said nothing. |
| KI-011 | Duplicate exported names with different meanings across packages (`ESCALATION_REASONS`, `PAIRWISE_OUTCOMES`, `RaterUnit`) | Open (not re-verified) | First file to import both picks one silently. |
| KI-012 | `fitDavidson` iteration cap behaves as a data-size limit: spurious non-convergence refusal once one model is undefeated past ~600 observations | **Open** (recorded in INTEGRATION-NOTES with measurements) | Will bite any real Taste bank (>400 ballots per axis by design). Site degrades to a publication blocker rather than throwing — the refusal is safe but wrong. |

## Plausible / unconfirmed (carry, do not close silently)

| ID | Concern | State |
|---|---|---|
| KI-013 | Case-sensitive dimension matching could let an authored `dimension: Context` silently dodge the context cap | Unconfirmed — trigger is authoring, not code |
| KI-014 | `INFLECTIONS` includes `'n'`, so required synonym `no` matches `non-dairy` | Unconfirmed harm |
| KI-015 | Site ranks are screening-derived: the homepage "=1st" badge and model-page ranks quote `analysis.separation`, which `analyze.ts` itself labels "SCREENING … nothing in `separation` may be quoted as an ordering"; the confirmatory places in the same artifact are unused by the site | Open as a claims/code tension — needs a decision, not just a patch |

## How to use this file

- Fixing an item: move it to `Fixed`, cite the commit and the test that now
  fails without the fix. Independent re-verification (a different agent or a
  human, reproducing the original trigger) moves it to `Independently
  verified`.
- Finding a new defect: append it here in the same commit as the finding,
  whatever other document records the detail.
- Wiring the v3 grading modes (KI-003) is **blocked** on KI-001 and KI-002:
  connecting a scoring path that silently passes unanimous-unclear safety
  criteria would convert two latent defects into live ones.
