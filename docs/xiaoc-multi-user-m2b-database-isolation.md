# XiaoC Multi-user M2B — Database Isolation Design

> Status: DESIGN ONLY
>
> Basis: M1 identity contract and the 2026-09-10 M2A Production catalog snapshot.
>
> This document does not authorize Production changes, migration execution, application-code changes, deployment, commit, or push. It intentionally contains no executable migration SQL.

## 1. Decision summary

Supabase Auth `auth.users.id` is the canonical tenant identity. The target database owner key is named `user_id`, has type `uuid`, is `NOT NULL` on every tenant-owned row, and is never derived from request input.

Create one application lifecycle root, `companion_instances`, with one row per Auth account:

```text
auth.users.id
    1 ── 1 companion_instances.user_id (UUID primary key)
              └── tenant-owned tables.user_id (UUID foreign key)
```

`companion_instances.user_id` must reference `auth.users.id`. All business tables reference `companion_instances(user_id)`, not mutable profile attributes. Auth deletion is not allowed to cascade implicitly through private history. Account deletion must use a separately authorized, audited purge workflow; until that exists, the Auth/root relationship is restrictive.

Keep globally unique entity IDs where they already exist to avoid a disruptive primary-key rewrite. Add `UNIQUE (user_id, id)` or the domain equivalent to every tenant parent, and make every child relationship tenant-qualified. Global uniqueness is convenience; the composite key is the ownership proof.

For legacy textual conversation IDs, retain the current identifier during the compatibility period but establish `UNIQUE (user_id, conversation_id)`. New conversations use globally unique UUID-form identifiers. A later ID-type cleanup is not part of M2.

## 2. Non-negotiable isolation invariants

1. `auth.uid()` or a verified service actor is the only source of tenant authority.
2. Every tenant row has exactly one `user_id uuid not null` referencing `companion_instances`.
3. A child cannot reference a parent belonging to another tenant; composite FKs enforce this even when IDs are globally unique.
4. Ordinary authenticated access requires both least-privilege grants and RLS. Either layer alone is insufficient.
5. `anon` receives no access to private business tables, tenant RPCs, private Storage objects, or private buckets.
6. Service role is never the default client for ordinary user work. It is reserved for workers, callbacks, migrations, retention, and narrowly defined administration.
7. Summary, Core, Memory, Context, task, cache, idempotency, and Storage identities are tenant-qualified before a second account is admitted.
8. A lookup with another tenant's valid child ID returns tenant-local not-found and never reveals ownership.
9. No migration maps unknown legacy cohorts to the first private account by assumption.
10. Ombre authority and cutover are outside M2. M2 must preserve the M1 legacy-account containment boundary.

## 3. Tenant root and lifecycle

### 3.1 `companion_instances`

Target responsibilities:

- `user_id uuid primary key` and FK to `auth.users.id`;
- lifecycle state such as `provisioning`, `active`, `suspended`, `pending_deletion`;
- timestamps and non-secret migration/version markers;
- optional immutable companion-instance UUID only if future product requirements need identity distinct from the account;
- no email, password, provider token, private prompt text, or Memory content.

The one-account/one-companion rule is enforced by the primary key. Profile and display attributes may live in a separate tenant-owned profile table; they are not owner keys.

Deletion contract:

- no raw Auth delete while a companion root owns data;
- begin with `pending_deletion`, revoke sessions, pause workers, create a privacy-safe deletion manifest, then purge children in an explicit dependency order;
- delete the companion root only after Storage and child tables reconcile to zero;
- delete the Auth user last;
- administrative recovery/undelete policy is separate from normal RLS.

### 3.2 Transitional naming

Production currently has text `user_id` columns. Do not cast them in place.

- additive stage: introduce `user_uuid uuid` beside legacy `user_id text`;
- backfill only from an approved legacy-owner mapping;
- dual-read verification compares legacy and UUID ownership without changing runtime authority;
- UUID-only writes begin only after the application-auth phase is ready;
- final schema stage makes the UUID column `NOT NULL`, installs FKs/RLS, retires the text alias, then renames UUID ownership to canonical `user_id` if necessary.

