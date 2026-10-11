-- RUN ONLY IN STAGING: frkkcycsvxqqffyituqu
-- Run this ENTIRE script. No business code or migration is changed.
-- The single DO execution creates and uses all fixtures in one backend session.
-- Its internal exception subtransaction rolls back ALL test data and DDL,
-- even if the editor executes the outer BEGIN/ROLLBACK separately.
-- Success emits a PASS notice with ten results. Any other exception is FAIL.
BEGIN;
DO $staging_validation$
DECLARE
  v_report jsonb;
BEGIN
  PERFORM set_config('statement_timeout', '30s', true);
  BEGIN
    EXECUTE $validation_payload$
DO $preflight$
DECLARE v_ref text := current_setting('app.settings.project_ref', true);
BEGIN
  IF v_ref IS NOT NULL AND v_ref <> '' AND v_ref <> 'frkkcycsvxqqffyituqu' THEN
    RAISE EXCEPTION 'WRONG PROJECT: expected staging frkkcycsvxqqffyituqu';
  END IF;
  IF to_regclass('public.memory_capture_events') IS NULL
    OR to_regprocedure('public.xiaoc_memory_capture_event_verified(text,text,uuid,uuid,jsonb,text,text,jsonb,text)') IS NULL
    OR to_regprocedure('public.xiaoc_memory_event_decide(text,text,uuid,uuid,text,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'Migration prerequisites missing';
  END IF;
END;
$preflight$;

CREATE TEMP TABLE pg_temp.capture_test_context (
  owner_id text, other_owner text, conversation_id text, other_conversation text,
  root_id uuid, reveal_id uuid, foreign_owner_id uuid, foreign_conversation_id uuid,
  assistant_id uuid, invalid_root_id uuid, late_root_id uuid, late_reveal_id uuid
) ON COMMIT DROP;
INSERT INTO pg_temp.capture_test_context
SELECT 'fictional-event-owner-' || extensions.gen_random_uuid(),
  'fictional-other-owner-' || extensions.gen_random_uuid(),
  'fictional-event-chat-' || extensions.gen_random_uuid(),
  'fictional-other-chat-' || extensions.gen_random_uuid(),
  extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
  extensions.gen_random_uuid(), extensions.gen_random_uuid(), extensions.gen_random_uuid(),
  extensions.gen_random_uuid(), extensions.gen_random_uuid();

INSERT INTO public.conversations(conversation_id,user_id,title)
SELECT conversation_id,owner_id,'Fictional capture validation' FROM pg_temp.capture_test_context
UNION ALL SELECT other_conversation,owner_id,'Fictional separate conversation' FROM pg_temp.capture_test_context;
INSERT INTO public.messages(id,user_id,conversation_id,role,content,created_at,metadata)
SELECT root_id,owner_id,conversation_id,'user','我准备了一份礼物，稍后揭晓',now()-interval '10 minutes','{}'::jsonb FROM pg_temp.capture_test_context
UNION ALL SELECT reveal_id,owner_id,conversation_id,'user','礼物是域名 lantern.example',now()-interval '5 minutes','{}'::jsonb FROM pg_temp.capture_test_context
UNION ALL SELECT foreign_owner_id,other_owner,conversation_id,'user','别人的虚构事实',now()-interval '5 minutes','{}'::jsonb FROM pg_temp.capture_test_context
UNION ALL SELECT foreign_conversation_id,owner_id,other_conversation,'user','另一对话的虚构事实',now()-interval '5 minutes','{}'::jsonb FROM pg_temp.capture_test_context
UNION ALL SELECT assistant_id,owner_id,conversation_id,'assistant','我自己说的虚构事实',now()-interval '5 minutes','{}'::jsonb FROM pg_temp.capture_test_context
UNION ALL SELECT invalid_root_id,owner_id,conversation_id,'user','我准备了另一份虚构礼物',now()-interval '10 minutes','{}'::jsonb FROM pg_temp.capture_test_context
UNION ALL SELECT late_root_id,owner_id,conversation_id,'user','我准备了虚构的纪念卡',now()-interval '10 minutes','{}'::jsonb FROM pg_temp.capture_test_context
UNION ALL SELECT late_reveal_id,owner_id,conversation_id,'user','纪念卡名字是星灯',now()-interval '5 minutes','{}'::jsonb FROM pg_temp.capture_test_context;

CREATE TEMP TABLE pg_temp.capture_test_results(test_name text, result text, detail text) ON COMMIT DROP;
GRANT SELECT ON pg_temp.capture_test_context TO service_role;
GRANT INSERT, SELECT ON pg_temp.capture_test_results TO service_role;

-- Test the real service-role grants instead of using postgres for the RPC calls.
SET LOCAL ROLE service_role;
DO $tests$
DECLARE
  c record;
  v_sources jsonb;
  v_bad_sources jsonb;
  v_memory uuid;
  v_repeat uuid;
  v_count integer;
  v_expiry timestamptz;
  v_bad record;
  v_rejected boolean;
  v_error text;
  v_before integer[];
  v_after integer[];
BEGIN
  SELECT * INTO c FROM pg_temp.capture_test_context;
  v_sources := jsonb_build_array(
    jsonb_build_object('source_message_id',c.root_id,'source_role','user',
      'evidence_text','我准备了一份礼物，稍后揭晓','evidence_type','assertion'),
    jsonb_build_object('source_message_id',c.reveal_id,'source_role','user',
      'evidence_text','礼物是域名 lantern.example','evidence_type','assertion'));

  PERFORM public.xiaoc_memory_event_decide(c.owner_id,c.conversation_id,c.root_id,c.root_id,'defer');
  SELECT expires_at INTO v_expiry FROM public.memory_capture_events
    WHERE user_id=c.owner_id AND conversation_id=c.conversation_id AND event_start_message_id=c.root_id;
  PERFORM public.xiaoc_memory_event_decide(c.owner_id,c.conversation_id,c.root_id,c.reveal_id,'defer');
  IF NOT EXISTS (SELECT 1 FROM public.memory_capture_events WHERE user_id=c.owner_id
    AND event_start_message_id=c.root_id AND status='deferred' AND memory_id IS NULL
    AND expires_at=v_expiry AND last_message_id=c.reveal_id) THEN
    RAISE EXCEPTION 'FAIL: deferred state or immutable expiry';
  END IF;
  INSERT INTO pg_temp.capture_test_results VALUES ('defer_lifecycle','PASS','deferred; expiry not extended; no Memory');

  v_memory := public.xiaoc_memory_capture_event_verified(c.owner_id,c.conversation_id,c.root_id,c.reveal_id,
    v_sources,'她为我准备了礼物，揭晓是域名 lantern.example。','relationship_memory','{}'::jsonb,
    'capture-event-v1:' || c.conversation_id || ':' || c.root_id::text);
  SELECT count(*) INTO v_count FROM public.memory_items WHERE user_id=c.owner_id;
  IF v_count <> 1 THEN RAISE EXCEPTION 'FAIL: expected exactly one Memory'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memory_items WHERE id=v_memory AND user_id=c.owner_id
    AND canonical_content='她为我准备了礼物，揭晓是域名 lantern.example。'
    AND provenance_status='verified_user' AND lifecycle_status='active'
    AND authority_tier='native_verified' AND origin_system='xiaoc_native') THEN
    RAISE EXCEPTION 'FAIL: Memory identity/lifecycle/authority';
  END IF;
  SELECT count(*) INTO v_count FROM public.memory_provenance WHERE user_id=c.owner_id AND memory_id=v_memory;
  IF v_count <> 2 THEN RAISE EXCEPTION 'FAIL: expected two provenance rows'; END IF;
  IF (SELECT count(DISTINCT source_message_id) FROM public.memory_provenance
    WHERE user_id=c.owner_id AND memory_id=v_memory AND source_conversation_id=c.conversation_id
      AND source_role='user' AND source_message_id IN (c.root_id,c.reveal_id)
      AND evidence_hash=encode(extensions.digest(convert_to(evidence_text,'UTF8'),'sha256'),'hex')) <> 2 THEN
    RAISE EXCEPTION 'FAIL: provenance source/hash';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.memory_capture_events WHERE user_id=c.owner_id
    AND event_start_message_id=c.root_id AND status='captured' AND memory_id=v_memory
    AND last_message_id=c.reveal_id AND lease_until IS NULL) THEN
    RAISE EXCEPTION 'FAIL: event/Memory state inconsistent';
  END IF;
  IF (SELECT count(*) FROM public.memory_operations WHERE user_id=c.owner_id
    AND operation_type='capture_verified' AND result_status='success'
    AND affected_memory_ids=ARRAY[v_memory]) <> 1 THEN
    RAISE EXCEPTION 'FAIL: successful operation missing';
  END IF;
  INSERT INTO pg_temp.capture_test_results VALUES ('multi_source_atomic_capture','PASS','1 Memory, 2 exact provenance, 1 successful operation, captured event');

  v_repeat := public.xiaoc_memory_capture_event_verified(c.owner_id,c.conversation_id,c.root_id,c.reveal_id,
    v_sources,'她为我准备了礼物，揭晓是域名 lantern.example。','relationship_memory','{}'::jsonb,
    'capture-event-v1:' || c.conversation_id || ':' || c.root_id::text);
  IF v_repeat IS DISTINCT FROM v_memory
    OR (SELECT count(*) FROM public.memory_items WHERE user_id=c.owner_id) <> 1
    OR (SELECT count(*) FROM public.memory_provenance WHERE user_id=c.owner_id) <> 2
    OR (SELECT count(*) FROM public.memory_operations WHERE user_id=c.owner_id) <> 1 THEN
    RAISE EXCEPTION 'FAIL: repeat captured additional rows';
  END IF;
  PERFORM public.xiaoc_memory_event_decide(c.owner_id,c.conversation_id,c.root_id,c.reveal_id,'defer');
  PERFORM public.xiaoc_memory_event_decide(c.owner_id,c.conversation_id,c.root_id,c.reveal_id,'reject');
  IF NOT EXISTS (SELECT 1 FROM public.memory_capture_events WHERE user_id=c.owner_id
    AND event_start_message_id=c.root_id AND status='captured' AND memory_id=v_memory) THEN
    RAISE EXCEPTION 'FAIL: captured event reopened or closed';
  END IF;
  INSERT INTO pg_temp.capture_test_results VALUES ('repeat_same_event','PASS','same Memory ID; no extra rows; captured event unchanged');

  SELECT ARRAY[(SELECT count(*)::integer FROM public.memory_items WHERE user_id=c.owner_id),
    (SELECT count(*)::integer FROM public.memory_provenance WHERE user_id=c.owner_id),
    (SELECT count(*)::integer FROM public.memory_operations WHERE user_id=c.owner_id),
    (SELECT count(*)::integer FROM public.memory_capture_events WHERE user_id=c.owner_id)] INTO v_before;
  FOR v_bad IN
    SELECT * FROM (VALUES
      ('cross_owner',c.foreign_owner_id,'别人的虚构事实','user','invalid exact event evidence'),
      ('cross_conversation',c.foreign_conversation_id,'另一对话的虚构事实','user','invalid exact event evidence'),
      ('assistant_source',c.assistant_id,'我自己说的虚构事实','user','invalid exact event evidence'),
      ('incorrect_source_role',c.reveal_id,'礼物是域名 lantern.example','assistant','invalid exact event evidence'),
      ('non_exact_evidence',c.reveal_id,'没有说过的购买行为','user','invalid exact event evidence'),
      ('unknown_source',extensions.gen_random_uuid(),'不存在的消息','user','invalid exact event evidence')
    ) AS invalid(test_name,source_id,evidence,source_role,expected_error)
  LOOP
    v_bad_sources := jsonb_build_array(
      jsonb_build_object('source_message_id',c.invalid_root_id,'source_role','user',
        'evidence_text','我准备了另一份虚构礼物','evidence_type','assertion'),
      jsonb_build_object('source_message_id',v_bad.source_id,'source_role',v_bad.source_role,
        'evidence_text',v_bad.evidence,'evidence_type','assertion'));
    v_rejected := false;
    BEGIN
      PERFORM public.xiaoc_memory_capture_event_verified(c.owner_id,c.conversation_id,c.invalid_root_id,c.reveal_id,
        v_bad_sources,'她准备了另一份虚构礼物。','relationship_memory','{}'::jsonb,
        'capture-event-v1:' || c.conversation_id || ':' || c.invalid_root_id::text);
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT;
      IF v_error IS DISTINCT FROM v_bad.expected_error THEN
        RAISE EXCEPTION 'FAIL: % unexpected error: %',v_bad.test_name,v_error;
      END IF;
      v_rejected := true;
    END;
    IF NOT v_rejected THEN RAISE EXCEPTION 'FAIL: % accepted',v_bad.test_name; END IF;
    SELECT ARRAY[(SELECT count(*)::integer FROM public.memory_items WHERE user_id=c.owner_id),
      (SELECT count(*)::integer FROM public.memory_provenance WHERE user_id=c.owner_id),
      (SELECT count(*)::integer FROM public.memory_operations WHERE user_id=c.owner_id),
      (SELECT count(*)::integer FROM public.memory_capture_events WHERE user_id=c.owner_id)] INTO v_after;
    IF v_after IS DISTINCT FROM v_before THEN RAISE EXCEPTION 'FAIL: % left residual rows',v_bad.test_name; END IF;
    INSERT INTO pg_temp.capture_test_results VALUES(v_bad.test_name,'PASS','expected rejection; zero residual Memory/provenance/operation/event');
  END LOOP;
