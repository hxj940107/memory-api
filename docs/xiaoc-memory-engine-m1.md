# XiaoC Memory Engine M1 Architecture Proposal

> Status: Design only  
> Date: 2026-09-08 (Asia/Shanghai)  
> Scope: canonical data model, service contracts, legacy mapping, shadow-read and rollback boundaries.  
> This document is not a database migration, import plan execution, or production cutover authorization.

## 1. Goal and non-goals

M1 defines the durable boundary for a XiaoC-owned Memory Engine. It must preserve the current companion experience while making memory identity, evidence, consolidation, retrieval and rollback independently auditable.

M1 does not:

- modify, delete, or stop production Ombre;
- import historical memory;
- generate or regenerate embeddings;
- change the production retrieval source, chat prompt, Core Snapshot, or chat behavior;
- implement deep retrieval, long-term heat/cold/archive automation, or migration SQL;
- add account switching, teams, organizations, billing, or public SaaS behavior.

Although XiaoC remains a private single-user product, `user_id` is a mandatory isolation boundary. This prevents accidental cross-user reads in storage, indexes, caches, jobs and future tooling; it is not a product-level multi-user feature.

## 2. Decisions

1. A memory is a canonical claim with stable identity, lifecycle and evidence. An embedding is a replaceable derived artifact, not the memory itself.
2. Provenance is stored as first-class rows. It must not live only in an opaque metadata JSON object.
3. Corrections and consolidation create new records and explicit relations. They do not silently overwrite or delete source observations.
4. `PIN`, `Core`, `Stable`, and `Dynamic` are different dimensions:
   - **Stable** is a memory class.
   - **PIN** is an explicit curated selection attached to a memory.
   - **Core** is a conversation-stable rendered snapshot of the PIN selection.
   - **Dynamic** is a retrieval path and result set, not a stored memory class.
5. Factual Memory remains separate from Active Context and Proactive Attention. Retrieval, ranking or prompt inclusion never grants proactive eligibility.
6. Legacy rows with no verifiable message evidence retain `provenance_status = legacy_unverified`. Provenance status does not by itself decide lifecycle or retrieval eligibility: deterministic classification may admit safe historical memories at lower authority, while damaged, conflicting or unowned records are quarantined. No provenance is invented.
7. Ombre remains authoritative until shadow-read gates pass and a separately approved cutover occurs. Existing Core snapshots are never rewritten during migration.
8. A future implementation must reuse the existing API function boundary, normally through an action/type branch in `api/memory.js`; it must not add a thirteenth Vercel Function.

## 3. Canonical model

The following is a logical schema. Names and types may be adjusted when a later migration is written, but the semantics and constraints are part of this proposal.

### 3.1 `memory_items`

One row represents one immutable version of a claim. A correction produces a new row linked by `supersedes`; only explicitly mutable policy and lifecycle fields may be updated with optimistic concurrency.

| Field | Meaning |
| --- | --- |
| `id` | Stable native memory ID. |
| `user_id` | Required isolation owner; same canonical type as the existing user/message owner key. |
| `memory_class` | `observation` or `stable`. |
| `category` | Semantic category such as `personal_fact`, `relationship_memory`, `relationship_preference`, `meaningful_experience`, or `long_term_concern`. Extensible without changing layer semantics. |
| `origin_system` | Immutable origin marker such as native XiaoC capture or legacy Ombre import. |
| `content` | Canonical concise claim in XiaoC's relationship perspective. |
| `content_hash` | Hash of normalized canonical content for idempotency and change detection. |
| `provenance_status` | `verified_user`, `derived_verified`, `manual_confirmed`, or `legacy_unverified`. It describes source verifiability only. |
| `lifecycle_status` | `active`, `superseded`, `archived`, or `deleted`. It describes retention and lifecycle only. |
| `retrieval_tier` | `active_legacy`, `low_authority`, `shadow_only`, `quarantined`, or `disabled`. Native verified eligibility is governed by native policy rather than an `active_legacy` value. |
| `authority_tier` | A deterministic policy result derived from provenance and retrieval policy; never copied from model confidence, importance or semantic score. |
| `claim_key` | Optional stable identity for a mutable claim, used for deterministic conflict, supersedes and resurrection suppression. It is not a hardcoded global taxonomy. |
| `confidence` | Evidence/extraction confidence only; not authority, importance, semantic relevance or conversational attention. |
| `event_time` | Optional time the remembered event/fact applies to. |
| `valid_from`, `valid_until`, `resolved_at` | Explicit temporal validity for facts, preferences, plans and completed/resolved items. |
| `created_at`, `updated_at` | Persistence timestamps. |
| `superseded_at`, `archived_at`, `deleted_at` | Nullable timestamps consistent with `lifecycle_status`. |
| `capture_policy_version` | Version of deterministic validation and judge contract that admitted the row. |
| `revision` | Monotonic value used for optimistic, rollback-safe updates. |

