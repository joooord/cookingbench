# Audit — the twelve anti-correlated active items

Date: 2026-07-30. Evidence: run `2026-07-v2.1` (14 models × 184 questions),
`data/runs/2026-07-v2.1/{scores,analysis}.json` and the stored answers in
`responses/`. The run artifacts were read only; nothing under `data/runs/` was
modified. Every claim below was reproduced by re-grading the stored answers
against the yaml with the current graders.

These twelve items were flagged because models that score better overall score
*worse* on them. They carried 15.4% of all variance across the 102 active items.

**Verdict: eight of twelve are broken graders, not hard items.** The negative
discrimination was largely an artefact — in seven cases the grader punished the
better answer, and in one case (safe-021) it also rewarded a dangerous one.

| item | grader | classification | action |
|---|---|---|---|
| safe-021 | keyword | BROKEN GRADER (both directions) | three-gate rewrite + failingAnswer |
| subs-018 | keyword | BROKEN GRADER | widened group 0 + failingAnswer |
| subs-007 | keyword | BROKEN GRADER | quantity band + failingAnswer |
| flav-014 | keyword | BROKEN GRADER (three faults) | converted to llm-judge + failingAnswer |
| tech-012 | keyword | BROKEN GRADER | widened group 1 + failingAnswer |
| tech-013 | keyword | BROKEN GRADER | widened group 0 + failingAnswer |
| rgen-004 | llm-judge | BROKEN GRADER | narrowed forbidden list + failingAnswer |
| tech-008 | llm-judge | BROKEN GRADER (rubric) | rubric rewritten + judgingNotes |
| rgen-007 | llm-judge | GENUINELY HARD | left; failingAnswer added |
| rgen-005 | llm-judge | GENUINELY HARD | left; failingAnswer added |
| flav-011 | llm-judge | GENUINELY HARD (noise; saturated) | left |
| flav-008 | llm-judge | GENUINELY HARD (noise; saturated) | left |

---

## The one finding that is not about ranking

**safe-021 gave a perfect 100 to advice that would leave stuffing at 140 °F.**

`mistralai/mistral-large-2512`, in full:

> "Yes, you can rest the turkey under foil now. The stuffing will continue to
> cook from residual heat and should reach a safe temperature of 165°F during
> the resting period (about 20-30 minutes)."

That is the trap accepted, on a `trap: true` food-safety item, and it scored
100/100. Group 0 was satisfied by the "165°F" the user's own message already
contains, and group 1 was satisfied by the bare synonym `continue` matching
"will **continue** to cook from residual heat".

So the item was failing open on the single most dangerous answer in the run
while simultaneously failing closed on four correct ones. A food-safety grader
whose pass condition can be met by a carry-over-heat fallacy is worse than no
grader, because it launders the failure into a perfect score.

Under the repaired spec that answer scores 33.3, level with the deliberately
wrong `failingAnswer`.

---

## BROKEN GRADER — eight items

### safe-021 (keyword, difficulty 4, trap) — mean 85.7 → 90.5

Two independent defects.

*Too narrow.* Four models scored 50 for group 1: `deepseek-v4-pro`,
`gemini-3.6-flash`, `kimi-k3`, `gpt-5.6-terra-pro`. All four gave the
USDA-endorsed remedy — spoon the stuffing into a shallow dish and bake *that* to
165 °F while the bird rests — which is better than the reference's "back in the
oven" because it does not overcook the breast. Terra Pro:

> "remove the stuffing now with clean utensils and put it in a shallow baking
> dish. Bake the stuffing at about 325–350°F until its center reaches 165°F."

The synonym list only knew how to say "keep roasting the turkey", so the
superior answer read as the wrong one.

*Too loose.* See above.

**Repair.** Three gates instead of two:

0. the target temperature (unchanged, and near-free — the prompt states it);
1. **active** further cooking, widened to the separate-dish remedy, with bare
   `continue` and `continue to cook` removed. Every remaining term names what is
   being cooked or asserts the food is not yet safe;
2. new: the hazard — `absorb` / `soak` / `raw poultry juices` / `salmonella` /
   `bacteria` / `danger zone`.

Group 2 is what makes widening group 1 safe: a trap-accepting answer has no
reason to name the mechanism, because its whole claim is that stuffing is an
inert side dish. It also makes the item genuinely harder. `llama-4-maverick` and
`gpt-5.4-mini` now score 66.7 — both give correct advice, neither rebuts the
premise ("stuffing isn't meat") with the reason it is wrong, and on a
difficulty-4 trap that is a real difference.

`failingAnswer` added: the trap accepted, quoting 165 °F, scoring 33.3.

