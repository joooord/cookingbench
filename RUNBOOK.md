# CookingBench runbook — the permit-gated pipeline

This describes the pipeline **as the code actually enforces it today**. Every
command below was read off `packages/runner/src/cli.ts` and the modules it
calls; where something is not wired, or is wired differently from what the plan
asks for, it says so rather than describing the intention.

The previous runbook described a workflow that no longer exists — `bench run
--budget --models …` with no manifest and no permit. Following it now produces
nothing but refusals. A runbook that does not match the code is worse than
none: it teaches an operator to read a correct refusal as a broken tool.

> **Nothing in this document has been executed against a live provider.**
> WP-0 authorises code preparation only: no model calls, no judge calls, no
> Supabase writes, no deployment, no publication. The offline loop in
> Appendix A is the only part that can be run today, and the only permits in
> the repository are deliberately unusable fixtures.

---

## 0. The shape of an authorised run

Nothing dangerous happens without three things existing at once:

| Thing | What it fixes | Where it lives |
| --- | --- | --- |
| **Manifest** | *what* will run: items, routes, caps, evidence class, content hashes | `data/runs/<run-id>/manifest.json` (immutable once written) |
| **Permit** | *that a human approved exactly that*, cryptographically | a file you pass with `--permit`; signed offline |
| **Ledger** | *that spend cannot exceed what was approved* | `data/runs/<run-id>/spend.ndjson` |

The permit binds the manifest **by hash**, and the manifest names the run, so
an approval cannot migrate to a different run, a different item set, a different
model roster or a larger budget. Verification takes **no** keyring, revocation
or clock parameter: a caller cannot choose what it is checked against.

Order of work, once per run:

```
manifest  →  permit (offline, human)  →  estimate  →  run  →  grade
          →  judge  →  report + analyze  →  register  →  audited
          →  release checklist  →  released  →  current pointer  →  (sync/publish)
```

Everything up to `estimate` is free. Everything from `run` onwards costs money
or touches live data, and every one of those commands refuses without
`--permit` and `--manifest`.

> **Pass `--permit` and `--manifest` as ABSOLUTE paths.** `pnpm bench` runs the
> CLI with its working directory set to `packages/runner/`, and a relative path
> is resolved against that, not against the repository root. A repo-relative
> path fails with `No manifest at …/packages/runner/data/…`, which reads like a
> missing file rather than a wrong directory. Every example below uses `$PWD`
> from the repo root for that reason.

---

## 1. Key ceremony — offline, human, once

The signing key is the only thing standing between the runner and spending
money. If it were reachable by CI, by the runner, or by an agent working in
this repository, the system that enforces approval could approve itself.

**On a machine this repository cannot see:**

```sh
openssl genpkey -algorithm ed25519 -out cookingbench-permit-2026.key   # never leaves that machine
openssl pkey -in cookingbench-permit-2026.key -pubout -out cookingbench-permit-2026.pub
```

