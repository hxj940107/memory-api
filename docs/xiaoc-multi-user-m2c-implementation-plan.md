# XiaoC Multi-user M2C — Database Isolation Implementation Plan

> Status: IMPLEMENTATION PLAN ONLY
>
> Basis: M1 Identity & Tenancy Design, M2A Production Discovery, and M2B Database Isolation Design.
>
> This document does not authorize Production changes, migration SQL generation or execution, application-code changes, deployment, commit, or push.

## 1. Outcome and sequencing rule

M2 database isolation must be delivered as small, independently approved checkpoints. The safe order is:

```text
close unknowns and decisions
  -> build mapping/quarantine registry and rehearsal
  -> contain independently dangerous grants
  -> add nullable UUID foundation to Core only
  -> backfill/quarantine Core
  -> validate Core tenant constraints
  -> repeat add/backfill/validate by remaining domain
  -> complete service RPC/grant containment
  -> prepare RLS policies
  -> M3 trusted-identity cutover enables tenant RLS by domain
```

No checkpoint combines database ownership migration with API trusted identity, Storage object migration, Ombre authority/cutover, Private App account UX/local-state migration, or Public App creation.

Public XiaoC v1 is now bounded to **Own Stack**, with user-funded infrastructure and model/API keys. M2C.5 remains unchanged and binds the first private companion account. After M2C.5 reconciliation, M2C.6+ receives an explicit scope review: continue checkpoint work required for XiaoC Engine correctness, trusted identity, and tenant data isolation; defer payment, subscription, pooled-credit, subsidy, abuse-control, and other work required only for a Hosted SaaS. This review must not be used to weaken isolation or to create the separate Public App repo.

The first executable checkpoint is **M2C.1**, a read-only and decision-closing checkpoint with no Production writes.

## 2. P0 gates before any schema implementation

The following must close before the first additive Production schema change:

1. **Canonical lifecycle approval:** approve `auth.users.id` as tenant identity, one-to-one `companion_instances`, and restrictive account deletion until an audited purge exists.
2. **Legacy cohort disposition:** enumerate every distinct legacy owner cohort with privacy-safe fingerprints and approve a classification or quarantine state. No active cohort may be implicitly assigned to the first account.
3. **Known orphan disposition:** explicitly choose preserve/quarantine/repair evidence requirements for the 1 Summary, 3 Moment candidate, and 2 Moment activity orphans.
4. **Compatibility access matrix:** prove which Production paths currently use service role, anon, authenticated, Storage direct access, and RPCs. This is required before revoking grants or enabling RLS.
5. **Operational rollback readiness:** confirm backup/PITR status, maintenance/write-pause method, Cron/worker/push pause controls, current deployment rollback, and a named rollback deadline.
6. **Constraint semantics:** choose delete behavior for each proposed parent/child relationship. Default is `RESTRICT` or soft-delete; no new cascade is assumed.
7. **SECURITY DEFINER review:** inspect the bodies and callers of every preserved SECURITY DEFINER function, especially `check_pending_moments_for_xiaoc()` and Core/Memory functions.
8. **Production-shaped rehearsal target:** provide an isolated environment with catalog-compatible schema, synthetic two-user data, and no private content.

If any of 1–5 remains unresolved, schema implementation is **STOP**. Items 6–8 may be completed as part of M2C.1/M2C.2, but must be closed before their affected Production checkpoint.

## 3. What can be closed by read-only investigation

These do not require a product decision:

- distinct legacy owner fingerprints, per-table aggregate counts, relationship graph, null/blank counts, and cohort overlap;
- exact function definitions, callers, grants, SECURITY mode, search path, and dynamic-SQL usage;
- actual Data API exposed schemas and pre-request hook;
- Auth provider/session/hook configuration without exposing secrets or user data;
- current direct client versus backend access paths from code/config and privacy-safe platform logs;
- Cron jobs, schedules, worker endpoints, task status aggregates, and pause/drain mechanisms;
- backup/PITR availability and restore limitations;
- complete migration-history/catalog reconciliation;
- Storage nested-object counts, bucket/prefix classifications, owner population, MIME/size aggregates, checksum availability, and DB columns holding object paths;
- polymorphic `source_id`/task/provider-callback target types using schema, code, and type/count aggregates;
- delete/update actions required by current lifecycle behavior;
- whether the six known orphan references represent missing parents, soft-deleted parents, terminal task history, or stale prototype data, using IDs/hashes/state codes only and no private body text.

Read-only evidence may recommend a disposition, but it cannot approve that data as belonging to a person.

## 4. Decisions required from the user

The user/product owner must decide:

