# Fundamentals selection input — the saturated-active inventory

**Status: input document, WP-6a (2026-08-01). No demotions are executed here.**
Moving any item's status is a bank-management act on `data/questions/` with its
own sign-off; this file exists so that decision starts from evidence instead of
from scratch.

Stage 3 needs a **15-item Fundamentals regression set** (master plan, question
blueprint): settled safety, allergens, ratios, quantities, conversions and hard
constraints that every competent model must pass — the Fundamentals Gate
*qualifies* a model and never inflates Craft. The natural source is the items
the current bank has already proven every model passes.

## The inventory: 37 candidates for Fundamentals/demotion

**33 active items scored 100 by all 14 models in 2026-07-v2.1**
(`analysis.json` `activeAllPerfect`; both pre-pivot branches independently
derived essentially this list), plus **4 items the anti-correlated audit found
saturated after grader repairs** (`subs-007`, `subs-018`, `tech-012`,
`tech-013` — negative discrimination driven by grader defects since repaired;
their post-repair means sit at 93–96).

What each group would regression-test, and selection notes:

### Conversions (7): `conv-021`–`conv-023`, `conv-025`–`conv-028`
Locale-trap unit chains: cl→US tbsp, dl→fl oz, AU tbsp (20 ml), gas marks,
gō, AU metric cup, szklanka. **Strong Fundamentals material** — these are
exactly "settled conversions and hard constraints", they encode the regional
measurement coverage M1.8 demands, and a regression here (a model version
suddenly fumbling gas marks) is a real, publishable finding. Recommend 3–4 of
the 7 for the Fundamentals 15, chosen for locale spread; the rest retire or
stay basics.

### Quantities & scaling (8): `qty-006`, `qty-019`–`qty-025`
Brine percentages, baker's-percentage arithmetic, pan-area scaling, cooked-
weight multipliers. Overlaps heavily in skill; **pick 2–3** (one brine, one pan
scaling, one baker's percentage) — the rest are near-duplicate signal.

### Nutrition (6): `nutr-031`–`nutr-035`, `nutr-037`
Label arithmetic and kcal estimation. Settled and checkable; **pick 1–2**.
`nutr-033` (alcohol kcal) duplicates a skill the salvage item `nutr-101`
(resistant starch) tests harder — keep the harder one in Craft, the easy one
in Fundamentals.

### Food safety (3): `safe-018`, `safe-020`, `safe-022`
Marinade reuse, bulged home-canned lid, fridge at 12 °C. **All three belong in
Fundamentals** — M3.7 says keep important easy safety material even though it
no longer ranks frontier models. Note all three are keyword-graded; they need
grader review (KI-005 class) before the Fundamentals set is sealed, or a
conversion to judge-graded with deterministic safety checks.

### Substitutions (4 + 2 audit): `subs-004`, `subs-011`, `subs-016`, `subs-017`; `subs-007`, `subs-018`
Cake-flour, buttermilk, fat-content arithmetic, self-raising flour, baking
powder chemistry. **Pick 2** — one arithmetic substitution, one chemistry one.
The two audit items need their repaired graders re-verified first.

### Flavour (3): `flav-003`, `flav-009`, `flav-016`
Pear/walnut/cheese, cheese-board pairing, vinaigrette ratio. `flav-016` (3:1
ratio) is Fundamentals; the two judged pairing items are not "settled facts"
— they saturated because they are easy, not because they are foundational.
Recommend retire or basics, not Fundamentals.

### Technique (2 + 2 audit): `tech-015`, `tech-016`; `tech-012`, `tech-013`
Blanch-fry temperature, caramelisation onset, soffritto order, oil in pasta
water. `tech-015`/`tech-016` are settled-number checks — **1 of the 2** for
Fundamentals. The audit pair are myth-correction traps; consider re-authoring
as Craft true-premise twins instead.

## Recommended shape of the eventual decision

- **~15 items → Fundamentals set** per the sketch above (3–4 conversions,
  2–3 quantities, 1–2 nutrition, 3 safety, 2 substitutions, 1 technique,
  1 flavour ratio, + 1–2 authored fresh to fill coverage holes — allergen
  hard-constraints have no saturated representative and will need one).
- **Remainder → basics or retired**, freeing the active set of ~22 zero-signal
  items in one reviewed move.
- Sequencing: this decision belongs with the Stage 4 bank-structure work, not
  before the candidate pool exists; nothing in WP-6a depends on it.
- The eval-research survey (`docs/research/eval-research-2026-06.md`)
  recommends a **perturbation probe before demotion**: renumber/relocale a
  saturated item first — if scores collapse, it was memorised, which is itself
  a finding worth recording in the item's provenance before it moves.
