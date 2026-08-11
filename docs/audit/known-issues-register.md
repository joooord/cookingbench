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
| KI-006 | The autopsy paper states two different "published" orderings (§2: Mini first; §4.6: Sol Pro first) because `report.ts` sorts on one-decimal-rounded scores | Paper half **Fixed and deployed** (amendments live since the 2026-08-11 auto-deploy of `c449472`; the site's "full paper" link is pinned to the amended blob at `9f4b249`; independent re-verification still owed before `Independently verified`). `report.ts` rounded-sort half still **Open**. | A (paper wording) + B (report.ts sort) | Deployed | §2 carries the full-precision reconciliation; the /results page footnotes the row-order tie-break. |

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
| KI-015 | Site ranks are screening-derived: model-page places quote `analysis.separation`, which `analyze.ts` itself labels "SCREENING … nothing in `separation` may be quoted as an ordering"; the committed v2.1 artifact has no `confirmatory` block, so the site could not quote one without deriving a new artifact | Open as a governance decision. Mitigated 2026-08-01: /methodology reworded to screening vocabulary (no "proven"), legacy /models pages redirected to archived profiles, /categories reframed without ordinals — remaining places are presented as archived history, not claims |

## Additional items from the 2026-08-01 full review (fleet-verified)

| ID | Concern | State |
|---|---|---|
| KI-016 | ~1,500 lines of the retired Tasting Flight survive as dead code (`app/tastetest/actions.ts`, `flight.ts`, `fixtures/`, `ProposalCard.tsx`, `BriefLabel.tsx`); `castBallotAction` still composes a ballot whose save always fails with a retryable message, so rewiring a UI to it would resurrect exactly the vote-stranding flow the pause exists to prevent | **Fixed 2026-08-11** — `castBallotAction` now refuses up front behind a `BALLOT_COLLECTION_PAUSED` guard (non-retryable, "nothing was recorded"); the pipeline is retained beneath it as the Stage 5 reference implementation. The dead modules stay parked; removing the flag is an explicit Stage 5 act alongside migration 0008 + `TASTE_BALLOT_SECRET` |
| KI-017 | Test support (`test/support/production-trust.ts`) writes ephemeral keys into the committed keyring and rewrites `revoked.json` in place during test runs; a hard-killed worker leaves residue that silently widens the local trust root (CI catches it; local runs do not) | Open |
| KI-018 | The absent-revocation-list fail-closed branch (`PERMIT_REVOCATION_UNAVAILABLE`) became untestable when the injectable seam was removed — no test can exercise it, so a refactor to "absent = nothing revoked" would pass the suite | Open |
| KI-019 | `dd91382` (codex round 3) was pushed with CI red — committed `node_modules` symlink, unfilled golden-hash placeholders, a traceability citation naming a nonexistent test; all repaired by `309f43f`, which is the true acceptance point. Recorded so the audit trail dates the 10/10-closed claim to the commit where it became verifiable | Recorded (historical) |
| KI-020 | RELEASE-002-D1 was flipped from `awaiting-decision` to accepted inside the same unverified implementation commit, against the handoff's stated intent that the owner decide; the implementation itself is sound (verified) | **Resolved 2026-08-01** — owner countersigned the stricter reading (`docs/controls/decision-log.md` entry 4) |
| KI-021 | `/questions` renders an inline 600-char excerpt of every model answer for every question (184 × up to 14) in one page — megabyte-scale HTML that is the heaviest page on the site, especially on mobile data | Open (note, not a defect — the page works and the content is the feature). Candidate fix when web work resumes: per-question lazy loading or pagination |
| KI-022 | The six research pages recomputed seven corpus aggregates by reading all 2,576 response files (19 MB) on every build, despite the corpus being immutable and CI-pinned | **Fixed 2026-08-11** — aggregates precomputed into `apps/web/lib/v21-corpus-facts.json`, digest-bound to the corpus at runtime (`research.ts` fails closed on mismatch) and recomputed from the real responses by `packages/runner/test/corpus-facts.test.ts`. `/questions` still reads the real corpus — it displays it |

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
