import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const forward = readFileSync(new URL("../supabase_multi_user_m2c3_grant_containment.sql", import.meta.url), "utf8")
const validation = readFileSync(new URL("../supabase_multi_user_m2c3_grant_validation.sql", import.meta.url), "utf8")
const rollback = readFileSync(new URL("../supabase_multi_user_m2c3_grant_rollback.sql", import.meta.url), "utf8")

const coreTables = ["conversation_summary", "conversations", "memories", "messages", "user_state"]
const sequences = [
  "album_assets_id_seq",
  "background_worker_run_audit_id_seq",
  "conversation_summary_id_seq",
  "moment_candidates_id_seq",
  "moment_check_audit_id_seq",
  "moment_xiaoc_activity_id_seq",
  "treehole_execution_audit_id_seq",
  "xiaoc_proactive_tasks_id_seq",
]
const guards = [
  "xiaoc_memory_guard_append_only",
  "xiaoc_memory_guard_embedding_transition",
  "xiaoc_memory_guard_import_run",
  "xiaoc_memory_guard_item_immutable",
  "xiaoc_memory_guard_operation_transition",
]
const inheritedServiceFunctions = [
  "check_pending_moments_for_xiaoc",
  "xiaoc_memory_guard_append_only",
  "xiaoc_memory_guard_embedding_transition",
  "xiaoc_memory_guard_import_run",
]

test("M2C.3 is an atomic ACL-only migration with drift detection", () => {
  const executableSql = forward.replace(/^\s*--.*$/gm, "")

  assert.match(forward, /^-- Multi-user M2C\.3/m)
  assert.match(forward, /begin;[\s\S]*commit;/i)
  assert.match(forward, /pg_advisory_xact_lock/)
  assert.match(forward, /M2C3_PARTIAL_OR_DRIFTED_ACL_STATE/)
  assert.match(forward, /v_before :=/)
  assert.match(forward, /v_after :=/)

  assert.doesNotMatch(forward, /\b(?:create|alter|drop)\s+table\b/i)
  assert.doesNotMatch(forward, /\b(?:enable|disable|force)\s+row\s+level\s+security\b/i)
  assert.doesNotMatch(forward, /\bcreate\s+policy\b/i)
  assert.doesNotMatch(forward, /\b(?:insert|update|delete|truncate)\s+(?:into|from|table)\b/i)
  assert.doesNotMatch(executableSql, /storage\.|ombre|auth\.users|user_uuid|owner_uuid/i)
})

test("M2C.3 removes the exposed Moment RPC and direct trigger-function execution", () => {
  assert.match(forward, /revoke all on function public\.check_pending_moments_for_xiaoc\(\) from public, anon, authenticated/i)
  assert.match(forward, /grant execute on function public\.check_pending_moments_for_xiaoc\(\) to service_role/i)
  for (const guard of guards) {
    assert.match(forward, new RegExp(`revoke all on function public\\.${guard}\\(\\) from public, anon, authenticated`, "i"))
    assert.match(rollback, new RegExp(`grant execute on function public\\.${guard}\\(\\) to public, anon, authenticated, service_role`, "i"))
  }
})

test("M2C.3 distinguishes inherited and explicit service EXECUTE", () => {
  assert.match(forward, /v_canonical_service_function_grants = 0/)
  assert.match(forward, /v_canonical_service_function_grants = 1/)
  assert.match(validation, /canonical writer service grant is explicit/)
  assert.match(validation, /canonical inherited guard service grants stay non-explicit/)
  for (const functionName of inheritedServiceFunctions) {
    assert.match(
      rollback,
      new RegExp(`revoke execute on function public\\.${functionName}\\(\\) from service_role`, "i"),
    )
  }
})

test("M2C.3 denies ordinary roles on RLS-off Core and all public sequences", () => {
  for (const table of coreTables) {
    assert.match(forward, new RegExp(`public\\.${table}`))
    assert.match(validation, new RegExp(`public\\.${table}`))
  }
  assert.match(forward, /revoke all privileges on table[\s\S]*from anon, authenticated/i)
  for (const sequence of sequences) {
    assert.match(forward, new RegExp(`public\\.${sequence}`))
    assert.match(rollback, new RegExp(`public\\.${sequence}`))
  }
  assert.match(forward, /revoke all privileges on sequence[\s\S]*from anon, authenticated/i)
})

