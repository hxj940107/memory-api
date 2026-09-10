# XiaoC Multi-user M2A — Production Supabase Read-only Discovery

> Snapshot date: 2026-09-10 (Asia/Shanghai)
>
> Scope: sanitized, read-only Production metadata and ownership discovery.
>
> No private message, Memory, Diary, Treehole, Moment, attachment, or prompt content was selected or recorded.

## 1. Discovery status

**PASS — Production catalog access completed; sufficient to enter M2B design.**

Production was queried through the configured Supabase REST, Auth Admin, and Storage metadata APIs using a server-side credential. This confirmed the exposed `public` schema shape, exposed RPC names/arguments, Auth user count, Storage bucket configuration, top-level object ownership metadata, and aggregate owner counts.

On the Mac, an authenticated Supabase Dashboard SQL Editor session provided read-only access to `pg_catalog` and `information_schema`. Catalog and aggregate relationship queries were run without selecting private content, identifiers, object names, emails, tokens, or secrets. This closed the prior PK/FK/index, RLS/policy, grants/default privileges, RPC security, trigger, view, Storage-policy, and aggregate orphan unknowns.

## 2. Confirmed Production facts

### 2.1 Auth

- Supabase Auth contains **0 users**.
- Therefore no existing business row is currently owned by an `auth.users.id` account.
- Existing owner labels are application strings, not verified Auth principals.

Status: **P0_BLOCKER**.

### 2.2 Exposed schema and ownership columns

- `conversation_summary` has no `user_id`/`user_uuid` column. It contains 6 rows; all 6 contain a Summary and 2 contain a Core snapshot.
- `messages.user_id`, `messages.conversation_id`, and `conversations.user_id` are nullable according to Production OpenAPI. Current rows have no null owner/conversation, but the schema permits unsafe future writes.
- `memories.user_id` is also nullable.
- `user_state`, Diary, Treehole, Moments, Proactive, Shared Context, Album, observability, and XiaoC Memory Engine tables expose a required `user_id` column.
- `shared_contexts` currently has 0 rows and no conversation is currently bound to one, so existing-data cross-owner binding cannot yet be observed.

### 2.3 Existing owner distribution

Only aggregate counts were read. Actual non-legacy owner strings were not recorded in this document.

| Table | Total | `user_id="user"` | Other non-null owner labels | Null owner |
| --- | ---: | ---: | ---: | ---: |
| messages | 7,111 | 3,838 | 3,273 | 0 |
| conversations | 55 | 6 | 49 | 0 |
| user_state | 2 | 1 | 1 | 0 |
| memories | 31 | 28 | 3 | 0 |
| diary_entries | 7 | 7 | 0 | 0 |
| treehole_entries | 43 | 43 | 0 | 0 |
| moment_entries | 27 | 27 | 0 | 0 |
| moment_comments | 27 | 27 | 0 | 0 |
| moment_candidates | 12 | 12 | 0 | 0 |
| moment_xiaoc_activity | 8 | 8 | 0 | 0 |
| moment_interaction_state | 1 | 1 | 0 | 0 |
| moment_check_audit | 99 | 99 | 0 | 0 |
| xiaoc_proactive_tasks | 1,217 | 1,216 | 1 | 0 |
| shared_contexts | 0 | 0 | 0 | 0 |
| album_assets | 22 | 22 | 0 | 0 |
| treehole_execution_audit | 0 | 0 | 0 | 0 |
| background_worker_run_audit | 34 | 34 | 0 | 0 |
| memory_items | 150 | 150 | 0 | 0 |
| memory_provenance / relations / embeddings / pins | 0 | 0 | 0 | 0 |
| memory_import_runs / plan items | 1 / 150 | 1 / 150 | 0 | 0 |
| legacy_memory_map | 150 | 150 | 0 | 0 |

This is a migration-critical finding: the legacy data set is not uniformly owned by `"user"`. The other owner labels must be classified as real legacy production data, historical prototype data, tests, imports, or stale rows before any UUID backfill. They must not be automatically merged into the first private account.

