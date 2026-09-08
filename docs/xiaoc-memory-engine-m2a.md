# XiaoC Memory Engine M2A Physical Schema & Migration Design

> Status: Design proposal only  
> Date: 2026-09-08 (Asia/Shanghai)  
> Architecture baseline: `docs/xiaoc-memory-engine-m1.md`  
> **NOT EXECUTABLE MIGRATION:** examples in this document illustrate PostgreSQL structure. They must not be applied as SQL.

## 1. Scope and compatibility

This proposal translates M1 into a Supabase/PostgreSQL physical model. It creates no database objects and changes no runtime behavior. Production Ombre, the existing `memories` table, Stable Memory, Core Snapshots, Memory/Context Gateway and chat path remain untouched and authoritative.

M1 calls the canonical table `memory_items`; that name is retained instead of introducing the alternate `memory_records` name. Six core tables and two import-control tables are proposed:

1. `memory_items`
2. `memory_provenance`
3. `memory_relations`
4. `memory_embeddings`
5. `memory_pins`
6. `memory_operations`
7. `memory_import_runs`
8. `legacy_memory_map`

The two import tables are necessary for checksum-bound, idempotent, reversible import. No additional taxonomy, ranking, heat or context tables are introduced.

## 2. PostgreSQL conventions and prerequisites

- Schema: `public`, matching the current project convention. A dedicated schema could be considered later but is not required for isolation.
- IDs: `uuid`, generated with `gen_random_uuid()` after confirming the required UUID facility is available.
- User identity: `text`, matching current XiaoC tables and the private value such as `user`. This does not add login or account UI.
- Time: `timestamptz` in UTC storage.
- Hashes: lowercase SHA-256 hex in `text`, checked as 64 hexadecimal characters.
- Extensible metadata: `jsonb not null default '{}'::jsonb`, used only for non-core source extensions.
- Controlled vocabularies: `text` plus `CHECK`, rather than PostgreSQL enum types. This keeps future vocabulary changes transactional and avoids enum migration friction.
- Vectors: the `vector` extension is a prerequisite only when `memory_embeddings` is implemented. M2A does not assume it is already enabled.

Every table has `user_id`. Parent tables expose `unique (user_id, id)` so child tables can use composite foreign keys and make cross-user linkage structurally impossible.

## 3. `memory_items`

### 3.1 Purpose

One row is one immutable version of a canonical claim. A correction inserts another row and relation. This table does not store provenance rows, vectors, PIN membership, current conversation attention or Core snapshot content.

### 3.2 Columns

| Column | PostgreSQL type | Null | Default | Mutation |
| --- | --- | --- | --- | --- |
| `id` | `uuid` | NO | `gen_random_uuid()` | Immutable |
| `user_id` | `text` | NO | — | Immutable |
| `canonical_content` | `text` | NO | — | Immutable; nonblank |
| `content_hash` | `text` | NO | — | Immutable SHA-256 of the declared normalization recipe |
| `origin_system` | `text` | NO | — | Immutable, initially `xiaoc_native` or `ombre_legacy` |
| `memory_class` | `text` | NO | — | Immutable, `observation` or `stable` |
| `category` | `text` | NO | — | Immutable for a version; nonblank, vocabulary remains extensible |
| `provenance_status` | `text` | NO | — | Immutable, `verified_user`, `derived_verified`, `manual_confirmed`, `legacy_unverified` |
| `lifecycle_status` | `text` | NO | `active` | Mutable through audited operation: `active`, `superseded`, `archived`, `deleted` |
| `retrieval_tier` | `text` | YES | `null` | Audited policy mutation: `active_legacy`, `low_authority`, `shadow_only`, `quarantined`, `disabled` |
| `authority_tier` | `text` | NO | — | Audited deterministic result: `native_verified`, `legacy_limited`, `none` |
| `authority_policy_version` | `text` | NO | — | Audited with authority/tier changes |
| `claim_key` | `text` | YES | — | Immutable for a version; optional and nonblank when present |
| `importance` | `smallint` | YES | — | Audited; range `0..10`; never authority |
| `confidence` | `numeric(4,3)` | YES | — | Immutable extraction/evidence confidence; range `0..1` |
| `event_time` | `timestamptz` | YES | — | Immutable source/event time |
| `valid_from` | `timestamptz` | YES | — | Immutable validity boundary |
| `valid_until` | `timestamptz` | YES | — | Immutable validity boundary |
| `resolved_at` | `timestamptz` | YES | — | Audited lifecycle/temporal mutation |
| `superseded_at` | `timestamptz` | YES | — | Audited lifecycle mutation |
| `archived_at` | `timestamptz` | YES | — | Audited lifecycle mutation |
| `deleted_at` | `timestamptz` | YES | — | Audited lifecycle mutation |
| `capture_policy_version` | `text` | NO | — | Immutable |
| `revision` | `bigint` | NO | `1` | Increments on every allowed mutation |
| `metadata` | `jsonb` | NO | `{}` | Audited extension data only |
| `created_at` | `timestamptz` | NO | `now()` | Immutable |
| `updated_at` | `timestamptz` | NO | `now()` | Updated with allowed mutations |

