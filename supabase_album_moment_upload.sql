-- Additive, service-role-only. No historical backfill; only future INSERTs enqueue.
begin;
create table if not exists public.album_moment_batches (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  asset_ids bigint[] not null check (cardinality(asset_ids) between 1 and 3),
  mode text not null check (mode in ('shadow','live')),
  status text not null default 'processing' check (status in ('processing','evaluated','shadow','declined','created','skipped','unknown')),
  result jsonb,
  candidate_id bigint references public.moment_candidates(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.album_moment_events (
  asset_id bigint primary key references public.album_assets(id) on delete cascade,
  user_id text not null,
  batch_id uuid references public.album_moment_batches(id),
  status text not null default 'pending' check (status in ('pending','batched','skipped')),
  created_at timestamptz not null default now()
);
create index if not exists album_moment_events_pending_idx on public.album_moment_events(user_id,created_at) where status='pending';
create index if not exists album_moment_batches_owner_idx on public.album_moment_batches(user_id,created_at desc);
alter table public.album_moment_batches enable row level security;
alter table public.album_moment_events enable row level security;
revoke all on public.album_moment_batches, public.album_moment_events from public,anon,authenticated;
grant select,insert,update,delete on public.album_moment_batches, public.album_moment_events to service_role;

create or replace function public.album_moment_enqueue() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.access_scope='shared' and new.enabled and new.archived_at is null then
    insert into public.album_moment_events(asset_id,user_id) values(new.id,new.user_id) on conflict do nothing;
  end if;
  return new;
end $$;
drop trigger if exists album_moment_enqueue_trigger on public.album_assets;
create trigger album_moment_enqueue_trigger after insert on public.album_assets for each row execute function public.album_moment_enqueue();

create or replace function public.album_moment_revoke() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.access_scope<>'shared' or not new.enabled or new.archived_at is not null then
    update public.album_moment_events set status='skipped' where asset_id=new.id and status='pending';
    update public.moment_candidates set status='skipped',skip_reason='相册来源已停止授权',updated_at=now()
      where user_id=new.user_id and source_type='album_upload' and status in ('pending','processing')
      and image_key ~ ('"albumAssetId"\s*:\s*'||new.id::text||'\s*[,}]');
  end if;
  return new;
end $$;
drop trigger if exists album_moment_revoke_trigger on public.album_assets;
create trigger album_moment_revoke_trigger after update of access_scope,enabled,archived_at on public.album_assets for each row execute function public.album_moment_revoke();

-- Reserve generation allowance BEFORE any external call. A reserved/unknown batch
-- consumes one allowance; never retry uncertain paid calls.
create or replace function public.claim_album_moment_batch(p_user_id text,p_mode text) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare ids bigint[]; b public.album_moment_batches; local_now timestamp:=now() at time zone 'Asia/Shanghai';
begin
  if p_mode not in ('shadow','live') then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('album-moment:'||p_user_id,0));
  update public.album_moment_batches set status='unknown',updated_at=now(),result=jsonb_build_object('reason','interrupted_generation_no_retry')
    where user_id=p_user_id and status='processing' and created_at<now()-interval '15 minutes';
  if exists(select 1 from public.album_moment_batches where user_id=p_user_id and status in ('processing','evaluated')) then return null; end if;
  if local_now::time<time '08:30' or local_now::time>=time '23:30' then return null; end if;
  if (select count(*) from public.album_moment_batches where user_id=p_user_id and created_at>=(date_trunc('day',local_now) at time zone 'Asia/Shanghai'))>=3 then return null; end if;
  if (select count(*) from public.moment_candidates where user_id=p_user_id and status in ('pending','processing') and expires_at>now())>=3 then return null; end if;
  if (select count(*) from public.moment_entries where user_id=p_user_id and author='小C' and created_at>=now()-interval '24 hours')>=3 then return null; end if;
  if exists(select 1 from public.moment_entries where user_id=p_user_id and author='小C' and created_at>now()-interval '6 hours') then return null; end if;
  update public.album_moment_events e set status='skipped' where e.user_id=p_user_id and e.status='pending' and not exists
    (select 1 from public.album_assets a where a.id=e.asset_id and a.user_id=e.user_id and a.access_scope='shared' and a.enabled and a.archived_at is null);
  if exists(select 1 from public.album_moment_events where user_id=p_user_id and status='pending' and created_at>now()-interval '5 minutes') then return null; end if;
  -- Exact photo reuse, regardless of source path.
  update public.album_moment_events e set status='skipped' where e.user_id=p_user_id and e.status='pending' and (
    exists(select 1 from public.moment_candidates c where c.user_id=p_user_id and c.status in ('pending','processing','published') and c.image_key ~ ('"albumAssetId"\s*:\s*'||e.asset_id::text||'\s*[,}]')) or
    exists(select 1 from public.moment_entries m where m.user_id=p_user_id and m.author='小C' and m.image_key ~ ('"albumAssetId"\s*:\s*'||e.asset_id::text||'\s*[,}]')));
  select array_agg(asset_id order by created_at,asset_id) into ids from
    (select asset_id,created_at from public.album_moment_events where user_id=p_user_id and status='pending' order by created_at,asset_id limit 3) q;
  if ids is null then return null; end if;
  insert into public.album_moment_batches(user_id,asset_ids,mode) values(p_user_id,ids,p_mode) returning * into b;
  update public.album_moment_events set status='batched',batch_id=b.id where user_id=p_user_id and asset_id=any(ids) and status='pending';
  return to_jsonb(b);
end $$;

-- Finalization is recoverable without another model call. Both candidate insert
-- and batch completion are in the same transaction.
create or replace function public.finish_album_moment_batch(p_user_id text,p_batch_id uuid,p_live boolean) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare b public.album_moment_batches; a public.album_assets; cid bigint; outcome text; normalized_text text;
begin
  perform pg_advisory_xact_lock(hashtextextended('album-moment:'||p_user_id,0));
  select * into b from public.album_moment_batches where id=p_batch_id and user_id=p_user_id for update;
  if not found or b.status<>'evaluated' then return jsonb_build_object('status','not_evaluated'); end if;
  outcome:='declined';
  if b.result->>'shouldPost'='true' then
    select * into a from public.album_assets where id=(b.result->>'asset_id')::bigint and user_id=p_user_id and id=any(b.asset_ids)
      and access_scope='shared' and enabled and archived_at is null for update;
    if not found then outcome:='skipped';
    elsif b.mode='shadow' then outcome:='shadow';
    elsif p_live is not true then outcome:='skipped';
    else
      normalized_text:=regexp_replace(lower(b.result->>'text'),'[[:space:][:punct:]，。！？、～…]','','g');
      if (select count(*) from public.moment_candidates where user_id=p_user_id and status in ('pending','processing') and expires_at>now())>=3
        or exists(select 1 from public.moment_candidates where user_id=p_user_id and status in ('pending','processing','published') and (
          image_key ~ ('"albumAssetId"\s*:\s*'||a.id::text||'\s*[,}]') or regexp_replace(lower(text),'[[:space:][:punct:]，。！？、～…]','','g')=normalized_text))
        or exists(select 1 from public.moment_entries where user_id=p_user_id and author='小C' and (
          image_key ~ ('"albumAssetId"\s*:\s*'||a.id::text||'\s*[,}]') or regexp_replace(lower(text),'[[:space:][:punct:]，。！？、～…]','','g')=normalized_text))
      then outcome:='skipped';
      else
        insert into public.moment_candidates(user_id,text,image_key,priority,share_mode,event_time,publish_after,expires_at,consideration_mode,source_type,source_ref,narrative_permission)
          values(p_user_id,b.result->>'text',jsonb_build_object('albumAssetId',a.id,'aspectRatio',a.aspect_ratio)::text,1,'delayed',b.created_at,
          now()+interval '45 minutes'+random()*interval '135 minutes',now()+interval '24 hours','autonomous','album_upload',b.id::text,b.result->>'narrative_permission') returning id into cid;
        outcome:='created';
      end if;
    end if;
  end if;
  update public.album_moment_batches set status=outcome,candidate_id=cid,updated_at=now() where id=b.id;
  return jsonb_build_object('status',outcome,'candidate_id',cid);
end $$;

-- Last database-side authorization check protects against revocation races and
-- retry-after-insert duplication. Applies only to this new source.
create unique index if not exists album_upload_moment_once_idx on public.moment_entries(user_id,source_ref) where source_type='album_upload';
create or replace function public.check_album_upload_moment() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare aid bigint;
begin
  aid:=substring(new.image_key from '"albumAssetId"\s*:\s*([0-9]+)')::bigint;
  if aid is null then
    if new.source_type='album_upload' then raise exception 'ALBUM_UPLOAD_IMAGE_REQUIRED'; end if;
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('album-moment:'||new.user_id,0));
  if new.source_type='album_upload' then
    perform 1 from public.album_assets where id=aid and user_id=new.user_id and access_scope='shared' and enabled and archived_at is null for update;
    if not found then raise exception 'ALBUM_UPLOAD_ASSET_REVOKED'; end if;
  end if;
  if exists(select 1 from public.moment_entries where user_id=new.user_id and author='小C'
    and (new.source_type='album_upload' or source_type='album_upload')
    and image_key ~ ('"albumAssetId"\s*:\s*'||aid::text||'\s*[,}]')) then raise exception 'ALBUM_UPLOAD_PHOTO_ALREADY_PUBLISHED'; end if;
  return new;
