# Paid run — runbook (current: methodology v3)

Pre-requisites: `OPENROUTER_API_KEY` in the environment (or `.env` at repo
root). Top up credits first: `GET https://openrouter.ai/api/v1/credits` with
the key shows the balance.

```bash
pnpm install
pnpm bench validate
pnpm -r test && pnpm -r typecheck
```

## 1. Verify roster slugs (slugs rot — v1 shipped 6 wrong guesses)

```bash
pnpm bench models --check
```

Fix any ✗ slugs in `data/models.yaml` using the suggested similar ids, re-run
until clean. Active-but-missing slugs MUST be fixed before estimating.

**If any judge-panel slug changed since the last run, the calibration anchors
must be re-validated — judge version changes are breaking** (rankings
reorder). The gate runs automatically at `bench judge`, but check
`calibration.json` per-seat MAE before trusting the run.

## 2. Estimate, canary, then the full run

The estimate gate hashes the exact (models × questions × token caps) set, so
flags must match between `estimate` and `run`. The v3 dataset (232 questions,
117 active incl. trap-control twins) needs a **fresh estimate** — old ones
won't match the hash.

```bash
# Canary first ($1, cheapest active model, 10 questions):
pnpm bench estimate --models <cheapest-slug> --limit 10
pnpm bench run --budget 1.00 --limit 10 --models <cheapest-slug> --run-id canary-v3
pnpm bench grade --run canary-v3 && pnpm bench judge --run canary-v3 && pnpm bench report --run canary-v3
```

Canary checks: responses stored, deterministic scores sane, judge JSON parses,
spend within ~5% of the OpenRouter dashboard.

Then the real run, frontier models first, batched per model with a budget just
above that batch's worst case (actuals land at 3–30% of worst case):

```bash
pnpm bench estimate --models <batch>
pnpm bench run --budget <usd> --run-id 2026-06-v3 --models <batch>
pnpm bench grade --run 2026-06-v3
pnpm bench judge --run 2026-06-v3     # calibration gate runs first, panel judging after
pnpm bench analyze --run 2026-06-v3   # ALWAYS — saturation ratchet + judge agreement + length bias
pnpm bench report --run 2026-06-v3
```

Append cheaper models with the same `--run-id` as budget allows — the runner
resumes idempotently per (model, question).

## 3. Post-run checks (new in v3)

- `analysis.json → judgeAgreement`: interval Krippendorff's alpha, Spearman,
  MAE and per-seat means. Compare per-seat means against the previous run —
  a drifting seat means its anchors need re-checking. (2026-06-v2 baseline:
  alpha 0.555, MAE 7.7, seat means Opus 92.0 / GPT-5.5 88.2 / Qwen 96.2.)
- `analysis.json → lengthBias`: within-question Spearman of length vs judge
  score (v2 baseline: +0.13 pooled-within-question; pooled raw −0.317).
- `leaderboard.json → rankCi`: rank intervals come from the paired bootstrap;
  never describe a rank difference inside overlapping intervals as a result.
- Trap-control twins (`pairId` items): if a model aces every trap but tanks
  the twins, it's premise-rejecting reflexively — say so in any writeup.
- Spot-check ~15 judged answers; flagged disagreements are in scores.json
  (`flagged: true`) and await human review.

## 4. Publish

```bash
git add data/runs/<run-id> && git commit && git push
# The site shows the newest leaderboard by generatedAt; past runs stay at /runs/<id>.
# Optional DB sync (needs SUPABASE_SERVICE_ROLE_KEY):
pnpm bench sync --run <run-id> && pnpm bench publish --run <run-id>
```

Run artifacts are immutable once published — never regrade an old run.
