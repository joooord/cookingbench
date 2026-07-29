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

- **Deterministic** (~75% of judgements): numbers extracted from the answer
  (fractions, thousands separators, ranges), unit-converted where equivalent
  (350°F = 177°C), tolerance-checked, with banded partial credit on compound
  items. Prompt-echoed values get no credit unless the item sets
  `expectedInPrompt`. Unsafe advice zeroes the question.
- **Judge panel** (~25%): three seats — Claude Opus 4.8, GPT-5.5, Qwen 3.5 Plus
  — two of which score each answer, blind to model identity. A judge never
  scores its own provider, and the dropped seat rotates by a deterministic
  hash. Judges list faults only (critical/major/minor); code maps those to
  −40/−15/−5 from 100, so the panel cannot award points. Cross-judge
  disagreement over 15 is flagged. Recipe generation blends judge (70%) with
  deterministic constraint checks (30%). Every seat must pass a calibration
  gate against hand-scored anchors before a paid run is accepted.

Scores are 0–100 per question. **Overall** is the plain mean over `active`
items, with a seeded 95% bootstrap CI. `basics` items (saturated, kept as a
regression gate) and `retired` items are excluded from it. **Frontier** is the
mean over difficulty ≥ 4 active items.

The whole dataset is public — there is no secret hold-out. Each file carries a
canary GUID so training-data filters can exclude it, and contamination shows up
as saturation, which `bench analyze` demotes out of the active set.

## Deploying the site (Vercel)

Import the repo at vercel.com/new and set **Root Directory** to `apps/web`
(framework auto-detects as Next.js; Vercel handles the pnpm workspace). Every
push to the production branch then auto-deploys.

## Status

- [x] Phase 0 — graders + golden tests + mock end-to-end pipeline
- [x] Phase 1 — dataset at 99 questions incl. the founding real-world prompts;
      Supabase project live (schema + RLS verified), `bench sync`/`publish` ready
- [ ] Phase 2 — $1 canary run, then full roster (needs OPENROUTER_API_KEY)
- [ ] Phase 3 — judge calibration gate
- [ ] Phase 4 — Vercel git integration (one-time import by the repo owner)
- [ ] Phase 5 — v1 public launch
