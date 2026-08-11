import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/dataset.js';
import { readResponses } from '../src/store.js';

/**
 * apps/web/lib/v21-corpus-facts.json lets the research pages state seven corpus
 * aggregates without re-reading 2,576 response files on every build. That is
 * only safe because the corpus is immutable (CI pins the data/runs tree hash) —
 * and because THIS test recomputes every number from the real responses via the
 * production reader. A drifted digit here means either the committed facts were
 * hand-edited or the immutable corpus changed; both must fail loudly.
 */

const FACTS_PATH = join(REPO_ROOT, 'apps/web/lib/v21-corpus-facts.json');
const RESPONSES_DIR = join(REPO_ROOT, 'data/runs/2026-07-v2.1/responses');
const RUN_ID = '2026-07-v2.1';

describe('the committed v2.1 corpus facts match the corpus', () => {
  const facts = JSON.parse(readFileSync(FACTS_PATH, 'utf8')) as {
    corpusDigest: string;
    responses: number;
    models: number;
    prompts: number;
    emptyAnswers: number;
    contentFilterFinishes: number;
    codePoints: number;
    utf8Bytes: number;
  };

  it('every aggregate recomputes identically from the production reader', () => {
    const responses = readResponses(RUN_ID);
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
    expect({
      responses: responses.length,
      models: models.size,
      prompts: prompts.size,
      emptyAnswers,
      contentFilterFinishes,
      codePoints,
      utf8Bytes,
    }).toEqual({
      responses: facts.responses,
      models: facts.models,
      prompts: facts.prompts,
      emptyAnswers: facts.emptyAnswers,
      contentFilterFinishes: facts.contentFilterFinishes,
      codePoints: facts.codePoints,
      utf8Bytes: facts.utf8Bytes,
    });
  });

  it('the embedded digest is the real content digest of the response set', () => {
    // Same recipe the erratum publishes: sha256 over the concatenated contents
    // of the response files in filename-sorted order.
    const hash = createHash('sha256');
    for (const file of readdirSync(RESPONSES_DIR).filter((f) => f.endsWith('.json')).sort()) {
      hash.update(readFileSync(join(RESPONSES_DIR, file)));
    }
    expect(hash.digest('hex')).toBe(facts.corpusDigest);
  });

  it('the digest the web page cross-checks against is the same one', () => {
    // research.ts refuses the facts file unless facts.corpusDigest equals
    // V21_RECORD.corpusDigest. Parse the actual constant's value — a bare
    // substring search would pass if the digest merely survived in a comment
    // while the constant itself was mistyped.
    const researchSource = readFileSync(join(REPO_ROOT, 'apps/web/lib/research.ts'), 'utf8');
    const match = researchSource.match(/corpusDigest:\s*'([0-9a-f]{64})'/);
    expect(match, 'V21_RECORD.corpusDigest not found in research.ts').not.toBeNull();
    expect(match![1]).toBe(facts.corpusDigest);
  });
});
