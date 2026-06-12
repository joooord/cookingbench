# Eval & benchmark research survey — June 2026

Deep-research pass over 2023–2026 evaluation literature and the practices of
credible benchmarks (HELM, Chatbot Arena, SWE-bench, ARC-AGI, Epoch AI,
LiveBench, MathArena), run before the first methodology-v3 paid run. Five
parallel research strands; the load-bearing claims were adversarially
re-verified against primary sources. This file records what we learned, what
changed in the repo as a result, and what was deliberately deferred.

## How CookingBench already matches best practice

The v2 design independently arrived at several published recommendations:

- **Cross-family judge panel with self-recusal.** PoLL (Verga et al. 2024,
  [arXiv:2404.18796](https://arxiv.org/abs/2404.18796)) shows panels of
  diverse judges beat a single big judge on human agreement, and documents
  self-preference: the largest positive score delta occurs when a model is
  judged by itself. Our two-seats-never-own-provider rule is that paper's
  remedy.
- **Reference-guided, rubric-anchored grading.** Reference answers cut GPT-4's
  math-judging failure rate from 70% to 15% (MT-Bench, Zheng et al. 2023,
  [arXiv:2306.05685](https://arxiv.org/abs/2306.05685)); explicit criteria
  matter more than chain-of-thought (Design-Choices study 2025,
  [arXiv:2506.13639](https://arxiv.org/abs/2506.13639)). Judges see the
  reference and judgingNotes; deduction grading is the fault-decomposition.
- **Calibration anchors + escalation on disagreement.** Cascaded selective
  evaluation with confidence-gated escalation to humans is the published
  version of our anchor gate + >15-point disagreement flag (Trust or
  Escalate, ICLR 2025,
  [openreview](https://openreview.net/forum?id=UHPnqSTBPO)). No public
  benchmark documents a *stricter* anchor gate than our MAE ≤ 10.
- **Saturation ratchet as contamination defence.** GSM1k
  ([arXiv:2405.00332](https://arxiv.org/abs/2405.00332)) and LiveCodeBench
  ([arXiv:2403.07974](https://arxiv.org/abs/2403.07974)) frame contamination
  as observable saturation/overfitting — exactly the demotion ratchet's logic.
  Note the canary GUID *detects* training-set inclusion, it does not prevent
  it: GPT-4-base reproduced BIG-bench's canary verbatim
  ([Alignment Forum 2024](https://www.alignmentforum.org/posts/kSmHMoaLKGcGgyWzs/big-bench-canary-contamination-in-gpt-4)).
- **Immutable per-response artifacts in git** matches the strongest
  transparency norm (HELM per-instance artifacts; Epoch AI publishes every
  prompt/response/score and aims to record the exact git revision per run).

## Gaps found → what changed (methodology v3)

1. **Unpaired bootstrap CIs could not answer "is 96.4 vs 95.1 real?"**
   Miller ("Adding Error Bars to Evals", Anthropic 2024,
   [arXiv:2411.00640](https://arxiv.org/abs/2411.00640)) recommends inference
   on question-level *paired* differences (SE²_paired = SE²_A + SE²_B −
   2·SE_A·SE_B·corr); with positively correlated per-question scores, pairing
   shrinks comparison variance for free. (His worked correlation table is
   illustrative/fictional data — verified — but the method is the point.)
   At ~117 active questions, unpaired CIs resolve only ~10-point gaps;
   CLT-style intervals are also anti-conservative under n < a few hundred
   (Bowyer et al. 2025, [arXiv:2503.01747](https://arxiv.org/abs/2503.01747)).
   **Change:** `report.ts` now draws one set of question resamples per
   replicate and scores every model on it, and publishes a per-model **95%
   rank interval** (MathArena-style, [arXiv:2505.23281](https://arxiv.org/abs/2505.23281):
   bestRank = 1 + #models significantly above; worstRank = N − #significantly
   below). The site shows the interval next to the rank. Tested: a constant
   3-point gap with heavily overlapping marginal CIs gets settled ranks.

2. **No inter-judge reliability statistic was published.**
   Interval Krippendorff's alpha is the standard for 0–100 two-rater data
   (Krippendorff's computing guide; conventional thresholds α ≥ 0.8 reliable
   / ≥ 0.667 tentative, with the caveat that the cutoffs are convention).
   Under top-heavy score skew, alpha/kappa deflate despite high raw agreement
   (the kappa paradox — Feinstein & Cicchetti 1990; Gwet's AC1/AC2 is the
   robust alternative), so alpha must be read alongside Spearman and MAE.
   **Change:** `bench analyze` now emits `judgeAgreement` (items, MAE,
   Pearson, Spearman, interval alpha, flag rate, per-seat means for drift
   tracking between runs). Run read-only against 2026-06-v2: α = 0.555,
   MAE = 7.7, flag rate 13.9%, and a real seat-leniency gap (Qwen seat mean
   96.2 vs GPT-5.5 88.2). Watch per-seat means across runs; re-calibrate
   anchors on any judge slug change (judge version changes reorder rankings —
   LLM-Evaluation Tropes, [arXiv:2504.19076](https://arxiv.org/abs/2504.19076)).

3. **Verbosity bias was asserted, never measured.** Deduction grading should
   penalize length (more surface for findings) — opposite to preference
   judges' verbosity bias (MT-Bench's repetitive-list attack fooled GPT-3.5 /
   Claude-v1 91.3% of the time; AlpacaEval LC,
   [arXiv:2404.04475](https://arxiv.org/abs/2404.04475), cut length
   gameability ~25%→10% — corrected figures, verified).
   **Change:** `bench analyze` now emits `lengthBias` (pooled and
   within-question Spearman of answer length vs judge score). On 2026-06-v2:
   pooled −0.317 but **within-question +0.13** — once item difficulty is
   controlled, longer answers score slightly *higher*. The "deduction grading
   punished verbose models, hence terse GPT-5.4 Mini won" theory in CLAUDE.md
   is not supported within-question; treat that ranking as more likely genuine.

4. **Traps could be farmed by reflexive premise-rejection.** FalseQA (Hu et
   al., ACL 2023, [aclanthology 2023.acl-long.309](https://aclanthology.org/2023.acl-long.309/))
   pairs every false-premise question with a true-premise twin for exactly
   this reason; AbstentionBench (2025,
   [arXiv:2506.09038](https://arxiv.org/abs/2506.09038)) finds reasoning
   models fail premise-handling *more*, not less.
   **Change:** all 15 active traps now have `pairId`-linked control twins
   (same surface, sound premise; keyword graders require the substantive
   answer). Verified both directions: every twin's reference answer scores
   100, and a canned premise-rejecting answer scores 0 on all 15.

5. **Only the newest run was visible — v2 would vanish when v3 publishes.**
   HELM keeps version-stamped leaderboards permanently addressable; LiveBench
   keeps a changelog; Chatbot Arena publishes vote snapshots. BetterBench
   (NeurIPS 2024, [arXiv:2411.12990](https://arxiv.org/abs/2411.12990)) found
   most benchmarks fail replication/reporting basics.
   **Change:** `/runs` archive (index + per-run pages, prerendered for
   2026-06-v1 and 2026-06-v2) with explicit "not comparable across
   methodology versions" framing, linked from the homepage, nav and
   methodology page. Artifacts in git remain the deep record.

6. **Near-duplicate audit** (MinHash-style shingle Jaccard is standard —
   Lee et al., [arXiv:2107.06499](https://arxiv.org/abs/2107.06499)): one-off
   5-gram Jaccard pass over all 232 prompts found only two template-sibling
   pairs (safe-001/002, qty-004/014), all `basics`, with genuinely different
   answers. No action needed.

## Considered and deliberately deferred

- **k > 1 samples per question (avg@k).** MathArena runs avg@4; Epoch runs up
  to 16. Per Miller's variance decomposition, k only shrinks the
  answer-sampling term — at our n, question-sampling variance dominates, and
  at temperature 0 resampling variance is small. Not worth 4× spend now;
  revisit if budget grows.
- **Temperature 0 vs API-default.** Epoch evaluates at API defaults; greedy
  decoding isn't perfectly deterministic anyway. Keeping temp 0 for
  reproducibility of deterministic graders; the choice is recorded in config.
- **Gwet's AC2** alongside alpha: viable later; Spearman+MAE cover the skew
  caveat for now.
- **Style-controlled scoring** (Arena style control): our counterweight is
  the human taste test, by design.
- **Cluster-aware bootstrap**: items are independent (no shared passages), so
  question-level resampling is correct; revisit if multi-part briefs sharing
  a context are ever added.
- **Judged-score scale**: the −40/−15/−5 deduction mapping has no direct
  literature validation (scale perturbations alone shift judge scores —
  [arXiv:2506.22316](https://arxiv.org/abs/2506.22316)); the anchor gate is
  what defends it. Left unchanged the night before a run on purpose.

## Outstanding debts the literature says matter most

1. **The 81 flagged v2 disagreements need human review** — the escalation
   gate's promise is hollow until the tail is actually reviewed (Trust or
   Escalate's guarantee assumes the escalated set gets human verdicts).
2. **Dataset growth is the only cure for CI width**: detecting a 3-point gap
   at 80% power wants on the order of 1,000 questions (Miller's power
   formula). The rank intervals make the current uncertainty honest; more
   active items make it smaller.
3. **Perturbation probe before demotion** (GSM-Symbolic,
   [arXiv:2410.05229](https://arxiv.org/abs/2410.05229)): when the ratchet
   next flags saturated items, renumber/relocale a few first — if scores
   collapse, the original was memorized, validating demotion.