`retrieval_tier` is nullable for native verified rows because the M1 tier vocabulary is specifically the legacy admission/suppression classification. Native retrieval eligibility is calculated from native provenance, lifecycle, relations and temporal validity. The retrieval contract returns the nullable tier together with `provenance_status` and `authority_tier`; it must not relabel native data as `active_legacy`.

### 3.3 Keys and checks

- Primary key: `(id)`.
- Alternate key: `unique (user_id, id)` for composite child FKs.
- Nonblank checks: `user_id`, `canonical_content`, `origin_system`, `memory_class`, `category`, policy versions.
- Hash check: `content_hash ~ '^[0-9a-f]{64}$'`.
- Vocabulary checks for all four independent dimensions.
- Range checks for `importance` and `confidence`.
- Time check: `valid_until is null or valid_from is null or valid_until >= valid_from`.
- Lifecycle timestamp checks:
  - `superseded` requires `superseded_at`;
  - `archived` requires `archived_at`;
  - `deleted` requires `deleted_at`.
- Origin/provenance checks:
  - `origin_system = 'ombre_legacy'` requires `provenance_status = 'legacy_unverified'` unless a later verified import policy is explicitly designed;
  - `legacy_unverified` requires a non-null legacy map before activation, enforced in the import transaction rather than a circular table constraint;
  - legacy retrieval tiers require `provenance_status = 'legacy_unverified'`;
  - eligible legacy authority is `legacy_limited`, always below `native_verified`;
  - `quarantined`, `disabled` and `shadow_only` require `authority_tier = 'none'` for production retrieval purposes.

- Generic consistency checks:
  - `lifecycle_status = 'deleted'` requires `deleted_at`;
  - an eligible legacy retrieval tier is valid only with `provenance_status = 'legacy_unverified'`;
  - `authority_tier = 'legacy_limited'` is valid only for eligible legacy rows;
  - `shadow_only`, `quarantined` and `disabled` have no ordinary retrieval authority;
  - native verified rows cannot use `active_legacy`;
  - `metadata` cannot carry substitutes for user identity, canonical content/hash, provenance locator, legacy identity or relation identity.

The last cross-table conditions belong in transaction validation because a row-level `CHECK` cannot inspect another table safely.

### 3.4 Claim lookup

Do not create `unique (user_id, claim_key)`: history, observations and superseded versions must coexist.

Initial indexes:

- `(user_id, claim_key, lifecycle_status, valid_from desc, created_at desc)` with `where claim_key is not null`;
- `(user_id, lifecycle_status, retrieval_tier, created_at desc)`;
- `(user_id, created_at desc)`.

A partial unique index for one active native **stable** row per `(user_id, claim_key)` is deferred. Multiple active observations may legitimately share a claim key, and the exact stable apply semantics should be proven before adding that stronger constraint. Consolidation/supersede uses a locked transaction and expected revision in the meantime.

## 4. `memory_provenance`

### 4.1 Purpose and boundary

This table contains real verified native evidence. An unverified Ombre row receives no fake provenance row; its identity and preserved source payload live in `legacy_memory_map`. A native memory marked `verified_user`, `derived_verified` or `manual_confirmed` cannot be created by ordinary table insert; it is admitted only through a controlled PostgreSQL transaction function.

