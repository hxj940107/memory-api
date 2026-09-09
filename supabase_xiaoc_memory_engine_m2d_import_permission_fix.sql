-- XiaoC Memory Engine M2D import permission fix.
-- Forward-only. This does not touch an import run or any Memory row.

begin;

-- The deferred constraint trigger fires after the protected import RPC has
-- returned to the service_role context. Run the trigger body under its trusted
-- owner so it can call the deliberately private integrity helper.
alter function public.xiaoc_memory_deferred_integrity_trigger()
  owner to postgres;
alter function public.xiaoc_memory_deferred_integrity_trigger()
  security definer;
alter function public.xiaoc_memory_deferred_integrity_trigger()
  set search_path = public, pg_catalog;

-- Trigger execution does not require callers to invoke the trigger function.
-- Keep both the trigger and its helper unavailable as direct RPCs.
revoke all on function public.xiaoc_memory_deferred_integrity_trigger()
  from public, anon, authenticated, service_role;
revoke all on function public.xiaoc_memory_assert_verified_integrity(text, uuid)
  from public, anon, authenticated, service_role;

commit;

