# XiaoC Memory Engine — M2D Historical Import Design

> Status: COMPLETE — schema hardening applied and transactionally validated; production historical import completed 150/150 on 2026-09-09.
> Scope: deterministic historical preservation only. This document does not authorize an import, a retrieval switch, embeddings, or production runtime changes.

## 1. Decision and boundary

M2D adopts **full migration, conservative retrieval**. Migration eligibility is based on source integrity and deterministic identity; retrieval eligibility remains an independent policy decision.

The import target is exactly 150 canonical Ombre records. Every imported record must have:

- `origin_system = ombre_legacy`;
- `provenance_status = legacy_unverified`;
- `memory_class = observation`;
- no native provenance row;
- no native PIN, Core membership, Stable consolidation, embedding, or proactive-attention eligibility.

M2C.1 is rejected. Its classifier artifact is not an input to migration eligibility, classification, ordering, or verification. No external model is needed for M2D.

Import completion did not enable reads. Ombre remains the production Memory source and the XiaoC Memory Engine remains a stored shadow copy.

## 2. Source lock

The implementation must fail before opening an import run unless both immutable inputs match:

| Input | Path | Required SHA-256 | Verified in this review |
|---|---|---|---|
| M0 archive | `/Users/hxj/XiaoC-Backups/ombre-volume-snapshot-2026-09-08.tar.gz` | `a96b8d211899e6a00dbcd40d42639293fb7ddc0a31a1430f44866e44876d3178` | PASS |
| M2C manifest | `tmp/xiaoc-memory-engine-m2c-manifest.json` | `861325ac1b3c8b22ce6b4aa124239c66dee08e263bceda43d5bd75930be070db` | PASS |

The locked manifest contains 150 entries with 150 unique legacy identities and deterministic Memory IDs. The future implementation must also verify:

1. manifest `source_archive_sha256` equals the locked archive hash;
2. every relative path is safe and resolves inside the extracted snapshot;
3. the exact UTF-8 body hash equals the entry `content_hash`;
4. the entry UUID equals UUIDv5 namespace `f1c7e436-ff13-5d2c-8e4a-5de7386b6db7` over `user_id + chr(31) + source_system + chr(31) + legacy_external_id`;
5. there are no duplicate external IDs, relative paths, hashes-to-identity conflicts, or deterministic UUIDs;
6. the classification overlay below covers every ID exactly once.

Any failure stops the run before Supabase writes.

## 3. Classification contract

The fixed initial distribution is:

| Retrieval tier | Authority tier | Count | Initial lifecycle |
|---|---|---:|---|
| `active_legacy` | — | 0 | — |
| `low_authority` | `legacy_limited` | 6 | `active` |
| `shadow_only` | `none` | 95 | `active` |
| `disabled` | `none` | 49 | `active` |
| **Total** | | **150** | |

The 49 archive records use `active + disabled` because the existing import RPC creates `lifecycle_status = active`. Their source archive state and lifecycle hints remain in `legacy_memory_map`. M2D must not update them directly to `archived`. A future archived lifecycle representation requires a separately reviewed protected transition.

The 95 `shadow_only` records are stored for lineage and future revalidation. They are ineligible for production retrieval, Core, Stable, PIN, and proactive attention.

### 3.1 Locked low-authority allowlist

The following six entries are the complete allowlist. The first is the original M2C deterministic classification. The other five were approved by the Historical Continuity Review. Review reason codes below form an M2D overlay; the immutable M2C manifest is not rewritten.

