import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const fix = readFileSync(new URL("../supabase_xiaoc_memory_engine_m2d_import_permission_fix.sql", import.meta.url), "utf8")
const validation = readFileSync(new URL("../supabase_xiaoc_memory_engine_m2d_import_permission_fix_validation.sql", import.meta.url), "utf8")

test("fix changes only the deferred trigger execution context and preserves private helpers", () => {
  assert.match(fix, /alter function public\.xiaoc_memory_deferred_integrity_trigger\(\)\s+owner to postgres/i)
  assert.match(fix, /alter function public\.xiaoc_memory_deferred_integrity_trigger\(\)\s+security definer/i)
  assert.match(fix, /set search_path = public, pg_catalog/i)
  assert.match(fix, /revoke all on function public\.xiaoc_memory_assert_verified_integrity\(text, uuid\)/i)
  assert.doesNotMatch(fix, /grant\s+(?:all|insert|update|delete)/i)
  assert.doesNotMatch(fix, /(?:insert into|update|delete from) public\./i)
})

test("validation is transactional, fictitious, service-role accurate, and avoids the real run", () => {
  assert.match(validation, /^begin;/m)
  assert.match(validation, /rollback;\s*$/i)
  assert.doesNotMatch(validation, /\bcommit\b/i)
  assert.doesNotMatch(validation, /8f80b744-2db8-4f78-85a3-78a2cfec679d/i)
  assert.match(validation, /set local role service_role/i)
  assert.match(validation, /FICTITIOUS_PERMISSION_MEMORY/)
  assert.match(validation, /xiaoc_memory_import_legacy/)
  assert.match(validation, /direct memory_items insert succeeded/)
  assert.match(validation, /direct legacy map insert succeeded/)
  assert.match(validation, /direct protected state update succeeded/)
  assert.match(validation, /XIAOC_MEMORY_ENGINE_M2D_IMPORT_PERMISSION_FIX_VALIDATION_PASS/)
})