END;
$tests$;
RESET ROLE;

-- Inject a failure specifically on the SECOND provenance insert. Transactional
-- DDL rolls back below; only this run's randomly generated owner/root is affected.
CREATE FUNCTION pg_temp.capture_test_fail_second_provenance()
RETURNS trigger LANGUAGE plpgsql AS $inject$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_temp.capture_test_context WHERE owner_id=NEW.user_id
    AND late_reveal_id=NEW.source_message_id) THEN
    RAISE EXCEPTION 'FICTIONAL_SECOND_PROVENANCE_FAILURE';
  END IF;
  RETURN NEW;
END;
$inject$;
CREATE TRIGGER staging_capture_test_fail_second_provenance
BEFORE INSERT ON public.memory_provenance
FOR EACH ROW EXECUTE FUNCTION pg_temp.capture_test_fail_second_provenance();

SET LOCAL ROLE service_role;
DO $atomicity$
DECLARE c record; v_rejected boolean := false; v_error text; v_sources jsonb;
BEGIN
  SELECT * INTO c FROM pg_temp.capture_test_context;
  PERFORM public.xiaoc_memory_event_decide(c.owner_id,c.conversation_id,c.late_root_id,c.late_root_id,'defer');
  v_sources := jsonb_build_array(
    jsonb_build_object('source_message_id',c.late_root_id,'source_role','user',
      'evidence_text','我准备了虚构的纪念卡','evidence_type','assertion'),
    jsonb_build_object('source_message_id',c.late_reveal_id,'source_role','user',
      'evidence_text','纪念卡名字是星灯','evidence_type','assertion'));
  BEGIN
    PERFORM public.xiaoc_memory_capture_event_verified(c.owner_id,c.conversation_id,c.late_root_id,c.late_reveal_id,
      v_sources,'她为我准备了名为星灯的纪念卡。','relationship_memory','{}'::jsonb,
      'capture-event-v1:' || c.conversation_id || ':' || c.late_root_id::text);
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_error=MESSAGE_TEXT;
    IF v_error <> 'FICTIONAL_SECOND_PROVENANCE_FAILURE' THEN RAISE EXCEPTION 'FAIL: unexpected late-write error: %',v_error; END IF;
    v_rejected := true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'FAIL: late-write injection did not fire'; END IF;
  IF (SELECT count(*) FROM public.memory_items WHERE user_id=c.owner_id) <> 1
    OR (SELECT count(*) FROM public.memory_provenance WHERE user_id=c.owner_id) <> 2
    OR (SELECT count(*) FROM public.memory_operations WHERE user_id=c.owner_id) <> 1
    OR NOT EXISTS(SELECT 1 FROM public.memory_capture_events WHERE user_id=c.owner_id
      AND event_start_message_id=c.late_root_id AND status='deferred' AND memory_id IS NULL
      AND last_message_id=c.late_root_id) THEN
    RAISE EXCEPTION 'FAIL: late failure did not roll back the whole capture';
  END IF;
  INSERT INTO pg_temp.capture_test_results VALUES('late_second_provenance_failure','PASS',
    'Memory + first provenance + completed operation rolled back; original deferred state preserved');
END;
$atomicity$;
RESET ROLE;

-- Force deferred integrity checks before reporting success, rather than skipping
-- them just because the outer transaction will roll back.
SET CONSTRAINTS ALL IMMEDIATE;

$validation_payload$;
    SELECT jsonb_agg(jsonb_build_object('test_name',test_name,'result',result,'detail',detail)
      ORDER BY test_name) INTO v_report FROM pg_temp.capture_test_results;
    IF jsonb_array_length(v_report) IS DISTINCT FROM 10 THEN
      RAISE EXCEPTION 'FAIL: expected ten validation results';
    END IF;
    -- Deliberate rollback of this subtransaction, including fixtures and trigger.
    RAISE EXCEPTION USING ERRCODE = 'ZC001', MESSAGE = 'VALIDATION_INTERNAL_ROLLBACK';
  EXCEPTION
    WHEN SQLSTATE 'ZC001' THEN
      NULL;
  END;
  RAISE NOTICE 'PASS: all 10 checks; all fictional fixtures and trigger rolled back. Results: %', v_report;
END;
$staging_validation$;
ROLLBACK;
