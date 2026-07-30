# CookingBench methodology-first master plan

**Status:** Final canonical implementation plan — Revision 3  
**Prepared:** 30 July 2026  
**Plan owner:** Codex  
**Implementation lead:** Claude Opus 5  
**Core decision:** No rank-bearing model inference is permitted until the Methodology Readiness Gate has passed. Earlier model calls require a named, bounded, non-scoring permit and can never support a headline result.  
**Purpose:** Build a defensible, living benchmark that can discover which AI model is the strongest culinary thinker, problem-solver and prospective chef—not merely the best writer of plausible cooking advice.  
**Review rule:** Code does not silently become methodology. Claude raises any implementation conflict; Codex records the agreed resolution before the affected work continues. Independent humans remain the authority for human, culinary, safety, cultural and sensory evidence.

## Executive decision

CookingBench should stop rank-bearing model testing and complete the benchmark itself first.

The next rank-bearing run must not be used to discover whether the methodology works. The methodology, questions, judges, statistics and release controls are developed with expert review, archived answers, adversarial cases, simulations and fixture-based software tests. A later sacrificial Development Probe may make tightly bounded candidate calls only after the core development gates; those answers are permanently excluded from rank and headline evidence.

The proposed mission is:

> CookingBench identifies the AI models that most reliably combine food safety, technical understanding, culinary judgement, flavour intelligence, historical and cultural context, practical problem-solving, originality and real-kitchen usefulness.

CookingBench should answer more than “which model scored highest on a fixed set of prompts?” It should discover:

> Which models understand culinary mechanisms, maintain a valid picture of the kitchen, make good decisions when conditions change, design coherent flavour, respect culinary context, communicate usefully and produce outcomes that survive cooking?

The public claim must follow the available evidence:

- Before food is physically cooked: **best culinary AI** or **strongest AI culinary assistant**.
- After a powered, replicated and controlled Kitchen Outcome study with coverage matching the claim: CookingBench may support a broader **best AI chef** claim.

Revision 3 incorporates the benchmark research, the verified v2.1 artifact audit and the two-round Claude–Codex reconciliation completed on 30 July 2026. Claude and Codex reached substantive consensus on the evidence boundary, specificity study, human baselines, judge validation, repeat sampling, KitchenPlan/TRN relationship, pairwise design and implementation ownership. Numerical thresholds in this plan are **candidate release rules**, not universal scientific constants. Their sample sizes and confidence requirements must be justified, preregistered and frozen before sealed evidence is opened.

## Document hierarchy

- This Revision 3 master plan is the single authoritative operating roadmap.
- `CookingBench-benchmark-research-and-adoption-report.md` is supporting evidence and rationale already incorporated here.
- The earlier critique, roadmap and v3 blueprint remain useful source material but are superseded wherever they conflict with this plan.
- `CookingBench-reply-to-Claude-round-1.md`, Claude’s round-two reply and `CookingBench-plan-ownership-and-code-handoff.md` are reconciliation evidence; this document supersedes them operationally.
- Later expert evidence and implementation conflicts enter through the decision log. A material change reopens every affected gate.

## Revision 3 decisions at a glance

- Codex owns the canonical plan; Claude Opus 5 implements; Codex independently reviews code and evidence.
- Work is organised by dependencies and evidence gates, not calendar estimates.
- WP-0 Evidence Firewall is the first merge; no historical re-analysis is safe before it.
- The v2.1 result remains immutable. Factual display/cost errors receive a dated erratum.
- Legacy Shadow may rejudge archived answers only and is permanently non-scoring.
- A bounded sacrificial Development Probe occurs only after the core methodology gates and cannot support a rank.
- The sealed confirmatory tranche is sized in advance, opened once and retired after a material methodology change.
- Human baselines, JudgeBench labels, safety/cultural certification and Kitchen Outcome evidence cannot be agent-filled.
- Question and JudgeBench counts are powered by claims and scenario-family clustering rather than frozen from convenient round numbers.
- The jury uses a five-family external pool, three conflict-free seats, majority-vote primary analysis and severity correction only as sensitivity.
- KitchenPlan is the semantic contract; a TRN-inspired table is one server-rendered view.
- Public Taste, professional preference, predicted Palate and physical Kitchen Outcome remain separate evidence.

## Non-negotiable principles

1. **No rank-bearing run before readiness.** The Methodology Readiness Gate is a hard evidence gate, not a target date.
2. **Safety is non-compensatory.** Creativity cannot make up for unsafe advice.
3. **Applied reasoning beats trivia.** Theory and history questions must change a culinary decision.
4. **Flavour excellence must be rewarded.** Judging cannot only deduct faults.
5. **Consistency is part of ability.** Repeat counts and decoding settings are selected from development evidence and frozen; CookingBench never raises temperature merely to manufacture variety or selects best-of.
6. **Different evidence stays separate.** Fundamentals, KitchenPlan, Interactive Kitchen, Craft, Palate, Public Taste and Kitchen Outcome are not silently blended.
7. **Uncertainty is published honestly.** Indistinguishable models appear in the same tier.
8. **The public repository remains useful without making the live test easy to memorise.**
9. **Every result is reproducible.** Questions, prompts, judges, model routes, settings and analysis are bound to an immutable run manifest.
10. **A failed readiness check delays the run.** It does not lower the standard.
11. **Truth is validated before difficulty.** A question is never admitted merely because current models fail it.
12. **Automation must earn coverage.** Deterministic graders and AI judges operate only in the domains where held-out evidence supports them.
13. **Freshness limits exposure; it does not prove purity.** CookingBench describes its bank as contamination-limited, not contamination-free.
14. **One score may not conceal a failure mode.** Capability profiles, gates, repeat reliability and Kitchen Outcome remain visible even if a summary tier is eventually supported.
15. **Specificity must be demonstrated.** A culinary score is not assumed to measure culinary ability merely because the prompts concern food.
16. **Development evidence cannot become headline evidence.** Every model–item contact is logged and each artifact belongs to one declared evidence class.
17. **Agents accelerate production, not truth.** Agents may draft, implement and simulate; they cannot manufacture human baselines, specialist validation, public preference or physical taste evidence.

## Measurement and bank vocabulary

Use separate vocabularies for what an item measures, how well it is verified and who has seen it.

**Evidence layers**

1. **Fundamentals Gate:** settled safety, allergens, ratios, quantities, conversions and hard constraints.
2. **KitchenPlan:** ingredient states, transformations, dependencies, resources, timings, safety checkpoints and service state.
3. **Interactive Kitchen:** clarification, observations, changed conditions, recovery and final kitchen state.
4. **Craft:** theory, diagnosis, adaptation, execution, history, context and decision quality.
5. **Palate:** predicted flavour architecture, aroma, texture, temperature, progression, restraint and originality.
6. **Public Taste:** blind reader preference between safe, valid and comparably presented written proposals.
7. **Kitchen Outcome:** physical execution, measured performance and blind tasting.

**Reporting strata**

- **Chef Consensus:** highly verified competence and regression material.
- **Chef Frontier:** difficult, valid and primary rank-bearing material intended to separate current strong systems.
- **Chef Horizon:** exceptionally difficult diagnostic material that does not affect rank until both the item and its measurement are certified.

**Exposure states**

- **Public Core:** immutable reviewed examples for reproducibility and regression.
- **Live release:** original timestamped questions whose results retain their release vintage.
- **Chef’s Table Holdout:** sealed evaluation-as-a-service material with restricted, logged access.
- **Linking anchor:** a small protected set connecting releases.
- **Retired:** disclosed material that no longer contributes to the live result.

**Verification states**

`Draft → Independent solve → Expert review → Certified / Certified after repair / Diagnostic only → Admitted → Retired`

An optional **Diamond** designation marks an item independently solved by at least two relevant specialists and shown to have a meaningful expertise gap. It describes validation strength, not obscurity.

## Scope decisions

| Decision | Included |
|---|---|
| Adopt for v3 methodology | Evidence firewall; non-scoring Legacy Shadow; bounded Development Probe; static KitchenPlan schema and validators; fixed two-turn interaction; expert-certified items; atomic rubrics; Culinary JudgeBench; rotating sealed bank; evidence-driven repeat protocol; uncertainty tiers |
| Pilot later | Free-running textual kitchen simulator; original multimodal state tasks; adaptive item selection in shadow mode; expanded public evidence explorer |
| Reject | One composite across Gate/Craft/Public Taste/Kitchen Outcome; model-stumping as validity; one judge as truth; permanently public hard bank; final-state-only safety; actual-taste claims before cooking |

## Evidence classes and permits

Every artifact is assigned exactly one evidence class before work starts:

1. **Historical v2:** immutable released candidate answers, ballots, scores and reports.
2. **Legacy Shadow:** archived-answer re-analysis under a frozen shadow manifest.
3. **Development:** non-rank-bearing authored, human, synthetic, mock or transformed-archive evidence that may change the design.
4. **Development Probe:** fresh candidate outputs from predeclared sacrificial models, items and variants after the core development gates.
5. **Confirmatory pilot:** the first rank-bearing candidate evidence under the frozen protocol.
6. **Public release:** an explicitly approved immutable result.

`evidenceClass` is separate from `releaseState`.

- `evidenceClass` describes what the evidence is eligible to support.
- `releaseState` records lifecycle: `draft → audited → released`, with `quarantined` and `retired` branches.
- Historical v2.1 remains `evidenceClass: historical` and `releaseState: released`; its already released display is grandfathered.
- A new ranking may publish only from `evidenceClass: public-release` and `releaseState: released`.
- A reviewed `presentation-erratum` manifest may update labels, explanatory metadata and navigation around a historical released result only when candidate-answer, ballot and score hashes remain unchanged. It cannot recompute scores or create a new winner.

`artifactOrigin` is separate from both. It records provenance such as `archived`, `human`, `agent-authored`, `transformed-archive`, `synthetic`, `mock` or `live-provider`, with full lineage where more than one applies. Synthetic and mock artifacts remain `evidenceClass: development`; origin never upgrades evidential eligibility.

Until the Methodology Readiness Gate issues a Confirmatory Pilot Permit:

**Always prohibited**

- production scoring or public leaderboard updates from development evidence;
- ad hoc candidate or judge reruns;
- tuning against a sealed tranche;
- changing a historical result in place;
- mixing outputs, credentials or manifests across evidence classes;
- syncing or publishing an ineligible evidence class or release state, except the narrowly defined historical presentation erratum.

**Permitted without model calls**

- read-only analysis of archived answers and judge outputs;
- deterministic grader, validator, statistical and release tests;
- manually authored or deterministically mutated adversarial cases;
- human expert annotation and human-baseline work;
- usability testing with fixture responses.

**Legacy Shadow Permit**

One bounded permit may authorise new judge calls on archived or synthetic answers only. It requires a frozen manifest, blinded aliases, cost cap, isolated append-only output and the permanent label **NON-SCORING — NOT FOR LEADERBOARD**.

**Development Probe Permit**

After the construct, question, judge, output-contract and integrity development gates pass, one bounded permit may authorise fresh outputs from predeclared development-only models, items and semantic variants. It fixes every model–item contact, settings, cost cap and analysis in advance. Its results estimate generation variance, prompt robustness, provenance effects and end-to-end behaviour; they can never support a headline or rank.

Every executable permit contains:

- immutable permit ID and kind;
- approved manifest hash and methodology hash;
- explicit capabilities selected from catalog read, candidate inference, judge inference, development database write, live database write, presentation erratum, result sync and publication;
- exact model–item or judge–answer cells where inference is allowed;
- budget cap and reservation scope;
- issuer, independent approver and approval evidence;
- validity condition, single-use/execution limit, revocation state and revocation mechanism;
- cryptographic or server-side verification that cannot be replaced by a local `approved: true` flag.

The enforcement layer validates the permit below individual CLI commands so every current and future entry point shares the same policy.

The current `bench pilot` command is not an approved development tool. It remains prohibited because it makes fresh candidate calls and applies a roster-dependent admission rule that Revision 3 replaces.

## Roadmap at a glance

| Stage | Outcome | Dependency | New model batch? |
|---|---|---|---|
| 0. Evidence firewall, artifact integrity and programme lock | Make evidence classes enforceable; preserve v2; issue factual errata | Start here | No |
| 0.5 Legacy Shadow Re-analysis | Diagnose archived v2 answers under frozen alternative scoring without changing history | WP-0 plus frozen shadow judging contract; works alongside Stages 1–5 | No candidate calls; bounded archived-answer judge calls only under permit |
| 1. Construct, claims and KitchenPlan | Define what “best culinary AI” means and what a valid kitchen representation contains | Stage 0 | No |
| 2. Scoring and judge system | Build and validate the culinary jury | Stage 0; works alongside Stages 1, 3, 4 and 5 | No |
| 3. Question system and powered pilot bank | Author independently solved, adversarially tested tasks and human evidence | Stage 0; works alongside Stages 1, 2, 4 and 5 | No |
| 4. Statistical, reliability and run integrity | Freeze reproducibility, generalisability and analysis rules | Stage 0; works alongside Stages 1, 2, 3 and 5 | No |
| 5. Taste Test redesign | Build and usability-test the Tasting Flight | Stage 0; works alongside Stages 1, 2, 3 and 4 | No |
| 6. Development Probe and Methodology Readiness Gate | Measure the last unidentified development components; independently review and freeze v3.0 | Stages 1–5 pass their evidence gates | Sacrificial development calls only, then one Confirmatory Pilot Permit |
| 7. Controlled v3 pilot | First rank-bearing inference, treated as non-headline validation research | Stage 6 | Yes, only under the frozen permit |
| 8. Public v3 Chef Trials | Expand only formats that passed the controlled pilot | Stage 7 | Yes |
| 9. Kitchen Outcome | Cook and blind-taste finalist work | Valid finalists from Stage 8 | Finalists only |

