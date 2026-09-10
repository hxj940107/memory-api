# XiaoC Multi-user M2C.3 — Grant Containment Preparation

> Status: PREPARED, NOT APPLIED
>
> Basis: M2A Production catalog, M2B isolation design, M2C plan, M2C.1 caller/function review, and M2C.2 rollback rehearsal.
>
> This package has not been executed against Production. It does not change tenant schema, owner data, RLS policies, application code, Storage policies, Ombre, deployment, or git history.

## 1. Outcome

M2C.3 is a single transactional ACL-only containment package. It closes privileges that are dangerous independently of tenant UUID/RLS work while preserving the current `service_role` compatibility lane.

Files:

- `supabase_multi_user_m2c3_grant_containment.sql`: forward transaction with object/baseline/partial-state preflight.
- `supabase_multi_user_m2c3_grant_validation.sql`: read-only post-apply actor checks.
- `supabase_multi_user_m2c3_grant_rollback.sql`: exact M2A/M2C.1 privilege restoration for changed objects.
- `tests/multi-user-m2c3-grant-containment.test.js`: static scope, coverage, service-lane, and rollback checks.

## 2. Proposed permission changes

### 2.1 Functions safe to contain now

- Revoke `PUBLIC`, `anon`, and `authenticated` EXECUTE from `check_pending_moments_for_xiaoc()`; retain explicit `service_role` EXECUTE.
- Revoke direct `PUBLIC`/`anon`/`authenticated` EXECUTE from the five native Memory Engine trigger guard functions. Existing triggers continue to invoke them; ordinary RPC callers do not need direct EXECUTE.
- Change future `postgres`/`public` function defaults so new functions are not automatically executable by `PUBLIC`, `anon`, or `authenticated`. User/service RPCs must receive explicit grants.

### 2.2 RLS-off Core tables safe to contain now

Revoke all privileges from `anon` and `authenticated` on:

- `conversation_summary`
- `conversations`
- `memories`
- `messages`
- `user_state`

These are the five Production tables with RLS OFF. Repository caller review found that the current Private App accesses them only through Vercel Supabase clients initialized with `SUPABASE_SERVICE_ROLE_KEY`. The forward package does not alter service grants.

### 2.3 High-risk table privileges safe to contain now

Revoke `TRUNCATE`, `TRIGGER`, `REFERENCES`, and PostgreSQL 17 `MAINTAIN` from `anon`/`authenticated` wherever the current catalog observed them. The two audit tables receive their actual `REFERENCES`/`TRIGGER`/`MAINTAIN` subset.

This is narrower than removing ordinary CRUD from every RLS-enabled table. RLS does not protect these maintenance and administration privileges, and they are not legitimate client capabilities. `MAINTAIN` permits operations such as `VACUUM`, `ANALYZE`, `REINDEX`, and `CLUSTER`. No current Private App route needs them.

### 2.4 Sequences safe to contain now

The 2026-09-10 read-only catalog follow-up found eight `public` sequences. All eight grant `SELECT`, `USAGE`, and `UPDATE` to both ordinary roles. Sequence operations are not governed by table RLS and can reveal or advance global counters.

Revoke all privileges from `anon`/`authenticated` on:

- `album_assets_id_seq`
- `background_worker_run_audit_id_seq`
- `conversation_summary_id_seq`
- `moment_candidates_id_seq`
- `moment_check_audit_id_seq`
- `moment_xiaoc_activity_id_seq`
- `treehole_execution_audit_id_seq`
- `xiaoc_proactive_tasks_id_seq`

Future sequence defaults are also made private to ordinary roles. Explicit sequence grants can be added later only for a proven direct authenticated insert path.

## 3. Deferred permissions

These are deliberately outside M2C.3:

- `SELECT`/`INSERT`/`UPDATE`/`DELETE` on the 22 RLS-enabled/no-policy tables. They currently fail closed through RLS; their final verbs depend on M3 per-domain Auth/API design.
- Any future authenticated access to Core. Core remains service-mediated until UUID ownership and trusted identity exist.
- `public` and `storage` schema `USAGE`, required for Supabase/PostgREST routing and not itself business-row access.
- Existing Storage table grants and the `chat-images` policy. Storage isolation is a separate checkpoint and must not be mixed with this ACL package.
- `service_role` broad table privileges and `BYPASSRLS`. Narrowing service identities needs per-worker credentials/RPC boundaries and is not safe as a blind global revoke.
- Caller-controlled `p_user_id`, Core conversation-only identity, RPC signatures/bodies, and tenant-qualified checks. Those depend on owner UUID backfill/constraints.
- Migration/import capability separation inside the current service role. It belongs to the later full service-RPC containment checkpoint.
- RLS enable/force flags and all RLS policies.
- Auth grants, API trusted-identity switch, owner backfill, Storage object moves, and Ombre cutover.

