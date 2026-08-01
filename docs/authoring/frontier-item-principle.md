# The frontier-item principle

*Make the canonical answer the wrong one, and make the reason a fact the model
can state but has not integrated.*

Status: authoring guidance. Evidence: run `2026-07-v2.1` (14 models × 184
questions), read from `data/runs/2026-07-v2.1/{analysis,scores}.json` and the
stored answers in `responses/`. Nothing under `data/runs/` was modified.

---

## 1. Why we need a principle rather than more items

The bank is much smaller than it looks.

| measure | value |
|---|---|
| active items | 102 |
| active items carrying any signal at all | 64 |
| `effectiveItems` (inverse Herfindahl of variance share) | **24.2** |
| active items scored 100 by all fourteen models | 33 |
| active items with zero variance | 42 |
| median active item's share of total variance | **0.002** |
| judged answers scoring exactly 100 | 50% (target < 35%) |

We pay for 102 items and run about 24. Adding items in the current style adds
cost and adds nothing to resolution: the top three models finished 96.0 / 96.0 /
96.0 and `analysis.separation` cannot order them (P ≈ 0.52).

### The eight items that actually work

Filter the active set to *low mean* **and** *positive discrimination* — items
that are hard, and on which the stronger models do better — and eight survive:

| item | cat | diff | grader | mean | sd | min | max | disc | var share |
|---|---|---|---|---|---|---|---|---|---|
| subs-021 | substitutions | 4 | keyword | 78.6 | 41.0 | 0.0 | 100 | +42.9 | 0.073 |
| rgen-013 | recipe-generation | 3 | llm-judge | 71.0 | 20.8 | 30.0 | 94.8 | +21.5 | — |
| **flav-013** | flavor-pairing | 4 | llm-judge | **55.1** | 29.7 | 8.8 | 100 | **+20.9** | 0.038 |
| rgen-019 | recipe-generation | 4 | llm-judge | 58.8 | 24.6 | 16.2 | 98.8 | +16.8 | — |
| nutr-036 | nutrition | 3 | numeric | 42.9 | 45.7 | 0.0 | 100 | +14.3 | 0.091 |
| rgen-015 | recipe-generation | 5 | llm-judge | 63.0 | 23.4 | 40.0 | 100 | +13.9 | — |
| rgen-012 | recipe-generation | 2 | llm-judge | 71.0 | 18.2 | 38.5 | 100 | +12.8 | — |
| **subs-020** | substitutions | 5 | llm-judge | **49.5** | 14.9 | 26.2 | 98.8 | **+10.7** | 0.010 |

Six of the eight are judge-graded. That is the first structural finding: the
deterministic graders are not where the remaining signal lives. It is also the
second argument for judge-first v3 items, the first being that **50 items in the
bank score 100 against a bare list of their own required synonyms**.

### Variance is not signal — check the sign

The single largest variance share in the run belongs to `nutr-036` (0.091) and
the second to `flav-014` (0.090). `flav-014`'s discrimination was **−9.5**: as
that item stood in the run, models that were better overall scored *worse* on
it, because its keyword grader zeroed nine of fourteen models including the best
answer in the set (see `docs/audit/anti-correlated-items.md`; the item has since
been converted to `llm-judge`). A broken grader manufactures variance that
anti-correlates with skill, and a bank tuned on spread alone would keep it and
throw away `subs-020`, whose sd is a third as large and whose sign is right.

**Rule: an item earns its place on low mean *and* positive discrimination. Never
on spread.**

---

## 2. The principle

> Make the CANONICAL answer the wrong one, and make the reason a fact the model
> can state but has not integrated. That tests reasoning against recall.

Four properties follow, and an item that misses any one of them is not on this
pattern:

1. **The trap must be the highest-probability answer**, not an obscure one. If
   the model has to be unlucky to fall in, the item measures sampling noise.
2. **The defeating fact must be recitable.** Ask the model the fact directly and
   it answers correctly. The item is not testing whether the fact is known; it
   is testing whether the fact is *reached* when a strong prior points the other
   way. Items whose defeating fact is genuinely obscure are trivia, and trivia
   saturates as soon as it is scraped.
3. **The two must collide inside one scenario**, so that answering requires
   overriding the prior rather than adding to it. An item where the canonical
   answer is merely *incomplete* grades as a completeness checklist, and every
   model completes checklists.
4. **Detection must not be the test.** Whatever cue triggers the conflict —
   a guest, a date, a temperature — should be noticed by everyone. If half the
   models miss the cue, you are measuring attention, which saturates in one
   model generation.

---

## 3. Worked example: `flav-013` — the Stilton

**Prompt.** A cheese board for a vintage port, six people. One guest is
mentioned in passing, as good news: *"my brother and his wife (she's about five
months pregnant now, so exciting!)"*. The question asked is which four cheeses
sing with port.

