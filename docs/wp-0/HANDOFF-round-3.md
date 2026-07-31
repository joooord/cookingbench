# WP-0 handoff — round 3

For Codex. Everything below is measured, not remembered; the reproduction
sequence at the end regenerates every number.

## Range

| | |
|---|---|
| Branch | `v3/wp-0-evidence-firewall` (production branch untouched) |
| Starting SHA | `f6bb16d` |
| Final SHA | `7938ec1` |
| Review range | `f6bb16d..7938ec1` |
| Diffstat | 56 files, +18,799 / −1,347 |

Commits, oldest first:

```
f40a50d  WP-0 closure: seven packages landed and integrated
0252dcc  WP-0 acceptance: the offline lifecycle, end to end, with all seventeen refusals
768049e  WP-0: resolve the LEAF, not just the directory, on every run-scoped path
1b631b8  WP-0: close the third caller-chosen trust root, and guard the last open seam
7938ec1  WP-0: re-derive both acceptance artifacts from verified reality
```

## Verification

| Check | Result |
|---|---|
| `pnpm typecheck` | clean, no output |
| `pnpm test` — core | 10 files, **492 passed**, 0 failed |
| `pnpm test` — runner | 30 files, **932 passed**, 0 failed |
| Acceptance summary regenerates byte-identically | ✓ |
| `pnpm build` (Next.js) | succeeds |

## Preservation

| | Before (`f6bb16d`) | After (`7938ec1`) |
|---|---|---|
| `data/runs` tree | `b9fd00163e3dadbe840ebed7dc368c250a227fe5` | **identical** |
| `data/taste` tree | `ad159d0d09e16e341994a7ec905cd5ef6a682d34` | **identical** |
| Corpus content digest | — | `91a5203ca231502afa9f64875ad0f396fe9751cf15287b942f3b3b69f6d5e9e1` |
| Response files | 2,576 | 2,576 |

`git status --short data/` is empty at the final SHA.

**Confirmed: no model call, no judge call, no live API key, no Supabase write,
no Vercel deploy, no change to the public release pointer.** Every route suite
replaces `globalThis.fetch` with a throwing stub for the whole file, and
`@supabase/supabase-js` is mocked so that *constructing* a service-role client
is itself an observable failure — which is what makes "it refused before a
privileged connection existed" an assertion rather than a hope.

## The ten requirements

| ID | Status | Gaps | Limitations | Decisions | Tests |
|---|---|---|---|---|---|
| RUN-001 | **closed** | 0 | 1 | 0 | 24 |
| RUN-001A | partial | 3 | 0 | 0 | 13 |
| RUN-002 | **closed** | 0 | 0 | 0 | 23 |
| DATA-001 | **closed** | 0 | 0 | 0 | 23 |
| DATA-002 | **closed** | 0 | 0 | 0 | 22 |
| RELEASE-001 | **closed** | 0 | 0 | 0 | 3 |
| RELEASE-002 | partial | 1 | 0 | 1 | 15 |
| JUDGE-001 | partial | 2 | 0 | 0 | 8 |
| BUDGET-001 | **closed** | 0 | 1 | 0 | 18 |
| TRACE-001 | partial | 1 | 0 | 0 | 10 |

**6 closed / 4 partial / 0 open, 7 remaining gaps.** Previous state: 2 / 7 / 1
with 19 gaps.

Route registry: **91 routes, 112 risks, 95 closed, 17 open** (was 47 closed /
63 open).

## This does not meet the bar you set

You asked for ten closed, zero partial, zero gaps. It is six and seven. I did
not close the remaining four, and the reasons differ enough to be worth reading
separately rather than as one number.

- **JUDGE-001 (2 gaps)** is not a code gap. The base-model-family arm of the
  conflict rule is dead on the live roster — every `family` in
  `data/models.yaml` sits inside exactly one provider, so it never excludes a
  seat the provider arm had not already excluded — and `family` is a marketing
  tier, not a base model (`claude-frontier` spans three different base models).
  Closing this means giving the registry a real base-model identity. That is a
  data change with methodology consequences, not something to do inside a
  code-preparation commit.

- **RELEASE-002 (1 gap)** is a scope question, and I have recorded it as a
  proposed decision (`RELEASE-002-D1`) rather than answering it in an
  implementation commit, per your instruction not to silently reinterpret a
  requirement. `writeLeaderboard` and `writeAnalysis` call no authorisation
  check. There is a defensible reading in which they need none — those files
  are inert until the release register points at them, and that pointer *is*
  approval-gated, proved by `16 — partial publication refuses`. There is an
  equally defensible reading in which a file named `leaderboard.json` inside a
  run is a result. My recommendation is in the matrix: require the grant and
  accept that `bench analyze` and `bench report` then need an approval. The
  validator refuses to let RELEASE-002 be closed while the decision is
  outstanding.

