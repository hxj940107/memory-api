alter table public.conversation_summary
  add column if not exists summary_segments jsonb not null default '[]'::jsonb;

comment on column public.conversation_summary.summary_segments is
  'Ordered summary segments with content, covered_message_ids, covered_until, created_at, id, and version.';
