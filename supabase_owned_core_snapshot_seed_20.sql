-- Exact, manually approved XiaoC Owned Core PIN set.
-- Run only after supabase_owned_core_snapshot.sql.

begin;

do $$
declare
  v_user_id constant text := 'user';
  v_policy constant text := 'xiaoc-owned-core-pin-v1';
  v_ids constant uuid[] := array[
    '07b1cb10-af92-522e-89f3-45c7de70e361'::uuid,
    '0c305248-3559-5a97-98f5-ddb0a1f36d2f'::uuid,
    '356939af-6c1c-5ab1-9652-8f418636f8bb'::uuid,
    '425a88c5-24c2-5519-9940-d1fefefa4070'::uuid,
    '6ac6c21a-f8af-51aa-b7b7-7685c99374b2'::uuid,
    '77b6e0fc-32c5-5860-a25c-0f6c6bebd1a3'::uuid,
    '8801fdb3-fbde-5046-81ba-b951942799e8'::uuid,
    '8d82ff74-01ef-5ba0-bca0-8f3eb2ec60e9'::uuid,
    '9d175961-0b7e-5cf1-a36b-2c0d1ee496bb'::uuid,
    'a7d1e8da-fcc1-5c35-8a53-8d4590a11d65'::uuid,
    'bcbb073c-f8ec-5d38-a5c7-f2593843321c'::uuid,
    'c20e0f5f-7069-57db-b922-9facbfc79fe1'::uuid,
    'c790b45d-4ae6-5356-9e23-2daac1a013a5'::uuid,
    'e70322cd-64f9-592a-abaf-4ca2a23db3fc'::uuid,
    'a71ced20-bced-585d-843d-66bb6e50c4a6'::uuid,
    'd4bf415e-3ec6-5e76-9502-aa9ffe537750'::uuid,
    'ed27f7af-74c7-5fa3-969c-ffa3d63157c3'::uuid,
    '020401fd-9517-5302-b813-335ecbfdf35b'::uuid,
    '5d3d9ee2-068b-50eb-a380-310989ac6b1a'::uuid,
    'bbac6900-fe5b-5bda-a1b7-b37a7e79e351'::uuid
  ];
  v_memory_id uuid;
  v_ordinal integer;
  v_active public.memory_pins%rowtype;
begin
  if cardinality(v_ids) <> 20
    or (select count(distinct target.memory_id)
        from unnest(v_ids) as target(memory_id)) <> 20 then
    raise exception 'Owned Core target must contain exactly 20 unique IDs';
  end if;

  if (select count(*) from public.memory_items i where i.user_id = v_user_id and i.id = any(v_ids)) <> 20 then
    raise exception 'Owned Core target contains a missing or wrong-owner Memory';
  end if;

  if exists (
    select 1 from public.memory_items i
    where i.user_id = v_user_id and i.id = any(v_ids)
      and not (
        i.origin_system = 'ombre_legacy'
        and i.provenance_status = 'legacy_unverified'
        and i.lifecycle_status = 'active'
        and i.retrieval_tier = 'low_authority'
        and i.authority_tier = 'legacy_limited'
      )
  ) then
    raise exception 'Owned Core target contains an ineligible historical Memory';
  end if;

  if (select count(*) from public.memory_items i where i.user_id = v_user_id and i.id = any(v_ids) and i.importance = 10) <> 14
    or (select count(*) from public.memory_items i where i.user_id = v_user_id and i.id = any(v_ids) and i.importance = 8) <> 6 then
    raise exception 'Owned Core target importance distribution differs from manual approval';
  end if;

  -- Release active ordinals first; every mutation still goes through the protected PIN RPC.
  for v_active in
    select * from public.memory_pins
    where user_id = v_user_id and scope = 'core' and pin_status = 'active'
    order by ordinal, memory_id
  loop
    perform public.xiaoc_memory_set_pin(
      v_user_id, v_active.memory_id, false, v_active.ordinal, v_policy,
      'owned-core-v1-unpin-' || v_active.memory_id::text
    );
  end loop;

  for v_ordinal in 1..cardinality(v_ids) loop
    v_memory_id := v_ids[v_ordinal];
    perform public.xiaoc_memory_set_pin(
      v_user_id, v_memory_id, true, v_ordinal - 1, v_policy,
      'owned-core-v1-pin-' || v_memory_id::text
    );
  end loop;

  if (select count(*) from public.memory_pins p
      where p.user_id = v_user_id and p.scope = 'core' and p.pin_status = 'active') <> 20
    or exists (
      select 1 from public.memory_pins p
      where p.user_id = v_user_id and p.scope = 'core' and p.pin_status = 'active'
        and not (p.memory_id = any(v_ids))
    )
    or exists (
      select 1 from unnest(v_ids) as target(memory_id)
      where not exists (
        select 1 from public.memory_pins p
        where p.user_id = v_user_id and p.scope = 'core'
          and p.pin_status = 'active' and p.memory_id = target.memory_id
      )
    ) then
    raise exception 'Owned Core final active PIN set does not exactly match the approved 20 IDs';
  end if;
end;
$$;

commit;

select
  p.ordinal,
  p.memory_id,
  i.category,
  i.importance,
  length(i.canonical_content) as canonical_content_length,
  i.content_hash,
  p.pin_status
from public.memory_pins p
join public.memory_items i on i.user_id = p.user_id and i.id = p.memory_id
where p.user_id = 'user' and p.scope = 'core' and p.pin_status = 'active'
order by p.ordinal, p.memory_id;