1. whether the literal `"user"` cohort belongs to the first private Auth account after evidence is presented;
2. the disposition of every non-`"user"` cohort: approved account, prototype/test, system/service, duplicate/superseded, or unknown quarantine;
3. whether an orphan should be retained quarantined, repaired to an evidenced parent, or retired as stale; deletion is a separate later approval;
4. the `companion_instances` deletion lifecycle and whether suspension/recovery is required before final purge;
5. whether legacy `memories` remains a user-facing Supabase surface or becomes server-only while Ombre stays authoritative;
6. whether Shared Context is user-readable/server-writable or entirely server-managed;
7. whether authenticated clients may upload directly to Storage or must use server-issued upload destinations;
8. the maintenance window, rollback deadline, and acceptable temporary worker/push pause for eventual apply;
9. which Auth method binds the first private account. This does not authorize Private App UI work in M2.

No decision is needed yet about Ombre cutover, Public App UX, account switching, billing, or public registration; those are outside M2.

## 5. Legacy owner mapping registry

### 5.1 Registry shape

M2C.1 produces a reviewed, privacy-safe mapping registry artifact before any database registry is created. Each cohort record contains:

- stable `cohort_key`: a deterministic hash of environment/source plus legacy owner alias, never the raw alias when it is not already the approved literal `"user"`;
- `legacy_owner_fingerprint` and alias kind;
- affected tables and aggregate row counts;
- relationship/component fingerprint showing which parent/child rows move together;
- evidence sources and evidence timestamp;
- classification: `approved_target`, `prototype_or_test`, `system_or_service`, `duplicate_or_superseded`, or `unknown`;
- target Auth UUID only for `approved_target` and only after the account exists;
- approver, reason, review state, and rollback group;
- `blocks_cutover` flag.

The repository artifact contains no email, private text, IDs from private rows, tokens, filenames, or signed URLs. A later migration registry in the database, if needed, is service/admin-only and contains the minimum mapping data.

### 5.2 Classification procedure

1. Build cohorts from owner fingerprints and connected parent/child components.
2. Compare table distribution, timestamps, environment provenance, migration/import-run linkage, and synthetic/test markers without reading private bodies.
3. Detect one raw alias spanning disconnected or contradictory components; split it into review groups rather than assuming one owner.
4. Mark every group `proposed`, then require explicit approval for `approved_target`.
5. Default unresolved groups to `unknown`, `blocks_cutover=true`.
6. Freeze registry version and digest before rehearsal and again before apply.

The mapping unit is a verified connected data cohort, not merely a string value.

## 6. Orphan quarantine and disposition

### 6.1 Quarantine model

Use logical quarantine, not destructive cleanup. The implementation choice is finalized in M2C.2:

- preferred: a restricted migration registry records row-key digests, domain, reason, original cohort, lifecycle state, and exclusion status while original rows remain unchanged;
- where workers could still execute an orphan, add a reversible execution exclusion/terminal disposition during the approved data checkpoint;
- never invent a parent, assign a catch-all tenant, clear a reference, or delete a row solely to satisfy a constraint;
- quarantined rows are excluded from UUID backfill, new authenticated reads, prompt assembly, workers, push, signing, and tenant constraint validation scope;
- retain enough hashed/count evidence to reverse every disposition.

### 6.2 Known orphan plan

| Finding | Read-only investigation | Default safe disposition pending decision |
| --- | --- | --- |
| 1 `conversation_summary` orphan | compare checkpoint/Core hashes, timestamps, logs, and known conversation-key history without reading Summary | quarantine entire Summary/Core row; never synthesize or attach |
| 3 candidate `published_moment_id` orphans | inspect candidate lifecycle/status and deletion/audit metadata | retain candidates; quarantine broken link from migration scope |
| 2 activity `moment_id` orphans | inspect task terminal state, retry eligibility, and linked audit metadata | prevent future execution; retain audit/history |

Any newly discovered null-owner, cross-cohort, or polymorphic orphan follows the same rule and stops the affected domain checkpoint.

## 7. Checkpoint plan

### M2C.1 — P0 evidence and decision pack

- **Scope:** finish all read-only investigations in section 3; build the access matrix, cohort inventory, orphan evidence pack, function review, operational rollback checklist, and decision log.
- **Prerequisites:** M2A PASS; authenticated read-only catalog access; no private-content selection.
- **Files/schema involved:** documentation and sanitized local artifacts only; `docs/xiaoc-multi-user-m2c-implementation-plan.md`, future cohort/decision manifests under `docs/` or an approved ignored artifact directory; no schema mutation.
- **Production write?** NO.
- **Rollback:** delete/revert local planning artifacts; Production is unchanged.
- **Validation:** repeat catalog counts; evidence timestamps; registry digest reproducible; every M2B P0 item labeled `resolved`, `decision_required`, or `blocked`; private-data scan of artifacts.
- **Stop condition:** catalog access fails; evidence requires private-body inspection; any owner attribution remains an unsupported guess; backup/pause controls cannot be established.

