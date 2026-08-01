# CookingBench

**Can AI cook?** An open research programme studying what AI models understand
about cooking — food safety, quantities and conversions, technique, flavour,
culture and care — and publishing the evidence, uncertainty and failures
together at [cookingbench.com](https://cookingbench.com).

Cooking is an unusually good probe of model reliability: it couples verifiable
physical constraints (heat, time, ratios, microbiology) to human judgement
(flavour, culture, occasion), so it exposes both what a model knows and what it
only sounds like it knows.

## Where the project stands

CookingBench ran two full benchmark runs in 2026. The second, `2026-07-v2.1`
(14 models × 184 questions, 2,576 answers, every model complete), survives as a
**preserved corpus** anyone can regrade. A retrospective audit found the derived
scores unreliable — the ordering was an artefact of the scoring instrument —
so the scores are archived as historical evidence and **must not be cited as a
ranking** (`docs/errata/2026-07-v2.1-corpus-and-scores.md`). The full argument
is the autopsy paper, `docs/papers/01-autopsy.md`, published on the site.

The benchmark is now being rebuilt methodology-first under a frozen master plan
(`docs/methodology/CookingBench-methodology-first-master-plan.md`, Revision 3):
no rank-bearing model inference until the methodology, questions, judges and
statistics pass their evidence gates. Work Package 0 — an evidence firewall of
signed permits, immutable run manifests, an atomic spend ledger and offline CI —
is complete; see `docs/wp-0/`.

## Layout

```
apps/web/          Next.js site — research programme, archived result, corpus record
packages/core/     Domain types, Zod schemas, graders (incl. unwired v3 modes)
packages/runner/   Permit-gated CLI: pnpm bench <command>
data/questions/    The dataset — one YAML file per category
data/runs/         Immutable run artifacts (CI pins the git tree hash)
data/permits/      Permit trust root — public verification keys only, by design
docs/              Master plan, WP-0 records, audits, erratum, autopsy paper
```

## Development

```sh
pnpm install
pnpm -r test          # offline; no keys, no network calls
pnpm bench validate   # dataset sanity — free and offline
pnpm --filter web dev # the site reads committed artifacts only
```

Every command that could spend money, write run artifacts or publish requires a
verified Ed25519 permit. No approver key is committed — minting one is a human
act performed away from the repository (`data/permits/keys/README.md`) — so all
paid paths fail closed by design. CI (`.github/workflows/ci.yml`) runs the whole
suite in a no-network namespace with no secrets, and fails if the historical
corpus changes by a byte.

The whole dataset is public — there is no secret hold-out. Each file carries a
canary GUID so training-data filters can exclude it, and contamination shows up
as saturation, which the item analysis demotes out of the active set.

See `RUNBOOK.md` for the operational pipeline and `CLAUDE.md` for orientation,
including the hard-won lessons from the v1/v2 era.
