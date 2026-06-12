-- Face-smash taste test: anonymous blind votes on paired model answers.
-- (Applied to the live project 2026-06-12 via MCP.)
create table if not exists taste_votes (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  run_id text not null,
  question_id text not null,
  model_a text not null,
  model_b text not null,
  winner text not null check (winner in ('a', 'b', 'tie')),
  constraint distinct_models check (model_a <> model_b)
);

alter table taste_votes enable row level security;

-- Anyone may cast a vote and read the tallies; nothing else.
create policy "anon can vote" on taste_votes
  for insert to anon with check (true);
create policy "anyone can read votes" on taste_votes
  for select to anon using (true);

-- Aggregated win rates for the leaderboard's Taste column.
create view taste_winrates with (security_invoker = true) as
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