Commit **only** the public half, as `data/permits/keys/<keyId>.pub`. The `keyId`
is the filename stem and must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$` — it is
validated, not sanitised, because it is used as a path component.

Also required, and easy to forget:

- `data/permits/revoked.json` must exist. Verification **fails closed** if the
  revocation list is missing — an absent list is not "nothing is revoked".
- `data/permits/keys/wp0-fixture-2026-07.pub` is a **fixture** key whose private
  half was destroyed. Delete it once a real approver key is committed; a keyring
  should hold approvers, not props.
- CI refuses to run if any `*.key`/`*.pem` or PEM private-key block is
  committed. That check is in `.github/workflows/ci.yml` and is not advisory.

To withdraw an approval mid-run, add its `permitId` to `data/permits/revoked.json`.
Expiry and revocation are re-checked every time authority is *exercised*, not
only when the permit was loaded, so a long run stops as soon as the withdrawal
lands.

---

## 2. Freeze the manifest

Write a draft (JSON). This is the only place an operator states what the run is;
after this it is frozen.

```jsonc
{
  "manifestVersion": 1,
  "runId": "2026-08-v3",
  "methodologyVersion": "v3.0",
  "schemaVersion": "1",
  "gitCommit": "f6bb16d",                    // the tree this run executes from
  "parentArtifacts": [],
  "evidenceClass": "confirmatory-pilot",     // see the table below
  "artifactOrigin": ["live-provider"],
  "releaseState": "draft",
  "rankEligible": true,                      // must agree with evidenceClass
  "candidateRoutes": [
    { "modelId": "anthropic/claude-opus-5", "provider": "anthropic", "baseModelFamily": "claude-opus-5" }
  ],
  "judgeRoutes": [
    { "modelId": "anthropic/claude-opus-4.8", "provider": "anthropic", "baseModelFamily": "claude-opus-4.8" },
    { "modelId": "openai/gpt-5.5", "provider": "openai", "baseModelFamily": "gpt-5.5" },
    { "modelId": "x-ai/grok-4.5", "provider": "xai", "baseModelFamily": "grok-4.5" }
  ],
  "generationSettings": {
    "temperature": 0, "maxTokens": 16000, "maxTokensRecipe": 32000,
    "repeats": 1, "repeatPolicy": "single"
  },
  "callPlan": { "concurrency": 4, "maxAttempts": 3, "abortOn": [] },
  "budgetCapUsd": 40
}
```

Then freeze it. The item set comes from the same selectors `estimate` uses, and
whatever you choose here is what the run may touch:

```bash
pnpm bench manifest --run-id 2026-08-v3 --draft "$PWD/drafts/2026-08-v3.json"
# add --tier active | --limit N | --questions qty-004,safe-021 to narrow the bank
# --draft is resolved against packages/runner too — same trap as --permit.
```

What the command does, and why each part matters:

- computes `bankHash`, `promptHash`, `judgePromptHash` and `validatorHash` from
  the real dataset and the real grader sources. If your draft **declares** one
  of them and it disagrees, the command refuses — declared hashes are checked,
  never corrected, because silently fixing a wrong belief about which bank is
  running is how a run comes to measure something else;
- derives `outputRoot` from the run id;
- writes `manifest.json`, `manifest-digest.json` (the item ids and per-file
  validator digests) and `manifest.sha256`;
- is idempotent for an identical envelope and **refuses a different one for the
  same run id**. There is no revising a manifest: derive a new run.

It prints the manifest hash. That hash — also in
`data/runs/<run-id>/manifest.sha256` — is what the permit must name. Do not
hash the draft file: unknown keys are stripped at parse, so the draft and the
stored manifest are not the same bytes.

**Evidence class decides what the run can ever become** (`RELEASE-001/002`):

| Class | Ranks? | Publishable? |
| --- | --- | --- |
| `historical` | already ranked (v1/v2) | remains visible; immutable |
| `legacy-shadow` | never | never — surfaces show **NON-SCORING — NOT FOR LEADERBOARD** |
| `development`, `development-probe` | never | never |
| `confirmatory-pilot` | yes | not directly |
| `public-release` | yes | the only publishable class |

Origin never upgrades eligibility: a `synthetic` or `mock` origin cannot appear
on a rank-eligible manifest at all.

---

## 3. Mint and sign the permit — offline

A permit is a JSON envelope: the body, a detached Ed25519 signature over the
**canonical JSON** of that body (keys sorted recursively, as
`canonicalJson()` in `packages/core/src/evidence.ts` produces), and the key id.
Plain `JSON.stringify` uses insertion order and will produce a signature that
does not verify.

```jsonc
{
  "permit": {
    "permitVersion": 1,
    "permitId": "cb-2026-08-v3-run-0001",          // 8–64 chars of [A-Za-z0-9._-]
    "kind": "confirmatory-pilot",
    "manifestHash": "<the hash bench manifest printed>",
    "methodologyHash": "<contents of docs/methodology/…-master-plan.sha256>",
    "capabilities": ["candidate-inference"],
    "cells": [ { "modelId": "anthropic/claude-opus-5", "questionId": "qty-004" } ],
    "budgetCapUsd": 40,
    "reservationScope": "call",
    "issuer": "Jordan",
    "approver": "<the second human who reviewed it>",
    "approvalEvidence": "<where that review is written down>",
    "notBefore": "2026-08-01T00:00:00Z",
    "notAfter":  "2026-08-03T00:00:00Z",
    "executionLimit": 1
  },
  "signature": "<base64 Ed25519 over canonicalJson(permit)>",
  "keyId": "cookingbench-permit-2026"
}
```

Verification enforces, **after** the signature passes and before any field is
acted on:

1. the key id resolves to a committed `.pub`, and the signature verifies;
2. the permit does not name its own revocation source;
3. it is not on `data/permits/revoked.json`;
4. `manifestHash` matches the manifest you passed with `--manifest`;
5. `methodologyHash` matches the committed sidecar — a plan revision invalidates
   every outstanding permit, deliberately;
6. the validity window contains now (the machine's clock; there is no `--now`);
7. **kind × capability**: the most a kind may ever grant.
   `legacy-shadow` → `judge-inference` only;
   `development-probe` → `catalog-read`, `candidate-inference`, `judge-inference`, `development-db-write`;
   `confirmatory-pilot` → `catalog-read`, `candidate-inference`, `judge-inference`;
   `presentation-erratum` → `presentation-erratum`;
   `publication` → `publication`, `result-sync`, `live-db-write`;
8. **kind × evidence class**, so a shadow permit cannot bind a pilot manifest;
9. **cells**: an inference permit with no cells authorises nothing (absence is
   denial), and a cell naming a model the manifest does not declare is a permit
   reaching outside its own envelope;
10. the permit's budget does not exceed the manifest's.

Two things that catch people out:

- **A judge call is authorised by the answer it scores, not by the seat scoring
  it.** A judging permit's cells are `(candidate model, question)` pairs — the
  same coordinates as the candidate cells.
- **The calibration gate is paid judging and needs cells of its own.** Anchors
  are scored under the pseudo-model `__calibration-anchor__`, so a judging
  permit must also carry a cell for each of the **24 distinct anchor question
  ids** in `data/calibration/anchors.yaml` (`flav-001 flav-002 flav-004
  flav-006 flav-009 flav-013 rgen-001 rgen-002 rgen-003 rgen-009 rgen-012
  rgen-013 rgen-015 rgen-016 rgen-019 rgen-020 subs-020 tech-001 tech-002
  tech-003 tech-004 tech-005 tech-006 tech-011`) paired with
  `__calibration-anchor__`. Without them the gate is refused at the firewall
  before it reaches the judge.

`executionLimit` is enforced by an on-disk redemption record under
`data/runs/<run-id>/permit-redemptions/`. A single-use permit that has been
redeemed is spent, including across processes. Each command that spends
redeems **once**, so a run plus a judging pass is two redemptions — either two
permits, or one with `executionLimit: 2` and both capabilities.

---

## 4. Free checks

```bash
pnpm bench validate     # dataset, canaries, reference answers, stuffing report
```

`validate` is the gate that makes a broken grader uncommittable: every
`referenceAnswer` must score 100 against its own grader, and a declared
`failingAnswer` must score ≤ 40. Warnings (keyword stuffing, missing
`failingAnswer`, near-duplicate prompts) do not fail the command; read them.

```bash
pnpm bench models --check \
  --permit "$PWD/permits/catalog-probe.permit.json" \
  --manifest "$PWD/permits/catalog-probe.manifest.json"