This roadmap states dependency order and evidence gates, not calendar estimates. Agent teams should parallelise the production work. Named roles below are accountabilities rather than a prescribed headcount. Human recruitment and labelling begin as an early parallel evidence workstream because independent human culinary, safety, cultural, usability and sensory evidence cannot be generated by agents.

# Stage 0 — Evidence firewall, artifact integrity and programme lock

## Objective

Make evidence classes enforceable, preserve the historical result and create the decision structure needed to protect methodological quality.

## Tasks

### M0.0 Merge WP-0 — Evidence Firewall and Offline Harness

Before any judging, re-scoring or live correction:

- introduce typed evidence classes and versioned, hashed manifests;
- make historical `data/runs/*` artifacts immutable;
- require every new execution to use an isolated run ID and output root;
- deny candidate, judge and network execution by default;
- prevent Legacy Shadow from calling candidates;
- prevent development artifacts from reaching sync, publish or rankings;
- permit live publication only from an approved `public-release` manifest;
- change rank-bearing configuration drift from warnings to hard failures;
- replace check-then-record budget handling with atomic reservations;
- enforce judge conflicts by both provider and underlying base-model family;
- add mocked failure tests for overwrite, mixed settings, overspend and unauthorised publication.

The current judging path can mutate score/configuration artifacts in place, and sync/publish paths can affect the live site. No Legacy Shadow work begins until WP-0 prevents those paths.

### M0.1 Issue the no-run rule

- Record that no rank-bearing candidate-model batch may start before Stage 6 sign-off.
- Disable or clearly label any routine that could accidentally publish a new run.
- Treat archived outputs as immutable historical inputs; derived development outputs use separate append-only roots.
- Require an explicit named permit for any future inference spend.
- Disable the current `bench pilot` route for v3.

### M0.2 Establish working roles

Appoint roles rather than relying on informal review:

- product owner;
- benchmark/methodology lead;
- culinary lead;
- food-safety specialist;
- food historian or culinary-culture reviewer;
- KitchenPlan/procedural-semantics lead;
- measurement/statistics reviewer;
- judge-system engineer;
- application/Taste Test engineer;
- independent release reviewer.

One person may hold more than one role during the pilot, but author and final approver should not be the same person for high-risk items.

### M0.3 Create project controls

- Methodology decision log.
- Question change log.
- Judge-prompt version log.
- Known-issues register.
- Risk register.
- Research and evidence register.
- Item provenance, exposure and retirement register.
- Rights, attribution and naming register.
- Definition-of-done checklist.
- Separate verification, reporting-stratum and exposure states using the vocabulary defined above.

The risk register must explicitly cover scoring-bank leakage, calibration-holdout leakage, scenario-family exposure, search-time retrieval, judge/provider affinity, model/API drift, representation rights and CookBench/CookingBench naming confusion.

Use explicit issue states:

`Open → Fixed → Independently verified`

Classify methodology changes:

- **A:** wording or documentation only; no scoring effect;
- **B:** non-semantic pipeline change; targeted replay required;
- **C:** question, reference, rubric, judge, sampling or statistical change; affected gates reopen;
- **D:** bank leak, integrity breach or critical safety flaw; rotate affected material and repeat full approval.

### M0.4 Preserve the current benchmark as a baseline

- Bind the current methodology, commit `980dfcb5e3ff920fe1a3231121a6115e3fa48dcb` and `2026-07-v2.1` result as historical artifacts.
- Record known saturation, grader, judge-assignment and release-provenance issues.
- Never silently repair and re-publish an old result.
- Add tests proving historical score artifacts are byte- or hash-identical after v3 development operations.

### M0.5 Issue the factual presentation erratum

Using released artifacts only:

- show the released tie-aware rank consistently on the board and model pages;
- distinguish `$26.93` recorded candidate inference from `$41.12` candidate plus judging, and list the committed `$0.49` calibration artifact separately;
- report 333 of 630 perfect two-seat panel means before deterministic blending and 315 of 630 perfect final blended scores;
- annotate repository visibility as private at the first audit and public after Jordan changed it;
- retain the original release and publish a dated erratum rather than rewriting history.

### M0.6 Run Stage 0.5 — Legacy Shadow Re-analysis

This is a cross-stage development task, not a prerequisite for beginning Stages 1–5. Run it only after WP-0 and the WP-4 shadow judging prompt, transform and Legacy Shadow manifest are frozen:

- rejudge archived answers in anchored dimension mode;
- replay fault mode, declared rubric weights and non-compensatory caps as separate diagnostic analyses;
- adjudicate the 73 archived large-disagreement flags and audit a stratified sample of unflagged cases;
- test ceiling reduction, item influence, judge-family effects and rank sensitivity;
- build a 60–80-case development calibration pack, never described as the release holdout;
- test judge/scorer invariance under semantically equivalent transformations of archived material;
- run a frozen negative-discrimination exclusion sensitivity analysis.

The last sensitivity view records that 12 active items have negative top-versus-bottom discrimination, their rounded variance shares sum to 15.4%, and deleting them reorders the top four. These are diagnostic facts, not proof that the board or variance is “inverted.” Freezing and hashing the rule now makes the retrospective analysis reproducible, not prospective. The view is labelled **NON-SCORING — NOT FOR LEADERBOARD**, does not auto-retire the items, and does not produce a corrected winner.

The Legacy Shadow may not:

- call candidate models;
- overwrite or silently edit v2;
- turn a post-hoc rubric or item exclusion into a public winner;
- automatically retire the 33 all-perfect active items;
- decide whether pairwise preference evidence is necessary for constructs where pairwise preference is primary.

### M0.7 Resolve representation rights and naming risk

- Record RecipeTables and Michael Chu’s Cooking for Engineers recipe summaries as inspiration for a dependency-based recipe view.
- Do not copy either site’s source code, exact styling, recipe content or merged-cell notation.
- Define KitchenPlan as an independent semantic representation, informed by open standards such as Cooklang and Schema.org plus cooking-procedure research.
- Seek permission before publicly using a substantially similar tabular notation.
- Maintain an accessible step-list and timeline view even if a table or graph is offered.
- Review the discoverability risk created by the separate 2025 academic benchmark named **CookBench**.
- Decide whether “CookingBench — The AI Chef Trials” or another descriptor sufficiently distinguishes the project before major promotion.
- Treat this as a naming and attribution review, not a predetermined rename or legal conclusion.

## Deliverables

- Project charter.
- Named role/approval matrix.
- Evidence-firewall tests and no-run policy.
- v2 baseline and known-issues register.
- Dated presentation erratum.
- Legacy Shadow specification; its append-only report is a Stage 0.5 deliverable after the shadow judging contract is ready.
- Versioning and decision-log conventions.
- Research/evidence register.
- Rights, attribution and naming decision.

## Gate 0 — Complete when

- The no-run rule and permit classes are enforced in code.
- Historical artifacts cannot be overwritten and non-release evidence cannot publish.
- Every workstream has an accountable role.
- Current v2 results are frozen as historical rather than editable evidence.
- Presentation errors are corrected without recomputing the v2 result.
- Legacy Shadow execution is blocked until its separate permit, frozen judging contract and isolated output are present.
- A methodology change can be traced to a recorded decision.
- The project has a documented, approved position on RecipeTables/Cooking for Engineers inspiration and CookBench naming risk.

# Stage 1 — Define the construct and public claims

## Objective

Define what CookingBench is trying to measure before writing or scoring more questions.

## Tasks

### M1.1 Freeze the evidence layers

CookingBench reports the seven layers defined in the shared vocabulary:

1. Fundamentals Gate.
2. KitchenPlan.
3. Interactive Kitchen.
4. Craft.
5. Palate.
6. Public Taste.
7. Kitchen Outcome.

Fundamentals qualifies a model; it does not inflate the Craft ranking. KitchenPlan and Interactive Kitchen reveal whether plausible prose corresponds to a valid process. Public Taste cannot override a Gate failure. Palate before cooking is a prediction of sensory quality, not evidence of actual taste.

### M1.2 Define the KitchenPlan construct

KitchenPlan is an independent, openly specified representation of the kitchen as ingredients, states, actions and constraints.

Minimum v3 objects:

- recipe title, servings, locale and service time;
- ingredients with stable IDs, quantities, units, allergens and starting states;
- equipment with capacity and availability;
- operations with inputs, outputs, equipment, duration, temperature and sensory target;
- dependencies and parallel branches;
- ingredient and preparation state transitions;
- safety checkpoints and trajectory invariants;
- observations and changed conditions;
- component holding limits and final service state.

The candidate supplies a human-readable answer and a KitchenPlan object for selected tasks. CookingBench renders the same plan server-side as a TRN-inspired dependency table, graph, schedule or accessible step list, but grades the underlying data. The table is one canonical renderer, not the semantic contract.

The representation must support multiple valid culinary plans. Format compliance alone is not culinary competence, and a validator must never reject a viable approach merely because it differs from one reference path. Structural validation is deterministic only when quantities, equipment limits, timing ranges, holding limits and safety thresholds come from the prompt or an independently verified judge pack. A candidate cannot validate its own plan by inventing convenient assumptions. Report structural consistency and culinary correctness separately.

### M1.3 Define the Interactive Kitchen construct

Interactive Kitchen tasks test whether a model:

- recognises when an instruction is genuinely ambiguous;
- asks a useful clarification rather than guessing or over-questioning;
- tracks what exists, where it is and in what state;
- updates only the affected parts of a plan after a new observation;
- manages equipment, holding and timing conflicts;
- recovers from a fault without creating collateral damage;
- stops, restarts or escalates when safe recovery is no longer credible.

Preference, common-sense and safety ambiguity must be represented separately. The planned first move can be an action, one clarification, a refusal to proceed or a safe fallback.

The v3 pilot uses deterministic fixed two-turn observation/change scripts. A free-running textual simulator is a later pilot, and multimodal or embodied simulation remains research-only until the state model is reliable.

### M1.4 Define the sensory dossier

For flavour-design tasks, candidates use a compact comparable contract:

- dish identity and intended diner experience;
- first aroma and aromatic progression;
- dominant, supporting and finishing flavours;
- salt, acid, sweetness, bitterness, savouriness, fat and heat strategy;
- texture and temperature contrasts;
- progression from first bite to finish;
- one likely sensory failure and correction;
- what was deliberately left out.

This gives the Palate jury concrete sensory claims to test and reduces the advantage of unstructured verbosity.

### M1.5 Approve the proposed Craft axes

Use the following as the starting proposal for expert review:

| Craft axis | Proposed weight | What it measures |
|---|---:|---|
| Technical reasoning and food theory | 20% | Mechanisms, transfer of principles, consequence prediction |
| Diagnosis and recovery | 20% | Finding likely causes and choosing workable rescues |
| Flavour and sensory judgement | 20% | Balance, identity, progression, texture, temperature and aroma |
| Adaptation and lateral problem-solving | 15% | Resourcefulness under unfamiliar or conflicting constraints |
| Execution, service and practicality | 15% | Timing, holding, equipment, communication, waste and realism |
| Culinary history, tradition and context | 10% | Provenance, change over time, cultural context and responsible adaptation |

Originality, restraint, clarity and uncertainty are scored as cross-cutting dimensions where relevant rather than becoming separate trivia-heavy categories.

These weights are a starting proposal, not an agreed scientific fact. Culinary and measurement reviewers must approve or replace them before results are seen. The item count in a category must never accidentally determine its importance.

KitchenPlan and Interactive Kitchen are evidence/task modes mapped onto these constructs; they are not automatically extra weighted abilities. Palate is the public result arising from flavour-and-sensory evidence, not a second score added on top of the 20% flavour axis.

| Evidence or task mode | Main construct contribution | Public output | Aggregation rule |
|---|---|---|---|
| Fundamentals Gate | Safety and hard constraints | Qualified / not qualified plus failure detail | Non-compensatory |
| KitchenPlan | Theory, execution, service, adaptation | Plan validity and failure profile | Counts once through mapped construct criteria |
| Interactive Kitchen | Diagnosis, adaptation, execution | Clarification and recovery profile | Counts once through mapped construct criteria |
| Craft prose | Theory, diagnosis, history, context | Anchored construct scores | Preregistered Craft analysis |
| Palate | Flavour and sensory judgement | Jury distribution and supported preference | Not added again to the same flavour evidence |
| Public Taste | Reader preference | Separate public rating | Never overrides correctness or safety |
| Kitchen Outcome | Physical execution and taste | Separate real-world result | Required for “best AI chef” claim |