Deliverable: a user-reviewable decision pack. M2C.1 is the **first executable checkpoint**.

### M2C.2 — Rehearsal model and rollback contract

- **Scope:** construct a production-shaped isolated schema with synthetic A/B/unknown/orphan fixtures; specify non-executable migration artifacts, dependency graph, quarantine mechanism, manifest format, and forward/reverse validation.
- **Prerequisites:** M2C.1 evidence complete; lifecycle and cohort classifications approved enough to model; isolated target available.
- **Files/schema involved:** local/rehearsal-only schema model, test fixtures, expected-result matrices, rollback runbook; no Production schema.
- **Production write?** NO.
- **Rollback:** discard the isolated rehearsal environment/artifacts.
- **Validation:** synthetic two-user FK/RLS/RPC/Storage tests; forward/reverse count and digest equality; failure injection at every phase boundary.
- **Stop condition:** Production catalog cannot be reproduced; rollback cannot restore the modeled pre-state; quarantine cannot remain unreachable.

### M2C.3 — Independent grant containment

- **Scope:** after a separate apply approval, repair future default privileges and revoke independently unsafe RPC grants, starting with anon/authenticated EXECUTE on `check_pending_moments_for_xiaoc()` and unnecessary direct trigger-function EXECUTE. Do not alter owner columns, backfill, RLS, Storage, or application auth.
- **Prerequisites:** M2C.1 access/caller matrix proves the private App and workers use service paths; M2C.2 rehearsal passes; exact rollback grants captured.
- **Files/schema involved:** future dedicated grant-containment migration artifact and verification/rollback artifacts; existing public functions/default ACLs.
- **Production write?** YES, only under future explicit approval.
- **Rollback:** restore the exact captured ACL/default-ACL state; no data rollback.
- **Validation:** service worker can still execute; anon/authenticated denial; private App chat/Moments/background canary; catalog ACL diff matches allowlist.
- **Stop condition:** any current legitimate path depends on the grant; function body/caller remains unknown; rollback ACL cannot be reproduced exactly.

Why before backfill: this closes an existing callable security exposure independently and reduces risk for future objects. Full table-grant/RPC conversion waits until schema and application dependencies are ready.

### M2C.4 — Additive Core tenant foundation

- **Scope:** add an empty `companion_instances` root and nullable UUID bridge columns only to `conversations`, `messages`, `conversation_summary`, `memories`, and `user_state`; add supporting indexes/unique ownership keys in compatibility-safe form. Do not backfill, validate `NOT NULL`, switch reads/writes, add authenticated policies, or alter existing text owner columns.
- **Prerequisites:** M2C.1 P0 gates closed; M2C.2 rehearsal/rollback passes; M2C.3 containment complete or explicitly waived with evidence; lock/runtime impact reviewed.
- **Files/schema involved:** future Core-foundation migration/rollback/validation artifacts; five Core tables plus new root.
- **Production write?** YES, schema only, under future explicit approval.
- **Rollback:** remove only unused nullable bridge columns/indexes/root after proving no UUID writes occurred; preserve existing schema/data.
- **Validation:** catalog diff; lock duration; index validity; old application path unchanged; 12/12 API function count unchanged; private App chat/history/Summary/Core canary.
- **Stop condition:** additive change rewrites/locks beyond budget; existing query behavior changes; old client sees errors; an index/constraint cannot be built safely.

This is the **minimum first schema batch**. It contains the collision-critical Core tables only; no Moments, Storage, Proactive, native Memory Engine owner conversion, or RLS enforcement.

### M2C.5 — First private account root and Core backfill/quarantine

- **Scope:** under separate approval, create the verified first Auth account and its `companion_instances` row, freeze the approved mapping-registry version, backfill only approved Core cohorts into UUID bridge columns, and register/quarantine unresolved Core rows.
- **Prerequisites:** M2C.4 stable; user approved account binding and cohort mapping; writes/workers affecting Core can be paused or captured; manifest and backup ready.
- **Files/schema involved:** future backfill/manifest/rollback artifacts; Auth account/root and UUID bridge columns on five Core tables.
- **Production write?** YES, data/Auth, under future explicit approval.
- **Rollback:** pause writes; reverse UUID bridge values and root binding from manifest; retain Auth account disabled/preserved according to approved lifecycle; legacy text owners remain authoritative.
- **Validation:** per-cohort counts/digests; zero UUID assignment outside approved cohorts; Summary/Core hash/checkpoint preservation; re-run null/orphan/mismatch checks; private App remains on legacy lane.
- **Stop condition:** writes cannot be quiesced; counts/digests differ; new owner cohort appears; any row would require guessed ownership; orphan disposition is unapproved.

