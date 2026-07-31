-- Stage 5 — the Tasting Flight ballot. NOT YET APPLIED to any project.
--
-- Apply only from a reviewed release commit, and run the verification block at
-- the foot of this file with the publishable key before believing it is safe.
-- 0006 exists because a migration that looked obviously correct opened a hole
-- that nobody checked for.
--
-- WHY A NEW TABLE RATHER THAN COLUMNS ON taste_votes
--
-- The v3 ballot has five outcomes; taste_votes has three. The two cannot be
-- reconciled, because `tie` is ambiguous between "equally excellent" and
-- "equally poor" and there is no way to recover which a voter meant. M5.3
-- forbids conflating them, so the 26 archived v2 ballots stay exactly as they
-- are, in their own table, feeding their own (archived) Bradley-Terry board.
-- Pooling the two vocabularies would silently convert every historical
-- both-unacceptable into half a win.

/* -------------------------------------------------------------------------- */
/* Permitted proposal sources                                                 */
/* -------------------------------------------------------------------------- */

-- 0007 constrained anon votes to the `models` roster. That is still right for
-- real Taste responses, but the Tasting Flight runs on AUTHORED FIXTURES until
-- the Stage 5 gates pass (WP-7: "build against synthetic and archived fixtures
-- until measurement gates pass"). A fixture proposal must never be attributed
-- to a real model — that would be a fabricated model contact in the permanent
-- record — so fixture voices get their own ids and their own kind.
create table if not exists taste_sources (
  id text primary key,
  kind text not null check (kind in ('model', 'fixture')),
  display_name text not null,
  active boolean not null default true
);

alter table taste_sources enable row level security;

-- The roster is already public (committed to the repo, rendered on the site).
insert into taste_sources (id, kind, display_name, active)
  select id, 'model', display_name, active from models
on conflict (id) do update set
  kind = excluded.kind,
  display_name = excluded.display_name,
  active = excluded.active;

-- The authored fixture voices. Deliberately not named after any lab, model or
-- person: a blinded card must not leak identity through the id if a payload
-- ever escapes, and a fixture must not be mistakable for a model.
insert into taste_sources (id, kind, display_name, active) values
  ('fixture/ash',     'fixture', 'Fixture — Ash',     true),
  ('fixture/brine',   'fixture', 'Fixture — Brine',   true),
  ('fixture/cinder',  'fixture', 'Fixture — Cinder',  true),
  ('fixture/dill',    'fixture', 'Fixture — Dill',    true),
  ('fixture/ember',   'fixture', 'Fixture — Ember',   true),
  ('fixture/fennel',  'fixture', 'Fixture — Fennel',  true),
  ('fixture/gale',    'fixture', 'Fixture — Gale',    true),
  ('fixture/hearth',  'fixture', 'Fixture — Hearth',  true),
  ('fixture/juniper', 'fixture', 'Fixture — Juniper', true),
  ('fixture/kelp',    'fixture', 'Fixture — Kelp',    true)
on conflict (id) do update set
  kind = excluded.kind, display_name = excluded.display_name, active = excluded.active;

/* -------------------------------------------------------------------------- */
/* The ballot                                                                 */
/* -------------------------------------------------------------------------- */

create table if not exists taste_flight_ballots (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),

  -- WP-0 evidence class. `development` can never bear a rank. The anon policy
  -- below pins inserts to it; promoting a ballot to `public-taste` requires a
  -- later, reviewed migration once a permitted Taste response bank exists.
  evidence_class text not null default 'development'
    check (evidence_class in ('development', 'public-taste')),

  -- Session/task clustering (M5.6). A flight is one reader's five rounds and
  -- is the resampling unit alongside the item; both are needed because the two
  -- groupings cross.
  flight_id uuid not null,
  round smallint not null check (round between 1 and 5),

  -- Single use (M5.4). The nonce is minted server-side inside the sealed
  -- flight token; the unique index is what actually makes a replayed ballot
  -- fail, because nothing else in this system holds server-side state.
  -- Expiry is enforced by the server action against the `exp` inside the
  -- token, which cannot be moved without the key.
  ballot_nonce text not null unique check (length(ballot_nonce) between 16 and 128),

  track text not null check (track in ('rescue', 'flavour', 'service', 'surprise')),
  item_id text not null check (length(item_id) between 1 and 64),

  -- AS DISPLAYED, left and right. Storing the pair in screen order rather than
  -- canonical order is what makes the position effect measurable after the
  -- fact; canonicalisation happens in analysis, never on the way in.
  model_left text not null,
  model_right text not null,

  choice text not null check (choice in ('left', 'right', 'equal', 'neither', 'abstain')),

  -- The bounded post-vote reason lives in its own table, not a column here.
  -- M5.3 requires it to be asked only after the primary vote LOCKS, so the vote
  -- has to be recorded before the reason exists — and patching it on afterwards
  -- would need an anon UPDATE grant on the ballot record, which is exactly the
  -- write surface 0006 was written to remove. See taste_ballot_reasons below.

  -- M5.4 integrity signals.
  both_seen boolean not null,
  dwell_ms integer check (dwell_ms is null or (dwell_ms >= 0 and dwell_ms <= 1800000)),
  left_words smallint check (left_words is null or (left_words >= 0 and left_words <= 2000)),
  right_words smallint check (right_words is null or (right_words >= 0 and right_words <= 2000)),

  -- Cohorts are reported separately and never pooled. An anonymous voter
  -- cannot self-declare into `professional`; the policy below forces `public`.
  cohort text not null default 'public' check (cohort in ('public', 'professional')),

  control_kind text not null default 'none'
    check (control_kind in ('none', 'identical', 'repeat')),

  session_id text check (session_id is null or session_id ~ '^[0-9a-fA-F-]{36}$'),

  -- An identical-answer control legitimately serves one source on both sides.
  -- Everything else must be a real pair. Expressed as one constraint so the
  -- two cases cannot drift apart.
  constraint distinct_unless_identical_control
    check (control_kind = 'identical' or model_left <> model_right),

  -- One ballot per round per flight. Without this a client could resubmit the
  -- same round under fresh nonces and vote five times on its favourite pair.
  constraint one_ballot_per_round unique (flight_id, round)
);

