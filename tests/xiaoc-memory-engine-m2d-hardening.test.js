import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const sql = readFileSync(new URL("../supabase_xiaoc_memory_engine_m2d_hardening.sql", import.meta.url), "utf8")

test("M2D is a forward-only hardening migration with an immutable source contract", () => {
  for (const field of ["manifest_sha256", "execution_order_digest", "classification_digest", "expected_record_count", "policy_version"]) {
    assert.match(sql, new RegExp(`add column ${field}`))
  }
  assert.match(sql, /immutable import run contract cannot be changed/)
  assert.doesNotMatch(sql, /(?:truncate table|delete from) public\./i)
})

test("M2D protects the planned-applying-terminal lifecycle", () => {
  assert.match(sql, /old\.run_status = 'planned' and new\.run_status in \('applying', 'failed'\)/)
  assert.match(sql, /old\.run_status = 'applying' and new\.run_status in \('complete', 'failed'\)/)
  assert.match(sql, /old\.run_status in \('complete', 'failed'\) and new\.run_status = 'disabled'/)
  assert.match(sql, /same-user applying run required/)
})

test("M2D links run, operation, plan, map, and canonical Memory with same-user foreign keys", () => {
  assert.match(sql, /memory_operations add column import_run_id uuid/)
  assert.match(sql, /foreign key \(user_id, import_run_id\) references public\.memory_import_runs/)
  assert.match(sql, /create table public\.memory_import_plan_items/)
  assert.match(sql, /join public\.memory_import_plan_items p/)
  assert.match(sql, /join public\.memory_items i/)
})

test("M2D enforces the exact historical classification contract", () => {
  assert.match(sql, /p_expected_record_count <> 150/)
  assert.match(sql, /classification plan must be exactly 0\/6\/95\/49/)
  assert.match(sql, /legacy memory_class must be observation/)
  assert.match(sql, /'ombre_legacy','observation'/)
  assert.match(sql, /'legacy_unverified','active'/)
  assert.match(sql, /active_legacy is not approved for M2D/)
  for (const id of ["ffb8ce86aa3b", "632959ffb312", "8815e2b2c20a", "f4c1457bd8d3", "1d16fc964753", "b4db8014d06e"]) {
    assert.match(sql, new RegExp(id))
  }
})

test("M2D finalizer derives completeness and forbids native dependencies", () => {
  assert.match(sql, /create function public\.xiaoc_memory_finalize_import_run/)
  assert.match(sql, /v_count<>150/)
  assert.match(sql, /retrieval_tier='low_authority'\)<>6/)
  assert.match(sql, /retrieval_tier='shadow_only'\)<>95/)
  assert.match(sql, /retrieval_tier='disabled'\)<>49/)
  for (const table of ["memory_provenance", "memory_pins", "memory_embeddings"]) {
    assert.match(sql, new RegExp(`exists\\(select 1 from public\\.${table}`))
  }
})

test("M2D rollback is compensating, idempotent, audited, and dependency guarded", () => {
  assert.match(sql, /create function public\.xiaoc_memory_rollback_import_run/)
  assert.match(sql, /operation_type='legacy_import_rollback'.*idempotency_key=p_idempotency_key/s)
  assert.match(sql, /retrieval_tier='disabled',authority_tier='none',revision=revision\+1/)
  assert.match(sql, /exists\(select 1 from public\.memory_relations/)
  assert.doesNotMatch(sql, /delete from public\.(?:memory_items|legacy_memory_map|memory_operations)/i)
})

test("M2D keeps protected tables and RPCs behind service role", () => {
  assert.match(sql, /revoke insert,update,delete on public\.memory_import_plan_items from service_role/)
  for (const fn of ["create_import_run", "start_import_run", "fail_import_run", "finalize_import_run", "rollback_import_run"]) {
    assert.match(sql, new RegExp(`revoke all on function public\\.xiaoc_memory_${fn}`))
    assert.match(sql, new RegExp(`grant execute on function public\\.xiaoc_memory_${fn}`))
  }
})