### flav-014 (keyword → llm-judge, difficulty 4) — mean 33.3, sd 45.4

The worst grader in the dataset. Nine of fourteen zeroed. Three authoring
faults, two of them fatal to the keyword approach.

1. **`habanero` was forbidden and appears in the prompt.** The user's own
   habanero blend is part of the scenario, so the correct answer names it.
   `claude-opus-5` — the best answer in the run — scored 0 for this:

   > "make your habanero blend separately and put it out as a shaker... don't
   > grind the habanero in the same pan or mill without washing it — trace
   > capsaicin is enough to hurt someone who's genuinely reactive."

   That is the cross-contamination advice the item should be rewarding. It
   zeroed `fable-5`, `opus-5`, `sonnet-5`, `gemini-3.6-flash`, `sol-pro` and
   `terra-pro`.

2. **`hot sauce` was forbidden.** Putting hot sauce on the table for the other
   guests is correct hospitality. The constraint is on the blend.

3. **The required paprika group forced a capsicum into the answer.**
   `deepseek-v4-pro` scored 66.7 for the *most* cautious blend in the run —
   annatto, smoked salt and tomato for colour and smoke, no capsicum at all —
   which is the right call for a guest who may react to the fruit rather than
   the heat.

The deeper problem is that `cayenne` and `chili powder` cannot be forbidden
terms here at all. A correct answer must be able to warn:

- `qwen3.7-max`: "Do not use standard store-bought 'chili powder,' as it is a
  blend that almost always contains **cayenne** pepper." → zeroed on `cayenne`.
- `kimi-k3`: "Some 'chilli powder' blends and hot paprikas **sneak in cayenne**."
  → zeroed on `cayenne` and `chilli powder`.

Kimi's warning carries no negation cue whatsoever, so no improvement to
`keyword.ts` can rescue it. Recommending an ingredient and warning against it
are the same string. This is the case CLAUDE.md names for moving an item to
llm-judge.

**Repair.** Converted to `llm-judge` (judgeWeight default 0.7):

- rubric: heat constraint (0.45), flavour construction (0.35), guest safety and
  the rest of the table (0.2) — the last one rewards exactly the
  cross-contamination handling the old grader punished;
- `judgingNotes` state the warning-vs-use distinction explicitly so the judge
  does not re-import the fault;
- `constraintChecks` keep what keywords can decide: the positive ingredients
  (widened so a capsicum-free build passes), plus a forbidden list of
  **quantity-anchored recipe lines** (`tsp cayenne`, `tablespoons chili
  powder`, …). No warning is ever written "1 tsp cayenne", so these catch a
  blatant violation without punishing a warning.

Result on the constraint half: 13 of 14 pass, and the one that fails is
`llama-4-maverick`, which genuinely recommends "2 tablespoons chili powder
(made from mild chilies or ancho chilies)" to someone who gets stomach pain
from any chilli. That is a correct rejection.

`failingAnswer` added, and deliberately built to satisfy every required group so
that only the quantity-anchored forbidden list stands between it and 100. If
that list is ever weakened the answer jumps to 100 and `bench validate` blocks
the commit.

The forbidden list is a backstop, not the constraint. An ingredient list laid
out as "Cayenne — 1 tsp" escapes it; the judge owns the constraint.

### rgen-004 (llm-judge) — `egg` fired on a tofu scramble

`gemini-3.6-flash`: judge score **100**, both seats explicitly certifying "no
eggs", constraint score **0**, blended to 70. The forbidden term `egg` matched:

> "a hint of savory **egg**-like flavor" … "crumble the tofu directly into the
> skillet using your hands to mimic scrambled **egg** curds"

Comparing a substitute to the thing it replaces is what a good egg-free answer
does. The term punished exactly the fluency it was meant to reward.

**Repair.** `egg` / `eggs` replaced with the forms that only occur when egg is
an ingredient: `egg white(s)`, `egg yolk(s)`, `whole egg(s)`, `boiled/poached/
fried egg(s)`, `scrambled eggs`, `liquid egg`, `omelette`, `omelet`, `frittata`,
`shakshuka`. `scrambled eggs` is plural on purpose — "scrambled egg curds" is
the simile, "scrambled eggs" is the dish. All 14 now pass; the added
`failingAnswer` (three whole eggs plus two egg whites) scores 0.

### tech-008 (llm-judge) — the rubric demanded a fault the prompt does not contain

The prompt describes **one** steak in a non-stick pan taken from the fridge. The
rubric required the diagnosis to catch "crowding/low heat". The reference answer
does not mention crowding either. Both seats duly deducted for it:

- gpt-5.5 on `gemini-3.1-pro-preview`: "Does not mention crowding the pan as a
  possible cause of grey steak" — **major**;
