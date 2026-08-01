import { getAnalysis, getLatestReport, getResponses } from '@/lib/data';

export const V21_RUN_ID = '2026-07-v2.1';

export const V21_RECORD = {
  runId: V21_RUN_ID,
  publishedDate: '29 July 2026',
  webPublicationDate: '1 August 2026',
  corpusDigest: 'cc5b5db1988921298ff72cf034ced530820d18a821009b15f56e9dfee9f40e8b',
  responseTree: '0e574bdf2ec63ca55067d0dd12bd0756eddec420',
  title:
    'CookingBench did not reliably discover the best AI cook—but it exposed how a benchmark can manufacture a convincing model ranking.',
  centralFinding:
    'CookingBench v2.1 did not support a unique fine-grained ordering of its leading models. Saturation, concentrated itemwise dispersion and a reproduced semantic scoring failure made the published ordering more precise than the instrument warranted.',
  positionThesis:
    'Cooking is an unusually rich evaluation domain because materially checkable constraints, sensory prediction, cultural context and recipient-sensitive decision-making are coupled within the same sequential task.',
} as const;

export interface V21CorpusFacts {
  responses: number;
  models: number;
  prompts: number;
  emptyAnswers: number;
  contentFilterFinishes: number;
  codePoints: number;
  utf8Bytes: number;
}

export interface V21Snapshot {
  report: NonNullable<ReturnType<typeof getLatestReport>>;
  corpus: V21CorpusFacts;
  analysis: {
    activeQuestions: number;
    allPerfect: number;
    withSignal: number;
    effectiveItemsArtifact: number;
  };
}

let cachedSnapshot: V21Snapshot | null | undefined;

/**
 * Read every public fact through the release-pinned data reader. The function
 * deliberately returns null if the approved release is not the named archive:
 * a versioned research page must never silently inherit figures from a later run.
 */
export function getV21Snapshot(): V21Snapshot | null {
  if (cachedSnapshot !== undefined) return cachedSnapshot;

  const report = getLatestReport();
  if (!report || report.runId !== V21_RUN_ID) {
    cachedSnapshot = null;
    return cachedSnapshot;
  }

  const responses = getResponses(V21_RUN_ID);
  const analysis = getAnalysis(V21_RUN_ID);
  if (responses.length === 0 || !analysis) {
    cachedSnapshot = null;
    return cachedSnapshot;
  }

  const models = new Set<string>();
  const prompts = new Set<string>();
  let emptyAnswers = 0;
  let contentFilterFinishes = 0;
  let codePoints = 0;
  let utf8Bytes = 0;

  for (const response of responses) {
    models.add(response.modelId);
    prompts.add(response.questionId);
    if (response.answerText.trim() === '') emptyAnswers += 1;
    if (response.finishReason === 'content_filter') contentFilterFinishes += 1;
    codePoints += Array.from(response.answerText).length;
    utf8Bytes += Buffer.byteLength(response.answerText, 'utf8');
  }

  cachedSnapshot = {
    report,
    corpus: {
      responses: responses.length,
      models: models.size,
      prompts: prompts.size,
      emptyAnswers,
      contentFilterFinishes,
      codePoints,
      utf8Bytes,
    },
    analysis: {
      activeQuestions: analysis.activeQuestions,
      allPerfect: analysis.activeAllPerfect,
      withSignal: analysis.activeWithSignal,
      effectiveItemsArtifact: analysis.effectiveItems,
    },
  };
  return cachedSnapshot;
}

export const CONSTRUCTS = [
  {
    name: 'Material feasibility',
    constraint: 'Ingredients, tools, quantities, heat and time',
    operation: 'Build an executable sequence',
    claim: 'The plan could work in a real kitchen',
  },
  {
    name: 'Safety and responsibility',
    constraint: 'Hazards, allergies, storage and dangerous premises',
    operation: 'Detect, refuse and adapt',
    claim: 'The eater is protected, not merely reassured',
  },
  {
    name: 'Sensory causal reasoning',
    constraint: 'Flavour, aroma, texture and their physical causes',
    operation: 'Predict the effect of a change',
    claim: 'Taste is reasoned about, not decorated with adjectives',
  },
  {
    name: 'Culture and occasion',
    constraint: 'History, setting, convention and who defines authenticity',
    operation: 'Interpret the meal in context',
    claim: 'Appropriateness is not mistaken for a universal rule',
  },
  {
    name: 'Recipient-responsive care',
    constraint: 'Need, dignity, budget, energy, preference and purpose',
    operation: 'Change the plan for this person',
    claim: 'Care is tested as observable responsiveness, not claimed feeling',
  },
] as const;

export const NEXT_PROGRAMME = [
  {
    stage: 'Define',
    work: 'Freeze the construct map, capability claims and exclusions before seeing new model results.',
    evidence: 'A preregistered measurement and analysis plan',
  },
  {
    stage: 'Build',
    work: 'Author difficult items around causal culinary reasoning, adaptation, history, culture and care—not trivia alone.',
    evidence: 'A versioned item bank with adversarial paraphrases and known failure modes',
  },
  {
    stage: 'Calibrate',
    work: 'Test scoring rules and AI judges against blinded expert annotations, disagreements and edge cases.',
    evidence: 'Judge validity, reliability and bias estimates by construct',
  },
  {
    stage: 'Run',
    work: 'Open sealed prompts only after protocol, model settings, exclusions and spend boundaries are fixed.',
    evidence: 'A complete, attributable and independently reproducible run',
  },
  {
    stage: 'Report',
    work: 'Publish profiles, uncertainty and analysis sensitivity; claim one best model only if the evidence truly separates one.',
    evidence: 'Results that can survive alternative defensible analyses',
  },
] as const;
