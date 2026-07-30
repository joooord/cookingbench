# Judge disagreements — run 2026-07-v2.1

Audit of the 73 answers (of 630 judged, 11.6%) that run `2026-07-v2.1` flagged for
cross-judge disagreement > 15 points. Every number below is computed from committed
artifacts: `data/runs/2026-07-v2.1/scores.json` (verdicts, disagreement, flags),
`data/runs/2026-07-v2.1/responses/` (answer text), `data/questions/*.yaml` (items), and
the judge implementation as of the run commit (`packages/runner/src/judge.ts` at
`e3f8aee`, severities critical −40 / major −15 / minor −5 from 100). The
machine-readable companion — all 73 cases with per-seat scores and a classification
each — is `docs/audit/judge-disagreements.json`; it is ordered by disagreement and is
consumable as an adjudication queue.

## The verdict on the panel

**The published board does not depend on the disputed answers, and the panel's
disagreements are mostly a pricing problem, not a truth problem.** Specifics:

1. **The board is stable.** The tied-at-96 top three (GPT-5.6 Sol Pro, GPT-5.4 Mini,
   Grok 4.5) is the same *set* under the published means, under exclusion of all 73
   flagged answers, and under per-answer medians. The bottom two never move. Grok 4.5's
   frontier lead — the run's one defensible "best" claim — survives all three
   treatments. (Full table in §4.)
2. **When seats disagree, they usually agree on the facts.** In 30 of 73 flagged cases
   the two seats quote the *same* faults and price them differently — critical vs
   major, or one root mistake enumerated as four findings. That is a compliance failure
   against the judge prompt's explicit instruction ("List each DISTINCT underlying
   mistake exactly once"), concentrated in one seat (§2), and it is fixable by
   prompt/calibration, not by replacing the panel.
3. **The genuine judge errors mostly hide in the high scores, not the low ones.** Of 11
   cases where a seat is wrong on a checkable fact, 10 are *lenient misses* — a seat
   scoring 90–100 past a verifiable fault its colleague caught (a "regular spaghetti
   (low-FODMAP)" label, a protein breakdown that doesn't add its own numbers, advice to
   conceal substitutions from an allergic guest). Only once did a harsh seat get the
   arithmetic wrong (grok-4.5 on `rgen-013`/qwen). Distrust of the panel's *low*
   outliers is mostly misplaced; scrutiny should go to unanimous-looking 100s.
4. **One item is broken and produced 8 of the 73 flags by itself.** `flav-013`'s own
   judgingNotes contradict the NHS guidance the item cites (§5). That is an item fix,
   not a judge fix.

What this does *not* say: the disagreements are not noise-free. gpt-5.5 is a
systematically severe seat (−4.3 points vs colleagues, CI [−5.9, −2.6]) and the
self-preference seating rule couples panel composition to candidate provider, so that
severity lands unevenly across the board (§2, structural note). The tie at the top is
robust; the mid-table ordering (places 5–11, spanning 3.2 points) is where seat
composition plausibly moves models by one or two places, and no claim there should be
made without `analysis.separation` — which already declares those pairs unseparated.

## 1. Distribution — flags follow items, not models

All disagreement figures are `detail.disagreement` = |seatA − seatB| over the two panel
verdicts per answer (verified exact for all 630; flag threshold >15, zero exceptions).

- Judged answers: 630 (45 per model × 14). Flagged: 73 (11.6%).
- Flagged disagreement: min 20, median 35, max 95. Buckets: 16–25 → 30 cases,
  26–40 → 21, 41–60 → 10, 61+ → 12.
- Across all 630 judged answers the median disagreement is **0** — the seats give the
  identical integer score on 52–62% of answers depending on the pair. Disagreement is a
  tail phenomenon, not a baseline hum.

**By item.** The 73 flags land on only 27 of the 45 llm-judge items; 17 items are flagged for
two or more candidates and account for 63 of 73 flags:

| item | flags | category | difficulty |
|---|---|---|---|
| flav-013 | 8 | flavor-pairing | 4 |
| rgen-013 | 6 | recipe-generation | 3 |
| rgen-016 | 5 | recipe-generation | 5 |
| tech-002, rgen-003, rgen-008, rgen-012, rgen-019 | 4 each | technique / recipe-generation | 2–4 |
| subs-020, rgen-002, rgen-014, tech-006, rgen-020, rgen-007 | 3 each | — | 2–5 |
| flav-004, tech-008, rgen-017 | 2 each | — | 2–3 |
| 10 further items | 1 each | — | — |