- **TRACE-001 (1 gap)** is now one step from closed. The provenance trail is
  written (see below); what is missing is that no release check *reads* it, so
  a run can still be released with an empty trail. The natural home is the
  release checklist, whose scope is already fixed and derived from the run.

- **RUN-001A (3 gaps)** is the seventeen open route risks: eight `bench pilot`
  and CLI readers with no test of any kind, six recorded DEFECTS whose test
  proves the risk is live, and the two RELEASE-002 writers above.

## Defects found and fixed in this range

All five were found by proving the routes rather than by reading them, and each
was reproduced by probe before being fixed.

1. **`writeAnalysis` followed a leaf symlink out of the repository.** It was a
   bare `writeFileSync(join(resolveRunDir(runId, {write:true}), 'analysis.json'))`
   — the guard applied to the directory, the write followed the leaf. Probed
   with the leaf linked to a file outside the repo: the write **succeeded and
   overwrote it**. `analysis.json` is what the site reads for the separation
   table. **DATA-001 was recorded as `closed` while this was open.**

2. **`readResponses` did not resolve its leaf.** A scratch run containing
   `responses -> data/runs/2026-07-v2.1/responses` returned **all 2,576 frozen
   answers, no error**, presented as the scratch run's own evidence.

3. **`runCalibration` preflighted the directory, not the write target.** `join`
   validates nothing, so the leaf was only checked by the final
   `writeRunFileAtomic` — after the judge loop had billed. Probed: the client
   was called against a target that was never writable.

   Sweeping for the *pattern* rather than fixing the three reported instances
   found three more: `readAttempts` (a linked attempts directory makes another
   run's spend satisfy this run's cap), `readScores`/`readRunConfig`, and the
   ledger, whose constructor preflighted the directory while `appendRunFileLine`
   refuses a linked leaf — and whose journal replay read *through* the link,
   inheriting another run's prior spend.

4. **`readHistoricalRegistry(registryPath = HISTORICAL_REGISTRY)`** let any
   caller name the file that decides which runs are frozen. `{"runIds": []}` is
   structurally valid, so one argument made every published run writable.
   Verified. This is the **third** instance of one defect — the permit keyring
   and the revocation list were the first two — which is why it is now stated
   as a rule rather than fixed case by case. Split as `permit.ts` was: the
   production entry takes no parameter, the seam refuses outside a test process.

5. **`ReservationLedger.forTests` had no runtime guard.** It checked the grant
   was real but not that the process was a test process, and `TestSeamOptions`
   carry `lock` and `now` — so a production caller holding a legitimate grant
   could take a ledger with the run lock disabled (two runners each spending the
   whole cap, the case BUDGET-001 exists to close) and a clock of its own.
   Now `UNDER_TEST`-guarded; the architecture suite's list of unguarded seams is
   empty and asserted as an equality.

Two validator defects, both of which made an **honest citation look
fabricated** — the worst direction for a completeness checker to fail in,
because the cheapest way to go green is then to weaken the citation:

- `['"\`](.+?)['"\`]` ended a lazy match at the first quote of any kind, so
  `it('… reading it as "no disputes"')` was indexed truncated.
- Neither harvester understood escapes, so `describe('… this run\'s own')` was
  indexed at the apostrophe.

## Production boundaries changed

| Boundary | Before | After |
|---|---|---|
| `readHistoricalRegistry` | `(registryPath = HISTORICAL_REGISTRY)` | `()` — no parameter; seam split out |
| `ReservationLedger.forTests` | grant check only | `UNDER_TEST` refusal |
| `writeAnalysis` | `writeFileSync` over a resolved directory | `writeRunFileAtomic` |
| `readResponses` / `readAttempts` | `readdirSync(join(runDir(id), …))` | `readRunJsonEntries` — leaf-resolved per entry |
| `readScores` / `readRunConfig` | `join(runDir(id), leaf)` | `readRunFileOrNull` / `readRunFile` |
| `runCalibration` preflight | `resolveRunDir` | `resolveRunFile` on the target |
| `ReservationLedger` constructor + journal replay | `resolveRunDir` | `resolveRunFile` on `spend.ndjson` |
| `recordProvenance` / `readProvenance` | did not exist | appended per authorisation from `bench run`, `bench judge`, `bench sync` |

New exports: `readRunFile`, `readRunFileOrNull`, `readRunJsonEntries`,
`readHistoricalRegistryForTests`, `recordProvenance`, `readProvenance`.
New error codes: `MISSING_RUN_FILE`, `SEAM_CLOSED`, `LEDGER_SEAM_CLOSED`.

## Deliberate deviations from the work order

1. **Not ten closed.** Explained above, per requirement. I would rather hand
   over an accurate six than a green ten that the next reviewer takes apart.