```

Slugs rot — v1 shipped six wrong ones. This one is **not** free of a permit: it
is an outbound request to the OpenRouter catalog, so it needs `catalog-read`.
Use a `development-probe` permit that grants `catalog-read` and nothing else: it
authorises no inference, needs no cells, and costs nothing to honour.

---

## 5. The estimate gate

```bash
pnpm bench estimate --models anthropic/claude-opus-5 --limit 10 \
  --permit "$PWD/permits/catalog-probe.permit.json" \
  --manifest "$PWD/permits/catalog-probe.manifest.json"
```

Writes `data/.estimate.json` (gitignored), valid for 24 hours, hashed over the
exact model set, question ids and token caps.

`bench run` recomputes that hash **from the manifest** — its routes, its item
set, its caps — not from the flags you type. So the estimate must have been
taken for the same work the manifest describes, or the run refuses. Pass
`estimate` the same `--models` and the same item selectors (`--tier`,
`--limit`, `--questions`) you gave `manifest`.

> **Known defect — check this before budgeting a real run.** `estimate` hashes
> the token caps from the CLI's `DEFAULTS` (16000 / 32000), while `run` hashes
> the caps from the manifest. A manifest that declares any other cap therefore
> can never satisfy the gate: `estimate` produces a hash `run` will not accept,
> and no flag on `estimate` changes it. Until that is fixed, keep
> `generationSettings.maxTokens` at 16000 and `maxTokensRecipe` at 32000, or
> expect "The saved estimate does not match this run" with nothing you can do
> about it. (`packages/runner/src/cli.ts` `cmdEstimate`, which passes `DEFAULTS`
> to `runEstimate`.)

Budget against **expected**, not worst case. Worst case assumes every call fills
its cap; with a 32k recipe cap that is roughly 8× reality. Measured: Fable 5
came in at $4.01 actual against $25.68 expected — the estimator is itself about
6× conservative, and the ledger enforces the hard ceiling on actual spend
anyway.

---

## 6. The run

```bash
pnpm bench run --run-id 2026-08-v3 \
  --permit "$PWD/permits/2026-08-v3-run.permit.json" \
  --manifest "$PWD/data/runs/2026-08-v3/manifest.json" \
  --budget 35 --per-model-budget 12
