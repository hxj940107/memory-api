-- XiaoC Treehole/background observability service-role permission hardening.
-- Forward-only. This changes privileges only and does not touch audit or business rows.

begin;

revoke update, delete, truncate, references, trigger
  on public.treehole_execution_audit
  from service_role;
revoke update, delete, truncate, references, trigger
  on public.background_worker_run_audit
  from service_role;

-- Preserve only the application permissions that observability uses.
grant select, insert on public.treehole_execution_audit to service_role;
grant select, insert on public.background_worker_run_audit to service_role;
grant usage, select on sequence public.treehole_execution_audit_id_seq to service_role;
grant usage, select on sequence public.background_worker_run_audit_id_seq to service_role;

-- Cleanup remains the only service-role-accessible deletion path.
alter function public.cleanup_xiaoc_observability_audits(integer)
  owner to postgres;
alter function public.cleanup_xiaoc_observability_audits(integer)
  security definer;
alter function public.cleanup_xiaoc_observability_audits(integer)
  set search_path = pg_catalog, public;

revoke all on function public.cleanup_xiaoc_observability_audits(integer)
  from public, anon, authenticated;
grant execute on function public.cleanup_xiaoc_observability_audits(integer)
  to service_role;

commit;