2. **`runner:permit:keyring:read` and `:revocation:read` were re-keyed to
   `verifyPermit`.** Their sinks (`loadPublicKey`, `revokedPermitIds`) are
   module-private and always were, so the registry's rule — a closed risk must
   cite a test that *calls* `route.function` — made a genuinely closed boundary
   permanently unprovable. The rule is right in general; weakening it would cost
   far more than it buys. The route now names the only path by which the sink is
   reachable, `operation` still names the sink, and **a test asserts neither
   internal is exported**, so the re-key is falsifiable rather than convenient.

3. **A `limitations` field, distinct from `gaps`.** A gap is work not done; a
   limitation is a boundary of the mechanism no commit in this repository will
   move. Two existed and were sitting in the gap list: the ledger cannot
   un-spend money the provider has taken, and no approver key exists *by
   design*. A permanent entry in the gap list trains readers to skim it.

4. **A `proposedDecisions` field.** Where RELEASE-002-D1 lives, per your
   instruction to record rather than reinterpret. The validator refuses to close
   a requirement carrying an `awaiting-decision` entry.

5. **`packages/runner/vitest.config.ts` — a 30s per-test timeout.** Vitest's 5s
   default failed the acceptance lifecycle test under suite parallelism; it takes
   ~4s alone. A timeout reported as a failure is the worst way for a suite to go
   red — the assertion never ran, so the output says nothing about whether the
   boundary holds, and the same command passes on a quieter machine.

6. **Removed a ratchet pointing the wrong way.** The traceability totals test
   asserted `partial + open > 0` — literally "WP-0 is not complete". The day it
   became complete, that test would have failed, and the cheapest fix would have
   been to reopen a requirement.

## Remaining concerns

- **Six routes have a test proving the risk is LIVE.** `web:data:analysis:read`,
  `web:data:scores:read`, `web:data:responses:read` and `web:data:run-config:read`
  serve run artifacts with no binding to the manifest that produced them;
  `runner:store:attempts:read` trusts an attempt record bound to no manifest;
  `runner:calibration:result:read` reads a hand-written `calibration.json` as a
  passed gate; `runner:estimate:record:read` accepts a hand-written estimate
  record. These are the *next* work package's shape, not this one's: they are
  all "an artifact is read without checking the envelope that produced it",
  which is DATA-002 applied to readers rather than to writers.

- **`bench pilot` has no test of any kind**, and RUN-001 records that it is
  meant to be DISABLED for v3, which nothing asserts either.

- **No approver key exists, by design**, so nothing can currently exercise a
  capability. The chain is proved against three committed fixture permits that
  expired in 2020 and a fixture key whose private half was destroyed. That is
  the correct state for a repository under code preparation, and it means the
  end-to-end proof is of the *loader*, not of a live approval.

- **The dataset problems are untouched and remain the real obstacle to a valid
  release.** 33 of 102 active items are perfect for all fourteen models,
  `effectiveItems` is 24.2, and the published board's top five are a
  statistical tie. WP-0 makes the *process* trustworthy; it does not make the
  *measurement* discriminating.

## Reproduction

```sh
git checkout v3/wp-0-evidence-firewall && git rev-parse HEAD   # 7938ec1
git diff --stat f6bb16d..HEAD

pnpm install
pnpm typecheck                     # clean
pnpm test                          # 492 core + 932 runner, 0 failed
pnpm build                         # Next.js build succeeds

# acceptance artifacts regenerate byte-identically
pnpm --filter @cookingbench/runner exec tsx src/regenerate.ts --check

# preservation
git rev-parse HEAD:data/runs       # b9fd00163e3dadbe840ebed7dc368c250a227fe5
git rev-parse HEAD:data/taste      # ad159d0d09e16e341994a7ec905cd5ef6a682d34
find data/runs/2026-07-v2.1/responses -name '*.json' | sort | xargs sha256sum | sha256sum
                                   # 91a5203ca231502afa9f64875ad0f396fe9751cf15287b942f3b3b69f6d5e9e1
find data/runs/2026-07-v2.1/responses -name '*.json' | wc -l   # 2576
git status --short data/           # empty

# the acceptance test on its own
pnpm --filter @cookingbench/runner exec vitest run test/lifecycle-e2e.test.ts

# the five route-proving suites
pnpm --filter @cookingbench/runner exec vitest run \
  test/routes-store.test.ts test/routes-judge.test.ts \
  test/routes-firewall.test.ts test/routes-publication.test.ts test/routes-web.test.ts

# the registers themselves
pnpm --filter @cookingbench/runner exec vitest run \
  test/route-inventory.test.ts test/traceability.test.ts test/architecture.test.ts
```

`docs/wp-0/acceptance-summary.json` carries the machine-readable version of the
tables above, regenerated from `routes.yaml` and `traceability.yaml` and checked
byte-for-byte in CI.
