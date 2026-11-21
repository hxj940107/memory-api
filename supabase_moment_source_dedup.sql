-- Deterministic source deduplication; no historical rows are changed.
BEGIN;

create or replace function public.check_album_upload_candidate() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare aid bigint; mid text;
begin

  aid:=substring(new.image_key from '"albumAssetId"\s*:\s*([0-9]+)')::bigint;
  mid:=nullif(new.source_message_id::text,'');
  -- Retain the existing lock namespace so album finalization and all entrances serialize.
  perform pg_advisory_xact_lock(hashtextextended('album-moment:'||new.user_id,0));
  if new.source_type='album_upload' then
    if aid is null then raise exception 'ALBUM_UPLOAD_IMAGE_REQUIRED'; end if;
    perform 1 from public.album_assets where id=aid and user_id=new.user_id
      and access_scope='shared' and enabled and archived_at is null for update;
    if not found then raise exception 'ALBUM_UPLOAD_ASSET_REVOKED'; end if;
  end if;
  if exists(select 1 from public.moment_candidates p where p.user_id=new.user_id
      and p.status in ('pending','processing','published')
      and (p.status='published' or p.expires_at > now())
      and ((aid is not null and substring(p.image_key from '"albumAssetId"\s*:\s*([0-9]+)')::bigint=aid)
        or (mid is not null and p.source_message_id::text=mid))) then
      raise exception 'MOMENT_DUPLICATE_SOURCE';
    end if;
if exists(select 1 from public.moment_entries p where p.user_id=new.user_id and p.author='小C'
      and ((aid is not null and substring(p.image_key from '"albumAssetId"\s*:\s*([0-9]+)')::bigint=aid)
        or (mid is not null and p.source_message_id::text=mid))) then
      raise exception 'MOMENT_DUPLICATE_SOURCE';
    end if;
  return new;
end $$;

create or replace function public.check_album_upload_moment() returns trigger
language plpgsql security definer set search_path=public,pg_temp as $$
declare aid bigint; mid text;
begin
  if new.author <> '小C' then return new; end if;
  aid:=substring(new.image_key from '"albumAssetId"\s*:\s*([0-9]+)')::bigint;
  mid:=nullif(new.source_message_id::text,'');
  -- Retain the existing lock namespace so album finalization and all entrances serialize.
  perform pg_advisory_xact_lock(hashtextextended('album-moment:'||new.user_id,0));
  if new.source_type='album_upload' then
    if aid is null then raise exception 'ALBUM_UPLOAD_IMAGE_REQUIRED'; end if;
    perform 1 from public.album_assets where id=aid and user_id=new.user_id
      and access_scope='shared' and enabled and archived_at is null for update;
    if not found then raise exception 'ALBUM_UPLOAD_ASSET_REVOKED'; end if;
  end if;
  if exists(select 1 from public.moment_entries p where p.user_id=new.user_id and p.author='小C'
      and ((aid is not null and substring(p.image_key from '"albumAssetId"\s*:\s*([0-9]+)')::bigint=aid)
        or (mid is not null and p.source_message_id::text=mid))) then
      raise exception 'MOMENT_DUPLICATE_SOURCE';
    end if;
  return new;
end $$;

-- Reuse existing trigger names; also install them if the older migration omitted them.

drop trigger if exists check_album_upload_candidate_trigger on public.moment_candidates;

create trigger check_album_upload_candidate_trigger before insert on public.moment_candidates for each row execute function public.check_album_upload_candidate();

drop trigger if exists check_album_upload_moment_trigger on public.moment_entries;

create trigger check_album_upload_moment_trigger before insert on public.moment_entries for each row execute function public.check_album_upload_moment();

revoke all on function public.check_album_upload_candidate(), public.check_album_upload_moment() from public,anon,authenticated;

COMMIT;
