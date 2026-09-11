# XiaoC Multi-user M2C.5 — First Root, Core Backfill & Quarantine

> Status: REPO PACKAGE PREPARED; PRODUCTION NOT AUTHORIZED
>
> Scope: bind one verified Supabase Auth UUID to the existing `user` cohort,
> backfill the five M2C.4 UUID bridges, and durably quarantine every excluded
> Core row. No Public App, RLS cutover, M2C.6 constraint validation, Storage,
> RPC, Ombre, or application change is included.

## Exact migration scope

M2C.5 creates service-only migration run, owner registry, row manifest,
quarantine, and table-audit relations. It inserts exactly one pre-existing,
independently verified `auth.users.id` into `companion_instances`, freezes the
mapping version/digest, and assigns that UUID only to the approved legacy
`user` cohort.

The Core rules are deterministic:

- `conversations`: legacy `user_id='user'`;
- `messages`: legacy `user_id='user'` plus a same-owner conversation parent;
- `memories` and `user_state`: legacy `user_id='user'`;
- `conversation_summary`: exactly one `user` conversation with the same
  `conversation_id`, and no non-`user` parent.

No legacy column, PK, Summary/Core payload, RLS rule, runtime lookup, or
application identity changes. The existing Private XiaoC service-role and text
`user_id` lane remains authoritative.

## Identity-binding prerequisites

The Auth account must be created through the normal Supabase Auth lifecycle,
not by inserting into `auth.users`. Before apply, the operator must independently
verify the UUID in Auth, and the user must explicitly attest that it owns the
legacy `user` cohort. The frozen execution copy supplies transaction-local
`run_id`, `target_user_uuid`, mapping version, 64-character evidence digest,
Summary/Core non-body metadata digest, and five-table expected counts. Missing
or structurally incomplete inputs fail before persistent writes.

Preflight must also prove: M2C.4 is exact; the root and bridges are empty;
observed owner aliases are exactly `user`, `small_c`, and `test`; there are no
null Core legacy owners or cross-owner `user` messages; counts/digests match;
Core writers/workers are paused or drained; and an independent logical recovery
artifact exists because Free Plan has no backup/PITR.

## Cohort and quarantine contract

- `user`: `private-current`, approved target only after explicit UUID binding.
- `small_c`: `historical-valid`, target UUID remains null, quarantined.
- `test`: `test-prototype`, target UUID remains null, quarantined.
- any new alias or null Core owner: fail closed; do not default to the first user.
- the known Summary orphan: remains present with null `user_uuid`; its row-key
  digest is registered as `summary-orphan` and no parent is fabricated.

Excluded rows retain original values. The registry stores only the minimum
service-only owner/row metadata needed to prove exclusion and recovery. No
private body, Summary text, Memory text, email, token, or signed URL is copied.
The three Moment candidate and two Moment activity orphans are outside this
five-table checkpoint; they remain untouched and retain the M2C.1 quarantine
decision for their later domain migration.

## Audit and validation

For each of the five tables, the durable audit records `before`, `eligible`,
`updated`, `quarantined`, and `remaining`, plus deterministic key-set digests.
Forward reconciliation requires:

`before = eligible + quarantined`, `updated = eligible`, and
`remaining = quarantined`.

Validation additionally proves the Auth/root binding, same-owner message and
Summary parents, zero UUID assignment to `small_c`/`test`, complete quarantine
coverage, service-only registry access, and unchanged legacy/Core RLS lane.

## Recovery and rollback boundary

The row manifest records every changed primary key and its prior UUID value.
Before M2C.6 or any UUID-dependent writer, recovery pauses writes, reverses only
manifest rows, rechecks all five count/digest sets, and marks the companion root
`suspended`. It never deletes the Auth account, private data, quarantine data,
or audit evidence.

The first committed companion row permanently closes the M2C.4 standalone
rollback window. Even after M2C.5 recovery, the root and run evidence remain;
M2C.4 rollback must never be used again. Once M2C.6 or a UUID writer begins,
recovery requires a new checkpoint-specific plan rather than this script.

## Production stop conditions

STOP on an unverified UUID, missing ownership approval, count/digest mismatch,
new/null owner cohort, cross-owner/missing parent, active writer, changed
Summary/Core metadata digest, unexpected registry object, inability to produce
logical recovery evidence, validation failure, or any change outside the
approved M2C.5 allowlist.

## Unresolved before Production preflight can pass

1. Create/identify the real private Auth account and provide its exact UUID.
2. Explicitly approve `user` → that UUID. `small_c`, `test`, and known orphans
   remain quarantined under this package.
3. Freeze the live five-table counts, eligible/quarantine counts, key digests,
   and Summary/Core metadata digest under a write pause.
4. Name the operator, maintenance window, recovery deadline, and logical export
   location; demonstrate workers/Core writers can be paused and drained.

**READY FOR M2C.5 PRODUCTION PREFLIGHT ONLY AFTER THE ABOVE INPUTS ARE FROZEN.**