### M1.6 Define what each axis is not

- Food theory is not a chemistry vocabulary test.
- Food history is not a list of dates or unsupported origin stories.
- Creativity is not ingredient accumulation or novelty for its own sake.
- Problem-solving is not a riddle with one clever phrase.
- Flavour is not a judge stating personal preference without sensory reasoning.
- Concision is not a substitute for completeness.
- Long, polished writing is not evidence of culinary competence.
- KitchenPlan is not a syntax-compliance contest.
- Interactive Kitchen is not a reward for asking unnecessary questions.

### M1.7 Define the claims ladder

Approve precise language for:

- a Gate-qualified model;
- a strong Craft model;
- a high Palate model;
- a Public Taste favourite;
- an evidence-supported overall tier;
- a Kitchen Outcome winner.

Ban unsupported language such as “proven best” when confidence intervals overlap or the food has not been cooked.

### M1.8 Define the target population, fairness and coverage

- State the intended universe of generalisation before sampling: cuisine, domestic/professional context, budget, equipment, skill level, dietary context, language and task type.
- Represent domestic, professional and resource-limited kitchens.
- Include regional terminology and measurement systems.
- Avoid treating one cuisine’s conventions as universal.
- Review culturally specific questions with relevant expertise.
- Require uncertainty or clarification when a prompt is genuinely underspecified.
- Define which tools, web access, images or follow-up questions each track permits.
- Report browser-enabled and closed-book conditions separately.
- Keep dated regulation, recall or current-guidance questions in a separate `Current Kitchen` track with jurisdiction and `asOf` metadata; do not blend browsing recency into stable culinary reasoning.

### M1.9 Decide whether an overall tier is supportable

The v3 pilot reports the seven evidence layers and model failure signatures first.

- Do not create one composite that blends Fundamentals, Craft, Public Taste and Kitchen Outcome.
- A summary **Craft tier** may be published only if construct validity, reliability, weighting and sensitivity checks support it.
- Fundamentals and safety remain non-compensatory.
- Public Taste and Kitchen Outcome remain separate evidence.
- If removing one question family or one judge family changes the leader, publish a profile or shared tier rather than a sole winner.

### M1.10 Define the specificity claim

CookingBench must determine whether it adds culinary information beyond general model capability.

**Exploratory analysis**

- Use exact model snapshots and data vintages where a defensible mapping exists.
- Because the archived run contains only 14 provider-clustered snapshots and no verified Arena route mapping, any current general-score adjustment remains descriptive.
- Use at most one externally defined, preweighted general-capability proxy or composite rather than fitting a flexible capability stack to 14 observations.
- Report absolute CookingBench performance, general-score association and **general-score-adjusted CookingBench residuals** separately.
- Never use residuals as the primary leaderboard or call them culinary ability.

**Confirmatory incremental validity**

- Freeze a general-capability factor or matched non-culinary control before candidate inference.
- Test through cross-validation whether CookingBench adds predictive value for an untouched culinary-expert or Kitchen Outcome criterion.
- The criterion cannot be the same evidence used to author, select, weight or tune CookingBench.
- A culinary-specific claim requires incremental out-of-sample prediction, not merely low correlation with a general score.

## Deliverables

- Construct definition.
- KitchenPlan schema and construct handbook.
- Interactive Kitchen construct and state model.
- Sensory-dossier contract.
- Scored-axis handbook.
- Public claims policy.
- Specificity study specification.
- Fairness and cultural-review policy.
- Proposed weights with written rationale.

## Gate 1 — Complete when

- Experts can explain the difference between every axis.
- Every planned question maps to a declared capability.
- Relevant experts agree that KitchenPlan captures real dependencies without forcing one culinary style.
- Interactive tasks distinguish necessary clarification from needless questioning.
- History and theory have applied culinary purposes.
- The public claim is narrower than or equal to the evidence.
- The target task population and tool conditions are explicit.
- The exploratory and confirmatory specificity predictors, criteria and claims are declared.
- Weights and aggregation rules are either frozen for the pilot or the plan explicitly commits to profile-only reporting.

# Stage 2 — Design and validate the scoring and judge system

## Objective

Create a judging system that detects danger, rewards excellence and knows when to defer.

## Tasks

### M2.1 Specify three grading modes

Apply them as a cascade:

`deterministic and reference-grounded checks → blind structured judgement → human escalation`

Presentation is a separate bounded dimension. It cannot compensate for unsafe, objectively incorrect or infeasible content.

**Fault-deduction mode**

Use deterministic or reference-grounded checks for factual, safety, allergen, quantity, unit, scaling, KitchenPlan validity, timing and hard-constraint errors wherever the construct permits.

**Dimension mode**

Use anchored 0–4 scores for technical reasoning, diagnosis, feasibility, sensory logic, context and execution.

**Pairwise mode**

Use for close comparisons between two valid creative answers:

- A better;
- B better;
- substantively equal;
- both unacceptable;
- abstain.

“Both unacceptable” must never be stored as an ordinary tie.

Every automated result records the route used, confidence, judge disagreement and whether a human could have changed it.

### M2.2 Define hard caps and failure rules

Create a severity matrix. These caps are proposed policy parameters requiring independent food-safety and measurement review; they are not claimed to have been empirically identified:

- critical safety or allergen failure → task score 0;
- non-safety hard-constraint failure → maximum 40;
- infeasible plan or omitted required output → maximum 60;
- unsupported historical claim presented as fact → context score cap;
- appropriate uncertainty or clarification → reward, not penalty.

No safety-critical case is accepted by an LLM judge alone. A deterministic rule or relevant human specialist must confirm it.

### M2.3 Write behavioural scoring anchors

Every scored dimension needs examples for 0, 1, 2, 3 and 4.

Anchors must describe observable behaviour. Terms such as “excellent,” “creative” or “authentic” are insufficient without operational meaning.

### M2.4 Replace reference answers with judge packs

Every subjective item receives:

- the capability being tested;
- hard constraints;
- atomic `include`, `avoid`, `critical` and `exceptional` criteria with declared weights;
- intended sensory, practical or historical outcome;
- relevant sources;
- multiple acceptable solution families;
- common failure modes;
- an exceptional answer;
- a competent but ordinary answer;
- a plausible, polished but wrong answer;
- a clearly failing answer.

KitchenPlan items also receive validator fixtures for valid alternatives, invalid transitions, cycles, resource conflicts, unsafe trajectories and incorrect service states.

### M2.5 Balance and blind the jury

- Maintain a versioned external pool spanning at least five genuinely distinct provider/base-model families.
- Select three conflict-free seats per candidate comparison through a preregistered balanced incomplete-block assignment across candidate pairs and task strata.
- Exclude any judge sharing either candidate’s provider or underlying base-model family whenever three external seats exist.
- If three conflict-free seats are unavailable, expand the external pool or route the comparison to humans.
- Give every eligible candidate family an equivalent distribution of judge families and prevent any candidate from receiving a systematically more lenient panel.
- Render candidates anonymously and identically; expose no provider or model names.
- Preserve candidate text. Standardise the container but do not shorten an answer to remove verbosity.
- Run A–B and B–A in independent presentations but treat the two presentations from one judge as one rater unit. An order flip is instability requiring escalation, not two independent votes.
- Escalate order flips, split critical tags and large criterion gaps.
- Retain criterion decisions, evidence, individual verdicts, confidence and vote entropy rather than only the mean.
- Use unweighted majority vote as the transparent primary analysis. Any severity correction is learned only on development evidence and reported as sensitivity.
- Publish leave-one-judge-family-out sensitivity.

### M2.6 Create the adjudication workflow

Human review is mandatory for:

- any safety disagreement;
- any judge split larger than the declared tolerance;
- any high-entropy or low-confidence case outside validated automation coverage;
- any order-unstable pair affecting a headline tier;
- all challenged references;
- a stratified random sample of otherwise unflagged cases.

Adjudicators record the decision, evidence, confidence and whether the item or judge prompt must change.

### M2.7 Build Culinary JudgeBench

Create a held-out calibration bank using authored and archived answers:

- all capability axes and severities;
- close valid pairs;
- safe-looking hidden hazards;
- concise versus padded versions;
- plain correct versus polished wrong versions;
- model self-identification and prompt-injection attempts;
- culturally contextual questions;
- multiple legitimate answers;
- tie, both-bad and abstention cases.

Author the development pool at two to three times the powered sealed requirement so weak, ambiguous or duplicative cases can be removed without hollowing out a stratum.

The final sealed holdout size and composition are fixed by Stage 4 precision analysis before it is opened. It must provide adequate evidence for:

- every critical hazard and allergen stratum;
- identical-answer and genuine-tie controls;
- length, verbosity and superficial-style counterfactuals;
- every automatically accepted culinary stratum and candidate provider/base family;
- independently adjudicated subjective pairs;
- qualified independent review of every critical safety case;
- both answer orders or a separately powered preregistered order audit;
- repeated judgement on a preregistered subset.

“300 pairs × three labels = 900 expert judgements” is planning arithmetic, not a scientific constant. Distinguish unique cases, human raters, rater-units and raw order presentations; account for clustering by person; use objective keys where the construct is genuinely objective; and report specialist coverage and ballot-hours.

Development and sealed holdout material remain separate. A failed holdout is terminal for that panel/protocol claim. A fresh holdout is permitted only after a substantive diagnosed change to the panel, prompt, retry policy or rubric, supporting development evidence, disclosure of every prior attempt, independent re-freeze and new preregistration.

### M2.8 Approve judge release thresholds

These are **provisional CookingBench release criteria**, not thresholds inherited as truth from another benchmark. Stage 4 must confirm their sample size, confidence intervals and feasibility before the sealed holdout is opened:

- 100% structured ballot capture after the documented retry rule;
- for the automatically accepted noncritical subset, lower 95% confidence bound of panel–expert agreement at least 85% at automation coverage of at least 70%;
- across the whole noncritical holdout, agreement at least 80%, macro-F1 at least 0.75 and no primary stratum below 70%;
- lower 95% confidence bound for panel agreement minus leave-one-human-out agreement greater than −5 percentage points;
- A–B/B–A winner consistency at least 90%, with the first-position effect inside a preregistered ±5-point equivalence margin;
- repeat-judgement consistency at least 90%;
- ordinal Krippendorff’s alpha for anchored 0–4 dimensions and nominal or custom-distance alpha for canonicalised pairwise outcomes, with clustered bootstrap intervals;
- identical controls called a tie at least 95% of the time;
- padded or repetitive duplicates preferred no more than 5% of the time;
- substantive decision preserved under superficial style changes at least 90% of the time;
- zero critical unsafe false accepts in the sealed critical set, while retaining the rule that safety is never LLM-only;
- removing one judge family changes the overall preference estimate by less than five points and produces no confirmed winner reversal;
- all failed, low-confidence or out-of-coverage domains routed to humans.

If the sealed holdout fails, that panel/protocol claim fails. Do not retry an unchanged or cosmetically renamed design. A fresh holdout requires a substantive diagnosed change, development evidence, full attempt disclosure, independent re-freeze and new preregistration.

Publish exact confidence intervals for critical recall and false acceptance. Zero observed failures is not described as zero underlying risk.

Alpha measures reliability, not truth. It supplements error against expert/adjudicated decisions, dimension distance, macro-F1, coverage, safety recall, false acceptance and position invariance. Canonicalise `A` and `B` to candidate identity before agreement analysis; treat `abstain` as missing and `both_unacceptable` as a separate absolute outcome.

### M2.9 Define Palate judgement separately

Palate judges receive the candidate sensory dossier and the task’s culinary evidence pack.

They judge coherence, balance, aroma logic, texture and temperature, progression and finish, identity, restraint, purposeful originality and execution plausibility.

- Judges record individual sensory reasoning before seeing panel aggregation.
- Genuine preference distributions remain visible.
- A polarising but coherent dish may produce disagreement without the grader being broken.
- Personal preference is never converted into factual correctness.
- Only Kitchen Outcome may claim how a cooked dish actually tasted.

## Deliverables

- Scoring handbook.
- Judge output schema.
- Hard-cap matrix.
- Judge-pack template.
- Adjudication SOP.
- Culinary JudgeBench development and holdout sets.
- Judge-validation report.
- Palate jury handbook and sensory anchors.
- Automation coverage and escalation policy.

## Gate 2 — Complete when

