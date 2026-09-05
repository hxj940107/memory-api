alter table public.user_state
  add column if not exists client_preferences jsonb not null default '{}'::jsonb;

comment on column public.user_state.client_preferences is
  'Cross-device non-sensitive XiaoC mobile preferences. Device credentials, Face ID and push permission remain local.';

create or replace function public.patch_client_preferences(
  p_user_id text,
  p_patch jsonb
)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  merged_preferences jsonb;
begin
  if p_user_id is null or btrim(p_user_id) = '' then
    raise exception 'user_id is required';
  end if;

  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'preferences patch must be an object';
  end if;

  insert into public.user_state (
    user_id,
    client_preferences,
    updated_at
  )
  values (
    p_user_id,
    p_patch,
    now()
  )
  on conflict (user_id) do update
  set
    client_preferences = coalesce(user_state.client_preferences, '{}'::jsonb)
      || excluded.client_preferences,
    updated_at = excluded.updated_at
  returning client_preferences into merged_preferences;

  return merged_preferences;
end;
$$;

revoke all on function public.patch_client_preferences(text, jsonb)
  from public, anon, authenticated;

grant execute on function public.patch_client_preferences(text, jsonb)
  to service_role;