### 2.4 RPC trust boundary

Production exposes 23 RPC endpoints. Most Memory Engine mutation/retrieval RPCs accept `p_user_id`, including capture, manual confirmation, consolidation, relations, pins, embeddings, imports, lexical/semantic retrieval, relation retrieval, and operation completion.

Other exposed RPCs with caller-provided ownership include:

- `claim_moment_check(p_user_id, p_conversation_id, ...)`
- `patch_client_preferences(p_user_id, p_patch)`

`initialize_core_memory_snapshot` is worse: it accepts only `p_conversation_id` and snapshot material, with no tenant identity at all.

Whether anon/authenticated can execute each RPC is still unknown because grants were not available from REST metadata. Regardless, any ordinary-user RPC that treats `p_user_id` as authority is incompatible with the M1 contract.

### 2.5 Storage

| Bucket | Public | Top-level entries | Entries with `owner_id` | Confirmed issue | Status |
| --- | --- | ---: | ---: | --- | --- |
| `chat-images` | Yes | 8 | 0 | Public objects; no Auth ownership; non-UUID top-level paths | P0_BLOCKER |
| `moment-images` | Yes | 1 | 0 | Public; legacy `user` prefix | P0_BLOCKER |
| `album-images` | No | 2 | 0 | Private but service-created/unowned; legacy `user` and `profiles` prefixes | P0_BLOCKER |
| `generated-files` | No | 1 | 0 | Private but service-created/unowned; legacy `user` prefix | P0_BLOCKER |
| `xiaoc-memory-backups` | No | 1 | 0 | Private backup bucket; no Auth owner; admin/service-only boundary unverified | NEEDS_HARDENING |

The Storage API returned no `owner_id` for any observed top-level entry. This is consistent with server/service-created objects and means Auth ownership cannot currently enforce tenant isolation. Nested object totals and policy expressions remain unknown.

## 3. Ownership matrix

Legend:

- `SAFE`: Production evidence establishes a complete tenant boundary.
- `NEEDS_HARDENING`: useful owner structure exists, but it is not yet an Auth/RLS boundary.
- `P0_BLOCKER`: a second production account could cause collision, unauthorized access, or prompt/data contamination.
- `UNKNOWN`: current discovery channel cannot establish the property.