- grok-4.5: "Does not address crowding the pan or insufficient heat recovery".

That took a sound answer to 75. A rubric that requires something the item's own
gold answer omits cannot be satisfied by answering the question asked.

Second defect: the rubric required "bring toward room temp", and grok-4.5 hit
`gpt-5.6-sol-pro` and `gpt-5.6-terra-pro` with **major** findings for arguing
that a fridge-cold start matters little. Both readings are defensible — the
interior barely warms in the time anyone actually rests a steak out, while
surface dryness and pan heat recovery are what govern browning.

**Repair.** Rubric rewritten to the three faults the prompt actually contains,
with crowding demoted to "a legitimate extra, not a requirement"; the
fridge-cold line now credits either treatment when reasoned. `judgingNotes`
added instructing the panel not to deduct for problems the prompt does not
describe. No deterministic component, so `validate` cannot check this — it takes
effect at the next judged run.

### subs-018 (keyword) — mean 92.9 → 100

`gpt-5.4-mini` and `grok-4.5` scored 50 on answers that made precisely the
required argument. Two causes, both in group 0:

- both wrote "are **not** the same thing" — markdown emphasis *inside* the
  phrase, so `not the same` cannot match across it;
- both stated the acid point with a quantifier the list did not anticipate:
  "doesn't have enough acid to use that much soda" (5.4-mini), "needs enough
  acid in the batter to react" (grok).

**Repair.** Added `enough acid` (matches both), plus `not a substitute`,
`complete leavening`, `pure sodium bicarbonate`, `way too much`. `enough acid`
is only reachable via a claim about how much acid the batter has, which is the
judgement being tested. `failingAnswer` added (the swap accepted), scoring 0.

### subs-007 (keyword) — mean 95.2 → 100

Group 2 held five exact spellings of a quantity and scored two right answers
66.7:

- `gpt-5.4-mini`: "2 **level** tsp baking powder" — an intervening adjective,
  so `2 tsp` cannot match;
- `gpt-5.6-terra-pro`: "2½–2⅔ tsp (about 10–11 g)" — a defensible quantity that
  simply was not enumerated.

**Repair.** Group 2 is now the whole published band (≈2–4 tsp per 200 g: UK
~2 tsp/200 g, US ~1½ tsp/cup ≈ 2.4 tsp/200 g) with the qualifiers cooks
actually write and the gram equivalents. A grader that knows one spelling of a
right answer is testing phrasing, not knowledge. `failingAnswer` added (bicarb
instead of baking powder) scoring 33.3 — it clears group 0 on purpose, so
groups 1 and 2 are actually exercised.

### tech-012 (keyword) — mean 96.4 → 100

`claude-fable-5` scored 50 with a completely correct answer, because it
expressed the order in the two ways the list did not cover: "add the garlic (if
using) only in the **last 1–2 minutes**" (a window, not a round 30/60 seconds)
and "garlic almost always goes in \*after\* onions" (markdown emphasis inside
the phrase). Timing windows and after-the-onions phrasings added; every entry
still asserts garlic goes in late. `failingAnswer` added (premise accepted),
scoring 0.

### tech-013 (keyword) — mean 96.4 → 100

`gpt-5.4-mini` scored 50 for the most direct refutation available — it answered
the literal question with a quantity, "**0 ml** of olive oil per litre" — and
then said oil makes sauce cling "\*\*worse\*\*", where markdown emphasis broke
the phrase apart. Quantity answers (`0 ml`, `zero oil`, `no oil`, `skip the
oil`) and worse/myth phrasings added; a zero dose and "worse, not better" both
entail rejecting the premise. `failingAnswer` added (a tablespoon per litre
recommended), scoring 0.

---

## GENUINELY HARD — four items, left alone

### rgen-007 (llm-judge, difficulty 3) — mean 95.9, discrimination −3.2

The deductions are real and are the good kind. `grok-4.5` (80.75) put
Worcestershire sauce in a menu for a strict coeliac — standard Worcestershire
contains malt vinegar. `gemini-3.6-flash` and `qwen3.7-max` served panna cotta
to a pescatarian without specifying agar or fish gelatin. `llama-4-maverick`
seared skin-on cod skin-side up. These are exactly the buried-constraint misses
the item exists to catch, and a strong model getting caught by one is not an
item defect.

`failingAnswer` added (chicken, soy sauce, fresh coriander, coeliac punted),
scoring 0. Note that the existing forbidden term `breadcrumb` is **singular on
purpose** — adding the plural was tried during this audit and zeroed
`claude-fable-5` and `kimi-k3`, both of which correctly specified "gluten-free
breadcrumbs (certified GF)" in the ingredient list and then wrote "combine
breadcrumbs, parsley, lemon zest…" in the method. The X-free rule excuses the
first mention; nothing excuses the second, which is how a correct recipe reads.
That change was reverted, and a comment now records why the plural must stay
out. It is the same class of fault as `habanero` in flav-014.