- Judges pass the held-out calibration criteria.
- JudgeBench gold labels come from independent qualified humans rather than model consensus.
- Zero critical unsafe false accepts occur in the sealed calibration set, and no safety-critical route is LLM-only.
- A–B/B–A testing exposes no unresolved order bias.
- Pairwise agreement is calculated on candidate-canonicalised ballots and order swaps are treated as one rater unit.
- Length, style and identical-answer controls pass.
- No candidate family receives a predictably easier panel.
- Every large disagreement has a defined resolution path.
- Human reviewers agree that 0–4 anchors distinguish ordinary from exceptional work.
- The release criteria and powered sample sizes were frozen before holdout access and were not tuned to a preferred ranking.
- The sealed tranche is opened once; any statistical failure is terminal for that protocol/claim. A fresh tranche requires the substantive-change and full-disclosure process above.

# Stage 3 — Build the question system and powered pilot bank

## Objective

Create difficult, fair and scorable tasks that test transferable culinary ability rather than recall or wording tricks.

## Question blueprint

Begin development with **30 Craft task archetypes plus a separate 15-item Fundamentals regression set**. This is a coverage scaffold, not a frozen rank-bearing count. The confirmatory pilot count expands if Stage 4 simulation shows that the declared reliability, subgroup precision or minimum-meaningful-difference claims require more independent scenario families.

| Pilot family | Craft tasks | Typical format |
|---|---:|---|
| Applied theory and mechanism | 4 | Predict, explain, transfer or change one variable |
| Diagnosis and recovery | 4 | Symptoms, ranked causes, rescue and stopping rule |
| Flavour and sensory construction | 4 | Build, edit, defend or reject a plate using a sensory dossier |
| Adaptation and lateral problem-solving | 3 | Scarcity, conflicting constraints or no-addition tasks |
| KitchenPlan, state and service | 6 | Compile, audit, repair, state probe, multi-dish schedule and counterfactual |
| Interactive ambiguity and change | 4 | Clarify, observe, re-plan and recover |
| History, tradition and culinary context | 3 | Evidence, evolution, myth correction and responsible adaptation |
| Mixed capstone cases | 2 | Multi-turn cases combining at least three axes |
| **Total** | **30** | |

At least two KitchenPlan tasks use shared equipment and fragile timing windows across multiple dishes. At least two Interactive Kitchen tasks pair an ambiguous instruction with a clear counterpart so the model can be penalised for both reckless guessing and needless questioning.

The distribution is an authoring blueprint, not the eventual weighting or sample size. Tasks may measure more than one axis, but each must have one primary capability. Aim for at least 25 independent scenario families in development, while recognising that 25 alone does not establish a 0.90 reliability coefficient. Final family and task counts are selected by the preregistered generalisability and power study before the bank is sealed.

| Family | Typical scoring approach |
|---|---|
| Applied theory | Structured prediction or ordering checks plus a source-anchored causal-reasoning judge |
| Diagnosis and recovery | Feasibility/safety checks plus ranked-cause, test-quality and rescue judging |
| Flavour and sensory | Hard-constraint gate plus anchored dimension and pairwise Palate judging |
| Adaptation and lateral thinking | Hard-constraint gate plus viability, coherence, originality and constraint-elegance dimensions |
| KitchenPlan, state and service | Schema validation, state-transition, dependency, resource, safety and timeline checks plus bounded explanation judging |
| Interactive Kitchen | Initial-action, clarification, trajectory-invariant and final-state checks plus recovery-quality judging |
| History and context | Evidence-attribution checks plus source-grounded synthesis and uncertainty judging |
| Mixed capstone | Predeclared combination of the relevant modes; safety remains non-compensatory |

## New first-class question families

### Food theory

Test whether the model can use mechanisms to make a decision.

Strong formats:

- predict what changes when heat, water, acidity, salt, fat or shear changes;
- compare two plausible mechanisms and choose the one consistent with the evidence;
- transfer a principle from one dish to an unfamiliar dish;
- diagnose from texture, aroma, temperature or timing observations;
- identify what evidence would disprove the proposed mechanism;
- rewrite only the faulty step in a recipe and predict the failure it prevents.

Useful theory areas include heat transfer, protein behaviour, starches, emulsions, water activity, fermentation, browning, gelation, crystallisation, aroma extraction and seasoning perception. Questions should not require chemistry terminology when correct culinary reasoning can be expressed plainly.

### Food history and culinary context

Test contextual intelligence, not pub-quiz memory.

Strong formats:

- explain how climate, preservation, trade, labour or equipment shaped a dish;
- distinguish documented history from a popular but weak origin story;
- compare two periods or regions and identify the culinary consequence;
- adapt a traditional preparation while accurately describing what has changed;
- identify when “authenticity” is the wrong frame and explain a more responsible one;
- use historical constraints to reconstruct a plausible method;
- flag uncertainty when sources disagree.

Historical references require credible sources and relevant review. A contested origin can be a good question only when uncertainty itself is part of the expected answer.

### Thinking outside the box

Test controlled originality and restraint.

Strong formats:

- add exactly one element;
- remove exactly one ingredient;
- rescue with technique only;
- create contrast while common flavour levers are forbidden;
- defend or reject an unusual combination;
- meet the same goal with different equipment;
- solve a dish backwards from the desired final bite;
- design around waste, leftovers or a very small pantry.

The best answer should be distinctive because the reasoning is strong—not because it is eccentric.

### Problem-solving

Test decisions under incomplete and changing information.

Strong formats:

- ask exactly one clarifying question, then receive a fixed second turn;
- rank likely causes rather than listing everything;
- allocate a limited error budget under service pressure;
- revise after a new sensory observation;
- manage shared equipment and holding constraints;
- decide when to stop rescuing and restart;
- identify which defect matters most to the diner;
- communicate a safe fallback when information is insufficient.

### KitchenPlan and ingredient-state reasoning

Test whether the model can turn culinary prose and observations into a valid process.

Strong formats:

- compile a recipe into ingredients, operations, dependencies and service state;
- find a missing, unsafe or impossible edge;
- repair a plan with the smallest viable change;
- identify what exists, where it is and in what state at minute X;
- re-plan after one ingredient, appliance or service condition changes;
- update only the affected branch after a substitution;
- make several dishes finish within valid holding windows;
- compare two plans and cite the concrete failure in the weaker one;
- translate a valid graph into clear instructions for the intended cook.

### Ambiguity and interactive recovery

Test whether the model asks for context only when it matters and uses new evidence correctly.

Strong formats:

- paired clear and ambiguous prompts covering preference, common-sense and safety ambiguity;
- exactly one permitted clarification followed by a fixed answer;
- a new aroma, texture, temperature or timing observation;
- an unavailable ingredient or occupied appliance;
- an allergy disclosed after the initial plan;
- a recovery that must preserve unaffected components;
- a case where the correct decision is to stop, restart or choose a safe fallback.

## Item authoring tasks

### M3.1 Finalise the item schema

Each item must record:

- ID and version;
- primary and secondary capability;
- task family and scenario-family cluster;
- evidence layer, Chef Consensus/Frontier/Horizon stratum and exposure state;
- locale, kitchen context and equipment;
- difficulty hypothesis;
- source and source confidence;
- human seed, agent draft, agent mutation and human-revision provenance;
- authoring model, version, prompts and transformations where applicable;
- author, reviewers and repair history;
- every model/version exposed during development and the purpose of contact;
- independent-solve records and verification state;
- hard constraints;
- atomic `include`, `avoid`, `critical` and `exceptional` rubric criteria;
- acceptable solution families;
- judge pack;
- passing, ordinary, plausible-wrong and failing examples;
- adversarial cases;
- expected output contract;
- judge mode;
- deterministic checks and validator version;
- KitchenPlan contract or interactive state/observation script where relevant;
- optional evidence pack supplied to both candidate and judges;
- the shortcut or failure mode the item is designed to block;
- chef-authored failure taxonomy labels for reasoning, sequencing, safety, feasibility, state, context and sensory errors;
- safety and cultural-review flags;
- public-core, live, Chef’s Table, linking-anchor or retired exposure status;
- `asOf`, jurisdiction and next-review date for Current Kitchen material.

### M3.2 Create authoring templates

Build templates for:

- single-turn structured decisions;
- multi-turn diagnosis;
- pairwise creative comparison;
- historical/contextual analysis;
- service timeline;
- KitchenPlan compile, audit, repair, state and scheduling;
- paired ambiguity and interactive recovery;
- recipe critique;
- sensory or image-supported cases for later tracks.

### M3.3 Author broadly, admit narrowly

- Draft two to three times the powered rank-bearing requirement, beginning with at least 75–90 candidate Craft tasks across the full question universe.
- Source briefs from original expert scenarios, opt-in real cooking-help questions, documented kitchen incidents and chef red-team cases; privacy-screen and rewrite any real-user material.
- Screen duplicates and weak formats before expert time is spent.
- Independently solve and review enough candidates to leave a powered, stratified bank after rejection and repair.
- Admit only certified items needed by the frozen coverage and power design.

### M3.4 Source and expert review

- One relevant specialist owns the construct brief and sources; agents may draft under recorded provenance; an independent specialist solves the resulting item blind without seeing the proposed answer or rubric.
- A second independent reviewer checks the prompt, solution families, scoring route and shortcut risk.
- The author cannot be the final certifier for a rank-bearing item.
- Disagreement requires revision and fresh independent solving, not negotiated ambiguity.
- Food-safety specialist for safety-relevant items.
- Relevant cultural/history review for contextual items.
- Resolve disagreements before admission.
- Record uncertainty rather than forcing one historical narrative.
- Model failure may be examined only after validity work; it is never proof of item quality.
- Optional Diamond items also receive a skilled non-expert shortcut test or adjacent-professional comparison.
- Fundamentals, safety, planning and practical communication are not rejected merely because a careful non-expert can solve them.

### M3.5 Adversarial item testing

Every admitted task is tested against:

- a correct concise answer;
- a correct but unconventional answer;
- a polished but subtly wrong answer;
- a verbose non-answer;
- a hedged contradictory answer;
- keyword stuffing and negation;
- a direct attempt to influence the judge;
- a hard-constraint miss;
- a likely model-family style variation;
- a semantically equivalent prompt form;
- a valid plan that follows a different culinary path;
- an invalid plan with a superficially convincing final answer.

### M3.6 Establish public and sealed banks

- Public Core: immutable schemas, representative examples, regression material and scoring guidance.
- Live releases: original timestamped tranches whose scores retain their release vintage.
- Chef’s Table Holdout: sealed scoring material used only through controlled evaluation after a pre-run hash commitment.
- Linking anchors: a small permanently protected set connecting releases.
- Retired material: disclosed only after it stops scoring, then replaced without changing construct weights.
- Exposure budgets, access logs, canary/provenance records and a leak-response procedure.
- Describe all banks as contamination-limited. Freshness, private access or post-cutoff dates are not treated as proof of no contamination.

### M3.7 Discover difficulty without sacrificing validity

- Assign Chef Consensus, Chef Frontier or Chef Horizon initially as a hypothesis.
- Keep important easy safety material in Fundamentals even if it does not rank frontier models.
- Audit any item expected to pass above 95% or below 5%.
- A Horizon item remains diagnostic until ambiguity, key quality, grader behaviour and expert agreement are certified.
- After the controlled pilot, audit every non-positive-discrimination, all-pass, all-fail or excessively influential item.
- Preserve scenario-family clusters so variants do not masquerade as independent evidence.
- Separate item-admission and final-evaluation evidence. Record every model/version used to select or revise an item.
- A model cohort used to create model-stumping items cannot then supply clean confirmatory evidence on those same items. Use untouched evaluation models, fresh item variants or report the overlap as exploratory.

### M3.8 Run the two human studies

**Matched human baseline**

- Relevant chefs, cooks or specialists receive the same task, output contract, tools and information as candidate models.
- Predeclare defensible task-specific time budgets for each cohort.
- If time conditions differ, report them separately and do not call the comparison fully matched.
- Human answers enter the same anonymous candidate pool and pass through the same rubric, objective checks and adjudication process.

**Expertise-gap and shortcut study**

- Skilled non-experts receive generous time and permitted web access on selected Chef Frontier or Diamond items.
- Use the result to test whether the item requires culinary expertise rather than generic reasoning, retrieval or wording clues.
- Derive any admission threshold from CookingBench’s own human pilot and confidence requirements.
- Do not apply non-expert failure as a universal gate.

### M3.9 Test authoring provenance before the confirmatory freeze

Use the sacrificial Development Probe to compare human-authored, agent-authored and agent-assisted items within matched task families and difficulty targets.

- Treat provenance as granular metadata, not a binary label.
- Account for scenario family, construct, review process and intended difficulty.
- Test provenance-by-responding-model-family interactions.
- Compare difficulty, discrimination, judge disagreement and influence with uncertainty.
- If agent-assisted authoring shows a systematic shared-prior advantage, repair the authoring process and validate fresh items.
- Do not make post-hoc provenance exclusions from rank-bearing results.
- A model used to author, select or tune an item cannot provide clean confirmatory evidence on that item.

## Deliverables