```

- The manifest supplies models, items, temperature, caps, concurrency and the
  approved ceiling. `--budget` may only **lower** that ceiling, never raise it.
- Mock-ness is a property of the envelope (`artifactOrigin: ["mock"]`), not of a
  flag — a command-line switch could turn a paid run into a free one after the
  fact and leave no trace.
- Identity is checked before the permit is redeemed: requested run id, permit's
  run id, manifest's run id and artifact directory must be one id. A mistyped
  flag therefore does not burn an approval.
- Then the permit is redeemed — the point of no return.
- Spend is **reserved before each call and settled at actual cost**, inside one
  ledger holding an exclusive lock on the run. A resumed run replays
  `spend.ndjson` and inherits prior spend, so it cannot spend its cap twice.
- Empty, filtered and provider-errored completions are retried twice (more
  tokens on the second) and then stored with `transportFailure: true`. They
  score 0 and appear in the board's `incidents` column: transport noise must
  never masquerade as skill.
- Re-running the same command resumes: it skips every `(model, item)` already
  stored.

Watch for `⚠ Per-model budget … is below the worst case for a single call`. That
refusal exists because a per-model cap under the per-call ceiling refuses every
call and then reports "0 responses stored" as though it had succeeded.

Cross-check real spend between batches:

```bash
curl -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/credits
```

---

## 7. Grade — free

```bash
pnpm bench grade --run 2026-08-v3
```

Deterministic graders only, and it re-checks that what is on disk is what the
manifest declares (bank, prompt, judge-prompt and validator hashes) before
reading a single response. Prior judge results are preserved.

---

## 8. Judge — paid

```bash
pnpm bench judge --run 2026-08-v3 --budget 15 \
  --permit "$PWD/permits/2026-08-v3-judge.permit.json" \
  --manifest "$PWD/data/runs/2026-08-v3/manifest.json"
```

- `--budget` is mandatory for a non-mock run. Judging was roughly 52% of real
  spend across the two published runs and none of it was recorded before v2.
- The panel comes from the **manifest's** `judgeRoutes`, never from a module
  default. A default that drifted after the envelope was signed would re-seat
  the panel silently, and a re-seated panel measured 96.20 against 88.16 on the
  same answers.
- The **calibration gate runs first**, inside the same ledger, and is paid: every
  seat must reproduce the hand-scored anchors at MAE ≤ 10 before any of its
  scores are accepted. A previously passed calibration is reused only if the
  panel and the judge-prompt version are identical.
- JUDGE-001: a seat never scores a model sharing its provider or its
  base-model family, and an identity missing from `data/models.yaml` counts as
  conflicted rather than distinct.
- Cross-judge disagreement over 15 flags the answer for human review. ~12–14% is
  healthy; those flags are a work item, not a failure.

---

## 9. Report and analyse

```bash
pnpm bench report  --run 2026-08-v3
pnpm bench analyze --run 2026-08-v3
```

Both go through the publication gate at *artifact* stage: a draft may produce
the board its own review reads, but the board is **stamped** with its evidence
class, release state and manifest hash so no reader can mistake development
evidence for a result. A non-scoring class prints its banner.

`report` refuses to write a board whose rows have different denominators — a
row averaged over fewer items is not comparable to its peers. `--allow-incomplete`
exists; using it on anything you intend to publish is not defensible.

Read `analysis.separation` before quoting any ordering. Adjacent-pair
differences are resampled per pair; on run 2026-07-v2.1 exactly one adjacent
pair of thirteen was genuinely ordered. **A 0.01-point lead is not a result.**

---

## 10. Register, audit, release

```bash
# 1. Put the run in the release register (binds it to its manifest hash)
pnpm bench lifecycle --run 2026-08-v3 --to audited --register true \
  --actor "Jordan" --evidence "docs/reviews/2026-08-v3.md"

