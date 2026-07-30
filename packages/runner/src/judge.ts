import {
  canonicalId,
  criterionAttentionHint,
  hasJudgeConflict,
  isAtomicCriterion,
  type AtomicCriterion,
  type BehaviouralAnchorSet,
  type JudgeMode,
  type Question,
} from '@cookingbench/core';
import type { ChatMessage, CompletionClient } from './openrouter.js';

/**
 * The judge, in two generations that deliberately do not blend.
 *
 * `judge-v2` is the shipped route: two conflict-free seats, deduction grading,
 * a mean. It stays here unchanged in behaviour because 2026-07-v2.1 was scored
 * with it and the pipeline still runs on it.
 *
 * The v3 routes below implement M2.1 and M2.5 — three grading modes, a jury of
 * three conflict-free seats drawn by a preregistered balanced design, both
 * presentation orders collapsed into one rater unit, and an UNWEIGHTED MAJORITY
 * as the primary analysis. They are additive: nothing in v2 changes shape, and
 * a v3-declared item is refused by the v2 entry points rather than quietly
 * downgraded into them (`assertFaultMode`). Silent downgrade is the failure
 * class that put eighteen wrong scores into 2026-06-v2; it does not get a
 * second outing.
 */
export const JUDGE_PROMPT_VERSION = 'judge-v2';

/** One prompt version per mode. A ballot is only comparable within its version. */
export const JUDGE_PROMPT_VERSIONS = {
  fault: JUDGE_PROMPT_VERSION,
  dimension: 'judge-v3-dimension',
  pairwise: 'judge-v3-pairwise',
} as const satisfies Record<JudgeMode, string>;

/**
 * judge-v2: reference-anchored deduction grading. The judge only enumerates
 * concrete faults; the severity→points arithmetic lives here, in code. v1's
 * absolute 0–5 rubric saturated (75% of judged answers got every criterion
 * perfect); finding faults is the discriminating task.
 */
export const SEVERITY_POINTS = { critical: 40, major: 15, minor: 5 } as const;

/**
 * Reserved per judge call before it is made. Measured: 1,260 judge calls in
 * 2026-07-v2.1 cost $14.19, about $0.011 each; this is a deliberate ceiling
 * over that, since a reservation that undershoots lets the cap be passed.
 */
export const JUDGE_WORST_CASE_PER_CALL_USD = 0.05;
export type Severity = keyof typeof SEVERITY_POINTS;

export interface JudgeFinding {
  quote: string;
  issue: string;
  severity: Severity;
  /** Atomic criterion this fault belongs to, where the item declares any. */
  criterionId?: string;
}

export interface JudgeVerdict {
  /** 0–100: 100 minus severity deductions, floored at 0. */
  score: number;
  findings: JudgeFinding[];
  summary: string;
  /**
   * Self-reported 0–1. Optional here and REQUIRED on v3 ballots: legacy fault
   * ballots predate the field, and an absent confidence must never be read as a
   * confident one — see `isConfident`.
   */
  confidence?: number;
}

/* -------------------------------------------------------------------------- */
/* M2.5 — blinding                                                            */
/* -------------------------------------------------------------------------- */

export const BLINDING_VERSION = 'blind-v3';

const REDACTION = '[assistant]';
/** Self-reference phrases carry a provider fingerprint without naming one. */
const SELF_REFERENCE_REDACTION = '[assistant self-reference]';

/**
 * Tokens a roster entry contributes that are ALSO ordinary English or ordinary
 * culinary vocabulary.
 *
 * This list is the reason blinding is two-tier. "Llama" is a meat in Andean
 * cooking, "meta" prefixes half the adjectives in a methodology note, "mistral"
 * is the wind that dries Provençal sausage, "sol"/"terra"/"opus"/"fable" are
 * words. Redacting them wholesale would edit the candidate's culinary text,
 * which M2.5 forbids outright ("Preserve candidate text"), and is the same
 * mistake as the keyword grader forbidding "coconut" on a coconut-allergy item.
 * So they are redacted only inside a self-identification context, and reported
 * as POSSIBLE — never certain — leaks.
 */
const AMBIGUOUS_IDENTITY_TOKENS = new Set([
  'claude', 'llama', 'mistral', 'meta', 'google', 'alibaba', 'moonshot', 'kimi', 'sol', 'terra',
  'opus', 'fable', 'sonnet', 'maverick',
  // "Bard" is here rather than in the certain list because barding — wrapping a
  // lean cut in fat — is a technique this dataset asks about. A blinder that
  // deletes "bard the loin" has corrupted the answer it was protecting.
  'bard',
]);

/**
 * Tier and size words a display name contributes and that identify NOTHING.
 *
 * Dropped from the lexicon entirely rather than filed as ambiguous: "Mini",
 * "Large", "Pro" and "Flash" would otherwise be reported as possible leaks by
 * roughly every question in the bank ("large eggs", "flash-fry"), and a leak
 * report that cries wolf is a leak report nobody reads.
 */
const GENERIC_TIER_WORDS = new Set([
  'mini', 'max', 'plus', 'pro', 'large', 'small', 'flash', 'preview', 'turbo', 'ultra', 'nano',
  'lite', 'base', 'chat', 'instruct', 'exp', 'beta', 'alpha',
]);

/**
 * Vendor and product tokens that never appear in a recipe by accident. Redacted
 * wherever they occur, and treated as a certain leak in a prompt.
 */
const CERTAIN_IDENTITY_TOKENS = [
  'openai', 'anthropic', 'chatgpt', 'gpt', 'deepseek', 'xai', 'x-ai', 'x.ai', 'qwen', 'grok',
  'gemini', 'copilot', 'moonshotai', 'meta ai', 'google deepmind', 'mistral ai',
  'moonshot ai', 'alibaba cloud',
];

