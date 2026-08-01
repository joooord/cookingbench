# CookingBench v3 — plan

> **SUPERSEDED (2026-07-30).** This blueprint is source material for, and is
> superseded by, `docs/methodology/CookingBench-methodology-first-master-plan.md`
> (Revision 3, frozen — sha256 sidecar). Where the two conflict, the master plan
> governs: in particular this document's Gate/Craft/Taste tier design, its
> "start collecting taste volume now" sequencing and its `bench pilot` admission
> step are all replaced (the master plan defines seven never-blended evidence
> layers, pauses ballot collection for the Tasting Flight rebuild, and disables
> `bench pilot` under the no-run rule M0.1). Do not execute the sequencing below.

Written 2026-07-29, after the grader audit. The goal for v3 is a change of
subject, not just a change of difficulty: **the leaderboard should rank cooking
judgement and flavour, with arithmetic as a gate rather than a differentiator.**
Models must still get conversions right — but being good at conversions should
not be how you win.

## Where v2 actually stands

Measured over the 102 active items of run `2026-06-v2`:

| | |
|---|---|
| active items with zero variance (every model identical) | **36 / 102 = 35%** |
| active items carrying real signal (sd > 5) | 54 / 102 = 53% |
| share of all item variance from the top 10 items | **54%** |
| adjacent leaderboard pairs statistically separated | **0 / 12** |

And the discrimination comes from the wrong place:

| grader | share of active items | share of variance |
|---|---|---|
| keyword | 22% | **52%** |
| llm-judge | 44% | 28% |
| numeric | 33% | 12% |

The keyword grader was the most fragile component in the system — it produced
ten false zeros in the published run — and it was carrying half the ranking.
That is now fixed, but the structural point stands: **a fifth of the items, run
through the most brittle grader, decided the board.**

Splitting the active set the way the v3 structure proposes:

| tier | items | mean | mean sd | dead items | share of variance |
|---|---|---|---|---|---|
| conversions + quantities | 18 | 99.2 | 2.33 | **15 / 18** | **2.5%** |
| everything else | 84 | 90.0 | 11.74 | 21 / 84 | 97.5% |

Two whole categories — the two the homepage leads with — are 18% of the active
set and 2.5% of the signal. Demoting them out of the ranking costs almost
nothing and buys an honest structure.

Difficulty labels are also not carrying information: label 3 averages 92.1,
label 4 averages 90.7, and only 5 items are labelled 5. `frontier` is computed
off that label.

## The v3 structure

Three tiers, reported separately, never blended.

**1. Gate — "can it do the arithmetic".** Conversions, quantities & scaling, and
the settled food-safety facts. Not part of Overall. Reported as a single
percentage with an expectation of 100, and a visible flag on any model below
~97%. This is the "must be good at conversions too, obviously" tier: failing it
is disqualifying, passing it earns nothing. Saturation here is a feature, so
these items stop needing the de-saturation ratchet at all.

**2. Craft — the ranking.** Technique diagnosis, flavour construction,
substitution under compounding constraint, recipe generation, and the
non-linear/modelling parts of nutrition and scaling. Overall is the mean over
this tier only. Judged-first, with deterministic checks used narrowly.

**3. Taste — the human axis.** Unchanged in principle, but it needs volume
before it can be presented as a ranking (see below).

This is a bigger change than a dataset refresh: `Overall` stops meaning "mean
over active" and starts meaning "mean over craft". Version it as methodology v3
and keep v2 artifacts readable, as v1 was kept.

## What to author

The healthiest thing in the dataset is `recipe-generation`: 20 items, **zero**
dead, mean sd 14.46. Open-ended, judged, constrained. That is the shape that has
not saturated, and v3 should be mostly that shape. Target roughly 120 craft
items, of which at least 80 carry signal.

Archetypes, chosen because they need a causal model of cooking rather than
recall — models bluff confidently on all of these:

1. **Non-linear scaling.** Pan geometry and depth, evaporation rate, why
   leavening and seasoning and thermal mass scale differently, why a 2 kg joint
   is not twice a 1 kg joint. Numeric with bands; models default to linear.
2. **Yield and shrinkage chains.** Raw → cooked weight, how per-100 g nutrition
   moves, trim and bone-out yields, reduction ratios. `numeric-multi`, errors
   compound.
3. **Preservation and cure safety.** Brine percentage, pH targets, nitrite ppm,
   water activity, safe fermentation temperatures. Tight numeric bands plus trap
   variants. Genuinely dangerous to get wrong and thinly represented in training
   data — the highest-value safety content available.
