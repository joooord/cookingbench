# The Objectivity Illusion: How a Deterministic Grader Manufactured a Model Ranking

*Paper 1 of the CookingBench programme — an autopsy of run `2026-07-v2.1`*

Draft, 2026-07-30. All evidence is drawn from artifacts committed to this
repository. Every quantitative claim below names the file it came from.

---

## Abstract

We audit a published AI benchmark leaderboard — 14 models × 184 cooking
questions, run `2026-07-v2.1` — and show that its ordering is an artefact of the
scoring instrument rather than a measurement of the models. Nearly half of all
score variance across the 102 ranked items (47.5%) comes from 22 keyword-matched
items, the least reliable component. Twelve active items are *negatively*
discriminating: models that score better overall score worse on them. Removing
only those twelve permutes every position in the top four. Removing the eleven
items whose forbidden vocabulary is unavoidable given the question moves seven of
the top eight.

The mechanism is one unfixable property of string matching: it cannot
distinguish *mentioning* an ingredient from *using* it. We identify 38 answers
where a two-seat LLM judge panel scored the answer at 90 or above and a
deterministic constraint check on the same answer scored it 0, and we read every
occurrence of every flagged term in all 38. Not one is a genuine violation. They
are label-check warnings ("check packaged tomatoes for added onion"),
cross-contamination advice ("don't use the grinder that handled your habanero
mix"), substitution instructions ("replace the Parmesan with nutritional
yeast"), and in one case a viscosity simile ("the consistency of thick honey" in
a vegan traybake). The instrument punished the answers that did the most safety
work.

Counter-evidence is reported at equal strength. Only 8 of 102 active items
discriminate strongly, and the effective item count — inverse Herfindahl of
variance share — is 24.2. The LLM judge, widely assumed to be the soft
component, is the healthiest part of the instrument: 30.1% of variance across 45
items with only 2 saturated, against 26 of 34 for the numeric grader. And the
largest single variance contributor is not a keyword item but a numeric one
whose ground truth is contestable.

The finding is **fragility, not a corrected ranking**. Both the published and
the de-noised orderings sit entirely inside a five-way statistical tie the run's
own paired bootstrap already reports. We built the defective graders ourselves.
This is one benchmark and one run.

---

## 1. Introduction

Leaderboards are read as measurements. A table with two decimal places, a
reproducible pipeline and committed artifacts carries an implicit claim: that
the ordering reflects something about the models. This paper is a worked
counter-example, from a benchmark we built, using numbers we published.

Cooking is an unusually good domain for this argument. A cooking answer carries
two layers at once. There is a **verifiable layer** — 176.7 °C is not 200 °C, an
Australian tablespoon is 20 ml, poultry stuffing must reach 74 °C — where a
deterministic grader is genuinely appropriate. And there is an **aesthetic and
judgement layer** — whether a blend tastes "big and Mexican", whether a cheese
board sings with vintage port — where it plainly is not. Most domains blur these
together. Cooking lets you put them in the same question and watch which
component of the instrument does the damage.

That is the setup for the finding. The verifiable-looking layer is where the
authors reached for deterministic grading, because deterministic grading feels
like rigour. It is precisely there that the instrument broke, and it broke in a
direction that penalised competence.

Related work on benchmark contamination, construct validity and LLM-as-judge
reliability belongs here and is not yet written:
[CITATION NEEDED: benchmark saturation and construct validity in LLM evaluation]
[CITATION NEEDED: LLM-as-judge reliability, self-preference and position bias]
[CITATION NEEDED: item response theory applied to LLM benchmarks].

---

## 2. The instrument

**Dataset.** 184 questions across eight categories, in `data/questions/*.yaml`.
Each carries a `status`: 102 **active** items count toward the Overall score, 82
**basics** items are kept as a saturated regression gate and excluded from the
ranking. Every question ships a hand-written `referenceAnswer`, and some a
deliberately wrong `failingAnswer`.

**Graders.** Four types, distributed across the 102 active items as `llm-judge`
45, `numeric` 34, `keyword` 22, `range` 1. The `keyword` grader scores by
required synonym groups (one hit per group) plus a forbidden-term list; any
non-negated forbidden term zeroes the item. The `llm-judge` grader blends a
panel score with optional deterministic `constraintChecks` — themselves keyword
matchers — at a default 0.7 judge / 0.3 constraint.