end $$;
drop trigger if exists check_album_upload_moment_trigger on public.moment_entries;
create trigger check_album_upload_moment_trigger before insert on public.moment_entries for each row execute function public.check_album_upload_moment();
create or replace function public.check_album_upload_candidate() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare aid bigint;
begin
  aid:=substring(new.image_key from '"albumAssetId"\s*:\s*([0-9]+)')::bigint;
  if aid is null then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('album-moment:'||new.user_id,0));
  if exists(select 1 from public.moment_candidates where user_id=new.user_id and status in ('pending','processing','published')
    and (new.source_type='album_upload' or source_type='album_upload')
    and image_key ~ ('"albumAssetId"\s*:\s*'||aid::text||'\s*[,}]'))
    or exists(select 1 from public.moment_entries where user_id=new.user_id and author='小C'
    and (new.source_type='album_upload' or source_type='album_upload')
    and image_key ~ ('"albumAssetId"\s*:\s*'||aid::text||'\s*[,}]')) then raise exception 'ALBUM_UPLOAD_DUPLICATE_CANDIDATE'; end if;
  return new;
end $$;
drop trigger if exists check_album_upload_candidate_trigger on public.moment_candidates;
create trigger check_album_upload_candidate_trigger before insert on public.moment_candidates for each row execute function public.check_album_upload_candidate();
revoke all on function public.album_moment_enqueue(),public.album_moment_revoke(),public.check_album_upload_moment(),public.check_album_upload_candidate() from public,anon,authenticated;
revoke all on function public.claim_album_moment_batch(text,text),public.finish_album_moment_batch(text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.claim_album_moment_batch(text,text),public.finish_album_moment_batch(text,uuid,boolean) to service_role;
commit;
