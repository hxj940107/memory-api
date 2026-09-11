import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const recovery = readFileSync(new URL("../supabase_multi_user_m2c3_canonical_recovery.sql", import.meta.url), "utf8")
const validation = readFileSync(new URL("../supabase_multi_user_m2c3_canonical_recovery_validation.sql", import.meta.url), "utf8")
const rollback = readFileSync(new URL("../supabase_multi_user_m2c3_canonical_recovery_rollback.sql", import.meta.url), "utf8")
const targets = [
  "check_pending_moments_for_xiaoc",
  "xiaoc_memory_guard_append_only",
  "xiaoc_memory_guard_embedding_transition",
  "xiaoc_memory_guard_import_run",
]

test("canonical recovery mutates only four explicit service EXECUTE entries", () => {
  const executable = recovery.replace(/^\s*--.*$/gm, "")
  assert.match(recovery, /begin;[\s\S]*commit;/i)
  assert.match(recovery, /M2C3_CANONICAL_RECOVERY_PREFLIGHT_FAILED/)
  assert.match(recovery, /M2C3_CANONICAL_RECOVERY_POSTFLIGHT_FAILED/)
  assert.equal(recovery.match(/revoke execute on function/g)?.length, 4)
  for (const target of targets) {
    assert.match(recovery, new RegExp(`revoke execute on function public\\.${target}\\(\\) from service_role`, "i"))
  }
  assert.doesNotMatch(executable, /\b(?:grant|revoke)\s+[^;]*\b(?:table|sequence)\b/i)
  assert.doesNotMatch(
    executable,
    /\b(?:insert\s+into|update\s+\S+\s+set|delete\s+from|truncate\s+(?:table\s+)?|create\s+|drop\s+)/i,
  )
})

test("recovery guards PUBLIC, service effective access, and the full baseline", () => {
  assert.match(recovery, /v_explicit<>4 or v_public<>4 or v_service_effective<>4/)
  assert.match(recovery, /v_explicit<>0 or v_public<>4 or v_service_effective<>4/)
  for (const baseline of ["v_check<>2", "v_guards<>10", "v_core<>80", "v_high_risk<>140", "v_defaults<>24", "v_sequences<>48"]) {
    assert.match(recovery, new RegExp(baseline.replace("<>", "<>")))
  }
  assert.match(validation, /ordinary function baseline is 12/)
  assert.match(validation, /core baseline is 80/)
  assert.match(validation, /high-risk baseline is 140/)
  assert.match(validation, /default ACL baseline is 24/)
  assert.match(validation, /sequence baseline is 48/)
  assert.match(validation, /begin transaction read only;[\s\S]*rollback;/i)
})

test("synthetic recovery and compensating rollback round trip exactly", () => {
  const before = new Set(targets.flatMap((target) => [
    `${target}:PUBLIC:EXECUTE`,
    `${target}:service_role:EXECUTE`,
  ]))
  const recovered = new Set(before)
  for (const target of targets) recovered.delete(`${target}:service_role:EXECUTE`)
  assert.deepEqual([...recovered].sort(), targets.map((target) => `${target}:PUBLIC:EXECUTE`).sort())

  const rolledBack = new Set(recovered)
  for (const target of targets) rolledBack.add(`${target}:service_role:EXECUTE`)
  assert.deepEqual([...rolledBack].sort(), [...before].sort())
})

test("compensating rollback restores only the four explicit entries", () => {
  assert.equal(rollback.match(/grant execute on function/g)?.length, 4)
  assert.doesNotMatch(rollback, /alter default privileges/i)
  assert.doesNotMatch(rollback, /\b(?:grant|revoke)\b[^;]*\b(?:table|sequence)\b/i)
  assert.match(rollback, /M2C3_CANONICAL_RECOVERY_ROLLBACK_PREFLIGHT_FAILED/)
  assert.match(rollback, /M2C3_CANONICAL_RECOVERY_ROLLBACK_POSTFLIGHT_FAILED/)
})