| Legacy external ID | Content hash | Deterministic Memory ID | Approval reason codes |
|---|---|---|---|
| `ffb8ce86aa3b` | `0458ba7f6948ed79cf9ac8f6d66fe1270c5c49beab3ea6edf9c0e35be3a15244` | `138b5bab-70f6-52b6-a183-23a1427677a5` | `LOW_RISK_DYNAMIC_DOMAIN`, `LEGACY_UNVERIFIED`, `STRONG_RELEVANCE_REQUIRED` |
| `632959ffb312` | `63409c97c8ce34bdb88f749fcbea405ebd35a928e66ad87d3a138eaad791d7b6` | `61ccb041-bb0d-5a8c-98a5-811bec2cbd44` | `HISTORICAL_CONTINUITY_REVIEW_APPROVED`, `EXPLICIT_PAST_FRAMING`, `NO_HIGH_AUTHORITY_MARKER` |
| `8815e2b2c20a` | `66df447a878f179aaccbac98c90bbdd741a6debfb0ae920973f3d68172417a72` | `6f4f6e34-797d-51c4-ac35-c20b3482bd2e` | `HISTORICAL_CONTINUITY_REVIEW_APPROVED`, `HISTORICAL_EVENT_SIGNAL`, `NO_HIGH_AUTHORITY_MARKER` |
| `f4c1457bd8d3` | `4b88854ce96d0f4034bbfd18314eabfdd446a45d307ed86c2975735d4c90ffbb` | `247db878-608d-5a61-8685-1a40889f45c8` | `HISTORICAL_CONTINUITY_REVIEW_APPROVED`, `HISTORICAL_EVENT_SIGNAL`, `NO_HIGH_AUTHORITY_MARKER` |
| `1d16fc964753` | `54398556b3fa29cb00a29cc1b17dcb3eff72f72a6664b0cf668215255925c1d8` | `efdc6744-44c5-524c-b9bd-5c8777831a8d` | `HISTORICAL_CONTINUITY_REVIEW_APPROVED`, `EXPLICIT_PAST_FRAMING`, `NO_HIGH_AUTHORITY_MARKER` |
| `b4db8014d06e` | `4f0bbdc4de42a4631d16dcec1bdecf0c7a4c7024e5eb02a37689267f8ea2cafe` | `faffc464-49d1-5db7-b9f6-b435ed1141b7` | `HISTORICAL_CONTINUITY_REVIEW_APPROVED`, `HISTORICAL_EVENT_SIGNAL`, `NO_HIGH_AUTHORITY_MARKER` |

Implementation must compare all three identity fields, not only the 12-character external ID. A mismatch fails closed. No record outside this table may receive `low_authority`.

## 4. Import contract

The importer must use the protected `xiaoc_memory_import_legacy` RPC once per manifest entry. It may not insert or update protected tables directly, even with an administrative or service-role session.

For every call:

- `source_system` is exactly `ombre`;
- `legacy_external_id`, path, source metadata and lifecycle hints come from the locked manifest/source;
- `p_original_content` is the exact source body and `p_original_content_hash` is its locked hash;
- `p_memory_class` is exactly `observation`;
- `p_initial_retrieval_tier` comes only from the fixed classification overlay;
- authority is derived by the RPC: `legacy_limited` only for `low_authority`, otherwise `none`;
- policy and importer versions are fixed for the whole run.

The client must independently recompute the deterministic UUID and require the RPC return value to match it. It must never log or persist the Memory body outside the local source and the user's Supabase.

## 5. Import run state machine

The required state machine is:

```text
planned -> applying -> complete
                    -> failed
complete/failed -> disabled   (compensating rollback when eligible)
```

`running` in the product plan maps to the existing database value `applying`; no second synonym should be introduced.

### 5.1 Run identity

A run is identified by the existing unique tuple:

```text
(user_id, source_system, source_archive_sha256,
 importer_version, legacy_policy_version)
```

The run contract must additionally bind the manifest SHA-256, expected count 150, deterministic-order digest, and classification digest. The current table has no dedicated manifest-hash columns; these values can be stored in a protected, immutable run contract field only after schema hardening. They must not live solely in client logs.

### 5.2 Required protected transitions

A protected run-control RPC must atomically:

1. move `planned` to `applying` after validating the locked contract;
2. reject changes to source identity, policy, expected count, manifest digest, order digest, or classification digest;
3. derive counts from database rows rather than trust client counters;
4. move `applying` to `complete` only after all verification predicates pass;
5. record `completed_at`, imported/idempotent/failure counts, tier statistics, and validation summary;
6. move a non-complete run to `failed` with a bounded reason code;
7. refuse terminal-state mutation except through an explicit compensating disable operation.

The existing `xiaoc_memory_create_import_run` only creates or returns a `planned` row. No protected RPC currently performs these transitions or updates the counters. Direct updates are revoked from `service_role`. This is a blocking schema gap.