### 4.2 Columns

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | NO | Primary key |
| `user_id` | `text` | NO | Owner |
| `memory_id` | `uuid` | NO | Composite FK to memory owner |
| `source_kind` | `text` | NO | `message` or `manual_user` |
| `source_locator_key` | `text` | NO | Immutable deterministic canonical locator |
| `source_message_id` | `text` | YES | Required for `message`; exact existing type must be confirmed before migration |
| `source_operation_id` | `uuid` | YES | Required for `manual_user`; same-user FK to the trusted manual operation |
| `source_conversation_id` | `text` | YES | Required for message evidence when the source message has a conversation |
| `source_role` | `text` | NO | `user` for verified automatic capture |
| `evidence_text` | `text` | NO | Bounded exact substring; nonblank |
| `evidence_hash` | `text` | NO | SHA-256 of normalized exact evidence |
| `evidence_type` | `text` | NO | `assertion`, `confirmation`, `correction`, `question`, `other` |
| `observed_at` | `timestamptz` | NO | Source message/action time |
| `created_at` | `timestamptz` | NO | Default `now()` |

Keys and indexes:

- `primary key (id)` and `unique (user_id, id)`;
- composite FK `(user_id, memory_id) -> memory_items(user_id, id)`;
- unique idempotency key `(user_id, memory_id, source_kind, source_locator_key, evidence_hash)`; the locator is never stored only in metadata;
- index `(user_id, source_message_id)` where message ID is present;
- index `(user_id, memory_id)` for evidence expansion.

Source-shape checks are exclusive:

- `source_kind = 'message'` requires `source_message_id`, `source_role = 'user'`, nonblank evidence, no `source_operation_id`, and a `source_locator_key` deterministically derived from the canonical message locator;
- `source_kind = 'manual_user'` requires a same-user `source_operation_id`, nonblank user evidence, no `source_message_id`, and a locator deterministically derived from that operation;
- future source kinds must define one stable, immutable locator and a mutually valid field shape before entering the vocabulary.

Validation required before insert:

1. Load the source message under the same `user_id`.
2. Confirm the message exists, its conversation matches, and its role is `user`.
3. Confirm `evidence_text` is an exact continuous substring of the stored message content under the declared normalization rule.
4. Reject question-only automatic admission.
5. Insert the memory, provenance and operation atomically.

### 4.3 Commit-time verified integrity

The controlled capture/consolidation/manual RPC inserts all required rows in one database transaction. A single `DEFERRABLE` constraint trigger performs final integrity validation at transaction commit; it does not implement capture business logic or mutate rows.

It rejects any final state where:

- `verified_user` lacks at least one same-user valid message provenance with `source_role = 'user'` and a legal source locator;
- `derived_verified` lacks valid same-user verified sources through consolidation lineage under the M1 rules;
- `manual_confirmed` lacks a same-user trusted manual provenance and operation locator.

The constraint is deferred so `memory_items`, provenance and relations can be inserted in any safe order within the same transaction. Direct insert grants cannot be used to create these verified states. This closes the verified-without-provenance state without introducing field-level triggers.

If the existing messages table can expose a compatible `unique (user_id, id)`, add a composite FK for existence/ownership. Role and exact-text matching still require transaction/application validation. If existing ID types do not match `text`, the migration design must adopt the real type rather than cast away FK integrity.

## 5. `memory_relations`

### 5.1 Columns and constraints

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | NO | Primary key |
| `user_id` | `text` | NO | Owner |
| `from_memory_id` | `uuid` | NO | New/derived side according to relation semantics |
| `to_memory_id` | `uuid` | NO | Old/source side according to relation semantics |
| `relation_type` | `text` | NO | `supersedes`, `consolidates`, `contradicts`, `duplicates`, `revalidates` |
| `operation_id` | `uuid` | NO | Composite FK to the creating operation |
| `created_at` | `timestamptz` | NO | Default `now()` |

- Both endpoints use composite FKs `(user_id, memory_id)` to prevent cross-user linkage.
- `check (from_memory_id <> to_memory_id)` forbids self-relations.
- Unique `(user_id, from_memory_id, to_memory_id, relation_type)` makes relation creation idempotent.
- `supersedes`, `consolidates`, `contradicts` and `revalidates` are directional.
- `duplicates` is semantically symmetric but stored once. The application/RPC canonicalizes the two UUIDs into ascending order; a relation-specific check enforces that stored order.

Directions:

- `new memory -> old memory` for `supersedes`;
- `stable memory -> source observation` for `consolidates`;
- newly evaluated memory -> conflicting memory for `contradicts`;
- canonical lower-ID memory -> higher-ID memory for `duplicates`;
- `new verified native memory -> old legacy memory` for `revalidates`.

### 5.2 Transaction validation

PostgreSQL `CHECK` constraints cannot reliably enforce graph acyclicity or inspect endpoint attributes. All semantic relation writes—`supersedes`, `revalidates`, `consolidates`, validated relation creation, related lifecycle/retrieval suppression and operation-ledger writes—must use a controlled PostgreSQL transaction function/RPC. Multiple ordinary Supabase requests are not a transaction.