# 2. Read the checklist without moving anything
pnpm bench lifecycle --run 2026-08-v3 --actor "Jordan" --evidence "docs/reviews/2026-08-v3.md"

# 3. Release. Rebuilds the checklist from the run's own evidence and refuses on any shortfall.
pnpm bench lifecycle --run 2026-08-v3 --to released \
  --actor "Jordan" --evidence "docs/reviews/2026-08-v3.md"
```

There is no `--checklist` flag, and there will not be one. The checklist is
built inside `transitionRun` from a fixed, enumerated list of checks; a caller
supplies who is signing and why, never the result. The previous shape accepted a
caller-supplied list, so a one-item list reading `pass` released a run.

The fourteen checks, all of which must pass — `not-checked` counts as a failure,
because a check that could not run is a check that did not run:

`manifest-present`, `manifest-digest-persisted`, `artifacts-match-manifest`,
`run-identity-consistent`, `evidence-class-publishable`, `lifecycle-audited`,
`coverage-complete`, `no-unadjudicated-flags`, `adjudications-resolved`,
`no-stale-scores`, `journals-intact`, `board-present`, `analysis-present`,
`artifacts-committed`.

Legal transitions: `draft → audited → released`, with `quarantined` and
`retired` available from most states. `released → draft` does not exist: a
published artifact never returns to work in progress. `quarantined → released`
does not exist either — lifting a quarantine in place would erase the reason it
was imposed; retire it and derive a replacement.

Commit the run directory before releasing (`artifacts-committed` checks it), and
never commit a toy or canary run.

---

## 11. The publication pointer

```bash
pnpm bench current                       # show the pointer and the register
pnpm bench current --run 2026-08-v3 \
  --reviewer "Jordan" --evidence "docs/reviews/2026-08-v3.md"
