# First paid run — runbook

Pre-requisites: `OPENROUTER_API_KEY` in the environment (or `.env` at repo
root). The key is capped (£10) so the strategy below fits inside it.

```bash
pnpm install
pnpm bench validate
```

## 1. Verify roster slugs (the ids in data/models.yaml are unverified guesses)

```bash
pnpm bench models --check
```

Fix any ✗ slugs in `data/models.yaml` using the suggested similar ids, re-run
until clean. Active-but-missing slugs MUST be fixed before estimating.

## 2. Estimate, canary, then frontier run

```bash
# The estimate gate hashes the exact model+question set, so the canary needs
# its own estimate with matching --models/--limit (required gate, valid 24h):
pnpm bench estimate --models <cheapest-slug> --limit 10
# $1 canary: cheapest active model, 10 questions
pnpm bench run --budget 1.00 --limit 10 --models <cheapest-slug> --run-id canary
pnpm bench grade --run canary && pnpm bench judge --run canary && pnpm bench report --run canary
```

Canary checks: responses stored, deterministic scores look sane, judge JSON
parses, BudgetGuard spend within ~5% of the OpenRouter dashboard number.

Then the real run, frontier-first (fits a ~£10 key; worst-case must clear the
gate, actuals run far lower):

```bash
pnpm bench estimate --models anthropic/claude-fable-5,anthropic/claude-opus-4.8,openai/gpt-5.5,google/gemini-3.1-pro-preview,x-ai/grok-4.3
pnpm bench run --budget 10.00 --run-id 2026-06-vXX --models <same list>
pnpm bench grade --run 2026-06-vXX
pnpm bench judge --run 2026-06-vXX        # judge = google/gemini-3.1-pro-preview, double-judged
pnpm bench report --run 2026-06-vXX
```

If budget remains (check the spend printout), append cheap models
(deepseek, kimi, llama, qwen, mistral) with the same --run-id — the runner
resumes idempotently and only calls the new models.

## 3. Publish

```bash
git add data/runs/<run-id> && git commit && git push   # Vercel auto-deploys the leaderboard
# Optional DB sync (needs SUPABASE_SERVICE_ROLE_KEY from the dashboard):
pnpm bench sync --run <run-id> && pnpm bench publish --run <run-id>
```

Manually spot-check ~15 judged answers in data/runs/<run-id>/ before
publishing. Flagged judge disagreements are in scores.json (`flagged: true`).

---

# First paid test after the v3 grader work

Everything below has only ever run against mocks. Run it in order and stop if a
step surprises you. Needs `OPENROUTER_API_KEY` in `.env` at the repo root.

## 0. Free — does the roster still exist

```bash
pnpm bench validate            # dataset, canaries, reference answers, stuffing report
pnpm bench models --check      # slugs rot; v1 shipped six wrong ones
```

Fix any ✗ slugs in `data/models.yaml` before spending anything.

## 1. The admission gate (~£0.05)

The newest code, and the only part with no real-API mileage at all.

```bash
pnpm bench pilot --file data/candidates/v3-buried-premise-01.yaml --budget 0.50
```

Three buried-premise safety candidates. Expect Stage 0 to pass all three (it
already caught one authoring bug: safe-024's reference said "throw *that*
batch out" against a synonym list that only had "throw it"), then two calls per
candidate. Admission needs the ceiling model and the mid model to disagree — if
the ceiling model catches every trap, the batch is too easy and that is the
gate doing its job, not a failure.

The record lands in `data/pilot/v3-buried-premise-01.json`. Commit it: admissions
are artifacts, same as runs.

## 2. Canary run (~£0.10)

```bash
pnpm bench estimate --models mistralai/mistral-large-2512 --limit 10
pnpm bench run --budget 2.00 --limit 10 --models mistralai/mistral-large-2512 --run-id canary3
pnpm bench grade --run canary3
pnpm bench judge --run canary3 --budget 1.00
pnpm bench report --run canary3
```

What to check, all of it new since 2026-06-v2:

- `config.json` has a non-zero `judgeCostUsd`. Judging was ~52% of real spend
  and none of it was recorded before.
- The judge prints a running spend and refuses to start without `--budget`.
- Any empty answer scores 0 rather than 21–42, and says so.
- `unjudged` is 0 on every leaderboard row, or the report names the model.
- Cross-check the total against the real number:
  `curl -H "Authorization: Bearer $OPENROUTER_API_KEY" https://openrouter.ai/api/v1/credits`

Don't commit `data/runs/canary3` — it is noise in the artifact history. It
cannot hijack the homepage even if you do: `getLatestReport()` skips mock runs
*and* any board covering less than half the question set, so a ten-question
canary is not publishable however new its timestamp.
