-- Narrow anonymous read on the ballot log.
--
-- 0002 granted anon `select ... using (true)` on taste_votes itself, so anyone
-- holding the publishable key could download every ballot including session_id
-- (a stable per-browser UUID) and exact timestamps — enough to reconstruct any
-- one visitor's full voting history and timing. The docs described this as
-- "anon may insert votes and read tallies, nothing else".
--
-- It cannot become a tallies-only view: the Bradley-Terry fit on /taste
-- genuinely needs per-row model_a/model_b/winner. So expose exactly those
-- columns and keep the telemetry server-side.
--
-- DEPLOY TOGETHER with the app change that reads taste_ballots instead of
-- taste_votes — applying this alone breaks /taste and the Taste column.

-- taste_winrates is security_invoker, so it currently relies on the anon policy
-- below. Make it run as owner before that policy goes away.
drop view if exists taste_winrates;
create view taste_winrates with (security_invoker = false) as
  with sides as (
    select model_a as model_id,
           case winner when 'a' then 1.0 when 'tie' then 0.5 else 0.0 end as points
    from taste_votes
    union all
    select model_b,
           case winner when 'b' then 1.0 when 'tie' then 0.5 else 0.0 end
    from taste_votes
  )
  select model_id, count(*) as battles, round(avg(points) * 100, 1) as win_rate
  from sides
  group by model_id;

create view taste_ballots with (security_invoker = false) as
  select id, run_id, question_id, model_a, model_b, winner, created_at
  from taste_votes;

grant select on taste_winrates to anon;
grant select on taste_ballots to anon;

-- Insert stays open (that is the whole point of an anonymous taste test);
-- reads now go through the views.
drop policy if exists "anyone can read votes" on taste_votes;