An item flagged for 8 of 13 candidates (`flav-013`) is a property of the item, and §5
confirms it. Repeat-flagged items are where the adjudication queue should start.

**By category and difficulty** (flag rate = flags / judged answers in that slice):
recipe-generation 47/280 (16.8%), substitutions 3/14 (21.4%, all on `subs-020`),
technique 12/154 (7.8%), flavor-pairing 11/182 (6.0%, 8 of 11 on `flav-013`).
By difficulty: d1 2.0%, d2 7.9%, d3 14.3%, d4 28.6%, d5 19.6%. Flags concentrate
exactly where the dataset still discriminates — long multi-constraint briefs — which
is expected: more constraints, more surface on which seats can price differently.

**By candidate.** claude-sonnet-5 11/45 (24.4%), claude-opus-5 9 (20.0%),
llama-4-maverick 9 (20.0%), qwen3.7-max 8 (17.8%), mistral-large-2512 7, grok-4.5 7
(15.6% each), deepseek/gemini-3.6-flash/kimi-k3 4 each (8.9%), claude-fable-5,
gemini-3.1-pro, gpt-5.6-sol-pro 3 each (6.7%), gpt-5.4-mini 1 (2.2%). **Read this
table with the panel-composition caveat in §2** — Anthropic candidates are always
judged by the most divergent seat pair, OpenAI candidates by the calmest, so the
candidate flag rate is partly an artifact of who judged them.

## 2. Seat behaviour — one severe seat, and it is episodic

Per-seat mean signed difference vs the colleague seat, over every judged answer the
seat sat on (95% CI):

| seat | n answers | mean vs colleague | 95% CI | criticals/answer | majors | minors | zero-finding answers |
|---|---|---|---|---|---|---|---|
| openai/gpt-5.5 | 393 | **−4.27** | [−5.93, −2.62] | **0.17** | 0.26 | 0.36 | 61% |
| x-ai/grok-4.5 | 478 | +1.71 | [+0.35, +3.06] | 0.06 | 0.23 | 0.24 | 77% |
| anthropic/claude-opus-4.8 | 389 | +2.22 | [+0.91, +3.54] | 0.06 | 0.10 | 0.57 | 58% |

- **gpt-5.5 is the severe seat**, and this is a stable trait: its mean seat score here
  is 88.26, essentially identical to its 88.16 in the prior run where qwen3.5-plus
  marginalised at 96.20 on the same answers (CLAUDE.md, panel refresh). The mechanism
  is visible in the findings mix: gpt-5.5 issues **criticals at three times the rate**
  of either colleague (0.17/answer vs 0.06), and a critical is −40. opus-4.8 finds
  *more* faults than anyone but prices them minor (0.57 minors/answer).
- **The severity is episodic, not a constant offset.** On unflagged answers every pair
  agrees to within 0.6 points on average (gpt|grok −0.12, opus|gpt −0.04, opus|grok
  −0.59); the entire severity signal lives in the flagged tail, where gpt-5.5 sits
  ~27–29 points below its colleague (gpt|grok flagged mean −29.5, opus|gpt +27.1).
  Subtracting a constant per-seat bias would therefore not de-flag anything — it would
  *increase* total absolute disagreement by ~20–25%, because most answers agree
  exactly. The correct model is: gpt-5.5 agrees with colleagues on ~85% of answers and
  occasionally prices the same faults 2–8× higher.
- **How much of the disagreement it explains:** pairs seating gpt-5.5 carry **73.8%**
  of all disagreement points (sum |Δ| = 3,160 of 4,280) on 62% of answers; 58 of 73
  flags (79%) have gpt-5.5 seated, and it is the **low seat in 49 of those 58 (84%)**;
  56.5% of all disagreement points in the run are specifically "gpt-5.5 below its
  colleague". Pair flag rates: gpt|grok 37/241 (15.4%), opus|gpt 21/152 (13.8%),
  **opus|grok 15/237 (6.3%)** — the one pair without gpt-5.5 flags at half the run
  average.
- **Structural fairness note (inference, but arithmetic-backed).** The
  no-self-judging rule makes panel composition a function of candidate provider:
  Anthropic candidates are *always* judged by gpt-5.5 + grok-4.5 (the most divergent
  pair), OpenAI candidates *never* see gpt-5.5 (they get the calmest pair), and the
  other 9 models are hash-split. With gpt-5.5 running −4.3 severe, a two-seat mean
  structurally depresses non-OpenAI judged scores by roughly 2 points on
  gpt-5.5-seated answers relative to an OpenAI candidate on the same item. The §4(b)
  treatment shows the direction concretely: the models that gain most when flagged
  answers are excluded are claude-sonnet-5 (+3.9) and claude-opus-5 (+2.8). This does
  not overturn the top-three tie (Sol Pro and Mini hold it while never being judged by
  gpt-5.5, but grok-4.5 holds it *while* being judged by it) — it is a mid-table
  distortion risk and an argument for severity-correcting or re-balancing seats.

