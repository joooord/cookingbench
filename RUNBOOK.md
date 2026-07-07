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
pnpm bench judge --run 2026-06-vXX        # panel: opus-4.8 + qwen3.5-plus + gpt-5.5, 2 non-conflicted seats/answer
pnpm bench report --run 2026-06-vXX
pnpm bench analyze --run 2026-06-vXX      # run after EVERY run: the de-saturation ratchet
```

If budget remains (check the spend printout), append cheap models
(deepseek, kimi, llama, qwen, mistral) with the same --run-id — the runner
resumes idempotently and only calls the new models.

## 2b. Taste panel run (LLM critics — optional, separate spend)

The taste panel judges pairwise A-vs-B duels drawn from the run's stored
answers to the subjective (llm-judge, active) items. It's independent of the
precision run above and never blended into it. Worst case looks large (2 seats ×
2 orders per duel), but actuals land far lower — tune `--pairs-per-question` and
watch the estimate.

```bash
pnpm bench taste-estimate --run 2026-06-vXX                 # default 4 pairs/question
pnpm bench taste-judge --run 2026-06-vXX --budget 5.00      # calibration gate runs first
```

The calibration gate makes every seat prefer a known-good answer over a
plainly-worse one, in both positions, before any paid duel. Artifacts land in
`data/runs/<id>/taste-panel/` (verdicts, `panel-votes.ndjson`, `summary.json`);
commit them to publish the /taste critics' table. Dry-run any wiring change for
$0 first with `--mock --pairs-per-question 1` (use a throwaway `--run-id`, and
never commit a mock run — the site shows the newest `generatedAt`).

## 3. Publish

```bash
pnpm bench flagged --run <run-id>   # export judge-disagreement worksheet for the expert layer
git add data/runs/<run-id> && git commit && git push   # Vercel auto-deploys the leaderboard
# Optional DB sync (needs SUPABASE_SERVICE_ROLE_KEY from the dashboard):
pnpm bench sync --run <run-id> && pnpm bench publish --run <run-id>
```

Manually spot-check ~15 judged answers in data/runs/<run-id>/ before
publishing. Flagged judge disagreements are in scores.json (`flagged: true`)
and collated for review in `data/runs/<run-id>/flagged-review.md`.