The target schema described below always calls the final UUID column `user_id`; `user_uuid` is only a migration bridge.

## 4. Target ownership matrix

All listed owner keys are `uuid not null references companion_instances(user_id)` unless stated otherwise.

| Table/domain | Final owner and tenant integrity | Access class |
| --- | --- | --- |
| `companion_instances` | `user_id` PK; one-to-one Auth root | authenticated self; lifecycle service/admin |
| `conversations` | `user_id`; `UNIQUE (user_id, conversation_id)` | authenticated self; worker as persisted owner |
| `messages` | `user_id`; composite FK `(user_id, conversation_id)`; `UNIQUE (user_id, id)` | authenticated self |
| `conversation_summary` | add `user_id`; composite FK `(user_id, conversation_id)`; `UNIQUE (user_id, conversation_id)` | server/worker only by default |
| legacy `memories` | `user_id`; `UNIQUE (user_id, id)` | authenticated self only if this legacy surface remains user-facing |
| `user_state` | `user_id` PK; tenant FK for `last_conversation_id` | authenticated self, restricted mutable columns |
| `diary_entries` | `user_id`; `UNIQUE (user_id, id)` | authenticated self |
| `treehole_entries` | `user_id`; tenant uniqueness for legacy/natural keys | authenticated self read/manage; service create where required |
| `treehole_execution_audit` | tenant-attributed `user_id`; task relationship tenant-qualified | service insert; no ordinary direct read by default |
| `moment_entries` | `user_id`; `UNIQUE (user_id, id)`; source conversation/message tenant-qualified | authenticated self |
| `moment_comments` | `user_id`; composite FKs to Moment and parent comment | authenticated self |
| `moment_candidates` | `user_id`; source conversation/message and published Moment tenant-qualified | service only |
| `moment_xiaoc_activity` | `user_id`; Moment/comment/task/message relationships tenant-qualified | service only |
| `moment_interaction_state` | `user_id` PK | authenticated self |
| `moment_check_audit` | `user_id`; conversation/message/candidate relationships tenant-qualified | service insert/read only |
| `xiaoc_proactive_tasks` | `user_id`; `UNIQUE (user_id, id)`; conversation/message links tenant-qualified; idempotency includes owner | worker/service only |
| `shared_contexts` | `user_id`; `UNIQUE (user_id, id)` | authenticated self read as needed; server write |
| `album_assets` | `user_id`; `UNIQUE (user_id, id)`; canonical Storage key bound to owner | authenticated self |
| `background_worker_run_audit` | tenant-attributed `user_id`; run uniqueness includes service/run identity | service insert/read only |
| `memory_items` | existing owner becomes UUID; preserve `(user_id, id)` unique | service-only until M4 authority decision |
| `memory_embeddings` | existing composite owner FK pattern | service-only |
| `memory_provenance` | composite Memory FK; source message/conversation becomes tenant-qualified | service-only |
| `memory_relations` | existing composite owner FKs | service-only |
| `memory_pins` | existing composite owner FKs and tenant-scoped ordinal uniqueness | service-only until M4 |
| `memory_operations` | existing composite owner/idempotency/FK pattern | service-only |
| `memory_import_runs` | existing composite owner uniqueness | migration/service only |
| `memory_import_plan_items` | existing composite owner FK pattern | migration/service only |
| `legacy_memory_map` | existing composite owner FK pattern | migration/service only |

Platform-owned Storage tables remain managed by Supabase. Tenant ownership is expressed through object path, `owner_id`, Storage policies, and the owning application row rather than adding application FKs to `storage.objects`.

### 4.1 Polymorphic references

Columns such as Proactive `source_id` cannot receive a single FK while their target changes by `source_type`. M2 must choose one of these in order of preference:

1. replace polymorphism with typed nullable tenant-qualified FK columns plus a check constraint allowing exactly one target;
2. introduce a tenant-owned source/event registry referenced by `(user_id, source_event_id)`;
3. retain polymorphism temporarily, but validate it in a service-only write RPC and scheduled integrity audit.

Do not claim database isolation is complete while an ordinary client can write an unchecked polymorphic target.

## 5. Core Chat, Summary, Core, Memory, and state design

