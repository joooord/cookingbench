import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Capability } from '@cookingbench/core';
import { Firewall } from './firewall.js';
import { assertVerifiedGrant, type VerifiedGrant } from './permit.js';

/**
 * RUN-001. The single construction path for a service-role database client.
 *
 * `sync.ts` and `taste.ts` each had their own private `client()` that read
 * `SUPABASE_SERVICE_ROLE_KEY` and handed back a fully privileged connection.
 * Two copies, no authorisation between them and the live project — the same
 * shape as the bare `new OpenRouterClient()`, and with a worse blast radius,
 * because the service-role key bypasses RLS entirely.
 *
 * Being reachable only from a verified grant is the point. There is deliberately
 * no unguarded export here.
 */
export function serviceRoleClient(grant: VerifiedGrant, capability: Capability, context: string): SupabaseClient {
  assertVerifiedGrant(grant, `serviceRoleClient(${context})`);
  Firewall.fromVerifiedPermit(grant).requireCapability(capability, context);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (see .env.example)');
  }
  return createClient(url, key, { auth: { persistSession: false } });
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
export const TASTE_ARCHIVE_CAPABILITY: Capability = 'result-sync';