/** Self-identification phrasing that leaks a provider without naming a model. */
const SELF_REFERENCE_PATTERNS: RegExp[] = [
  /\bas an? (?:ai|artificial intelligence|large language model|language model|llm)(?: (?:model|assistant|system))?\b/gi,
  /\bi(?:'m| am) an? (?:ai|artificial intelligence|large language model|language model|llm)(?: (?:model|assistant|system))?\b/gi,
  /\bmy (?:training data|training corpus|training set|training cut[- ]?off|knowledge cut[- ]?off|guidelines|system prompt|instructions|usage policies|policies|safety guidelines|creators?|developers?|makers?|training)\b/gi,
  /\bi (?:was|have been) (?:trained|developed|created|built|made)\b/gi,
];

export interface BlindingLexicon {
  /** Redacted everywhere, and a certain leak when found in a prompt. */
  certain: string[];
  /** Redacted only in an identification context; a possible leak in a prompt. */
  possible: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Boundary-aware match for a token that may contain '/', '.' or '-'.
 *
 * \b is defined on word characters, so `\bx-ai\b` anchors at the wrong places
 * and `\banthropic/claude-opus-5\b` fails to close after a digit followed by a
 * slash. Lookarounds on "not a letter or digit" behave the same for every token
 * shape, which matters because the tokens come from a data file.
 */
function tokenPattern(token: string, flags = 'gi'): RegExp {
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(token)}(?![A-Za-z0-9])`, flags);
}

function classifyToken(token: string): 'certain' | 'possible' | 'drop' {
  const key = token.trim().toLowerCase();
  if (GENERIC_TIER_WORDS.has(key)) return 'drop';
  return AMBIGUOUS_IDENTITY_TOKENS.has(key) ? 'possible' : 'certain';
}

/**
 * Derive the blinding lexicon from the roster.
 *
 * Deliberately structural, like `identityIndex`: the lexicon is whatever the
 * roster declares, so adding a model to data/models.yaml extends the blinding
 * and the leak test in the same commit.
 *
 * Multi-word display names are kept as WHOLE PHRASES and never split into
 * words. Splitting "GPT-5.4 Mini" or "Mistral Large 3" would put "Mini" and
 * "Large" in the lexicon, and a blinder that redacts "large eggs" has destroyed
 * the answer it was protecting.
 */
export function blindingLexicon(
  models: ReadonlyArray<{ id: string; displayName?: string; provider?: string; family?: string }>,
): BlindingLexicon {
  const certain = new Set<string>(CERTAIN_IDENTITY_TOKENS);
  const possible = new Set<string>();

  const add = (raw: string | undefined, forceCertain = false): void => {
    const token = (raw ?? '').trim().toLowerCase();
    if (token.length < 3) return; // "3", "v4" and the like identify nothing
    if (forceCertain) {
      certain.add(token);
      return;
    }
    const kind = classifyToken(token);
    if (kind === 'drop') return;
    if (kind === 'possible') possible.add(token);
    else certain.add(token);
  };

  for (const m of models) {
    // The full slug and its tail are unambiguous whatever they contain.
    add(m.id, true);
    const tail = m.id.includes('/') ? m.id.slice(m.id.indexOf('/') + 1) : '';
    if (tail) add(tail, true);
    const vendorPrefix = m.id.includes('/') ? m.id.slice(0, m.id.indexOf('/')) : '';
    add(vendorPrefix);

    if (m.displayName) {
      // Phrase first (certain), then only the leading word, which is the part
      // that identifies a family. Trailing size/tier words never enter.
      add(m.displayName, true);
      add(m.displayName.split(/\s+/)[0]);
    }
    if (m.provider) {
      add(m.provider, m.provider.trim().split(/\s+/).length > 1);
      add(m.provider.split(/\s+/)[0]);
    }
    if (m.family) {
      // NOT forced certain. Roster families are sometimes a bare word — `llama`,
      // `mistral`, `kimi` — and forcing those into the certain list would redact
      // llama shoulder and the mistral out of the candidate's own text. The
      // compound families (`claude-frontier`, `gemini-pro`) classify as certain
      // on their own merits.
      add(m.family);
      add(m.family.split('-')[0]);
    }
  }
  // A token cannot be both: certain wins, since redacting more is the safe
  // direction for anything that reached the certain list by any route.
  for (const token of certain) possible.delete(token);
  return {
    certain: [...certain].sort((a, b) => b.length - a.length),
    possible: [...possible].sort((a, b) => b.length - a.length),
  };
}

/** The static lexicon used when no roster is supplied. Never empty: absence of a roster must not mean absence of blinding. */
const STATIC_LEXICON: BlindingLexicon = {
  certain: [...CERTAIN_IDENTITY_TOKENS].sort((a, b) => b.length - a.length),
  possible: [...AMBIGUOUS_IDENTITY_TOKENS].sort((a, b) => b.length - a.length),
};

/**
 * Strip anything that could reveal which model wrote an answer.
 *
 * Hardened well past the three contractions v2 shipped with. v2 looked for
 * `as|i'm|i am` immediately before a handful of hard-coded product names, so
 * "This is Claude.", "— ChatGPT" on the last line, "developed by Anthropic",
 * "my training data ends in 2024" and every model added to the roster since all
 * walked straight through into the judge's context.
 *
 * The container is standardised; the culinary text is not touched. Ambiguous
 * tokens (see AMBIGUOUS_IDENTITY_TOKENS) are removed only where the sentence is
 * identifying the author.
 */
export function anonymizeAnswer(text: string, lexicon: BlindingLexicon = STATIC_LEXICON): string {
  let out = text;

  // 1. Attribution frames, for tokens of either class. These carry the
  //    ambiguous ones: "as Claude" is identification, "llama shoulder" is food.
  const allTokens = [...lexicon.certain, ...lexicon.possible].sort((a, b) => b.length - a.length);
  const alternation = allTokens.map(escapeRegExp).join('|');
  if (alternation.length > 0) {
    const frames = [
      // "As ChatGPT", "I'm Claude", "This is Gemini", "speaking as Grok"
      new RegExp(
        `\\b(?:as|i'm|i am|im|this is|you(?:'re| are) (?:chatting|speaking) with|speaking as|acting as|signed,?)\\s+(?:an?\\s+)?(?:${alternation})(?![A-Za-z0-9])`,
        'gi',
      ),
      // "developed by Anthropic", "trained by OpenAI", "powered by Gemini"
      new RegExp(
        `\\b(?:developed|created|made|built|trained|designed|fine[- ]?tuned|operated|deployed|powered|generated|trained up)\\s+by\\s+(?:the\\s+)?(?:${alternation})(?![A-Za-z0-9])`,
        'gi',
      ),
      // "Anthropic's guidelines", "OpenAI's policy", "Claude's team"
      new RegExp(
        `\\b(?:${alternation})(?:'s|’s)\\s+(?:model|assistant|team|guidelines|policy|policies|usage policies|safety|api|servers?)\\b`,
        'gi',
      ),
    ];
    for (const frame of frames) out = out.replace(frame, REDACTION);

    // 2. A trailing sign-off line: "— Claude", "Best, ChatGPT", "-Gemini".
    //    Position is what makes an ambiguous token identifying here, so this is
    //    anchored to the end of the text rather than applied line by line.
    const signOff = new RegExp(
      `(?:\\r?\\n)\\s*(?:[-—–*_~]{0,3}\\s*)?(?:best(?: regards)?|regards|sincerely|cheers|yours(?: truly)?|from)?[,:]?\\s*(?:${alternation})\\s*[.!]?\\s*$`,
      'i',
    );
    out = out.replace(signOff, `\n${REDACTION}`);
  }

  // 3. Certain tokens, wherever they appear.
  for (const token of lexicon.certain) out = out.replace(tokenPattern(token), REDACTION);

  // 4. Provider-fingerprinting self-reference that names nobody.
  for (const pattern of SELF_REFERENCE_PATTERNS) {
    out = out.replace(pattern, SELF_REFERENCE_REDACTION);
  }

  return out;
}

export interface IdentityLeak {
  token: string;
  /** certain = a name that identifies a model or vendor outright. */
  kind: 'certain' | 'possible';
}

/**
 * Every roster identifier still present in a piece of text.
 *
 * Used two ways: as a runtime guard on assembled prompts (`assertPromptBlind`)
 * and as the standing structural test over the whole dataset. The second is the
 * cheap permanent one — a new question whose reference answer says "unlike
 * Gemini 3.1…" fails the suite before it can reach a judge.
 */
export function identityLeaks(
  text: string,
  lexicon: BlindingLexicon = STATIC_LEXICON,
): IdentityLeak[] {
  const leaks: IdentityLeak[] = [];
  for (const token of lexicon.certain) {
    if (tokenPattern(token, 'i').test(text)) leaks.push({ token, kind: 'certain' });
  }
  for (const token of lexicon.possible) {
    if (tokenPattern(token, 'i').test(text)) leaks.push({ token, kind: 'possible' });
  }
  return leaks;
}

/**
 * Refuse to send a prompt that names a model or vendor outright.
 *
 * Only `certain` leaks throw. A `possible` leak is returned for the caller to
 * record, because the alternative — refusing to judge an item about llama
 * shoulder or the mistral — is a blinder deciding what the dataset may contain.
 * The structural test holds the line on the possible class instead, where a
 * human can look at it.
 */
export function assertPromptBlind(
  messages: ReadonlyArray<{ content: string }>,
  lexicon: BlindingLexicon = STATIC_LEXICON,
): IdentityLeak[] {
  const leaks = messages.flatMap((m) => identityLeaks(m.content, lexicon));
  const certain = leaks.filter((l) => l.kind === 'certain');
  if (certain.length > 0) {
    throw new Error(
      `Judge prompt is not blind: it names ${[...new Set(certain.map((l) => l.token))].join(', ')}`,
    );
  }
  return leaks;
}

/* -------------------------------------------------------------------------- */
/* M2.1 — mode routing and prompt construction                                */
/* -------------------------------------------------------------------------- */

/**
 * Which of M2.1's three routes grades this item.
 *
 * Absence is the legacy route, not a default: v1/v2 items declare nothing and
 * must keep being graded exactly as they were scored. A non-judge grader has no
 * mode at all and throws rather than being handed 'fault'.
 */
export function judgeModeOf(question: Question): JudgeMode {
  if (question.grader.type !== 'llm-judge') {
    throw new Error(`Question ${question.id} is not judge-graded`);
  }
  return question.grader.judgeMode ?? 'fault';
}

function assertFaultMode(question: Question): void {
  const mode = judgeModeOf(question);
  if (mode !== 'fault') {
    throw new Error(
      `Question ${question.id} declares judgeMode "${mode}"; the v2 deduction route cannot grade it. ` +
        'Route it through judgeDimensionAnswer or judgePairwiseComparison.',
    );
  }
}

/** judge-v2 attention hints: explicit judgingNotes, else the rubric criteria. */
function attentionHints(question: Question): string | undefined {
  if (question.judgingNotes) return question.judgingNotes;
  if (question.grader.type === 'llm-judge' && question.grader.rubric) {
    return question.grader.rubric.map(criterionAttentionHint).join('\n');
  }
  return undefined;
}

export function buildJudgeMessages(
  question: Question,
  answerText: string,
  lexicon: BlindingLexicon = STATIC_LEXICON,
) {
  assertFaultMode(question);
  const system = [
    'You are a meticulous culinary fact-checker. Compare the CANDIDATE ANSWER against the QUESTION and REFERENCE ANSWER and list every concrete error, omission, or constraint violation. Do not award points — only find faults.',
    'Severity definitions:',
    '- critical: dangerous advice, a violated hard constraint (allergen, dietary rule, equipment, serving count), or an error that would ruin the dish.',
    '- major: a materially wrong quantity/temperature/time/technique claim, or a missing element the question explicitly required.',
    '- minor: imprecision, a small omission, or an unclear instruction that a competent cook would survive.',
    'Do not list style, verbosity, or formatting as faults. The reference shows ONE good answer, not the only one — a different but equally sound approach is not a fault. Do not invent faults to seem rigorous: an answer that is sound and complete has zero findings.',
    'List each DISTINCT underlying mistake exactly once. If one root error shows up in several places (a forbidden ingredient in the list and again in the steps, or one wrong claim repeated), report it as a single finding, not several.',
    'Respond with STRICT JSON only, no markdown:',
    '{"findings":[{"quote":"<≤15 words quoted from the candidate, or \'omission\'>","issue":"<what is wrong>","severity":"critical|major|minor"}],"summary":"<1-2 sentences>"}',
  ].join('\n');
  const hints = attentionHints(question);
  const user = [
    `QUESTION:\n${question.prompt}`,
    `REFERENCE ANSWER (one sound answer, for comparison):\n${question.referenceAnswer}`,
    ...(hints ? [`PAY PARTICULAR ATTENTION TO:\n${hints}`] : []),
    `CANDIDATE ANSWER:\n${anonymizeAnswer(answerText, lexicon)}`,
  ].join('\n\n');
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
  assertPromptBlind(messages, lexicon);
  return messages;
}

/**
 * The atomic criteria this item is judged against.
 *
 * The judge pack is the primary home (M2.4); an item that has not been
 * converted may carry atomic criteria in the rubric instead. Legacy
 * {name, description, weight} lines are NOT accepted here — they bundle several
 * judgements into one number, which is the shape M2.4 exists to replace, and
 * silently accepting them would let a v1 rubric masquerade as a v3 ballot.
 */
function atomicCriteriaOf(question: Question): AtomicCriterion[] {
  const fromPack = question.judgePack?.criteria ?? [];
  if (fromPack.length > 0) return fromPack;
  const rubric = question.grader.type === 'llm-judge' ? (question.grader.rubric ?? []) : [];
  return rubric.filter((entry): entry is AtomicCriterion => isAtomicCriterion(entry));
}

/**
 * Criteria, with the ids a ballot must cite back.
 *
 * Ids are optional in the schema and mandatory here: a ballot that cannot name
 * the criterion it decided cannot be retained per-criterion, adjudicated, or
 * checked for split critical tags, so the item is refused at prompt-build time
 * rather than producing ballots nobody can use.
 */
function citableCriteria(question: Question): Array<AtomicCriterion & { id: string }> {
  const criteria = atomicCriteriaOf(question);
  if (criteria.length === 0) {
    throw new Error(
      `Question ${question.id} declares a v3 judge mode but carries no atomic criteria (judgePack.criteria or an atomic rubric).`,
    );
  }
  const missing = criteria.filter((c) => !c.id);
  if (missing.length > 0) {
    throw new Error(
      `Question ${question.id}: every atomic criterion needs a stable id before it can be judged — ${missing.length} of ${criteria.length} have none.`,
    );
  }
  return criteria as Array<AtomicCriterion & { id: string }>;
}

function renderCriteria(criteria: ReadonlyArray<AtomicCriterion & { id: string }>): string {
  return criteria
    .map((c) => {
      const head = `[${c.id}] (${c.kind}, weight ${c.weight}${c.dimension ? `, dimension: ${c.dimension}` : ''}) ${c.statement}`;
      return c.evidence ? `${head}\n    what counts as evidence: ${c.evidence}` : head;
    })
    .join('\n');
}

function renderAnchors(anchors: ReadonlyArray<BehaviouralAnchorSet>): string {
  return anchors
    .map((set) => {
      const bands = [...set.bands]
        .sort((a, b) => a.band - b.band)
        .map((b) => `  ${b.band} — ${b.descriptor}`)
        .join('\n');
      return `DIMENSION: ${set.dimension}${set.definition ? `\n${set.definition}` : ''}\n${bands}`;
    })
    .join('\n\n');
}

/** Judge-pack context that keeps a different-but-valid route from reading as a fault. */
function renderPackContext(question: Question): string[] {
  const pack = question.judgePack;
  if (!pack) return [];
  const blocks: string[] = [`CAPABILITY UNDER TEST:\n${pack.capabilityUnderTest}`];
  blocks.push(
    `HARD CONSTRAINTS:\n${
      pack.hardConstraints.length > 0
        ? pack.hardConstraints.map((c) => `- ${c}`).join('\n')
        : '- none declared'
    }`,
  );
  blocks.push(
    `ACCEPTABLE SOLUTION FAMILIES (any of these routes can be right):\n${pack.solutionFamilies
      .map((f) => `- ${f.summary} — acceptable because ${f.whyAcceptable}${f.boundaries ? ` (limits: ${f.boundaries})` : ''}`)
      .join('\n')}`,
  );
  blocks.push(
    `KNOWN FAILURE MODES:\n${pack.commonFailureModes
      .map((f) => `- ${f.label}: ${f.description}`)
      .join('\n')}`,
  );
  // Worked examples are deliberately NOT shown. They are the calibration bank's
  // material (M2.7); putting the graded exemplars in the scoring prompt turns
  // the item into few-shot pattern matching and spends the only held-out
  // evidence we have that the judge can tell polished-and-wrong from right.
  return blocks;
}

/**
 * Dimension mode (M2.1 + M2.3). The judge receives the criteria, THEIR WEIGHTS
 * and the behavioural anchors, and returns a band per dimension with evidence.
 *
 * It is told the weights and forbidden to use them: aggregation is code's job,
 * and a judge that totals a weighted score has re-introduced the single opaque
 * number the anchored route exists to replace.
 */
export function buildDimensionJudgeMessages(
  question: Question,
  answerText: string,
  lexicon: BlindingLexicon = STATIC_LEXICON,
) {
  if (judgeModeOf(question) !== 'dimension') {
    throw new Error(`Question ${question.id} does not declare judgeMode "dimension"`);
  }
  const anchors = question.anchors ?? [];
  if (anchors.length === 0) {
    // The schema already refuses this pairing; the check is repeated because a
    // prompt built from an unparsed object would otherwise ask the judge to
    // invent the scale, which is the 800-of-970-perfect failure of v1.
    throw new Error(`Question ${question.id} declares dimension mode but carries no anchors`);
  }
  const criteria = citableCriteria(question);
  const dimensions = anchors.map((a) => a.dimension);

  const system = [
    'You are a meticulous culinary examiner. Score the CANDIDATE ANSWER on each scored dimension using ONLY the behavioural anchors given, and record a decision on every listed criterion.',
    'Anchors are behavioural: choose the band whose description matches what the answer OBSERVABLY does, not how good it feels.',
    'Criterion weights tell you which criteria matter most. Do NOT compute a total, an average or an overall score — report bands and per-criterion decisions only. Aggregation happens outside this conversation.',
    'A criterion decision is "met", "missed" or "unclear". Use "unclear" when the answer does not give you enough to decide; do not guess.',
    'Every band and every criterion decision needs a short evidence string quoting or describing what in the answer put it there. An empty evidence string is not acceptable.',
    'Report your own confidence in this ballot as a number from 0 to 1.',
    'A different but equally sound approach is not a failure. Style, length and formatting are not scored here.',
    'Respond with STRICT JSON only, no markdown:',
    '{"dimensions":[{"dimension":"<exact name>","band":0,"evidence":"<what put it in this band>"}],"criteria":[{"id":"<criterion id>","decision":"met|missed|unclear","evidence":"<why>"}],"confidence":0.0,"summary":"<1-2 sentences>"}',
  ].join('\n');

  const user = [
    `QUESTION:\n${question.prompt}`,
    ...renderPackContext(question),
    `SCORED DIMENSIONS AND THEIR ANCHORS (score every one, using the exact dimension name):\n${renderAnchors(anchors)}`,
    `CRITERIA (decide every one, citing its id):\n${renderCriteria(criteria)}`,
    ...(question.judgingNotes ? [`PAY PARTICULAR ATTENTION TO:\n${question.judgingNotes}`] : []),
    `CANDIDATE ANSWER:\n${anonymizeAnswer(answerText, lexicon)}`,
    `Return exactly ${dimensions.length} dimension entries and ${criteria.length} criterion entries.`,
  ].join('\n\n');

  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
  assertPromptBlind(messages, lexicon);
  return messages;
}

/** Which answer was shown first. One judge sees both orders; see resolveRaterUnit. */
export type PresentationOrder = 'AB' | 'BA';

/**
 * Pairwise mode (M2.1). Two anonymised answers, one ballot.
 *
 * The two answers are labelled only by position. Nothing in the prompt says
 * which candidate is which, and the caller maps position back to candidate
 * identity afterwards — so a judge cannot prefer a provider it cannot see.
 */
export function buildPairwiseJudgeMessages(
  question: Question,
  first: string,
  second: string,
  lexicon: BlindingLexicon = STATIC_LEXICON,
) {
  if (judgeModeOf(question) !== 'pairwise') {
    throw new Error(`Question ${question.id} does not declare judgeMode "pairwise"`);
  }
  const criteria = citableCriteria(question);

  const system = [
    'You are a meticulous culinary examiner comparing two answers to the same question. Decide which is better against the criteria given.',
    'Outcomes:',
    '- "A": answer A is substantively better.',
    '- "B": answer B is substantively better.',
    '- "equal": both are acceptable and neither is substantively better.',
    '- "both_unacceptable": BOTH answers are unsafe, violate a hard constraint, or fail the task. This is NOT a tie — use it whenever both fail, however they compare with each other.',
    '- "abstain": you cannot decide from what you were given. Abstaining is a legitimate answer and is not penalised.',
    'Judge substance: safety, correctness, feasibility and the criteria. Length, polish, formatting and confident tone are not merits.',
    'Name every critical failure you find and say which answer it belongs to.',
    'Every criterion decision needs a short evidence string. Report your own confidence in this ballot as a number from 0 to 1.',
    'Respond with STRICT JSON only, no markdown:',
    '{"outcome":"A|B|equal|both_unacceptable|abstain","criteria":[{"id":"<criterion id>","favours":"A|B|equal|neither","evidence":"<why>"}],"criticalFailures":[{"answer":"A|B|both","criterionId":"<id or omit>","issue":"<what is unsafe or violated>"}],"confidence":0.0,"reasoning":"<1-3 sentences>"}',
  ].join('\n');

  const user = [
    `QUESTION:\n${question.prompt}`,
    ...renderPackContext(question),
    `CRITERIA (decide every one, citing its id):\n${renderCriteria(criteria)}`,
    ...(question.judgingNotes ? [`PAY PARTICULAR ATTENTION TO:\n${question.judgingNotes}`] : []),
    `ANSWER A:\n${anonymizeAnswer(first, lexicon)}`,
    `ANSWER B:\n${anonymizeAnswer(second, lexicon)}`,
  ].join('\n\n');

  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: user },
  ];
  assertPromptBlind(messages, lexicon);
  return messages;
}