- Question taxonomy.
- Complete item schema.
- Authoring and review guide.
- Candidate-task inventory at two to three times the powered requirement.
- Powered, stratified Craft pilot bank.
- Fifteen validated Fundamentals items.
- KitchenPlan schema, validator and fixture suite.
- Interactive Kitchen state/observation scripts.
- Item-level sources, judge packs and adversarial fixtures.
- Public Core/Live/Chef’s Table/anchor/retirement policy.
- Matched-human-baseline and expertise-gap protocols.
- Provenance-discrimination analysis specification.

## Gate 3 — Complete when

- Every admitted item has one clear primary capability.
- Every item has multiple acceptable approaches where appropriate.
- Every rank-bearing item has a successful blind independent solve.
- Every objective grader passes correct, wrong, contradictory and adversarial fixtures.
- KitchenPlan validators accept independently verified alternative plans and reject declared invalid trajectories.
- History items are source-supported and uncertainty-aware.
- Creative items reward coherent originality rather than mere novelty.
- Reviewers agree the prompt has enough information to support fair scoring.
- No known wording trick determines success.
- No item is admitted solely because models failed it.
- Required matched-human or expertise-gap evidence is complete for the claim and stratum.
- Provenance and every development model–item contact are recorded.
- No authoring or tuning model supplies clean confirmatory evidence on an exposed item.
- No Chef Horizon or `Diagnostic only` item contributes to the rank.
- The sealed pilot bank and its access controls are ready.

# Stage 4 — Build statistical, run-integrity and release controls

## Objective

Make the future result reproducible, uncertainty-aware and resistant to accidental or post-hoc manipulation.

## Tasks

### M4.1 Freeze an immutable run manifest

Record:

- Git commit;
- dataset and item hashes;
- release vintage, bank partition, verification state and exposure status;
- KitchenPlan schema, validator and interactive-environment hashes;
- system/user prompt hashes;
- grader and judge-prompt hashes;
- calibration-set hash;
- model slug and returned model identity;
- provider route and model revision where available;
- generation parameters, response limits and seed where supported;
- retries, failures, timestamps, token use and cost;
- raw-response, score, analysis and publication hashes.

### M4.2 Define the response protocol

- Structured task-specific output contracts.
- Equivalent visible answer budgets.
- Declare whether each condition measures lowest-stochasticity controlled performance, product-default reliability or creative variation.
- Use the provider-supported lowest-stochasticity setting for the primary controlled condition; do not assume every route exposes a literal numeric temperature of zero.
- Select the official repeat count from the Development Probe’s model × scenario × repeat variance, precision target and cost simulation; do not impose a blanket three-response rule.
- Repeat byte-identical prompts on a stratified sacrificial subset and test semantic paraphrases on a separate development subset.
- If creative sampling is a separate construct, preregister it as a separate result and report the full distribution.
- No best-of selection.
- Report the preregistered performance statistic plus repeat reliability such as worst-of-n or probability of passing all trials.
- Hash byte-identical candidate outputs and preserve their multiplicity. They may share an adjudicated/reference score for candidate-reliability analysis, but independent judge repeats remain separate evidence.
- Complete response matrix or an explicitly failed run.
- Candidate content treated as untrusted data by judges.

### M4.3 Preregister the analysis

Before a run, freeze:

- domain weights;
- Gate thresholds;
- hard caps;
- primary and secondary endpoints;
- whether the primary result is profile-only, a shared tier or a supported summary tier;
- missing-response rules;
- meaningful-difference margin;
- tier construction;
- tie-aware pairwise model and treatment of `both unacceptable`;
- treatment of anchored 0–4 scores as ordinal unless an interval-scale assumption is justified;
- pairwise multiplicity correction;
- cluster-bootstrap method;
- treatment of repeated samples;
- leave-one-item, category and judge-family sensitivity;
- influence and rank-fragility analysis;
- generalisability and dependability targets;
- stopping, abort and rerun rules.
- evidence eligibility and the single-open rule for sealed tranches;
- adaptive pair allocation, forced exploration, selection probabilities, estimator, reweighting, stopping rule and stopping correction where adaptive research is authorised.

### M4.4 Replace forced precision with supported tiers

- Publish full head-to-head evidence.
- Use statistically indistinguishable groups.
- Require practical as well as statistical significance.
- Apply Holm adjustment for named confirmatory comparisons.
- Bootstrap by scenario family, keeping repeats together.
- Use a Davidson or equivalent tie-aware extension of Bradley–Terry for pairwise summarisation.
- Use valid A wins, B wins and substantive ties in Davidson summarisation.
- Keep `both unacceptable` as an absolute failure and release-gating signal rather than a semantic tie; report it by model and run a declared sensitivity analysis because its exclusion may be non-random.
- Treat `abstain` as missingness and coverage, not a tie.
- Require an evidentially connected real comparison graph; a phantom opponent cannot create evidence between disconnected real components.
- Require multiplicity-adjusted intervals to clear both zero and the preregistered practical margin for a sole-winner claim.
- Publish the smallest audited data deletion or influence set that can flip the leader.
- Do not use “proven better” for an unadjusted 95% result.

### M4.5 Run a generalisability and reliability study

Use archived answers, authored fixtures and captured judge outputs first, then the permitted sacrificial Development Probe for variance components unavailable in archived evidence:

- all suitable historical model snapshots, retaining provider-family identity and exact route limitations;
- a stratified question/fixture set sized for the variance components and mandatory constructs;
- the planned multi-family judge pool;
- both answer orders;
- repeat judge calls or captured repeats on a powered stratified subset;
- repeated candidate generations and semantic variants only on predeclared development models and items under the Development Probe Permit.

Estimate variance associated with model, question, category, judge family, answer order, prompt form, candidate generation and their important interactions.

Provisional targets requiring measurement-review approval:

- overall relative-ranking generalisability coefficient at least 0.90;
- each primary category at least 0.80;
- absolute-decision dependability at least 0.90 where meaningful;
- 95% interval half-width no larger than half the minimum practically meaningful difference;
- top-tier membership stable in at least 90% of cluster-bootstrap resamples.

If archived evidence cannot identify a required component, estimate it on the sacrificial Development Probe before the confirmatory freeze. Do not fabricate certainty from synthetic responses and do not tune using rank-bearing evidence.

### M4.6 Run simulation and power checks

Use simulated and archived score matrices to test:

- likely interval width;
- sensitivity to one dominant item;
- impact of judge severity;
- saturation and ceiling scenarios;
- negative-discrimination items;
- missing responses;
- number of models and repeats required;
- publication thresholds for Taste ratings.
- sample size and composition for Culinary JudgeBench;
- stability of Chef Consensus/Frontier/Horizon reporting;
- worst-of-n and pass-all-trials reliability;
- rank fragility and multiplicity;
- KitchenPlan validator error scenarios.
- authoring-provenance and responding-model-family interactions;
- general-score association and incremental-validity study power;

This tests the analysis design without calling new candidate models.

### M4.7 Fix infrastructure defects

- Explicit reviewed `current-run` pointer.
- Candidate → audited → released lifecycle.
- No preservation of stale judge scores after a prompt, item or panel change.
- Complete score/adjudication status tracking.
- Automated release checklist.
- Dataset and score validation in continuous integration.
- Confirm public code and data licences.
- Formal errata, quarantine, score-reissue and retirement workflow.

### M4.8 Protect the sealed bank and evidence lineage

- Separate validation and production credentials.
- Restrict and log access to sealed questions and keys.
- Record the data-retention/training terms of every external judge provider.
- Treat candidate answers as hostile input: strict boundaries, output limits, no execution of supplied code or links, and prompt-injection tests.
- Store raw answers and ballots append-only.
- Give every run, item, response and ballot a deterministic ID and idempotent retry key.
- Trace every published aggregate back through ballot, judge verdict, candidate answer, prompt, model settings and signed manifest.
- Treat a challenge-bank leak as an automatic no-go requiring rotation.

### M4.9 Keep IRT and adaptive testing in research mode

- Use transparent pass rates, item-total discrimination and influence diagnostics first.
- Investigate every non-positive-discrimination item for a bad key, ambiguity, judge failure or construct mismatch.
- Treat item-response models as exploratory unless model-fit, local-independence, multidimensionality and sample-regime checks support them.
- Do not publish one global latent “cooking ability” score from an unjustified unidimensional model.
- Do not use adaptive item selection for the v3 public rank.
- Adaptive testing may run only in shadow replay with known selection probabilities, content quotas, exposure caps, random audits and fixed confirmatory anchors.
- Adoption requires preregistered replay targets for score error, interval coverage and tier agreement.

### M4.10 Freeze the specificity analyses

**Archived descriptive analysis**

- Proceed only with exact, evidenced model-snapshot mappings.
- Because Claude could not supply a verified mapping from the OpenRouter routes to Arena snapshots, the current Arena comparison remains descriptive and may be omitted if mapping uncertainty makes it misleading.
- If reported, use the neutral label **general-score-adjusted CookingBench residual** and never rank models by it.

**Confirmatory incremental validity**

- Freeze the independent general-capability predictor before candidate inference.
- Freeze an untouched culinary-expert or Kitchen Outcome criterion that was not used to author, select, weight or tune the benchmark.
- Require cross-validated incremental prediction before making a culinary-specific validity claim.
- Report absolute culinary performance, shared general-capability variance and incremental validity separately.

### M4.11 Define inference units and cost gates

- Every estimate names its unit: candidate response, judge seat, unordered pair-task, order presentation, human rater-unit or raw ballot.
- Claude’s `$30` Legacy Shadow figure is a proposed cap, not a verified cost; prompt length, seats, retries and adjudication must be priced from the frozen manifest.
- If a design used 900 unordered pair-task units, three seats and both orders, it would create 5,400 judge verdicts. The `$60.82` figure is only an extrapolation from historical per-seat spend and excludes longer context, retry, calibration and human escalation.
- Sequence paid development by information value, but do not let a dimension-score separation eliminate pairwise evidence where close creative preference is the construct.
- A budget shortfall narrows the claim or design before evidence is opened; it never lowers a gate after results are seen.

## Deliverables

- Run-manifest specification.
- Frozen response protocol.
- Statistical analysis plan.
- Simulation and sensitivity report.
- Generalisability and reliability report.
- Release-state model.
- Errata, quarantine and score-reissue policy.
- Automated integrity and completeness checks.
- Specificity analysis protocol.
- Cost ledger with explicit inference and ballot units.

## Gate 4 — Complete when

- A historical or synthetic run can be reproduced from its manifest.
- Analysis code produces ties when evidence is inconclusive.
- Multiple-comparison and practical-significance rules are frozen.
- The pairwise unit, order design, adaptive estimator and treatment of tie, both-unacceptable and abstention are frozen.
- Simulations show the planned design can detect differences worth publishing.
- Every component estimable without fresh candidates meets its approved target. Components requiring fresh candidate outputs have a preregistered Development Probe test and must be resolved before Gate 6; none is deferred to rank-bearing evidence.
- IRT and adaptive testing cannot affect the v3 public rank.
- Stale scores cannot survive changed methodology.
- No run can be selected for the website without explicit reviewed release status.
- Zero unresolved high or critical integrity issues remain.
- Every published value has complete artifact lineage.
- The sealed holdout is sized and stratified before opening; one committed tranche will be opened once and retired after a material methodology change.

# Stage 5 — Redesign and validate the Taste Test

## Objective

Create an enjoyable public experience that collects cleaner preference evidence without pretending that readers literally tasted the food.

## Tasks

### M5.1 Freeze the measurement claim

Taste measures:

> Which safe, valid and comparably presented culinary proposal a person would rather cook, serve or eat after reading it.

It does not measure the actual cooked flavour.

### M5.2 Build the five-round Tasting Flight

- Choose Rescue, Flavour, Service or Surprise.
- Five numbered rounds, approximately three minutes.
- One short task and one task-specific judging question per round.
- Controlled 120–160-word responses or the same compact field budget.
- For flavour rounds, a matched sensory card: identity; aroma; balance; texture/temperature; bite progression/finish; likely failure/correction; deliberate restraint.
- For rescue or service rounds, an optional matched KitchenPlan/timeline view where it improves comprehension.
- Identical layout and semantic rendering.
- Model identities hidden until the entire flight ends.
- Clear progress, lightweight transitions, completion reveal, contribution summary and spoiler-free share.
- Delight must come from pace, clarity and reveal—not animation that obstructs comparison.

### M5.3 Improve ballot choices

Use:

- Choose A;
- Choose B;
- Equally good;
- Neither works;
- Not my area.

Do not conflate equally excellent with equally poor.

After the primary vote is locked, optionally ask one task-specific “why?” question using two or three bounded reason choices plus skip. The reason prompt must not influence the initial choice or become a substitute for the ballot.

### M5.4 Remove bias and accidental interaction

- Dedicated short-form Taste responses; no third-model summaries.
- Safety and hard-constraint prefilter.
- Model IDs held server-side until reveal.
- Signed, single-use, expiring ballots.
- Randomised side assignment.
- No repeated model or question within a flight.
- Both-seen and bounded-dwell signals.
- Native buttons, fieldset/legend semantics and a non-obstructive mobile decision bar.
- Reduced-motion and screen-reader support.