### 5.1 `conversations`

Target constraints and indexes:

- `user_id uuid not null` FK to companion root;
- retain `conversation_id` as the stable compatibility ID;
- `UNIQUE (user_id, conversation_id)` as the referenced ownership key;
- index `(user_id, updated_at desc)` for history;
- index `(user_id, shared_context_id)` where bound;
- composite FK `(user_id, shared_context_id)` to `shared_contexts`;
- new IDs are UUID-form and globally unique, but all queries still qualify by owner.

The existing global `PRIMARY KEY (conversation_id)` may remain through M2 to minimize risk. It is not accepted as an authorization boundary. A later primary-key modernization requires separate evidence and is not needed for isolation.

### 5.2 `messages`

Target constraints and indexes:

- `user_id uuid not null`;
- `conversation_id not null`;
- `UNIQUE (user_id, id)`;
- composite FK `(user_id, conversation_id)` to `conversations` with an explicitly chosen delete action; default recommendation is restrictive/soft-delete rather than cascading private history accidentally;
- index `(user_id, conversation_id, created_at, id)` for stable history pagination;
- any client-idempotency/message-external key is unique only within `user_id` or `(user_id, conversation_id)`;
- attachment/object references resolve under the same owner.

### 5.3 `conversation_summary` and Core Snapshot

Add `user_id uuid not null`. The row identity becomes `(user_id, conversation_id)`:

- replace global `UNIQUE (conversation_id)` with `UNIQUE (user_id, conversation_id)` only after compatibility readers no longer depend on global identity;
- composite FK `(user_id, conversation_id)` to `conversations`;
- Summary segments, checkpoint, Core snapshot, Core hash, source bucket IDs, and snapshot creation time remain in the same tenant-owned row;
- Core initialization must lock/select/update by both owner and conversation;
- source bucket IDs are validated under the same tenant before persistence;
- no fallback lookup by conversation ID alone, including cache, upsert conflict target, or cold-start initialization.

The existing one Summary orphan must be quarantined or mapped to a verified conversation before `NOT NULL`/FK validation. It must not be silently attached to the first account.

This prevents both collision classes:

- two tenants cannot read/update the same Summary through a shared conversation identifier;
- a Core Snapshot cannot contain source bucket identities resolved from another tenant.

### 5.4 legacy `memories`

- make `user_id uuid not null` and add `UNIQUE (user_id, id)`;
- any user-facing CRUD uses RLS and `auth.uid()`;
- any bridge to Ombre remains restricted to the allowlisted private UUID and is not inferred from this table;
- do not combine owner migration with Memory Engine cutover, consolidation redesign, or heat/archive work.

### 5.5 `user_state`

- `user_id uuid primary key` and FK to companion root;
- `last_conversation_id` receives composite FK `(user_id, last_conversation_id)`;
- mutable preferences are column-allowlisted; push tokens and sensitive device state should be separated if their lifecycle or grants differ;
- user updates must never be able to set another owner.

## 6. RLS and grant model

### 6.1 Policy templates

Enable RLS on every tenant-owned table. Force RLS is optional for tables accessed by the owner role `postgres`; it does not constrain `service_role` because that role bypasses RLS. The security boundary for service actors is separate credentials, RPC grants, and repository rules.

Policy classes:

- **authenticated self CRUD:** `USING` and `WITH CHECK` both require `auth.uid() = user_id`;
- **authenticated self read + constrained update:** separate SELECT/INSERT/UPDATE/DELETE policies, not one broad `ALL` policy; use column grants or RPCs for sensitive mutations;
- **server-managed:** no authenticated policy; service-only RPC/repository path;
- **append-only audit:** no authenticated policy; service INSERT, restricted service/admin SELECT, no UPDATE/DELETE except retention capability;
- **migration/admin:** no standing authenticated policy; time-bounded audited capability outside normal user access.

Tenant child policies may use the row's owner only because composite FKs guarantee that its parents share that owner. Avoid repeated security-definer ownership lookups where a direct `user_id` comparison suffices.

### 6.2 Table policy classification

Authenticated self CRUD/read-manage candidates:

