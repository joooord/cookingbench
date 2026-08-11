# Risk register (M0.3)

Seeded 2026-08-01 from the master plan's mandated coverage list plus risks the
WP-0 reviews surfaced. States: `Open → Mitigated → Closed`; a mitigation names
its mechanism or it is not one.

| ID | Risk (plan-mandated coverage in bold) | State | Mitigation / next step |
|---|---|---|---|
| RISK-01 | **Scoring-bank leakage** — sealed items exposed before use | Open | Exposure states defined (plan vocabulary); no sealed bank exists yet. Design the Chef's Table holdout access log before Stage 3 authoring. |
| RISK-02 | **Calibration-holdout leakage** — judges tuned on the held-out anchors | Open | 44/23 split exists (`docs/calibration/anchor-design.md`); enforcement of "held-out never in a prompt" is not yet coded. |
| RISK-03 | **Scenario-family exposure** — near-duplicate items telegraphing each other | Open | `bench validate` warns on >50% shared wording; family clustering is a Stage 3 design item. |
| RISK-04 | **Search-time retrieval** — public items retrieved verbatim at answer time | Open | Canary GUIDs in every file; freshness-limits principle 13. No retrieval probe exists. |
| RISK-05 | **Judge/provider affinity** — seating rule creating systematic harshness asymmetry | Open | Documented in the erratum (Anthropic always drew the harsh seat; gpt-5.5 −4.27). `baseModel` identity landed; M2.5's five-family pool is the structural fix. |
| RISK-06 | **Model/API drift** — slugs and behaviour rotting between design and run | Open | `models --check` (permit-gated); manifests freeze routes per run. |
| RISK-07 | **Representation rights** — RecipeTables / Cooking for Engineers inspiration | Open | M0.7 decision not yet recorded (`docs/controls/` has no rights decision; Gate-0 blocker). |
| RISK-08 | **CookBench/CookingBench naming confusion** — 2025 academic benchmark with a colliding name | Open | M0.7 review not done; decide descriptor before major promotion. |
| RISK-09 | Latent v3 grader fail-opens wired into production before repair | Open | KI-001/KI-002 recorded as blocking the wiring (`docs/audit/known-issues-register.md`). |
| RISK-10 | Local trust-root residue from test support mutating the committed keyring | Open | KI-017; CI catches residue, local runs do not. |
| RISK-11 | Red commit deployed to production — git auto-deploy (enabled 2026-08-11) ships any push to `v3/wp-0-live` even when GitHub Actions is red | Mitigated (procedural) | CI-green-first discipline recorded in CLAUDE.md and decision-log entry 14: land on a session branch, wait for green CI on the exact commit, then fast-forward `v3/wp-0-live`. KI-019 precedent (`dd91382` pushed red). Structural close = GitHub branch protection requiring the CI check on `v3/wp-0-live` (owner action, open). |
| RISK-12 | Taste ballots drifting from the committed permanent record | Open | 8 ballots (29–30 July) in Supabase, not in `data/taste/votes.ndjson`; export held in session records. Archiving is a reviewed decision (CI tree pin + permit + service key). |