Deliberately absent from this table:

- no embedding vector or embedding model fields;
- no `is_dynamic` or `is_core` flag;
- no conversational attention, proactive eligibility, or current-topic state;
- no single `metadata` blob as the only source of lineage;
- no heat score in M1. Heat, importance, semantic relevance, novelty and attention have different meanings and must not be collapsed into one score.

The four status dimensions are independent:

- `provenance_status` answers whether the source can be verified;
- `lifecycle_status` answers whether the record is current, superseded, archived or deleted;
- `retrieval_tier` answers whether and how the record can participate in retrieval;
- `authority_tier` expresses deterministic factual authority.

For example, an intact historical memory may be `legacy_unverified + active + low_authority`. A damaged record may be `legacy_unverified + active + quarantined`. Neither becomes verified merely because it is retrievable.

`user_id`, `origin_system`, canonical `content`, `content_hash`, evidence source locators and legacy external identity are immutable. Correcting content always creates a new memory and an explicit relation; it never edits the historical claim in place.

### 3.2 `memory_evidence`

Evidence rows answer “why is XiaoC allowed to believe this?”

| Field | Meaning |
| --- | --- |
| `id`, `user_id`, `memory_id` | Evidence identity and same-user ownership. |
| `source_type` | `message`, `manual_user`, or `legacy_import`. Memory-to-memory lineage belongs in `memory_relations`. |
| `source_message_id`, `source_conversation_id` | Nullable locator for native message evidence. |
| `source_role` | `user`, `assistant`, `system`, or `unknown`. |
| `evidence_type` | `assertion`, `confirmation`, `correction`, `question`, or `other`. |
| `evidence_quote` | Bounded exact excerpt when available; never a generated paraphrase presented as a quote. |
| `evidence_hash` | Hash of the normalized excerpt/source payload for later verification. |
| `source_system`, `source_external_id` | Legacy system and immutable external ID when applicable. |
| `provenance_quality` | Evidence-level validation detail. The memory-level result is recorded separately in `memory_items.provenance_status`. |
| `observed_at`, `created_at` | Source time and evidence persistence time. |

Native automatic capture may use `lifecycle_status = active` only when at least one verified user-message evidence row exists and the quoted text is validated against that message. A question alone is insufficient. Assistant text may help interpretation, but it can never be the sole evidence for a user fact.

Evidence excerpts should be short enough to avoid duplicating whole conversations. Full source text remains in the message store and is loaded only when verification is required.

### 3.3 `memory_relations`

This table carries directed, same-user lineage between memories.

| Field | Meaning |
| --- | --- |
| `user_id`, `from_memory_id`, `to_memory_id` | Composite same-user endpoints. |
| `relation_type` | `supersedes`, `consolidates`, `contradicts`, `duplicates`, or `revalidates`. |
| `operation_id` | The audited operation that created the edge. |
| `created_at` | Relation time. |

Direction is explicit:

- `new stable -> old stable` for `supersedes`;
- `stable -> source observation` for `consolidates`;
- `new verified memory -> old legacy memory` for `revalidates` when new real user evidence independently confirms the same claim;
- the newly evaluated memory points to the conflicting or duplicate memory for the other relations.

`revalidates` is a non-evidentiary lineage relation. It does not backfill provenance into the old legacy row, make legacy content evidence for the new row, or promote the old row to a verified status. If the new user evidence corrects the old claim rather than confirming it, the relation is `supersedes`.

The storage layer must reject self-edges, cross-user edges and cycles in `supersedes`. A supersede apply is atomic: insert the new memory, evidence/lineage and operation record, then mark the old memory superseded in one transaction. Source observations are retained.

### 3.4 `memory_embeddings`

Embeddings are independently versioned derived data.

| Field | Meaning |
| --- | --- |
| `user_id`, `memory_id` | Same-user owner and source memory. |
| `provider`, `model`, `dimensions` | Concrete embedding identity. |
| `preprocessor_version` | Exact content normalization/input recipe. |
| `embedding_version` | XiaoC-owned logical version used by retrieval configuration. |
| `input_hash` | Hash that must equal the embedded canonical input. |
| `vector` | Derived vector. |
| `status` | `ready`, `failed`, or `stale`. |
| `created_at` | Generation time. |

The unique identity is the user, memory, embedding version and input hash. Retrieval chooses one declared read version and never compares raw scores across incompatible versions. A model upgrade writes a parallel version, runs shadow comparison, and changes the read version only after approval. It does not update vectors in place.

Changing a PIN, lifecycle status or category does not require re-embedding unchanged content. A corrected claim is a new memory row and therefore receives its own embedding later. Missing/failed embeddings must be observable and may use a declared lexical fallback; they must not silently query another user's namespace or mix vector versions.

M1 performs no embedding generation or regeneration.

### 3.5 `memory_pins`

PIN membership is explicit curation rather than a boolean on `memory_items`.

| Field | Meaning |
| --- | --- |
| `id`, `user_id`, `memory_id` | Pin identity and same-user target. |
| `scope` | `core`; additional scopes require a later product decision. |
| `ordinal` | Deterministic render order. |
| `status` | `active` or `inactive`. |
| `pinned_by` | `user`, or a narrowly defined administrative migration actor. |
| `pinned_at`, `unpinned_at` | Audit timestamps. |
| `operation_id` | Audited operation that changed membership. |

Only a memory with eligible provenance, `lifecycle_status = active`, and a non-quarantined/non-disabled retrieval policy can become an active native PIN. Legacy PIN metadata is imported only as `legacy_pin_candidate`; it never creates native PIN/Core membership automatically. Consolidation never changes PIN membership automatically. If a pinned claim is superseded, the old PIN remains until a separate explicit pin decision; this avoids silently changing XiaoC's stable identity knowledge.

### 3.6 `memory_operations`

An append-only operation ledger supports audit, idempotency and rollback.

It records `id`, `user_id`, operation type, actor type, idempotency key, policy version, affected IDs, compact before/after state or hashes, result, reason and timestamp. Operation types include capture, manual confirmation, consolidation apply, supersede, archive/restore, delete/restore, pin/unpin, legacy import, and retrieval-tier promotion/demotion.

It must not log embeddings, credentials, full conversations, or unrelated private content. Mutations use an idempotency key unique within a user.

### 3.7 `memory_import_runs` and `legacy_memory_map`

These tables make a future Ombre import repeatable without treating an archive as native evidence.

An import run records the source system, canonical archive SHA-256, importer version, start/end state, counts and validation result. Each mapping row records `user_id`, import run, legacy bucket ID, native memory ID, source item checksum, mapped fields and mapping status. `(user_id, source_system, legacy_bucket_id)` is unique.

No import rows are created in M1.

## 4. User isolation

All memory tables, relation tables, embedding rows, import maps, operation rows, jobs and cache keys carry `user_id`.

