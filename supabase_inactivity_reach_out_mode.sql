alter table public.user_state
add column if not exists inactivity_reach_out_mode text
not null default 'normal';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_state_inactivity_reach_out_mode_check'
  ) then
    alter table public.user_state
      add constraint user_state_inactivity_reach_out_mode_check
      check (
        inactivity_reach_out_mode in (
          'frequent',
          'normal',
          'relaxed',
          'off'
        )
      );
  end if;
end $$;