**Result.** mean 55.1, sd 29.7, range 8.75–100, discrimination +20.9. 3.8% of
the run's total variance on one item, against a median active item's 0.2%.

| model | score | | model | score |
|---|---|---|---|---|
| claude-sonnet-5 | 8.75 | | mistral-large-2512 | 55.00 |
| claude-fable-5 | 10.00 | | kimi-k3 | 55.00 |
| llama-4-maverick | 15.00 | | grok-4.5 | 66.25 |
| claude-opus-5 | 23.75 | | gpt-5.4-mini | 75.00 |
| deepseek-v4-pro | 50.00 | | gemini-3.1-pro | 80.00 |
| gemini-3.6-flash | 55.00 | | qwen3.7-max | 80.00 |
| | | | gpt-5.6-terra-pro | 97.50 |
| | | | gpt-5.6-sol-pro | 100.00 |

**All fourteen models noticed the pregnancy.** Detection is saturated; property
4 above is satisfied by construction, and it buys nothing. What separated 8.75
from 100 is a single inference.

The canonical answer is *Stilton*. Port and Stilton is possibly the strongest
food-pairing prior in the English language, and it is wrong here.

The defeating fact: **pasteurisation does not make a soft blue cheese safe in
pregnancy — the risk comes from the mould-ripening, the moisture and the low
acidity, which let *Listeria monocytogenes* grow after the milk was heated.**
NHS guidance excludes soft blue cheeses whether or not they are pasteurised.

Both bottom models reasoned their way there confidently, and correctly on the
sub-fact:

> **claude-fable-5 (10.00)** — "**Stilton** — the classic port pairing, full
> stop. […] Good news: all authentic Stilton is made with pasteurized milk (it's
> required by its PDO), so it's pregnancy-safe despite being a blue."

> **claude-sonnet-5 (8.75)** — "Stilton is traditionally unpasteurized […] Easy
> fix: pick a **pasteurized blue** (many good ones are) […] That way everyone
> can dig into everything without you needing to manage a separate plate."

The PDO claim in the first is *true*. The inference from it is not. Both models
can recite the listeria fact on demand; both had already named the risk category
in the same answer. The pairing prior supplied the conclusion and the
pasteurisation fact was recruited to justify it.

The top model did the one thing that separates:

> **gpt-5.6-sol-pro (100.00)** — "For your pregnant sister-in-law, the simplest
> cautious approach is to serve her the **pasteurized hard cheeses** and have her
> skip the Stilton/other blue cheese, subject to local pregnancy guidance."

Note what makes this item survive roster turnover: the gap is not knowledge, so
a bigger model does not close it by knowing more. It closes it by *checking a
conclusion it already believes*, which is exactly the capability the benchmark
claims to measure.

---

## 4. Worked example: `subs-020` — Nonna's meatballs

The same principle by a different route: **three interacting hard constraints
inside stated emotional stakes.**

**Prompt.** Grandmother's beef-and-pork meatballs — beef, pork, bread soaked in
milk, a mountain of parmesan, parsley, garlic, eggs — cooked for the partner's
family for the first time. The partner's father keeps kosher (no pork, meat and
dairy never mixed); his sister has a sesame allergy. *"It actually matters."*

**Result.** mean 49.5, sd 14.9, range 26.25–98.75, discrimination +10.7,
difficulty 5. Lower sd than `flav-013` and a lower ceiling on the ordinary
answers: almost nobody aces it, which is what a hard item looks like.

Here the canonical answer is not one dish but one *move*: swap the pork, and
stop. Dropping the pork is the visible constraint and it is the wrong stopping
point. The defeating fact is a rule the model can state verbatim — **kashrut
separates meat and dairy, so the parmesan and the milk-soaked bread both have to
go, not just the pork** — and the milk is buried inside a technique step
(*bread soaked in milk*) rather than listed as a dairy ingredient. A fourth
requirement is doing the substitution *well*: removing a mountain of parmesan
removes the dish's savour, so an answer that just deletes it has degraded the
thing the cook cares about.

Why the emotional stakes are load-bearing rather than decoration: they make
"ask a clarifying question" and "hedge across all options" bad answers. The item
wants a decision, and it wants the cook to be able to serve it on Sunday.

`subs-020` also carries the bank's most expensive authoring lesson. As shipped
in `2026-06-v2` its keyword grader forbade `parmesan`, which any competent
answer must name in order to remove it; the item zeroed 12 of 13 models, three
of them while the judge panel scored them 100. **The pattern in this document
puts almost all of its weight on the judge. Do not re-introduce that failure by
adding a forbidden-term list to catch what the judge is already reading.**

---

## 5. The authoring recipe

Write these five things down before you write the prompt. If you cannot fill in
2 and 3 crisply, there is no item.