- `companion_instances` self read only;
- `conversations`, `messages`, `memories` if retained, Diary, Treehole, Moments/comments/interaction state, Album, and user-visible preferences;
- Shared Context may be self-readable but server-written if clients do not need direct mutation.

Server-managed with no direct authenticated write:

- `conversation_summary`, Moment candidates/activity/check audit, Proactive tasks, background audits;
- native Memory Engine tables until the M4 authority gate;
- Core Snapshot fields and all worker lifecycle fields.

### 6.3 Grants

Target grants:

- `anon`: schema usage only where Supabase requires it; no business table, sequence, or private function privilege; no Storage object access for private XiaoC data.
- `authenticated`: schema usage; only the minimum table verbs needed by the policy classification; no `TRUNCATE`, `TRIGGER`, or `REFERENCES`; sequence usage only when a user-writable table truly requires it; execute only on explicitly approved user RPCs.
- `service_role`: do not rely on blanket default grants. Grant service-only RPC execution and the narrow table operations required by named workers. Where Supabase's built-in role remains broadly privileged, application separation and per-service RPC surfaces must provide the effective least-privilege boundary.
- admin/migration: separate, audited, time-bounded capability; never shipped to clients or reused by normal API requests.

Repair default privileges for future objects before relying on per-object revocations. New tables/functions must start private and receive explicit grants. Existing grants are then reconciled object by object. Grant changes and RLS activation must be staged so the current private App is not cut off before its authenticated path is ready.

## 7. RPC hardening plan

### 7.1 User-callable RPCs

A user-callable RPC:

- derives `v_user_id := auth.uid()` internally;
- rejects a missing authenticated identity;
- does not accept authoritative `p_user_id`;
- resolves every conversation/message/Moment/Memory ID under `v_user_id`;
- is SECURITY INVOKER by default so RLS remains effective;
- if SECURITY DEFINER is unavoidable, uses a minimal fixed `search_path`, fully qualified objects, explicit authorization at the top, no dynamic SQL from callers, and a dedicated owner with only required rights;
- grants EXECUTE only to `authenticated` and explicitly revokes `public`/`anon`.

`patch_client_preferences` is the clearest future user-RPC candidate: remove authoritative `p_user_id`, derive `auth.uid()`, allowlist preference keys, and keep tenant-local upsert identity.

### 7.2 Service-only RPCs

Keep these service-only:

- Moment checking/claiming and worker selection;
- Summary/Core creation and checkpoint update;
- Proactive task claiming, execution lifecycle, retention, and reconciliation;
- observability cleanup;
- all native Memory Engine mutation, retrieval, embedding, import, operation, pin, and relation RPCs until M4;
- migration/backfill/repair functions;
- provider callback reconciliation.

Service-only RPC rules:

- revoke from `public`, `anon`, and `authenticated`;
- grant only to the intended service capability;
- `p_user_id uuid` may remain as a routing argument only because caller identity is already a trusted service actor;
- verify every supplied child ID belongs to that same `p_user_id` using tenant-qualified constraints/queries;
- claim workers adopt the persisted task owner and never trust an external request owner;
- SECURITY DEFINER functions use a minimal fixed search path and fully qualified tables.

### 7.3 Specific Production functions

| Function group | Target disposition |
| --- | --- |
| `check_pending_moments_for_xiaoc()` | revoke anon/authenticated immediately in the grant-hardening phase; retain service-only or replace with a service worker query/RPC |
| `claim_moment_check(...)` | service-only; convert owner parameter to UUID; verify conversation/messages under owner |
| `initialize_core_memory_snapshot(...)` | service-only; add trusted tenant UUID; conflict/lock/FK all use `(user_id, conversation_id)` |
| `patch_client_preferences(...)` | preferably authenticated invoker using `auth.uid()`; otherwise service-only with trusted actor context |
| `xiaoc_memory_*` runtime RPCs | service-only through M4; convert text owner to UUID without widening execute grants |
| `xiaoc_memory_*` import/rollback RPCs | migration capability only, unavailable to runtime service identities |
| trigger guard functions | revoke direct public/anon/authenticated execute where PostgreSQL trigger execution does not require it |
| retention cleanup | service/admin-only, bounded retention arguments, audited run identity |

