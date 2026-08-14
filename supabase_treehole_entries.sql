create table if not exists public.treehole_entries (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  tag text not null default '树洞',
  entry_date text,
  content jsonb not null default '[]'::jsonb
    check (jsonb_typeof(content) = 'array'),
  highlights jsonb not null default '[]'::jsonb
    check (jsonb_typeof(highlights) = 'array'),
  reaction text not null default '🌙 偷偷偏心 · ❤️ 1',
  source text not null default 'manual'
    check (source in ('manual', 'autonomous', 'legacy')),
  seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists treehole_entries_user_created_idx
on public.treehole_entries (user_id, created_at desc);

create index if not exists treehole_entries_user_unseen_idx
on public.treehole_entries (user_id, created_at desc)
where seen_at is null;
