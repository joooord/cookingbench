# Anchor bank design — judge-calibration anchors v3 (2026-07-30)

Status: **DEVELOPMENT material.** Every hand-score in this bank was produced by
an agent, not a chef or food-safety professional. Read "The central limitation"
before citing any number from this bank in a release claim.

## What changed

The judge calibration gate (`packages/runner/src/calibration.ts`) previously
rested on 12 hand-written anchors spanning 5 question ids. That bank could not
detect a judge that is lenient on safety, one that rewards padding, or one that
collapses on close calls — there was simply no anchor of any of those shapes.

The bank now holds **67 anchors across 31 question ids**, split into:

- `data/calibration/anchors.yaml` — 44 anchors (12 legacy hand-written v2
  anchors + 32 new archive-sourced anchors). The **development** split: used
  while tuning judge prompts, severity mappings and tolerances.
- `data/calibration/holdout.yaml` — 23 anchors (34% of the bank). The
  **holdout** split: structurally identical file, same schema, never to be
  scored during tuning. Acceptance thresholds for a panel must be judged on
  this file precisely because nothing was fitted to it.

Every new anchor's `answerText` is copied **verbatim** from a stored response
in `data/runs/2026-07-v2.1/responses/` (that run: 14 models × 184 questions,
630 judged answers, 73 flagged panel disagreements). Provenance — source model,
the run's two seat scores, disagreement, and flag status — is recorded in each
anchor's `note`. The judge never sees the note (`buildJudgeMessages` sends only
the question and the anonymised answer), but a human auditor can trace every
anchor back to its artifact.

## Schema

Exactly the shape `calibration.ts` reads (`CalibrationAnchor`); no extra keys:

```yaml
- questionId: flav-013        # must exist in data/questions/ AND be llm-judge/fault graded
  note: "[stratum: …] [source: 2026-07-v2.1 <model>] [run seats: …] hand-score reasoning"
  expectedScore: 100          # agent hand-score, 0–100
  toleranceAbs: 10            # per-anchor band; DEFAULT_TOLERANCE=20 if omitted
  answerText: |               # VERBATIM archived model output
    …
```

Stratum membership is encoded as a `[stratum: …]` tag at the head of `note`
rather than as a separate YAML key, so the files stay schema-exact for the
current loader while coverage remains greppable:

```
grep -o "stratum: [a-z-]*" data/calibration/anchors.yaml | sort | uniq -c
```

## Strata

Each stratum exists so the gate can catch one specific judge failure mode.