### M5.5 Validate with human usability sessions

Use authored and archived fixture responses, not a new model run.

Test:

- comprehension of the task;
- ability to compare both answers;
- accidental-vote rate;
- completion time;
- mobile reachability;
- tie/neither/not-my-area understanding;
- whether identity reveal changes subsequent choices;
- accessibility with keyboard and screen reader.

### M5.6 Freeze the Taste analysis

- Tie-aware preference model.
- Separate ratings by task axis before any overall.
- Control prompt, position and answer-length effects.
- Separate verified culinary professionals as a cohort.
- Report public and verified-professional cohorts separately.
- Preserve meaningful vote distributions and disagreement rather than forcing consensus.
- Set minimum ballot counts and precision thresholds through Stage 4 simulation before publishing ratings.
- Add consistency and identical-answer controls.
- Detect anomalous or abusive voting without collecting unnecessary personal data.
- Treat adaptive pair sampling, if used, as a known sampling design with the required statistical correction.
- Require a connected pairwise comparison graph and simultaneous uncertainty before publishing a model order.

## Deliverables

- Taste measurement statement.
- Tasting Flight interaction specification.
- Ballot and security specification.
- Usability-test report.
- Accessibility sign-off.
- Preregistered Taste analysis.
- Sensory-card and post-vote-reason specification.

## Gate 5 — Complete when

- At least 90% of usability participants complete a flight without assistance.
- No known accidental-vote path remains.
- Participants correctly distinguish tie, neither and abstain.
- Participants understand that the sensory card predicts rather than measures actual taste.
- Both responses are practically viewable on supported mobile sizes.
- Model identity is unavailable before a recorded decision.
- Ballot integrity is adequate and the planned comparison graph can support the intended claim.
- Accessibility review finds no blocking issue.
- The Taste claim and statistical model are approved.

# Stage 6 — Development Probe, Methodology Readiness Gate and v3.0 freeze

## Objective

Measure the last unidentified development components on sacrificial evidence, then decide whether CookingBench is ready for rank-bearing model inference.

## Tasks

### M6.1 Assemble the traceability pack

For every planned capability, show:

- its definition;
- question coverage;
- grader or judge mode;
- construct axis and evidence/task-mode mapping;
- verification state, reporting stratum and exposure state;
- human reviewer;
- validation evidence;
- KitchenPlan/interactive validator evidence where relevant;
- analysis treatment;
- public output.

### M6.2 Issue the Development Probe Permit

Only after Stages 1–5 pass their development gates:

- name predeclared development-only models, items and semantic variants;
- exclude every authoring/tuning model from clean confirmatory use on contacted items;
- freeze the manifest, settings, contact plan, analysis, cost cap, retry and abort rules;
- write to an isolated append-only `development-probe` root;
- label every output permanently non-rank-bearing;
- prohibit sealed-item contact, public sync and publication.

### M6.3 Run and close the Development Probe

Use only the permitted cells to:

- estimate candidate-generation variance at the provider-supported lowest-stochasticity setting;
- test semantic prompt robustness separately from byte-identical repeatability;
- test authoring provenance and provenance-by-responding-model-family effects;
- measure end-to-end completeness, cost and recovery behaviour;
- test judge repeatability separately on fixed answers;
- choose the official repeat and decoding protocol through the preregistered simulation.

If the probe exposes a material defect, repair it on development evidence, version the change and run only the minimum new development cells needed. Development outputs never become headline evidence.

### M6.4 Complete blinded end-to-end dry runs

Use random model aliases and keep the mapping with two authorised custodians.

**Dry run A — deterministic replay**

- Replay archived raw outputs through ingestion, grading, analysis and reporting twice.
- Require byte-identical results except declared timestamps and request IDs.
- Replay valid alternative KitchenPlans, invalid cycles, missing inputs, unsafe trajectories, resource conflicts and service-window failures.

**Dry run B — judge integration**

- Use captured verdicts or separately authorised calibration-only calls on archived/synthetic answers.
- Exercise A–B/B–A order, ties, both-bad, abstention and human escalation.

**Dry run C — fault injection**

- Inject malformed, missing, duplicated and oversized answers.
- Swap sides, expose a model name, corrupt a hash, use a stale judge version and simulate partial judge outage.
- Test retry idempotency, prompt injection and a sealed-bank access violation.
- Inject an exact-reference grader that rejects a different valid plan and require the test to fail.
- Require every fault to fail closed according to the runbook.

Do not inspect whether the blinded order “looks right.” Freeze the evidence before unblinding.

### M6.5 Run an independent red-team review

Attempt to break:

- safety grading;
- KitchenPlan false acceptance and false rejection;
- exact-reference grading that rejects unconventional valid plans;
- unsafe intermediate trajectories with superficially successful final states;
- historical references;
- unconventional-but-valid answers;
- judge prompt injection;
- position and length controls;
- provider-family fairness;
- sealed-bank access;
- missing-response handling;
- release-state controls;
- calibration-holdout leakage and repeated tuning;
- scenario-family and linking-anchor leakage;
- public claims.

### M6.6 Resolve every blocking issue

Classify issues:

- blocker;
- must fix before public release;
- monitored limitation;
- later enhancement.

No blocker may be waived for convenience or momentum.

### M6.7 Freeze the protocol

Version and commit:

- methodology v3.0;
- construct/evidence-layer crosswalk;
- KitchenPlan schema, validator and accessible render contracts;
- Interactive Kitchen state and observation format;
- question schema;
- admitted pilot item IDs;
- sealed item hashes;
- prompts and output contracts;
- judge panel and judge packs;
- calibration holdout;
- bank inventory, exposure states and release vintages;
- analysis plan;
- release thresholds;
- run budget and abort rules.

Any material change after the freeze cancels the pending run and creates v3.0.1 or v3.1 with a new review.

### M6.8 Issue a one-run Confirmatory Pilot Permit

The permit authorises exactly:

- one named model set;
- one committed execution;
- one frozen manifest;
- one cost ceiling;
- the preregistered retry and abort rules.

It expires after that execution, or immediately after any Class C/D change, model-version drift, bank-access incident or new critical finding.

## The hard no-go checklist

Do not run if any statement is true:

- The construct remains disputed, or weights remain disputed without an approved profile-only analysis.
- Legacy Shadow is incomplete, its findings remain unresolved, or its outputs are not demonstrably isolated from historical and rank-bearing evidence.
- The Development Probe has not closed every candidate-generation, repeat, provenance or end-to-end component needed by the claim.
- Any pilot item lacks required review or adversarial fixtures.
- Any rank-bearing item is still `Diagnostic only`, unresolved or Chef Horizon.
- A KitchenPlan validator has an unresolved false positive or false negative against an expert-verified fixture.
- An objective grader requires exact equality to one reference plan where multiple valid plans exist.
- Judge calibration fails a domain or safety threshold.
- The judge panel, prompt or retry policy was tuned against the sealed holdout.
- A sealed tranche has already been opened for the current methodology version.
- Any materially disputed item, pending score or unresolved judge flag remains in the scored set.
- Panel composition differs materially by candidate family without correction.
- Candidate or provider identity is visible to judges, or same-family judging lacks the approved independent audit.
- A flagged judgement has no adjudication route.
- The statistical analysis is not frozen.
- The planned design cannot estimate the declared minimum practically meaningful difference.
- Any component needed for sampling, reliability, ranking, acceptance or the declared claim remains unresolved after the Development Probe.
- A purportedly exploratory Stage 7 endpoint could affect item selection, eligibility, thresholds, weighting, analysis, acceptance or a later public claim.
- The run manifest cannot bind all artifacts.
- Compared models receive unequal tool, browsing, context, timeout, retry or failure-handling budgets.
- Model/API drift occurs inside the run window without the declared abort or bridge procedure.
- A nominally closed-book run retrieves a benchmark key, reference or materially equivalent answer.
- Sealed questions are accessible to candidate systems.
- The bank exposure, anchor, retirement or leak-response policy is incomplete.
- The expected response matrix is incomplete by design.
- Public claims exceed what the planned evidence can show.
- A human-level or professional claim lacks a matched expert baseline under the same task, output contract, tools and information conditions; any time-condition difference is not separately reported.
- A RecipeTables-like public visual is planned without the approved rights/attribution decision.
- Inference cost and abort conditions are unapproved.

## Deliverables

- Complete readiness dossier.
- Development Probe manifest, contact ledger and non-scoring report.
- Red-team report and resolutions.
- Dry-run and fault-injection evidence.
- Signed go/no-go checklist.
- Frozen v3.0 methodology tag and sealed-bank commitment.
- One-run Confirmatory Pilot Permit.

## Gate 6 — Complete when

All accountable reviewers sign their sections, the Development Probe and dry runs pass, and the independent release reviewer records **GO** and issues the one-run permit. This is the first point at which rank-bearing candidate inference is allowed.

# Stage 7 — Controlled v3 pilot

## Objective

Use the first rank-bearing inference only to validate the frozen design—not to launch a headline leaderboard.

## Scope

- The powered, stratified Craft bank selected from the Stage 3 archetypes and frozen scenario-family requirement.
- A separate validated Fundamentals Gate.
- The repeat count and decoding settings selected by the Development Probe and frozen in the manifest.
- A deliberately varied, power-supported set of exact model snapshots spanning weak, mid-range and frontier ability plus multiple provider families.
- Frozen judges, settings, analysis and release rules.
- Frozen item eligibility, task-family inclusion and Chef Consensus/Frontier/Horizon labels.
- One committed untouched tranche opened once.

## Tasks

### M7.1 Execute the frozen run

- Verify hashes before starting.
- Capture route, retry, cost and timing metadata.
- Abort on a manifest, provider-routing or completeness violation.
- Never substitute or repair a response invisibly.
- Log every candidate and judge contact and preserve all terminal failures.

### M7.2 Complete judging and adjudication

- Equivalent jury composition.
- A–B/B–A presentation for every rank-bearing pairwise comparison, or a separately powered preregistered random order audit.
- Human review of every critical disagreement.
- A stratified unflagged-answer audit sized from declared risk and precision requirements.
- No report while scores or adjudications remain pending.

### M7.3 Evaluate the items and methodology

Measure:

- saturation and all-perfect rate;
- item difficulty and discrimination;
- effective item count;
- reliability across repeated responses;
- judge–human and human–human agreement;
- position, length and provider-family effects;
- candidate-generation, question, judge, order and prompt-form variance;
- KitchenPlan validator false acceptance and false rejection;
- whether structured evidence reduces subjective judge variance;
- clarification precision: necessary questions asked and needless questions avoided;
- service-plan feasibility, state tracking and trajectory safety;
- contribution of every item and domain;
- ranking stability under sensitivity analyses;
- critical-failure frequency;
- cost and operational failure rate;
- chef-authored failure-taxonomy counts and representative step-level failure annotations.
- incremental prediction of the untouched culinary criterion beyond the frozen general-capability predictor.

Compare prose-only scoring with KitchenPlan-assisted scoring on the preregistered subset. The purpose is to learn whether structure removes judge noise without rejecting valid culinary diversity.

Inspect every item with:

- more than 95% pass or less than 5% pass;
- all-model pass or all-model failure;
- non-positive discrimination;
- excessive influence on a tier;
- unusually high judge disagreement;
- large provider-family or prompt-form effects.

### M7.4 Apply the frozen format gates

Evaluate the predeclared acceptance gates without changing the scored design.

- Do not promote, revise, retire or reclassify an item or task family inside the opened tranche.
- Keep the controlled pilot non-headline even if its frozen analysis produces an exciting provisional order.
- If removing one judge family or question family changes the supported leader or tier, prohibit a headline winner claim.
- Any observed-data change to item eligibility, reporting stratum, task-family inclusion, threshold, weighting, judge treatment or analysis is Class C: reclassify the entire tranche as Development and prohibit every score in it from supporting a rank or release.
- Record all failed attempts and the exact diagnosed defect.

## Frozen pilot acceptance targets

These candidate thresholds are finalised by Stage 4 power/reliability work and frozen at Stage 6 before the tranche opens:

- no more than 15% of Craft items perfect for every model;
- at least 80% of Craft items show positive discrimination;
- no unresolved negative-discrimination item;
- effective item count at least half the nominal Craft count;
- no single item contributes more than 5% of ranking variance;
- critical-fault recall at least 95% as a diagnostic, zero observed critical unsafe false accepts and no LLM-only safety acceptance;
- overall generalisability coefficient at least 0.90 and each primary category at least 0.80, or the affected rank is withheld;
- top-tier membership stable in at least 90% of cluster-bootstrap samples;
- interval half-width no greater than half the preregistered minimum meaningful difference;
- no unexplained judge-family, position or length effect outside the preregistered tolerance;
- A–B/B–A, identical-answer, padded-duplicate and superficial-style controls still meet Gate 2;
- every safety or large-score disagreement adjudicated;
- results stable under leave-one-item, family and category checks;
- no supported winner reversal after removing one judge family or question family;
- every rank-bearing KitchenPlan and Interactive Kitchen task passes its validator and trajectory audit;
- no incomplete model-by-task response cells;
- no public tier claim unsupported by the preregistered intervals.

