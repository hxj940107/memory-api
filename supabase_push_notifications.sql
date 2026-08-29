alter table public.user_state
  add column if not exists push_token text,
  add column if not exists push_notifications_enabled boolean not null default false,
  add column if not exists push_preview_enabled boolean not null default true,
  add column if not exists push_token_updated_at timestamptz;

comment on column public.user_state.push_token is
  'Single-user Expo push token for the currently installed private XiaoC app.';