| Domain / object | Status | Production evidence / reason |
| --- | --- | --- |
| Supabase Auth | P0_BLOCKER | 0 Auth users; no immutable authenticated owner exists. |
| `conversation_summary` / Core | P0_BLOCKER | No owner column; 6 summaries and 2 Core snapshots keyed without tenant identity. |
| `messages` | P0_BLOCKER | Owner exists but is nullable; mixed legacy owner labels; RLS/grants unknown. |
| `conversations` | P0_BLOCKER | Owner exists but is nullable; mixed legacy owner labels; tenant FK/unique constraints unknown. |
| `user_state` / preferences / push | P0_BLOCKER | Required owner label, but not Auth-backed; mixed owners; RPC accepts `p_user_id`. |
| legacy `memories` | P0_BLOCKER | Owner is nullable; mixed owner labels; Ombre remains authoritative outside this table. |
| Diary | NEEDS_HARDENING | Required owner and all rows use legacy owner; RLS/FKs/grants unknown. |
| Treehole | NEEDS_HARDENING | Required owner and all rows use legacy owner; RLS/FKs/grants unknown. |
| Moments / comments / candidates / activity / interaction | NEEDS_HARDENING | Required owner labels are present; cross-table tenant FKs and RLS unknown. |
| Proactive tasks | P0_BLOCKER | Required owner, but no Auth principal; mixed owners; scheduler/service boundary not DB-enforced. |
| Shared Context | NEEDS_HARDENING | Required owner and no data yet; conversation-to-context same-tenant constraint unknown. |
| Album metadata | NEEDS_HARDENING | Required legacy owner; Storage objects have no Auth owner. |
| XiaoC Memory Engine tables | NEEDS_HARDENING | Strong required owner shape is present and current rows are legacy-owned; actual RLS/grants/function security still unverified. |
| Observability tables | NEEDS_HARDENING | Required owner labels; privacy-safe shape expected, but grants/retention RPC security unverified. |
| RPCs with `p_user_id` | P0_BLOCKER | Exposed caller-controlled tenant parameter; execute grants/security mode unknown. |
| Core initialization RPC | P0_BLOCKER | No tenant parameter; conversation-only identity. |
| public image buckets | P0_BLOCKER | `chat-images` and `moment-images` are public and lack Auth ownership. |
| private media buckets | P0_BLOCKER | Private flag exists, but objects are unowned and service signing boundary is the sole protection. |
| backup bucket | NEEDS_HARDENING | Private, but owner/policies/admin scope need catalog review. |
| PK/FK/unique/index definitions | P0_BLOCKER | Catalog confirms globally keyed Chat/Summary/content rows and sparse tenant FKs; only the native Memory Engine consistently uses composite `(user_id, id)` integrity. |
| RLS flags and policy expressions | P0_BLOCKER | 5/27 public tables have RLS disabled; the other 22 have RLS enabled but no public-table policy. Storage has one public INSERT policy for `chat-images`. |
| grants/default privileges/BYPASSRLS roles | P0_BLOCKER | `anon`/`authenticated` receive broad public table/function/sequence privileges by default; `service_role` has `BYPASSRLS`. |
| function SECURITY DEFINER/owner/search_path/execute | P0_BLOCKER | 30 public functions: 22 SECURITY DEFINER; service-only tenant RPCs are bounded by grants, but one zero-argument SECURITY DEFINER function is executable by anon/authenticated. |
| triggers and views | NEEDS_HARDENING | 14 public triggers and 4 Storage triggers; no public/Storage views or materialized views. Trigger functions use explicit search paths. |

No user-data domain is marked `SAFE` yet. This does not mean every existing implementation is broken in the current single-user deployment; it means Production evidence does not establish a safe boundary for admitting a second account.

## 4. Confirmed P0 blockers

1. No Supabase Auth account or immutable Auth UUID exists.
2. `conversation_summary` and Core snapshots have no owner column.
3. Existing owner labels are mixed and none map to an Auth account.
4. `messages`, `conversations`, and legacy `memories` permit null owner values.
5. Production exposes many RPCs whose tenant is supplied as `p_user_id`; execute grants remain unknown.
6. Core initialization is conversation-only.
7. Public chat and Moment image buckets cannot provide private tenant isolation.
8. Private media objects have no Auth `owner_id`; current safety depends entirely on unrestricted server code correctly checking legacy labels.
9. Five core public tables have RLS disabled, while broad anon/authenticated grants remain present.
10. RLS-enabled public tables have no policies, so authenticated access is fail-closed today but not tenant-capable.
11. `check_pending_moments_for_xiaoc()` is SECURITY DEFINER and executable by anon/authenticated.
12. Storage allows public INSERT into `chat-images` based only on `bucket_id`.
13. Cross-domain relationships are mostly not enforced by tenant-qualified FKs; aggregate discovery found existing orphan references.

## 5. Production catalog findings

### 5.1 Keys, FKs, unique constraints, and indexes

- Catalog inventory: **27 public tables**, **8 Storage tables**, **216 constraints**, and **111 indexes** across `public` and `storage`.
- Globally keyed P0 surfaces include:
  - `conversations`: `PRIMARY KEY (conversation_id)`; no `(user_id, conversation_id)` unique key.
  - `conversation_summary`: `UNIQUE (conversation_id)` and no owner column or FK to `conversations`.
  - `messages`: `PRIMARY KEY (id)`; no FK to `conversations`, no tenant-qualified unique key, and no conversation/owner index.
  - Diary, Treehole, Moments, Album, Shared Context, audit, and Proactive tables use global `id` primary keys. Most child references are not composite with `user_id`.