alter table taste_flight_ballots enable row level security;

create index if not exists taste_flight_ballots_created_idx
  on taste_flight_ballots (created_at, id);
create index if not exists taste_flight_ballots_flight_idx
  on taste_flight_ballots (flight_id);
create index if not exists taste_flight_ballots_session_idx
  on taste_flight_ballots (session_id);
create index if not exists taste_flight_ballots_track_idx
  on taste_flight_ballots (track, item_id);

/* -------------------------------------------------------------------------- */
/* Anonymous insert policy                                                    */
/* -------------------------------------------------------------------------- */

drop policy if exists "anon can cast a flight ballot" on taste_flight_ballots;

-- NOTE ON THE SHAPE OF THIS EXPRESSION — this cost a whole debugging session in
-- 0007 and the trap has not moved. The obvious form
--
--     exists (select 1 from taste_sources s where s.id = taste_flight_ballots.model_left)
--
-- silently rejects EVERY insert: each conjunct tests true standalone as anon,
-- yet the correlated reference to the new row does not bind the way it reads.
-- `IN (subquery)` takes the new row's value directly and has no outer
-- reference, so it behaves as written. Do not "tidy" these into EXISTS.
create policy "anon can cast a flight ballot" on taste_flight_ballots
  for insert to anon
  with check (
    model_left in (select id from taste_sources where active)
    and model_right in (select id from taste_sources where active)
    -- Development evidence only. This is the firewall: nothing an anonymous
    -- client can insert is ever rank-bearing, whatever it claims.
    and evidence_class = 'development'
    -- A voter cannot promote themselves into the verified-professional cohort.
    and cohort = 'public'
    -- both_seen = false is recorded, not rejected: the refusal rate is itself
    -- a finding, and a client that cannot report it must not be able to hide
    -- that by omitting the ballot. Admissibility is decided in analysis.
    and both_seen is not null
    and (control_kind = 'identical' or model_left <> model_right)
  );

-- The policy reads taste_sources, so anon must be able to see it.
grant select on taste_sources to anon, authenticated;
create policy "anyone can read permitted sources" on taste_sources
  for select to anon using (true);