The transaction function must:

- use a fixed `search_path` and a trusted server-derived `user_id`;
- lock the affected memory rows in stable ID order;
- validate equal user ownership again;
- reject a `supersedes` cycle using a recursive walk;
- require the `from` row of `revalidates` to be verified native and the `to` row to be `legacy_unverified`;
- require `consolidates` sources to be verified native observations and never legacy;
- insert the relation with `ON CONFLICT DO NOTHING` only after semantic validation;
- change old lifecycle/retrieval state and write the operation ledger in the same transaction;
- use expected `revision` values so stale proposals fail closed.

Protected roles receive no direct mutation grant on `memory_relations`. The service role can bypass RLS but must still call these mutation functions; runtime code must not use direct relation table writes. A recursive trigger is not needed.

Resurrection prevention queries filter lifecycle, retrieval tier, temporal validity, direct relations, `claim_key` and known duplicate-cluster membership before vector ranking. When a verified correction supersedes a legacy item, the affected legacy item and its known duplicate cluster are quarantined. Similarity, importance or an old embedding cannot bypass that filter.

Indexes:

- `(user_id, from_memory_id, relation_type)`;
- `(user_id, to_memory_id, relation_type)`.

The unique key already supports common exact-edge checks; no additional relation indexes are proposed initially.

## 6. `memory_embeddings`

### 6.1 Columns

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | NO | Primary key |
| `user_id` | `text` | NO | Owner |
| `memory_id` | `uuid` | NO | Composite FK to memory owner |
| `provider` | `text` | NO | Concrete provider |
| `model` | `text` | NO | Concrete model |
| `embedding_version` | `text` | NO | XiaoC logical version |
| `preprocessor_version` | `text` | NO | Exact input recipe |
| `dimensions` | `integer` | NO | Positive vector size |
| `content_hash` | `text` | NO | Must match the canonical input version |
| `embedding` | unbounded `vector` | NO | Successful vector only; requires pgvector prerequisite |
| `rollout_status` | `text` | NO | `active`, `shadow`, `retired`, `stale` |
| `created_at` | `timestamptz` | NO | Default `now()` |

Unique generation key:

```text
(user_id, memory_id, provider, model,
 embedding_version, preprocessor_version, content_hash)
```

This supports old active plus new shadow embeddings without overwriting. Generation uses `INSERT ... ON CONFLICT` on this identity, not a prior existence read. Generation failure is recorded in `memory_operations`; it creates no `memory_embeddings` row and no placeholder vector.

A partial unique constraint/index enforces at most one active embedding per memory:

```text
unique (user_id, memory_id)
where rollout_status = 'active'
```

Activation is a controlled database transaction: lock the memory's embedding rows, change the old active row to `retired`, change the selected `shadow` row to `active`, and complete the operation ledger atomically. Two active embeddings cannot survive commit.

The transaction validates that `content_hash` matches the associated immutable memory content. A vector-dimension check should use pgvector's supported dimension function after its installed version is confirmed. The unbounded `vector` column can store successful embeddings with different dimensions, but different dimensions can never participate in the same distance calculation.

### 6.2 Vector indexing

Do not create a vector index until provider, metric, dimensions and representative volume are known. For the current small dataset, exact search may be adequate and easier to validate.

If approximate indexing becomes necessary:

- prefer HNSW for read quality/operational simplicity unless measured workload supports IVFFlat;
- build a version-specific partial/expression index, for example conceptually on a cast to `vector(N)` and a single active/shadow version;
- include the chosen distance operator class explicitly;
- constrain `provider`, `model`, `embedding_version` and `dimensions` before distance calculation;
- apply `user_id`, lifecycle/retrieval/relations and version filters before ranking through a security-safe query/RPC plan;
- never compare scores from different embedding versions.

There is no cross-dimension generic ANN query. Every vector index and vector search is bound to one confirmed version and dimension.

Index DDL depends on the confirmed pgvector version and dimensions and is intentionally deferred.

## 7. `memory_pins`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | NO | Primary key |
| `user_id` | `text` | NO | Owner |
| `memory_id` | `uuid` | NO | Composite FK to memory owner |
| `scope` | `text` | NO | Initially `core` |
| `ordinal` | `integer` | NO | Nonnegative deterministic render order |
| `pin_status` | `text` | NO | `active`, `inactive` |
| `pinned_by` | `text` | NO | `user` or narrowly authorized migration actor |
| `operation_id` | `uuid` | NO | Composite FK to operation |
| `pinned_at` | `timestamptz` | NO | — |
| `unpinned_at` | `timestamptz` | YES | Required when inactive |

