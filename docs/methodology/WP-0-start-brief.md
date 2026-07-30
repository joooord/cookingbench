# CookingBench — Claude implementation start brief

## Authority

Implement against `CookingBench-methodology-first-master-plan.md`, Revision 3.

- Plan and protocol owner: Codex.
- Implementation lead: Claude Opus 5.
- Product and external-action authority: Jordan.
- Pinned historical base reviewed during planning: commit `980dfcb5e3ff920fe1a3231121a6115e3fa48dcb`.
- Canonical Revision 3 plan SHA-256: `2f9e63a1ce08cadb2ddfbd64696a5d6b2f31e69fc1886bb3944007052d8a727d`.

Before implementation, copy the byte-identical canonical plan and its checksum sidecar into the repository’s methodology documentation. A plan change requires a decision-log entry, a new digest and review of every affected requirement.

This brief authorises code preparation only. It does not authorise model calls, judge calls, Supabase writes, Vercel deployment, default-branch changes or publication.

Develop and review WP-0 on a non-production `v3/*` integration branch. Do not merge into a branch watched for production deployment, and suppress or separately approve any automatic Vercel build/deployment path.

## First package

**WP-0 — Evidence Firewall and Offline Harness**

WP-0 must merge and pass independent review before Legacy Shadow, historical presentation changes that touch release code, or any v3 execution work.

## Requirements

### `RELEASE-001` — Evidence classes

Represent:

- `historical`;
- `legacy-shadow`;
- `development`;
- `development-probe`;
- `confirmatory-pilot`;
- `public-release`.

Every run and derived artifact has exactly one class.

Store two orthogonal fields:

- `artifactOrigin`: for example `archived`, `human`, `agent-authored`, `transformed-archive`, `synthetic`, `mock` or `live-provider`, with lineage;
- `releaseState`: `draft`, `audited`, `released`, `quarantined` or `retired`.

Synthetic and mock artifacts remain Development evidence. Origin never upgrades eligibility.

### `RELEASE-002` — Publication eligibility

- Only an approved `public-release` manifest in `releaseState: released` may create a new public result or ranking.
- Every other class fails closed with a clear error.
- `legacy-shadow` and `development-probe` surfaces display **NON-SCORING — NOT FOR LEADERBOARD**.
- Existing v2.1 remains `evidenceClass: historical`, `releaseState: released` and may remain publicly visible.
- A reviewed presentation-only erratum may update historical labels and explanatory metadata only when candidate, ballot and score hashes remain unchanged.

### `DATA-001` — Historical immutability

- Existing v1/v2 run artifacts are read-only inputs.
- No command overwrites their response, score, config, cost or report files.
- Derived work uses a new run ID and isolated output root.
- Golden hashes prove v2.1 remains unchanged.

### `DATA-002` — Versioned manifest

Require and hash:

- methodology and schema versions;
- Git commit;
- evidence class and rank eligibility;
- artifact origin and release state;
- parent artifacts;
- item/bank, prompt, judge and validator hashes;
- candidate and judge model routes;
- provider and underlying base-model family;
- generation settings and repeat policy;
- call plan, retry and abort policy;
- budget cap;
- output root.

WP-0 owns this immutable execution envelope. WP-1 may add referenced v3 domain-contract hashes and schemas, but it must not redefine the firewall, permit or release fields.

### `RUN-001` — Deny-by-default execution

- Candidate, judge and network execution are disabled without a valid named permit.
- Continuous integration and normal development use injected mocks.
- Shadow cannot call candidates.
- The current `bench pilot` is disabled for v3.

The permit contract contains:

- immutable permit ID and kind;
- approved manifest and methodology hashes;
- explicit capabilities: catalog read, candidate inference, judge inference, development database write, live database write, presentation erratum, result sync and publication;
- exact model–item or judge–answer cells;
- budget cap and reservation scope;
- issuer, independent approver and approval evidence;
- single-use/execution limit, validity condition, revocation state and mechanism;
- cryptographic or server-side verification that cannot be replaced by a local boolean.

Enforcement sits beneath CLI commands so every entry point shares the same policy.

### `RUN-001A` — Bypass-path inventory

- Inventory every writer and network route before calling the firewall complete.
- Cover `run` and configuration merging, `grade`, `judge`, `report`, `analyze`, dataset sync, run sync, `publish`, `pilot`, `taste-archive`, OpenRouter execution and catalog/cost checks such as `models --check` and `estimate`.
- Add parameterised denial tests at the shared enforcement layer, not only command-specific tests.

### `RUN-002` — Protocol consistency

- A resumed run must preserve all rank-affecting settings and hashes.
- Mixed routes, prompts, banks, settings or methodology versions fail rather than warn.
- Retry IDs are deterministic and idempotent.

### `BUDGET-001` — Atomic reservations

- Replace check-then-record budget handling with atomic reservation and settlement.
- Concurrent requests and retries cannot exceed the manifest cap.
- Failed and cancelled reservations have explicit terminal states.

### `JUDGE-001` — Conflict identity

- Record both provider and underlying base-model family.
- A conflict check covers either shared identity.
- Missing family identity cannot silently count as conflict-free.

### `TRACE-001` — Requirement traceability

Create a machine-validated mapping from requirement ID to:

- canonical-plan section;
- implementation path;
- tests;
- manifest fields;
- gate and owner.

## Mandatory tests

WP-0 is incomplete until automated tests prove:

1. a historical artifact cannot be overwritten;
2. Shadow cannot invoke candidate generation;
3. development evidence cannot sync, publish or rank;
4. an unapproved manifest cannot use network clients;
5. mixed settings cannot share a run ID;
6. concurrent calls cannot overspend;
7. retry/resume is idempotent;
8. provider and base-family conflicts are detected;
9. v1/v2 readers still reproduce published artifacts;
10. the already released historical board remains viewable while an erratum cannot change score hashes;
11. every inventoried writer/network route is denied or capability-checked by the shared enforcement layer;
12. continuous integration runs without secrets or network access.

## Explicit non-goals

Do not include:

- model or judge calls;
- external network calls during acceptance tests;
- Legacy Shadow execution;
- v2 re-scoring;
- new question content;
- rubric, prompt or scoring-semantic changes;
- pairwise ranking implementation;
- KitchenPlan design;
- Supabase or production database writes;
- Vercel deployment;
- automatic default-branch or production-branch changes.

## Handoff back to Codex

Return:

- branch or pull-request reference;
- requirement-to-code mapping;
- changed-file summary;
- test commands and results;
- golden historical hashes;
- any unresolved implementation conflict;
- explicit confirmation that no network, live-data or deployment action occurred.

Codex will review WP-0 against the dedicated M0.0/WP-0 acceptance requirements above. Full Gate 0 closes separately after its roles, erratum, governance and rights tasks. Any methodology ambiguity is resolved in the decision log before the affected code continues.
