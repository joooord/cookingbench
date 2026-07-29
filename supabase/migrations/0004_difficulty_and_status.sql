-- Unblock `bench sync`. As of this migration the benchmark tables in the live
-- project were still entirely empty — runs/models/questions/responses/scores
-- all 0 rows — because sync cannot complete against the constraint below.
-- Safe to apply on its own: additive, and there is no data to migrate.

-- 1. difficulty was capped at 3, but the dataset has 30 items at difficulty 4
--    and 5 at difficulty 5 — `frontier` is literally defined as >= 4. The
--    single-statement upsert in syncDataset aborts on the first difficulty-4
--    row, after the models upsert has already half-succeeded.
alter table questions drop constraint if exists questions_difficulty_check;
alter table questions add constraint questions_difficulty_check
  check (difficulty between 1 and 5);

-- 2. There was no status column, so the v1 `leaderboard` view averaged active,
--    basics and retired items together and could never reproduce the published
--    Overall, which is a plain mean over active items only.
alter table questions add column if not exists status text not null default 'active'
  check (status in ('active', 'basics', 'retired'));

drop view if exists leaderboard;
create view leaderboard with (security_invoker = true) as
  select r.run_id, r.model_id, round(avg(s.score), 1) as overall, count(*) as questions
  from scores s
  join responses r on r.id = s.response_id
  join questions q on q.id = r.question_id
  join runs run on run.id = r.run_id and run.published
  where q.status = 'active'
  group by r.run_id, r.model_id;