Constraints and indexes:

- composite FK to `memory_items` and same-user operation;
- unique `(user_id, memory_id, scope)`; toggling status is audited rather than inserting duplicate membership rows;
- partial unique `(user_id, scope, ordinal) where pin_status = 'active'`;
- index `(user_id, scope, pin_status, ordinal)`.

PIN apply must transactionally verify eligible native provenance, active lifecycle and permitted retrieval state. `legacy_pin_candidate` in the import map cannot satisfy this check. PIN is an association, Stable is a class, Dynamic is a query result, and Core remains the separately persisted conversation snapshot. No field turns them into a shared enum.

Existing `conversation_summary.core_memory_*` columns are unchanged. A future native Core source may namespace source IDs, but no existing snapshot is rewritten.

## 8. `memory_operations`

| Column | Type | Null | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | NO | Primary key |
| `user_id` | `text` | NO | Owner |
| `operation_type` | `text` | NO | Capture/import/consolidation/supersede/archive/restore/delete/pin/tier/embedding operations |
| `idempotency_key` | `text` | NO | Caller-derived stable key |
| `actor_type` | `text` | NO | `system`, `user`, `migration` |
| `policy_version` | `text` | NO | Policy that authorized the operation |
| `result_status` | `text` | NO | `started`, `success`, `failed`, `cancelled` |
| `reason_code` | `text` | YES | Bounded machine-readable reason |
| `affected_memory_ids` | `uuid[]` | NO | Default empty array |
| `before_state` | `jsonb` | YES | Compact mutable-field state/hash only |
| `after_state` | `jsonb` | YES | Compact mutable-field state/hash only |
| `compensates_operation_id` | `uuid` | YES | Same-user rollback lineage |
| `created_at` | `timestamptz` | NO | Default `now()` |
| `completed_at` | `timestamptz` | YES | — |

- Primary and alternate `(user_id, id)` keys.
- Unique `(user_id, operation_type, idempotency_key)` is the mutation admission key.
- Same-user FK for `compensates_operation_id`.
- Index `(user_id, created_at desc)` and `(user_id, result_status, created_at desc)`.
- The ledger uses one controlled row per operation. Its only normal state transition is `started -> success | failed | cancelled`.
- `id`, `user_id`, `operation_type`, `idempotency_key`, `actor_type`, `policy_version` and `created_at` are immutable.
- Only a controlled transaction function can update terminal status, result/error fields and `completed_at`.
- A terminal row cannot be modified again.
- Rollback/compensation creates a new operation referencing `compensates_operation_id`; it never rewrites the old terminal operation.
- Memory bodies, credentials and embeddings are excluded.

## 9. Legacy import tables

### 9.1 `memory_import_runs`

This table binds an import to the verified M0 archive without storing credentials or a machine-local absolute backup path.

| Column | Type | Null |
| --- | --- | --- |
| `id` | `uuid` | NO |
| `user_id` | `text` | NO |
| `source_system` | `text` | NO |
| `source_archive_sha256` | `text` | NO |
| `importer_version` | `text` | NO |
| `legacy_policy_version` | `text` | NO |
| `run_status` | `text` | NO |
| `source_file_count`, `planned_count`, `imported_count`, `rejected_count` | `integer` | NO, default `0` |
| `tier_statistics` | `jsonb` | NO, default `{}` |
| `validation_summary` | `jsonb` | NO, default `{}` |
| `created_at`, `completed_at` | `timestamptz` | completed nullable |

Unique import identity:

```text
(user_id, source_system, source_archive_sha256,
 importer_version, legacy_policy_version)
```

The run state is `planned`, `applying`, `complete`, `failed`, or `disabled`. Disabling a run is the non-destructive import rollback boundary.

Legacy item identity is independent of a particular snapshot run. A fixed, versioned namespace derives the canonical UUID deterministically from:

```text
user_id + source_system + legacy_external_id
```

The derivation uses a stable namespace UUID and documented UUIDv5-compatible normalization. It never generates a random memory ID and then competes on `legacy_memory_map`.

### 9.2 `legacy_memory_map`

