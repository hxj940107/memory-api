alter table public.user_state
  add column if not exists client_preferences jsonb not null default '{}'::jsonb;

comment on column public.user_state.client_preferences is
  'Cross-device non-sensitive XiaoC mobile preferences. Device credentials, Face ID and push permission remain local.';