| Stratum | dev | holdout | Catches a judge that… |
|---|---|---|---|
| correct-high | 6 | 5 | invents faults on sound answers (v1's anti-inflation problem, inverted) |
| confidently-wrong | 6 | 3 | is charmed by fluent, well-structured, materially wrong answers |
| hidden-hazard | 3 | 3 | is lenient on safety — answers that *read* safe and are not |
| close-valid-pair | 4 (2 pairs) | 2 (1 pair) | separates two equally sound approaches (over-reads style) |
| concise-vs-padded | 6 (3 pairs) | 4 (2 pairs) | rewards or punishes length (documented verbosity bias of deduction grading) |
| panel-split | 7 | 6 | collapses to one pole on genuinely contested judgements |
| legacy v2 hand-written | 12 | 0 | (kept unchanged; the original 5-question bank) |

Per-category coverage (new + legacy):

| Category | dev | holdout |
|---|---|---|
| flavor-pairing | 13 | 9 |
| technique | 13 | 2 |
| recipe-generation | 16 | 11 |
| substitutions | 2 | 1 |
| conversions / food-safety / nutrition / quantities-scaling | 0 | 0 — see "What could not be sourced" |

The pair strata are *joint* tests: each pair shares a question, both members
carry `expectedScore: 100` (±10), and the anchors cross-reference each other in
their notes. A judge can pass each member individually while failing the intent
— if it scores the concise twin 92 and the padded twin 100 repeatedly, it is
pricing length even though both pass. The per-anchor gate catches the gross
version; the paired structure makes the subtle version visible to a human
reading `calibration.json`. (A mechanical pair-gap check would be a
`calibration.ts` change; see "Loader changes needed".)

`flav-013` (cheese board with a pregnant guest) appears eight times across
strata. That is deliberate: it is the single most discriminating judged item in
the run (panel scores 10–100 across 14 models, 8 of 14 flagged) and the only
item where correct-high, hidden-hazard and panel-split behaviour all occur on
the *same prompt*, which is exactly what a calibration bank wants.

## Banding philosophy (honoured, with one designed exception)

The house rule, learned from real panel runs: judges agree tightly on good
answers and legitimately span 0–55 on confidently-wrong ones. Tight top is
anti-inflation; loose bottom avoids fighting honest disagreement. The gate
checks bands, not points.

- **correct-high**: `expectedScore` 95–100, `toleranceAbs` 10 (15 where a
  defensible minor exists, e.g. the deepseek flav-013 anchor's NHS-vs-stricter
  unpasteurised-hard-cheese framing).
- **confidently-wrong**: tolerances 20–30. Centres are placed at the middle of
  the *defensible* span, not at my point estimate, to minimise the MAE cost an
  honest judge pays on these anchors.
- **panel-split**: tolerances 25–45. These are the run's genuinely contested
  judgements (seat gaps of 40–95 points on identical text). The anchor bounds
  the extremes; it does not adjudicate the dispute. Do **not** tighten one of
  these without a human ruling on the underlying question (several hinge on
  jurisdiction: NHS vs FDA on Stilton/raw-milk cheese in pregnancy, FDA
  tree-nut classification of coconut vs UK practice).
- **hidden-hazard — the designed exception**: tolerances 15–25 despite sitting
  low on the scale. The task of these anchors is to make safety leniency
  *disqualifying*, which a ±30 band cannot do. To keep the tight band honest,
  hazard anchors were only drawn from cases where the run's two seats already
  agreed (e.g. both seats 0 on "All ingredients are naturally dairy-free" over
  milk-powder instant mash for an epipen-serious allergy). Hazard-shaped
  answers where the panel itself split (raw-fish starter, Worcestershire-for-
  coeliac read as major vs critical) are filed under panel-split or carry the
  wider band instead — a tight band on a contested reading would just fail
  honest judges.

Mid-band anchors are rare and precious: `tech-011` (gemini-3.1) drew 55 from
*both* seats independently — disagreement 0 at mid-scale — and is banded ±20.

## How hand-scores were produced

For each candidate: read the full archived answer, read the question's prompt,
reference answer and judgingNotes, read both seat verdicts (score + itemised
findings), then re-derived a score under the shipped severity arithmetic
(critical −40 / major −15 / minor −5 from 100, floored at 0) applying the
prompt's own rule that each *distinct root mistake* counts once. Where my
reading and the seats' readings diverged, the band was widened to cover every
reading I could defend, and the note says which reading anchors each edge.

One consequence worth calling out: the `rgen-003` (sonnet) anchor centres at 65
even though one real seat scored it 25, because that seat issued a separate
major for every non-gram line (buttermilk ml, eggs by count, tsp lemon juice,
"pinch" of salt) — the same root decision counted four times, which the judge
prompt explicitly forbids. The band (35–95) deliberately excludes the stacked
reading. This is the one place the bank takes a side against an incumbent
seat's actual behaviour; it is in the dev split, not the holdout, so if the
current panel fails it the failure is visible during tuning rather than
blocking an acceptance run.

## Findings about the incumbent panel (evidence, not conclusions)

Reading 55 answers against their verdicts surfaced patterns a future tuning
pass should know about:

- **gpt-5.5 is the harsh seat on pregnancy/raw-milk items** and stacks
  root faults (see rgen-003 above; also scored opus-5's flav-013 at 0 while
  grok-4.5 scored the same text 95).
- **grok-4.5 is internally inconsistent on the NHS Stilton question across
  answers**: it cited NHS guidance to *permit* Stilton when judging one answer
  (minor, 95) and to *forbid* it when judging another (critical, 5). Seat
  pairings differ per candidate (self-preference exclusion + hash drop), so
  this inconsistency directly moves published scores.
- **The flav-013 judgingNotes themselves take a contestable position**
  (treating Stilton as a "soft-ish blue"; NHS lists Stilton as a hard cheese
  that is fine in pregnancy). Several panel-split anchors exist *because* the
  item's attention hint and public guidance pull judges in opposite
  directions. A human should re-adjudicate that item's notes.

## MAE interaction — read before adding more wide anchors

The gate enforces two things per seat: every anchor within its band, and
**MAE ≤ 10 across the whole bank** (`MAE_LIMIT` in calibration.ts). Wide-band
anchors are individually permissive but each contributes its miss to the MAE.
With 13 panel-split anchors, an honest judge that lands 20–35 points off those
centres (fully inside band) while nailing the 21 tight anchors pays roughly
(13×25)/67 ≈ 4.9 MAE from splits alone — safe, but the headroom is real: a
bank that grew to ~25 wide anchors without growing the tight majority would
start failing well-calibrated judges on MAE while every band passes. If that
happens, the right fix is per-stratum MAE (tight strata at ≤10, split strata
band-only) — a `calibration.ts` change, described below, not made here.

## Loader changes needed (NOT made — calibration.ts is owned elsewhere)

1. **Holdout loading.** `loadAnchors()` reads the hard-coded `ANCHORS_PATH`
   (`data/calibration/anchors.yaml`). The minimal change: give it an optional
   path parameter (or add `loadHoldoutAnchors()` reading
   `data/calibration/holdout.yaml`), and have `runCalibration` accept a
   `bank: 'dev' | 'holdout'` choice recorded in the emitted
   `calibration.json`. Holdout runs should be rare, deliberate, and labelled
   in the artifact so a tuning loop cannot silently consume them.
2. **Pair-gap check (optional).** For close-valid-pair and concise-vs-padded
   anchors, flag |score(a) − score(b)| > 10 within a pair even when both pass
   their bands. Pairs are identifiable today by note tags sharing a questionId
   and stratum.
3. **Per-stratum MAE (only if needed).** See the MAE section above.

## What could not be sourced from the archive, and why

- **Conversions, food-safety, nutrition and quantities-scaling anchors do not
  exist and currently cannot.** The gate scores anchors through
  `judgeAnswer` → `buildJudgeMessages` → `assertFaultMode`, which **throws**
  on any question whose grader is not `llm-judge` (`judge.ts`:
  "Question X is not judge-graded"). Those four categories contain zero
  llm-judge items in the dataset (they are numeric/keyword/range graded), so
  an anchor citing e.g. `safe-014` would crash the calibration gate on its
  first run — a malformed-anchor failure, not coverage. Safety judgement is
  instead exercised through judged items whose *substance* is safety-critical
  (pregnancy listeria constraints in flav-013, allergen constraints in
  rgen-007/015/017/019, food-safety-of-raw-fish in rgen-020). Real
  food-safety-category anchors become possible only when v3 adds llm-judge
  items to that category, or when the gate learns to score anchors through
  deterministic graders.
- **Substitutions is thin (3 anchors, all on subs-020)** because subs-020 is
  the category's only judge-graded item. Nothing else existed to source.
- **No archived answer exhibits a pure "reward for sycophancy/confident tone"
  failure isolated from factual error** — confident wrongness always co-occurs
  with real faults in this run, so that judge failure mode is only tested
  jointly (confidently-wrong stratum), not in isolation.

## The central limitation — circularity

These hand-scores were produced by an AI agent reading model answers and model
judge verdicts. Where the run's panel was unanimous, the anchor largely
*encodes the panel's own behaviour back at it* — a jury validated against
labels derived from itself is not validated; it is self-consistent. The
independent contribution here is the reading of each answer against the
question's ground truth (arithmetic re-derived, guidance checked, methods
sanity-checked) and the banding structure; it is real work, but it is not
expert labelling.