The implementation must enforce isolation at several boundaries:

1. Interfaces require `userId`; it is derived from trusted authentication/configuration, never accepted as an arbitrary client-selected owner.
2. Database row-level policies restrict ordinary reads and writes by `user_id`. Server-side service credentials still require explicit application-level owner filters because they may bypass RLS.
3. Foreign keys use `(user_id, id)` pairs so a same-shaped ID cannot create a cross-user evidence, relation, PIN or embedding edge.
4. Vector and lexical retrieval filter `user_id` before ranking. Post-filtering a global nearest-neighbor result is not sufficient.
5. Queue payloads, idempotency keys, observability dimensions and cache keys include `user_id`.
6. Diagnostics may record IDs, counts, ranks and reasons, but not memory bodies by default.

The first implementation can still configure exactly one allowed XiaoC user. The invariant is data isolation, not a new account experience.

## 5. Lifecycle and consolidation

### 5.1 Four independent status dimensions

`provenance_status`:

- `verified_user`: supported by validated real user-message evidence;
- `derived_verified`: derived only from verified native evidence through explicit lineage;
- `manual_confirmed`: explicitly confirmed by the user through a trusted manual action;
- `legacy_unverified`: imported historical content whose original message provenance cannot be verified.

`lifecycle_status`:

- `active`: the claim has not been superseded, archived or deleted;
- `superseded`: retained for history but replaced by an explicit newer claim;
- `archived`: intentionally cold; explicit history or restore tooling may access it later;
- `deleted`: soft-deleted and excluded from user-facing retrieval. Physical purge is a separately authorized retention action after the rollback horizon.

Allowed normal lifecycle transitions are:

```text
active   -> superseded | archived | deleted
archived -> active | deleted
```

`retrieval_tier`:

- `active_legacy`: deterministically classified legacy content that may provide historical continuity under a permanent legacy authority cap;
- `low_authority`: eligible only under stronger semantic/current-context relevance and stricter conflict/temporal checks;
- `shadow_only`: available for comparison or review but excluded from production prompt context;
- `quarantined`: anomalous, damaged, conflicting, unowned or unsafe to treat as a retrieval candidate;
- `disabled`: intentionally unavailable to ordinary retrieval, including resolved/expired plans and records suppressed by a newer verified claim.

Native verified retrieval eligibility is determined by native policy over provenance, lifecycle, relations and temporal validity; `active_legacy` is specifically a legacy tier and is not a generic lifecycle state.

`authority_tier` is computed by a deterministic, versioned policy. It is not written from model judgment and is not interchangeable with `confidence`, importance, vector similarity, semantic relevance, novelty or attention. Every eligible legacy item has lower authority than an eligible verified native memory.

Rollback may reverse a transition through a compensating audited operation. It never erases the original operation.

M1 defines archive semantics but does not implement automatic heat, cold or archive policy. Passive retrieval does not refresh lifecycle state. If heat is later added, only new user evidence or an explicit user action may raise it; system retrieval and prompt injection cannot.

Temporal validity is evaluated before retrieval. An expired or resolved future plan is `disabled` even if it remains historically `active` for lineage. Mutable claims may use an optional `claim_key` to group successive values. Examples such as `preference:food:<subject>` or `plan:travel:<subject>` illustrate the shape only; M1 does not define a hardcoded taxonomy.

### 5.2 Deterministic authority and precedence

Factual conflict precedence is:

```text
current user statement
> newer explicit user evidence
> verified native Memory
> eligible legacy_unverified Memory
> model-generated Summary / derived Context
```

Summary and derived Context do not become provenance and cannot overrule source-backed facts. Prompt context ordering remains separately governed by the existing Context architecture (`current user / Recent -> Active Context -> Summary -> selected Memory`). Prompt ordering is not factual authority ordering.