**Judge panel.** Three seats (`claude-opus-4.8`, `gpt-5.5`, `grok-4.5`); two
score each answer; a seat never scores its own provider. Judges list faults by
severity and code maps severities to deductions from 100. A calibration gate
runs first: every seat must reproduce 12 hand-scored anchors at MAE ≤ 10. On
this run the seats posted MAE 8.5, 3.3 and 6.0
(`data/runs/2026-07-v2.1/calibration.json`).

**Scoring.** Overall is the plain mean over active items, with bootstrap 95%
confidence intervals per model. Critically for this paper, `analyze` also
computes **paired** separation over all 91 model pairs by resampling per-item
score *differences*, because every model answers the same items.

**The run.** `2026-07-v2.1`, 14 models × 184 questions = 2,576 answers
(`data/runs/2026-07-v2.1/scores.json`, 2,576 records). All 14 models completed
184/184. 630 answers were judged, 0 unjudged, 73 flagged for cross-judge
disagreement > 15 (11.6%). Candidate answers cost $26.93, judging $14.19
(sums over `responses/*.json` and over judge verdicts in `scores.json`).

**The board as published** (`data/runs/2026-07-v2.1/leaderboard.json`): GPT-5.4
Mini 96.0, GPT-5.6 Sol Pro 96.0, Grok 4.5 96.0, GPT-5.6 Terra Pro 95.4, Claude
Fable 5 94.1, then nine more down to Llama 4 Maverick at 84.5.

---

## 3. Methods

Everything here is a re-analysis of committed artifacts. No model was called, no
answer regenerated, no published score altered. Run artifacts are immutable by
project rule; a grader fix never rewrites a published run, it is documented in
an erratum and carried by the next run.

**Item statistics.** `mean`, `sd`, `allPerfect`, `varianceShare` and
`discrimination` are read from `analysis.json` and were independently recomputed
from `scores.json` as a check. `discrimination` is the mean of the top seven
models by overall score minus the mean of the bottom seven
(`packages/runner/src/analyze.ts`). `varianceShare` is an item's population
variance over the 14 models as a fraction of the active-set total.
`effectiveItems` is the inverse Herfindahl index of those shares: equal shares
over *n* items gives *n*, one item holding everything gives 1. The committed
value, 24.2, is computed from `sd` rounded to one decimal; recomputing from raw
scores gives 24.0. We quote the committed figure.

**Contradiction detection.** For every judged answer carrying a deterministic
`constraintCheck` (280 of them) we compared the two components. A
*contradiction* is `judgeScore ≥ 90` with `constraintScore = 0` — the panel
found the answer essentially faultless and the string matcher found it
disqualifying. 38 qualify.

