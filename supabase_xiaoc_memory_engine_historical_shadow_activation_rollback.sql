-- Safe mechanism rollback: disable execution without changing activated data.
revoke execute on function public.xiaoc_memory_activate_historical_shadow(text,text,text,jsonb,text) from service_role;
revoke execute on function public.xiaoc_memory_demote_historical_shadow(text,text,text,jsonb,uuid,text) from service_role;