Therefore:

- This bank is **development material**. It can catch gross regressions (a
  drifted judge model, a broken prompt, a severity scheme that stopped biting,
  a seat that goes soft on safety or starts paying for length).
- It **cannot support a release claim** of the form "the judge panel is
  calibrated". That requires anchors whose expected scores were set by
  qualified humans — chef/food-safety review of at minimum the hidden-hazard
  and panel-split strata, several of which turn on genuinely contested
  guidance (NHS vs FDA) that an agent must not adjudicate.
- The sealed **Culinary JudgeBench holdout** described in the master plan — a
  human-labelled, sealed artifact — is a separate deliverable. This bank does
  not replace it, feed it, or substitute for it. When that artifact exists,
  this bank remains useful as the cheap always-on regression gate in front of
  it.

## Verification performed

- Both files parse with the repo's own `yaml@2.9.0` (the package
  `calibration.ts` uses); every anchor carries exactly the
  `CalibrationAnchor` keys with correct types.
- All 55 archive-sourced `answerText` values compared byte-for-byte against
  `data/runs/2026-07-v2.1/responses/*.json` — zero mismatches.
- Every `questionId` exists in `data/questions/` and is `llm-judge`
  fault-mode graded (so the gate will not throw).
- Stratum and category counts above regenerated from the files themselves.