4. **Compounding substitutions.** Swap the flour *and* the fat *and* the sugar;
   hydration, structure and browning interact. Judged.
5. **Diagnosis from symptoms.** "It came out like this, here is exactly what I
   did" → rank the causes by probability and say how to test each. Judged
   against a reference ranking. This is the single best discriminator available:
   it cannot be answered by recall.
6. **Simultaneous service.** Four dishes, one oven, one hob, on the table hot at
   8pm. Judged, plus deterministic checks on oven-temperature conflicts and
   total oven-minutes against elapsed time.
7. **Recipe critique.** A real published recipe with one embedded error — find
   it and say why. The error is objective, the reasoning is judged.
8. **Flavour construction under absence.** Build a dish around an ingredient
   with a named absence (no acid, no allium, no heat, no browning) and justify
   the balance. Judged. This is the "best cook" axis in precision form, and the
   closest precision analogue to what the taste test measures.
9. **Order of operations.** When to season, when to rest, what must happen
   before what and why. Judged.
10. **Locale and equipment reality.** Gas marks, AU tablespoons, induction vs
    gas behaviour, domestic oven recovery time. Keep a handful — they are cheap
    and they still catch real failures — but as gate items, not craft.

## Grader strategy

**Retire the keyword grader from constraint checking on open-ended items.** The
whole bug class it produced — a correct answer punished for naming the thing it
tells you to avoid — comes from matching forbidden terms against free prose. The
structural fix is to scope constraint checks to the **ingredient list**: models
reliably emit an ingredients block, and a forbidden ingredient *in the
ingredients* is a violation while a mention in prose is discussion. That removes
the failure mode instead of patching the regex around it.

Keep the keyword grader only where the phrase *is* the finding — dangerous
advice in a trap item. Even there, the reference-answer assertion added to
`bench validate` now guards it.

**Rebalance toward judged items.** Judged items carry 29% of craft variance
today; target ≥60% in v3. Deduction grading has a verbosity bias, which is
exactly what the taste axis is there to counterweight — but that argument only
holds if the taste axis has data.

**Set difficulty empirically.** After each run, recompute the label from
observed discrimination rather than trusting the hand-assigned one. A `difficulty`
that does not predict score is not a difficulty.

## Targets for v3

| metric | v2 | v3 target |
|---|---|---|
| craft items all-perfect | 35% | ≤ 15% |
| craft items with zero variance | 21 / 84 | 0 (demote after two consecutive runs) |
| share of variance from the single largest item | 7.8% | ≤ 5% |
| share of craft variance from judged items | 29% | ≥ 60% |
| adjacent leaderboard pairs statistically separated | 0 / 12 | ≥ 4 |

The last one is the honest headline. Until some adjacent pairs actually separate,
the board should keep showing the ± and should group statistically tied models
rather than implying a strict 1–13 order.

## Taste axis

The live table holds **23 votes** — and the committed archive holds 6, so the
snapshot is stale. `MIN_BATTLES` is 5, which is far too low: a Bradley-Terry
rating on five battles has a confidence interval wider than the entire spread of
the board.

- Raise `MIN_BATTLES` to ~20 before a model appears in the standings.
- Target ~1,000 total ballots (≈ 150 battles per model across 13 models) before
  the Taste Board is presented as a ranking rather than a curiosity.
- Run `bench taste-archive` on a schedule, not by hand — the ballots are meant
  to be the permanent record and they are currently 17 votes behind.
- Fix the presentation bias first: answers render with `whitespace-pre-wrap`, so
  a model that replies in markdown shows up as raw pipe soup next to an
  opponent's clean prose. Human voters are being asked to judge flavour and
  shown a formatting difference. Render a safe markdown subset before
  collecting votes at volume, or the whole corpus inherits the bias.

## Sequencing

1. ~~Fix the grader; assert reference answers in `bench validate`.~~ Done.
2. ~~Stop paying models for empty answers; cap and record judging spend.~~ Done.
3. Render markdown in the duel, raise `MIN_BATTLES`, start collecting taste
   volume — it accrues in the background while the dataset work happens.
4. Re-run `bench analyze` on corrected scores to get an honest demotion list.
   The current one is unusable: 82 of its 115 recommendations were for items
   already demoted, now fixed but not yet re-run.
5. Author the craft items. This is the long pole and the only one that actually
   moves the benchmark.
6. Cut over to methodology v3: split Overall into gate + craft, keep v2
   artifacts readable, note the v2 grader erratum on the methodology page.

A benchmark that publishes its own corrections is more trustworthy than one that
never needs to — which is the argument this project already makes about its
dataset being fully public.