`companion_instances` schema is created empty in M2C.4. The first real row is created only here, after a verified Auth account and approved mapping exist. No automatic Auth trigger creates a companion during this private migration.

### M2C.6 — Core tenant constraint validation

- **Scope:** add/validate Core composite ownership FKs and uniqueness against UUID bridge columns in a compatibility-safe order; keep UUID columns nullable for quarantined/unmigrated rows until the domain cutover gate; do not replace legacy runtime reads.
- **Prerequisites:** M2C.5 reconciliation PASS; all included rows mapped; orphan excluded/quarantined; constraint delete actions approved.
- **Files/schema involved:** future Core-constraint migration/rollback/validation artifacts; five Core tables/root.
- **Production write?** YES, schema validation, under future explicit approval.
- **Rollback:** drop new composite constraints/indexes only; UUID bridge and legacy path remain.
- **Validation:** synthetic cross-tenant link rejection; existing approved rows validate; Summary uniqueness/upsert model rehearsed; concurrent Core initialization model; Production catalog diff.
- **Stop condition:** any included row violates ownership; constraint validation impacts availability; application conflict targets would change prematurely.

Before authorizing this checkpoint, apply the post-M2C.5 product-boundary review. Core ownership integrity and cross-tenant collision prevention remain Engine/data-isolation concerns and are not Hosted-only features; any newly proposed SaaS operations must be separated and deferred.

### M2C.7 — Remaining-domain additive batches

- **Scope:** repeat add → backfill/quarantine → validate in separate domain batches, never one global migration:
  1. Shared Context and native Memory provenance boundary;
  2. Moments/comments/candidates/activity/interaction/audit;
  3. Proactive/tasks/preferences/push/observability;
  4. Diary/Treehole/Album metadata;
  5. native Memory Engine internal owner conversion, only preserving current Shadow/authority behavior.
- **Prerequisites:** Core constraints stable; each domain has an approved mapping, relationship map, worker pause plan, rollback, and synthetic test.
- **Files/schema involved:** one future migration/rollback/validation set per domain; no Storage object move.
- **Production write?** YES per separately approved sub-checkpoint.
- **Rollback:** reverse only the current domain using its manifest; do not unwind previously stable domains automatically.
- **Validation:** domain counts/digests, composite FK rejection, worker/task idempotency, no prompt/Memory authority change, private App canary.
- **Stop condition:** polymorphic target unresolved; owner mismatch/orphan discovered; worker cannot pause/drain; M4 Memory behavior would change.

### M2C.8 — Full grant and service-RPC containment

- **Scope:** reconcile existing table/sequence/function grants with the M2B access classes; keep Summary/Core, workers, Proactive, audits, native Memory, imports, cleanup, and callbacks service-only; tenant-qualify service RPC parameters and child checks where the UUID schema is ready. Do not create user-auth RPC behavior yet.
- **Prerequisites:** affected domain UUID constraints validated; exact current callers known; application service lane tested; function bodies reviewed.
- **Files/schema involved:** future ACL/RPC migration and rollback artifacts; public functions and grants; no application code in this checkpoint.
- **Production write?** YES, under future explicit approval.
- **Rollback:** restore exact function signatures/definitions/grants captured before apply; keep new schema intact.
- **Validation:** actor matrix for anon/authenticated/service; forged owner/child ID rejection; fixed search paths; worker canaries; no public execute leakage.
- **Stop condition:** an RPC cannot validate owner with existing schema; ordinary app path depends on an unrestricted service function; function replacement cannot be rolled back atomically.

This checkpoint follows backfill/constraints because tenant-qualified RPC checks need the new UUID ownership graph. M2C.3 remains the narrow early exception for independently unsafe grants.

### M2C.9 — RLS policy readiness, not user cutover