For the same mutable claim, a newer explicit correction outranks a confirmation, which outranks an older assertion. Deterministic lifecycle, relation, temporal and claim suppression is applied before semantic or vector ranking; the model is not asked to choose the authoritative version at retrieval time.

### 5.3 Consolidation rules

Consolidation preserves the current verified behavior:

- deterministic clustering precedes any model call;
- normally at least three independent user-backed observations support a stable proposal;
- clusters represent the same fact or durable pattern, not merely events that occurred near each other;
- conflicting claims do not silently merge;
- the proposal identifies every source observation and any stable memory it would supersede;
- applying a proposal never deletes observations;
- stable output obtains `derived_verified` only through its same-user source relations and verified evidence;
- `legacy_unverified` memories are never consolidation inputs and cannot enter a future native provenance chain;
- a model proposes wording and relations; deterministic validation and a transaction decide whether they may persist;
- PIN/Core are outside consolidation apply.

Consolidated observations may remain `active` for lineage. Normal retrieval suppresses them when an active stable memory already represents the same evidence, avoiding duplicate prompt weight without corrupting history.

## 6. PIN, Core, Stable and Dynamic mapping

| Existing concept | Native representation | Retrieval behavior |
| --- | --- | --- |
| Episodic observation | `memory_items.memory_class = observation` plus verified evidence | Candidate for Dynamic retrieval; may support consolidation. |
| Stable Memory | `memory_class = stable` plus `consolidates`/`supersedes` relations | Preferred over represented observations when relevant. |
| PIN | Active `memory_pins` row pointing to an eligible memory | Explicit curated source set; excluded from Dynamic duplication. |
| Core Memory | Existing per-conversation rendered snapshot, hash and source IDs | Frozen for that conversation; new conversations use the then-current PIN set. |
| Dynamic Memory | Result of the retrieval pipeline | Not stored as a memory type. Excludes current Core sources and cross-layer duplicates. |

Persona and Relationship Contract remain outside the memory tables. Summary, Recent, Active Context, Shared Context and Proactive Attention also remain separate context systems.

During migration, source IDs are namespaced (`ombre:<bucket_id>` or `xiaoc:<memory_id>`). Existing Ombre-based Core snapshots continue reading their persisted text and source namespace. They are not translated, rebuilt or changed when the native engine is introduced.

## 7. Service interfaces

These are internal application contracts. A later implementation may expose necessary actions through the existing `api/memory.js` dispatcher, with the existing authentication boundary.

### 7.1 Capture

```ts
captureMemory({
  userId,
  source: { messageId, conversationId, role, text, createdAt },
  candidate: { content, category, eventTime? },
  policyVersion,
  idempotencyKey,
  mode: "evaluate" | "apply"
}) -> {
  decision: "accepted" | "rejected" | "duplicate" | "conflict",
  memoryId?,
  evidenceIds?,
  reasonCode,
  operationId?
}
```

Capture validates exact user evidence, question-only rejection, category, duplication and conflict before persistence. `evaluate` is read-only. `apply` atomically writes the observation, evidence and operation. An assistant message cannot be passed as user evidence. Legacy import uses a separate importer and cannot bypass this contract by pretending to be native capture.

### 7.2 Retrieval

```ts
retrieveMemory({
  userId,
  query,
  mode: "passive" | "deep_tool" | "shadow",
  embeddingReadVersion,
  limit,
  tokenBudget,
  excludeMemoryIds,
  excludeContent
}) -> {
  selected: [{
    memoryId,
    content,
    category,
    provenanceStatus,
    lifecycleStatus,
    retrievalTier,
    authorityTier,
    claimKey,
    evidenceSummary,
    scoreParts,
    suppressionReason
  }],
  diagnostics: { retrieved, relevant, eligibleForPrompt, suppressed, version }
}
```

The pipeline must execute these stages in order:

1. enforce `user_id` and embedding-version isolation;
2. apply provenance, lifecycle, retrieval-tier, temporal-validity, claim-key and relation suppression;
3. suppress Core sources, superseded claims, revalidated legacy rows and entire duplicate clusters blocked by a verified correction;
4. only then perform lexical/embedding candidate ranking;
5. apply relevance, novelty, cross-layer duplicate suppression, stable-over-observation preference and the shared context budget.

Suppressed candidates carry a deterministic `suppression_reason` in diagnostics. Quarantined, disabled and shadow-only rows can be inspected only by separately authorized shadow/review tooling; the ordinary retrieval interface cannot promote them through a request flag.

Every returned item has `eligibleForProactiveAttention = false`. The caller cannot promote a retrieval result into Active Context or a proactive event without that subsystem's own current-user evidence and gate.

### 7.3 Consolidation

```ts
consolidateMemory({
  userId,
  triggerMemoryId?,
  sourceMemoryIds?,
  policyVersion,
  expectedRevisions,
  mode: "propose" | "apply",
  idempotencyKey
}) -> {
  decision: "proposed" | "applied" | "skipped" | "conflict",
  proposal?: { content, category, sourceMemoryIds, supersedesMemoryId?, confidence },
  stableMemoryId?,
  operationId?,
  reasonCode
}
```

`propose` performs no mutation. `apply` revalidates same-user ownership, source state, independent evidence, conflicts and expected revisions inside the transaction. A stale proposal fails closed and must be regenerated. The interface cannot update PINs or Core snapshots.

## 8. Legacy Ombre mapping

A future import maps each Ombre bucket without changing Ombre:

| Ombre property | Native target |
| --- | --- |
| Bucket ID | `legacy_memory_map.legacy_bucket_id`; retained as external identity. |
| Text/content | `memory_items.content`, with original checksum recorded before any normalization. |
| Created/updated time | Native source/event metadata where trustworthy; import time remains separate. |
| Existing type/category | Mapped to `memory_class` and `category` through a versioned deterministic mapping table. Unknown values remain unknown; they are not guessed. |
| Pinned state | Imported as `legacy_pin_candidate` in mapping metadata. It does not automatically alter native active PIN/Core. |
| Source message/conversation metadata | Verified against the canonical message store before becoming `legacy_verified` evidence. |
| Supersedes/source bucket IDs | Same-user relations only after all referenced rows resolve and cycle checks pass. |
| Embedding/vector | Not imported as a native embedding unless provider, model, dimensions, preprocessing and input hash are all provable. Default is metadata-only preservation. |

### 8.1 Legacy rows without provenance

An Ombre memory lacking a verifiable source message is historically useful but is not a verified native fact. It receives `provenance_status = legacy_unverified` and one `legacy_import` evidence row containing its external ID, source archive/import-run identity and checksum, with `source_role = unknown`. It receives no fabricated message ID, conversation ID, evidence quote, user role or confirmation time.

`legacy_unverified` does not imply quarantine. A deterministic, versioned import policy assigns lifecycle and retrieval independently:

| Classification | Eligible content | Retrieval rule |
| --- | --- | --- |
| `ACTIVE` (`active_legacy`) | Intact, owned, non-conflicting, time-bounded low-risk past experiences or continuity details | May participate in ordinary retrieval below verified native authority. |
| `LOW_AUTHORITY` | Intact but mutable or less certain preferences, habits and ordinary background details | Requires stronger semantic and current-conversation relevance; never overrules verified content. |
| `SHADOW_ONLY` | High-authority, sensitive or current-relationship claims; historical pinned/stable/digested content pending review; ambiguous temporal claims | Comparison/review only; never enters production prompt context. |
| `QUARANTINE` | Damaged, checksum-invalid, conflicting, user-unowned, inference-like, structurally invalid, or denied by a verified correction | Excluded from retrieval, PIN and consolidation. |
| `DISABLED` | Expired/resolved future plans, intentionally archived/deleted items, and non-conflicting duplicates already represented by a verified memory | Preserved for lineage/audit but excluded from ordinary retrieval. |

