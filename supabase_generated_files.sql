insert into storage.buckets (id, name, public, file_size_limit)
values ('generated-files', 'generated-files', false, 10485760)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit;

-- Phase 1 的上传和签名下载都只经过持有 service role 的 XiaoC 后端。
-- App 不直接访问 Storage，因此不新增 authenticated/anon policy。
