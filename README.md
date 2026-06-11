# CookingBench

**How well do AI models cook?** A benchmark and public leaderboard for culinary
competence in AI models: scaling quantities, converting units, food safety,
substitutions, technique, flavour logic and nutrition math.

Cooking is an unusually good probe of model reliability — it mixes hard
arithmetic, regulated facts and judgement, and model versions visibly regress
on it (quantity/volume errors in otherwise stronger releases). To our
knowledge this is the first public leaderboard for culinary knowledge
correctness in general-purpose chat models.

## Layout

```
apps/web/          Next.js leaderboard site (flat editorial design, Tailwind v4)
packages/core/     Domain types, Zod schemas, deterministic graders (zero-dep)
packages/runner/   CLI: validate | models | estimate | run | grade | judge | report
data/models.yaml   Model roster (OpenRouter slugs)
data/questions/    The dataset — one YAML file per category
data/runs/         Committed raw run artifacts: every leaderboard rebuilds from git
supabase/          Postgres schema + RLS (public read of published runs only)
```

## Pipeline

```bash
pnpm install
pnpm test                      # grader golden tests
pnpm bench validate            # dataset sanity
pnpm bench run --mock          # full pipeline for $0 with mock personas
pnpm bench grade --run mock-run
pnpm bench judge --run mock-run
pnpm bench report --run mock-run
pnpm dev                       # leaderboard site on localhost:3000
```

A **paid run** is gated by cost controls:

```bash
pnpm bench models --check          # verify roster slugs against the live OpenRouter catalog
pnpm bench estimate                # worst-case cost table — required, valid 24h
pnpm bench run --budget 120        # BudgetGuard aborts before exceeding the cap
pnpm bench grade --run <id> && pnpm bench judge --run <id> && pnpm bench report --run <id>
```

Needs `OPENROUTER_API_KEY` (see `.env.example`). Set a spend limit on the key
itself as a second backstop.

## Grading

- **Deterministic** (~55%): numbers extracted from the answer (fractions,
  thousands separators, ranges), unit-converted where equivalent
  (350°F = 177°C), tolerance-checked. Prompt-echoed values get no credit.
  Unsafe advice zeroes the question.
- **LLM judge** (~45%): per-question rubrics, judged blind (model identity
  stripped), twice at temperature 0, averaged; disagreements flagged. Recipe
  generation blends judge (70%) with deterministic constraint checks (30%).

Scores are 0–100 per question; category = mean; overall = unweighted mean of
categories. Some questions are held out (`public: false`) against benchmark
contamination.

## Status

- [x] Phase 0 — graders + golden tests + mock end-to-end pipeline
- [ ] Phase 1 — expand dataset to 20 questions/category (currently 6), Supabase sync
- [ ] Phase 2 — $1 canary run, then full roster
- [ ] Phase 3 — judge calibration gate
- [ ] Phase 4 — deploy to Vercel
- [ ] Phase 5 — v1 public launch