## 3. Root cause — hand classification of all 73

All 73 flagged cases were classified; 38 were reviewed deeply (question + answer text
+ both verdicts), the rest from both seats' full verdicts. Per-case rationale and
verbatim seat quotes are in `docs/audit/judge-disagreements.json`.

| classification | n | share |
|---|---|---|
| SEVERITY-STACKING | 30 | 41% |
| GENUINELY-BORDERLINE | 21 | 29% |
| JUDGE-ERROR | 11 | 15% |
| ITEM-AMBIGUOUS | 8 | 11% |
| REFERENCE-SUSPECT | 3 | 4% |

**SEVERITY-STACKING (30).** The seats found the *same* fault and priced it apart, or
one seat counted a single root as several findings — the judge prompt forbids both
("If one root error shows up in several places... report it as a single finding").
Textbook case, `rgen-014`/claude-opus-5: both seats returned exactly one finding, the
same finding — gpt-5.5 "[critical] Chipotle in adobo commonly contains added sugar"
(60) vs grok-4.5 "[major] Commercial chipotles in adobo almost always contain added
sugar" (85). Or `rgen-014`/qwen: gpt-5.5 split "meal 5 uses processed items" into two
criticals (15) where grok wrote one major covering both (80). gpt-5.5 is the usual but
not the only offender: on `flav-013`/llama-4-maverick it was **grok** that enumerated
five criticals (0) for the one root failure gpt covered with a single critical (60),
and on `rgen-009` opus-4.8 priced the agreed faults harder than gpt-5.5. The same
fault even moves within one seat: gpt-5.5 priced the identical spelt-pasta risk
critical on one answer (`rgen-012`/claude-opus-5) and major on another
(`rgen-012`/claude-sonnet-5), and a lone non-gram "pinch of salt" as critical
(`rgen-003`/grok-4.5).

**GENUINELY-BORDERLINE (21).** Real judgement calls with defensible seats on both
sides: is a hard-cheese wedge "shelf-stable" for camping (`rgen-008`/claude-opus-5)?
Does naming "vanilla bean panna cotta" without specifying agar violate a pescatarian
constraint (`rgen-007`, twice)? Is "cool completely, then refrigerate in the pot" for
a 3.5 kg braise a danger-zone violation or normal home practice (`rgen-015`)? A
consistent sub-cluster is grok-4.5's minority risotto doctrine ("a lively simmer is
required", gentle simmer is an error), applied identically to three candidates on
`tech-006` — doctrinal, not factual.

**JUDGE-ERROR (11) — 10 of them lenient misses.** One seat wrong on a checkable fact:

- `rgen-012`/mistral: the answer offers "**200g gluten-free or regular spaghetti
  (low-FODMAP)**" (answer text, `responses/mistralai__mistral-large-2512__rgen-012.json`).
  Wheat spaghetti is high-FODMAP; grok-4.5's critical (20) is correct, **opus-4.8 (90)
  missed the item's central constraint violation**.
- `rgen-004`/mistral: the breakdown lists 23+24+6+2+0.5 g yet states "Total Protein:
  ~42.5g" — it sums to 55.5; the item's top-weighted rubric line is "genuinely sum".
  gpt-5.5 (40) caught it plus two inflated per-item values; **opus-4.8 (95) wrote "the
  protein numbers... sum to ≥40g"**.
- `subs-020`/claude-fable-5: the answer advises "**don't announce the substitutions
  until after they've eaten them**" — to a table including a kosher-keeping father and
  a sesame-allergic guest. gpt-5.5 (70) faulted it; **grok-4.5 (100): "No concrete
  errors"**.
- `tech-001`/llama: answer claims yolks survive to "above 180°F/82°C"; they coagulate
  around 65–70°C. grok caught it (75); opus-4.8 (95) called the rescue "sound".
- The single harsh-side error: `rgen-013`/qwen, where grok-4.5 (5) declared the
  Tuesday protein "fabricated" by counting only the 180 g trout (~36 g) while ignoring
  the 250 g Puy-lentil pouch and broad beans *in the same salad* — opus-4.8 (80) did
  the full arithmetic (~48–50 g, inside the 40–60 g band) and called the claimed 57 g
  a minor overstatement. Checkable, and grok is wrong.