M2C must inspect preserved SECURITY DEFINER function bodies before implementation. M2A verified metadata and grants, not internal authorization semantics.

## 8. Storage isolation model

### 8.1 Canonical object contract

Every private object uses:

```text
{user_uuid}/{resource_type}/{resource_uuid}/{version-or-random-file-id}.{ext}
```

Rules:

- the first path segment is the lowercase canonical Auth UUID;
- no email, legacy alias, display name, conversation text, or user-controlled arbitrary owner prefix;
- DB metadata row stores `user_id`, bucket, canonical object key, resource identity, size/checksum, lifecycle state, and content type—not signed URLs;
- object key uniqueness is tenant-qualified in DB and globally unique in Storage;
- server signing first resolves the owning application row under trusted tenant context;
- signed URLs are short-lived, resource-specific, never logged, and cannot be refreshed with another tenant's resource ID;
- upload MIME/size limits are bucket-specific and checked both before signing and on finalized metadata.

### 8.2 Bucket/access model

- `chat-images`, `moment-images`, `album-images`, and `generated-files` become private tenant buckets/objects. Public read buckets are incompatible with XiaoC private content.
- remove the current public `chat-images` INSERT policy only after authenticated/server-mediated replacement upload is verified.
- direct authenticated Storage policies, where used, require `auth.uid()` to equal both the UUID path prefix and `owner_id`/`owner_id::uuid` as supported by the deployed Storage schema.
- private App and future Public App share the same ownership contract; only their authentication UX differs.
- `xiaoc-memory-backups` remains service/admin-only, outside user RLS, with no signed client URL.
- service-created objects must set/retain attributable ownership where supported; absence of Storage `owner_id` never relaxes the application DB ownership check.

Recommended client pattern:

- authenticated direct upload only to a server-issued, tenant-bound destination or a narrowly scoped Storage policy;
- authenticated read through short-lived signed URLs issued after DB ownership validation;
- deletion is soft-delete in application metadata, followed by authorized asynchronous Storage cleanup.

## 9. Existing-data migration design

### 9.1 Classification states

Create a migration-only owner mapping registry. Every distinct legacy owner cohort is classified as exactly one of:

- `approved_target`: verified to belong to a specific Auth UUID;
- `prototype_or_test`: preserved but not exposed to any real account;
- `system_or_service`: moved to an explicit service-owned/non-user model if semantically valid;
- `duplicate_or_superseded`: retained for reconciliation but not merged automatically;
- `unknown`: quarantined and blocks final `NOT NULL`/cutover for affected active rows.

Mapping evidence contains redacted fingerprints, aggregate counts, origin/environment evidence, approver, timestamp, and reason. It never contains private body text.

The literal `"user"` is not automatically approved. It is only mapped to the first private Auth UUID after the user/account binding and domain reconciliation are explicitly approved. All non-`"user"` cohorts require independent classification.

### 9.2 Quarantine

Quarantine is logical and reversible:

- excluded from new-account reads, prompts, Memory retrieval, workers, push, and Storage signing;
- retains original primary keys, owner alias, hashes/counts, timestamps, and reference graph;
- may use a migration registry/state column or separate restricted quarantine schema/table, chosen in M2C;
- cannot be assigned to a catch-all tenant UUID;
- does not delete or rewrite private content merely to satisfy a constraint.

### 9.3 Known anomalies

- **1 Summary orphan:** quarantine the Summary/Core row unless its conversation can be proven from non-content lineage. Do not synthesize a conversation or attach it to the first account.
- **3 Moment candidate published-Moment orphans:** preserve candidates; clear/rewrite references only after lifecycle evidence establishes whether the Moment was deleted, never merely to pass an FK.
- **2 Moment activity Moment orphans:** stop them from worker execution, preserve terminal/audit evidence, and classify before FK validation.
- **nullable schema owners:** current counts are zero for core rows, but the migration must recheck under write pause. Any null becomes quarantine, not default-owner backfill.
- **mixed owner labels:** migrate parents and children by approved cohort mapping; a cross-cohort relationship is a blocking conflict even if the raw IDs resolve.

### 9.4 Manifest and rollback

