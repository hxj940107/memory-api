# Memory association experiment — local implementation

This is Shadow only. No association result enters main-chat prompt, consumes the production context budget, writes Memory, or creates proactive work. No extra per-turn model or embedding call: search reuses the existing query embedding. Both flags default OFF.

## Release

Apply `supabase_memory_association_shadow.sql` once (additive table, service-only/RLS, 20-memory owner cap). Deploy backend through the existing release flow, still 12 Functions. No OTA.

- `XIAOC_MEMORY_ASSOCIATION_BUILD_ENABLED=true`: permit explicit single-ID maintenance builds.
- `XIAOC_MEMORY_ASSOCIATION_SHADOW_ENABLED=true`: permit observational reads during existing owned Memory retrieval. There is deliberately no live mode.

Existing authenticated maintenance endpoint: POST `/api/memory`, using the same maintenance-secret header as embedding maintenance. Body: `{"type":"memory_embedding_maintenance","action":"association_build","memory_id":"<reviewed UUID>","confirm_count":1}`. Do not put secrets in URLs. A regular chat token cannot authorize this operation. At most one generation and one embedding batch per new memory. A durable claim prevents automatic paid retry, including unknown interrupted outcomes. Failed/processing rows require separate operator review, not reset/retry. Trial counts failed attempts toward the 20-row cap.

Only explicitly selected native, eligible, non-PIN meaningful experiences/relationship memories with exact user-message provenance, or manual-confirmed body backed by a successful owner user operation, are accepted. Legacy/unverified corpus is not automatically converted. No bulk automatic backfill or automatic capture hook in this first trial. The operator must review IDs before individual calls. Source evidence is checked against owner-scoped current user messages. Oversized input fails before spending.

Derived records include memory content hash, exact source quotation, embedding identity and policy version. Read path checks current lifecycle, eligibility, provenance, source message, pins and content hash; changed/deleted/revoked/incompatible sources fail closed. No source body or cue text is returned in Shadow telemetry. At most one ID-only candidate is returned after existing relation and Context Gateway suppression, using a separate 600-character simulation budget. The threshold 0.72 is experimental, not a proven relevance guarantee. Each DB read shares an 800ms abort signal. Missing migration/network problems degrade to no association result.

## Observe before any live use

`telemetry.association_shadow` reports scanned count, failure state, at most one memory ID and whether ordinary retrieval already discovered it. Evaluate new useful recall versus irrelevant and repetitive recall with synthetic cases and carefully reviewed real turns. This is not an automated semantic usefulness judge. Main prompt is unchanged byte-for-byte by this channel.

Not implemented: next-turn prediction, actual-mention cooldown, live prompt injection, historic whole-library processing, automatic rebuild on edit. Edited records become unreadable via hash mismatch; rebuilding and retry policy need a separate follow-up design. Disabling both flags restores a no-I/O no-op; leaving the table is safe and preserves auditability.

## Retained verification

Production project `cncpymfqefyabiclnqzg`: migration applied through the logged-in SQL Editor during this task. Read-back showed RLS=true, anon SELECT=false, authenticated SELECT=false, trial_rows=0, guard_count=1. This establishes schema/permission readiness only, not deployed runtime or real-model usefulness. Backend and flags were not deployed/changed. Focused local suite: 81/81 passed, JS syntax and diff checks passed, Functions 12/12. No real Memory body was sent for indexing and no real-model cost was incurred by this experiment yet.


## Manual-confirmed source trial

Manual-confirmed native memories may use current canonical content as `source_kind=manual_memory` only when a current `manual_user` provenance row links to a successful user operation whose affected IDs include that memory. Source ID includes the provenance ID and memory content hash. It is not a verbatim chat quote and cannot be presented as one. Message-sourced cues remain separately typed `message`; no upgrade of legacy/unverified history is performed. Current source/operation and body version are rechecked on every Shadow read. No additional SQL migration is required.

Explicit single-ID runner: `node --env-file=.env.local scripts/build-memory-association-trial.js --apply <reviewed UUID>`. It checks the production project hostname, uses existing configured providers, prints IDs/counts/cost only and never prints source text or secrets. Do not retry a failed/processing durable claim without separate review.

Two production native manual-confirmed relationship memories were reviewed and had successful `manual_edit_owned` user operations linked to their IDs. Local build attempts failed on the first source read with ECONNRESET before a claim or paid model request. They do not establish successful indexing. Source-kind support is local pending push/deployment; actual trial generation and enabling Shadow remain unfinished.
