-- Make the database enforce what the application already believes about votes.
-- (Applied to the live project 2026-07-29.)
--
-- 0002 shipped `for insert to anon with check (true)`. Supabase's own linter
-- flags that as effectively bypassing RLS, and it did: the server action
-- validates the model pair, but a direct POST to PostgREST skips the server
-- action entirely, and the publishable key is committed by design. A single
-- forged row put attacker-chosen text on the public Taste Board, because
-- /taste renders whatever model ids it finds. Worse, `model_a = ' phantom'`
-- collides with the sentinel opponent the Bradley-Terry fit uses internally,
-- which would corrupt the ratings rather than merely pollute them.
--
-- The models table is the roster of record, so seed it and check against it.
-- This does NOT stop ballot stuffing — nothing here prevents someone casting a
-- thousand legitimate-looking votes — but it does stop arbitrary strings
-- entering the permanent record, which is the part that cannot be undone.

insert into models (id, display_name, provider, family, release_date, active) values
  ('anthropic/claude-fable-5','Claude Fable 5','Anthropic','claude-frontier','2026-06-09',true),
  ('anthropic/claude-opus-4.8','Claude Opus 4.8','Anthropic','claude-frontier','2026-05-28',false),
  ('openai/gpt-5.5','GPT-5.5','OpenAI','gpt-frontier','2026-04-15',false),
  ('google/gemini-3.1-pro-preview','Gemini 3.1 Pro Preview','Google','gemini-pro','2026-02-19',true),
  ('x-ai/grok-4.3','Grok 4.3','xAI','grok-frontier','2026-04-20',false),
  ('anthropic/claude-sonnet-4.6','Claude Sonnet 4.6','Anthropic','claude-mid',null,false),
  ('openai/gpt-5.4-mini','GPT-5.4 Mini','OpenAI','gpt-mid',null,true),
  ('google/gemini-3.5-flash','Gemini 3.5 Flash','Google','gemini-flash',null,false),
  ('deepseek/deepseek-v4-pro','DeepSeek V4 Pro','DeepSeek','deepseek',null,true),
  ('moonshotai/kimi-k2.6','Kimi K2.6','Moonshot AI','kimi',null,false),
  ('meta-llama/llama-4-maverick','Llama 4 Maverick','Meta','llama',null,true),
  ('mistralai/mistral-large-2512','Mistral Large 3','Mistral','mistral',null,true),
  ('qwen/qwen3.5-plus-20260420','Qwen 3.5 Plus','Alibaba','qwen',null,false),
  ('anthropic/claude-opus-5','Claude Opus 5','Anthropic','claude-frontier','2026-07-24',true),
  ('anthropic/claude-sonnet-5','Claude Sonnet 5','Anthropic','claude-mid','2026-06-30',true),
  ('openai/gpt-5.6-sol-pro','GPT-5.6 Sol Pro','OpenAI','gpt-frontier','2026-07-09',true),
  ('openai/gpt-5.6-terra-pro','GPT-5.6 Terra Pro','OpenAI','gpt-mid','2026-07-09',true),
  ('x-ai/grok-4.5','Grok 4.5','xAI','grok-frontier','2026-07-08',true),
  ('moonshotai/kimi-k3','Kimi K3','Moonshot AI','kimi','2026-07-16',true),
  ('google/gemini-3.6-flash','Gemini 3.6 Flash','Google','gemini-flash','2026-07-21',true),
  ('qwen/qwen3.7-max','Qwen 3.7 Max','Alibaba','qwen','2026-05-21',true)
on conflict (id) do update set display_name=excluded.display_name, provider=excluded.provider,
  family=excluded.family, release_date=excluded.release_date, active=excluded.active;

drop policy if exists "anon can vote" on taste_votes;
drop policy if exists "anon can vote for roster models" on taste_votes;

-- NOTE on the shape of this expression. The obvious form —
--   exists (select 1 from models m where m.id = taste_votes.model_a)
-- does not work. Every conjunct evaluates true when tested standalone as anon,
-- and the insert is still rejected: the reference to the new row from inside a
-- correlated subquery does not bind the way it reads. `IN (subquery)` takes the
-- new row's value directly and has no outer reference, so it behaves as written.
create policy "anon can vote for roster models" on taste_votes
  for insert to anon
  with check (
    model_a in (select id from models)
    and model_b in (select id from models)
    and model_a <> model_b
    and length(coalesce(run_id, '')) between 1 and 64
    and length(coalesce(question_id, '')) between 1 and 64
    and (session_id is null or session_id ~ '^[0-9a-fA-F-]{36}$')
  );

-- The policy reads models, so anon must be able to see it. Already public data:
-- the roster is committed to the repo and rendered on the site.
grant select on models to anon, authenticated;

-- Verified live with the publishable key:
--   forged model id "VOTE FOR ME evil.com" -> 401
--   " phantom" sentinel                    -> 401
--   same model on both sides               -> 401
--   session_id "<script>"                  -> 401
--   two real roster models                 -> 201
-- Test ballot removed afterwards; taste_votes back to 23 rows.