- **Scope:** install/rehearse final policy definitions and least-privilege authenticated grants by domain. For Production, RLS may be enabled with no authenticated policy on service-only tables and may block anon on proven service-mediated Core paths. Do not claim authenticated tenant enforcement until M3 supplies trusted user JWT paths.
- **Prerequisites:** UUID owners backfilled and constrained for the domain; access matrix proves current private App compatibility; two-user rehearsal passes; service-only rollback path exists.
- **Files/schema involved:** future per-domain RLS/grant migration/rollback/test artifacts.
- **Production write?** YES only for separately approved policy/readiness changes.
- **Rollback:** restore prior RLS flags/policies/grants per domain; schema/data ownership remains.
- **Validation:** anon denial, service continuity, policy catalog diff, A/B JWT simulation in rehearsal, private App canary.
- **Stop condition:** any active row lacks UUID owner; current legitimate client uses anon/direct table access; policy depends on unshipped M3 code; service canary fails.

True authenticated enforcement occurs only when a domain is cut over in M3: the API verifies the Supabase token, passes the user-scoped database identity, writes UUID ownership, and removes the legacy/service fallback for that domain. M2C.9 can prepare policies but must not enable a broken user path.

### M2C.10 — M2 database closure and handoff

- **Scope:** verify every database domain has a target owner rule, mapping/quarantine state, constraints, grant/RPC classification, RLS readiness state, and rollback artifact; produce the M3 handoff matrix.
- **Prerequisites:** M2C.4–M2C.9 approved portions complete and stable; no unresolved active P0 exception.
- **Files/schema involved:** closure report, canonical catalog snapshot, M3 per-route dependency matrix; no new behavior.
- **Production write?** NO for the closure review.
- **Rollback:** not applicable; this is evidence consolidation.
- **Validation:** full catalog diff, two-user rehearsal suite, private lane canary, orphan/cohort registry digest, function/grant/policy allowlists.
- **Stop condition:** any tenant domain lacks owner/constraint/access rule; quarantine is reachable; rollback artifact missing; M3 would need to guess ownership.

## 8. Grant/RPC versus backfill ordering

The answer is deliberately split:

- **Before backfill:** repair future default privileges and revoke proven-unneeded, independently unsafe execute grants such as `check_pending_moments_for_xiaoc()` from anon/authenticated. This requires caller verification first.
- **After UUID backfill and constraints:** tenant-qualify RPC signatures, enforce child ownership, and perform the full table/function grant reconciliation. These controls depend on the new owner graph.
- **At M3 domain cutover:** expose only approved auth-derived user RPCs and authenticated table policies. Remove legacy owner parameters and service fallback per route.

Do not perform a broad grant lockdown before the compatibility access matrix proves which roles the current private App uses.

## 9. Private XiaoC compatibility lane

Until M3/M5 explicitly cut it over, private XiaoC remains on the current single-user production behavior:

- legacy text owner remains authoritative for runtime reads/writes;
- UUID bridge columns are nullable, shadow-only metadata and do not alter prompt/context selection;
- existing conversation/message IDs, Summary/Core bytes, checkpoints, timestamps, and ordering are preserved;
- current Vercel endpoints remain 12/12; no new endpoint is introduced;
- background workers continue with existing service identity except during bounded maintenance pauses;
- Ombre remains authoritative and allowlisted to the legacy account; no new account reaches it;
- no Auth login/account-switching UI, local-state namespace migration, or Public App work occurs in M2;
- no Storage key is moved in Core schema checkpoints;
- every Production checkpoint has chat/history/Summary/Core/Moments/worker real-device or service canaries and an immediate rollback threshold.

Compatibility is not a permanent bypass. It is a time-bounded lane whose removal belongs to M3/M5 after the UUID database foundation is proven.

## 10. Validation gates shared by all write checkpoints

Before apply:

- approved scope and exact Production targets;
- catalog snapshot and rollback artifact;
- backup/PITR and maintenance controls confirmed;
- rehearsal PASS with synthetic A/B/unknown/orphan fixtures;
- no private content in artifacts/logs;
- lock/query-plan impact reviewed;
- private-lane canary and abort thresholds written down.

After apply:

- `git diff --check` and local artifact validation;
- catalog/constraint/grant/RLS diff equals allowlist;
- row counts and privacy-safe digests reconcile;
- zero new null/mismatch/orphan for included cohorts;
- actor allow/deny tests pass;
- private App and worker canaries pass;
- rollback remains executable until the deadline.

Any failed invariant stops the sequence. Do not continue to the next checkpoint to compensate for a failed current checkpoint.

## 11. Recommended next action

Proceed with **M2C.1 only**:

- read-only access/caller/configuration investigation;
- privacy-safe cohort and orphan evidence pack;
- SECURITY DEFINER body/caller review;
- backup/pause/rollback capability inventory;
- explicit user decision list.

M2C.1 performs no Production writes and generates no migration SQL. Its output determines whether M2C.2 rehearsal can start or the project must STOP for ownership/operational decisions.

**READY FOR M2C.1.**