## 6. Deterministic execution and restart safety

Entries are sorted by `legacy_external_id` ascending using bytewise/C-locale ordering. The ordered sequence of `(legacy_external_id, content_hash, deterministic_memory_id, retrieval_tier)` is hashed and bound to the run before applying begins.

For each entry, the importer records only the ID, expected hash, returned UUID, disposition (`created` or `idempotent`), and bounded error code. It never records content.

If the connection fails after item 73, the same run is resumed from the same locked plan:

- the first 73 same-identity/same-hash calls return the existing canonical IDs;
- the remaining calls create the missing rows;
- same identity with a different hash fails closed;
- a returned UUID different from the expected deterministic UUID fails closed;
- the run cannot become `complete` while any entry is missing or conflicting.

The existing import RPC already provides same-identity/same-hash idempotency and different-hash rejection. Restart safety is therefore achievable once the run control plane is protected. A different importer or policy version must not silently adopt rows from another run; cross-run reuse requires an explicit verified reconciliation rule.

## 7. Write-after verification contract

Completion is a database decision. Client success count is only diagnostic. The protected finalization path must check the exact run scope through `legacy_memory_map.import_run_id`, joined to canonical items and operations.

All predicates below are mandatory:

- exactly 150 `legacy_memory_map` rows belong to the run;
- exactly 150 distinct mapped `memory_items` exist for the same user;
- all 150 have `origin_system = ombre_legacy`, `memory_class = observation`, `provenance_status = legacy_unverified`, and `lifecycle_status = active`;
- classification is exactly `active_legacy=0`, `low_authority=6`, `shadow_only=95`, `disabled=49`;
- authority is exactly `legacy_limited=6`, `none=144`;
- every canonical `content_hash` equals the map hash and the locked manifest hash;
- all 150 deterministic UUIDs match the production UUIDv5 algorithm;
- every mapped identity/path is unique and matches the locked manifest;
- each created item has a successful, matching `legacy_import` operation; idempotent replays are classified separately and do not create duplicate operations;
- no new native provenance row exists for mapped IDs;
- PIN count for mapped IDs is zero;
- embedding count for mapped IDs is zero;
- no mapped record is `stable` or has a Core PIN;
- no mismatch, rejection, unfinished import operation, or unexpected row exists.

Verification output contains IDs, hashes, counts, and bounded reason codes only. It must never return Memory bodies or source metadata containing body text.

## 8. Rollback design

Rollback is a compensating **logical disable**, not manual deletion. Historical source rows and operation history must remain available for lineage and audit.

A new protected rollback RPC is required. Given `(user_id, import_run_id, expected run-contract digest, idempotency key)`, it must run in one transaction and:

1. lock the run and require it to be the exact target run;
2. derive the target set solely from `legacy_memory_map` for that user and run;
3. require every target to remain `ombre_legacy` and `legacy_unverified`;
4. fail if the target set differs from the locked run contract;
5. fail if any target has acquired native provenance, a PIN, an embedding, a relation, a verified descendant, or another post-import dependency that requires separate reconciliation;
6. set every eligible target to `retrieval_tier=disabled`, `authority_tier=none`, incrementing `revision` through the protected path;
7. create one compensating operation ledger record with the exact affected IDs and previous tier counts;
8. transition the run to `disabled` only after every target is disabled;
9. be idempotent when the same compensation key is repeated;
10. leave native Memory, other users, other import runs, current runtime tables, and Ombre untouched.

Physical deletion is incompatible with the current append-only `legacy_memory_map` and `memory_operations` guards and is unnecessary while the new engine is disconnected. The current schema has no protected batch rollback/disable RPC and no retrieval rule tied to `run_status`; merely setting a run status would not suppress the six `low_authority` items. Rollback capability is therefore a blocking gap.

## 9. Privacy and runtime isolation

- Historical bodies may be read locally only to verify hashes and form the future Supabase RPC payload.
- Bodies must not be printed, written to docs or logs, or sent to classifiers or any external model.
- The only future remote destination permitted for import bodies is the user's existing Supabase project.
- No embedding provider is called.
- Runtime retrieval remains off for the new engine.
- No shadow-read, comparison, Context Gateway integration, Memory Judge integration, or proactive-attention integration occurs in M2D.
- Ombre remains unchanged and continues as the production source.

