begin;
set local lock_timeout = '10s';
-- Physical deletion for conversations without retained Memory evidence. One
-- transaction prevents partial deletion; existing Memory evidence stays protected.
create or replace function public.xiaoc_delete_conversation(p_user_id text, p_conversation_id text)
returns jsonb language plpgsql security definer
set search_path = public, pg_catalog as $$
begin
  if p_user_id is null or btrim(p_user_id) = '' or p_conversation_id is null or btrim(p_conversation_id) = '' then
    raise exception 'INVALID_CONVERSATION';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('memory-event:' || p_user_id || ':' || p_conversation_id, 0));
  perform 1 from public.conversations where user_id = p_user_id and conversation_id = p_conversation_id for update;
  if not found then return jsonb_build_object('ok', true); end if;
  if exists(select 1 from public.memory_provenance p where p.user_id = p_user_id
    and (p.source_conversation_id = p_conversation_id or p.source_message_id in
      (select id from public.messages where user_id = p_user_id and conversation_id = p_conversation_id)))
    or exists(select 1 from public.memory_capture_events where user_id = p_user_id
      and conversation_id = p_conversation_id and memory_id is not null) then
    raise exception 'CONVERSATION_HAS_MEMORY_EVIDENCE';
  end if;
  delete from public.memory_capture_events where user_id = p_user_id and conversation_id = p_conversation_id and memory_id is null;
  delete from public.messages where user_id = p_user_id and conversation_id = p_conversation_id;
  delete from public.conversation_summary s where s.conversation_id = p_conversation_id
    and exists(select 1 from public.conversations c where c.user_id = p_user_id and c.conversation_id = s.conversation_id);
  delete from public.conversations where user_id = p_user_id and conversation_id = p_conversation_id;
  return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.xiaoc_delete_conversation(text,text) from public, anon, authenticated;
grant execute on function public.xiaoc_delete_conversation(text,text) to service_role;
commit;