| Column | Type | Null | Mutation |
| --- | --- | --- | --- |
| `id` | `uuid` | NO | Immutable |
| `user_id` | `text` | NO | Immutable |
| `import_run_id` | `uuid` | NO | Immutable composite FK |
| `memory_id` | `uuid` | NO | Immutable composite FK |
| `source_system` | `text` | NO | Immutable |
| `legacy_external_id` | `text` | NO | Immutable |
| `original_relative_path` | `text` | NO | Immutable, normalized and traversal-safe |
| `original_content` | `text` | NO | Immutable exact imported source content |
| `original_content_hash` | `text` | NO | Immutable SHA-256 |
| `original_metadata` | `jsonb` | NO | Immutable exact parsed metadata |
| `original_lifecycle_hints` | `jsonb` | NO | Immutable separate `archived/resolved/digested` hints |
| `legacy_pin_candidate` | `boolean` | NO | Immutable original PIN hint, default false |
| `original_archive_state` | `text` | YES | Immutable source archive state |
| `original_created_at`, `original_last_active_at` | `timestamptz` | YES | Immutable source timestamps |
| `original_activation_count` | `integer` | YES | Immutable nonnegative source value |
| `legacy_policy_version` | `text` | NO | Classification policy |
| `initial_retrieval_tier` | `text` | NO | Initial deterministic classification |
| `legacy_duplicate_cluster_id` | `text` | YES | Stable grouping for whole-cluster suppression |
| `created_at` | `timestamptz` | NO | Default `now()` |

Constraints:

- same-user composite FKs to import run and memory;
- unique `(user_id, source_system, legacy_external_id)`;
- unique `(user_id, import_run_id, original_relative_path)`;
- nonblank/path/hash/range checks;
- mapped memory must be `origin_system = ombre_legacy` and `provenance_status = legacy_unverified`, validated in the import transaction;
- no `memory_provenance` row is fabricated for this locator.

Legacy import is performed only by one database transaction function. It atomically writes `memory_operations`, the deterministic-ID `memory_items` row and `legacy_memory_map`. Repeating the same identity with the same original/canonical content hashes returns the existing mapping as an idempotent success. The same identity with a different hash fails closed and records no overwrite, silent update or second canonical memory. `original_relative_path` remains import metadata and never participates in canonical memory identity.

Ombre importance, pin, resolved, digested, archived and activation signals remain preserved inputs. They do not directly set native authority. Tier statistics are recorded per `ACTIVE / LOW_AUTHORITY / SHADOW_ONLY / QUARANTINE / DISABLED`, and later promotion/demotion is recorded in `memory_operations` without rewriting original import fields.

## 10. Idempotency by operation

| Operation | Database identity | Apply behavior |
| --- | --- | --- |
| Native capture | Operation unique key plus provenance unique key; recommended key includes user, source message, capture policy and normalized candidate hash | Insert operation/memory/provenance atomically; conflict returns prior result |
| Legacy import run | Archive/importer/policy unique key | Reuse completed run or resume explicit failed run; never duplicate silently |
| Legacy item | Deterministic UUID from user/source/external ID plus map unique keys | One RPC transaction returns existing identical hashes; mismatch fails without orphan or overwrite |
| Consolidation | Operation key derived from sorted source IDs, source revisions and policy version | Revalidate locked sources; return prior applied result on exact conflict |
| Relation | Unique edge key | `ON CONFLICT DO NOTHING` only after semantic validation |
| Embedding | Full version/content unique key plus one-active partial unique key | Return existing identical artifact; failure logs an operation only; activation retires old and activates shadow atomically |
| PIN/tier/lifecycle change | Operation key plus expected memory revision | Repeat returns prior result; stale revision fails closed |

No mutation relies only on “SELECT first, then INSERT.”

## 11. RLS and isolation

All eight tables enable RLS. Initial deployment is server-only:

- revoke table access from `anon` and direct client paths;
- create no permissive authenticated policy until XiaoC has a real auth-to-`user_id` mapping;
- service-role code must always filter the trusted server-derived `user_id`, because service role bypasses RLS;
- future authenticated policy can compare `user_id` with a trusted mapping or `auth.uid()::text`, but the current private value `user` must not be mistaken for an Auth UUID;
- transaction functions use a fixed `search_path`, explicit grants, and repeat owner checks internally;
- composite FKs prevent relations, embeddings, provenance, pins, operations and import mappings from crossing users even when application filtering is wrong.

