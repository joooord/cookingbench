import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/dataset.js';
import {
  ManifestError,
  assertReproducibleGitIdentity,
  assertReproducibleGitIdentityForTests,
} from '../src/manifest.js';

describe('production git identity is reproducible from the declared commit', () => {
  let repoRoot = '';
  let head = '';

  function git(args: string[]): string {
    return execFileSync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  function write(relativePath: string, contents: string): void {
    const path = join(repoRoot, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  function refusal(commit = head): ManifestError {
    let caught: unknown;
    try {
      assertReproducibleGitIdentityForTests(commit, repoRoot);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ManifestError);
    return caught as ManifestError;
  }

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cookingbench-git-identity-'));
    git(['init', '--quiet']);
    git(['config', 'user.name', 'CookingBench test']);
    git(['config', 'user.email', 'test@cookingbench.invalid']);
    git(['config', 'commit.gpgsign', 'false']);

    write('packages/core/src/index.ts', 'export const core = 1;\n');
    write('packages/runner/src/index.ts', 'export const runner = 1;\n');
    write('data/questions/example.yaml', 'id: example\n');
    write('data/models.yaml', 'models: []\n');
    write('data/calibration/anchors.yaml', '[]\n');
    write('data/historical-runs.json', '{"runIds":[]}\n');
    write('data/permits/keys/reviewer.pub', 'test public key bytes\n');
    write('data/permits/revoked.json', '{"revokedPermitIds":[]}\n');
    write('docs/methodology/plan.md', '# Frozen method\n');
    write('docs/wp-0/traceability.yaml', 'requirements: []\n');
    git(['add', '--all']);
    git(['commit', '--quiet', '-m', 'initial reproducible source']);
    head = git(['rev-parse', 'HEAD']);
  });

  afterEach(() => {
    if (repoRoot !== '') rmSync(repoRoot, { recursive: true, force: true });
  });

  it('checks the real fixed repository paths through the production wrapper', () => {
    const current = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    const status = execFileSync(
      'git',
      [
        'status',
        '--porcelain=v1',
        '--untracked-files=all',
        '--',
        'packages/core/src',
        'packages/runner/src',
        'data/questions',
        'data/models.yaml',
        'data/calibration',
        'data/historical-runs.json',
        'data/permits/keys',
        'data/permits/revoked.json',
        'docs/methodology',
        'docs/wp-0/traceability.yaml',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    ).trim();

    if (status === '') {
      expect(assertReproducibleGitIdentity(current)).toBe(current);
    } else {
      let caught: unknown;
      try {
        assertReproducibleGitIdentity(current);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ManifestError);
      expect((caught as ManifestError).code).toBe('SOURCE_TREE_DIRTY');
      expect((caught as ManifestError).message).toContain(status.split('\n')[0]!.slice(3));
    }
  });

  it('accepts the exact current commit when every relevant path is clean', () => {
    expect(assertReproducibleGitIdentityForTests(head, repoRoot)).toBe(head);
  });

  it.each([
    ['core source', 'packages/core/src/index.ts', 'export const core = 2;\n'],
    ['runner source', 'packages/runner/src/index.ts', 'export const runner = 2;\n'],
    ['question', 'data/questions/example.yaml', 'id: changed\n'],
    ['model roster', 'data/models.yaml', 'models:\n  - id: changed\n'],
    ['calibration bank', 'data/calibration/anchors.yaml', '- changed\n'],
    ['historical policy', 'data/historical-runs.json', '{"runIds":["changed"]}\n'],
    ['permit trust root', 'data/permits/keys/reviewer.pub', 'changed key\n'],
    ['permit revocations', 'data/permits/revoked.json', '{"revokedPermitIds":["changed"]}\n'],
    ['methodology', 'docs/methodology/plan.md', '# Changed method\n'],
    ['traceability matrix', 'docs/wp-0/traceability.yaml', 'requirements:\n  - changed\n'],
  ])('refuses dirty tracked %s bytes even though HEAD itself is unchanged', (_label, path, bytes) => {
    write(path, bytes);

    const error = refusal();
    expect(error.code).toBe('SOURCE_TREE_DIRTY');
    expect(error.message).toContain(path);
  });

  it('refuses untracked question bytes that checking out the commit would lose', () => {
    write('data/questions/untracked.yaml', 'id: untracked\n');

    const error = refusal();
    expect(error.code).toBe('SOURCE_TREE_DIRTY');
    expect(error.message).toMatch(/\?\? data\/questions\/untracked\.yaml/);
  });

  it('refuses a full-length commit id that does not exist in the repository', () => {
    const error = refusal('f'.repeat(40));

    expect(error.code).toBe('SOURCE_COMMIT_MISMATCH');
    expect(error.message).toMatch(/does not identify an existing commit/);
  });

  it('refuses an existing commit that is no longer the current source', () => {
    const prior = head;
    write('README.md', 'second commit\n');
    git(['add', 'README.md']);
    git(['commit', '--quiet', '-m', 'advance head']);
    head = git(['rev-parse', 'HEAD']);

    const error = refusal(prior);
    expect(error.code).toBe('SOURCE_COMMIT_MISMATCH');
    expect(error.message).toContain(`is not the current source commit ${head}`);
  });

  it('refuses abbreviated commit prefixes at the production boundary', () => {
    const error = refusal(head.slice(0, 12));

    expect(error.code).toBe('SOURCE_COMMIT_MISMATCH');
    expect(error.message).toMatch(/not a full 40-character commit identity/);
  });
});