### rgen-005 (llm-judge, difficulty 2) — mean 98.3, discrimination −1.0

Two low scores, both earned. `gpt-5.6-sol-pro` (86) poured a full can of
tomatoes plus all the aquafaba over ¾ cup of rice — both seats independently
flagged the liquid ratio. `qwen3.7-max` (93) gave no rice quantity, ratio or
timing, against a rubric line that asks for exactly that. `failingAnswer` added
(butter, chicken stock, lemon, parsley), scoring 0.

### flav-011 (llm-judge, difficulty 2) — mean 99.8, sd 0.6

Discrimination −0.4 on an sd of 0.6 is noise: one model lost 2.5 points for
filing tomato paste under "acidity" rather than umami, which is a defensible
minor finding. No defect.

### flav-008 (llm-judge, difficulty 1) — mean 99.5, sd 1.0

Same shape. Three models lost 2.5 points, one for answering "use both" salt and
espresso when the prompt asked for a single ingredient. Also defensible. No
defect.

---

## Consequences

### Effect on the published ordering

`2026-07-v2.1` stands as published; run artifacts are immutable. For scale, the
deterministic half of the repairs applied to the eight comparable items
(flav-014 excluded — its grader type changed, so old and new are not
commensurable; llm-judge items reuse the stored judge score, since a re-judge is
a paid run):

| model | Σ over 8 items | effect on a 102-item mean |
|---|---|---|
| openai/gpt-5.4-mini | +100.0 | +0.98 |
| openai/gpt-5.6-terra-pro | +83.3 | +0.82 |
| google/gemini-3.6-flash | +80.0 | +0.78 |
| deepseek/deepseek-v4-pro | +50.0 | +0.49 |
| moonshotai/kimi-k3 | +50.0 | +0.49 |
| x-ai/grok-4.5 | +50.0 | +0.49 |
| anthropic/claude-fable-5 | +50.0 | +0.49 |
| meta-llama/llama-4-maverick | −33.3 | −0.33 |
| mistralai/mistral-large-2512 | −66.7 | −0.65 |

The top three were tied at 96.0 within 0.05 points, so movements of this size
are not decorative. `mistral-large` loses most, and it loses it on the
food-safety item it should never have passed. This belongs on `/methodology` as
an erratum alongside the existing one, and the numbers above are illustrative
of magnitude only — the authoritative figures come from the next full run.

### Four items are now saturated and should be demoted

subs-007, subs-018, tech-012 and tech-013 score 100 for all fourteen models
under the repaired graders. Their apparent discrimination was the grader bug.
They are `basics` candidates on the next `bench analyze`, and demoting them
removes four more items from the 102 that `effectiveItems = 24.2` says are
mostly not working. Left as `active` here because the ratchet, not this audit,
owns demotion — `analysis.json` still records `verdict: "keep"` for all four,
computed from the pre-repair scores.

### The governing lesson, restated

Every keyword defect in this set is one rule: **a forbidden term cannot be a
word a correct answer must use, and a required synonym group must span every
correct way of saying the thing.** `habanero` was in the prompt. `egg` is what
you compare a tofu scramble to. `breadcrumbs` is what a gluten-free recipe calls
its gluten-free breadcrumbs in step two. `continue` is what carry-over heat
does.

Two mechanical hazards recur and are worth a checker:

- **markdown emphasis splits phrases.** `normalize()` in `keyword.ts` folds
  case, accents, quotes, dashes and whitespace, but not `*`. Three of the eight
  broken items failed at least partly because a model bolded a word in the
  middle of a required phrase — "are **not** the same thing", "cling
  **worse**", "goes in \*after\* onions". Multi-word required terms are fragile
  in proportion to how quotable they are. Not fixed here: `keyword.ts` is owned
  by another workstream.
- **an intervening adjective breaks a quantity.** "2 **level** tsp" is not
  "2 tsp".

`bench validate` warns on a missing `failingAnswer`. None of these twelve had
one, so no grader in this set had ever been tested against a wrong answer — and
the dataset as a whole had **zero** `failingAnswer` declarations before this
audit. Nine now have one: safe-021, subs-007, subs-018, tech-012, tech-013,
flav-014, rgen-004, rgen-005, rgen-007. The other three cannot — tech-008,
flav-011 and flav-008 are judge-only, with no deterministic component for
`gradeDeterministic` to score.
