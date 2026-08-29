create table if not exists public.shared_contexts (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  title text not null,
  kind text not null default 'other'
    check (kind in ('reading', 'article', 'project', 'discussion', 'other')),
  status text not null default 'active'
    check (status in ('active', 'archived')),
  working_context jsonb not null default '{"progress":null,"recent_decisions":[],"user_views":[],"xiaoc_views":[],"open_questions":[],"latest_update":null,"source_message_ids":[],"field_sources":{"progress":[],"recent_decisions":[],"user_views":[],"xiaoc_views":[],"open_questions":[],"latest_update":[]},"conversation_checkpoints":{}}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists shared_contexts_user_updated_idx
  on public.shared_contexts (user_id, updated_at desc);

alter table public.conversations
  add column if not exists shared_context_id uuid null
  references public.shared_contexts(id) on delete set null;

alter table public.conversations
  add column if not exists shared_context_bound_at timestamptz null;

create index if not exists conversations_shared_context_idx
  on public.conversations (user_id, shared_context_id)
  where shared_context_id is not null;