Before apply, produce a privacy-safe signed manifest containing:

- mapping-registry version and approved target UUIDs;
- per table/cohort counts and primary-key digests;
- relationship/orphan/mismatch counts;
- Summary/Core snapshot-hash and checkpoint digests;
- Storage old/new key mapping, size/checksum, and reference counts;
- task status/idempotency/event digests;
- schema/grant/RLS versions and rollback deadline.

Rollback retains legacy aliases and old Storage objects read-only until the gate expires. Reverse mapping restores legacy ownership and object references; UUID-created rows remain isolated for forensic comparison and are never merged blindly. Rollback pauses workers/writes first and uses the same reconciliation checks as forward migration.

## 10. Safe additive and reversible phases

These phases are separate approval and deployment units. Do not combine schema ownership, RLS enforcement, API auth, Ombre cutover, or private App account migration.

### Phase 0 — Freeze and rehearsal

- capture catalog/operational/backup baseline;
- classify owner cohorts and known orphans;
- build a production-shaped rehearsal copy and two test Auth users;
- define kill switches and rollback deadline.

Exit: every active cohort has a disposition; backup/PITR and rollback rehearsal are proven.

### Phase 1 — Add tenant foundation

- add companion root and nullable UUID bridge columns;
- add non-validating/compatible composite unique keys and indexes;
- do not change current reads, writes, grants, or RLS behavior.

Exit: additive schema has no runtime behavior change and can be removed safely.

### Phase 2 — Backfill and quarantine

- create the verified private Auth account/root only under separate approval;
- backfill approved cohorts in dependency order;
- quarantine unknown/anomalous rows;
- copy Storage to UUID paths without deleting old objects.

Exit: counts/digests match; no approved row has null UUID ownership or owner mismatch.

### Phase 3 — Constraint validation

- establish/validate tenant composite FKs and uniqueness;
- resolve or quarantine every orphan before validation;
- keep legacy runtime path unchanged.

Exit: database rejects cross-tenant parent/child links on the rehearsal environment and shadow validation is clean.

### Phase 4 — Grant and RPC containment

- repair default privileges;
- revoke accidental anon/authenticated table/function access;
- restrict Moments, Memory, cleanup, Core, and worker RPCs to intended actors;
- do not yet enable authenticated client policies that the application cannot use.

Exit: old private production path remains functional; direct anon/auth probes fail.

### Phase 5 — RLS shadow/readiness

- define authenticated self policies and server-managed no-policy tables;
- test under role/JWT simulation in rehearsal;
- prepare, but do not combine with, API trusted-context cutover.

Exit: full two-user DB test suite passes and every policy/grant pair is reviewed.

### Phase 6 — API Auth cutover (M3, separate scope)

- application starts using verified Auth UUID and user-scoped access;
- writes become UUID-only; legacy alias reads are time-bounded compatibility;
- RLS enforcement activates per domain behind rollback flags.

Exit: API IDOR and production canary pass; no service-role fallback on user paths.

### Phase 7 — Private App and Storage cutover (M5/M6, separate scope)

- bind private App to the approved first account;
- move local state namespace and authenticated Storage paths;
- resume workers/push after reconciliation.

Exit: real-device continuity and rollback checks pass.

Ombre cutover is not a phase here. It stays authoritative only for the allowlisted legacy account until M4 separately closes its gate.

## 11. Two-user isolation validation plan

Use tenants A and B plus anon, expired-token, service-worker, and migration actors. Seed synthetic data only.

### 11.1 Database and RLS

- A can perform each allowed action on A rows; B can do the same on B rows.
- A cannot SELECT/INSERT/UPDATE/DELETE B rows, including by known valid ID.
- setting `user_id=B` under A fails `WITH CHECK`.
- anon has no business-table access.
- authenticated cannot truncate, trigger, reference, or execute service RPCs.
- cross-owner composite FK inserts and updates fail.
- service worker can access only through its intended operational surface in tests.

### 11.2 IDOR and collision