Ombre `archived`, `resolved`, `digested` and `pinned` metadata are mapped separately because they express different semantics. Importance, score or pinned state may inform review but cannot raise provenance or authority. Legacy items never enter Stable consolidation and never automatically enter native PIN/Core. Existing persisted Core Snapshots remain unchanged.

Claims involving identity, sensitive facts, present relationship state, relationship rules, health, finance, security, precise important dates or similarly high-authority assertions default to `shadow_only` until verified. Mutable preferences without sufficient temporal grounding default to `low_authority` or `shadow_only`. Expired/resolved future plans are `disabled`.

### 8.2 Resurrection prevention

If a verified memory supersedes a legacy claim, retrieval suppresses the covered legacy row and every member of its known legacy duplicate cluster before embedding/vector ranking. Importance, similarity, semantic score or a stale cached rank cannot restore it. Suppression is keyed by same-user explicit relations, optional `claim_key`, duplicate-cluster membership and temporal state; it does not depend on a model deciding conflicts during each read.

A current user correction takes precedence immediately in the current turn. Once captured, the new verified memory records `supersedes` to the old legacy claim, and the contradicted legacy retrieval tier becomes `quarantined`. A revalidated, non-conflicting duplicate becomes `disabled`. A missing reliable claim identity keeps mutable legacy content out of `active_legacy` so the system does not create an unpreventable resurrection path.

### 8.3 Legacy re-verification

A future real user message may create a new verified native memory that independently confirms an old legacy claim. The new memory's provenance points only to the new real user message. It may link to the old legacy row using `revalidates`; a correction uses `supersedes`, and a non-confirming duplicate uses `duplicates`.

The old legacy row retains its original provenance and lifecycle history for lineage/audit. `revalidates` never copies new evidence backward, treats legacy content as evidence for the new memory, or promotes the legacy row to verified. After revalidation, ordinary retrieval returns the verified native memory and suppresses the represented legacy row.

## 9. Shadow-read migration strategy

Each phase requires separate authorization. M1 executes none of them.

### Phase 0 — baseline and recovery anchor

The completed M0 canonical Railway snapshot and independent verified copies remain the historical recovery anchor. Record its checksum in the future import run; do not download or modify the source again merely to start M1.

### Phase 1 — native schema and contract verification

Create the reviewed schema later, with RLS, composite owner constraints, operation ledger and contract tests. Production reads and writes remain Ombre-only.

### Phase 2 — deterministic import rehearsal

Parse the M0 archive offline, produce counts/checksums/mapping diagnostics and reject reports. No production database or Ombre write occurs. Re-running the same archive and importer version must yield the same planned IDs/mappings.

### Phase 3 — classified import and capture mirror

After approval, import legacy rows idempotently with `provenance_status = legacy_unverified` and a deterministic `ACTIVE / LOW_AUTHORITY / SHADOW_ONLY / QUARANTINE / DISABLED` classification. Ombre stays authoritative. Native capture can run as a best-effort mirror with independent failure diagnostics; mirror failure must never block the current chat response.

### Phase 4 — shadow retrieval

For the same real query, return Ombre results to the current Memory/Context Gateway and run native retrieval out of band or within a strict non-blocking budget. Native results never enter the prompt. Log only safe comparison data: IDs/mappings, rank, score components, status, latency, exclusions and reason codes.

Compare:

- availability and latency;
- top-k mapped overlap and unique useful coverage;
- Core/PIN exclusion correctness;
- stable-over-observation and superseded suppression;
- missing/stale embedding rate;
- provenance/verification distribution;
- false inclusion and meaningful false omission on a representative, manually reviewed query set;
- historical continuity gain and unsafe legacy inclusion as separate metrics;
- token/cost impact;
- cross-user isolation and cache isolation.

Overlap alone is not a pass criterion because a better native ranker may legitimately differ.

### Phase 5 — gated native reads

