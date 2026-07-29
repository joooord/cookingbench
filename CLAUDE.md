# CLAUDE.md — CookingBench

Orientation for future Claude instances (and humans). Read this before touching
anything; it encodes several lessons that were paid for in API credits.

## What this is

CookingBench benchmarks how well AI models cook — quantities, conversions, food
safety, substitutions, technique, flavour, nutrition, recipe generation — and
publishes a leaderboard at **cookingbench.com** (Next.js on Vercel). Scores are
reproducible from artifacts committed to this repo. Two axes, kept separate on
purpose ("metrics test vs flavour test"):

- **Precision** — deterministic graders + an LLM judge *panel* (see below).
- **Taste** — humans blind-voting on paired answers at `/tastetest`.

## Repo map

```
data/questions/*.yaml      the dataset (184 items, schema in packages/core/src/schema.ts)
data/calibration/anchors.yaml  hand-scored answers every judge must reproduce
data/runs/<run-id>/        immutable run artifacts: config, responses/, scores, leaderboard, analysis, calibration
packages/core              types, zod schema, deterministic graders (+ vitest tests)
packages/runner            CLI pipeline (pnpm bench <cmd>), OpenRouter client, judge, calibration, analyze
apps/web                   the site; reads committed run artifacts, NO env vars or secrets
supabase/migrations        DB schema incl. taste_votes (applied to live project nvdkhatenkjmbyudwbgm)
RUNBOOK.md                 step-by-step for a paid run
```

Branches: the default branch is `claude/peaceful-bardeen-bo2h6q` — **that is what
Vercel deploys** (user redeploys manually). Development happens on a session
branch which the user merges (or has previously authorised merging directly).

## The pipeline

```
pnpm bench validate                  # dataset sanity
pnpm bench models --check            # verify OpenRouter slugs (ids drift! v1 shipped 6 wrong guesses)
pnpm bench estimate [--models a,b] [--limit N]   # REQUIRED gate before any paid run
pnpm bench run --budget <usd> --models a,b --run-id <id>   # resume-aware per (model,question)
pnpm bench grade --run <id>          # deterministic; preserves prior judge results
pnpm bench judge --run <id>          # panel judging; calibration gate runs first
pnpm bench analyze --run <id>        # saturation/discrimination ratchet — run after EVERY run
pnpm bench report --run <id>         # leaderboard.json + table
git add data/runs/<id> && commit && push   # publish; site picks newest leaderboard by generatedAt
```

Key invariants:
- The **estimate gate** hashes the exact (models × questions × token caps) set.
  `estimate` flags must match `run` flags (`--models`, `--limit`) or run refuses.
- `run` refuses if worst-case estimate > `--budget`. Worst case assumes full
  token caps; **actuals land at 3–30% of worst case**. Batch per model with a
  budget just above that batch's worst case, and watch real spend between
  batches: `GET https://openrouter.ai/api/v1/credits` with the API key.
- Run artifacts are **immutable** once published. Never regrade old runs; a
  leaderboard.json without `methodologyVersion` is treated as v1 by the site.
- Don't commit toy runs: the site shows the **newest** `generatedAt` across
  `data/runs/*`. A regenerated mock run would hijack the homepage.

## Methodology v2 (current) — why it looks like this

v1 saturated catastrophically: 84/129 questions perfect-for-everyone, judge gave
5/5 on 800/970 criteria, top four models within 0.7 points. v2's answers:

1. **Dataset tiers** (`status` field): `active` (counts toward Overall),
   `basics` (saturated items kept as a regression gate, excluded from Overall),
   `retired` (never runs). `bench analyze` mechanically produces demotion lists
   — this ratchet is the long-term de-saturation strategy AND the contamination
   defence (the dataset is honestly all-public, with a canary GUID in each file;
   contamination shows up as saturation and gets demoted).
2. **Item styles that still discriminate**: compound numeric chains (errors
   compound; banded partial credit `bands:` on the numeric grader), dangerous-
   premise traps (`trap: true`, keyword grader), buried-constraint long-context
   briefs (llm-judge + deterministic constraintChecks), locale traps (AU tbsp =
   20 ml, UK pint = 568 ml, gas marks, gō), tight-band estimation. Single-hop
   flashcards are dead — numeric items were 51/52 saturated in v1.
3. **Judge panel** (judge.ts): Claude Opus 4.8, Qwen 3.5 Plus, GPT-5.5. Two
   seats score each answer; a judge **never scores its own provider** (self-
   preference), the third seat is dropped by deterministic FNV-1a hash
   (reproducible, balanced). Deduction grading: judges only list faults
   (critical/major/minor); CODE maps severities to −40/−15/−5 from 100. The
   judge prompt insists each *distinct root mistake* is counted once.
