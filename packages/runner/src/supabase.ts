import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Capability } from '@cookingbench/core';
import { Firewall } from './firewall.js';
import { assertGrantStillValid, assertVerifiedGrant, type VerifiedGrant } from './permit.js';

/**
 * RUN-001. The only path from a verified grant to the live database.
 *
 * Two defects motivate the shape of this file.
 *
 * 1. `sync.ts` and `taste.ts` each had their own private `client()` that read
 *    `SUPABASE_SERVICE_ROLE_KEY` and handed back a fully privileged connection.
 *    Two copies, no authorisation between them and the live project — the same
 *    shape as the bare `new OpenRouterClient()`, with a worse blast radius,
 *    because the service-role key bypasses RLS entirely.
 *
 * 2. The first fix checked a capability and then RETURNED THE SERVICE-ROLE
 *    CLIENT. That is a turnstile in front of an open door: a caller holding a
 *    `result-sync` permit received an object that could drop the ballot table,
 *    publish a run or read anything, and the check it passed constrained none of
 *    it. A capability check whose reward is unrestricted power is decoration.
 *
 * So the client never escapes. `serviceRoleClient` returns a fixed set of
 * OPERATIONS chosen by the capability — the specific reads and writes sync,
 * publication and the taste archive actually need — each closed over a
 * connection nobody else can reach, each bound to the grant's ONE run id, and
 * each re-checking the permit at the moment it is exercised rather than trusting
 * a check that happened when the process started.
 *
 * The NAME is retained deliberately: `docs/wp-0/routes.yaml` and
 * `guarded-clients.test.ts` cite `serviceRoleClient` as the database route, and
 * renaming it in the same change that narrows it would break the registry's
 * ability to see the thing it governs. A rename is proposed in
 * docs/wp-0/INTEGRATION-NOTES.md, to be done with the registry in one step.
 */

// ---------------------------------------------------------------------------
// Row shapes. Narrow on purpose: these are the only columns anything may write.
// ---------------------------------------------------------------------------

export interface ModelRow {
  id: string;
  display_name: string;
  provider: string;
  family: string | null;
  release_date: string | null;
  active: boolean;
}

export interface QuestionRow {
  id: string;
  category: string;
  difficulty: number;
  prompt: string;
  system_hint: string | null;
  grader: unknown;
  reference_answer: string;
  source: string | null;
  is_public: boolean;
  status: string;
}

export interface RunRow {
  config: unknown;
  methodology_version: string;
  total_cost_usd: number;
}

export interface ResponseRow {
  model_id: string;
  question_id: string;
  raw: unknown;
  answer_text: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  finish_reason: string | null;
}

export interface ScoreRow {
  response_id: number;
  score: number;
  grader_type: string;
  detail: unknown;
  judge_model: string | null;
}

export interface ResponseIdRow {
  id: number;
  model_id: string;
  question_id: string;
}

/** One page of a paginated read. PostgREST caps a select at 1000 rows. */
export interface Page {
  from: number;
  to: number;
}

// ---------------------------------------------------------------------------
// The operation sets
// ---------------------------------------------------------------------------

/**
 * What `result-sync` buys. Every run-scoped operation takes NO run id: it uses
 * the grant's, so a caller cannot sync one run under another run's approval.
 */
export interface ResultSyncOperations {
  readonly runId: string;
  upsertModels(rows: ModelRow[]): Promise<void>;
  upsertQuestions(rows: QuestionRow[]): Promise<void>;
  upsertRun(row: RunRow): Promise<void>;
  upsertResponses(rows: ResponseRow[]): Promise<void>;
  readResponseIds(page: Page): Promise<ResponseIdRow[]>;
  upsertScores(rows: ScoreRow[]): Promise<void>;
  /** The taste archive: a live READ, see TASTE_ARCHIVE_CAPABILITY below. */
  readTasteVotes(page: Page): Promise<unknown[]>;
}

/** What `publication` buys. Exactly one thing, on exactly one run. */
export interface PublicationOperations {
  readonly runId: string;
  markRunPublished(): Promise<void>;
}

export type ServiceRoleOperations = ResultSyncOperations | PublicationOperations;

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Open the privileged connection. Module-private and never returned: this is
 * the value the previous version handed to callers.
 */
function openServiceRoleConnection(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example)');
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

function fail(operation: string, message: string): never {
  throw new Error(`${operation} failed: ${message}`);
}