1. **Scenario** — an ordinary request a person would actually make.
2. **Canonical trap** — the answer a strong model gives at temperature 0, in one
   sentence. Name it. ("Serve the Stilton." "Swap the pork.")
3. **Defeating fact** — the specific, checkable, *recitable* fact that makes 2
   wrong, with a source and a confidence. One sentence, and it must name a
   mechanism, not a rule of thumb. ("Mould-ripening and moisture, not the milk.")
4. **Shortcut blocked** — what a model could otherwise do to score without
   reasoning. This goes in `classification.shortcutBlocked`.
5. **Stakes** — why hedging is not an answer here.

Then:

- **Grade judge-first.** `grader.type: llm-judge`, `judgeWeight` ≥ 0.8, and
  prefer `judgeMode: dimension` with a behavioural anchor set on the one
  dimension that separates. The 0–4 anchors are where you write down what
  applying the fact *looks like*, which is the thing a deduction judge cannot
  infer from a reference answer.
- **Use `judgePack`, not a reference answer, as the judge's material.** It
  requires multiple acceptable solution families, so an item that only admits
  your own answer will fail to author — which is the point. `flav-013` has at
  least two: serve no blue at all, or serve it labelled with a hard pasteurised
  alternative for the guest.
- **Write the four worked examples honestly.** `plausible-but-wrong` is the
  whole pack: it should be the canonical trap, written as well as the trap
  actually gets written in the wild. If yours is not tempting, you have not
  found the trap.
- **Add `adversarialCases`.** At minimum a `polished-but-wrong` case carrying
  the trap with `expect: at-most`, and a `correct-concise` case with
  `expect: at-least` so that a terse right answer cannot be marked down for
  brevity. (`expect: at-most` on a correct answer is refused by the schema: it
  would pass when the grader zeroes the answer.)
- **Deterministic checks only where they are safe, and measure before you keep
  one.** A `forbidden` list on a trap item is a landmine: the correct answer
  names the banned thing in order to refuse it. That class of defect put
  eighteen wrong scores into `2026-06-v2`. A numeric check on a figure the
  answer must contain is safer — but only where the figure is written in
  digits. A numeric check drafted for `qty-101` was removed after testing: the
  extractor reads digits, so "around two hours" scored 0 where "120 minutes"
  scored 100. Grams get written as digits; minutes get spelled out. Run the
  reference answer, the failing answer and every worked example through
  `gradeDeterministic` before you commit a check.

### Disqualifiers

Reject your own draft if any of these is true.

| symptom | why it fails |
|---|---|
| The trap is a fact the model doesn't know | Trivia. Saturates on the next scrape. |
| The trap requires missing a stated cue | Attention test. Already saturated. |
| The canonical answer is incomplete rather than wrong | Checklist. Everyone completes checklists. |
| The right answer is "ask a clarifying question" | Rewards needless questioning (M1.6). |
| The right answer is "refuse / bin it / see a professional" | Safety theatre scores without reasoning. Invert it: make over-caution wrong too. |
| The prompt shares >50% of its content words with an existing item | Splits one item's signal across two. `bench validate` warns on near-duplicates. |
| Bare keyword stuffing scores 100 on the deterministic part | The item measures token presence. |

### Verification before admission

1. `bench validate` — reference answer scores 100 against its own grader, a
   `failingAnswer` scores ≤ 40. This is the only automated admission step that
   currently runs, and it is free and offline.
2. **There is no automated paid admission step.** `bench pilot` is disabled for
   v3 (master plan M0.1; `cmdPilot` refuses unconditionally, and
   `test/cli-boundaries.test.ts` asserts it). Any candidate inference on draft
   items needs a Development Probe permit under the master plan's Stage 3
   protocol — a named, bounded, non-scoring human approval, not a CLI flag.
3. Human review of everything. The old pilot's Stage 2 question — *is the low
   scorer actually wrong, or is the grader?* — remains the right question, and
   this pattern creates exactly the answers that need it: a confidently-argued
   wrong answer is what both a failing model and a broken grader produce.

### The provenance caveat (M3.9)

An agent-drafted item may share a prior with the models it is meant to test: the
same training distribution that supplies the canonical trap also supplies the
author's sense of what is canonical. Draft items therefore carry
`provenance.authoringChain` with `stage: agent-draft` and a
`verificationState` of `draft`, and they are not admitted to the bank on the
strength of a pilot pass alone. Provenance is granular metadata, not a binary
label — record the chain, and record every model that saw the item before it
scored in `provenance.modelExposures`, because a model used to author or stump
an item cannot then supply clean confirmatory evidence on it.

---

## 6. Current drafts on this pattern

`data/candidates/v3-canonical-trap-{01,02,03}-*.yaml` — twelve items, all
`status: candidate`, all `authoringProvenance: agent-draft`. Not admitted. Not
in `data/questions/`. Read the header of each file before running anything.
