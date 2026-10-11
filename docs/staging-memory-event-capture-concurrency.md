# Staging event capture: two-session lock check

Run only in project `frkkcycsvxqqffyituqu`. Do not run in Production.

This checks the exact advisory-lock namespace used by event capture without committing fixture data. It does not prove end-to-end simultaneous RPC idempotency. That test requires committed, shared message fixtures visible to both sessions; the BEGIN/ROLLBACK-only fixture script cannot supply those across sessions.

Use two independent SQL Editor executions. Start A, then run B while A is sleeping. Each complete script rolls back. Do not rely on separate editor runs retaining the same connection.

Session A:

```sql
BEGIN;
SET LOCAL statement_timeout = '25s';
SELECT pg_advisory_xact_lock(hashtextextended(
  'memory-event:fictional-lock-owner:fictional-lock-chat', 0
));
SELECT pg_sleep(15);
ROLLBACK;
```

Session B, during the 15-second window:

```sql
BEGIN;
SELECT CASE WHEN NOT pg_try_advisory_xact_lock(hashtextextended(
  'memory-event:fictional-lock-owner:fictional-lock-chat', 0
)) THEN 'PASS: same event lock is held by session A'
ELSE 'INCONCLUSIVE: A did not hold the lock when B ran' END AS result;
ROLLBACK;
```

After A finishes, repeat B using this release check:

```sql
BEGIN;
SELECT CASE WHEN pg_try_advisory_xact_lock(hashtextextended(
  'memory-event:fictional-lock-owner:fictional-lock-chat', 0
)) THEN 'PASS: lock released after rollback'
ELSE 'FAIL: lock still held; check whether A is still running' END AS result;
ROLLBACK;
```

No model calls, table writes, or retained fixtures. Both lock checks must PASS. An INCONCLUSIVE result means timing/session overlap was not established; rerun A and B, rather than treating it as a pass or an RPC failure.

For the transaction validation SQL, success means the single DO completes and emits the `PASS: all 10 checks` notice containing ten PASS results. Any surfaced exception is FAIL. Fixtures and the trigger are created and tested inside one DO execution and rolled back in an internal subtransaction; the outer BEGIN/ROLLBACK also remains. If the SQL Editor stops execution at an error, issue ROLLBACK in the still-open session if applicable. Do not commit a failed validation transaction.

The transaction script also forces deferred integrity constraints before reporting results. It exercises service_role permissions and injects a transactional trigger that only affects its own generated fixtures; ROLLBACK removes this trigger and its function.

The optional project-ref database setting may be absent. Therefore it is not an identity attestation: manually confirm the SQL Editor's project ref before execution.
