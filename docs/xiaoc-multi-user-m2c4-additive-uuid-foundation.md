# XiaoC Multi-user M2C.4 — Additive UUID Foundation

> Status: COMPLETE — PRODUCTION APPLIED AND VALIDATED
>
> Scope: empty Auth-backed tenant root plus nullable UUID ownership foundation
> for the five legacy Core tables. This checkpoint does not authorize
> M2C.5. M2C.4 is complete; M2C.5 has not started.

## Production completion evidence

M2C.4 was applied to Production as the approved single-transaction additive
foundation. No companion root row or UUID backfill was created.

- Forward: `PASS`
- Validation: `11/11 PASS`
- Post-apply schema snapshot: `118` rows
- Post-apply snapshot SHA-256:
  `1E52422B4FFD118E31FCF75D1F5A8AA4C64E97F776E7D7F1102F184F41193FC5`
- Pre-M2C.4 baseline `EXCEPT` post-apply: `0`
- Post-apply `EXCEPT` pre-M2C.4 baseline: `23`
- Approved-change allowlist: `PASS`
- Rollback executed: `NO`
- Standalone rollback deadline: still open, but only until M2C.5 begins and
  only while the rollback guard remains satisfied
- `companion_instances`: present and empty
- All five `user_uuid` bridges: present, nullable, default-free, and entirely
  `NULL`
- Legacy columns, primary/unique keys, runtime ownership path, RLS, and ACL:
  unchanged

The 23 snapshot additions are exactly five UUID columns, five `NOT VALID`
root FKs, five tenant-qualified unique constraints, the five backing indexes
created by those unique constraints, and three explicit tenant access indexes.

## 1. Confirmed Production baseline

The schema was re-read from the Production catalog using metadata-only SQL.
No application rows or private text were selected.

- `conversations.conversation_id` and legacy `user_id` are `text`; the current
  primary key is global `conversation_id`.
- `messages.id` is `uuid`; `conversation_id` and legacy `user_id` are nullable
  `text`; there is no conversation FK.
- `memories.id` is `uuid` and legacy `user_id` is nullable `text`.
- `conversation_summary.id` is `bigint`, `conversation_id` is non-null `text`
  with a global unique constraint, and the table has no owner column.
- `user_state.user_id` and `last_conversation_id` are `text`; legacy
  `user_id` remains the primary key.
- All five tables still have RLS disabled. M2C.3 ordinary-role containment is
  the required ACL baseline.
- `conversations` has no `updated_at`; its additive tenant history index uses
  existing `created_at` rather than introducing a behavioral timestamp.

## 2. Exact additive schema

### 2.1 Tenant root

Create `public.companion_instances` empty with:

- `user_id uuid primary key` referencing `auth.users(id)` with restrictive
  update/delete behavior;
- lifecycle state constrained to `provisioning`, `active`, `suspended`, or
  `pending_deletion`;
- a non-secret integer foundation version;
- created/updated timestamps.

M2C.4 creates no Auth user and no companion row. There is no automatic Auth
trigger. The first approved root row belongs to M2C.5.

### 2.2 UUID bridge ownership

Add nullable, default-free `user_uuid uuid` to:

- `conversations`
- `messages`
- `memories`
- `conversation_summary`
- `user_state`

Each bridge receives a `NOT VALID` FK to
`companion_instances(user_id)`. This avoids a historical-table validation scan
while immediately rejecting any future non-null UUID without a root. The
columns remain non-authoritative and empty; M2C.4 never derives UUIDs from the
legacy literal `"user"` or any other cohort.

### 2.3 Tenant-qualified key foundation

Create full unique constraints suitable as future composite-FK targets:

- `conversations (user_uuid, conversation_id)`
- `messages (user_uuid, id)`
- `memories (user_uuid, id)`
- `conversation_summary (user_uuid, conversation_id)`
- `user_state (user_uuid)`

The Summary key adds the missing owner dimension for future Summary/Core
lookups and upserts. The existing global Summary uniqueness and all existing
primary keys remain unchanged for Private XiaoC compatibility.

Create tenant access indexes:

- `conversations (user_uuid, created_at desc, conversation_id)`
- `messages (user_uuid, conversation_id, created_at, id)`
- `memories (user_uuid, created_at desc, id)`

M2C.4 does not add the cross-table composite FKs from messages, Summary, or
state to conversations. Those constraints require approved backfill and orphan
quarantine, and therefore remain M2C.6 work. Their required referenced unique
keys are established here.

## 3. Compatibility and exclusions

- Keep every legacy `user_id` column, type, nullability, key, and runtime path.
- Do not populate `user_uuid` and do not map `user`, `small_c`, `test`, unknown,
  or orphan rows.
- Do not change Summary/Core bytes, checkpoints, source bucket IDs, or upsert
  behavior.
- Do not enable or force RLS and do not add policies.
- Do not change grants, RPCs, Storage, application code, Ombre, Auth sessions,
  deployments, or the 12/12 API function set.
- Do not create a Public App or enter M2C.5.

## 4. Package

- `supabase_multi_user_m2c4_additive_uuid_foundation.sql`: one transactional
  forward package with object/type/RLS/M2C.3 baseline guards.
- `supabase_multi_user_m2c4_additive_uuid_validation.sql`: read-only catalog,
  empty-bridge, ACL, RLS, legacy-key, and service-lane validation.
- `supabase_multi_user_m2c4_additive_uuid_rollback.sql`: exact foundation
  removal guarded by zero companion rows and zero non-null bridge values.
- `tests/multi-user-m2c4-additive-uuid-foundation.test.js`: static scope,
  compatibility, symmetry, and rollback-safety checks.

## 5. Rollback contract

Rollback is allowed only before M2C.5 and only when:

- `companion_instances` has zero rows;
- all five `user_uuid` columns contain zero non-null values;
- no later object depends on the M2C.4 keys or columns.

The rollback transaction removes the three access indexes, five unique
constraints, five root FKs, five UUID bridge columns, and empty tenant root. It
uses no `CASCADE`. Any later dependency makes the rollback fail closed rather
than deleting unreviewed work.

The point of no longer using this rollback is the first M2C.5 root insertion or
UUID backfill. From that point, rollback requires the separate M2C.5 manifest
and contract.

## 6. Production preflight prerequisites

Before a separately authorized Production apply:

1. Re-read the five-table columns, constraints, indexes, RLS flags, and grants;
   require the forward preflight baseline exactly.
2. Confirm M2C.3 remains active: ordinary roles have zero privileges on the
   five Core tables and service-role Core access remains intact.
3. Confirm `companion_instances`, all five `user_uuid` columns, and every
   proposed object name are absent.
4. Capture a schema/ACL snapshot and exact rollback deadline. Free Plan has no
   scheduled backup/PITR, so accept this only as a schema-only additive change
   with empty-column rollback; do not extend that acceptance to M2C.5 data work.
5. Review lock duration for building five small unique constraints and three
   indexes against current table sizes; schedule a bounded quiet window.
6. Record Private XiaoC chat, history, Summary/Core, Memory, preferences, and
   worker smoke baselines.
7. After apply, require every validation row PASS, exact catalog allowlist
   match, zero companion/UUID rows, unchanged legacy keys/RLS, and Private
   XiaoC smoke PASS.

## 7. Stop conditions

STOP on schema/type/name drift, any pre-existing partial foundation object,
unexpected ordinary-role Core access, RLS drift, lock timeout, any non-null
UUID value, any companion row, validation failure, catalog change outside the
allowlist, or Private XiaoC regression.

**M2C.4 COMPLETE. M2C.5 NOT STARTED.**