- Only **23 FKs** exist across public and Storage. Public non-Memory FKs are limited to:
  - `conversations.shared_context_id -> shared_contexts.id`;
  - `moment_check_audit.candidate_id -> moment_candidates.id`;
  - `moment_comments.moment_id -> moment_entries.id`;
  - `moment_comments.parent_id -> moment_comments.id`.
- The XiaoC Memory Engine is materially stronger: its internal references normally use composite `(user_id, id)` unique keys and FKs. Two boundaries remain non-tenant-qualified: `memory_provenance.source_message_id -> messages.id`, and free-form `source_conversation_id` has no FK.
- Scheduler indexes such as `moment_candidates_pending_idx`, `moment_xiaoc_activity_pending_idx`, and `xiaoc_proactive_tasks_pending_idx` begin with status/time rather than tenant. That is appropriate for global service workers, but ordinary tenant queries and uniqueness must be designed separately.

Status: **P0_BLOCKER** for M2 migration; **confirmed strong baseline** inside the native Memory Engine only.

### 5.2 RLS and policies

- RLS is **disabled** on: `conversation_summary`, `conversations`, `memories`, `messages`, and `user_state`.
- RLS is enabled but not forced on the other **22 public tables**.
- There are **no RLS policies on any public table**. Those 22 tables therefore fail closed for anon/authenticated today, but have no usable per-tenant authenticated path.
- Storage tables have RLS enabled and not forced.
- The only policy in `public` or `storage` is a permissive `INSERT` policy on `storage.objects`, role `public`, with only `WITH CHECK (bucket_id = 'chat-images')`. It does not require authentication, UUID path ownership, or `owner_id`.

Status: **P0_BLOCKER**.

### 5.3 Grants, roles, and default privileges

- `anon` and `authenticated` have schema `USAGE` on `public` and `storage`; they do not have schema `CREATE`.
- PostgreSQL default ACLs for objects created by `postgres` in both schemas grant:
  - all table privileges to `anon`, `authenticated`, and `service_role`;
  - sequence `rwU` to those roles;
  - function `EXECUTE` to those roles.
- This default is already reflected on most public business tables. On the five tables without RLS, anon/authenticated consequently have direct broad CRUD/TRUNCATE-style privileges.
- Native Memory Engine tables and the two observability audit tables have been explicitly narrowed: Memory tables are service-only read/references/truncate at the table layer, and audit writes are service-only. Their RLS remains defense in depth.
- `service_role` has `BYPASSRLS`. Other relevant bypass roles include platform/admin roles and `supabase_read_only_user`; `anon` and `authenticated` do not bypass RLS.

Status: **P0_BLOCKER** until default privileges and existing grants are made least-privilege as part of M2.

### 5.4 RPC security

- There are **30 public functions**; all are owned by `postgres`.
- **22/30** are `SECURITY DEFINER`; all 22 have an explicit function-level `search_path`.
- Tenant-bearing Memory RPCs, `claim_moment_check`, cleanup, Core initialization, and preferences patching are not executable by anon/authenticated; their intended callable surface is service-only.
- `initialize_core_memory_snapshot` and `patch_client_preferences` are SECURITY INVOKER, service-only, with `search_path=public`; their earlier tenant-identity design concerns remain, but they are not directly exposed to ordinary roles.
- P0 exception: `check_pending_moments_for_xiaoc()` is zero-argument, `SECURITY DEFINER`, `search_path=public`, and executable by anon/authenticated as well as service role.
- Five trigger-only guard functions are SECURITY INVOKER but retain anon/authenticated EXECUTE because of default function privileges. Direct execution is not an authorization path by itself, but these grants are unnecessary and should be removed in the least-privilege design.
- The SECURITY DEFINER Memory RPCs use explicit `search_path=public, extensions, pg_catalog`; observability cleanup uses `pg_catalog, public`.