4. **Calibration gate** (calibration.ts + data/calibration/anchors.yaml): every
   seat must reproduce hand-scored anchors (per-judge MAE ≤ 10) before paid
   judging. Philosophy learned from real runs: judges agree tightly on good
   answers (anchor tolerance ±10) and legitimately span 0–55 on confidently-
   wrong ones (wide tolerances there). Tight top = anti-inflation; loose bottom
   = don't fight honest disagreement. Cross-judge disagreement > 15 flags the
   answer for human review (13.9% flag rate in 2026-06-v2 — that's healthy).
5. **Scoring**: Overall = plain mean over active items (v1's mean-of-category-
   means diluted the only discriminating category to 1/8). `frontier` =
   difficulty ≥ 4 mean. `basics` column ≈ 100 for everyone by design. Seeded
   bootstrap 95% CIs over questions shown as ±. `incidents` counts responses
   that stayed empty/filtered after retries (scored 0 but visible — transport
   noise must never silently masquerade as skill).
6. **Taste test**: `/tastetest` page (dynamic route) serves blind pairs; votes
   go to Supabase `taste_votes` (RLS: anon may insert votes and read tallies,
   nothing else; keys in apps/web/lib/supabase.ts are public by design). With
   5+ battles a model gets a Taste column on the leaderboard — never blended
   into the precision score. The `/taste` Taste Board ranks models by
   **Bradley-Terry rating** (packages/core/src/taste.ts: MM fit, ties = half
   win, phantom-opponent prior, seeded-bootstrap CIs) because raw win% is
   biased by opponent strength. Votes carry anonymous telemetry (`session_id`
   localStorage UUID + `vote_ms`, migration 0003 — analysis-grade, spoofable,
   not auth) and contender sampling is weighted `1/(battles+1)` so new models
   catch up. `pnpm bench taste-archive` snapshots every vote to
   `data/taste/votes.ndjson` (stable order ⇒ append-only diffs) + a ratings
   snapshot — commit it periodically; the ballots, not the board, are the
   permanent record. The duel UI treats a vote as unconfirmed until the
   insert succeeds (pending → saved/error with retry) — votes must never be
   lost silently, and the whole dish card is the tap target (a v1 bug hid the
   click on the header strip only).

## Hard-won operational lessons

- **Reasoning models burn token caps invisibly.** v1's 2000/4000 caps made Kimi
  K2.6 return *empty text* on 14 questions (hidden reasoning ate the budget) —
  that was most of its last place. v2: flat 8000 cap + `reasoning: effort
  medium` for candidates; judges get `effort low` with token escalation on
  retry. If a model scores mysteriously low, check `finish_reason` and
  `completion_tokens_details.reasoning_tokens` in the stored raw response first.
- **Retry-on-empty is mandatory.** Providers return empty completions, error
  bodies, and `content_filter` stops. cmdRun retries 2× (more tokens on the
  second), then stores with `transportFailure: true`. Note: Claude Fable 5's
  content_filter on nutr-028/030/safe-014 is *reproducible*, not transient.
- **OpenRouter quirks**: new accounts get 10 requests/min on some flagship
  models (429 backoff base is 15 s for this reason); network-level fetch errors
  ("terminated") are retried like 502s; slugs in data/models.yaml rot — always
  `models --check` before estimating.
- **Keyword-grader traps bite their authors.** Forbidden terms can't be words a
  *correct* answer must use ("coconut" in a coconut-allergy question — fixed
  after it zeroed two correct answers). Negation handling lives in
  keyword.ts: "not/avoid/instead of…" sentence-window, "X-free" immediately
  before a term, "term-free" after. A looser X-free rule was rejected because
  "feel free to add peanut butter" would excuse allergens — there's a test for
  it.
- **Calibrate the gate, not just the judge.** When a calibration anchor fails,
  first ask whether the *anchor* encodes a defensible hand-score. Two anchors
  were re-banded because Opus/GPT-5.5 stack findings harder than Gemini did —
  both readings were defensible; the gate now checks bands, not points.
- **Deduction grading has a verbosity bias**: longer answers expose more
  surface for findings, which is partly why terse GPT-5.4 Mini topped
  2026-06-v2 (96.4). The taste test is the designed counterweight. Keep this in
  mind before celebrating or "fixing" a surprising ranking.
- **Secrets**: `.env` (repo root, gitignored) holds OPENROUTER_API_KEY; verified
  never committed. The web app reads zero env vars. Supabase anon/publishable
  keys are public by design (RLS-protected).

## State as of 2026-07-29

### The grader audit — read this before touching the graders

A full review found the keyword grader was punishing correct answers. Its
negation detection covered three contractions and looked backwards only, so a
refutation using a contracted auxiliary ("you *haven't* dodged a bullet") or a
warning that names the banned thing ("many vegan butters *use coconut oil* —
look for soy-based") read as a violation. **Eighteen answers in `2026-06-v2`
were marked wrong when they were right**, and three questions' own hand-written
`referenceAnswer` scored 0 against their own grader. On `subs-020` that zeroed
12 of 13 models, three of them while the judge panel scored them 100.

Fixed forward — `2026-06-v2` stands as published, with an erratum on
`/methodology`. Re-grading it moves six of thirteen positions.

Three guards now make the class un-committable, all in `bench validate`:
1. Every `referenceAnswer` must score 100 against its own grader. **Blocking.**
2. Optional `failingAnswer` (deliberately wrong) must score ≤ 40. The pair is a
   free discrimination test on the *grader*: 100/100 means it credits anything,
   0/0 means it rejects everything.
3. Warnings for keyword-stuffing, forbidden terms the reference itself uses,
   short prefix-colliding synonyms, near-duplicate prompts, missing canaries.

**50 items score 100 on keyword stuffing** — a bare list of their own required
synonyms, no sentence. `rgen-002` passes on the word "minute". 39 have no judge
component to dilute it. That is saturation from the grader's side, and it is
the strongest argument for the judge-first direction in `docs/V3-PLAN.md`.

### Token caps are not provider-neutral

`maxTokensFor` splits by category again: **16k general, 32k recipe-generation.**
Measured on rgen-013 with the 2026-07 roster:

    gpt-5.6-terra-pro  23,559 out (15,132 reasoning)  finish: stop
    claude-opus-5       8,000 out ( 2,362 reasoning)  finish: LENGTH

OpenAI does not count reasoning against `max_tokens`; Anthropic does. The old
flat 8k truncated Opus 5 at 1,323 characters where Fable 5 wrote 8,409. After
the fix Opus 5 writes 15,611, finish `stop`. Never set a flat cap again without
checking both providers.

### Estimates: budget against *expected*, not worst case

Worst case assumes every call fills its cap, which with a 32k recipe cap is
~8x reality and demanded `--budget 343` for three models. `estimate` now reports
both; the gate uses expected (2,000 tokens normal / 9,000 recipe, from measured
p90s). **Measured ratio: Fable 5 came in at $4.01 actual against $25.68
expected — the estimator is ~6x conservative.** BudgetGuard still enforces the
hard ceiling on actual spend.

### Roster and panel, refreshed 2026-07-29

14 active models across 9 labs. `claude-opus-5` is newer *and* half the price of
`claude-fable-5` ($5/$25 vs $10/$50); Fable stays for version-regression.

Judge panel is **opus-4.8 / gpt-5.5 / grok-4.5**. The obvious full upgrade was
tried and *the calibration gate rejected it*: `gpt-5.6-sol-pro` posted MAE 12.9,
scoring a deliberately-wrong anchor 70 where the hand-score is 30 (too soft on
confidently bad advice) while zeroing another where it is 50. `claude-opus-5`
came in at MAE 6.5 but missed a band. `grok-4.5` passed cleanest at 5.6, so it
replaces the qwen seat that marginalised at 96.20 against gpt-5.5's 88.16 on the
same answers. **Newer is not automatically better calibrated.** Before
concluding a model judges badly, re-read the anchor — CLAUDE.md's own earlier
lesson, still the right instinct.

Costs are not proportional to per-token price: **GPT-5.6 Sol Pro cost $9.78 on
184 questions against Fable 5's $4.01**, despite being cheaper per token. It
reasons far more.

### Supabase — migrations 0004–0007 applied to nvdkhatenkjmbyudwbgm

- `0004` relaxed `difficulty` to 1–5 and added `status`. `bench sync` had **never
  worked** — the check capped at 3 while the dataset has 35 items above it, so
  every benchmark table was empty.
- `0005` narrowed anon reads to `taste_ballots`/`taste_winrates`.
- **`0006` fixed a hole `0005` opened.** `taste_ballots` is a plain SELECT over
  one table, so Postgres made it auto-updatable; it was `security_invoker =
  false`, so DML ran as owner and bypassed RLS; and Supabase grants anon
  INSERT/UPDATE/DELETE by default. Anyone with the publishable key could have
  deleted the entire ballot record. Revoked to SELECT plus DO INSTEAD NOTHING
  rules. **Check `information_schema.views.is_updatable` on any new view.**
- `0007` constrains anon inserts to roster models. Note: the obvious
  `exists (select 1 from models m where m.id = taste_votes.model_a)` form
  silently rejects everything — the correlated outer reference does not bind.
  Use `IN (subquery)`.

### The admission gate — `bench pilot`

`pnpm bench pilot --file <candidates.yaml> --budget <usd> [--mock]`. Stage 0 is
free (the validate checks above); Stage 1 runs a **ceiling** model and a mid
model and rejects if both score ≥ 90 — ceiling-first, so items survive roster
turnover rather than becoming a small-model detector. Costs **~$0.30/candidate**
for judged items (a two-seat panel per model), not the $0.004 first estimated.
Stage 2 (is the low scorer actually wrong, or is the grader?) is **not built**.

### Run 2026-07-v2.1 — complete, and mostly a tie

14 models × 184 questions, methodology **v2** (corrected graders, refreshed
roster — the v3 gate/craft split in `docs/V3-PLAN.md` is not built, hence the
id). All 14 at 184/184, zero empty answers, 3 incidents (Fable 5
`content_filter` on nutrition items — reproducible model behaviour, not
transport). 630 answers judged, **0 unjudged**, 73 flagged (11.6%).
Candidates $26.93 + judging $14.19.

**The board says the top three are 96.0, 96.0, 96.0. They are tied, and
`analyze` now proves it.** Per-model CIs on the board are *marginal*, so they
neither confirm nor refute an ordering. Every model answers the same items, so
the comparison must be **paired** — resample the per-item score *differences*.
Of 13 adjacent pairs, exactly **one** is genuinely ordered (qwen3.7-max >
mistral-large, P=0.951). The top three sit within 0.05 points at P≈0.52.

The one defensible "best" claim: on the **35 frontier items** (difficulty ≥ 4 —
a pre-declared column, not a post-hoc slice) **Grok 4.5 leads at 98.6 and
separates from GPT-5.4 Mini at P=0.975**, and from Gemini 3.1 Pro, Terra Pro
and Gemini 3.6 Flash. It does *not* separate from GPT-5.6 Sol Pro (P=0.924).

Never quote an ordering off the overall column without checking
`analysis.separation`. A 0.01-point lead is not a result.

**Statistical ties do not chain, and the site now depends on this.**
`analysis.separation` holds **all** pairs (91 for 14 models), not just adjacent
ones, because "A ties B" and "B ties C" says nothing about A vs C. The first
cut of this computed places by walking the adjacent chain and produced a
**twelve-way tie for first** — Qwen 3.7 Max, 5.3 points off the lead, sharing
first place with GPT-5.6 Sol Pro, which beats it directly at P=1.000. Rank is
`1 + count of models proven better`, over the full matrix.

Two consequences worth knowing before touching `analyze.ts`:
- Places are **not monotonic in score**, and that is correct, not a bug. A model
  with a wider spread is harder to prove worse, so it can hold a better *place*
  than a model above it on points. That is why the board's `#` column stays
  positional and only the tied-for-first group is marked; the full places table
  belongs on `/methodology`, where it can be explained.
- Each pair is seeded from `hash(seed:scope:a:b)`, not one shared stream.
  With a shared stream a pair's p-value depends on how many pairs were drawn
  before it — `qwen > mistral` read 0.951 adjacent-only and 0.937 inside the
  full matrix. It is genuinely borderline (0.941 seeded per pair), so **no
  adjacent pair on this run clears 0.95**, while 48 of 91 pairs overall do.

### Where the dataset actually stands

- 102 active items, **64 carry any signal**, `effectiveItems` (inverse Herfindahl
  of variance share) is **24.2**. You are paying for 102 and running about 24.
- **33 active items are scored 100 by every one of 14 models.**
- Judged answers scoring exactly 100: **50%**, against a target of <35%. Active
  all-perfect 32% against a target of ≤15%. Both barely moved from v2 (35%/52%)
  — because the *content* did not change. Scoring mechanics are no longer the
  lever; authoring harder items is.
- `analyze` emits `activeWithSignal`, `effectiveItems`, per-item `varianceShare`,
  `separation`, and `referenceSuspect`. On this run `referenceSuspects` is
  **empty** — `nutr-036`, the one v2 suspect, is no longer flagged by the newer
  roster. Re-read it before assuming it is fixed.

### Open items

- **Author the v3 content.** The admission gate is built and the ratchet is
  measured; 33 all-perfect actives are waiting to be demoted and replaced.
- 159 of 184 items have no `failingAnswer`, so their graders are untested
  against a wrong answer. 50 still score 100 on bare keyword stuffing.
- `bench sync` is unblocked but never yet run successfully end to end.
- 73 flagged judge disagreements in this run (81 in v2) await human review.
- `data/taste/votes.ndjson` now holds all **26** ballots, pulled from the live
  table — `bench taste-archive` itself still needs `SUPABASE_SERVICE_ROLE_KEY`,
  which is not in `.env`. 26 ballots across 3 sessions is not a ranking.
- Branch `claude/cookingbench-code-review-70c3hx` is ~25 commits ahead of the
  deploy branch. **Database changes are live; code changes are not.**
