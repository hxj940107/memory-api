# XiaoC Multi-user M2C.2 — Synthetic Rehearsal & Rollback Contract

> Status: LOCAL SYNTHETIC REHEARSAL PASS
>
> Basis: M1, M2A, M2B, M2C implementation plan, and M2C.1 evidence pack.
>
> This checkpoint did not connect to or modify Production, execute a Production migration, change application code, deploy, commit, or push. The fixture contains identifiers and lifecycle metadata only; it contains no private content.

## 1. Rehearsal boundary

The Mac has no local PostgreSQL/Supabase runtime available. M2C.2 therefore uses an executable in-memory state-machine rehearsal rather than pretending SQLite is PostgreSQL. It models Production-shaped tables, ownership relationships, composite keys, quarantine, a durable phase journal, failure injection, resume, and rollback digests.

This PASS proves data-classification and sequencing invariants. It does **not** prove PostgreSQL lock duration, query plans, `NOT VALID`/`VALIDATE CONSTRAINT` behavior, transactional DDL details, Supabase Auth integration, PostgREST schema-cache behavior, or a managed backup restore. Those remain mandatory before Production schema work.

Artifacts:

- `tests/fixtures/multi-user-m2c2-synthetic.json`: synthetic dataset with no body fields.
- `tests/multi-user-m2c2-rehearsal.test.js`: forward, failure, resume, isolation, and rollback assertions.

## 2. Synthetic cases covered

The fixture includes:

- approved synthetic `user` → tenant A (`private-current`);
- separately approved-for-rehearsal-only `small_c` → tenant B (`historical-valid`), without implying a Production ownership decision;
- unapproved `test` (`test-prototype`) and `other` (`unknown`) cohorts;
- rows with a null legacy owner;
- one Summary orphan, three published Moment candidate orphans, and two terminal Moment activity orphans;
- tenant A and B using the same `conversation_id`;
- a child message whose legacy owner conflicts with its only parent;
- Summary rows with no legacy owner, including an unambiguous parent, an ambiguous colliding ID, and no parent;
- Core tables `conversations`, `messages`, `conversation_summary`, `memories`, and `user_state` plus the orphan-bearing Moment tables.

No fixture row has a `text`, `content`, or `summary` property.

## 3. Rehearsed migration order and findings

The successful order is strict and journaled:

1. **Companion root foundation** — create empty/verified tenant roots before assigning any row.
2. **Additive UUID owner columns** — initialize them as nullable and non-authoritative.
3. **Legacy mapping registry** — freeze approved-target versus quarantine state before backfill.
4. **Backfill** — assign UUIDs only for approved registry entries; Summary ownership may be derived only from exactly one owned parent.
5. **Quarantine** — retain and exclude unapproved/null owners, orphans, ambiguous Summary rows, and cross-tenant children.
6. **Composite unique/FK definitions** — model tenant-qualified conversation and Summary identities and child ownership.
7. **Constraint validation** — validate only non-quarantined rows against companion roots and tenant-qualified parents.

Findings:

- Mapping must precede backfill; a raw alias fallback such as “anything else belongs to tenant A” is forbidden.
- Quarantine must precede constraint validation. It is a selection boundary, not data cleanup.
- Existing Summary ownership cannot be inferred from `conversation_id` if more than one tenant-qualified parent exists. The row remains quarantined.
- The target Summary/Core key is `(user_id, conversation_id)`. Two tenants can then use the same conversation ID without sharing a Summary or Core snapshot.
- Child validation must compare both UUID owner and related ID. Matching only `conversation_id` accepts cross-tenant rows.
- A phase journal/digest makes an interrupted apply detectable. Re-running completed phases is a no-op; resuming applies only the remaining suffix.
- Each stage can fail immediately after its journal boundary, stop without advancing, and roll back to the exact baseline fixture/registry digest.

## 4. Validation result

The local rehearsal verifies:

- `test`, `other`, and null-owner rows receive no UUID and remain quarantined;
- unknown cohorts are never defaulted to the private-current account;
- orphan rows remain present, receive no fabricated parent, and are not deleted;
- the cross-owner message is excluded rather than silently re-parented;
- an ambiguous legacy Summary is excluded rather than assigned by conversation ID;
- future tenant A/B Summary rows with the same conversation ID remain distinct;
- a forged cross-tenant message owner fails composite relationship validation;
- full migration is idempotent;
- a failure after backfill is detected and safely resumable;
- failure after every modeled phase can be rolled back to the original synthetic table and registry digests;
- out-of-order phase execution fails closed.

Result: **PASS within the stated local-model boundary**.

## 5. Rollback contract

### 5.1 Required artifacts before any Production apply

Every future write checkpoint must have, before execution:

- an immutable pre-apply catalog snapshot and exact ACL/default-ACL snapshot where relevant;
- a versioned mapping/quarantine manifest with per-table counts and privacy-safe digests;
- a phase journal containing `planned`, `started`, `verified`, `rolled_back`, or `committed` state;
- forward and reverse validation queries reviewed together;
- a named operator, maintenance start, rollback decision deadline, abort thresholds, and canary owner;
- verified backup/PITR facts from the Supabase dashboard plus a documented restore path;
- no dependency on downloading private bodies into repository artifacts.