## 4. Repeatability and partial-apply behavior

All forward ACL statements are idempotent. More importantly, the transaction preflight counts the exact refreshed Production baseline across exposed functions, five Core tables, high-risk table privileges, eight sequences, and future default ACLs. The PostgreSQL 17 baseline is `80` Core privilege instances, `140` high-risk table privilege instances, and `24` relevant default-ACL privilege instances; the earlier `70`/`104`/`22` counts omitted `MAINTAIN`.

- Exact baseline: proceed.
- Exact desired state: safe repeat; statements remain no-ops.
- Any mixed count: abort with `M2C3_PARTIAL_OR_DRIFTED_ACL_STATE` before changing privileges.
- Any expected object missing or required service EXECUTE absent: abort.
- The whole package uses one transaction and an advisory transaction lock. A SQL error rolls back all ACL changes.

`IF NOT EXISTS` is not used as a substitute for ACL reconciliation.

## 5. Production impact

Expected behavior change:

- unauthenticated/authenticated PostgREST callers can no longer invoke the global Moment writer;
- ordinary roles can no longer directly reach the RLS-off Core tables;
- ordinary roles cannot truncate, maintain, alter trigger/reference behavior on covered business tables, or access public sequences;
- future public objects do not inherit ordinary-role privileges automatically.

Expected unchanged behavior:

- Private XiaoC chat, history, Summary/Core, Memory, preferences, Moments, generated assets, and background operations continue through `service_role`;
- the every-minute Moment HTTP worker and five-minute background HTTP worker are unchanged;
- `claim_moment_check`, cleanup, Core initialization, preferences patch, and callable Memory Engine RPCs retain service EXECUTE;
- Memory Engine triggers remain attached and functional;
- no rows, sequences, schema objects, policies, function bodies, Storage objects, or Ombre data change.

Risk is a previously undiscovered direct anon/authenticated client. Repository and M2C.1 evidence found none, but Production apply still requires a pre-apply canary owner and immediate rollback threshold.

## 6. Validation plan

### Before apply

1. Verify the forward preflight reports the exact baseline, not drift/partial state.
2. Capture current function/table/sequence/default ACL catalog output outside the database.
3. Confirm backup/PITR limitations and retain the logical ACL rollback file independently.
4. Name the operator and a timestamped rollback deadline.
5. Record baseline Private App canaries: chat send/history, Summary/Core initialization, preferences, Moments, Memory retrieval, and one observed Cron/background cycle.

### Immediately after apply

1. Run the read-only validation file; every row must have `pass=true`.
2. Confirm anon/auth denial for `check_pending_moments_for_xiaoc()` and Core tables.
3. Confirm service access to Core tables, all public sequences it needs, worker RPCs, and Memory Engine callable RPCs.
4. Repeat the Private App canaries without changing API configuration.
5. Observe at least two five-minute background cycles and the intervening Moment cycles.
6. Compare the post-apply ACL catalog against the package allowlist; any unrelated difference triggers rollback.

The validation SQL is explicitly read-only and ends with `ROLLBACK`.

## 7. Rollback plan

The rollback file restores the exact privilege classes recorded in M2A/M2C.1 for every changed object and restores the prior `postgres` default ACL grants. It does not change data or schema.

Rollback immediately if:

- any Private App service canary fails with a database permission error;
- either Cron/worker path fails because of database permission;
- a Memory Engine service RPC or trigger fails;
- validation has any `pass=false` row;
- post-apply ACL differences exceed the allowlist;
- the rollback deadline arrives before validation completes.

Default rollback window: at least ten minutes after apply, covering two background-worker cycles. The Production change record must replace this relative window with an exact timestamp and named operator before execution.

After rollback, rerun the captured baseline ACL query and the same Private App/worker/Memory canaries. Because this checkpoint has no data mutation, no data restore is expected. Backup/PITR remains an operational gate, not the primary ACL rollback mechanism.

## 8. Apply readiness

The change package is technically prepared and locally checked. Production execution remains blocked until:

- backup/PITR and restore limitations are recorded;
- the current ACL/default-ACL snapshot is freshly recaptured and matches the preflight counts;
- a named operator, maintenance timestamp, rollback deadline, and canary checklist are recorded;
- the user separately authorizes running the forward SQL against Production.

Final state: **PACKAGE READY; PRODUCTION APPLY STOP.**
