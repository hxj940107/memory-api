-- Exact M2A/M2C.1 ACL restoration for the objects changed by M2C.3.
-- Run only during the declared rollback window after pausing verification traffic.

begin;

set local lock_timeout = '5s';
set local statement_timeout = '30s';

select pg_advisory_xact_lock(hashtextextended('xiaoc:multi-user:m2c3:grant-containment', 0));

grant execute on function public.check_pending_moments_for_xiaoc() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_append_only() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_embedding_transition() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_import_run() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_item_immutable() to public, anon, authenticated, service_role;
grant execute on function public.xiaoc_memory_guard_operation_transition() to public, anon, authenticated, service_role;

grant all privileges on table
  public.conversation_summary,
  public.conversations,
  public.memories,
  public.messages,
  public.user_state
to anon, authenticated, service_role;

grant truncate, references, trigger on table
  public.album_assets,
  public.conversation_summary,
  public.conversations,
  public.diary_entries,
  public.memories,
  public.messages,
  public.moment_candidates,
  public.moment_check_audit,
  public.moment_comments,
  public.moment_entries,
  public.moment_interaction_state,
  public.moment_xiaoc_activity,
  public.shared_contexts,
  public.treehole_entries,
  public.user_state,
  public.xiaoc_proactive_tasks
to anon, authenticated, service_role;

grant references, trigger on table
  public.background_worker_run_audit,
  public.treehole_execution_audit
to anon, authenticated, service_role;

grant all privileges on sequence
  public.album_assets_id_seq,
  public.background_worker_run_audit_id_seq,
  public.conversation_summary_id_seq,
  public.moment_candidates_id_seq,
  public.moment_check_audit_id_seq,
  public.moment_xiaoc_activity_id_seq,
  public.treehole_execution_audit_id_seq,
  public.xiaoc_proactive_tasks_id_seq
to anon, authenticated, service_role;

alter default privileges for role postgres in schema public grant all privileges on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all privileges on sequences to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant execute on functions to anon, authenticated, service_role;

commit;