**Manual classification.** For each of the 38 we extracted every occurrence of
every flagged term from the stored answer text and read it in context, marking
each as a **use** (the term names something the answer recommends) or a
**mention** (warning, label check, cross-contamination advice, substitution
instruction, comparison, simile, or quotation of the user's own words). An
answer counts as a false positive only if *no* occurrence is a use. This is a
judgement made by the authors on their own dataset; §5 treats it as a threat.

**Counterfactual boards.** We recomputed the Overall column under four
alternative item sets and one alternative scoring rule, holding everything else
fixed. Ranks are positional. No new bootstrap was run; separation is quoted
from the committed `analysis.separation`, which contains all 91 pairs.

**Reproduction.** Every number below can be regenerated from
`data/runs/2026-07-v2.1/{scores,analysis,leaderboard,calibration,config}.json`,
`data/runs/2026-07-v2.1/responses/*.json`, and `data/questions/*.yaml` at commit
`055ac90^` for the dataset as it stood at run time.

---

## 4. Results

### 4.1 The instrument is much thinner than it looks

102 active items produce an effective item count of **24.2**
(`analysis.json:effectiveItems`). 42 active items have zero variance
share — every model scores identically. 33 are perfect for all 14 models
(`activeAllPerfect`). Only 64 have a standard deviation above 1
(`activeWithSignal`).

Variance is extremely concentrated. The single largest item holds 9.1% of it;
the top three hold 25.4%; the top six hold 41.6%; the top ten hold 54.6%. On a
board where the top three models are separated by 0.05 points, a handful of
items decide the ordering. That is the precondition for everything that follows:
you do not need a *biased* grader to manufacture a ranking. You need a *noisy*
one, and a dataset thin enough that the noise exceeds the signal.

### 4.2 Where the variance comes from

Over the 102 active items (`analysis.json`, recomputed from `scores.json`):

| grader | items | share of variance | variance per item | disc < 0 | disc = 0 | all-perfect |
|---|---:|---:|---:|---:|---:|---:|
| keyword | 22 | 47.5% | 2.16 | 6 | 6 | 5 |
| llm-judge | 45 | 30.1% | 0.67 | 6 | 3 | 2 |
| numeric | 34 | 17.1% | 0.50 | 0 | 27 | 26 |
| range | 1 | 5.3% | 5.34 | 0 | 0 | 0 |

Read the first two columns together. Keyword items are 22% of the ranked set and
carry 47.5% of the spread — 3.2× the variance per item of a judged item. Nearly
half of what separates these models comes from the component with the weakest
claim to validity.

The `disc = 0` column needs care and the distinction matters: for `numeric`,
27 of 34 items have exactly zero discrimination because they are *saturated*
(26 are perfect for all 14 models), not because they are perverse. For
`keyword`, 6 items are *strictly negative*: better models do worse.

### 4.3 Central exhibit: `flav-014`

The item asks for a taco seasoning with zero chilli heat for a guest who gets
stomach pain from any capsaicin. The user's own message reads: *"Last time half
of us were crying from my habanero blend."*

At run time the item was graded entirely by keyword, and its forbidden list
included the bare terms `habanero`, `cayenne`, `chili powder`, `chilli powder`
and `hot sauce` (dataset at `055ac90^`, `data/questions/flavor-pairing.yaml`).
`habanero` is a word that appears in the prompt. It is also a word the correct
answer cannot avoid, because the right advice is: keep your habanero blend, make
it separately, and do not share the grinder.

**Nine of fourteen models scored zero.** From
`data/runs/2026-07-v2.1/scores.json` and the stored answers:

- `gpt-5.6-sol-pro` — zeroed on `habanero`, for: *"don't use the grinder, jar,
  spoon, or board that handled your habanero mix."* That is the
  cross-contamination advice the item exists to reward.
- `claude-opus-5` — zeroed on `habanero` and `hot sauce`, for *"make your
  habanero blend separately and put it out as a shaker, plus a bowl of hot
  sauce"* and *"don't grind the habanero in the same pan or mill without washing
  it — trace capsaicin is enough to hurt someone who's genuinely reactive."*
- `kimi-k3` — zeroed on `cayenne` and `chilli powder`, for *"Some 'chilli
  powder' blends and hot paprikas sneak in cayenne."* This one is decisive:
  the sentence carries no negation cue at all, so no improvement to the matcher
  can rescue it. Recommending an ingredient and warning against it are the same
  string.
- `qwen3.7-max` — zeroed on `cayenne`, for *"Do not use standard store-bought
  'chili powder,' as it is a blend that almost always contains cayenne pepper."*

Eight of the nine zeroes were triggered by phrases that are correct advice. The
ninth, `llama-4-maverick`, put *"2 tablespoons chili powder"* in the blend and
deserved to fail — the matcher was right there, but for a reason it could not
distinguish from the eight it got wrong.

Now the part that indicts the measurement rather than the item. `gpt-5.4-mini`
scored **100**. Its answer contains the word "habanero". It survived because it
wrote the word inside a markdown bullet list under the heading `Skip:`, and the
grader's negation rule is a sentence-window lookback — a bullet list has no full
stop, so the cue "Skip" scopes every bullet beneath it. `gpt-5.6-terra-pro`
scored **0**. It made the same "leave out all chilli powders — including
cayenne, chipotle, ancho" point and survived that, then added one more sentence:
*"For everyone else, serve your habanero blend, hot sauce, sliced jalapeños,
etc. separately — and use a clean spoon so her portion stays genuinely
heat-free."*

That sentence is strictly additional correct advice, and it cost 100 points.
`gpt-5.4-mini`, the model that scored 100, gives no cross-contamination advice
at all, and hedges with *"sweet paprika or smoked paprika if she tolerates
it"*. On the item's own rubric — the one written later, when it was converted to
judge grading — the 100 is the weaker answer.

`flav-014` posted discrimination **−9.5** and the second-widest spread on the
board (sd 45.4, 9.0% of all active variance).

The item has since been rewritten: converted to `llm-judge`, with the forbidden
list narrowed to quantity-anchored recipe lines (`tsp cayenne`, `tablespoons
chili powder`) that only ever occur in a use, plus `judgingNotes` stating the
warning-versus-use distinction explicitly. The repair is itself evidence for the
argument: the fault could not be fixed inside the keyword paradigm, only by
leaving it. Full detail is in `docs/audit/anti-correlated-items.md`.

### 4.4 The failure generalises: 38 contradictions

`flav-014` is not a one-off, and the audit that found it — which selected items
by negative discrimination — could not have found the rest, because the rest
discriminate positively.

Of 280 judged answers carrying a deterministic constraint check, **38 have a
judge score ≥ 90 and a constraint score of 0**. We read every occurrence of
every flagged term in all 38. **None is a genuine use.** They fall into five
shapes:

**Label-check warnings.** `gpt-5.6-sol-pro` on `rgen-012` (low-FODMAP pasta, no
onion, no garlic) mentions onion three times: *"with no onion or garlic added"*,
*"How the flavour is built without onion or garlic"*, and — the one that fired —
*"check all packaged tomatoes, tamari, and gluten-free pasta for added onion,
garlic, inulin, or chicory root."* Five models were zeroed on `milk powder` in
`rgen-019` (severe dairy allergy, wild camping) for warning that chorizo and
flavoured couscous sometimes contain it.

**Cross-contamination advice.** `claude-opus-5` on `rgen-015` was zeroed on
`sesame` for *"pita, lavash, and Turkish pide are frequently sesame-topped or
baked on sesame-dusted trays"*, and for noting that loose sumac *"can also sit
next to sesame in shared scoops."*

**Substitution instructions.** On `subs-020` (a kosher and sesame-safe rewrite
of a grandmother's Parmesan-heavy meatball recipe) nine models were zeroed on
`parmesan` — for saying to replace it. `qwen3.7-max`: *"Substitute the parmesan
with nutritional yeast."* `gpt-5.4-mini` was zeroed for *"Serve grated parmesan
on the side only for guests who can eat dairy, after the kosher guests..."* —
the same shape as `flav-014`'s habanero sentence, in a different category,
under a different grader, on the same run. Three models on `rgen-001` (strictly
dairy-free pancakes) were zeroed on `buttermilk` for the standard technique:
*"let sit 5 minutes to curdle slightly (this is your dairy-free
'buttermilk')."*

**Comparisons and similes.** `gemini-3.6-flash` on `rgen-004` (tofu scramble)
was zeroed on `egg` while both judge seats explicitly certified the recipe
contained no eggs — the matches were *"a hint of savory egg-like flavor"* and
*"mimic scrambled egg curds"*. `deepseek-v4-pro` on `rgen-017` (vegan, nut-free,
banana-free traybake) was zeroed on `honey` by a single sentence: *"It should
be the consistency of thick honey."*

**Domain distinctions the matcher cannot see.** `claude-opus-5` on `rgen-020`
was zeroed on `coriander` after writing *"Zero coriander anywhere"* and
*"Coriander watch: dill and parsley only"* — the trigger being its correct
observation that *"Ground coriander seed is a different compound and usually
fine for soap-taste people."* Two models were zeroed on `onion` in `rgen-012`
for using spring-onion green tops, which are low-FODMAP precisely because the
fructans concentrate in the white bulb. `claude-sonnet-5` was zeroed on
`crushed garlic` for garlic-infused oil, the canonical low-FODMAP technique.

One further shape deserves its own note. `gpt-5.6-terra-pro` on `rgen-015` wrote
*"It is sesame- and tree-nut-free as written"*. English coordination distributes
the suffix; the matcher requires it adjacent. Correct grammar was scored as an
allergen.

### 4.5 The mechanism: forbidden terms the question itself supplies

The proximate cause is a property of the dataset that can be checked
mechanically. At run time, **16 of the 28 questions carrying a forbidden list
contained at least one of their own forbidden terms in the prompt** — 15 of them
active. The list: `flav-014` (habanero), `rgen-004` (egg), `rgen-007`
(cilantro), `rgen-012` (onion), `rgen-014` (white rice, white potato),
`rgen-015` (sesame, broil), `rgen-016` (hob), `rgen-017` (banana), `rgen-019`
(coolbox), `rgen-020` (coriander, wok, stir-fry), `subs-020` (parmesan, sesame),
plus four dangerous-premise traps and one basics item.

Five of these — four active traps and one basics item — are deliberate and
defensible: on a premise trap the forbidden phrase *is* the user's wrong claim
("dodged a bullet", "kills everything") and the correct answer must quote it to
refute it. The project's `bench validate` already warns on exactly that case
(`packages/runner/src/cli.ts`, `checkReferenceAnswers`).

The other eleven are the defect, and the validator's own comment explains why it
misses them:

> *Single-word ingredient constraints are fine — "write it without onion" is
> supposed to name onion — so only multi-word phrases on trap items are
> flagged.*

That reasoning is right about the *reference* answer and wrong about the *model*
answers. "Write it without onion" does license naming onion — and on `rgen-012`
the grader then zeroed five models for doing it, every one of them with a judge
score of 90 or above. The guard was calibrated against the one answer the
authors wrote, not against the space of correct answers.

This is the same class the project already found once. Run `2026-06-v2` shipped
three questions whose own hand-written reference answers scored 0 against their
own graders, and on `subs-020` twelve of thirteen models were zeroed on the
constraint check, three of them while the judge panel scored them 100
(erratum, `apps/web/app/methodology/page.tsx`). A blocking check now makes
*that* impossible. `2026-07-v2.1` is the residue after the fix: the reference
answers all pass, and 38 model answers still do not.

### 4.6 Fragility: five boards from one run

Holding the run fixed and varying only which items count
(`data/runs/2026-07-v2.1/scores.json`, active items only):

| # | Published (102) | −12 anti-correlated (90) | −22 keyword (80) | judge component only (102) | −11 self-referential (91) |
|---|---|---|---|---|---|
| 1 | Sol Pro 96.04 | **5.4 Mini** 96.99 | Sol Pro 96.83 | Sol Pro 97.03 | Sol Pro 98.31 |
| 2 | 5.4 Mini 96.04 | **Terra Pro** 96.95 | 5.4 Mini 96.62 | **Terra Pro** 96.73 | **Terra Pro** 97.66 |
| 3 | Grok 4.5 95.99 | **Sol Pro** 96.89 | **Terra Pro** 96.41 | 5.4 Mini 96.39 | **Fable 5** 97.29 |
| 4 | Terra Pro 95.39 | **Grok 4.5** 96.26 | **Grok 4.5** 95.93 | **Fable 5** 96.15 | **Kimi K3** 97.22 |
| 5 | Fable 5 94.10 | Fable 5 95.03 | Fable 5 94.98 | **Grok 4.5** 95.29 | **5.4 Mini** 96.99 |
| 6 | Kimi K3 93.85 | Kimi K3 94.86 | Kimi K3 94.66 | **Opus 5** 95.05 | **Opus 5** 96.60 |

Dropping the twelve negatively-discriminating items permutes all four top
positions: Sol Pro 1→3, GPT-5.4 Mini 2→1, Grok 3→4, Terra Pro 4→2. Ranks 5 to 8
and 11 to 14 hold; ninth and tenth swap (Gemini 3.1 Pro and DeepSeek V4 Pro,
0.14 points apart as published). Dropping the eleven self-referential items is
more violent still: Fable 5 rises 5→3, Kimi K3 6→4, Opus 5 8→6, and GPT-5.4
Mini — first on one board — falls to fifth. Scoring judged items on the judge
component alone, discarding the constraint checks entirely, is the mildest
intervention and still moves Terra Pro 4→2, Fable 5 5→4, Opus 5 8→6, Grok 3→5.

**None of these is the true ordering, and we do not claim one is.** The run's
own committed paired bootstrap (`analysis.json:separation`, all 91 pairs)
reports a **five-way tie for first**: Sol Pro, GPT-5.4 Mini, Grok 4.5, Terra Pro
and Fable 5 are each proven worse than nobody. No adjacent pair on the active
board clears P = 0.95; the closest is Qwen over Mistral at 0.941. The
permutation happens entirely inside a group the statistics already say is
unordered.

That is the finding. The instrument reports 0.01-point gaps and the site renders
them as an ordering; the same run's separation matrix says the ordering is not
there; and the counterfactuals show it is not even stable under removing items
the instrument itself flags as broken.

The one ordering claim this run does support is on the pre-declared frontier
column (35 items at difficulty ≥ 4): Grok 4.5 leads at 98.6 and separates from
twelve of thirteen rivals, failing only against Sol Pro (P = 0.931). It is worth
noticing that this is the claim made on the *smaller* and *harder* subset, not
the headline column.

### 4.7 Failing open is worse than failing closed

Everything above is the grader rejecting correct answers. The same class also
accepts a dangerous one. On `safe-021`, a difficulty-4 stuffing-temperature trap,
`mistral-large-2512` scored **100** for:

> *"Yes, you can rest the turkey under foil now. The stuffing will continue to
> cook from residual heat and should reach a safe temperature of 165°F during
> the resting period."*

That is the carry-over-heat fallacy — the trap accepted. It scored 100 because
the first synonym group was satisfied by the "165°F" the user's own message
already contains, and the second by the bare word `continue` matching *"will
continue to cook from residual heat"*
(`data/runs/2026-07-v2.1/scores.json`; analysis in
`docs/audit/anti-correlated-items.md`). A food-safety grader whose pass
condition can be met by the hazard it is testing for does not merely fail to
measure — it launders the failure into a perfect score.

### 4.8 The largest single lever is a matter of opinion

The biggest variance contributor in the whole active set is not a keyword item.
`nutr-036` — *"Estimate the total kilocalories in a typical takeaway 12-inch
margherita pizza"* — is a `numeric` item with `expected: 850 kcal`, full credit
within ±200 and half credit within ±400. It carries **9.1%** of all active
variance.

The answers (`scores.json`): five models between 800 and 1000 (100 points), two
at 1100 (50), and seven between 1400 and 2200 (0) — including Grok 4.5 at 2200
and Terra Pro at 1500. The item's own reference answer states a band of
700–1050 kcal, narrower than the models' disagreement.

We take no position on the correct figure
[CITATION NEEDED: published nutritional data for 12-inch takeaway margherita
pizzas]. The point is structural: nine per cent of the instrument's
discriminating power rides on one authoring choice about a genuinely disputed
quantity, and the automated `referenceSuspect` detector does not flag it,
because it requires two thirds of the top-half models to score zero and only
three of seven did. The "objective" grader is not more objective here. It has
simply moved the subjectivity from the scoring to the answer key, where nothing
inspects it.

### 4.9 Counter-evidence, reported at full strength

Four findings cut against the paper's thesis and are not buried.

**Most items measure nothing at all, and that is a bigger problem than bias.**
Only **8 of 102** active items post discrimination ≥ 20: `subs-021` (42.9),
`safe-019` (35.7), `nutr-020` (28.6), `subs-012` (28.6), `tech-011` (22.9),
`rgen-009` (21.8), `rgen-013` (21.5), `flav-013` (20.9). If every grader defect
in this paper were fixed tomorrow, the instrument would still be running on
about two dozen effective items.

**The judge is the healthiest component.** Of the 33 active items perfect for
all 14 models, **26 are numeric, 5 keyword and only 2 judge-graded**. Judge items
hold 30.1% of variance across 45 items at the lowest saturation rate of any
grader; the seats passed calibration at MAE 8.5, 3.3 and 6.0 against hand-scored
anchors; cross-judge disagreement above 15 points occurred on 11.6% of judged
answers, a healthy rate rather than a collapsing one. The intuition that the LLM
judge is the soft, unreliable part of the instrument is not supported here.

**The instrument does sometimes work.** `flav-013` — a cheese board for a
gathering including a five-months-pregnant guest, mentioned in passing — posts
mean 55.1, sd 29.7 and discrimination +20.9, with the judge component alone
spanning 10 to 100. Every model noticed the pregnancy; the spread came from
whether they knew a *pasteurised* soft blue is still not safe. That is the
buried-constraint discrimination the item was designed for, and the judge found
it.

**But even that item is contaminated.** `flav-013`'s constraint check zeroed five
models, four of them falsely. `deepseek-v4-pro` scored **100 from both judge
seats** and landed at 50.0 for writing *"hard cheeses are generally fine, even if
unpasteurised, because their low moisture content discourages listeria"* — the
NHS position, stated correctly. `claude-opus-5` and `claude-fable-5` were zeroed
for the same sentence in other words. `claude-sonnet-5` was zeroed for a
near-identical warning, though its final 8.8 is roughly defensible on other
grounds: the judge gave it 17.5 for proposing a *pasteurised* blue as the fix,
which is the very error the item tests. Only `llama-4-maverick` earned its zero
outright, recommending Gorgonzola Dolce and Époisses without mentioning
pregnancy at all.

So the paper's designated counter-example is *itself* a demonstration of the
defect: `flav-013`'s judge half works, its string-matching half does not, and its
healthy +20.9 discrimination is a real signal and an artefact pointing the same
way by coincidence. That is the strongest available evidence that positive
discrimination does not certify an item as sound — and it is why the prior audit,
which selected items by *negative* discrimination, could not have found this.

---

## 5. Threats to validity

**We are auditing our own instrument.** Every grader criticised here was written
by the authors, and the mention/use classification of the 38 answers was
performed by the authors on their own dataset. The raw material is published —
every flagged occurrence is recoverable in context from
`data/runs/2026-07-v2.1/responses/` — but the classification is not blind and
has not been replicated by an independent reader.

**One run, one benchmark, one domain.** *n* = 14 models, 184 questions, single
sampling at temperature 0. The counterfactual boards are not independent
measurements but re-weightings of the same 2,576 answers. Nothing here
generalises to another benchmark without the same audit being done there.

**The counterfactuals are not corrections.** Removing items changes the construct
being measured, not just the noise: the "−11 self-referential" board removes
eleven long-context briefs, which are among the harder items, so the resulting
ordering rewards models that do well on what remains. We report the permutations
as evidence of *sensitivity*, not as competing estimates.

**Discrimination is a weak defect detector in both directions.** It is defined
against the overall ranking, which is itself contaminated by the defect —
circularity we have not escaped — and §4.9 shows it misses defects on positively
discriminating items entirely.

**The 38-contradiction count is a lower bound.** It is computable only where a
judge score and a constraint score coexist. On pure keyword items there is no
second opinion: 18 answers were zeroed on active keyword items, 9 of them on
`flav-014`; the other 9 look like genuine failures by weaker models on trap
items, but that is our reading, not a measurement.

**Judge scores are not ground truth.** We used `judgeScore ≥ 90` as evidence
that an answer is sound. Deduction grading has a known verbosity bias, and two
seats agreeing is not the same as being right.

**The run-time and current datasets differ.** `flav-014` and `rgen-004` were
repaired on 2026-07-30, after the run. Figures describing the run are computed
at commit `055ac90^`, figures describing the present state at HEAD; both are
labelled where it matters.

---

## 6. What this shows, and what it does not

**It shows** that a deterministic grading component that looks objective
produced 38 demonstrably wrong zeroes, carried a disproportionate share of total
variance, and that removing the items it damaged permutes the entire top four of
a published leaderboard. It shows the damage falls on a recognisable class of
behaviour — warning about hidden allergens, advising on cross-contamination,
naming what is being replaced — with the correlation between a model's mean
answer length and its contradiction count at ρ = 0.50 across 14 models.

**It does not show** that the de-noised ordering is correct. Both orderings sit
inside a five-way tie the run's own paired bootstrap reports. Anyone quoting
"GPT-5.4 Mini is really first" from this paper has misread it.

**It does not show** that the damaged models are better than the undamaged ones.
The per-model correlation between overall score and contradiction count is
ρ = 0.09 — essentially nil. This is not a systematic bias in favour of weak
models; it is a large, roughly arbitrary perturbation that becomes decisive only
because the underlying differences are smaller than it.

**It does not show** that deterministic grading is unsound in general. On the
verifiable layer — 176.7 °C, 20 ml, 74 °C — it is right, and the numeric grader
produced no negatively discriminating items at all on this run. The failure is
specific: deterministic grading of *natural-language constraint compliance*,
where the same string is written by the best answer and the worst.

**It does not show** that LLM judges are reliable — only that where the two
disagreed sharply here, the judge was right and the matcher wrong 38 times out
of 38. That is a comparison, not an endorsement.

---

## 7. Implications for benchmark design

**Mention and use are not separable by string matching, and no amount of
negation handling fixes it.** The project's negation matcher already handles
contractions, `X-free` compounds, sentence-window lookback and look-ahead. It
still cannot see *"check packaged tomatoes for added onion"* — an instruction to
detect the banned thing, containing no negation cue, semantically the opposite
of use. If a constraint is expressible only in natural language, grade it with
something that reads natural language, and keep the deterministic component for
what it can actually decide: a quantity in front of an ingredient is always a
use and never a warning.

**A forbidden term that appears in the prompt is a defect unless the item is a
premise trap.** This is mechanically checkable in CI, takes no model calls, and
would have caught 11 of the 15 active offenders on this run.

**Validate the grader against the space of correct answers, not against one.**
The blocking check "the reference answer must score 100 against its own grader"
was necessary and not sufficient: all 184 pass, and 38 model answers were still
wrongly zeroed. The authors wrote both the reference and the grader, so the
reference is the answer least likely to expose the fault. Adversarial
paraphrases — a version that warns about the banned ingredient, a version that
names what it replaces — cost no model calls and would have caught this class.

**Report separation, and refuse to render an ordering the statistics do not
support.** This run's board shows three models at 96.0 in a numbered column
while its own artifact says five are tied for first. Wherever a leaderboard is
consumed, the tie structure has to travel with it.

**Publish per-item variance share.** Concentration is the vulnerability. If six
items carry 41.6% of the spread, those six items *are* the benchmark and deserve
the scrutiny given to the aggregate. `nutr-036` would never have been read
closely without it.

**Cross-check the components you already have.** The most productive diagnostic
in this paper cost nothing: comparing two graders that scored the same answer.
Any benchmark blending a deterministic and a model-based component holds this
signal. Where they contradict, someone should read the answer.

**Saturation and defect need different fixes, and the second is worse.** A
saturated item wastes budget and measures nothing. A defective item measures the
wrong thing with high variance and *decides the ranking*. This project's ratchet
was built to hunt saturation; the defects required reading answers.

---

## 8. Provenance

| Claim | Source |
|---|---|
| Board, CIs, costs, incidents | `data/runs/2026-07-v2.1/leaderboard.json` |
| Item statistics, variance shares, separation matrix | `data/runs/2026-07-v2.1/analysis.json` |
| Per-answer scores and grader detail | `data/runs/2026-07-v2.1/scores.json` |
| Answer text, tokens, finish reasons | `data/runs/2026-07-v2.1/responses/*.json` |
| Roster, panel, token caps | `data/runs/2026-07-v2.1/config.json` |
| Judge calibration MAE | `data/runs/2026-07-v2.1/calibration.json` |
| Question text, graders, reference answers (current) | `data/questions/*.yaml` at HEAD |
| Question text, graders as they ran | `data/questions/*.yaml` at `055ac90^` |
| Prior audit of the 12 anti-correlated items | `docs/audit/anti-correlated-items.md` |
| Erratum for run `2026-06-v2` | `apps/web/app/methodology/page.tsx` |
| Discrimination, variance share, effective items definitions | `packages/runner/src/analyze.ts` |
| Reference/failing-answer guards, trap warning | `packages/runner/src/cli.ts` |
| Negation handling | `packages/core/src/graders/keyword.ts` |

Run artifacts under `data/runs/` are immutable and were read only. Nothing in
this paper regrades, alters or supersedes the published run: `2026-07-v2.1`
stands as published, and the corrections described here are carried by the next
run, not backdated onto this one.
