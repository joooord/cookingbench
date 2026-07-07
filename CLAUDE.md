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
pnpm bench flagged --run <id>        # export judge-disagreement worksheet (data/runs/<id>/flagged-review.md)
git add data/runs/<id> && commit && push   # publish; site picks newest leaderboard by generatedAt

# LLM taste panel (independent of the precision run above; never blended):
pnpm bench taste-estimate --run <id> [--pairs-per-question N]
pnpm bench taste-judge --run <id> --budget <usd> [--pairs-per-question N] [--mock]
#   pairwise A-vs-B duels on the run's subjective answers; taste calibration
#   gate runs first; artifacts in data/runs/<id>/taste-panel/ (commit to publish
#   the /taste critics' table). Reproducible; feeds the same Bradley-Terry math.
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
7. **Taste critics' panel** (v3, `packages/runner/src/tastejudge.ts`): an LLM
   "team of judges" that blind-tastes the SAME paired answers as the crowd, as a
   separate signal — never blended with the human vote or the precision score.
   Pairwise A-vs-B preference (prompt ignores length/formatting to fight the
   deduction-grading verbosity bias); each duel judged twice with positions
   swapped (flip-flop ⇒ tie) to cancel position bias; a 5-provider panel that
   excludes BOTH contenders' providers so ≥2 seats always remain; deterministic
   balanced pair planning (reuses `providerOf`/`fnv1a` from judge.ts and
   `mulberry32`/`computeTasteRatings` from core). Its own calibration gate
   (`taste-anchors.yaml`: every seat must prefer a good answer over a
   plainly-worse one in both positions). Verdicts live ONLY in committed
   artifacts (`data/runs/<id>/taste-panel/`), never in Supabase — reproducible
   from git. Surfaces on `/taste` as a second table via `getLatestTastePanel()`
   (skips `mock:true` summaries); homepage untouched until a paid run proves it.

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

## State as of 2026-07-07 (v3 content + taste-panel machinery landed, unrun)

- Published runs unchanged: `2026-06-v1` (v1, saturated, immutable) and
  `2026-06-v2` (13 models × 184 questions, panel-judged, spread 96.4–82.0).
  These artifacts are NOT re-graded; the v3 dataset only affects future runs.
- **v3 dataset ratchet (done, awaiting a paid run):** 36 saturated active items
  demoted to basics (33 analyzer-flagged deterministic + flav-003/009/011
  llm-judge, demoted manually — the analyzer now does this itself under
  judge-v2). Three negative-discrimination graders fixed: flav-014 keyword →
  llm-judge, safe-016 broader discard synonyms, subs-021 forbidden list dropped
  (post-term negation like "dairy butter is out" was zeroing correct answers —
  a fresh instance of the keyword-trap lesson). 36 new `addedIn: v3` items
  authored in the proven discriminating styles, refilling the active set to 102
  (dataset now 220 total). All covered by `packages/runner/test/dataset.test.ts`
  (perfect-chef = 100, non-vacuous, grader-audit regressions).
- **Taste critics' panel (machinery done, unrun):** see Methodology point 7.
  `bench taste-judge --mock` exercises the whole chain for $0; the first PAID
  taste-panel run + its calibration are a future session's job.
- **Analyzer upgraded:** demotes saturated llm-judge items under judge-v2,
  excludes transport anomalies from discrimination, and emits a new
  `grader-audit` verdict for mis-keyed deterministic graders.
- **Housekeeping:** `bench flagged --run 2026-06-v2` wrote the 81-item
  `flagged-review.md` worksheet (the expert-layer on-ramp); methodology page
  de-staled (taste test is live) and gained a critics'-panel paragraph;
  `bench validate` now prints per-category active/basics/retired counts.
- Open items for a future session:
  - Run the v3 benchmark (`2026-07-v3` or similar) + the taste panel; then
    `bench analyze` to see whether v3 hit the targets and to produce the next
    demotion list. Two taste seats (Gemini 3.1 Pro, Grok 4.3) are unproven as
    judges — the taste calibration gate screens them before any paid vote.
  - Targets before v3 run: active all-perfect 35% (goal ≤15%), judged-100s 52%
    (goal <35%). The v3 authoring is the lever aimed at these.
  - One answer unjudged after prose-not-JSON from a judge seat (kimi-k2.6 ×
    flav-005) — `bench judge --run 2026-06-v2` retries it (v2 artifact only).
  - 81 flagged v2 disagreements now collated in flagged-review.md for the
    promised expert layer.
- Spend so far: ~$55.6 of OpenRouter credits (both v2-era runs). No spend this
  session — all v3 work is content, machinery, tests and docs. The user tops up
  willingly in ~£10 increments and cares that models get a *fair* shot.