/* -------------------------------------------------------------------------- */
/* Ballot parsing                                                             */
/* -------------------------------------------------------------------------- */

function extractJson(question: Question, text: string): Record<string, unknown> {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`Judge returned no JSON for ${question.id}: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]) as Record<string, unknown>;
}

/** 0–1, present, finite. An unparseable confidence is not a confident ballot. */
function requireConfidence(question: Question, raw: unknown): number {
  const value = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Judge gave no usable confidence (0–1) on ${question.id}: ${String(raw)}`);
  }
  return value;
}

function requireEvidence(question: Question, raw: unknown, what: string): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new Error(`Judge gave no evidence for ${what} on ${question.id}`);
  }
  return raw.trim();
}

export function parseJudgeResponse(question: Question, text: string): JudgeVerdict {
  assertFaultMode(question);
  const parsed = extractJson(question, text) as {
    findings?: Array<{ quote?: string; issue?: string; severity?: string; criterionId?: string }>;
    summary?: string;
    confidence?: number;
  };
  if (!Array.isArray(parsed.findings)) {
    throw new Error(`Judge JSON missing findings[] for ${question.id}`);
  }
  const findings: JudgeFinding[] = parsed.findings.map((f) => {
    const severity = f.severity as Severity;
    if (!(severity in SEVERITY_POINTS)) {
      throw new Error(`Judge gave invalid severity "${f.severity}" on ${question.id}`);
    }
    return {
      quote: f.quote ?? '',
      issue: f.issue ?? '',
      severity,
      ...(f.criterionId ? { criterionId: f.criterionId } : {}),
    };
  });
  const deductions = findings.reduce((sum, f) => sum + SEVERITY_POINTS[f.severity], 0);
  return {
    score: Math.max(0, 100 - deductions),
    findings,
    summary: parsed.summary ?? '',
    // Optional on this route only: legacy ballots and the calibration anchors
    // predate the field. Downstream must treat undefined as "unknown".
    ...(typeof parsed.confidence === 'number' ? { confidence: parsed.confidence } : {}),
  };
}

export type CriterionDecision = 'met' | 'missed' | 'unclear';

export interface CriterionRecord {
  criterionId: string;
  decision: CriterionDecision;
  evidence: string;
}

export interface DimensionRecord {
  dimension: string;
  /** 0–4, the anchored scale. */
  band: number;
  evidence: string;
}

export interface DimensionBallot {
  dimensions: DimensionRecord[];
  criteria: CriterionRecord[];
  confidence: number;
  summary: string;
}

/**
 * Parse an anchored ballot, refusing anything incomplete.
 *
 * Every declared dimension and every declared criterion must be decided exactly
 * once. Partial ballots are refused rather than filled in, because a missing
 * dimension silently defaulting to a middle band is indistinguishable in the
 * artifacts from a judge that looked and decided.
 */
export function parseDimensionBallot(question: Question, text: string): DimensionBallot {
  if (judgeModeOf(question) !== 'dimension') {
    throw new Error(`Question ${question.id} does not declare judgeMode "dimension"`);
  }
  const parsed = extractJson(question, text) as {
    dimensions?: Array<{ dimension?: string; band?: unknown; evidence?: unknown }>;
    criteria?: Array<{ id?: string; decision?: string; evidence?: unknown }>;
    confidence?: number;
    summary?: string;
  };
  if (!Array.isArray(parsed.dimensions) || !Array.isArray(parsed.criteria)) {
    throw new Error(`Judge JSON missing dimensions[] or criteria[] for ${question.id}`);
  }

  const expectedDimensions = new Map(
    (question.anchors ?? []).map((a) => [canonicalId(a.dimension), a.dimension]),
  );
  const dimensions: DimensionRecord[] = [];
  const seenDimensions = new Set<string>();
  for (const entry of parsed.dimensions) {
    const key = canonicalId(entry.dimension);
    const canonical = expectedDimensions.get(key);
    if (!canonical) {
      throw new Error(`Judge scored unknown dimension "${String(entry.dimension)}" on ${question.id}`);
    }
    if (seenDimensions.has(key)) {
      throw new Error(`Judge scored dimension "${canonical}" twice on ${question.id}`);
    }
    seenDimensions.add(key);
    const band = entry.band;
    if (typeof band !== 'number' || !Number.isInteger(band) || band < 0 || band > 4) {
      throw new Error(`Judge gave band ${String(band)} outside 0–4 on ${question.id}`);
    }
    dimensions.push({
      dimension: canonical,
      band,
      evidence: requireEvidence(question, entry.evidence, `dimension "${canonical}"`),
    });
  }
  const missingDimensions = [...expectedDimensions.keys()].filter((k) => !seenDimensions.has(k));
  if (missingDimensions.length > 0) {
    throw new Error(
      `Judge left ${missingDimensions.length} dimension(s) unscored on ${question.id}: ${missingDimensions.join(', ')}`,
    );
  }

  const criteria = parseCriterionRecords(question, parsed.criteria);
  return {
    dimensions,
    criteria,
    confidence: requireConfidence(question, parsed.confidence),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
  };
}

