-- Safe rollback: disable future writes and retain existing audit evidence.
begin;

revoke insert on public.xiaoc_memory_observation_audit from service_role;
revoke usage on sequence public.xiaoc_memory_observation_audit_id_seq from service_role;

create or replace function public.cleanup_xiaoc_observability_audits(
  p_retention_days integer default 60
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if p_retention_days < 30 or p_retention_days > 365 then
    raise exception 'invalid retention days';
  end if;
  delete from public.treehole_execution_audit
  where created_at < now() - make_interval(days => p_retention_days);
  delete from public.background_worker_run_audit
  where created_at < now() - make_interval(days => p_retention_days);
end;
$$;

revoke all on function public.cleanup_xiaoc_observability_audits(integer) from public, anon, authenticated;
grant execute on function public.cleanup_xiaoc_observability_audits(integer) to service_role;

commit;
