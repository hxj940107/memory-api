# XiaoC Multi-user M2C.3 — Grant Containment

> Status: COMPLETE — PRODUCTION GRANT CONTAINMENT ACTIVE
>
> Basis: M2A Production catalog, M2B isolation design, M2C plan, M2C.1 caller/function review, and M2C.2 rollback rehearsal.
>
> The final revised package was applied to Production and validated on 2026-09-11. It changed ACLs and default privileges only; it did not change tenant schema, owner data, RLS policies, application code, Storage policies, Ombre, or deployment.

## 1. Outcome

M2C.3 is a single transactional ACL-only containment package. It closes privileges that are dangerous independently of tenant UUID/RLS work while preserving the current `service_role` compatibility lane.

Final Production outcome: **COMPLETE**. The forward transaction committed, all
13 validation checks passed, and the frozen post-forward ACL snapshot matched
the reviewed containment allowlist exactly. Rollback was not required. M2C.4
was not started.

### 1.1 Final Production evidence

- Forward: `PASS`
- Validation: `13/13 PASS`
- Post-forward canonical rows: `665`
- Post-forward canonical SHA-256: `567A3B1B1BE2E40FD34F337511D8A357154E7A3F0FDDEB0F3D053167FDF88F87`
- Baseline `EXCEPT` post-forward: `270`
- Post-forward `EXCEPT` baseline: `1`
- Approved allowlist comparison: `PASS`
- Rollback executed: `NO`
- Final Production state: M2C.3 grant containment active

The first Production apply was rolled back because UI-driven validation could not be completed inside the declared window. Read-only investigation confirmed that effective privileges returned to the approved baseline, but the original rollback left four redundant explicit `service_role EXECUTE` ACL entries. Those functions had received the same effective access through `PUBLIC` before M2C.3. This revision fixes the rollback representation and makes canonical ACL shape part of preflight, validation, rehearsal, and rollback postflight.

A later re-apply reached the contained state but was immediately rolled back
because the validation package raised `"saml_providers_pkey" is not a
sequence`. The ACL recovery completed and the frozen snapshot matched the
934-row canonical baseline bidirectionally. The failure was caused by relying
on the textual conjunction `c.relkind = 'S' AND
has_sequence_privilege(...)`: PostgreSQL may reorder those predicates and call
the privilege function for a non-sequence `pg_class` row first. Validation and
rollback postflight now place every catalog-wide sequence privilege call in a
short-circuiting `CASE WHEN c.relkind = 'S'` expression. The forward package
already uses its explicit reviewed list of eight sequence names and does not
perform this catalog-wide call pattern.

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

Effective privilege checks alone are insufficient for rollback fidelity. PostgreSQL roles automatically inherit grants made to `PUBLIC`, while `aclexplode` distinguishes that inherited path from an explicit role ACL. The canonical pre-apply state has no explicit `service_role EXECUTE` entry on:

- `check_pending_moments_for_xiaoc()`
- `xiaoc_memory_guard_append_only()`
- `xiaoc_memory_guard_embedding_transition()`
- `xiaoc_memory_guard_import_run()`

The canonical contained state has exactly one such entry, on `check_pending_moments_for_xiaoc()`. Forward preflight now rejects any other representation. Rollback restores `PUBLIC` first, removes those four explicit entries, then verifies `2 / 10 / 80 / 140 / 24 / 48` and zero redundant explicit entries before commit.

- Exact baseline: proceed.
- Exact desired state: safe repeat; statements remain no-ops.
- Any mixed count: abort with `M2C3_PARTIAL_OR_DRIFTED_ACL_STATE` before changing privileges.
- Any expected object missing or required service EXECUTE absent: abort.
- Effective counts that match but canonical explicit grants that do not match: abort.
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

Canonical comparison removes volatile capture columns, projects each entry as `(object_type, schema_name, object_name, owner, grantor, grantee, privilege, grantable)`, and performs `pre EXCEPT post` plus `post EXCEPT pre`. After forward, only the documented containment allowlist may remain. After rollback, both directions must return zero rows; matching row counts alone are not sufficient.

The validation SQL is explicitly read-only and ends with `ROLLBACK`.

## 7. Rollback plan

The rollback file restores the exact privilege classes recorded in M2A/M2C.1 for every changed object and restores the prior `postgres` default ACL grants. It restores `PUBLIC`-inherited function access without manufacturing explicit `service_role` entries, then runs an in-transaction effective-and-canonical postflight before commit. It does not change data or schema.

Rollback immediately if:

- any Private App service canary fails with a database permission error;
- either Cron/worker path fails because of database permission;
- a Memory Engine service RPC or trigger fails;
- validation has any `pass=false` row;
- post-apply ACL differences exceed the allowlist;
- the rollback deadline arrives before validation completes.

Default rollback window: at least ten minutes after apply, covering two background-worker cycles. The Production change record must replace this relative window with an exact timestamp and named operator before execution.

After rollback, rerun the captured baseline ACL query, require a bidirectional canonical set diff of zero, and repeat the same Private App/worker/Memory canaries. Because this checkpoint has no data mutation, no data restore is expected. Backup/PITR remains an operational gate, not the primary ACL rollback mechanism.

## 8. Canonical recovery record

Before the final apply, Production was restored to the approved canonical
baseline, including removal of four redundant explicit `service_role EXECUTE`
entries. The recovery package remained deliberately separate from M2C.3:

