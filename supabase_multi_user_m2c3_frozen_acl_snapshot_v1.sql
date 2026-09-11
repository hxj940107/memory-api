-- XiaoC M2C.3 frozen ACL snapshot query, version 1.
-- Catalog metadata only. No application rows are read.

begin transaction read only;

with acl_rows as (
  select
    case c.relkind
      when 'S' then 'sequence'
      when 'v' then 'view'
      when 'm' then 'materialized_view'
      when 'f' then 'foreign_table'
      when 'p' then 'partitioned_table'
      else 'table'
    end::text as object_type,
    n.nspname::text as schema_name,
    c.relname::text as object_name,
    owner_role.rolname::text as owner,
    grantor_role.rolname::text as grantor,
    coalesce(grantee_role.rolname, 'PUBLIC')::text as grantee,
    x.privilege_type::text as privilege,
    x.is_grantable::boolean as grantable
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  join pg_catalog.pg_roles owner_role on owner_role.oid = c.relowner
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      c.relacl,
      pg_catalog.acldefault(case when c.relkind = 'S' then 'S'::"char" else 'r'::"char" end, c.relowner)
    )
  ) x
  join pg_catalog.pg_roles grantor_role on grantor_role.oid = x.grantor
  left join pg_catalog.pg_roles grantee_role on grantee_role.oid = x.grantee
  where n.nspname = 'public'
    and c.relkind in ('r', 'p', 'S', 'v', 'm', 'f')

  union all

  select
    'function'::text as object_type,
    n.nspname::text as schema_name,
    (p.proname || '(' || pg_catalog.pg_get_function_identity_arguments(p.oid) || ')')::text as object_name,
    owner_role.rolname::text as owner,
    grantor_role.rolname::text as grantor,
    coalesce(grantee_role.rolname, 'PUBLIC')::text as grantee,
    x.privilege_type::text as privilege,
    x.is_grantable::boolean as grantable
  from pg_catalog.pg_proc p
  join pg_catalog.pg_namespace n on n.oid = p.pronamespace
  join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
  cross join lateral pg_catalog.aclexplode(
    coalesce(p.proacl, pg_catalog.acldefault('f'::"char", p.proowner))
  ) x
  join pg_catalog.pg_roles grantor_role on grantor_role.oid = x.grantor
  left join pg_catalog.pg_roles grantee_role on grantee_role.oid = x.grantee
  where n.nspname = 'public'

  union all

  select
    ('default_privilege_' || d.defaclobjtype)::text as object_type,
    n.nspname::text as schema_name,
    (owner_role.rolname || ':' || d.defaclobjtype)::text as object_name,
    owner_role.rolname::text as owner,
    grantor_role.rolname::text as grantor,
    coalesce(grantee_role.rolname, 'PUBLIC')::text as grantee,
    x.privilege_type::text as privilege,
    x.is_grantable::boolean as grantable
  from pg_catalog.pg_default_acl d
  join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
  join pg_catalog.pg_roles owner_role on owner_role.oid = d.defaclrole
  cross join lateral pg_catalog.aclexplode(d.defaclacl) x
  join pg_catalog.pg_roles grantor_role on grantor_role.oid = x.grantor
  left join pg_catalog.pg_roles grantee_role on grantee_role.oid = x.grantee
  where n.nspname = 'public'
    and d.defaclobjtype in ('r', 'S', 'f')
)
select *
from (
  select distinct
    object_type,
    schema_name,
    object_name,
    owner,
    grantor,
    grantee,
    privilege,
    grantable
  from acl_rows
) canonical_acl
order by
  object_type collate "C",
  schema_name collate "C",
  object_name collate "C",
  owner collate "C",
  grantor collate "C",
  grantee collate "C",
  privilege collate "C",
  grantable;

rollback;