Status: **P0_BLOCKER** for the callable Moments function and caller-supplied tenant contract; otherwise the current service-only RPC grants are a useful containment baseline.

### 5.5 Triggers and views

- No views or materialized views exist in `public` or `storage`; there is currently no view-based RLS bypass surface.
- Public has **14 triggers**, all in the native Memory Engine: append-only guards, lifecycle transition guards, immutable-item guards, and deferred verified-integrity constraint triggers.
- Storage has **4 platform triggers** for bucket/object protection, bucket name length, and object timestamps.
- Public trigger functions are owned by `postgres` and have explicit `search_path`; three deferred integrity triggers call a SECURITY DEFINER function with `search_path=public, pg_catalog`.

Status: **PASS for discovery**; no additional P0 view bypass was found.

### 5.6 Storage security

- The earlier bucket public/private and owner findings remain confirmed.
- Catalog adds that the only custom Storage policy is unauthenticated public upload to `chat-images` with a bucket-only check.
- There is no SELECT/UPDATE/DELETE tenant policy and no UUID path/`owner_id` policy for any bucket.
- Broad table grants exist on Storage tables, but RLS gates ordinary roles; `service_role` bypasses RLS.

Status: **P0_BLOCKER**.

### 5.7 Tenant FK and orphan profile

Only counts were selected. No IDs or content were read.

| Relationship | Orphans | Owner mismatch among matched rows |
| --- | ---: | ---: |
| `conversation_summary.conversation_id -> conversations` | 1 | N/A: Summary has no owner |
| `moment_candidates.published_moment_id -> moment_entries` | 3 | 0 |
| `moment_xiaoc_activity.moment_id -> moment_entries` | 2 | 0 |
| 15 other checked Chat, Shared Context, Memory provenance, Moments, preferences, and Proactive relationships | 0 | 0 |

The three nonzero results are real migration reconciliation inputs, not permission to delete or rewrite rows. `published_moment_id` and activity Moment references are not backed by FKs. The checks covered every direct cross-domain relationship identifiable from current `*_id` columns except polymorphic `source_id`/task IDs, whose target depends on row type and remains a design-time validation requirement.

Status: **P0_BLOCKER**, with no observed same-row owner mismatch in the checked resolvable relationships.

## 6. Discovery completeness and remaining unknowns

- **Resolved:** PK/FK/check/unique definitions, indexes, RLS flags/policies, schema/table/default privileges, relevant roles and BYPASSRLS, public RPC owner/security/search path/execute grants, triggers, views, Storage RLS policy, and aggregate direct-reference orphan/tenant mismatch checks.
- **Remaining operational unknown:** classify the redacted non-`"user"` legacy owner cohorts as real data, prototype/test/import data, or stale data. That classification requires user/operational provenance, not private-body inspection.
- **Remaining polymorphic unknown:** reconcile `source_id`, task IDs, provider callback identifiers, and any object-path references whose target cannot be inferred from a database FK alone.
- **Remaining platform configuration:** Data API exposed-schema/pre-request settings, Auth provider/session/hook settings, Cron job definitions, backup/PITR availability, and complete migration-history reconciliation were outside these catalog queries. They affect rollout operations but do not invalidate the confirmed database P0 design inputs.
- No function body/source text was exported because owner, SECURITY mode, fixed search path, identity arguments, and execute grants were sufficient for this M2A security inventory. M2B must review the body of any RPC it proposes to preserve or expose; do not assume tenant checks from its signature.

## 7. M2B entry recommendation

M2B may begin as a **design-only ownership, isolation, and migration model** using the now-confirmed catalog baseline. Production changes, migration execution, Auth-user creation, and code changes remain separately gated.

**READY FOR M2B DESIGN.** First design the canonical Auth UUID/companion root, then produce the table-by-table target ownership/constraint/RLS/grant/RPC/Storage matrix and an explicit reconciliation plan for the orphan and mixed-owner cohorts. Do not apply it to Production without separate approval.
