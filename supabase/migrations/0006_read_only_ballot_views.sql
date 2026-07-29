-- Make the ballot views read-only. (Applied to the live project 2026-07-29.)
--
-- 0005 narrowed anonymous *reads* to a view, which was right, but opened a
-- worse hole on the write side. Three things combined:
--
--   1. `taste_ballots` is a plain SELECT over one table, so Postgres makes it
--      auto-updatable — information_schema.views reported is_updatable = YES.
--   2. It was created `security_invoker = false`, so DML through it executes as
--      the view *owner*, which bypasses RLS on taste_votes.
--   3. Supabase grants anon INSERT/UPDATE/DELETE on new objects by default, and
--      0005 only added a SELECT grant on top — it never took the rest away.
--
-- Net effect: anyone holding the publishable key could rewrite or delete every
-- row of the permanent ballot record by going through the view. That is
-- strictly worse than the session_id exposure 0005 existed to close, and the
-- ballots are meant to be the permanent record.
--
-- The views are still SECURITY DEFINER on purpose — that is what lets anon read
-- aggregates and blinded ballots without read access to the base table, and the
-- Bradley-Terry fit genuinely needs per-row model_a/model_b/winner. Supabase's
-- linter flags the pattern; it is a deliberate trade, and the rules below remove
-- the part of it that was actually dangerous.

revoke all on taste_ballots from anon, authenticated;
revoke all on taste_winrates from anon, authenticated;
revoke all on leaderboard from anon, authenticated;

grant select on taste_ballots to anon, authenticated;
grant select on taste_winrates to anon, authenticated;
grant select on leaderboard to anon, authenticated;

-- Structural backstop, so a future GRANT cannot quietly reopen this: make the
-- view non-updatable regardless of privileges. DO INSTEAD NOTHING leaves SELECT
-- untouched.
create rule taste_ballots_no_insert as on insert to taste_ballots do instead nothing;
create rule taste_ballots_no_update as on update to taste_ballots do instead nothing;
create rule taste_ballots_no_delete as on delete to taste_ballots do instead nothing;

-- Verified after applying, with the publishable key:
--   DELETE /taste_ballots  -> 400
--   PATCH  /taste_ballots  -> 400
--   GET    /taste_ballots  -> 200
--   GET    /taste_winrates -> 200
--   select count(*) from taste_votes -> 23, unchanged.
--
-- Still open, by design and tracked separately: the "anon can vote" INSERT
-- policy is WITH CHECK (true), so a direct PostgREST insert bypasses the
-- server action's pair validation. Closing that means moving inserts to a
-- service-role key server-side and dropping the anon policy.