## Deliverables

- Immutable pilot run.
- Expert-audit and adjudication log.
- Item and judge validation report.
- Generalisability, consistency and KitchenPlan validation report.
- Frozen-gate pass/fail report.
- Class C decision and full attempt disclosure if any design change is required.
- Recommendation on whether the unchanged protocol may advance.

## Gate 7 — Complete when

The pilot passes every frozen acceptance target without changing item eligibility, strata, task-family inclusion, thresholds, weights, judge treatment or analysis. Predeclared construct, wording, length, judge-composition and influence checks support the intended interpretation; the independent reviewer verifies those frozen checks rather than adding post-hoc discretion.

A statistical failure is terminal for that protocol and claim. An unchanged or cosmetically renamed protocol may not try another tranche. A fresh tranche requires a substantive diagnosed change, supporting development evidence, disclosure of every prior attempt, independent re-freeze and new preregistration.

# Stage 8 — Expand and launch the public v3 Chef Trials

## Objective

Turn the successful pilot formats into the first defensible public CookingBench release.

## Tasks

### M8.1 Expand only validated formats

- Grow only to the powered scenario-family and task count required for the declared public claims.
- Preserve fixed capability weights.
- Maintain scenario-family and cultural coverage.
- Re-run independent solve, expert, source and adversarial review for every new item.
- Maintain Public Core, timestamped Live releases, Chef’s Table Holdout and protected linking anchors.
- Keep the active sealed share and reserve large enough to support planned rotation.
- Launch Current Kitchen only as a separate dated and jurisdiction-specific track.

### M8.2 Repeat the readiness process

- Validate expanded judge packs.
- Re-run simulations.
- Freeze methodology and sealed hashes.
- Complete a second Stage 6 review for the full release.

### M8.3 Run the full candidate set

- Use the frozen repeat and decoding protocol.
- Complete Fundamentals Gate.
- Equivalent judge treatment.
- Full adjudication.
- Immutable candidate → audited → released workflow.

### M8.4 Publish evidence, not only a table

Publish:

- release vintage, methodology version and bank policy;
- Gate status and critical-failure rate;
- Craft axis scores;
- KitchenPlan, Interactive Kitchen and failure-mode profiles;
- Palate jury distributions;
- consistency curves, worst-of-n/pass-all-trials evidence and uncertainty;
- statistically supported tiers;
- head-to-head matrix;
- question evidence, rendered KitchenPlan and judge evidence explorer;
- judge card, automation coverage, escalation rate and leave-one-family sensitivity;
- item verification/reporting/exposure policy;
- cost and completeness ledger;
- methodology version and known limitations.
- visible repository, licence, citation and downloadable released-data links.

Public Taste remains a separate result and can launch alongside the evidence explorer.

### M8.5 Operate a rotation cycle

- Disclose a retired item only after it no longer contributes to any live result and disclosure will not expose an active scenario family.
- Never disclose linking anchors while they remain active.
- Replace a preregistered share for the next timestamped release.
- Maintain sealed anchors and a reserve pool.
- Monitor saturation and grader defects continuously.
- Re-audit the residual failure, high-disagreement and high-influence tail after every major model generation.
- Operate formal errata, quarantine, score-reissue and retirement procedures.
- Require readiness review for every methodology change.

### M8.6 Complete public identity and rights checks

- Resolve the CookBench/CookingBench naming and discoverability decision before public promotion.
- Confirm attribution and permission for any RecipeTables-like visual treatment.
- Make the distinction between **AI Chef Trials** branding and evidence-backed “best AI chef” claims visible.

## Deliverables

- CookingBench v3 public release.
- Evidence explorer and improved methodology pages.
- Five-round public Tasting Flight.
- Rotation and maintenance policy.
- Public judge card and bank-policy card.
- Immutable release tag and full artifact package.

## Gate 8 — Complete when

- All release gates pass.
- No unresolved adjudications or missing cells remain.
- The public site selects only the explicitly released run.
- Headline language matches the evidence.
- Cross-edition comparisons use protected bridge evidence or are explicitly reported as non-comparable vintages.
- Pairwise preference graphs are connected, manipulation checks pass and simultaneous intervals support every published order.
- Public identity and representation-rights decisions are complete.
- Reproduction instructions and known limitations are public.

# Stage 9 — Kitchen Outcome validation

## Objective

Measure whether finalist advice survives contact with ingredients, equipment, cooks and diners.

## Tasks

### M9.1 Design the cook-off

- Use six to ten representative recipes or rescue plans only as an initial design scaffold; final dish, cook, repetition and panel counts come from a preregistered power and coverage analysis.
- Standardise ingredients, equipment, budget and time.
- Randomise model-to-cook assignment.
- Anonymise instructions.
- Define allowed clarifications and record every intervention.
- Include enough repeated executions to separate instruction/model effects from cook, dish and service-session variability.
- Match cuisine, task, equipment and difficulty coverage to the breadth of the intended claim.

### M9.2 Measure execution

Record:

- safety temperatures;
- timings and holding;
- predicted versus observed KitchenPlan states, critical path and service windows;
- yield and waste;
- ambiguities and cook corrections;
- safety-invariant breaches, near misses and collateral damage;
- failure points;
- cook-rated clarity and practicality.

### M9.3 Blind-taste the food

Use trained and public panels where appropriate to score:

- flavour balance;
- aroma;
- texture;
- doneness;
- coherence;
- memorability;
- desire to eat again.

### M9.4 Analyse separately

Account for cook, dish and tasting-panel effects.

- Compare KitchenPlan predictions with observed timings, temperatures, state transitions, interventions and service outcomes.
- Estimate whether written Craft and Palate evidence predicts kitchen performance.
- Include an expert-authored or expert-directed baseline under the same ingredients, equipment, output contract, tools and information before making human-level or professional claims. Predeclare defensible cohort-specific time conditions; report unequal conditions separately rather than calling them fully matched.
- Publish Kitchen Outcome as a separate axis rather than retroactively blending it into a text benchmark.

## Deliverables

- Preregistered kitchen protocol.
- Cook and taster forms.
- Recorded execution log.
- Sensory and practicality analysis.
- Public Kitchen Outcome report.

## Gate 9 — Complete when

The study is reproducible, blinded, powered, adequately replicated and recorded, and its precision and culinary coverage support the intended claim after accounting for cook, dish and panel variability. Otherwise publish only **Kitchen Outcome winner in this trial**; do not generalise to “best AI chef.”

# Cross-stage ownership

**Canonical plan and protocol:** Codex owns this plan, the evidence gates, requirement identifiers, acceptance criteria and final protocol review.  
**Implementation:** Claude Opus 5 leads code changes through small reviewable branches or pull requests and raises conflicts rather than reinterpreting methodology silently.  
**Product authority:** Jordan owns the mission, product choices, external actions, inference permission and publication approval.  
**Independent evidence:** qualified humans own culinary, safety, cultural, baseline, usability and physical-sensory evidence that neither AI can self-certify.

Roles below are accountabilities, not a prescribed headcount. Agent teams may fill drafting, engineering, analysis and simulation roles in parallel. The required independent human evidence cannot be agent-filled.

| Workstream | Accountable role | Required independent review |
|---|---|---|
| Mission, claims and weights | Product/methodology lead | Culinary and measurement reviewers |
| Safety Gate | Food-safety lead | Independent safety reviewer |
| Food theory and technique | Culinary lead | Second culinary reviewer |
| Food history and context | History/culture lead | Relevant regional or subject reviewer |
| KitchenPlan and state model | Procedural-semantics lead | Culinary, safety and accessibility reviewers |
| Judge system | Judge-system lead | Culinary and measurement reviewers |
| Judge calibration holdout | Independent calibration custodian | Measurement and culinary reviewers |
| Statistics | Measurement lead | Independent statistical reviewer |
| Question bank | Benchmark editor | Relevant subject reviewers |
| Sealed-bank custody | Independent bank custodian | Release reviewer |
| Taste Test | Product/UX lead | Accessibility and measurement reviewers |
| Rights, attribution and naming | Product owner | Independent legal/naming review where required |
| Run infrastructure | Engineering lead | Independent release reviewer |
| Public release | Product owner | All accountable leads |

# Implementation work packages

Use dedicated non-production `v3/*` integration branches from a pinned base commit. “Merge WP-0” means acceptance on that integration branch; do not merge into a production-watched branch or allow an automatic production deployment. Default-branch, Vercel production-branch and deployment changes are separate approved administration actions. A code merge does not authorise inference, live data writes or deployment.

## WP-0 — Evidence firewall and provenance controls

This is the mandatory first merge. It contains no model calls, judging, re-scoring or production writes.

- Add the six eligibility classes `historical`, `legacy-shadow`, `development`, `development-probe`, `confirmatory-pilot` and `public-release`.
- Store `artifactOrigin` and `releaseState` as orthogonal fields; synthetic and mock artifacts remain Development evidence.
- Require a versioned hashed manifest containing methodology version, evidence eligibility, code commit, bank and prompt hashes, model routes, provider/base-family identities, judge pool, settings, call plan, retry policy, budget cap and parent artifacts.
- Make historical runs immutable; every new execution writes to a new isolated run ID and output root.
- Deny candidate, judge and network execution by default.
- Refuse sync, publish and ranking for every non-release artifact.
- Disable the existing `bench pilot` for v3.
- Implement the full permit contract and capability checks defined under Evidence classes and permits.
- Inventory and firewall every current writer/network route below the CLI, including run/config merge, grade, judge, report, analyze, dataset/run sync, publish, pilot, Taste archive, provider execution and catalog/cost checks.
- Turn rank-bearing configuration drift into hard failures.
- Replace check-then-record budgets with atomic reservations.
- Enforce judge conflicts by provider and underlying base-model family.
- Add negative tests for historical overwrite, Shadow candidate calls, development publication, mixed settings and concurrent overspend.
- Prove that released historical v2 remains visible and that a presentation erratum cannot alter score hashes.

WP-0 owns the immutable execution-envelope, evidence/release, permit and firewall manifest fields. WP-1 may extend the envelope with referenced v3 domain-contract hashes but cannot redefine those core controls.

## WP-1 — Versioned data contracts

- Add v3 schemas alongside backward-compatible v1/v2 readers.
- Define Question v3, KitchenPlan, candidate response, deterministic finding, judge verdict, human label, pairwise ballot, run manifest, contact ledger and release record.
- Record scenario family, construct, evidence layer, reporting stratum, locale, safety jurisdiction, authoring provenance, reviewer certifications, exposure and rank eligibility.
- Represent safety failures non-compensatorily.
- Keep `A`, `B`, `substantive_tie`, `both_unacceptable` and `abstain` distinct.
- Store raw seat outputs, transformed scores and adjudications separately and append-only.
- Add sealed-bank hash commitments and historical compatibility tests.

## WP-2 — Offline validators and adversarial fixtures

- Validate cross-field constraints, units, tolerances, rubric weights, KitchenPlan dependencies, locale/safety keys, family conflicts and manifest completeness.
- Add valid-technique, unsafe, both-bad, abstention, malformed-output, prompt-injection and scorer-invariance fixtures.
- Test correct, unconventional-valid, polished-wrong and failing responses without contacting models.
- Prevent development or agent-authored fixtures from being mistaken for certified rank-bearing items.
- Provide deterministic replay and fault injection.

## WP-3 — Protocol-safe runners

- Give Legacy Shadow, Development Probe and rank-bearing execution distinct commands and output roots.
- Inject network clients so continuous integration and ordinary development use mocks.
- Record every attempted model–item contact, route, retry, token count, cost and terminal state.
- Make resume behaviour idempotent and refuse partial or mixed-protocol publication.
- Bind decoding, repeat policy and transport-failure treatment to the manifest.
- Require a named permit for any non-mock execution.

## WP-4 — JudgeBench and judging modes

- Implement blinded fault, dimension and pairwise judging.
- Carry declared rubric weights into the versioned judging prompt and score transform exactly once; test that named weights are neither dropped nor double-applied.
- Apply non-compensatory safety caps.
- Preserve aliases, order presentation, seat verdicts, judge identity, disagreement and adjudication history.
- Support canonical order swaps, common anchors, both-unacceptable and abstention.
- Build accuracy, coverage, alpha, severity and invariance reports against human-labelled JudgeBench strata.
- Keep development calibration separate from the sealed release holdout.
- Prevent model-labelled data from certifying the jury.

Once the prompt, transform and manifest are frozen, this package may execute the bounded Legacy Shadow. Its output remains permanently non-scoring.

## WP-5 — Statistical and simulation machinery