Only after review, partially activate deterministically approved legacy tiers and switch Dynamic retrieval behind a centralized, immediately reversible read-source gate. Keep capture mode, Dynamic read source, legacy tier activation, and Core/PIN source as independent gates. Dynamic can move first; PIN/Core moves last. There is no implicit percentage rollout requirement for the private single-user product—a controlled session/test gate is sufficient.

Existing conversations retain their persisted Core Snapshot. New conversations use whichever Core source is explicitly active at snapshot creation time.

### Phase 6 — stabilization and Ombre retirement decision

Run a defined rollback window while reconciling accepted writes and failures. Ombre deletion or retirement requires a later explicit decision, verified native backups and a rollback drill. It is outside M1.

## 10. Rollback strategy

Rollback is per capability, not one global switch:

- **Dynamic read rollback:** route new retrievals back to Ombre. Native data and diagnostics remain intact.
- **Capture rollback:** stop native mirror/capture independently while current Ombre capture continues. Reconcile failed/missing mirror operations from idempotent operation records before any future retry.
- **Core rollback:** create new conversation snapshots from Ombre again. Persisted native or Ombre snapshots in existing conversations continue rendering their stored text and are never rewritten.
- **Import rollback:** disable the import run from all eligible reads and pins; retain its rows/mapping for audit. Physical deletion is unnecessary and should not be the first rollback action.
- **Consolidation rollback:** create a compensating operation that reactivates the superseded row and retires the replacement after revision checks. Source observations were never deleted.
- **Embedding rollback:** select the previous read version. Both versions remain separately addressable until the rollback horizon ends.

During the rollout window, a consistency report must identify Ombre-only, native-only, mismatched and failed operations without logging memory bodies. No Ombre retirement is safe while native-only accepted writes cannot be replayed or recovered.

## 11. Required gates before any cutover

The next implementation phase should define measurable thresholds, but the following are hard gates:

- zero cross-user read, relation, PIN, embedding, job or cache leakage in isolation tests;
- zero `shadow_only`, `quarantined`, `disabled`, archived, deleted or superseded-with-active-replacement rows in ordinary retrieval;
- 100% deterministic mapping for the currently active PIN set before Core source cutover;
- 100% native automatic memories backed by validated user evidence; `legacy_unverified` content and its lower authority remain distinguishable;
- exact import counts/checksums and idempotent rerun behavior;
- shadow queries demonstrate acceptable useful recall, false inclusion, latency, token and cost behavior on representative real cases;
- operation idempotency, stale consolidation rejection and supersedes cycle protection pass;
- read, capture, Core and embedding rollback paths are each exercised independently;
- current “memory is knowledge, not attention” regressions remain passing;
- API Function count remains `12/12` or lower.

## 12. Recommended implementation boundary after M1

When a later phase is authorized, the smallest safe sequence is:

1. approve the logical schema and lifecycle vocabulary;
2. write migration and RLS locally for review, without applying production changes;
3. implement repository/service contracts behind the existing Memory endpoint boundary;
4. add isolation, provenance, idempotency and rollback contract tests;
5. rehearse the M0 archive mapping offline;
6. request separate authorization for the first database/import write;
7. begin shadow-only comparison while Ombre remains authoritative.

No step in this sequence authorizes historical import, embedding regeneration, retrieval cutover, Core replacement, Ombre mutation or deletion.

### 12.1 Future implementation guidance

The following improve safety and observability but are not M2 blocking schema requirements:

- record a versioned `legacy_policy_version` so the same archive and policy can reproduce the same classification;
- assign a stable legacy duplicate-cluster ID where deterministic grouping succeeds, allowing whole-cluster suppression;
- report migration counts and validation results separately for every retrieval tier;
- record retrieval-tier promotion/demotion, previous/new tier and reason in the operation ledger;
- report shadow `continuity_gain` separately from `unsafe_inclusion` rather than relying only on top-k overlap;
- use the explicit name `legacy_pin_candidate` for imported Ombre pinned metadata so it cannot be confused with native active PIN/Core membership.
