-- Requires supabase_album_moment_upload.sql. Additive; no old batch replay.
begin;
create table if not exists public.album_photo_comments (
  id uuid primary key default gen_random_uuid(),
  user_id text not null,
  asset_id bigint not null references public.album_assets(id) on delete cascade,
  batch_id uuid not null references public.album_moment_batches(id),
  content text not null check (char_length(content) between 1 and 120),
  created_at timestamptz not null default now(),
  unique(user_id,asset_id)
);
alter table public.album_photo_comments enable row level security;
revoke all on public.album_photo_comments from public,anon,authenticated;
grant select,insert,update,delete on public.album_photo_comments to service_role;
create or replace function public.apply_album_photo_comments(p_user_id text,p_batch_id uuid) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare b public.album_moment_batches; item jsonb; aid bigint; added integer:=0; n integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('album-moment:'||p_user_id,0));
  select * into b from public.album_moment_batches where id=p_batch_id and user_id=p_user_id for update;
  if not found or b.status<>'evaluated' then return jsonb_build_object('inserted',0); end if;
  if jsonb_typeof(b.result->'comments') is distinct from 'array' then return jsonb_build_object('inserted',0); end if;
  for item in select value from jsonb_array_elements(b.result->'comments') limit 3 loop
    if coalesce(item->>'asset_id','') !~ '^[0-9]{1,15}$' or jsonb_typeof(item->'content') is distinct from 'string' then continue; end if;
    aid:=(item->>'asset_id')::bigint;
    if not (aid=any(b.asset_ids)) or char_length(trim(item->>'content')) not between 1 and 120 then continue; end if;
    perform 1 from public.album_assets where id=aid and user_id=p_user_id and access_scope='shared' and enabled and archived_at is null for update;
    if not found then continue; end if;
    insert into public.album_photo_comments(user_id,asset_id,batch_id,content) values(p_user_id,aid,b.id,trim(item->>'content')) on conflict(user_id,asset_id) do nothing;
    get diagnostics n=row_count;
    added:=added+n;
  end loop;
  return jsonb_build_object('inserted',added);
end $$;
revoke all on function public.apply_album_photo_comments(text,uuid) from public,anon,authenticated;
grant execute on function public.apply_album_photo_comments(text,uuid) to service_role;
create or replace function public.claim_album_comment_batch(p_user_id text,p_mode text) returns jsonb
language plpgsql security invoker set search_path=public,pg_temp as $$
declare allow_post boolean:=true; ids bigint[]; b public.album_moment_batches; local_now timestamp:=now() at time zone 'Asia/Shanghai';
begin
  if p_mode not in ('shadow','live') then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended('album-moment:'||p_user_id,0));
  update public.album_moment_batches set status='unknown',updated_at=now(),result=jsonb_build_object('reason','interrupted_generation_no_retry')
    where user_id=p_user_id and status='processing' and created_at<now()-interval '15 minutes';
  if exists(select 1 from public.album_moment_batches where user_id=p_user_id and status in ('processing','evaluated')) then return null; end if;
  if local_now::time<time '08:30' or local_now::time>=time '23:30' then return null; end if;
  if (select count(*) from public.album_moment_batches where user_id=p_user_id and created_at>=(date_trunc('day',local_now) at time zone 'Asia/Shanghai'))>=3 then return null; end if;
  if (select count(*) from public.moment_candidates where user_id=p_user_id and status in ('pending','processing') and expires_at>now())>=3 then allow_post:=false; end if;
  if (select count(*) from public.moment_entries where user_id=p_user_id and author='小C' and created_at>=now()-interval '24 hours')>=3 then allow_post:=false; end if;
  if exists(select 1 from public.moment_entries where user_id=p_user_id and author='小C' and created_at>now()-interval '6 hours') then allow_post:=false; end if;
  update public.album_moment_events e set status='skipped' where e.user_id=p_user_id and e.status='pending' and not exists
    (select 1 from public.album_assets a where a.id=e.asset_id and a.user_id=e.user_id and a.access_scope='shared' and a.enabled and a.archived_at is null);
  if exists(select 1 from public.album_moment_events where user_id=p_user_id and status='pending' and created_at>now()-interval '5 minutes') then return null; end if;
  select array_agg(asset_id order by created_at,asset_id) into ids from
    (select asset_id,created_at from public.album_moment_events where user_id=p_user_id and status='pending' order by created_at,asset_id limit 3) q;
  if ids is null then return null; end if;
  if exists(select 1 from public.moment_candidates c where c.user_id=p_user_id and c.status in ('pending','processing','published') and exists
    (select 1 from unnest(ids) as q(aid) where c.image_key ~ ('"albumAssetId"\s*:\s*'||q.aid::text||'\s*[,}]')))
    or exists(select 1 from public.moment_entries m where m.user_id=p_user_id and m.author='小C' and exists
    (select 1 from unnest(ids) as q(aid) where m.image_key ~ ('"albumAssetId"\s*:\s*'||q.aid::text||'\s*[,}]'))) then allow_post:=false; end if;
  insert into public.album_moment_batches(user_id,asset_ids,mode) values(p_user_id,ids,p_mode) returning * into b;
  update public.album_moment_events set status='batched',batch_id=b.id where user_id=p_user_id and asset_id=any(ids) and status='pending';
  return to_jsonb(b)||jsonb_build_object('allow_post',allow_post);
end $$;

revoke all on function public.claim_album_comment_batch(text,text) from public,anon,authenticated;
grant execute on function public.claim_album_comment_batch(text,text) to service_role;
commit;