- Implement scenario-clustered uncertainty and repeated-generation reliability.
- Add item influence, leave-one-family-out, provenance and judge/order-effect analyses.
- Apply declared multiplicity correction.
- Implement tie-aware pairwise analysis with forced exploration, common anchors, retained selection probabilities and stopping-rule simulation.
- Test known-answer synthetic data, disconnected graphs, duplicate ballots and informative missingness.
- Require exact replay from manifest, seed and committed inputs.

## WP-6 — Question-bank workflow

- Support broad authoring at two to three times the powered bank requirement.
- Track detailed human/agent provenance and every development exposure.
- Require blind independent solving, two-reviewer certification and relevant specialist approval.
- Support matched-human and selected expertise-gap studies.
- Compare authoring provenance only on sacrificial development evidence.
- Freeze development and sealed banks before relevant model contact.
- Never admit an item because selected models disagree or fail.

## WP-7 — Tasting Flight and recipe presentation

- Build against synthetic and archived fixtures until measurement gates pass.
- Render KitchenPlan as a TRN-inspired accessible dependency table while retaining graph, schedule and text views.
- Render candidates identically and safely; formatting style must not reveal identity.
- Support balanced assignment, blinded aliases, order randomisation, tie, neither and abstain.
- Capture session/task clusters and cohort eligibility.
- Keep general-public and verified-professional evidence separate.
- Replace the historical three-outcome/phantom-opponent Taste model for v3.

## WP-8 — Permitted development execution

**Legacy Shadow**

- archived answers only;
- frozen rejudging manifest and cost cap;
- append-only output;
- no leaderboard eligibility.

**Development Probe**

- only after construct, question, judge, output-contract and integrity gates;
- sacrificial development-only models, items and variants;
- fixed manifest, cap and contact ledger;
- no rank or release claim.

Use these outputs to find protocol defects, estimate generation variance, test paraphrase robustness and rehearse recovery. A material method change keeps all contacted evidence in development and requires a new freeze.

## WP-9 — Confirmatory pilot, release and deployment

- Freeze the bank, prompts, routes, judges, settings, exclusions, estimators, thresholds and permitted claims.
- Open one committed untouched tranche once.
- Treat statistical failure as terminal for that protocol/claim; a new tranche requires a substantive diagnosed change, development evidence, full attempt disclosure, independent re-freeze and new preregistration.
- Require independent protocol review and a complete evidence ledger before publication.
- Preserve v2 and publish v3 as a distinct methodology version.
- Permit Supabase migration, live sync, Vercel deployment and public ranking only from the reviewed release commit and approved `public-release` manifest.

## Safe sequencing

1. Freeze Revision 3 and its requirement identifiers.
2. Complete, review and accept WP-0 on the non-production integration branch.
3. Complete and accept WP-1 on the same protected integration path.
4. Build WP-2 through WP-7 in parallel with mocks, synthetic fixtures and archived read-only data.
5. Run Legacy Shadow only after its judging contract and manifest are frozen.
6. Complete human question, baseline and JudgeBench gates.
7. Issue the Development Probe Permit and execute the minimum WP-8 cells.
8. Freeze the confirmatory protocol.
9. Execute WP-9 and deploy only after every release gate passes.

## Continuous verification

Continuous integration is secret-free and network-free by default. It covers:

- schema and historical compatibility;
- unit, property and golden-fixture tests;
- evidence-firewall and publication-denial tests;
- concurrent budget and retry tests;
- provider/base-family conflict tests;
- deterministic replay and artifact hashes;
- statistical simulations and failure modes;
- isolated database migrations;
- accessibility and ballot flows.

Paid provider tests, live Supabase writes and production deployments require separate manual approval.

## Methodology-to-code traceability

Assign stable identifiers such as `CONSTRUCT-*`, `DATA-*`, `JUDGE-*`, `SAFETY-*`, `STATS-*`, `UX-*` and `RELEASE-*`.

Maintain a machine-validated traceability file mapping every mandatory requirement to:

- methodology text;
- implementing code path;
- validating tests;
- manifest fields;
- evidence gate and owner.

Every rank-affecting pull request cites the relevant identifiers and declares whether it changes measurement semantics. Continuous integration fails on an untested mandatory requirement or undocumented rank-affecting rule. Every run manifest records the methodology hash, traceability version and exact Git commit.

# Immediate backlog

These are the first tasks to open:

1. Claude implements WP-0 Evidence Firewall and Offline Harness on a non-production integration branch; Codex reviews it against M0.0/WP-0 acceptance. Full Gate 0 closes separately.
2. Create the methodology decision, traceability, research/evidence, known-issues and risk registers.
3. Preserve v2.1, issue the factual presentation erratum and freeze the Legacy Shadow manifest.
4. Start the human-evidence workstream: culinary, food-safety, history/culture, KitchenPlan, measurement, baseline and usability recruitment.
5. Implement WP-1 versioned schemas and historical compatibility tests.
6. Freeze the evidence-layer/construct crosswalk, task universe, specificity study and public claims ladder.
7. Build KitchenPlan schema, state taxonomy, validator fixtures and accessible render proof.
8. Finalise item, atomic-rubric, judge-pack, sensory-dossier and provenance schemas.
9. Author JudgeBench and question candidates at two to three times the powered requirement; do not seal a fixed count before precision analysis.
10. Specify the human-baseline, expertise-gap, generalisability, power and sealed-holdout protocols.
11. Build WP-2 through WP-7 in parallel with mocks, synthetic fixtures and archived read-only evidence.
12. Run Legacy Shadow only after WP-0 and the shadow judging manifest pass review.
13. Resolve representation rights and CookBench/CookingBench naming.
14. Issue no Development Probe or rank-bearing permit until its evidence gate passes.

# Independent external review brief

External reviewers are asked to challenge this final plan, not endorse its ambition. A useful review addresses:

1. **Construct validity:** Do the proposed axes and task universe measure culinary-assistant competence, or do they omit an important construct or double-count flavour, planning or execution?
2. **KitchenPlan:** Is the proposed state/dependency representation rich enough to catch real culinary failure while allowing genuinely different valid plans?
3. **Question quality:** Does independent blind solving plus expert review sufficiently separate difficulty from ambiguity, trivia and bad keys?
4. **Question volume:** Does the powered scenario-family design support the proposed pilot inferences once clustering and repeated responses are accounted for?
5. **Judge design:** Is the deterministic → A/B and B/A jury → human escalation cascade appropriate, and where should automation coverage be lower?
6. **Judge holdout:** Is each sealed stratum powered, operationally realistic and resistant to repeated tuning?
7. **Safety:** Are the hard caps, zero unsafe false-accept rule and no-LLM-only route sufficient without making the grader reject safe alternative techniques?
8. **Statistics:** Are the generalisability, bootstrap, multiplicity, influence and practical-significance plans adequate for the frozen model set?
9. **Aggregation:** Should CookingBench publish only a multi-layer scorecard, or can a Craft summary tier be justified without collapsing incompatible evidence?
10. **Freshness and contamination:** Are Public Core, dated Live releases, Chef’s Table Holdout, linking anchors and retirement sufficient for an exposure-reduced living benchmark?
11. **Human evidence:** Are independent solving, JudgeBench, matched baselines, expertise-gap studies and adjudication adequately powered without compromising expertise or diversity?
12. **Taste Test:** Does the Tasting Flight collect a clean blind answer preference while remaining enjoyable enough to attract sustained participation?
13. **Kitchen Outcome:** What minimum matched expert baseline and physical study would justify moving from “culinary AI” to “AI chef”?
14. **Naming and rights:** Is the proposed response to CookBench similarity and Cooking for Engineers/RecipeTables inspiration proportionate?

For every point, the reviewer should return:

- `AGREE`, `CHANGE`, `REJECT` or `UNCERTAIN`;
- the concrete reason;
- primary evidence or a clearly labelled inference;
- replacement wording or an executable alternative for every `CHANGE` or `REJECT`;
- whether the issue blocks Stage 6;
- any new test that would resolve uncertainty.

An external finding changes the plan only through the decision log. Every accepted material change reopens the affected gates and receives new traceability identifiers.

# Master definition of done

CookingBench is ready for a rank-bearing model batch only when:

- the mission and claims are approved;
- the capability model and weights are frozen;
- KitchenPlan and Interactive Kitchen constructs, validators and accessible views are approved;
- food theory, history, lateral reasoning and problem-solving have valid applied task formats;
- every rank-bearing pilot item has a blind independent solve, sources, judge pack, atomic rubric and adversarial fixtures;
- no rank-bearing item is Diagnostic only or Chef Horizon;
- judges pass held-out calibration and safety thresholds;
- JudgeBench gold evidence comes from independent qualified humans rather than model consensus;
- safety has no LLM-only acceptance route;
- every disagreement has an adjudication route;
- repeat sampling, generalisability, uncertainty and influence analysis are preregistered;
- the Development Probe has fixed the repeat/decoding protocol and closed the authoring-provenance risks on development-only evidence;
- the specificity predictor and untouched culinary criterion are frozen;
- Public Core, Live, Chef’s Table, anchors and retirement have complete controls;
- run artifacts are immutable and reproducible;
- one sealed tranche is committed for one opening, with retirement required after a material methodology change;
- Taste Test measurement and interaction are validated;
- the planned result cannot silently collapse Gate, Craft, Answer Preference and Kitchen Outcome into one number;
- an independent reviewer signs the Stage 6 go decision.

Until then, the correct project status is **methodology development**, not **leaderboard refresh**.

# Research foundations

## Benchmark construction, freshness and verification

- Arora et al., [HealthBench](https://arxiv.org/abs/2505.08775)
- White et al., [LiveBench](https://arxiv.org/abs/2406.19314)
- Center for AI Safety et al., [Humanity’s Last Exam](https://www.nature.com/articles/s41586-025-09962-4)
- Zhai et al., [HLE-Verified](https://arxiv.org/abs/2602.13964)
- Rein et al., [GPQA](https://arxiv.org/abs/2311.12022)
- OpenAI, [Why SWE-bench Verified no longer measures frontier coding capabilities](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)
- Vendrow et al., [Do Large Language Model Benchmarks Test Reliability?](https://arxiv.org/abs/2502.03461)

## Cooking procedure, state and interaction

- Nevens et al., [A Benchmark for Recipe Understanding in Artificial Agents](https://aclanthology.org/2024.lrec-main.3/)
- Diallo et al., [PizzaCommonSense](https://arxiv.org/abs/2401.06930)
- Wu et al., [Recipe2Plan](https://arxiv.org/abs/2503.02238)
- Ivanova et al., [AmbiK](https://arxiv.org/abs/2506.04089)
- Yagcioglu et al., [RecipeQA](https://arxiv.org/abs/1809.00812)
- Jiang et al., [CookDial](https://arxiv.org/abs/2206.08723)
- Toyooka et al., [Ingredient States Annotation for State Probing](https://arxiv.org/abs/2507.17232)
- Cai et al., [CookBench](https://arxiv.org/abs/2508.03232)
- Xie et al., [OSWorld](https://arxiv.org/abs/2404.07972)
- Yao et al., [τ-bench](https://arxiv.org/abs/2406.12045)

## Judging and preference measurement

- Zheng et al., [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685)
- Chiang et al., [Chatbot Arena: An Open Platform for Evaluating LLMs by Human Preference](https://arxiv.org/abs/2403.04132)
- LMArena, [Arena Explorer](https://oldblog.lmarena.ai/blog/2025/arena-explorer/)
- Dubois et al., [Length-Controlled AlpacaEval](https://arxiv.org/abs/2404.04475)
- Verga et al., [Replacing Judges with Juries](https://arxiv.org/abs/2404.18796)
- Shi et al., [A Systematic Study of Position Bias in LLM-as-a-Judge](https://arxiv.org/abs/2406.07791)
- Liu et al., [JudgeBench](https://arxiv.org/abs/2410.12784)
- Zeng et al., [LLMBar](https://arxiv.org/abs/2310.07641)
- Feuer et al., [SOS-Bench](https://arxiv.org/abs/2409.15268)
- Hughes, [Krippendorff’s alpha for multiple raters, levels of measurement and missingness](https://arxiv.org/abs/2103.12170)

## Reliability and sampling

- Brennan, [Elements of Generalizability Theory](https://doi.org/10.1111/j.1745-3992.1992.tb00260.x)
- Kossen et al., [Active Testing](https://proceedings.mlr.press/v139/kossen21a.html)
- [Can We Trust Item Response Theory for AI Evaluation?](https://arxiv.org/abs/2607.15190)

## Recipe representation inspiration

- [RecipeTables](https://recipetables.com/)
- Michael Chu, [Cooking for Engineers](https://www.cookingforengineers.com/)
- Michael Chu, [Recipe Summaries – Standards and Microsoft](https://mx.cookingforengineers.com/article/29/Recipe-Summaries-Standards-and-Microsoft)
- [Cooklang specification](https://cooklang.org/docs/spec/)
- [Schema.org Recipe](https://schema.org/Recipe)
