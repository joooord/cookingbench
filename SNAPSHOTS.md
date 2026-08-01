# Snapshots

Permanent, immutable reference points. Each is a branch on `origin` that is
never advanced or deleted, so the state can always be recovered even if the
working branches move on.

Why branches rather than tags: this repo is pushed through a git relay that
accepts branch refs but rejects tag refs. A `backup/*` branch is the durable
primitive available. Treat these branches as read-only — if you need a tag
locally, create it from the recorded commit.

To recover a snapshot:

```
git fetch origin backup/<name>
git checkout -b inspect origin/backup/<name>
```

---

## `backup/v2.1-published-2026-07-30` — commit `980dfcb`

Taken before the v2.2 / v3 methodology work began. At this commit the deploy
branch (`claude/peaceful-bardeen-bo2h6q`) and the working branch
(`claude/cookingbench-code-review-70c3hx`) were identical.

**Run `2026-07-v2.1`** — the artifact this snapshot exists to preserve:

- 14 models × 184 questions = **2,576 responses**, all present, none malformed,
  no empty answers.
- 630 answers panel-judged, **0 unjudged**, 73 flagged for cross-judge
  disagreement above 15 points.
- Panel: `claude-opus-4.8` (calibration MAE 8.5), `gpt-5.5` (3.3),
  `grok-4.5` (6.0).
- Real spend: **$26.93** candidates + **$14.19** judging + **$0.49**
  calibration = **$41.61**.
- Headline result: five models statistically tied for first. 48 of 91 model
  pairs separate, uncorrected for multiplicity. (Historical — the derived
  scores were subsequently disowned by
  `docs/errata/2026-07-v2.1-corpus-and-scores.md` and are not citable as a
  ranking.)

Also preserved: `2026-06-v1` (methodology v1, saturated), `2026-06-v2`
(13 models, panel-judged), `canary`, `canary2`, all 26 taste ballots in
`data/taste/votes.ndjson` with a Bradley-Terry ratings snapshot, and Supabase
migrations 0001–0007 as applied to the live project.

### Known defects at this snapshot

Recorded rather than fixed, because run artifacts are immutable and the defects
are part of the honest record. **Do not rewrite this snapshot to fix them** —
the v3 methodology-first programme supersedes it (the scores were disowned by
the erratum rather than re-run; any successor result will carry a new run id).

1. **Declared rubric weights never reach the judge.** `attentionHints()` in
   `packages/runner/src/judge.ts` passes criterion names and descriptions but
   drops `weight`. 97 weight declarations across the dataset are decorative, so
   "Flavour logic: 50%" is not a 50% scoring dimension.
2. **12 active items have negative discrimination**, carrying **15.4%** of all
   ranking variance — they rank weaker models above stronger ones. Removing
   them reorders the top four. The two largest variance contributors overall are
   both defective: `nutr-036` (9.1%, reference contradicted by 10 of 13 models)
   and `flav-014` (9.0%, discrimination −9.5).
3. **Model pages contradict the leaderboard.** `apps/web/app/models/[slug]/page.tsx`
   derives rank from `report.rows.indexOf(row) + 1`, so a model shown `=1st` on
   the homepage is labelled `#2` on its own page and in its search description.
4. **"Run cost" is candidate spend only** — $26.93 displayed against $41.61 real.
5. **Safety is compensable.** A `critical` judge finding costs 40 points, so
   dangerous advice can publish at 60.
6. **Grader fixtures are thin.** 159 of 184 items have no `failingAnswer`;
   50 items score 100 on bare keyword stuffing.
7. **73 judge disagreements are flagged but never adjudicated** — the disputed
   two-seat mean survives as the score.
8. **Separation claims are uncorrected for multiplicity.** 48 of 91 pairs at an
   uncorrected 95% threshold will contain false discoveries; Holm adjustment is
   pending.
