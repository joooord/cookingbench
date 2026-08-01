# CookingBench authoring guide (v3 / Stage 3)

The single entry point for authoring v3 question items. Read this first; the
pattern guides (`frontier-item-principle.md`) and `templates.md` sit under it.

## What Stage 3 is doing, and what it is not

Stage 3 rebuilds the question bank because the v2.1 bank measures far less than
it looks like it does (effective item count 24.2 against 102 active; 33 items
perfect for every model). The master plan wants **30 Craft archetypes across 8
task families + 15 Fundamentals items**, drafted broadly (75–90 candidates) and
admitted narrowly.

**WP-6a produces drafts, not admitted items.** Everything authored here lands in
`data/candidates/` at `status: candidate` and `verificationState: draft`.
Admission needs a blind independent human solve, a second reviewer, and
specialist (food-safety / culinary / history) sign-off — all blocked until those
seats are filled (`docs/controls/roles.md`). Do not treat a green `bench
candidates` run as admission; it is a floor, not a ceiling.

## The candidate lifecycle

```
draft  →  validator-clean  →  agent cross-review  →  parked (awaiting certification)
```

- **draft** — written to a candidate file, full provenance recorded.
- **validator-clean** — passes `bench candidates` (schema, scenario-family
  membership, canary, near-duplicate, self-satisfiable-group, fixture
  execution, KitchenPlan validation where relevant).
- **agent cross-review** — a *different* Claude session reads the item against
  its family checklist and records a note in `provenance.authoringChain` as an
  `agent-mutation` stage (or confirms no change). This is not certification and
  is not recorded in the `reviewers` field, which is reserved for the human
  certification reviewers.
- **parked** — the item waits at `verificationState: draft`. Safety-relevant
  items carry a machine-visible pending-safety marker so the blocker is
  countable.

## The pattern-to-family map

The canonical-trap pattern is one tool. Each blueprint family has a home
pattern and a template:

| Blueprint family | Archetypes | Home pattern | Template |
|---|---:|---|---|
| Applied theory | 4 | canonical-trap / mechanism-transfer | single-turn structured decision |
| Diagnosis & recovery | 4 | correct-except-one-detail | multi-turn diagnosis |
| Adaptation & lateral | 3 | single-substitution / scarcity / buried-constraint | single-turn structured decision |
| Flavour & sensory | 4 | construction-under-absence / defend-or-reject | recipe critique (Palate judging deferred) |
| KitchenPlan | 6 | compile / audit / repair / state / schedule / counterfactual | KitchenPlan template |
| Interactive ambiguity | 4 | paired clear/ambiguous | paired ambiguity + recovery |
| History & context | 3 | documented-vs-myth / responsible-adaptation | historical/contextual analysis |
| Capstone | 2 | multi-axis case | (combination of the above) |
| Fundamentals (15, separate) | — | settled-fact regression | (drawn largely from the saturated-active inventory) |

## The five hard rules (encoded as decision-log entries, 2026-08-01)

1. **Validity-first authoring.** Write the defeating fact, its source, and its
   *mechanism* — and check the source — **before** the prompt. A trap's
   plausibility is argued from public culinary canon, never from an observed
   model score. Difficulty beliefs from v2.1 may enter only as a labelled
   `stratumHypothesis.rationale` prefixed "hypothesis:". **Do not read
   `data/runs/2026-07-v2.1/responses/` while authoring an item** — doing so
   transfers the 14-model roster's fingerprints onto the item and must be
   recorded as a `difficulty-probe` model exposure on it. An item's admission
   record must be structurally incapable of citing model failure (M3.7,
   Gate 3).

2. **Judge-dominance rule.** Judge-dominant grading (`judgeWeight ≥ 0.8`, no
   deterministic gate) is permitted for **theory, flavour, adaptation, history,
   and the prose components of capstones**. It is **never** judge-only for:
   - **KitchenPlan** — plan validation (`validatePlan`) is the gate;
   - **Interactive** — initial-action and final-state checks are the gate;
   - **Diagnosis** — a feasibility/safety check gates the judgement;
   - **any safety-critical element** — requires ≥1 `critical` criterion **and**
     a provably-safe deterministic check.
   This follows the master plan's per-family scoring table, which pairs a
   hard-constraint gate with judging for most families.

3. **No keyword graders as the primary judgement on an open-ended item.** The
   keyword grader is retained only where the phrase *is* the finding (a
   dangerous instruction in a safety trap), and even then it needs a
   `failingAnswer` proving it can detect the wrong answer. KI-005 (the hedged-
   containment carve-out) is live; do not add keyword `constraintChecks` that a
   correct answer must trip. The self-satisfiable-group check in `bench
   candidates` exists to catch the safe-021 fail-open class — a required group
   the prompt's own words satisfy.

4. **Provenance is granular and honest.** Every item records
   `provenance.authoringChain` (ordered stages: `human-seed` → `agent-draft` →
   `agent-mutation` → `human-revision`) and `provenance.modelExposures` naming
   every model that saw it with an `actorVersion` and a `purpose`. The
   executing session's exact model id is the `agent-draft` actor. Whichever
   model authors an item is tainted for clean confirmatory evidence on it
   (M3.9); the ledger is what keeps M3.9's remedies (untouched models, fresh
   variants, exposure reported as exploratory) available later.

5. **Scenario families before sampling.** Every item's
   `classification.scenarioFamily` must be a registered id in
   `data/candidates/scenario-families.yaml`. Variants of one scenario are not
   independent evidence; the validator warns above four candidates per family.

## Ids, files, and categories

- New v3 ids use the **`-101+` range** in each category prefix (`safe-101`,
  `rgen-102`, …), never colliding with the live bank (which tops out below 100
  in every prefix).
- One file per authoring batch: `data/candidates/v3-<batch>-NN-<slug>.yaml`.
- Every candidate file **must carry a canary line** of the form
  `# CANARY:cookingbench:<guid>` — `bench candidates` enforces it.
- **Category is a fixed enum** (`CATEGORY_IDS`, the eight v2 categories). There
  is no `kitchen-plan` or `interactive` category. KitchenPlan and Interactive
  items map to the nearest category (`technique` or `recipe-generation`) and
  carry their true family in `classification.taskFamily` and
  `classification.evidenceLayer` (which *do* have `kitchen-plan` /
  `interactive-kitchen` values). Extending the category enum is a WP-1 contract
  question, flagged for Codex — do not do it in WP-6a.

## What NOT to do

No edits to `data/questions/`, `data/runs/`, `data/taste/`, `data/calibration/`.
No demotions (see `fundamentals-selection-input.md` for the deferred decision).
No grader-defect fixes or judge-mode wiring (KI-001/002/004/005 are Stage-2-lane
changes; candidates may *declare* `judgeMode: dimension` but nothing routes them
into the judge). No category-enum extension. No `bench simulate` CLI.