test("synthetic canonical ACL forward then rollback is an exact set round trip", () => {
  const canonicalBefore = new Set([
    ...inheritedServiceFunctions.map((name) => `${name}:PUBLIC:EXECUTE`),
    ...inheritedServiceFunctions.flatMap((name) => [
      `${name}:anon:EXECUTE`,
      `${name}:authenticated:EXECUTE`,
    ]),
  ])
  const afterForward = new Set(canonicalBefore)
  for (const name of inheritedServiceFunctions) {
    afterForward.delete(`${name}:PUBLIC:EXECUTE`)
    afterForward.delete(`${name}:anon:EXECUTE`)
    afterForward.delete(`${name}:authenticated:EXECUTE`)
  }
  afterForward.add("check_pending_moments_for_xiaoc:service_role:EXECUTE")

  const afterRollback = new Set(afterForward)
  for (const name of inheritedServiceFunctions) {
    afterRollback.add(`${name}:PUBLIC:EXECUTE`)
    afterRollback.add(`${name}:anon:EXECUTE`)
    afterRollback.add(`${name}:authenticated:EXECUTE`)
    afterRollback.delete(`${name}:service_role:EXECUTE`)
  }
  assert.deepEqual([...afterRollback].sort(), [...canonicalBefore].sort())
})

test("PostgreSQL 17 MAINTAIN is baselined, denied, validated, and reversible", () => {
  assert.match(forward, /v_core_grants = 80/i)
  assert.match(forward, /v_high_risk_grants = 140/i)
  assert.match(forward, /v_default_acl_grants = 24/i)
  assert.match(forward, /revoke truncate, references, trigger, maintain on table/i)
  assert.match(forward, /revoke references, trigger, maintain on table/i)
  assert.match(validation, /high-risk privilege including MAINTAIN/i)
  assert.match(validation, /'TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'/i)
  assert.match(rollback, /grant truncate, references, trigger, maintain on table/i)
  assert.match(rollback, /grant references, trigger, maintain on table/i)
  assert.equal(forward.match(/\('public\.[^']+', 'MAINTAIN'\)/g)?.length, 18)
})

test("future defaults become explicit without reducing service_role", () => {
  assert.match(forward, /alter default privileges for role postgres in schema public revoke all privileges on tables from anon, authenticated/i)
  assert.match(forward, /alter default privileges for role postgres in schema public revoke all privileges on sequences from anon, authenticated/i)
  assert.match(forward, /alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated/i)
  assert.doesNotMatch(forward, /revoke[^;]*from service_role/i)
})

test("validation covers private, worker, sequence, Core, and Memory Engine lanes", () => {
  for (const label of [
    "check_pending retained for service_role",
    "service core table lane retained",
    "service sequence lane retained",
    "Memory Engine callable RPCs remain service-only",
    "worker RPCs retain service execute",
  ]) assert.match(validation, new RegExp(label))
  assert.match(validation, /begin transaction read only/i)
  assert.match(validation, /rollback;/i)
})

test("rollback restores every privilege class changed by forward", () => {
  assert.match(rollback, /begin;[\s\S]*commit;/i)
  assert.match(rollback, /grant all privileges on table[\s\S]*to anon, authenticated, service_role/i)
  assert.match(rollback, /grant all privileges on sequence[\s\S]*to anon, authenticated, service_role/i)
  assert.match(rollback, /alter default privileges[\s\S]*grant execute on functions to anon, authenticated, service_role/i)
  assert.match(rollback, /M2C3_ROLLBACK_NOT_CANONICAL/)
  assert.doesNotMatch(rollback, /\b(?:create|alter|drop)\s+table\b/i)
  assert.doesNotMatch(rollback, /\bcreate\s+policy\b/i)
})
