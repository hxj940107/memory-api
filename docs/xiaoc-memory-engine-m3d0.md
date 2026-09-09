# XiaoC Memory Engine M3D0 — Bounded DB Retrieval RPC Foundation

Status: implementation complete; migration intentionally not applied.

M3D0 adds the smallest read-only database boundary needed by a future M3D shadow read. It does not connect XiaoC retrieval to Chat, Context Gateway, Ombre, or production telemetry.

## Architecture and ownership

The future path is QueryPlan → bounded database candidates → M3B2 eligibility/claim resolution → M3C-R1 evidence compatibility → M3B3 ranking. PostgreSQL owns only trusted user scoping, deterministic eligibility prefiltering, active embedding compatibility, bounded vector ordering, and bounded relation loading. QueryPlan, claim winners, semantic admission, final scores, thresholds, diversity, and Top-K remain JavaScript policy.

The forward migration creates three focused `SECURITY DEFINER` RPCs with fixed `search_path`:

- `xiaoc_memory_retrieve_lexical_candidates`: at most 32 rows, using at most 12 non-empty terms of at most 128 characters each.
- `xiaoc_memory_retrieve_semantic_candidates`: at most 32 rows after same-user eligibility and exact embedding compatibility filtering.
- `xiaoc_memory_retrieve_candidate_relations`: accepts at most 32 candidate IDs and returns at most 128 same-user relations.

The private helper applies the existing M3B2 row gates. Normal retrieval permits active, temporally current rows; historical recall may also admit archived and non-current temporal states. Deleted or lifecycle-superseded rows, forbidden retrieval tiers, and invalid provenance/authority combinations never enter either candidate channel. Explicit `supersedes` and `revalidates` edges remain a resolver concern: an active target may enter the bounded candidate pool, after which the companion relation RPC returns its same-user suppressor even when that replacement was not itself retrieved.

## Security and privacy boundary

Only `service_role` receives execute permission on the three public RPCs. `PUBLIC`, `anon`, and `authenticated` are revoked, the helper is not directly executable by `service_role`, and M3D0 adds no table or mutation grants. Every RPC requires a non-empty `user_id`; row predicates and relation predicates independently enforce that scope. Invalid modes, timestamps, limits, term sets, embedding identities, dimensions, and candidate ID sets fail closed.

Candidate content is returned only because the trusted JavaScript lexical scorer needs the full canonical text. It is not included in result traces or the prepared shadow telemetry. Telemetry is count/reason/latency only: attempted, channel candidate counts, eligible/suppressed/selected counts, degradation mode, reason-code counts, and latency. It excludes query text, Memory bodies, vectors, and candidate IDs.

## Lexical and semantic strategy

At the current approximately 150-row historical scale, lexical retrieval uses a same-user, eligibility-filtered lowercase literal substring match and a stable timestamp/ID order. This is deliberately simple and Chinese-compatible. No `pg_trgm`, FTS tokenizer, extension, or new index is added. The query is bounded in output; its scan is bounded operationally by the single-user dataset and strict term count. Before moderate-scale rollout, inspect `EXPLAIN (ANALYZE, BUFFERS)` on synthetic/non-sensitive representative data. A proposed engineering trigger for revisiting indexing is sustained latency outside the shadow-read budget or growth from hundreds into low-thousands of eligible rows per user; these are review triggers, not production SLAs.

Semantic retrieval filters same-user eligible rows and joins only `active` embeddings whose provider, model, embedding version, preprocessor version, dimension, and content hash exactly match the request and current Memory. Vector distance ordering occurs only after those predicates. Zero compatible embeddings returns an empty semantic set and is a valid lexical-only degradation, not an error.

## JavaScript adapter

`XiaoCMemoryDbRetrievalRepository` maps the three RPC contracts into the existing M3B/M3C structured candidate and relation shapes. It repeats hard limits locally, validates user ownership and policy fields, validates active embedding identity and similarity, rejects oversized or malformed responses, and propagates RPC failures without partial results. The in-memory evaluation repository remains unchanged. The DB adapter is not imported by any production API.

## Manual migration and validation

No SQL was executed by this phase. After review, an authorized operator must:

1. Apply `supabase_xiaoc_memory_engine_m3d0_retrieval.sql` in the intended Supabase project.
2. Separately run `supabase_xiaoc_memory_engine_m3d0_retrieval_validation.sql` in SQL Editor.
3. Confirm every assertion completes and the script ends with `ROLLBACK`.
4. Recheck function privileges and verify no protected-table mutation permission was introduced.

The validation uses only synthetic users, memories, embeddings, and relations inside one transaction. It covers lexical and semantic user isolation, forbidden tier/lifecycle exclusion, eligible-before-vector behavior, exact and incompatible embedding identity, zero embeddings, hard limits, relation lookup with an outside-pool replacement, invalid inputs, executable roles, and lack of mutation rights.

Rollback, if later authorized, should be a separate compensating migration that revokes execute and drops the three RPCs and helper by exact signature. M3D0 creates no data and therefore requires no data rollback. Do not edit or reverse an already-applied migration file.

## M3D readiness boundary

M3D shadow work remains blocked until the migration and rollback validation have been manually reviewed and applied successfully, database query plans/latency have been observed, production-safe feature flags and telemetry sinks have been separately reviewed, and Chat/Context integration receives explicit authorization. M3D0 itself does not enable a feature flag, emit telemetry, create embeddings, inspect real Memory bodies, or change Ombre retrieval.