-- No anon SELECT policy on taste_flight_ballots itself. Reads go through the
-- view below, which withholds session_id and dwell_ms — a stable per-browser
-- UUID plus per-round timings reconstructs one visitor's whole sitting, which
-- is exactly what 0005 existed to stop leaking on the v2 table.

/* -------------------------------------------------------------------------- */
/* The bounded post-vote reason                                               */
/* -------------------------------------------------------------------------- */

-- Append-only, one row per ballot, keyed by the ballot's spent nonce.
--
-- WHY AN INDEX RATHER THAN TEXT. Each item offers two or three fixed reasons,
-- authored alongside it. Storing the chosen INDEX means no free text can ever
-- enter the permanent record — a `reason_code text` column that anon may insert
-- into is a public writable string on a page that renders it, and the taste
-- board has already had one of those (0007's forged model ids).
-- The index resolves back to wording through the fixture bank at analysis time.
--
-- The primary key is the nonce, so a second reason for the same ballot is a
-- 409 rather than an overwrite. Nothing here can modify the vote itself.
create table if not exists taste_ballot_reasons (
  ballot_nonce text primary key
    references taste_flight_ballots (ballot_nonce) on delete cascade,
  created_at timestamptz not null default now(),
  reason_index smallint not null check (reason_index between 0 and 2)
);

alter table taste_ballot_reasons enable row level security;

drop policy if exists "anon can attach one reason" on taste_ballot_reasons;
create policy "anon can attach one reason" on taste_ballot_reasons
  for insert to anon
  with check (
    -- Same IN (subquery) shape as above, and for the same reason: a correlated
    -- EXISTS referencing the new row does not bind and rejects everything.
    ballot_nonce in (select ballot_nonce from taste_flight_ballots)
    and reason_index between 0 and 2
  );

-- The policy reads taste_flight_ballots, which anon cannot SELECT. A policy's
-- subquery runs with the privileges of the policy owner rather than the caller,
-- so this works without granting anon any read on the ballot table — verify it
-- anyway with the checklist at the foot of this file, because "should work" is
-- how 0007's EXISTS form got written.
revoke insert, update, delete, truncate on taste_ballot_reasons from authenticated;
revoke update, delete, truncate on taste_ballot_reasons from anon;

/* -------------------------------------------------------------------------- */
/* The public read view                                                       */
/* -------------------------------------------------------------------------- */

drop view if exists taste_flight_reads;

create view taste_flight_reads with (security_invoker = false) as
  select
    id,
    created_at,
    evidence_class,
    flight_id,
    round,
    track,
    item_id,
    model_left,
    model_right,
    choice,
    both_seen,
    left_words,
    right_words,
    cohort,
    control_kind
  from taste_flight_ballots;

-- READ 0006 BEFORE CHANGING ANY OF THE NEXT TWELVE LINES.
--
-- A view that is a plain SELECT over one table is AUTO-UPDATABLE in Postgres.
-- This one is. It is also security_invoker = false, so DML through it would run
-- as the owner and bypass RLS on the base table, and Supabase grants anon
-- INSERT/UPDATE/DELETE on new objects by default — a SELECT grant does not take
-- the others away. That combination is how the entire v2 ballot record became
-- deletable with the publishable key.
--
-- Two independent defences, because either alone has already failed once:
-- revoke the privileges, and make the view structurally non-writable.
revoke all on taste_flight_reads from anon, authenticated;
grant select on taste_flight_reads to anon, authenticated;

create rule taste_flight_reads_no_insert as on insert to taste_flight_reads do instead nothing;
create rule taste_flight_reads_no_update as on update to taste_flight_reads do instead nothing;
create rule taste_flight_reads_no_delete as on delete to taste_flight_reads do instead nothing;

-- Reasons, joined to their ballot so the spent nonce never leaves the server.
-- A view over a JOIN is not auto-updatable in Postgres, which is a second,
-- structural reason this one cannot be written through — but the grants and the
-- rules go on regardless, because "not auto-updatable today" is a property of
-- the query and the query is the thing most likely to be edited.
drop view if exists taste_flight_reason_reads;
create view taste_flight_reason_reads with (security_invoker = false) as
  select b.id as ballot_id, b.flight_id, b.round, b.item_id, r.reason_index, r.created_at
  from taste_ballot_reasons r
  join taste_flight_ballots b on b.ballot_nonce = r.ballot_nonce;

revoke all on taste_flight_reason_reads from anon, authenticated;
grant select on taste_flight_reason_reads to anon, authenticated;

create rule taste_flight_reason_reads_no_insert as on insert to taste_flight_reason_reads do instead nothing;
create rule taste_flight_reason_reads_no_update as on update to taste_flight_reason_reads do instead nothing;
create rule taste_flight_reason_reads_no_delete as on delete to taste_flight_reason_reads do instead nothing;

-- taste_sources is a base table with RLS and a SELECT-only policy, but the
-- default grants apply to it too.
revoke insert, update, delete, truncate on taste_sources from anon, authenticated;
revoke insert, update, delete, truncate on taste_flight_ballots from authenticated;

/* -------------------------------------------------------------------------- */
/* Verification — RUN THIS, do not assume                                     */
/* -------------------------------------------------------------------------- */

-- As owner:
--
--   select table_name, is_updatable, is_insertable_into
--     from information_schema.views
--    where table_name in ('taste_flight_reads', 'taste_ballots', 'taste_winrates');
--
--   select grantee, privilege_type from information_schema.role_table_grants
--    where table_name in ('taste_flight_reads', 'taste_flight_ballots', 'taste_sources')
--      and grantee in ('anon', 'authenticated');
--   -- expect: SELECT on taste_flight_reads and taste_sources for both roles,
--   --         INSERT on taste_flight_ballots for anon only, nothing else.
--
-- With the publishable key, over PostgREST — every one of these must fail:
--
--   DELETE /rest/v1/taste_flight_reads?id=eq.<any>          -> not 2xx
--   PATCH  /rest/v1/taste_flight_reads?id=eq.<any>          -> not 2xx
--   POST   /rest/v1/taste_flight_reads                      -> not 2xx
--   DELETE /rest/v1/taste_flight_ballots?id=eq.<any>        -> not 2xx
--   PATCH  /rest/v1/taste_flight_ballots?id=eq.<any>        -> not 2xx
--   GET    /rest/v1/taste_flight_ballots                    -> not 2xx (no read policy)
--   POST   /rest/v1/taste_flight_ballots  evidence_class='public-taste'  -> 401/403
--   POST   /rest/v1/taste_flight_ballots  cohort='professional'          -> 401/403
--   POST   /rest/v1/taste_flight_ballots  model_left='anthropic/made-up' -> 401/403
--   POST   /rest/v1/taste_flight_ballots  model_left=model_right, control_kind='none' -> 401/403
--   POST   /rest/v1/taste_flight_ballots  a valid row, twice with one nonce -> second is 409
--   POST   /rest/v1/taste_flight_ballots  same (flight_id, round), new nonce -> 409
--   POST   /rest/v1/taste_ballot_reasons  unknown ballot_nonce               -> 401/403
--   POST   /rest/v1/taste_ballot_reasons  reason_index = 7                   -> 400/401
--   POST   /rest/v1/taste_ballot_reasons  same nonce twice                   -> second is 409
--   PATCH  /rest/v1/taste_ballot_reasons                                     -> not 2xx
--   GET    /rest/v1/taste_ballot_reasons                                     -> not 2xx (no read policy)
--
-- And these must succeed:
--
--   GET    /rest/v1/taste_flight_reads                      -> 200
--   GET    /rest/v1/taste_flight_reason_reads               -> 200
--   GET    /rest/v1/taste_sources                           -> 200
--   POST   /rest/v1/taste_ballot_reasons  valid nonce, reason_index 0 -> 201
--   POST   /rest/v1/taste_flight_ballots  a valid development row -> 201
--
-- Remove the test rows afterwards as owner and re-count, as 0006 and 0007 did.
--
-- STILL OPEN, deliberately, and tracked: ballot stuffing. Nothing here stops
-- someone completing a thousand honest-looking flights. The sealed token bounds
-- replay and the nonce bounds resubmission; volume is a behavioural problem and
-- is handled in analysis by `abuseSignals`, which is explicitly not an
-- authentication story.