- repeat every GET/mutation with another tenant's conversation, message, Moment, Memory, task, album, or file ID;
- compare not-found/error shapes to avoid ownership enumeration;
- attempt identical legacy conversation IDs for A and B according to the selected global-ID compatibility rule;
- verify global collision rejects safely and never resolves the existing tenant's row;
- verify all repository/RPC upserts use tenant-aware conflict targets.

### 11.3 Summary and Core

- create same-shaped conversations for A/B and initialize concurrently;
- prove Summary checkpoints, segments, Core snapshots, hashes, and source bucket IDs remain isolated;
- attempt to initialize A's conversation with B's source buckets;
- test cold start, retry, concurrent first write, lazy initialization, and rollback;
- verify no query/cache/upsert uses conversation ID alone.

### 11.4 RPC

- call every user RPC with forged owner fields and B child IDs;
- call every service RPC as anon/authenticated and expect denial;
- verify user RPCs ignore/remove `p_user_id` and use `auth.uid()`;
- inspect SECURITY DEFINER fixed search paths and object qualification;
- test dynamic-input, search-path shadowing, null-auth, and overbroad execute grants.

### 11.5 Storage

- A cannot upload under B prefix, set B owner, list B paths, sign B objects, refresh B URLs, update, or delete B objects;
- anon cannot use the removed `chat-images` upload path;
- copied legacy objects reconcile by size/checksum without exposing filenames;
- signed URL expiry is enforced; possession after expiry cannot refresh without ownership;
- DB soft delete prevents new signing before asynchronous object cleanup.

### 11.6 Background work and callbacks

- task claim returns persisted owner; request owner cannot override it;
- Moment, Treehole, inactivity, weather, proactive, Summary, and push workers never combine A/B context;
- task/idempotency/event IDs do not collide across tenants;
- stale-processing recovery and retries preserve owner;
- provider callbacks resolve a persisted tenant after signature verification and cannot choose one from payload alone.

### 11.7 Memory and Context injection

- A prompt cannot include B Summary, Core, Recent, Dynamic/Stable Memory, Active/Shared Context, Moment, Diary, Treehole, or attachment description;
- Core exclusion IDs, provenance, pins, embeddings, and relations are owner-qualified;
- cache/provider session keys differ for A/B even with equal conversation IDs;
- Ombre rejects B entirely and accepts only the allowlisted private UUID;
- logs contain only privacy-safe tenant hashes and no private prompt/content.

### 11.8 Migration and rollback

- rehearsal covers approved, test/prototype, unknown, null-owner, duplicate, orphan, and cross-owner fixtures;
- forward and reverse manifests reconcile counts/digests;
- quarantined rows remain unreachable and unmodified;
- rollback restores legacy owner/object references without exposing UUID-created rows to legacy readers.

## 12. P0 blockers before implementation

1. Approve the companion-root and restrictive Auth deletion lifecycle.
2. Inventory exact columns/delete semantics for every proposed composite FK and choose soft-delete versus restrict per domain.
3. Classify all legacy owner cohorts; do not leave active `unknown` mappings.
4. Decide the disposition of the 1 Summary, 3 candidate, and 2 activity orphan references.
5. Inspect bodies of every SECURITY DEFINER/user-preserved RPC.
6. Define the exact Data API exposed schemas/pre-request behavior and Auth configuration.
7. Confirm backup/PITR, Cron pause, push pause, worker drain, and rollback operational controls.
8. Complete Storage nested-object/reference inventory and checksum-capable copy rehearsal.
9. Inventory all polymorphic source/task/provider references and choose their integrity model.
10. Produce an application access matrix so grant/RLS changes do not break the current private App.
11. Build a production-shaped rehearsal database and automated two-user role/JWT test harness.
12. Preserve Ombre legacy-account-only containment; no second account may enter its current global paths.

## 13. M2B exit decision

The target tenancy schema, RLS/grant model, RPC boundary, Storage contract, reversible legacy migration, staged rollout, and two-user validation plan are defined from the real M2A catalog.

**READY FOR M2C IMPLEMENTATION PLAN**, subject to the P0 design inputs above. M2C may produce an ordered implementation plan, migration artifact specification, and rehearsal/test plan. It must not execute Production migration or combine database isolation with M3 API auth, M4 Ombre/Memory authority, or M5 private-App account changes without separate approval.