## 10. Schema gap review

| Area | Current capability | Verdict |
|---|---|---|
| Per-record deterministic import | Protected RPC verifies body hash, computes UUIDv5, preserves legacy identity, and fails closed on hash conflict | Sufficient |
| Fixed `memory_class` | RPC accepts caller-supplied `p_memory_class`; schema permits `stable` | **Blocking: enforce `observation` for legacy imports** |
| Retrieval/authority pairing | Table checks and RPC-derived authority enforce valid combinations | Sufficient |
| Fixed classification plan | RPC accepts any valid legacy tier and does not bind an allowlist/classification digest | **Blocking: bind and validate the run plan** |
| Run lifecycle | Table has states and counters; only protected create RPC exists | **Blocking: add protected start/fail/finalize transitions** |
| Run contract | Archive hash/version/count exist; manifest, order, and classification digests are absent | **Blocking: persist immutable run contract** |
| Exact read-back | Map has `import_run_id`; joins can scope rows precisely | Sufficient after protected finalizer exists |
| Operation audit | Each newly created legacy item gets a successful operation, but operation identity does not contain `import_run_id` | Needs finalizer to reconcile via mapped IDs; adding explicit run linkage is preferred |
| Archive representation | `active + disabled`, with original archive state preserved in map | Safe for M2D |
| Restart/idempotency | Same run and same hash are idempotent; different hash fails closed | Sufficient with locked run identity |
| Rollback | No protected batch compensation; append-only guards prevent manual cleanup | **Blocking: add protected rollback/disable RPC** |
| Direct mutation | Revoked for `service_role`; required missing actions cannot be done safely today | Must remain forbidden |

## 11. Implementation gate

No executable importer should be created yet. M2D implementation becomes eligible only after an additive schema-hardening migration and transactional validation establish:

1. immutable run contract storage;
2. protected `planned -> applying -> complete/failed` transitions and derived statistics;
3. database enforcement that legacy imports are `observation` and match their locked tier plan;
4. protected, idempotent compensation that disables only the exact run;
5. exact read-back verification without exposing content;
6. continued denial of direct protected-table mutation.

The design review concluded **M2D SCHEMA HARDENING REQUIRED**. The additive hardening and its transactional production validation have since passed, satisfying that gate.

## 12. Schema hardening implementation (2026-09-09)

The forward-only migration `supabase_xiaoc_memory_engine_m2d_hardening.sql` implements the M2D database boundary. It was applied manually to production and the transactional validation passed with all fixtures rolled back.

The hardened contract adds immutable source snapshot, manifest, execution-order and classification digests, an exact expected record count, and a policy version to each import run. An immutable `memory_import_plan_items` table stores all 150 approved identities, hashes, deterministic IDs, retrieval tiers, authority tiers and bounded reason codes. The database recomputes the plan digests, requires the exact `0 / 6 / 95 / 49` distribution, rejects `active_legacy`, and restricts `low_authority` to the six reviewed entries.

Protected RPCs now own `planned -> applying -> complete` and `planned/applying -> failed`. Completion is only possible after database read-back verifies all plan/map/item/operation joins, identity and hash agreement, exact classification counts, legacy provenance, observation class, and zero provenance, PIN or embedding rows for the imported set. Validation failure leaves the run in `applying`; callers may inspect the bounded failure and explicitly invoke the protected fail transition. This preserves retryability and prevents a transient or repairable validation error from silently making the run terminal.

`memory_operations.import_run_id` provides typed, same-user lineage from run to operation, while the immutable plan and existing map provide the deterministic path from run to canonical Memory. Run creation, start, item import, finalize, fail and rollback are auditable without recording Memory bodies in the operation ledger.

Rollback is a protected atomic compensation. A `complete` run may transition to terminal `disabled`; a `failed` run is eligible only when its full 150-row target still matches the locked contract. The same idempotency key returns the existing successful compensation. Rollback disables retrieval and removes legacy authority while retaining canonical Memory, the legacy map, plan and operation history. Any provenance, PIN, embedding, relation (including supersedes, revalidates or consolidation lineage), non-legacy target, incomplete target set or cross-user scope fails closed. No descendant or audit record is cascade-deleted.

