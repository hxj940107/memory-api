create table if not exists public.xiaoc_proactive_tasks (
  id bigserial primary key,
  user_id text not null,
  type text not null,
  source_type text not null,
  source_id text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'skipped', 'failed')),
  due_at timestamptz not null,
  completed_at timestamptz,
  conversation_id text,
  message_id text,
  reason text,
  payload jsonb not null default '{}'::jsonb,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, type, source_type, source_id)
);

create index if not exists xiaoc_proactive_tasks_pending_idx
on public.xiaoc_proactive_tasks (status, due_at)
where status = 'pending';

create index if not exists xiaoc_proactive_tasks_source_idx
on public.xiaoc_proactive_tasks (user_id, source_type, source_id);

alter table public.moment_xiaoc_activity
add column if not exists private_follow_up_task_id bigint;