RLS is one future user-access layer, not the sole isolation mechanism. Service-role bypass is contained by mandatory `user_id` columns, same-user composite FKs, trusted server-derived identity, protected transaction functions and removal of direct mutation grants. These constraints prevent user A provenance, relation, embedding or PIN rows from pointing at user B memory rows even when an application write is malformed.

RLS tests must cover select, insert, update, relation creation, vector RPC and import lookup with two synthetic users. The product remains single-user; these are storage isolation tests only.

## 12. Protected Mutation Boundary

Ordinary roles have no direct mutation grant for protected Memory Engine state. The service role also follows the same RPC boundary even though it can bypass RLS.

| Mutation | Required write path |
| --- | --- |
| Verified native capture plus provenance and operation | Controlled capture transaction function only |
| Derived verified consolidation | Controlled consolidation transaction function only |
| Manual confirmation plus manual provenance | Controlled manual-confirmation transaction function only |
| `supersedes`, `revalidates`, `consolidates` and other semantically validated relations | Controlled relation transaction function only |
| Relation-driven lifecycle/retrieval suppression | Same relation transaction; never a separate request |
| Legacy import | Controlled deterministic-import transaction function only |
| Embedding artifact insert | Controlled generation persistence function or tightly scoped repository insert after validation |
| Embedding activation/retirement | Controlled activation transaction function only |
| PIN activation, order change or removal | Controlled PIN transaction function with atomic operation ledger |
| Operation `started -> terminal` transition | The owning controlled transaction function only |

Read-only selects may use the repository with an explicit trusted `user_id`. No protected mutation is implemented as a sequence of independent Supabase requests. Future `api/memory.js` actions can call these RPCs without adding a Vercel Function.

## 13. Immutability enforcement

Use the smallest enforceable mechanism:

1. **Append-only by table policy:** `memory_provenance`, applied `memory_relations`, original fields in `legacy_memory_map`, and terminal `memory_operations` are not directly updated or deleted.
2. **One narrow DB trigger on `memory_items`:** reject changes to `user_id`, canonical content/hash, origin, class/category, provenance status, claim key, confidence, event/validity source fields, capture policy and creation time. Allow only audited lifecycle, tier, authority, importance, resolution timestamps, revision, bounded metadata and update time.
3. **Controlled transaction/RPC or repository mutation:** require operation ID and expected revision for allowed state changes.
4. **Append-only table grants plus a small guard trigger where service-role bypass makes grants insufficient:** provenance source locators including `source_locator_key`, legacy external identity/original source fields and terminal operation history merit DB protection. A separate trigger for every column/table is unnecessary; one reusable immutable-column guard can serve these tables.
5. **One deferred integrity constraint:** the commit-time verified-provenance constraint described above checks final cross-table integrity. It is not a business workflow trigger.

`metadata` is extension-only. Validation rejects reserved keys that attempt to duplicate or override provenance locators, legacy identity, canonical content/hash, user identity or relation identity.

Correction is always `insert new memory -> insert relation -> transition old row`, in one audited transaction. It never updates canonical historical content.

## 14. Retrieval query boundary

The retrieval repository/RPC returns:

- `provenance_status`
- `lifecycle_status`
- `retrieval_tier`
- `authority_tier`
- `claim_key`
- `suppression_reason`

The physical query is staged:

```text
trusted user_id + requested embedding version
  -> lifecycle / retrieval eligibility
  -> claim suppression
  -> supersedes / revalidates / duplicate-cluster suppression
  -> temporal validity
  -> eligible row IDs only
  -> provider / model / embedding version / dimensions
  -> embedding candidate selection and vector ranking
  -> relevance / novelty / Core and cross-context suppression
  -> budgeted results
```

Every deterministic suppression step occurs before vector top-k. An approximate vector index must never search globally and filter user/status only after top-k selection. Shadow queries use a separate authorized mode and cannot promote `shadow_only`, `quarantined` or `disabled` rows into production prompt context.

## 15. Index plan

Create only indexes supporting known access paths:

| Table | Index |
| --- | --- |
| `memory_items` | `(user_id, lifecycle_status, retrieval_tier, created_at desc)` |
| `memory_items` | `(user_id, claim_key, lifecycle_status, valid_from desc, created_at desc) where claim_key is not null` |
| `memory_items` | `(user_id, created_at desc)` |
| `memory_items` | `(user_id, valid_until) where valid_until is not null and lifecycle_status = 'active'` |
| `memory_provenance` | `(user_id, source_message_id) where source_message_id is not null` |
| `memory_provenance` | `(user_id, memory_id)` |
| `memory_relations` | `(user_id, from_memory_id, relation_type)` and reverse endpoint equivalent |
| `memory_embeddings` | `(user_id, memory_id, rollout_status)` and `(user_id, provider, model, embedding_version, rollout_status)`; vector index deferred |
| `memory_pins` | `(user_id, scope, pin_status, ordinal)` |
| `memory_operations` | `(user_id, created_at desc)` and pending/result lookup |
| `legacy_memory_map` | Unique legacy identity; `(user_id, legacy_duplicate_cluster_id)` where present |