function parseCriterionRecords(
  question: Question,
  raw: Array<{ id?: string; decision?: string; evidence?: unknown }>,
): CriterionRecord[] {
  const expected = new Map(citableCriteria(question).map((c) => [c.id, c]));
  const records: CriterionRecord[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    const id = entry.id ?? '';
    if (!expected.has(id)) {
      throw new Error(`Judge decided unknown criterion "${id}" on ${question.id}`);
    }
    if (seen.has(id)) throw new Error(`Judge decided criterion "${id}" twice on ${question.id}`);
    seen.add(id);
    const decision = entry.decision as CriterionDecision;
    if (decision !== 'met' && decision !== 'missed' && decision !== 'unclear') {
      throw new Error(`Judge gave invalid decision "${String(entry.decision)}" on ${question.id}`);
    }
    records.push({
      criterionId: id,
      decision,
      evidence: requireEvidence(question, entry.evidence, `criterion "${id}"`),
    });
  }
  const missing = [...expected.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`Judge left criteria undecided on ${question.id}: ${missing.join(', ')}`);
  }
  return records;
}

/**
 * M2.1's pairwise vocabulary, as it comes off the wire (positional).
 * `both_unacceptable` is stored as itself and must never be folded into 'equal'.
 */
export const PAIRWISE_OUTCOMES = ['A', 'B', 'equal', 'both_unacceptable', 'abstain'] as const;
export type PairwiseOutcome = (typeof PAIRWISE_OUTCOMES)[number];

export interface PairwiseCriterionRecord {
  criterionId: string;
  favours: 'A' | 'B' | 'equal' | 'neither';
  evidence: string;
}

export interface CriticalTag {
  /** Positional while on the ballot; canonicalised to a candidate id later. */
  answer: 'A' | 'B' | 'both';
  criterionId?: string;
  issue: string;
}

export interface PairwiseBallot {
  order: PresentationOrder;
  outcome: PairwiseOutcome;
  criteria: PairwiseCriterionRecord[];
  criticalTags: CriticalTag[];
  confidence: number;
  reasoning: string;
}

