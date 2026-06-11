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