**ITEM-AMBIGUOUS (8).** The prompt sustains two readings and the seats split along it:
does "vegetarian" ban animal-rennet Parmesan (`rgen-002` ×2 + pricing variants)? Is
coconut "nut-free" (`rgen-017`, `rgen-006`)? Does an exhaustively enumerated dorm
"kitchen" (one bowl, one mug, fork, spoon) include a knife (`rgen-016` ×2)? Does
"exactly five spices" count mashed garlic cloves — noting `flav-004`'s own rubric
lists garlic *as a spice* (`flav-004` ×2)?

**REFERENCE-SUSPECT (3, all `flav-013`)** — plus 5 more `flav-013` flags filed as
stacking with reference-suspect secondary. See §5.

## 4. The consequence — the board under three treatments

Overall = plain mean over the 102 active items (recomputation of the published board
matches `leaderboard.json` to 0.1 on every row). Treatment (b) drops each model's
flagged answers from its own mean (n = items remaining). Treatment (c) replaces each
answer's judge score with the per-answer **median** seat score — **which is provably
identical to the published mean, because every one of the 630 judged answers has
exactly two verdicts and the median of two equals their mean.** (c) is shown for
completeness; with a two-seat panel it cannot differ, and that is itself a finding:
median-robustness is unavailable without a third seat.

| model | (a) published | (b) excl. flagged (n) | (c) median | Δ place (a)→(b) |
|---|---|---|---|---|
| openai/gpt-5.6-sol-pro | 96.0 | 96.25 (99) | 96.0 | 1 → 2 |
| openai/gpt-5.4-mini | 96.0 | 96.20 (101) | 96.0 | 2 → 3 |
| x-ai/grok-4.5 | 96.0 | 97.30 (95) | 96.0 | 3 → 1 |
| openai/gpt-5.6-terra-pro | 95.4 | 95.39 (102) | 95.4 | 4 → 5 |
| anthropic/claude-fable-5 | 94.1 | 94.78 (99) | 94.1 | 5 → 7 |
| moonshotai/kimi-k3 | 93.9 | 94.42 (98) | 93.9 | 6 → 8 |
| google/gemini-3.6-flash | 93.3 | 93.97 (98) | 93.3 | 7 → 9 |
| anthropic/claude-opus-5 | 92.9 | 95.71 (93) | 92.9 | 8 → 4 |
| google/gemini-3.1-pro-preview | 92.8 | 93.26 (99) | 92.8 | 9 → 10 |
| deepseek/deepseek-v4-pro | 92.7 | 92.94 (98) | 92.7 | 10 → 11 |
| anthropic/claude-sonnet-5 | 90.9 | 94.85 (91) | 90.9 | 11 → 6 |
| qwen/qwen3.7-max | 90.7 | 92.62 (94) | 90.7 | 12 → 12 |
| mistralai/mistral-large-2512 | 85.9 | 87.73 (95) | 85.9 | 13 → 13 |
| meta-llama/llama-4-maverick | 84.5 | 86.24 (93) | 84.5 | 14 → 14 |

Reading it honestly:

- **The top-three set {Sol Pro, Mini, Grok 4.5} is stable under all three treatments**,
  as are places 12–14. The published run already declares the top three a statistical
  tie (gaps ≤ 0.05, P≈0.51–0.52, `analysis.json` separation) — under (b) grok-4.5
  nominally leads by 1.05, but (b) has no paired-bootstrap attached and a ~1-point gap
  did not separate anywhere else on this run, so no ordering claim follows.
- **Frontier (difficulty ≥ 4): grok-4.5 leads under (a) 98.6, (b) 99.8, and (c)** —
  the run's one pre-declared separation survives every treatment.
- **The mid-table is where flags carry weight.** Excluding disputed answers lifts
  claude-sonnet-5 four places (90.9 → 94.9, 11th → 6th) and claude-opus-5 four (8th →
  4th). But (b) is a *biased* treatment — flagged answers are disproportionately
  low-scoring, so models with many flags gain mechanically — and Anthropic candidates
  have many flags partly because they always draw the gpt-5.5-seated pair (§2). Treat
  (b) as a sensitivity bound, not a better board: the honest statement is that
  mid-table positions 5–11 (a 3.2-point span the run already leaves unseparated) are
  sensitive to how the 73 disputes are resolved, and the extremes are not.

## 5. The two named cases

**flav-013 — grok-4.5 citing NHS both ways: CONFIRMED, with quotes.** On
claude-opus-5's answer (which recommends a Stilton for the table while giving the
pregnant guest three hard-cheese options and correctly stating NHS's actual position
that hard cheeses, even unpasteurised, are safe), grok-4.5 scored **95** and wrote:

> "[minor] Overstates UK pregnancy guidance: **hard blues such as Stilton are
> explicitly allowed (NHS)**; only soft blues need avoiding."

On claude-fable-5's answer to the *same item*, grok-4.5 scored **20** with:

> "[critical] **Stilton is a soft blue cheese; NHS guidance advises pregnant people to
> avoid all mould-ripened soft blues (including Stilton) regardless of
> pasteurisation**..."

— and repeated the forbid reading on kimi-k3 ("NHS advises pregnant people to avoid
soft/blue-veined cheeses like Stilton (pasteurised or not)") and gpt-5.4-mini ("Soft
blue cheeses such as Stilton remain an NHS-listed listeria risk... even when
pasteurised"). Same seat, same item, opposite ground truth, 75 points apart. The
deeper cause is the **item**: its judgingNotes tell judges that Stilton is "itself a
soft-ish blue" and that "anything unpasteurised" is an NHS-listed risk — but the NHS
page the item cites as `source` lists *hard* cheeses including Stilton as safe even
when unpasteurised. Seats that defer to the notes (gpt-5.5, scoring 0–20 across five
answers here) and seats that consult their own NHS knowledge (grok, sometimes)
necessarily diverge — in both directions, candidate by candidate. Add the constraint
check, which lists `unpasteurised` as a forbidden term so that an NHS-correct answer
scores constraint 0 (claude-opus-5: judge seats 0 and 95, constraint 0, published
23.75; deepseek: both seats 100, constraint 0, published 50 — unflagged, because the
*seats* agreed). This item produced 8 of the 73 flags and cannot be judged
consistently as written; it needs re-authoring or retirement, and it is exactly the
class of error the run's empty `referenceSuspects` list does not catch, since the
suspect here is the judgingNotes, not the numeric reference.

**rgen-003 / claude-sonnet-5 — 25 vs 80 with stacking: CONFIRMED.** gpt-5.5 scored
**25**, grok-4.5 **80** (`scores.json`, disagreement 55). gpt-5.5's findings are four
majors that are each the same root — the answer did not give every quantity in grams:

> "[major] 3 large eggs — eggs are given by count rather than weight." / "[major]
> 240ml buttermilk — ...millilitres rather than grams" / "[major] 1 tsp lemon juice —
> ...teaspoon measure instead of grams" / "[major] Pinch of salt — ...not given in
> grams."

plus a fifth major (hidden-gluten certification). grok-4.5 found the identical root
and counted it once — "[major] several liquids (buttermilk, oil, vanilla, cream) given
in ml and eggs unweighed" plus a tsp minor — exactly as the judge prompt requires
("List each DISTINCT underlying mistake exactly once. If one root error shows up in
several places... report it as a single finding, not several", `judge.ts` @ `e3f8aee`).
The entire 55-point gap is prompt-compliance: −60 of gpt-5.5's −75 deduction is one
mistake counted four times. The same signature repeats across `rgen-003`'s other three
flags (the not-in-grams fault priced anywhere from one minor to critical).

## 6. What follows (inference, flagged as such)

- **Adjudicate the queue, don't re-mean it.** 30 stacking + 3 reference-suspect + 8
  item-ambiguous cases (56% of flags) are resolvable by code or item fixes, not by a
  third opinion on the answer: collapse same-root findings before deduction (the
  findings already carry quotes, so root-clustering is mechanisable), and fix or
  retire `flav-013`, the coconut/nut-free and garlic/spice items.
- **A calibration anchor for stacking.** The gate tests score reproduction; nothing
  tests "one root, one finding". A single anchor whose hand-score depends on *not*
  stacking (e.g. a grams-violation answer like `rgen-003`'s) would have caught
  gpt-5.5's pattern before the run.
- **Median-robustness requires a third seat.** With two seats the median is the mean by
  arithmetic; any hope that "take the median" damps an outlier seat is void under the
  current panel design. A third seat on flagged answers only (~73 × one verdict) would
  be cheap and would make treatment (c) meaningful.
- **The lenient tail deserves the same suspicion as the harsh one.** 10 of 11 checkable
  judge errors were 90–100 scores past real faults. Sampling audits should include
  agreed-perfect answers, not only flagged ones.
- **Decouple severity from provider seating,** by severity-normalising seats or
  rotating a third seat, before reading anything into mid-table order: today an
  Anthropic candidate's judge pair is systematically ~4 points harsher than an OpenAI
  candidate's on the answers where it matters.