### 5.2 Per-stage rollback conditions

| Stage | Roll back when | Reversible action | Required validation after rollback |
| --- | --- | --- | --- |
| Companion root foundation | unexpected root/account, ownership ambiguity, or Auth mismatch | remove only unused synthetic/new companion rows; never delete an Auth account as an automatic rollback | root count/digest and zero FK references |
| Nullable owner columns | lock/runtime budget exceeded or catalog differs | drop only unused nullable columns/indexes after proving no writers use them | original catalog shape and Private App canary |
| Mapping registry | registry digest/approval differs | restore previous immutable registry version; do not rewrite data | registry digest and approval audit |
| Backfill | any count, owner, or cohort mismatch | reverse only rows listed in the applied manifest to their prior null UUID values | per-table counts/digests; zero changes outside manifest |
| Quarantine | active row excluded or quarantined row reachable | restore prior registry/exclusion state from manifest | inclusion/exclusion count and worker/prompt reachability |
| Composite keys/FKs | index invalid, lock budget exceeded, or unexpected violation | drop only new unvalidated constraints/indexes | old queries/canaries plus catalog diff |
| Constraint validation | any included row fails | stop; keep old authoritative path; remove/leave unvalidated new constraints according to runbook | no old-path behavior change; violation set unchanged |
| M2C.3 grants | legitimate caller denied or ACL diff exceeds allowlist | restore exact captured function/default ACLs | actor matrix and worker/private canaries |

### 5.3 Rollback deadline

There is no universal clock-only deadline. Each apply must declare a concrete deadline before starting. The default contract is:

- decide rollback immediately on any invariant/canary failure;
- keep the rollback window open through one complete worker/Cron cycle and Private App chat/history/Summary/Core canary set;
- for M2C.3, keep it open for at least ten minutes (two five-minute background cycles) after grant verification;
- for a future data backfill, keep it open until manifests reconcile, workers resume, and no new writer depends on UUID columns;
- if the declared deadline is reached without complete validation, stop and roll back rather than proceeding to the next checkpoint.

The named Production operator must choose the actual maintenance window and timestamp. M2C.2 does not authorize one.

### 5.4 Reversible versus point-of-no-return

Reversible while the legacy path stays authoritative:

- empty companion root schema;
- nullable UUID columns and unused indexes;
- versioned mapping/quarantine registry;
- manifest-bounded UUID backfill;
- unvalidated composite constraints;
- narrow function grant changes with exact ACL snapshots.

Potential point-of-no-return operations, excluded from M2C.3/M2C.4 and requiring their own later cutover approval:

- dropping or overwriting legacy owner columns;
- making UUID ownership authoritative while old writers still omit it;
- enabling tenant RLS before trusted identity reaches the database;
- changing public IDs or collapsing two cohorts;
- deleting orphan/test/unknown data;
- moving Storage objects and removing original keys after clients reference new paths;
- issuing long-lived signed URLs across an ownership cutover;
- cascading account deletion;
- Ombre or Private App authority cutover.

### 5.5 Backup/PITR gate

Before any Production schema or data checkpoint, confirm and record:

- most recent restorable backup timestamp and retention;
- whether PITR is enabled and its recovery-point granularity;
- whether restore is whole-project or supports the affected database scope;
- estimated restore time and who can initiate it;
- one non-Production restore/recovery drill or an accepted limitation with an independent logical export strategy;
- that backup time predates apply and all migration manifests/ACL snapshots are stored outside the database being changed.

If PITR is unavailable, a checkpoint needs an independently verified logical rollback artifact and must not contain destructive or point-of-no-return operations. “Free plan” is not backup evidence.

## 6. Design changes required

M2B's target schema is unchanged. M2C implementation detail is tightened in four ways:

1. `conversation_summary.user_id` backfill must require exactly one tenant-qualified parent; collision or no parent means quarantine.
2. The migration registry needs a durable phase journal and registry digest, not only mapping rows.
3. Quarantine must carry an explicit reason and be applied before constraint validation.
4. Resume logic must compare the journal and catalog/data digest at every boundary; it must not merely use `IF NOT EXISTS` as proof that a prior phase completed correctly.

## 7. M2C.3 readiness

M2C.3 remains technically independent of tenant UUID backfill. Its safe scope is still limited to:

- revoke `anon`/`authenticated` EXECUTE from `check_pending_moments_for_xiaoc()`;
- remove unnecessary direct EXECUTE from trigger-only guard functions;
- repair future default function privileges only after the exact default-ACL baseline is captured.

The synthetic ordering/rollback model no longer blocks preparing M2C.3. **Production apply remains STOP** until the following are closed:

- Supabase backup/PITR and restore limitations;
- exact ACL/default-ACL before-state and reverse artifact;
- named operator and timestamped rollback deadline;
- service/private/worker canary procedure;
- separate explicit Production approval.

Final state: **REHEARSAL PASS; READY TO PREPARE M2C.3, NOT AUTHORIZED TO APPLY.**