```

This is the approved-release pointer that replaces "newest `generatedAt` across
`data/runs/*`" — a heuristic, not an approval, and one that a regenerated mock
run could hijack. Setting it rebuilds the checklist, requires the register to
say `released`, requires the manifest itself to be publishable, and pins every
published artifact by digest.

> **Known gap:** `apps/web` still selects a board by newest `generatedAt`. The
> pointer exists and is written; the site does not yet read it. Recorded against
> RELEASE-002 in `docs/wp-0/traceability.yaml`.

---

## 12. Database sync and publish — optional, live data

```bash
pnpm bench sync    --run 2026-08-v3 \
  --permit "$PWD/permits/2026-08-v3-publication.permit.json" \
  --manifest "$PWD/data/runs/2026-08-v3/manifest.json"
pnpm bench publish --run 2026-08-v3 \
  --permit "$PWD/permits/2026-08-v3-publication.permit.json" \
  --manifest "$PWD/data/runs/2026-08-v3/manifest.json"
```

Both take the full publication test *before* the permit is redeemed and before
any row leaves the machine, including that the permit, the manifest and the
request name one run. `sync` needs `result-sync`; `publish` needs `publication`
— they are deliberately different capabilities, because pushing rows and making
them public are different decisions.

Needs `SUPABASE_SERVICE_ROLE_KEY` in the environment. That key is not in `.env`
and must never be committed; CI proves it is absent.

---

## 13. Taste archive

```bash
pnpm bench taste-archive \
  --permit "$PWD/permits/taste-archive.permit.json" \
  --manifest "$PWD/data/runs/<run-id>/manifest.json"
```

Snapshots every vote to `data/taste/votes.ndjson` in a stable order, so the diff
is append-only, plus a ratings snapshot. Commit it periodically: **the ballots,
not the board, are the permanent record.** Needs
`SUPABASE_SERVICE_ROLE_KEY`, which is still not in `.env` — so this has never
run end to end.

---

## Appendix A — the offline development loop

The only part of this document that can be run today. It calls no provider,
needs no key and spends nothing.

```bash
pnpm install
pnpm bench validate
pnpm bench manifest --run-id dev-loop --mock --limit 10
pnpm bench run      --run-id dev-loop            # mock envelope ⇒ MockClient, no permit needed
pnpm bench grade    --run dev-loop
pnpm bench judge    --run dev-loop               # mock ⇒ no permit, no calibration, no spend
pnpm bench report   --run dev-loop
pnpm bench analyze  --run dev-loop
```

A mock manifest is `evidenceClass: development`, `artifactOrigin: ["mock"]`,
`rankEligible: false`. It can never rank, sync or publish, and the class travels
with the artifact rather than living in the operator's memory. **Do not commit
`data/runs/dev-loop`.**

To exercise the permit loader against real committed material — no key, no
spend, nothing authorised — use the fixtures. Verification happens before the
command does anything, so nothing is called:

```bash
pnpm bench models --check \
  --permit "$PWD/data/permits/fixtures/expired-probe.permit.json" \
  --manifest "$PWD/data/permits/fixtures/expired-probe.manifest.json"
# expect: PERMIT_EXPIRED — reaching that error proves the key id resolved to a
# committed .pub, the signature verified, the revocation list was read, and the
# manifest and methodology bindings matched. No request is made.
#
# Swap the permit (keeping the same manifest) for the other two fixtures:
#   revoked-probe.permit.json  → PERMIT_REVOKED       (the list is genuinely read)
#   tampered-probe.permit.json → PERMIT_BAD_SIGNATURE (a body edited after signing)
```

---

## Appendix B — refusals, and what each one means

| Code | Meaning | Usual cause |
| --- | --- | --- |
| `PERMIT_UNKNOWN_KEY` | no committed `.pub` for that key id | approver key not committed |
| `PERMIT_BAD_SIGNATURE` | body edited after signing | signed over non-canonical JSON |
| `PERMIT_CHOOSES_OWN_TRUST` | the permit named its own revocation source | drop `revocationListUrl` |
| `PERMIT_REVOCATION_UNAVAILABLE` | `data/permits/revoked.json` missing | fails closed by design |
| `PERMIT_MANIFEST_MISMATCH` | `manifestHash` is not this manifest | signed the draft, not the frozen manifest |
| `PERMIT_METHODOLOGY_MISMATCH` | plan revision changed | re-approve; this is deliberate |
| `PERMIT_KIND_FORBIDS_CAPABILITY` | kind × capability matrix | e.g. shadow asking for candidate inference |
| `PERMIT_CELLS_INCOHERENT` | a cell names a model the manifest does not | permit reaching outside its envelope |
| `PERMIT_EXHAUSTED` | `executionLimit` reached | one redemption per spending command |
| `PERMIT_TRUST_INPUT_REJECTED` | someone passed a keyring/clock to `verifyPermit` | the boundary refusing, correctly |
| `MANIFEST_IMMUTABLE` | different manifest for an existing run id | derive a new run |
| `MANIFEST_HASH_MISMATCH` | bank/prompt/validator moved under the run | the dataset or a grader changed |
| `INELIGIBLE_EVIDENCE` | class/state cannot produce a public result | check the manifest, not the command |
| `CHECKLIST_INCOMPLETE` | release checks outstanding | the listed shortfall is the work |
| `GRANT_NOT_MINTED` | a hand-built grant reached a boundary | a bug, not a configuration problem |

---

## Appendix C — what is deliberately not here

- **`bench pilot`.** `RUN-001` requires the v2 admission gate to be **disabled**
  for v3. The command still exists behind a permit and no test asserts it is
  disabled — recorded as an open risk in `docs/wp-0/routes.yaml`
  (`runner:cli:pilot:record:write`). Do not use it for v3 work.
- **Re-grading a published run.** `data/runs/**` is immutable; the graders were
  corrected forward and `2026-06-v2` stands as published with an erratum on
  `/methodology`. Derived work uses a new run id and an isolated output root.
- **Editing the taste ballots.** `data/taste/**` is immutable for the same
  reason. CI pins both trees by git hash.

---

## Appendix D — regenerating the acceptance artifacts

`docs/wp-0/acceptance-summary.json` is generated from the route registry, the
traceability matrix and the WP-0 brief. It carries no timestamp and no
environment-dependent value, so the same inputs always produce the same bytes.

```bash
pnpm --filter @cookingbench/runner exec tsx src/regenerate.ts --check   # what CI runs
pnpm --filter @cookingbench/runner exec tsx src/regenerate.ts --write   # after editing either YAML
```

Commit the regenerated summary **in the same commit** as the change that moved
its numbers. That is the whole point: the acceptance totals stop being prose
somebody typed and become a diff somebody has to justify.
