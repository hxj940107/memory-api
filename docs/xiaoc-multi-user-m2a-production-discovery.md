# XiaoC Multi-user M2A — Production Supabase Read-only Discovery

> Snapshot date: 2026-09-10 (Asia/Shanghai)
>
> Scope: sanitized, read-only Production metadata and ownership discovery.
>
> No private message, Memory, Diary, Treehole, Moment, attachment, or prompt content was selected or recorded.

## 1. Discovery status

**PARTIAL — sufficient to confirm P0 blockers, insufficient for M2B migration SQL.**

Production was queried through the configured Supabase REST, Auth Admin, and Storage metadata APIs using a server-side credential. This confirmed the exposed `public` schema shape, exposed RPC names/arguments, Auth user count, Storage bucket configuration, top-level object ownership metadata, and aggregate owner counts.

The current environment did not provide a database connection string, `psql`, Supabase CLI linkage, or a usable Dashboard SQL session. PostgREST OpenAPI does not expose authoritative PK/FK/unique/index definitions, RLS flags/policy expressions, grants/default privileges, function owners/security mode/source, triggers, or views. Those items remain `UNKNOWN` until a read-only catalog query is run.

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
| PK/FK/unique/index definitions | UNKNOWN | Not exposed authoritatively by current discovery channel. |
| RLS flags and policy expressions | UNKNOWN | Requires `pg_class`/`pg_policy` catalog access. |
| grants/default privileges/BYPASSRLS roles | UNKNOWN | Requires information schema and role/catalog access. |
| function SECURITY DEFINER/owner/search_path/source | UNKNOWN | RPC presence/arguments confirmed; security metadata unavailable. |
| triggers and views | UNKNOWN | Requires database catalog access. |

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
9. Actual RLS, grants, SECURITY DEFINER surface, triggers, views, and service-role privilege surface are not yet verified.

## 5. Required completion query

Before M2B migration design is considered complete, run one sanitized read-only database-catalog export covering:

- `pg_namespace`, `pg_class`, `pg_attribute`, `pg_constraint`, `pg_indexes`;
- `pg_policy`, row-security and force-row-security flags;
- `information_schema` table/schema/routine/sequence privileges and default ACLs;
- roles/role membership and `rolbypassrls` without password material;
- `pg_proc` identity arguments, owner, `prosecdef`, volatility, configuration/search path and grants;
- `pg_trigger` and function linkage;
- view/materialized-view definitions, owners, security options and grants;
- `storage.buckets` plus `storage.objects` policy/grant definitions and aggregate owner/path classification;
- FK/orphan and same-tenant relationship checks using IDs only;
- classification of every distinct legacy owner label using redacted fingerprints and approved operational meaning.

Do not export row content, emails, tokens, push tokens, signed URLs, object filenames beyond structural prefix classification, or secrets.

## 6. M2B entry recommendation

M2B may begin as a **design-only ownership and migration model**, using the confirmed P0 facts above. It must not produce executable Production migration assumptions until the catalog export closes the `UNKNOWN` items.

Immediate next action: obtain a read-only Postgres connection or have the user run a reviewed metadata-only SQL bundle in the Supabase SQL Editor and return its sanitized output. Then update this snapshot and build the authoritative table-by-table target matrix.
