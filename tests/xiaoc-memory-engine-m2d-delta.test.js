import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

const migration = fs.readFileSync("supabase_xiaoc_memory_engine_m2d_delta.sql", "utf8")
const importer = fs.readFileSync("scripts/xiaoc-memory-engine-delta-import.js", "utf8")

test("M2D delta is locked to the reviewed snapshot, manifest, count, and digests", () => {
  for (const value of [
    "a6cc6820c7396af0eb8adc2c3b1c0a8596332beb946fbaf4bf93a86038d81e5d",
    "a8f06f3746b17423bce0d409b9437fd8882b75c2d213cbce0e03e5826b60a15f",
    "84db2db26c74441dcbe20d4df486b3bb30771f34c6b95a3b79b2221a96b386ba",
    "ff4b7d718afa1cf11e4c961860efe18e9d68718ce63b804427d6ab3687ff3e6f",
  ]) {
    assert.match(migration, new RegExp(value))
    assert.match(importer, new RegExp(value))
  }
  assert.match(migration, /jsonb_array_length\(p_plan\) <> 16/)
  assert.match(migration, /retrieval_tier <> 'shadow_only' or authority_tier <> 'none'/)
  assert.match(importer, /const EXPECTED_COUNT = 16/)
  assert.match(importer, /entry\.retrieval_tier !== "shadow_only"/)
})

test("M2D delta uses protected RPCs and does not weaken direct table grants", () => {
  for (const signature of [
    "xiaoc_memory_create_delta_import_run(jsonb, text)",
    "xiaoc_memory_finalize_delta_import_run(uuid, text)",
    "xiaoc_memory_rollback_delta_import_run(uuid, text, text)",
    "xiaoc_memory_reconcile_legacy_delta_exclusions(text, text)",
  ]) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${signature.replace(/[()]/g, "\\$&")}`))
    assert.match(migration, new RegExp(`grant execute on function public\\.${signature.replace(/[()]/g, "\\$&")} to service_role`))
  }
  assert.doesNotMatch(migration, /grant\s+(insert|update|delete)\s+on\s+(public\.)?(memory_items|memory_import_runs|memory_import_plan_items)/i)
})

test("legacy exclusions distinguish proven archive from ambiguous absence", () => {
  assert.match(migration, /lifecycle_status = 'archived'/)
  assert.match(migration, /v_missing_ids/)
  assert.match(migration, /where user_id = 'user' and id = any\(v_missing_ids\)[\s\S]*retrieval_tier <> 'disabled'/)
  assert.doesNotMatch(migration, /id = any\(v_missing_ids\)[\s\S]{0,180}lifecycle_status = 'deleted'/)
})

test("delta importer never logs Memory bodies", () => {
  assert.match(importer, /memory_bodies_logged: 0/)
  assert.doesNotMatch(importer, /console\.log\([^\n]*(body|original_content)/)
})