Runtime retrieval remains off and Ombre remains authoritative.

## 13. Historical Import Implementation and final dry-run (2026-09-09)

The importer is implemented at `scripts/xiaoc-memory-engine-historical-import.js`. Its default mode is `--dry-run`. It verifies both locked source hashes, builds and validates the complete 150-entry plan in memory, checks archive/manifest coverage, recomputes every content hash and UUIDv5 identity, applies the exact six-entry allowlist, and computes the two database-compatible digests before any Supabase client is created.

### 13.1 CLI safety contract

- No arguments and explicit `--dry-run` are equivalent and perform no external request.
- `--apply` requires the additional exact `--confirm-source-sha` value. Missing or incorrect confirmation fails before client creation.
- Conflicting modes are rejected.
- Apply uses only the protected create, start, item-import and finalize RPCs, plus a read-only import-run status query.
- `--rollback=<import_run_id>` requires the same source confirmation and calls only the protected rollback RPC.
- No command performs direct insert, update, delete or upsert against protected tables.
- Memory bodies exist only in local process memory and, during a future authorized apply, in protected Supabase import RPC payloads. Console and dry-run artifacts exclude them.

### 13.2 Resume and rollback semantics

An interrupted apply is rerun with the identical command and locked inputs. A `planned` run is started; an `applying` run resumes; a `complete` run exits successfully. Replayed entries rely on the validated same-identity/same-hash RPC behavior, while a different-hash conflict stops before finalization. Network failures do not mark a partial run terminal, preserving restart safety.

Rollback is explicit and compensating. It uses the current classification digest and the protected `xiaoc_memory_rollback_import_run` RPC. It never deletes or directly updates Memory rows.

### 13.3 Final dry-run result

The real locked M0 archive and original M2C manifest produced:

| Check | Result |
|---|---|
| Snapshot SHA-256 | PASS |
| Manifest SHA-256 | PASS |
| Canonical/archive/plan coverage | 150 / 150; missing 0; unexpected 0 |
| Content hashes | 150 / 150 PASS |
| Deterministic IDs | 150 / 150 PASS |
| Classification | `active_legacy=0`, `low_authority=6`, `shadow_only=95`, `disabled=49` |
| Allowlist | 6 / 6 PASS |
| Duplicate canonical identities | 0 |
| Classification digest | `0e77a92da8a5c530ff5fde7d9acaa6e9591f840aead8106c453fe3e5d066ee1e` |
| Execution-order digest | `5c47bb9291f2656731da21b877aafbf348a1396cf001e48671c562afb8e3b959` |
| External requests / Supabase writes | 0 / 0 |

The content-free result is stored at `tmp/xiaoc-memory-engine-historical-import-dry-run.json`. This dry-run was the pre-apply gate; the authorized production import subsequently completed as recorded below.

## 14. Production historical import completion (2026-09-09)

The authorized historical import completed without enabling XiaoC retrieval:

- import run: `8f80b744-2db8-4f78-85a3-78a2cfec679d`;
- run state: `completed`;
- processed / created / failed: `150 / 150 / 0`;
- database read-back: `memory_items=150`, `legacy_memory_map=150`;
- retrieval tiers: `active_legacy=0`, `low_authority=6`, `shadow_only=95`, `disabled=49`;
- provenance: `legacy_unverified=150`;
- content hashes and deterministic IDs: `150/150 PASS`;
- operations: `153 PASS` (`run create=1`, `run start=1`, `legacy import=150`, `finalize=1`);
- native verified provenance, native PINs, and embeddings created: `0 / 0 / 0`.

The first apply attempt stopped on PostgreSQL `42501` at the deferred integrity trigger. The forward-only permission fix changed the deferred trigger function to a fixed-search-path, postgres-owned `SECURITY DEFINER` boundary without restoring caller access to the private helper or direct protected-table mutation. Validation passed, the same run resumed, and no rollback or re-import is required.

Ombre remains the production retrieval source. Completion of historical preservation does not authorize shadow read, embedding generation, Context Gateway integration, or cutover.
