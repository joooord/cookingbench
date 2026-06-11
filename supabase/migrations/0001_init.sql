-- CookingBench schema. Writes happen only via the runner using the service-role
-- key; the public site reads through RLS policies below.

create table models (
  id text primary key,                -- openrouter slug: 'anthropic/claude-fable-5'
  display_name text not null,
  provider text not null,
  family text,
  release_date date,
  active boolean not null default true
);

create table questions (
  id text primary key,
  category text not null,
  difficulty smallint not null check (difficulty between 1 and 3),
  prompt text not null,
  system_hint text,
  grader jsonb not null,
  reference_answer text,
  source text,
  is_public boolean not null default false,
  version int not null default 1
);

create table runs (
  id text primary key,                -- '2026-06-15-v1'
  created_at timestamptz not null default now(),
  config jsonb not null,              -- full RunConfig incl. judge model + prompt version
  methodology_version text not null,
  total_cost_usd numeric,
  published boolean not null default false
);

create table responses (
  id bigint generated always as identity primary key,
  run_id text not null references runs(id),
  model_id text not null references models(id),
  question_id text not null references questions(id),
  raw jsonb not null,
  answer_text text,
  tokens_in int,
  tokens_out int,
  cost_usd numeric,
  latency_ms int,
  finish_reason text,
  unique (run_id, model_id, question_id)
);

create table scores (
  response_id bigint primary key references responses(id),
  score numeric not null check (score between 0 and 100),
  grader_type text not null,
  detail jsonb,
  judge_model text
);

create view leaderboard as
  select r.run_id, r.model_id, q.category,
         avg(s.score) as category_score,
         count(*) as n,
         sum(r.cost_usd) as cost_usd
  from responses r
  join scores s on s.response_id = r.id
  join questions q on q.id = r.question_id
  join runs on runs.id = r.run_id and runs.published
  group by r.run_id, r.model_id, q.category;

alter table models enable row level security;
alter table questions enable row level security;
alter table runs enable row level security;
alter table responses enable row level security;
alter table scores enable row level security;

create policy public_read_models on models for select using (true);
create policy public_read_questions on questions for select using (is_public);
create policy public_read_runs on runs for select using (published);
create policy public_read_responses on responses for select using (
  exists (select 1 from runs where runs.id = run_id and runs.published)
  and exists (select 1 from questions where questions.id = question_id and questions.is_public)
);
create policy public_read_scores on scores for select using (
  exists (
    select 1 from responses r
    join runs on runs.id = r.run_id and runs.published
    join questions q on q.id = r.question_id and q.is_public
    where r.id = response_id
  )
);
-- No insert/update/delete policies: mutations only via the service-role key.