Do not add generic JSONB GIN, category, importance or standalone timestamp indexes until measured queries require them.

## 16. Future migration ordering

This is execution order for a later approved migration, not SQL to run now:

1. Inspect actual production column types and constraints read-only, especially message/conversation IDs and user ownership keys.
2. Confirm prerequisites (`gen_random_uuid`; pgvector and supported version only if embeddings are created in that migration).
3. Create text vocabulary checks/helper functions and the reusable immutability guard.
4. Create `memory_operations` first because relations, pins and state changes reference it.
5. Create `memory_items` and its composite owner key.
6. Create `memory_import_runs`.
7. Create `memory_provenance` with compatible message/conversation references where possible.
8. Create `memory_relations`.
9. Create `memory_embeddings` only after pgvector/dimensions are confirmed; it may safely be deferred to a separate migration.
10. Create `memory_pins`.
11. Create `legacy_memory_map` and import-run links.
12. Add the minimal B-tree/partial indexes.
13. Enable RLS, revoke direct grants, add only required server/function grants.
14. Install immutable/append-only guards and transactional mutation functions.
15. Validate constraints, two-user isolation, idempotency and empty-table query plans.
16. Confirm existing Ombre/current-memory/chat paths behave identically with all new feature gates off.

Tables can exist empty and fully bypassed. No data copy, trigger on existing tables, Core Snapshot change, runtime import, vector generation or read-source switch belongs in the schema migration.

## 17. Rollback

The physical schema is additive and namespaced away from the existing `memories` and `conversation_summary` runtime paths. With all new read/write gates off:

- Ombre remains authoritative;
- current Supabase `memories` behavior remains unchanged;
- existing Stable Memory and Memory/Context Gateway remain unchanged;
- existing Core snapshots continue reading persisted text and Ombre source IDs;
- chat does not query the new tables.

Before any imported/native data is used, rollback is simply disabling the unused schema path; dropping tables is unnecessary. Later import rollback disables an import run and native read gate without deleting rows. Later retrieval rollback switches new reads to Ombre. Operation and relation history support compensating state changes. Embedding rollback selects the prior version.

## 18. Schema consistency review

1. **Four dimensions independent:** yes. Provenance, lifecycle, retrieval tier and authority have separate typed columns and constraints. Confidence/importance/similarity remain separate.
2. **PIN/Core/Stable/Dynamic orthogonal:** yes. PIN is an association, Core remains a frozen conversation artifact, Stable is `memory_class`, Dynamic is a retrieval result.
3. **Legacy preserved without fake provenance:** yes. Original Ombre identity/content/metadata live in import tables; unverified legacy has no verified provenance row.
4. **Deterministic conflict suppression:** yes. User scope, status, temporal state, claim key, relations and duplicate cluster filter before vector rank.
5. **Cross-user relations prevented:** yes. Composite owner FKs cover every child/edge table.
6. **Embeddings independently versioned:** yes. Full provider/model/preprocessor/version/content identity permits active plus shadow rows.
7. **Corrections preserve history:** yes. Canonical content is immutable and correction creates a new memory plus relation.
8. **Rollback supported:** yes. The schema is additive and unused by current runtime; later capability gates remain independent.
9. **Over-engineering check:** pass. Only six M1 core tables and two required import-control tables are proposed; vector index and stronger claim uniqueness are deferred.
10. **Vercel boundary:** pass. A future implementation can use repository functions and actions inside existing `api/memory.js`; no new Serverless Function is required.

## 19. Open implementation prerequisites, not M1 blockers

- Confirm real production types and owner constraints for message and conversation IDs before writing any FK.
- Confirm pgvector availability/version, embedding dimensions and distance metric before creating `memory_embeddings` vector indexes.
- Define exact canonical content/evidence normalization and SHA-256 versioning.
- Define the first deterministic authority and legacy classification policy versions.

These choices affect a future executable migration but do not make M1 physically incompatible. They must be resolved and reviewed before SQL is applied.