- `supabase_multi_user_m2c3_canonical_recovery.sql` verifies all four functions still expose EXECUTE through `PUBLIC`, all four explicit service entries exist, effective service access remains true, and `12 / 80 / 140 / 24 / 48` matches before removing only those explicit entries.
- `supabase_multi_user_m2c3_canonical_recovery_validation.sql` is read-only and verifies canonical absence, inherited/effective access, and the complete baseline after recovery.
- `supabase_multi_user_m2c3_canonical_recovery_rollback.sql` is a compensating package that restores only the four explicit entries if recovery validation fails. It does not invoke either M2C.3 package.

Recovery transition:

- Before: four `PUBLIC EXECUTE` entries plus four redundant explicit `service_role EXECUTE` entries; service effective access is true.
- After: the same four `PUBLIC EXECUTE` entries, zero explicit service entries, and unchanged service effective access through `PUBLIC`.
- Canonical proof: normalized post-recovery ACL compared bidirectionally with the pre-apply snapshot must produce zero rows.

That recovery completed before the final M2C.3 re-preflight. It is not part of
the retained post-forward delta. M2C.4 remains outside this checkpoint.

## 9. Completion state

The final package passed its preflight, Production forward transaction,
immediate read-only validation, frozen ACL recapture, and canonical allowlist
comparison. The retained Production state is the contained ACL state described
in this document.

Final state: **M2C.3 COMPLETE; PRODUCTION CONTAINMENT ACTIVE.**

This completion does not authorize or begin M2C.4.

## 10. Canonical baseline and comparison contract

The original `941`-row pre-M2C.3 CSV could not be recovered from the local
workspace, user profile, browser-accessible download state, or the surviving
Supabase SQL Editor tabs. That historical artifact is therefore **LOST**. The
successful recovery validation and the previously identified four-row delta
remain valid operational evidence, but they do not prove file-level historical
equality and must never be described as such.

The validated pre-forward Production ACL state was captured as versioned
baseline `m2c3-acl-v1-20260911T163305+0800` using the frozen query. Its
canonical row count was `934` and its SHA-256 was
`BFC5F8C7A2E0C2462B16EA370AF5C0130396CFD3B02B22EFF8CE6B5689B9B00C`.
The final post-forward evidence is recorded in section 1.1.

### 10.1 Frozen canonical projection

The capture query must emit the raw catalog rows plus these canonical columns:

`(object_type, schema_name, object_name, owner, grantor, grantee, privilege, grantable)`

Before comparison, discard `captured_at`, database/session metadata, display
columns, and CSV row ordering. Normalize `PUBLIC` consistently, preserve exact
function identity including argument types, preserve case-sensitive identifiers,
encode nulls unambiguously, remove only byte-identical duplicate tuples, sort by
all eight columns using bytewise/C collation semantics, and serialize with UTF-8
and LF line endings.

The frozen query text itself is part of the evidence. Record its SHA-256 and do
not compare snapshots captured by different query versions without an explicit
query-version compatibility review.

### 10.2 Baseline bundle

Use a timestamped capture id such as
`m2c3-canonical-v1-YYYYMMDDTHHMMSSZ`. Store the working copy under the ignored
local artifact directory:

- `tmp/multi-user/m2c3/baselines/<capture-id>/acl-raw.csv`
- `tmp/multi-user/m2c3/baselines/<capture-id>/acl-canonical.csv`
- `tmp/multi-user/m2c3/baselines/<capture-id>/validation.json`
- `tmp/multi-user/m2c3/baselines/<capture-id>/manifest.sha256`
- `tmp/multi-user/m2c3/baselines/<capture-id>/README.txt`

Copy the complete bundle, without modification, to a repo-external location
such as:

`C:/Users/Administrator/Documents/XiaoC-Audit/m2c3/baselines/<capture-id>/`

The external copy is the recovery copy; the ignored `tmp` copy is the local
working artifact. The manifest must cover the raw CSV, canonical CSV, validation
record, README, and the exact frozen query file. Record capture time, Production
project ref, operator, query version/hash, raw row count, canonical tuple count,
and every file SHA-256. Do not include application rows or private content.

### 10.3 Capture gates

A new baseline is accepted only when all of the following pass in the same
read-only capture window:

- canonical recovery validation is `8/8 true`;
- explicit `service_role EXECUTE` on the four recovery targets is `0`;
- `PUBLIC EXECUTE` and effective `service_role EXECUTE` on those targets are
  both `4`;
- the function/Core/high-risk/default-ACL/sequence baseline is exactly
  `12 / 80 / 140 / 24 / 48`;
- critical `service_role` table, sequence, worker RPC, and Memory Engine RPC
  checks pass;
- raw CSV parses without malformed rows and its recorded row count matches the
  export;
- regeneration of the canonical CSV from the raw CSV is deterministic and
  produces the same SHA-256 twice;
- local and repo-external bundle manifests match byte-for-byte.

The new row count is recorded as observed; it is not required to be `941`, and
must not be backdated or presented as the lost historical snapshot.

### 10.4 Forward and rollback comparisons

Before any future M2C.3 forward attempt, recapture the current canonical CSV
with the same frozen query and require bidirectional set equality with the new
baseline: `baseline EXCEPT current = 0` and
`current EXCEPT baseline = 0`. Abort on any difference.

After forward, compare against the same baseline and require that the complete
bidirectional delta equals the reviewed M2C.3 allowlist exactly. After rollback,
recapture again and require both directions to be zero. Compare tuple sets and
SHA-256 artifacts; matching row counts alone never pass the gate.

This section records the evidence procedure used for M2C.3. It does not
authorize rollback, M2C.4, deployment, or any further permission mutation.