export function parsePairwiseBallot(
  question: Question,
  text: string,
  order: PresentationOrder,
): PairwiseBallot {
  if (judgeModeOf(question) !== 'pairwise') {
    throw new Error(`Question ${question.id} does not declare judgeMode "pairwise"`);
  }
  const parsed = extractJson(question, text) as {
    outcome?: string;
    criteria?: Array<{ id?: string; favours?: string; evidence?: unknown }>;
    criticalFailures?: Array<{ answer?: string; criterionId?: string; issue?: unknown }>;
    confidence?: number;
    reasoning?: string;
  };
  const outcome = parsed.outcome as PairwiseOutcome;
  if (!(PAIRWISE_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new Error(`Judge gave invalid pairwise outcome "${String(parsed.outcome)}" on ${question.id}`);
  }
  if (!Array.isArray(parsed.criteria)) {
    throw new Error(`Judge JSON missing criteria[] for ${question.id}`);
  }
  const expected = new Map(citableCriteria(question).map((c) => [c.id, c]));
  const criteria: PairwiseCriterionRecord[] = [];
  const seen = new Set<string>();
  for (const entry of parsed.criteria) {
    const id = entry.id ?? '';
    if (!expected.has(id)) throw new Error(`Judge decided unknown criterion "${id}" on ${question.id}`);
    if (seen.has(id)) throw new Error(`Judge decided criterion "${id}" twice on ${question.id}`);
    seen.add(id);
    const favours = entry.favours as PairwiseCriterionRecord['favours'];
    if (!['A', 'B', 'equal', 'neither'].includes(favours)) {
      throw new Error(`Judge gave invalid criterion direction "${String(entry.favours)}" on ${question.id}`);
    }
    criteria.push({
      criterionId: id,
      favours,
      evidence: requireEvidence(question, entry.evidence, `criterion "${id}"`),
    });
  }
  const missing = [...expected.keys()].filter((id) => !seen.has(id));
  if (missing.length > 0) {
    throw new Error(`Judge left criteria undecided on ${question.id}: ${missing.join(', ')}`);
  }

  const criticalTags: CriticalTag[] = (parsed.criticalFailures ?? []).map((tag) => {
    const answer = tag.answer as CriticalTag['answer'];
    if (answer !== 'A' && answer !== 'B' && answer !== 'both') {
      throw new Error(`Judge tagged a critical failure to "${String(tag.answer)}" on ${question.id}`);
    }
    return {
      answer,
      ...(tag.criterionId ? { criterionId: tag.criterionId } : {}),
      issue: requireEvidence(question, tag.issue, 'a critical failure'),
    };
  });

  // A "both unacceptable" verdict with no critical failure named is an unusable
  // safety claim: nothing downstream could adjudicate or route it.
  if (outcome === 'both_unacceptable' && criticalTags.length === 0) {
    throw new Error(
      `Judge called both answers unacceptable on ${question.id} without naming a single failure`,
    );
  }

  return {
    order,
    outcome,
    criteria,
    criticalTags,
    confidence: requireConfidence(question, parsed.confidence),
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

/* -------------------------------------------------------------------------- */
/* JUDGE-001 / M2.5 — identity, pool admissibility and seating                */
/* -------------------------------------------------------------------------- */

/**
 * JUDGE-001. Where a model's conflict identity comes from.
 *
 * Seating used to compare the OpenRouter slug prefix — `anthropic/claude-x` vs
 * `openai/gpt-x` — which is a routing detail, not an identity. It misses the
 * case the rule exists for: a model served under one vendor's prefix that is
 * another vendor's base model underneath, or two entries of the same family
 * shipped under different prefixes. `hasJudgeConflict` compares the declared
 * provider AND the base-model family, and treats a MISSING identity as a
 * conflict rather than as conflict-free.
 */
export interface JudgeIdentity {
  provider: string;
  baseModelFamily: string;
}
export type IdentityOf = (modelId: string) => JudgeIdentity | undefined;

/**
 * Build a lookup from the roster. Structural on purpose so this module does not
 * need the dataset loader — judge.ts stays free of filesystem imports.
 */
export function identityIndex(
  models: ReadonlyArray<{ id: string; provider: string; family?: string }>,
): IdentityOf {
  const index = new Map<string, JudgeIdentity>();
  for (const m of models) {
    // A model with no declared family has no identity, and no identity means
    // conflict everywhere. Recorded as undefined rather than defaulted to the
    // slug, which would manufacture a distinctness that was never declared.
    if (m.family) index.set(m.id, { provider: m.provider, baseModelFamily: m.family });
  }
  return (modelId) => index.get(modelId);
}

/** Deterministic 32-bit FNV-1a hash — seat assignment must be reproducible. */
function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Pick two panel seats for a (candidate, question) pair — the judge-v2 route.
 *
 * Retained unchanged because 2026-07-v2.1 was scored with it. v3 comparisons do
 * NOT come through here: M2.5 requires three conflict-free seats and forbids
 * dropping to two, which is exactly what this function does on its last line.
 * Use `buildJuryDesign` / `juryFor` for anything claiming v3.
 */
export function panelSeats(
  panel: string[],
  candidateModelId: string,
  questionId: string,
  identify: IdentityOf,
): string[] {
  const candidate = identify(candidateModelId);
  const eligible = panel.filter((seat) => !hasJudgeConflict(identify(seat) ?? {}, candidate ?? {}));
  if (eligible.length <= 2) return eligible;
  const drop = fnv1a(`${candidateModelId}|${questionId}`) % eligible.length;
  return eligible.filter((_, i) => i !== drop);
}

/** Why a seat was excluded, for the diagnostic when too few remain. */
function conflictReason(seatId: string, candidateId: string, identify: IdentityOf): string {
  const seat = identify(seatId);
  const candidate = identify(candidateId);
  if (!seat) return `${seatId}: no declared identity in the roster`;
  if (!candidate) return `${candidateId}: no declared identity in the roster`;
  if (canonicalId(seat.provider) === canonicalId(candidate.provider)) {
    return `${seatId}: same provider (${seat.provider})`;
  }
  if (canonicalId(seat.baseModelFamily) === canonicalId(candidate.baseModelFamily)) {
    return `${seatId}: same base-model family (${seat.baseModelFamily})`;
  }
  return `${seatId}: eligible`;
}

/** M2.5: three conflict-free seats per comparison, and never fewer. */
export const SEATS_PER_COMPARISON = 3;
/** M2.5: "at least five genuinely distinct provider/base-model families". */
export const MIN_POOL_FAMILIES = 5;

/**
 * Group models into judge families under the relation "shares a provider or a
 * base-model family", transitively.
 *
 * Transitive because the relation is not an equivalence on its face: A and B
 * may share a provider while B and C share a base model, and seating A and C
 * together would put one lab's two rebadges on the same jury. The group label
 * is the smallest `provider/family` string in the group, so it is stable under
 * roster reordering and readable in an artifact.
 */
export function judgeFamilyGroups(
  members: readonly string[],
  identify: IdentityOf,
): Map<string, string> {
  const unidentified = members.filter((m) => !identify(m));
  if (unidentified.length > 0) {
    // Fail closed: hasJudgeConflict treats an unknown identity as conflicting
    // with everything, so an unidentified member would silently collapse the
    // whole pool into one group and read as "no distinct families".
    throw new Error(
      `Cannot group judge families: no declared identity for ${unidentified.join(', ')}`,
    );
  }
  const parent = new Map<string, string>(members.map((m) => [m, m]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (const a of members) {
    for (const b of members) {
      if (a === b) continue;
      if (hasJudgeConflict(identify(a)!, identify(b)!)) {
        const [ra, rb] = [find(a), find(b)];
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const labels = new Map<string, string>();
  for (const m of members) {
    const root = find(m);
    const id = identify(m)!;
    const label = `${canonicalId(id.provider)}/${canonicalId(id.baseModelFamily)}`;
    const current = labels.get(root);
    if (current === undefined || label < current) labels.set(root, label);
  }
  return new Map(members.map((m) => [m, labels.get(find(m))!]));
}

export interface JuryPool {
  /** Versioned, per M2.5: a pool is part of the protocol, not an ambient list. */
  version: string;
  seats: string[];
}

/**
 * Refuse a pool that cannot support the protocol.
 *
 * Checked before any assignment because the failure it catches — a pool of
 * three families where a two-family conflict leaves one seat — is invisible
 * until the comparison that needs it, by which point the tempting fix is to
 * relax the conflict rule.
 */
export function assertPoolAdmissible(pool: JuryPool, identify: IdentityOf): Map<string, string> {
  if (pool.seats.length === 0) throw new Error(`Jury pool ${pool.version} is empty`);
  const duplicates = pool.seats.filter((s, i) => pool.seats.indexOf(s) !== i);
  if (duplicates.length > 0) {
    // A repeated seat would be counted as two independent raters by every
    // aggregation below it.
    throw new Error(`Jury pool ${pool.version} lists ${duplicates.join(', ')} more than once`);
  }
  const groups = judgeFamilyGroups(pool.seats, identify);
  const distinct = new Set(groups.values());
  if (distinct.size < MIN_POOL_FAMILIES) {
    throw new Error(
      `Jury pool ${pool.version} spans ${distinct.size} distinct provider/base-model families; M2.5 requires at least ${MIN_POOL_FAMILIES}. Families: ${[...distinct].sort().join(', ')}`,
    );
  }
  return groups;
}

export interface JuryRefusal {
  ok: false;
  /** M2.5: "expand the external pool or route the comparison to humans". */
  routeTo: 'human';
  reason: string;
  diagnostics: string[];
}

export interface JurySeating {
  ok: true;
  seats: string[];
  /** One family per seat, in seat order. */
  families: string[];
}

export type JurySelection = JurySeating | JuryRefusal;

/** Seats that conflict with NO candidate in the comparison. */
export function conflictFreeSeats(
  pool: readonly string[],
  candidates: readonly string[],
  identify: IdentityOf,
): string[] {
  return pool.filter((seat) =>
    candidates.every((c) => !hasJudgeConflict(identify(seat) ?? {}, identify(c) ?? {})),
  );
}

export interface Comparison {
  /** Stable key: item id for a single-candidate ballot, item+pair for a duel. */
  key: string;
  /** One candidate (dimension/fault) or two (pairwise). */
  candidates: string[];
  /** M2.5 balances across task strata as well as candidate pairs. */
  stratum?: string;
}

export interface JuryAssignment extends Comparison {
  stratum: string;
  selection: JurySelection;
}

export interface JuryBalance {
  /**
   * Per block — one candidate-family signature × stratum — how many times each
   * eligible judge family sat. `spread` is max − min over eligible families.
   */
  blocks: Array<{
    block: string;
    comparisons: number;
    eligibleFamilies: string[];
    seatCounts: Record<string, number>;
    spread: number;
  }>;
  /** True when no block's spread exceeds one seat: the BIBD balance condition. */
  balanced: boolean;
  /** Comparisons that could not be seated and must go to a human. */
  routedToHuman: string[];
}

export interface JuryDesign {
  poolVersion: string;
  seed: string;
  seatsPerComparison: number;
  assignments: Map<string, JuryAssignment>;
  balance: JuryBalance;
}

/**
 * Preregistered balanced incomplete-block assignment (M2.5).
 *
 * The whole design is computed up front, from the pool, the comparison list and
 * a seed, and is a pure function of them — so it can be published before any
 * judging happens and recomputed byte-identically afterwards, which is what
 * "preregistered" has to mean for a machine.
 *
 * Balance, concretely: comparisons are grouped into BLOCKS by (candidate family
 * signature × stratum), because eligibility is constant inside a block. Within
 * a block, each comparison takes the three eligible families that have sat
 * least often so far, so every eligible judge family sits within one seat of
 * every other. That is the property M2.5 asks for — no candidate can draw a
 * systematically softer panel, because no candidate family gets more of any
 * judge family than any other comparison in its block.
 *
 * Two details that look fussy and are not:
 *
 *  - comparisons are processed in a HASH order, not in key order. Item ids are
 *    category-prefixed (`nutr-036`, `safe-014`), so key order would hand the
 *    first triple to every nutrition item and the next to every safety item —
 *    a panel correlated with content, which is exactly the systematic-leniency
 *    failure being prevented.
 *  - ties in "least used" are broken by hash, not alphabetically. An
 *    alphabetical tie-break gives the first-named family a standing advantage
 *    in every odd-sized block.
 */
export function buildJuryDesign(input: {
  pool: JuryPool;
  comparisons: readonly Comparison[];
  identify: IdentityOf;
  seed?: string;
}): JuryDesign {
  const { pool, comparisons, identify } = input;
  const seed = input.seed ?? pool.version;
  const poolGroups = assertPoolAdmissible(pool, identify);

  const keys = comparisons.map((c) => c.key);
  const duplicateKey = keys.find((k, i) => keys.indexOf(k) !== i);
  if (duplicateKey !== undefined) {
    // Two comparisons under one key would overwrite each other in the lookup
    // and silently share a jury.
    throw new Error(`Comparison key "${duplicateKey}" appears more than once`);
  }

  const blockOf = (c: Comparison): string => {
    const families = c.candidates
      .map((id) => {
        const identity = identify(id);
        // An unidentified candidate cannot be seated at all (every seat
        // conflicts with it), but it still needs a stable block label.
        return identity
          ? `${canonicalId(identity.provider)}/${canonicalId(identity.baseModelFamily)}`
          : `unidentified:${id}`;
      })
      .sort();
    return `${c.stratum ?? 'all'}|${families.join('+')}`;
  };

  const grouped = new Map<string, Comparison[]>();
  for (const c of comparisons) {
    const block = blockOf(c);
    grouped.set(block, [...(grouped.get(block) ?? []), c]);
  }

  const assignments = new Map<string, JuryAssignment>();
  const blocks: JuryBalance['blocks'] = [];
  const routedToHuman: string[] = [];

  for (const [block, members] of [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const eligibleSeats = conflictFreeSeats(pool.seats, members[0]!.candidates, identify);
    const seatsByFamily = new Map<string, string[]>();
    for (const seat of eligibleSeats) {
      const family = poolGroups.get(seat)!;
      seatsByFamily.set(family, [...(seatsByFamily.get(family) ?? []), seat]);
    }
    const eligibleFamilies = [...seatsByFamily.keys()].sort();
    const counts: Record<string, number> = Object.fromEntries(
      eligibleFamilies.map((f) => [f, 0]),
    );

    if (eligibleFamilies.length < SEATS_PER_COMPARISON) {
      // M2.5, the line that matters: do NOT drop to two. Distinct FAMILIES, not
      // distinct seats — two seats from one lab are one rater family, and
      // seating them would break leave-one-family-out as well as independence.
      for (const c of members) {
        // Name every seat against every candidate. "No jury available" sends
        // the reader to the pool; the cause is usually one candidate's identity
        // colliding with three quarters of it, and that is only visible per pair.
        const diagnostics = pool.seats.flatMap((seat) =>
          c.candidates.map((candidate) => conflictReason(seat, candidate, identify)),
        );
        assignments.set(c.key, {
          ...c,
          stratum: c.stratum ?? 'all',
          selection: {
            ok: false,
            routeTo: 'human',
            reason: `only ${eligibleFamilies.length} conflict-free judge famil${eligibleFamilies.length === 1 ? 'y' : 'ies'} for ${c.candidates.join(' vs ')}; ${SEATS_PER_COMPARISON} are required and the panel may not be reduced`,
            diagnostics,
          },
        });
        routedToHuman.push(c.key);
      }
      blocks.push({
        block,
        comparisons: members.length,
        eligibleFamilies,
        seatCounts: counts,
        spread: 0,
      });
      continue;
    }

    const ordered = [...members].sort((a, b) => {
      const ha = fnv1a(`${seed}|order|${a.key}`);
      const hb = fnv1a(`${seed}|order|${b.key}`);
      return ha === hb ? (a.key < b.key ? -1 : 1) : ha - hb;
    });

    for (const c of ordered) {
      const chosenFamilies = [...eligibleFamilies]
        .sort((fa, fb) => {
          const ca = counts[fa]!;
          const cb = counts[fb]!;
          if (ca !== cb) return ca - cb;
          return fnv1a(`${seed}|tie|${c.key}|${fa}`) - fnv1a(`${seed}|tie|${c.key}|${fb}`);
        })
        .slice(0, SEATS_PER_COMPARISON);

      const seats = chosenFamilies.map((family) => {
        const options = seatsByFamily.get(family)!;
        // Rotate within a family too, so a family with two seats does not park
        // all of its load on whichever one sorts first.
        return options[fnv1a(`${seed}|seat|${c.key}|${family}`) % options.length]!;
      });
      for (const family of chosenFamilies) counts[family] = counts[family]! + 1;

      assignments.set(c.key, {
        ...c,
        stratum: c.stratum ?? 'all',
        selection: { ok: true, seats, families: chosenFamilies },
      });
    }

    const used = eligibleFamilies.map((f) => counts[f]!);
    blocks.push({
      block,
      comparisons: members.length,
      eligibleFamilies,
      seatCounts: counts,
      spread: Math.max(...used) - Math.min(...used),
    });
  }

  return {
    poolVersion: pool.version,
    seed,
    seatsPerComparison: SEATS_PER_COMPARISON,
    assignments,
    balance: {
      blocks,
      balanced: blocks.every((b) => b.spread <= 1),
      routedToHuman,
    },
  };
}

/**
 * The jury for one comparison. A key the design does not carry is a refusal,
 * not an improvised panel — an ad-hoc seat pick would be unbalanced by
 * construction and would not appear in the preregistered design.
 */
export function juryFor(design: JuryDesign, key: string): JurySelection {
  const assignment = design.assignments.get(key);
  if (!assignment) {
    return {
      ok: false,
      routeTo: 'human',
      reason: `comparison "${key}" is not in jury design ${design.poolVersion}; seats cannot be improvised outside the preregistered design`,
      diagnostics: [],
    };
  }
  return assignment.selection;
}

/* -------------------------------------------------------------------------- */
/* M2.5 — rater units, order design and aggregation                           */
/* -------------------------------------------------------------------------- */

export const ESCALATION_REASONS = [
  'order-flip',
  'presentation-inconsistent',
  'split-critical-tag',
  'criterion-gap',
  'no-majority',
  'high-entropy',
  'low-confidence',
  'abstention',
] as const;
export type EscalationReason = (typeof ESCALATION_REASONS)[number];

export interface Escalation {
  reason: EscalationReason;
  detail: string;
}

/**
 * Provisional policy parameters, not measured constants.
 *
 * M2.8 fixes the release thresholds against the sealed holdout; until then
 * these are declared here so that a run records the numbers it used rather than
 * burying them in a conditional. Overridable per call for the same reason.
 */
export const ESCALATION_DEFAULTS = {
  /** Shannon bits over rater-unit outcomes. */
  maxVoteEntropy: 1.0,
  /** Below this, the panel is not trusted to have decided anything. */
  minConfidence: 0.6,
  /** Band difference on one anchored dimension that counts as a large gap. */
  maxBandGap: 2,
} as const;

export type EscalationThresholds = typeof ESCALATION_DEFAULTS;

/**
 * Shannon entropy in bits over a set of outcomes.
 *
 * Throws on an empty set. Zero would be the arithmetic answer and the wrong
 * one: no ballots is not unanimity, and a panel-agreement figure of "perfect"
 * derived from nothing is the sort of number that ends up on a leaderboard.
 */
export function voteEntropy(outcomes: readonly string[]): number {
  if (outcomes.length === 0) {
    throw new Error('voteEntropy of an empty ballot set is undefined, not zero disagreement');
  }
  const counts = new Map<string, number>();
  for (const o of outcomes) counts.set(o, (counts.get(o) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) {
    const p = n / outcomes.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/** Unanimity-free majority: the strict winner, or null when nothing has one. */
function strictMajority<T extends string>(votes: readonly T[]): T | null {
  if (votes.length === 0) return null;
  const counts = new Map<T, number>();
  for (const v of votes) counts.set(v, (counts.get(v) ?? 0) + 1);
  for (const [value, n] of counts) if (n * 2 > votes.length) return value;
  return null;
}

/** A rater unit's outcome, in CANDIDATE terms, never positional. */
export type UnitOutcome =
  | { kind: 'candidate'; modelId: string }
  | { kind: 'equal' }
  | { kind: 'both_unacceptable' }
  | { kind: 'abstain' }
  | { kind: 'unstable' };

export function unitOutcomeKey(outcome: UnitOutcome): string {
  return outcome.kind === 'candidate' ? `candidate:${outcome.modelId}` : outcome.kind;
}

export interface RaterUnit {
  judgeModel: string;
  judgeFamily: string;
  /**
   * The pair this unit judged, in canonical order. Carried on the unit because
   * every outcome below it is stated in candidate terms; an aggregate that had
   * to be told separately which model was "A" is one mislabelled argument away
   * from crediting the wrong model.
   */
  candidateA: string;
  candidateB: string;
  /** Exactly two: one A–B presentation and one B–A. */
  presentations: PairwiseBallot[];
  outcome: UnitOutcome;
  /** True when the two presentations named opposite winners. */
  orderFlip: boolean;
  instability?: 'order-flip' | 'presentation-inconsistent';
  /** Candidate ids this unit tagged with a critical failure, in either order. */
  criticalTags: string[];
  /** True when the two presentations disagreed about a critical failure. */
  criticalUnstable: boolean;
  /** The lower of the two presentations' confidences. */
  confidence: number;
}

/** Map a positional ballot outcome onto candidate identity. */
function canonicaliseOutcome(
  ballot: PairwiseBallot,
  candidateA: string,
  candidateB: string,
): UnitOutcome {
  const first = ballot.order === 'AB' ? candidateA : candidateB;
  const second = ballot.order === 'AB' ? candidateB : candidateA;
  switch (ballot.outcome) {
    case 'A':
      return { kind: 'candidate', modelId: first };
    case 'B':
      return { kind: 'candidate', modelId: second };
    case 'equal':
      return { kind: 'equal' };
    case 'both_unacceptable':
      return { kind: 'both_unacceptable' };
    case 'abstain':
      return { kind: 'abstain' };
  }
}

function canonicaliseCriticalTags(
  ballot: PairwiseBallot,
  candidateA: string,
  candidateB: string,
): string[] {
  const first = ballot.order === 'AB' ? candidateA : candidateB;
  const second = ballot.order === 'AB' ? candidateB : candidateA;
  const tagged = new Set<string>();
  for (const tag of ballot.criticalTags) {
    if (tag.answer === 'A' || tag.answer === 'both') tagged.add(first);
    if (tag.answer === 'B' || tag.answer === 'both') tagged.add(second);
  }
  return [...tagged].sort();
}

/**
 * Collapse one judge's two presentations into ONE rater unit (M2.5).
 *
 * This is the function that stops A–B and B–A being counted as two votes. Both
 * presentations come from the same model with the same prompt version; treating
 * them as independent would halve the apparent variance of the panel and let a
 * position effect masquerade as agreement.
 *
 * Resolution, and every branch of it is deliberately conservative:
 *  - identical outcomes → that outcome;
 *  - opposite winners → ORDER FLIP: no preference is recorded at all, and the
 *    comparison escalates. This is instability, not a tie;
 *  - a winner in one order and 'equal' in the other → no reliable preference:
 *    recorded as equal and escalated, since it is the first-position effect
 *    M2.8 measures showing up in a single unit;
 *  - 'both_unacceptable' in only one order → escalated as unstable. An absolute
 *    safety-flavoured claim is never averaged away against a preference;
 *  - any abstention → the unit abstains. One presentation is not order-verified,
 *    and M2.7 treats abstention as missing rather than as evidence.
 */
export function resolveRaterUnit(input: {
  judgeModel: string;
  judgeFamily: string;
  candidateA: string;
  candidateB: string;
  ballots: readonly PairwiseBallot[];
}): RaterUnit {
  const { judgeModel, judgeFamily, candidateA, candidateB, ballots } = input;
  if (ballots.length !== 2) {
    throw new Error(
      `Rater unit for ${judgeModel} needs exactly two presentations, got ${ballots.length}`,
    );
  }
  const ab = ballots.find((b) => b.order === 'AB');
  const ba = ballots.find((b) => b.order === 'BA');
  if (!ab || !ba) {
    // Two ballots in the same order are one presentation done twice: it cannot
    // detect a position effect, which is the only reason both orders are run.
    throw new Error(`Rater unit for ${judgeModel} needs one AB and one BA presentation`);
  }

  const o1 = canonicaliseOutcome(ab, candidateA, candidateB);
  const o2 = canonicaliseOutcome(ba, candidateA, candidateB);
  const k1 = unitOutcomeKey(o1);
  const k2 = unitOutcomeKey(o2);

  const tags1 = canonicaliseCriticalTags(ab, candidateA, candidateB);
  const tags2 = canonicaliseCriticalTags(ba, candidateA, candidateB);
  const criticalTags = [...new Set([...tags1, ...tags2])].sort();
  const criticalUnstable = tags1.join('|') !== tags2.join('|');

  let outcome: UnitOutcome;
  let orderFlip = false;
  let instability: RaterUnit['instability'];

  if (k1 === k2) {
    outcome = o1;
  } else if (o1.kind === 'abstain' || o2.kind === 'abstain') {
    outcome = { kind: 'abstain' };
    instability = 'presentation-inconsistent';
  } else if (o1.kind === 'candidate' && o2.kind === 'candidate') {
    outcome = { kind: 'unstable' };
    orderFlip = true;
    instability = 'order-flip';
  } else if (o1.kind === 'both_unacceptable' || o2.kind === 'both_unacceptable') {
    outcome = { kind: 'unstable' };
    instability = 'presentation-inconsistent';
  } else {
    // winner vs equal
    outcome = { kind: 'equal' };
    instability = 'presentation-inconsistent';
  }

  return {
    judgeModel,
    judgeFamily,
    candidateA,
    candidateB,
    presentations: [ab, ba],
    outcome,
    orderFlip,
    ...(instability ? { instability } : {}),
    criticalTags,
    criticalUnstable,
    confidence: Math.min(ab.confidence, ba.confidence),
  };
}

export interface LeaveOneOutResult {
  family: string;
  outcome: string;
  /** Winner's share of decided units, in percentage points, without this family. */
  winnerSharePct: number;
  /** Change in that share against the full panel. */
  shareDeltaPct: number;
  reversal: boolean;
}

export interface PairwiseAggregate {
  /**
   * M2.5's transparent primary: unweighted majority over rater units. No
   * severity weighting, no confidence weighting, no judge weighting.
   */
  primary: {
    method: 'unweighted-majority';
    outcome: string;
    votes: Record<string, number>;
    decidedUnits: number;
    winnerSharePct: number;
  };
  units: RaterUnit[];
  entropy: number;
  /** Units that abstained or were order-unstable, excluded from the tally. */
  abstained: number;
  unstable: number;
  minConfidence: number;
  escalate: boolean;
  escalations: Escalation[];
  leaveOneFamilyOut: LeaveOneOutResult[];
  thresholds: EscalationThresholds;
}

function tallyUnits(units: readonly RaterUnit[]): {
  votes: Record<string, number>;
  decided: string[];
} {
  const votes: Record<string, number> = {};
  const decided: string[] = [];
  for (const u of units) {
    const key = unitOutcomeKey(u.outcome);
    votes[key] = (votes[key] ?? 0) + 1;
    // Abstentions are missing data and instability is not a vote; neither is
    // allowed into the denominator, where they would dilute a real majority
    // into a plurality.
    if (u.outcome.kind !== 'abstain' && u.outcome.kind !== 'unstable') decided.push(key);
  }
  return { votes, decided };
}

function majorityOf(units: readonly RaterUnit[]): {
  outcome: string;
  votes: Record<string, number>;
  decided: string[];
  winnerSharePct: number;
} {
  const { votes, decided } = tallyUnits(units);
  const winner = strictMajority(decided);
  const share =
    winner === null || decided.length === 0
      ? 0
      : (decided.filter((d) => d === winner).length / decided.length) * 100;
  return {
    outcome: winner ?? 'no-majority',
    votes,
    decided,
    winnerSharePct: Math.round(share * 10) / 10,
  };
}

/**
 * Aggregate a pairwise comparison.
 *
 * Everything is retained — per-criterion decisions and evidence live on the
 * ballots inside each unit, individual verdicts on the units, confidence and
 * vote entropy at the top. The mean is not computed anywhere, because there is
 * no mean of an ordinal preference and reporting one was how v2 turned a 0.05
 * point difference into an ordering.
 */
export function aggregatePairwise(
  units: readonly RaterUnit[],
  options: { thresholds?: Partial<EscalationThresholds> } = {},
): PairwiseAggregate {
  if (units.length === 0) throw new Error('Cannot aggregate a comparison with no rater units');
  const pairs = new Set(units.map((u) => `${u.candidateA}|${u.candidateB}`));
  if (pairs.size > 1) {
    // Units from two different duels tallied together would produce a majority
    // over a comparison nobody ran.
    throw new Error(`Rater units disagree about which pair they judged: ${[...pairs].join(' / ')}`);
  }
  const judges = units.map((u) => u.judgeModel);
  if (new Set(judges).size !== judges.length) {
    // One judge appearing twice is the two-votes-per-judge error the rater-unit
    // design exists to prevent, arriving through the back door.
    throw new Error(`A judge appears in more than one rater unit: ${judges.join(', ')}`);
  }
  const thresholds = { ...ESCALATION_DEFAULTS, ...options.thresholds };

  const full = majorityOf(units);
  const entropy = voteEntropy(units.map((u) => unitOutcomeKey(u.outcome)));
  const abstained = units.filter((u) => u.outcome.kind === 'abstain').length;
  const unstable = units.filter((u) => u.outcome.kind === 'unstable').length;
  const minConfidence = Math.min(...units.map((u) => u.confidence));

  const escalations: Escalation[] = [];
  for (const unit of units) {
    if (unit.orderFlip) {
      escalations.push({
        reason: 'order-flip',
        detail: `${unit.judgeModel} named opposite winners in the two presentations`,
      });
    } else if (unit.instability === 'presentation-inconsistent') {
      escalations.push({
        reason: 'presentation-inconsistent',
        detail: `${unit.judgeModel} gave inconsistent verdicts across presentation orders`,
      });
    }
    if (unit.criticalUnstable) {
      escalations.push({
        reason: 'split-critical-tag',
        detail: `${unit.judgeModel} tagged a critical failure in one presentation order only`,
      });
    }
  }

  // Split critical tags ACROSS units: some seats say an answer is dangerous and
  // others do not. M2.6 makes any safety disagreement a human matter.
  const taggedCandidates = new Set(units.flatMap((u) => u.criticalTags));
  for (const candidate of [...taggedCandidates].sort()) {
    const tagging = units.filter((u) => u.criticalTags.includes(candidate)).length;
    if (tagging > 0 && tagging < units.length) {
      escalations.push({
        reason: 'split-critical-tag',
        detail: `${tagging} of ${units.length} rater units tagged a critical failure against ${candidate}`,
      });
    }
  }

  // Criterion gaps: units pointing in opposite directions on the same criterion.
  // Directions are canonicalised to candidate identity first — comparing raw
  // "A"s across an A–B and a B–A presentation compares two different answers.
  const directions = new Map<string, Set<string>>();
  for (const unit of units) {
    for (const ballot of unit.presentations) {
      const first = ballot.order === 'AB' ? unit.candidateA : unit.candidateB;
      const second = ballot.order === 'AB' ? unit.candidateB : unit.candidateA;
      for (const record of ballot.criteria) {
        if (record.favours !== 'A' && record.favours !== 'B') continue;
        const favoured = record.favours === 'A' ? first : second;
        directions.set(
          record.criterionId,
          (directions.get(record.criterionId) ?? new Set()).add(favoured),
        );
      }
    }
  }
  for (const [criterionId, seen] of [...directions.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (seen.size > 1) {
      escalations.push({
        reason: 'criterion-gap',
        detail: `criterion ${criterionId} was decided in opposite directions across the panel`,
      });
    }
  }

  if (full.outcome === 'no-majority') {
    escalations.push({
      reason: 'no-majority',
      detail: `${full.decided.length} decided unit(s) produced no strict majority`,
    });
  }
  if (entropy > thresholds.maxVoteEntropy) {
    escalations.push({
      reason: 'high-entropy',
      detail: `vote entropy ${entropy.toFixed(2)} bits exceeds ${thresholds.maxVoteEntropy}`,
    });
  }
  if (minConfidence < thresholds.minConfidence) {
    escalations.push({
      reason: 'low-confidence',
      detail: `lowest rater-unit confidence ${minConfidence} is below ${thresholds.minConfidence}`,
    });
  }
  if (abstained > 0) {
    escalations.push({
      reason: 'abstention',
      detail: `${abstained} of ${units.length} rater units abstained`,
    });
  }

  return {
    primary: {
      method: 'unweighted-majority',
      outcome: full.outcome,
      votes: full.votes,
      decidedUnits: full.decided.length,
      winnerSharePct: full.winnerSharePct,
    },
    units: [...units],
    entropy,
    abstained,
    unstable,
    minConfidence,
    escalate: escalations.length > 0,
    escalations,
    leaveOneFamilyOut: leaveOneFamilyOutPairwise(units),
    thresholds,
  };
}

/**
 * M2.5's published sensitivity: drop each judge family in turn and recompute.
 *
 * Reported per family rather than as a single worst case, because M2.8's
 * release criterion is about a specific family's removal — "removing one judge
 * family changes the overall preference estimate by less than five points and
 * produces no confirmed winner reversal".
 */
export function leaveOneFamilyOutPairwise(units: readonly RaterUnit[]): LeaveOneOutResult[] {
  const full = majorityOf(units);
  const families = [...new Set(units.map((u) => u.judgeFamily))].sort();
  return families.map((family) => {
    const remaining = units.filter((u) => u.judgeFamily !== family);
    const without = remaining.length > 0 ? majorityOf(remaining) : null;
    const outcome = without?.outcome ?? 'no-units';
    return {
      family,
      outcome,
      winnerSharePct: without?.winnerSharePct ?? 0,
      shareDeltaPct: Math.round(((without?.winnerSharePct ?? 0) - full.winnerSharePct) * 10) / 10,
      // A reversal is a DIFFERENT winner, not the loss of a majority: losing the
      // majority is a power question, naming the other model is a validity one.
      reversal:
        outcome !== full.outcome && outcome !== 'no-majority' && full.outcome !== 'no-majority',
    };
  });
}

export interface DimensionAggregate {
  primary: {
    method: 'unweighted-majority';
    dimensions: Array<{
      dimension: string;
      bands: number[];
      /** Strict majority band, or null when the seats do not agree on one. */
      majorityBand: number | null;
      gap: number;
      entropy: number;
    }>;
    criteria: Array<{
      criterionId: string;
      kind: AtomicCriterion['kind'];
      decisions: CriterionDecision[];
      majority: CriterionDecision | null;
      split: boolean;
      evidence: string[];
    }>;
  };
  ballots: Array<{ judgeModel: string; judgeFamily: string; ballot: DimensionBallot }>;
  minConfidence: number;
  escalate: boolean;
  escalations: Escalation[];
  leaveOneFamilyOut: Array<{ family: string; dimensions: Array<{ dimension: string; majorityBand: number | null }> }>;
  thresholds: EscalationThresholds;
}

/**
 * Aggregate anchored ballots by unweighted majority, per dimension and per
 * criterion.
 *
 * Criterion WEIGHTS are deliberately not applied here. They are shown to the
 * judge as attention, and any weighted number is a severity correction in
 * disguise — M2.5 allows one only as a sensitivity analysis learned on
 * development evidence. `applySeverityCorrection` is the only door to it and it
 * refuses to be the primary.
 */
export function aggregateDimension(
  question: Question,
  entries: ReadonlyArray<{ judgeModel: string; judgeFamily: string; ballot: DimensionBallot }>,
  options: { thresholds?: Partial<EscalationThresholds> } = {},
): DimensionAggregate {
  if (entries.length === 0) throw new Error('Cannot aggregate a dimension ballot set with no seats');
  const thresholds = { ...ESCALATION_DEFAULTS, ...options.thresholds };
  const criteriaById = new Map(citableCriteria(question).map((c) => [c.id, c]));
  const escalations: Escalation[] = [];

  // Lookups refuse rather than assert. parseDimensionBallot guarantees complete
  // ballots, but this function is also reachable with hand-built entries (an
  // adjudicator's re-score, a replayed artifact), and a missing band silently
  // becoming `undefined` would propagate into NaN bands and a majority of one.
  const bandOf = (
    entry: { judgeModel: string; ballot: DimensionBallot },
    dimension: string,
  ): number => {
    const record = entry.ballot.dimensions.find(
      (d) => canonicalId(d.dimension) === canonicalId(dimension),
    );
    if (!record) {
      throw new Error(
        `${entry.judgeModel} left dimension "${dimension}" unscored on ${question.id}`,
      );
    }
    return record.band;
  };
  const criterionOf = (
    entry: { judgeModel: string; ballot: DimensionBallot },
    criterionId: string,
  ): CriterionRecord => {
    const record = entry.ballot.criteria.find((c) => c.criterionId === criterionId);
    if (!record) {
      throw new Error(
        `${entry.judgeModel} left criterion "${criterionId}" undecided on ${question.id}`,
      );
    }
    return record;
  };

  const dimensionNames = (question.anchors ?? []).map((a) => a.dimension);
  const dimensions = dimensionNames.map((dimension) => {
    const bands = entries.map((e) => bandOf(e, dimension));
    const majorityBand = strictMajority(bands.map(String));
    const gap = Math.max(...bands) - Math.min(...bands);
    if (gap >= thresholds.maxBandGap) {
      escalations.push({
        reason: 'criterion-gap',
        detail: `dimension "${dimension}" spans ${gap} bands (${bands.join(', ')})`,
      });
    }
    return {
      dimension,
      bands,
      majorityBand: majorityBand === null ? null : Number(majorityBand),
      gap,
      entropy: voteEntropy(bands.map(String)),
    };
  });

  const criteria = [...criteriaById.values()].map((criterion) => {
    const decisions = entries.map((e) => criterionOf(e, criterion.id).decision);
    const evidence = entries.map((e) => criterionOf(e, criterion.id).evidence);
    const majority = strictMajority(decisions);
    const split = new Set(decisions).size > 1;
    if (split && criterion.kind === 'critical') {
      // A split on a critical criterion is a safety disagreement, and M2.6
      // makes that a human matter unconditionally — majority or not.
      escalations.push({
        reason: 'split-critical-tag',
        detail: `critical criterion ${criterion.id} split the panel: ${decisions.join(', ')}`,
      });
    }
    return {
      criterionId: criterion.id,
      kind: criterion.kind,
      decisions,
      majority,
      split,
      evidence,
    };
  });

  for (const d of dimensions) {
    if (d.majorityBand === null) {
      escalations.push({
        reason: 'no-majority',
        detail: `dimension "${d.dimension}" has no majority band (${d.bands.join(', ')})`,
      });
    }
    if (d.entropy > thresholds.maxVoteEntropy) {
      escalations.push({
        reason: 'high-entropy',
        detail: `dimension "${d.dimension}" band entropy ${d.entropy.toFixed(2)} bits exceeds ${thresholds.maxVoteEntropy}`,
      });
    }
  }

  const minConfidence = Math.min(...entries.map((e) => e.ballot.confidence));
  if (minConfidence < thresholds.minConfidence) {
    escalations.push({
      reason: 'low-confidence',
      detail: `lowest ballot confidence ${minConfidence} is below ${thresholds.minConfidence}`,
    });
  }

  const families = [...new Set(entries.map((e) => e.judgeFamily))].sort();
  const leaveOneFamilyOut = families.map((family) => {
    const remaining = entries.filter((e) => e.judgeFamily !== family);
    return {
      family,
      dimensions: dimensionNames.map((dimension) => {
        const bands = remaining.map((e) => bandOf(e, dimension));
        const majority = bands.length > 0 ? strictMajority(bands.map(String)) : null;
        return { dimension, majorityBand: majority === null ? null : Number(majority) };
      }),
    };
  });

  return {
    primary: { method: 'unweighted-majority', dimensions, criteria },
    ballots: entries.map((e) => ({ ...e })),
    minConfidence,
    escalate: escalations.length > 0,
    escalations,
    leaveOneFamilyOut,
    thresholds,
  };
}

/* -------------------------------------------------------------------------- */
/* M2.5 — severity correction, as sensitivity and nothing else                */
/* -------------------------------------------------------------------------- */

export interface SeverityCorrection {
  /** Where the weights were fitted. Only development evidence is admissible. */
  learnedOn: 'development' | 'holdout' | 'live' | 'unknown';
  /** What the caller intends to do with it. */
  appliedAs: 'sensitivity' | 'primary';
  weights: Record<Severity, number>;
  /** Which development set, which fit, which date. Free text, required. */
  provenance: string;
}

/**
 * Apply a severity correction — and refuse every use M2.5 forbids.
 *
 * "Use unweighted majority vote as the transparent primary analysis. Any
 * severity correction is learned only on development evidence and reported as
 * sensitivity." Both halves are enforced here rather than documented, because a
 * documented rule about which number is the headline is a rule that lasts until
 * the first time the corrected number looks better.
 */
export function applySeverityCorrection(
  correction: SeverityCorrection,
  findings: ReadonlyArray<{ severity: Severity }>,
): { sensitivityScore: number; isPrimary: false } {
  if (correction.appliedAs !== 'sensitivity') {
    throw new Error(
      'A severity correction may only be reported as sensitivity; the primary analysis is the unweighted majority vote.',
    );
  }
  if (correction.learnedOn !== 'development') {
    throw new Error(
      `A severity correction must be learned on development evidence, not "${correction.learnedOn}".`,
    );
  }
  if (!correction.provenance.trim()) {
    throw new Error('A severity correction without provenance cannot be reported as sensitivity.');
  }
  const deduction = findings.reduce((sum, f) => sum + (correction.weights[f.severity] ?? 0), 0);
  return { sensitivityScore: Math.max(0, 100 - deduction), isPrimary: false };
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Every judge call costs money, so the caller has to see it even when the
 * call fails — a parse failure burns three of these.
 */
export interface JudgeSpend {
  costUsd: number;
}

/** One parsed ballot from one seat, with empty/truncated-output escalation. */
async function askJudge<T>(
  client: CompletionClient,
  judgeModel: string,
  question: Question,
  messages: ChatMessage[],
  parse: (text: string) => T,
  spend: JudgeSpend,
): Promise<T> {
  // Reasoning judges can burn the whole token cap on hidden thinking or
  // return empty text outright: cap effort low, escalate tokens on retry.
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await client.complete(judgeModel, messages, {
      temperature: 0,
      maxTokens: 2000 * (attempt + 1),
      reasoning: { effort: 'low' },
      // Carried through so the permit's cell list and the reservation ledger
      // apply to judge calls too. A judging pass is paid work like any other.
      questionId: question.id,
      estimateUsd: JUDGE_WORST_CASE_PER_CALL_USD,
    });
    spend.costUsd += result.costUsd;
    try {
      return parse(result.text);
    } catch (err) {
      lastError = err as Error;
    }
  }
  throw lastError ?? new Error(`Judge ${judgeModel} failed on ${question.id}`);
}

async function singleVerdict(
  client: CompletionClient,
  judgeModel: string,
  question: Question,
  answerText: string,
  spend: JudgeSpend,
  lexicon?: BlindingLexicon,
): Promise<JudgeVerdict> {
  return askJudge(
    client,
    judgeModel,
    question,
    buildJudgeMessages(question, answerText, lexicon),
    (text) => parseJudgeResponse(question, text),
    spend,
  );
}

export interface PanelVerdict extends JudgeVerdict {
  judges: string[];
  verdicts: Array<JudgeVerdict & { judgeModel: string }>;
  disagreement: number;
  flagged: boolean;
  /** What this answer cost to judge, including retries on a failed seat. */
  costUsd: number;
}

/**
 * judge-v2 panel judging: two distinct judges score each answer once; the mean
 * is the score, and large cross-judge disagreement is flagged for human review.
 *
 * This is the LEGACY route, kept so the shipped pipeline keeps running. It is
 * not M2.5-compliant — two seats, a mean, no order design — and it refuses any
 * item that declares a v3 mode rather than grading it the old way.
 */
export async function judgeAnswerPanel(
  client: CompletionClient,
  panel: string[],
  candidateModelId: string,
  question: Question,
  answerText: string,
  identify: IdentityOf,
  spend: JudgeSpend = { costUsd: 0 },
  lexicon?: BlindingLexicon,
): Promise<PanelVerdict> {
  const seats = panelSeats(panel, candidateModelId, question.id, identify);
  if (seats.length < 2) {
    // Name WHY each seat was dropped. The likeliest cause is an incomplete
    // roster rather than a genuinely small panel, and "panel too small" sends
    // you looking in the wrong place — including at the temptation to relax the
    // conflict rule, which is the one thing that must not happen here.
    throw new Error(
      `Only ${seats.length} non-conflicted judge(s) for ${candidateModelId} on ${question.id}; two are required.\n` +
        panel.map((seat) => `  ${conflictReason(seat, candidateModelId, identify)}`).join('\n'),
    );
  }
  const before = spend.costUsd;
  const verdicts = await Promise.all(
    seats.map(async (judgeModel) => ({
      judgeModel,
      ...(await singleVerdict(client, judgeModel, question, answerText, spend, lexicon)),
    })),
  );
  const [a, b] = verdicts as [PanelVerdict['verdicts'][number], PanelVerdict['verdicts'][number]];
  const disagreement = Math.abs(a.score - b.score);
  return {
    score: (a.score + b.score) / 2,
    // Both seats' findings, tagged — the headline score is the two-seat mean,
    // so attributing it to seat A's findings alone (the pre-v3 behaviour) left
    // 78 rows with a sub-100 score and an empty findings list, which is the
    // first thing the human-review layer reads.
    findings: verdicts.flatMap((v) => v.findings.map((f) => ({ ...f, judgeModel: v.judgeModel }))),
    summary: verdicts.map((v) => `${v.judgeModel}: ${v.summary}`).join('\n'),
    judges: seats,
    verdicts,
    disagreement,
    flagged: disagreement > 15,
    costUsd: spend.costUsd - before,
  };
}

/**
 * Single-judge double-scoring (used by the calibration gate, which calibrates
 * each panel member independently).
 */
export async function judgeAnswer(
  client: CompletionClient,
  judgeModel: string,
  question: Question,
  answerText: string,
  spend: JudgeSpend = { costUsd: 0 },
  lexicon?: BlindingLexicon,
): Promise<
  JudgeVerdict & { verdicts: JudgeVerdict[]; disagreement: number; flagged: boolean; costUsd: number }
> {
  const before = spend.costUsd;
  const verdicts: JudgeVerdict[] = [];
  for (let i = 0; i < 2; i++) {
    verdicts.push(await singleVerdict(client, judgeModel, question, answerText, spend, lexicon));
  }
  const [a, b] = verdicts as [JudgeVerdict, JudgeVerdict];
  const disagreement = Math.abs(a.score - b.score);
  return {
    score: (a.score + b.score) / 2,
    findings: a.findings,
    summary: a.summary,
    verdicts,
    disagreement,
    flagged: disagreement > 15,
    costUsd: spend.costUsd - before,
  };
}

export interface JurySeatContext {
  seats: string[];
  /** Family per seat, in seat order — from the jury design, not re-derived. */
  families: string[];
}

/**
 * Seats must arrive from a design, with three DISTINCT families.
 *
 * Re-checked at the point of spend rather than trusted from upstream: this is
 * the last place before money is spent where a two-seat panel could still be
 * caught, and a v3 claim resting on two seats is not repairable afterwards.
 */
function assertJurySeating(seating: JurySeatContext, questionId: string): void {
  if (seating.seats.length !== SEATS_PER_COMPARISON) {
    throw new Error(
      `Jury for ${questionId} has ${seating.seats.length} seats; ${SEATS_PER_COMPARISON} are required and the panel may not be reduced.`,
    );
  }
  if (seating.families.length !== seating.seats.length) {
    throw new Error(`Jury for ${questionId} is missing a family label for every seat`);
  }
  if (new Set(seating.families).size !== seating.families.length) {
    throw new Error(
      `Jury for ${questionId} seats two members of the same judge family (${seating.families.join(', ')}); leave-one-family-out would be undefined.`,
    );
  }
}

/**
 * Dimension mode end to end: one anchored ballot per seat, majority aggregation.
 */
export async function judgeDimensionAnswer(
  client: CompletionClient,
  seating: JurySeatContext,
  question: Question,
  answerText: string,
  options: {
    spend?: JudgeSpend;
    lexicon?: BlindingLexicon;
    thresholds?: Partial<EscalationThresholds>;
  } = {},
): Promise<DimensionAggregate & { costUsd: number }> {
  assertJurySeating(seating, question.id);
  const spend = options.spend ?? { costUsd: 0 };
  const before = spend.costUsd;
  const messages = buildDimensionJudgeMessages(question, answerText, options.lexicon);
  const entries = await Promise.all(
    seating.seats.map(async (judgeModel, index) => ({
      judgeModel,
      judgeFamily: seating.families[index]!,
      ballot: await askJudge(
        client,
        judgeModel,
        question,
        messages,
        (text) => parseDimensionBallot(question, text),
        spend,
      ),
    })),
  );
  return {
    ...aggregateDimension(question, entries, { thresholds: options.thresholds }),
    costUsd: spend.costUsd - before,
  };
}

/**
 * Pairwise mode end to end: each seat judges both presentation orders, and the
 * two presentations collapse into one rater unit before anything is counted.
 */
export async function judgePairwiseComparison(
  client: CompletionClient,
  seating: JurySeatContext,
  question: Question,
  candidateA: { modelId: string; answerText: string },
  candidateB: { modelId: string; answerText: string },
  options: {
    spend?: JudgeSpend;
    lexicon?: BlindingLexicon;
    thresholds?: Partial<EscalationThresholds>;
  } = {},
): Promise<PairwiseAggregate & { costUsd: number; candidates: [string, string] }> {
  assertJurySeating(seating, question.id);
  if (candidateA.modelId === candidateB.modelId) {
    throw new Error(`Pairwise comparison on ${question.id} names ${candidateA.modelId} twice`);
  }
  const spend = options.spend ?? { costUsd: 0 };
  const before = spend.costUsd;

  const abMessages = buildPairwiseJudgeMessages(
    question,
    candidateA.answerText,
    candidateB.answerText,
    options.lexicon,
  );
  const baMessages = buildPairwiseJudgeMessages(
    question,
    candidateB.answerText,
    candidateA.answerText,
    options.lexicon,
  );

  const units = await Promise.all(
    seating.seats.map(async (judgeModel, index) => {
      const ballots = await Promise.all(
        ([
          ['AB', abMessages],
          ['BA', baMessages],
        ] as const).map(([order, messages]) =>
          askJudge(
            client,
            judgeModel,
            question,
            messages,
            (text) => parsePairwiseBallot(question, text, order),
            spend,
          ),
        ),
      );
      return resolveRaterUnit({
        judgeModel,
        judgeFamily: seating.families[index]!,
        candidateA: candidateA.modelId,
        candidateB: candidateB.modelId,
        ballots,
      });
    }),
  );

  return {
    ...aggregatePairwise(units, { thresholds: options.thresholds }),
    candidates: [candidateA.modelId, candidateB.modelId],
    costUsd: spend.costUsd - before,
  };
}