export function serviceRoleClient(
  grant: VerifiedGrant,
  capability: 'result-sync',
  context: string,
): ResultSyncOperations;
export function serviceRoleClient(
  grant: VerifiedGrant,
  capability: 'publication',
  context: string,
): PublicationOperations;
export function serviceRoleClient(
  grant: VerifiedGrant,
  capability: Capability,
  context: string,
): ServiceRoleOperations;
export function serviceRoleClient(
  grant: VerifiedGrant,
  capability: Capability,
  context: string,
): ServiceRoleOperations {
  assertVerifiedGrant(grant, `serviceRoleClient(${context})`);
  // Freshness first: an expired or revoked permit must not even open a
  // connection, never mind be told which capability it lacks.
  assertGrantStillValid(grant, `serviceRoleClient(${context})`);
  Firewall.fromVerifiedPermit(grant).requireCapability(capability, context);

  // Opened once, captured here, and never returned by any operation below.
  const db = openServiceRoleConnection();
  const runId = grant.runId;

  /**
   * Re-check before EVERY operation, not once at construction.
   *
   * The operations object outlives its construction — a sync of a full run
   * makes dozens of calls over minutes — so a permit that expires or is revoked
   * part-way through must stop working part-way through. Also re-asserts the
   * capability, so the connection is unreachable except through a check that
   * has just passed.
   */
  const gate = (operation: string): SupabaseClient => {
    assertGrantStillValid(grant, `${context}.${operation}`);
    Firewall.fromVerifiedPermit(grant).requireCapability(capability, `${context}.${operation}`);
    return db;
  };

  if (capability === 'result-sync') {
    const ops: ResultSyncOperations = {
      runId,
      async upsertModels(rows) {
        const { error } = await gate('upsertModels').from('models').upsert(rows);
        if (error) fail('models upsert', error.message);
      },
      async upsertQuestions(rows) {
        const { error } = await gate('upsertQuestions').from('questions').upsert(rows);
        if (error) fail('questions upsert', error.message);
      },
      async upsertRun(row) {
        // The id is the grant's, never the caller's.
        const { error } = await gate('upsertRun').from('runs').upsert({ ...row, id: runId });
        if (error) fail('runs upsert', error.message);
      },
      async upsertResponses(rows) {
        const { error } = await gate('upsertResponses')
          .from('responses')
          .upsert(
            rows.map((r) => ({ ...r, run_id: runId })),
            { onConflict: 'run_id,model_id,question_id' },
          );
        if (error) fail('responses upsert', error.message);
      },
      async readResponseIds(page) {
        const { data, error } = await gate('readResponseIds')
          .from('responses')
          .select('id, model_id, question_id')
          .eq('run_id', runId)
          .order('id', { ascending: true })
          .range(page.from, page.to);
        if (error) fail('responses id fetch', error.message);
        return (data ?? []) as ResponseIdRow[];
      },
      async upsertScores(rows) {
        const { error } = await gate('upsertScores').from('scores').upsert(rows);
        if (error) fail('scores upsert', error.message);
      },
      async readTasteVotes(page) {
        const { data, error } = await gate('readTasteVotes')
          .from('taste_votes')
          .select('*')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(page.from, page.to);
        if (error) fail('taste_votes fetch', error.message);
        return (data ?? []) as unknown[];
      },
    };
    return ops;
  }

  if (capability === 'publication') {
    const ops: PublicationOperations = {
      runId,
      async markRunPublished() {
        const { error } = await gate('markRunPublished')
          .from('runs')
          .update({ published: true })
          .eq('id', runId);
        if (error) fail('publish', error.message);
      },
    };
    return ops;
  }

  // Deny by default. A capability with no operation set gets no operations —
  // never a fallback client, which is how the previous version leaked one.
  throw new Error(
    `serviceRoleClient(${context}): no database operations are defined for capability '${capability}'. ` +
      `Operations are enumerated per capability on purpose; there is no general client to fall back to.`,
  );
}

/**
 * Reading the live ballot table moves data out of the production database, so
 * it needs a capability — but the vocabulary has no `live-db-read`, and
 * extending a security vocabulary is the protocol owner's call, not something
 * to do quietly in an implementation commit. `result-sync` is the closest
 * honest fit: this is data movement between the live project and committed
 * artifacts, in the direction the archive runs.
 *
 * Flagged rather than papered over — if a read-only capability is wanted, this
 * is the call site that motivates it.
 */
export const TASTE_ARCHIVE_CAPABILITY = 'result-sync' as const;
