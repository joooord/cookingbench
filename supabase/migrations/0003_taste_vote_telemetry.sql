-- Richer anonymous vote telemetry for the taste test. Both columns are
-- nullable: pre-0003 votes simply lack them, and all consumers treat them
-- as optional. session_id is a client-generated random UUID (no accounts,
-- no IP) used only to filter spam and repeat voters in analysis; vote_ms
-- is time from pair shown to vote, capped at 30 minutes.
-- (Applied to the live project 2026-06-12 via MCP.)
alter table taste_votes add column if not exists session_id text;
alter table taste_votes add column if not exists vote_ms integer
  check (vote_ms is null or (vote_ms >= 0 and vote_ms <= 1800000));

-- The archive export pages by time; analysis groups by session.
create index if not exists taste_votes_created_at_idx on taste_votes (created_at, id);
create index if not exists taste_votes_session_idx on taste_votes (session_id);
