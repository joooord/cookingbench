import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REPO_ROOT, RUNS_DIR } from '../src/dataset.js';

class ExitSignal extends Error {
  constructor(readonly status: string | number | null | undefined) {
    super(`process.exit(${String(status)})`);
    this.name = 'ExitSignal';
  }
}

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_OPENROUTER_KEY = process.env.OPENROUTER_API_KEY;
const ORIGINAL_SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function refuseExit() {
  return vi.spyOn(process, 'exit').mockImplementation((status) => {
    throw new ExitSignal(status);
  });
}

function refuseNetwork() {
  const fetch = vi.fn(() => {
    throw new Error('NETWORK_CALLED');
  });
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

afterEach(() => {
  process.argv = [...ORIGINAL_ARGV];
  restoreEnv('OPENROUTER_API_KEY', ORIGINAL_OPENROUTER_KEY);
  restoreEnv('SUPABASE_SERVICE_ROLE_KEY', ORIGINAL_SUPABASE_KEY);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('CLI import and fixed-path boundaries', () => {
  it('imports without executing a command or loading a repository .env', async () => {
    process.env.OPENROUTER_API_KEY = 'external-environment-only';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'external-environment-only';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = refuseExit();

    vi.resetModules();
    const imported = await import('../src/cli.js');

    expect(log).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
    expect(process.env.OPENROUTER_API_KEY).toBe('external-environment-only');
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe('external-environment-only');
    expect(Object.keys(imported).sort()).toEqual([
      'checkCanaries',
      'cmdJudge',
      'cmdManifest',
      'cmdPilot',
      'cmdRun',
      'cmdValidate',
      'frozenMethodologyHash',
      'requireGrant',
    ]);

    const source = readFileSync(join(REPO_ROOT, 'packages/runner/src/cli.ts'), 'utf8');
    expect(source).not.toMatch(/join\(REPO_ROOT,\s*['"]\.env['"]\)/);
    expect(source).not.toMatch(/readFileSync\([^)]*\.env/);
  });

  it('frozenMethodologyHash reads the fixed committed plan and matches its recorded digest', async () => {
    const { frozenMethodologyHash } = await import('../src/cli.js');
    const recorded = readFileSync(
      join(REPO_ROOT, 'docs/methodology/CookingBench-methodology-first-master-plan.sha256'),
      'utf8',
    ).trim().split(/\s+/)[0];

    expect(frozenMethodologyHash()).toBe(recorded);
    expect(frozenMethodologyHash.length).toBe(0);
  });

  it('checkCanaries reads only the committed question directory and finds every canary', async () => {
    const { checkCanaries } = await import('../src/cli.js');

    expect(checkCanaries()).toEqual([]);
    expect(checkCanaries.length).toBe(0);
  });

  it('cmdManifest reads the named draft and refuses malformed JSON before any run write', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'cb-cli-manifest-'));
    const draft = join(scratch, 'draft.json');
    writeFileSync(draft, '{not valid json');
    process.argv = ['node', 'cli-test', 'manifest', '--run-id', 'cli-malformed-draft', '--draft', draft];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    refuseExit();
    const fetch = refuseNetwork();

    try {
      const { cmdManifest } = await import('../src/cli.js');
      expect(() => cmdManifest()).toThrow(ExitSignal);
      expect(error.mock.calls.flat().join(' ')).toContain('is not valid JSON');
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(join(RUNS_DIR, 'cli-malformed-draft'))).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('cmdValidate completes over the committed dataset without touching credentials or the network', async () => {
    const { cmdValidate } = await import('../src/cli.js');
    process.env.OPENROUTER_API_KEY = 'unchanged-by-validation';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'unchanged-by-validation';
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fetch = refuseNetwork();

    cmdValidate();

    expect(fetch).not.toHaveBeenCalled();
    expect(process.env.OPENROUTER_API_KEY).toBe('unchanged-by-validation');
    expect(process.env.SUPABASE_SERVICE_ROLE_KEY).toBe('unchanged-by-validation');
    expect(log.mock.calls.flat().join(' ')).toContain('questions valid');
    expect(log.mock.calls.flat().join(' ')).toContain('reference answers score 100');
  });
});

describe('CLI paid routes refuse before side effects', () => {
  it('requireGrant refuses missing authority before any network client can exist', async () => {
    const { requireGrant } = await import('../src/cli.js');
    process.argv = ['node', 'cli-test', 'run'];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    refuseExit();
    const fetch = refuseNetwork();

    expect(() => requireGrant('route test')).toThrow(ExitSignal);
    expect(error.mock.calls.flat().join(' ')).toContain('requires an approved permit');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cmdRun refuses a manifest-less run before permit redemption, network or writes', async () => {
    const { cmdRun } = await import('../src/cli.js');
    const legacyRun = '2026-07-v2.1';
    const runDir = join(RUNS_DIR, legacyRun);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
    process.argv = ['node', 'cli-test', 'run', '--run-id', legacyRun];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    refuseExit();
    const fetch = refuseNetwork();

    await expect(cmdRun()).rejects.toBeInstanceOf(ExitSignal);

    expect(error.mock.calls.flat().join(' ')).toContain('MANIFEST_ABSENT');
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(join(runDir, 'manifest.json'))).toBe(false);
  });

  it('cmdJudge reads the manifested run boundary and refuses a missing config before network', async () => {
    const runId = 'cli-judge-without-config';
    vi.resetModules();
    vi.doMock('../src/manifest.js', async () => {
      const actual = await vi.importActual<typeof import('../src/manifest.js')>('../src/manifest.js');
      return {
        ...actual,
        readRunManifest: vi.fn(() => ({ runId })),
        assertRunArtifactsMatchManifest: vi.fn(() => undefined),
      };
    });

    try {
      const { cmdJudge } = await import('../src/cli.js');
      process.argv = ['node', 'cli-test', 'judge', '--run', runId];
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      refuseExit();
      const fetch = refuseNetwork();

      await expect(cmdJudge()).rejects.toBeInstanceOf(ExitSignal);
      expect(error.mock.calls.flat().join(' ')).toContain(
        `judge needs data/runs/${runId}/config.json`,
      );
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../src/manifest.js');
      vi.resetModules();
    }
  });

  it('cmdPilot is an unconditional v3 refusal before any input or side effect', async () => {
    const { cmdPilot } = await import('../src/cli.js');
    process.argv = [
      'node',
      'cli-test',
      'pilot',
      '--file',
      '../../untrusted-candidate.yaml',
      '--mock',
      '--budget',
      '999',
    ];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    refuseExit();
    const fetch = refuseNetwork();

    expect(() => cmdPilot()).toThrow(ExitSignal);

    const message = error.mock.calls.flat().join(' ');
    expect(message).toContain('pilot is disabled in v3');
    expect(message).toContain('No input is read');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cmdRun refuses a valid paid envelope before permit, estimate, client, redemption or writes', async () => {
    const runId = 'cli-paid-envelope-without-permit';
    const estimate = vi.fn(() => {
      throw new Error('ESTIMATE_CALLED');
    });
    const constructClient = vi.fn(() => {
      throw new Error('CLIENT_CONSTRUCTED');
    });
    const redeem = vi.fn(() => {
      throw new Error('PERMIT_REDEEMED');
    });
    const mergeConfig = vi.fn(() => {
      throw new Error('CONFIG_WRITTEN');
    });

    vi.resetModules();
    vi.doMock('../src/manifest.js', async () => {
      const actual = await vi.importActual<typeof import('../src/manifest.js')>('../src/manifest.js');
      return {
        ...actual,
        readRunManifest: vi.fn(() => ({
          manifestVersion: 1,
          runId,
          methodologyVersion: 'v3-test',
          schemaVersion: '1',
          parentArtifacts: [],
          evidenceClass: 'public-release',
          artifactOrigin: ['openrouter'],
          releaseState: 'draft',
          rankEligible: true,
          candidateRoutes: [
            { modelId: 'provider/test-model', provider: 'provider', baseModelFamily: 'test-model' },
          ],
          judgeRoutes: [],
          generationSettings: {
            temperature: 0,
            maxTokens: 16_000,
            maxTokensRecipe: 32_000,
            repeats: 1,
            repeatPolicy: 'single',
          },
          callPlan: { concurrency: 1, maxAttempts: 1, abortOn: [] },
          budgetCapUsd: 100,
          itemCount: 1,
        })),
        readRunDigest: vi.fn(() => ({ itemIds: ['tech-001'] })),
        assertRunArtifactsMatchManifest: vi.fn(() => undefined),
      };
    });
    vi.doMock('../src/store.js', async () => {
      const actual = await vi.importActual<typeof import('../src/store.js')>('../src/store.js');
      return {
        ...actual,
        hasResponse: vi.fn(() => false),
        readAttempts: vi.fn(() => []),
        mergeRunConfig: mergeConfig,
      };
    });
    vi.doMock('../src/estimate.js', async () => {
      const actual = await vi.importActual<typeof import('../src/estimate.js')>('../src/estimate.js');
      return { ...actual, assertFreshEstimate: estimate };
    });
    vi.doMock('../src/redemption.js', async () => {
      const actual = await vi.importActual<typeof import('../src/redemption.js')>('../src/redemption.js');
      return { ...actual, redeemPermit: redeem };
    });
    vi.doMock('../src/openrouter.js', async () => {
      const actual = await vi.importActual<typeof import('../src/openrouter.js')>('../src/openrouter.js');
      return {
        ...actual,
        OpenRouterClient: {
          forCandidates: constructClient,
          forJudging: vi.fn(() => {
            throw new Error('JUDGE_CLIENT_CONSTRUCTED');
          }),
        },
      };
    });

    try {
      const { cmdRun } = await import('../src/cli.js');
      process.argv = ['node', 'cli-test', 'run', '--run-id', runId];
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      refuseExit();
      const fetch = refuseNetwork();

      await expect(cmdRun()).rejects.toBeInstanceOf(ExitSignal);

      expect(error.mock.calls.flat().join(' ')).toContain('PAID_INFERENCE_NOT_READY');
      expect(fetch).not.toHaveBeenCalled();
      expect(estimate).not.toHaveBeenCalled();
      expect(constructClient).not.toHaveBeenCalled();
      expect(redeem).not.toHaveBeenCalled();
      expect(mergeConfig).not.toHaveBeenCalled();
      expect(existsSync(join(RUNS_DIR, runId))).toBe(false);
    } finally {
      vi.doUnmock('../src/manifest.js');
      vi.doUnmock('../src/store.js');
      vi.doUnmock('../src/estimate.js');
      vi.doUnmock('../src/redemption.js');
      vi.doUnmock('../src/openrouter.js');
      vi.resetModules();
    }
  });

  it('cmdJudge derives mock status from the manifest and refuses a paid envelope before reads or paid side effects', async () => {
    const runId = 'cli-paid-judge-disabled';
    const runDir = join(RUNS_DIR, runId);
    const readResponses = vi.fn(() => {
      throw new Error('RESPONSES_READ');
    });
    const readScores = vi.fn(() => {
      throw new Error('SCORES_READ');
    });
    const constructClient = vi.fn(() => {
      throw new Error('CLIENT_CONSTRUCTED');
    });
    const redeem = vi.fn(() => {
      throw new Error('PERMIT_REDEEMED');
    });
    const loadQuestions = vi.fn(() => {
      throw new Error('QUESTIONS_READ');
    });

    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'config.json'), '{}\n');
    vi.resetModules();
    vi.doMock('../src/manifest.js', async () => {
      const actual = await vi.importActual<typeof import('../src/manifest.js')>('../src/manifest.js');
      return {
        ...actual,
        readRunManifest: vi.fn(() => ({
          manifestVersion: 1,
          runId,
          artifactOrigin: ['openrouter'],
          candidateRoutes: [],
          judgeRoutes: [],
        })),
        assertRunArtifactsMatchManifest: vi.fn(() => undefined),
        assertRunIdentity: vi.fn(() => undefined),
      };
    });
    vi.doMock('../src/store.js', async () => {
      const actual = await vi.importActual<typeof import('../src/store.js')>('../src/store.js');
      return {
        ...actual,
        readRunConfig: vi.fn(() => ({ mock: true })),
        readResponses,
        readScores,
      };
    });
    vi.doMock('../src/dataset.js', async () => {
      const actual = await vi.importActual<typeof import('../src/dataset.js')>('../src/dataset.js');
      return { ...actual, loadQuestions };
    });
    vi.doMock('../src/redemption.js', async () => {
      const actual = await vi.importActual<typeof import('../src/redemption.js')>('../src/redemption.js');
      return { ...actual, redeemPermit: redeem };
    });
    vi.doMock('../src/openrouter.js', async () => {
      const actual = await vi.importActual<typeof import('../src/openrouter.js')>('../src/openrouter.js');
      return {
        ...actual,
        OpenRouterClient: {
          forCandidates: vi.fn(() => {
            throw new Error('CANDIDATE_CLIENT_CONSTRUCTED');
          }),
          forJudging: constructClient,
        },
      };
    });

    try {
      const { cmdJudge } = await import('../src/cli.js');
      process.argv = ['node', 'cli-test', 'judge', '--run', runId, '--budget', '100'];
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      refuseExit();
      const fetch = refuseNetwork();

      await expect(cmdJudge()).rejects.toBeInstanceOf(ExitSignal);

      expect(error.mock.calls.flat().join(' ')).toContain('PAID_INFERENCE_NOT_READY');
      expect(fetch).not.toHaveBeenCalled();
      expect(loadQuestions).not.toHaveBeenCalled();
      expect(readResponses).not.toHaveBeenCalled();
      expect(readScores).not.toHaveBeenCalled();
      expect(constructClient).not.toHaveBeenCalled();
      expect(redeem).not.toHaveBeenCalled();
    } finally {
      rmSync(runDir, { recursive: true, force: true });
      vi.doUnmock('../src/manifest.js');
      vi.doUnmock('../src/store.js');
      vi.doUnmock('../src/dataset.js');
      vi.doUnmock('../src/redemption.js');
      vi.doUnmock('../src/openrouter.js');
      vi.resetModules();
    }
  });
});
