/**
 * Local verification for data/candidates/*.yaml. Calls no model, writes nothing.
 *
 * The candidate files deliberately carry `status: candidate`, which questionSchema
 * refuses — so this maps it to `active` in memory (exactly what a human would do
 * at admission) and then applies every check the pilot's Stage 0 applies, plus the
 * v3 blocks the pilot does not yet look at.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { questionSchema, gradeDeterministic, type Question } from '@cookingbench/core';
import { loadQuestions } from './src/dataset.js';

const DIR = '/home/user/cookingbench/data/candidates';
const corpus = loadQuestions();
const existing = new Set(corpus.map((q) => q.id));

function contentTokens(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3),
  );
}

let problems = 0;
for (const file of readdirSync(DIR).filter((f) => f.endsWith('.yaml')).sort()) {
  const text = readFileSync(join(DIR, file), 'utf8');
  console.log(`\n=== ${file}`);
  if (!text.includes('CANARY:cookingbench:')) console.log('  ✗ no canary'), problems++;
  const raw = parse(text) as Array<Record<string, unknown>>;
  for (const item of raw) {
    const id = String(item.id);
    const declaredStatus = item.status;
    const flags: string[] = [];
    if (declaredStatus !== 'candidate') flags.push(`status is ${String(declaredStatus)}, not candidate`);
    if (item.authoringProvenance !== 'agent-draft') flags.push('authoringProvenance is not agent-draft');
    if (!item.canonicalTrap) flags.push('no canonicalTrap');
    if (!item.defeatingFact) flags.push('no defeatingFact');

    const parsed = questionSchema.safeParse({ ...item, status: 'active' });
    if (!parsed.success) {
      console.log(`  ✗ ${id} SCHEMA: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(' | ')}`);
      problems++;
      continue;
    }
    const q = parsed.data as Question;

    if (existing.has(id)) flags.push('id collides with the live bank'), problems++;
    const a = contentTokens(q.prompt);
    for (const other of corpus) {
      const b = contentTokens(other.prompt);
      let shared = 0;
      for (const w of a) if (b.has(w)) shared++;
      const overlap = shared / new Set([...a, ...b]).size;
      if (overlap >= 0.4) flags.push(`${Math.round(overlap * 100)}% prompt overlap with ${other.id}`);
    }

    // Stage 0, as the pilot runs it.
    const ref = gradeDeterministic(q, q.referenceAnswer);
    if (ref && ref.score < 99.99) {
      flags.push(`referenceAnswer scores ${ref.score.toFixed(1)}: ${JSON.stringify(ref.detail).slice(0, 200)}`);
      problems++;
    }
    if (q.failingAnswer) {
      const bad = gradeDeterministic(q, q.failingAnswer);
      if (bad && bad.score > 40) {
        flags.push(`failingAnswer scores ${bad.score.toFixed(1)} (needs <= 40)`);
        problems++;
      }
    }
    const groups =
      q.grader.type === 'keyword'
        ? (q.grader.required ?? [])
        : q.grader.type === 'llm-judge'
          ? (q.grader.constraintChecks ?? []).flatMap((c) => (c.type === 'keyword' ? (c.required ?? []) : []))
          : [];
    if (groups.length > 0) {
      const stuffed = `${groups.map((g) => g[0]).join(', ')}.`;
      const r = gradeDeterministic(q, stuffed);
      if (r && r.score >= 99.99) flags.push('scores 100 on keyword stuffing');
    }

    // v3 blocks the pilot does not check.
    if (!q.judgePack) flags.push('no judgePack');
    else {
      const kinds = new Set(q.judgePack.workedExamples.map((e) => e.kind));
      for (const k of ['exceptional', 'competent-ordinary', 'plausible-but-wrong', 'clearly-failing']) {
        if (!kinds.has(k as never)) flags.push(`judgePack missing worked example: ${k}`);
      }
      if (q.judgePack.criteria.every((c) => c.kind !== 'critical')) flags.push('no critical criterion');
    }
    if (!q.classification?.shortcutBlocked) flags.push('no shortcutBlocked');
    const chain = q.provenance?.authoringChain ?? [];
    if (!chain.some((s) => s.stage === 'agent-draft')) flags.push('authoringChain has no agent-draft stage');
    if (q.provenance?.verificationState !== 'draft') flags.push('verificationState is not draft');
    if (!(q.provenance?.modelExposures ?? []).some((e) => e.purpose === 'authoring')) {
      flags.push('no modelExposure with purpose authoring');
    }
    if (q.exposure) flags.push('carries an exposure state, which an unadmitted item has not earned');
    const adv = q.adversarialCases ?? [];
    if (!adv.some((c) => c.kind === 'polished-but-wrong')) flags.push('no polished-but-wrong adversarial case');
    if (!adv.some((c) => c.kind.startsWith('correct-'))) flags.push('no correct-* adversarial case');

    console.log(
      `  ${flags.length ? '✗' : '✓'} ${id} ${q.category} d${q.difficulty} ${q.grader.type}` +
        `${q.grader.type === 'llm-judge' ? `/${q.grader.judgeMode ?? 'legacy'}` : ''}` +
        `${flags.length ? `\n      - ${flags.join('\n      - ')}` : ''}`,
    );
    if (flags.length) problems++;
  }
}
console.log(`\n${problems === 0 ? 'ALL CLEAN' : `${problems} problem(s)`}`);
process.exit(problems === 0 ? 0 : 1);
