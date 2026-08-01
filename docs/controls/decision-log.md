# Methodology decision log (M0.3)

Every methodology-relevant decision, dated, with who decided and where the
evidence lives. Change classes: **A** wording/docs only · **B** non-semantic
pipeline, targeted replay · **C** scoring semantics, affected gates reopen ·
**D** integrity/safety, rotate material and repeat approval.

Entries recorded by an agent carry `sign-off: pending` until the owner
countersigns; a pending entry records history, it does not authorise anything.

| # | Date | Decision | Class | Decided by | Evidence | Sign-off |
|---|---|---|---|---|---|---|
| 1 | 2026-07-30 | Adopt the Revision 3 methodology-first master plan as the single authoritative roadmap; no rank-bearing inference before the Methodology Readiness Gate | — (constitutional) | Codex (plan owner), implemented by Claude | `docs/methodology/CookingBench-methodology-first-master-plan.md` + sha256 sidecar | pending |
| 2 | 2026-07-30 | Disown the 2026-07-v2.1 derived scores by dated erratum; preserve the corpus immutably as legacy-shadow evidence | A (presentation) | Codex/Claude per the plan's M0.5 | `docs/errata/2026-07-v2.1-corpus-and-scores.md` | pending |
| 3 | 2026-07-31 | Replace the marketing-tier `family` conflict arm with per-entry `baseModel` identity in the roster; judge seating reads it and fails closed on `unknown` for active routes | C | Implemented in WP-0 round 2, ratcheted in round 3 | `data/models.yaml`, `packages/runner/src/judge.ts` identityIndex, wp0-self-review tests | pending |
| 4 | 2026-08-01 | RELEASE-002-D1: `writeLeaderboard`/`writeAnalysis` require a publication grant (the stricter reading) | C | Accepted in codex round 3 — **inside the implementation commit, against the handoff's intent that the owner decide** (KI-020) | `docs/wp-0/traceability.yaml`, `packages/runner/test/release.test.ts` | **required — not yet given** |
| 5 | 2026-08-01 | Production deploys from `v3/wp-0-live` via manual Vercel CLI promote; the old default branch is frozen at the v2.1 snapshot. Default-branch designation on GitHub remains an open owner action | — (administration) | De facto by deployment; recorded by review | Vercel deployment `dpl_sDar3Ropx…`, `SNAPSHOTS.md` | pending |
| 6 | 2026-08-01 | Legacy `/models/*` pages redirect to the archived profiles; `/categories/*` reframed without ordinal ranking; `/methodology` reworded to screening vocabulary and the pause state | A (presentation) | Claude review session, from fleet-verified findings | `claude/cookingbench-review-quyjf2` commits; `docs/audit/known-issues-register.md` KI-015 | pending |
