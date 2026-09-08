import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const sql = readFileSync(
  new URL("../supabase_xiaoc_memory_engine_foundation.sql", import.meta.url),
  "utf8",
)

const tables = [
  "memory_items",
  "memory_provenance",
  "memory_relations",
  "memory_embeddings",
  "memory_pins",
  "memory_operations",
  "memory_import_runs",
  "legacy_memory_map",
]

test("M2B creates only the eight isolated Memory Engine tables", () => {
  for (const table of tables) {
    assert.match(sql, new RegExp(`create table public\\.${table} \\(`))
    assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`))
  }
  assert.equal((sql.match(/create table public\./g) || []).length, tables.length)
  assert.doesNotMatch(sql, /(?:alter|drop|truncate) table public\.(?:memories|messages|conversation_summary)\b/i)
})

test("M2B keeps four dimensions and same-user foreign keys", () => {
  for (const column of [
    "provenance_status",
    "lifecycle_status",
    "retrieval_tier",
    "authority_tier",
  ]) assert.match(sql, new RegExp(`${column} text`))

  for (const table of [
    "memory_provenance",
    "memory_relations",
    "memory_embeddings",
    "memory_pins",
    "legacy_memory_map",
  ]) {
    const start = sql.indexOf(`create table public.${table}`)
    const end = sql.indexOf(";", start)
    assert.match(sql.slice(start, end), /foreign key \(user_id, [^)]+\)/)
  }
})

test("M2B protects verified provenance and manual locator idempotency", () => {
  assert.match(sql, /source_locator_key text not null/)
  assert.match(sql, /unique \(user_id, memory_id, source_kind, source_locator_key, evidence_hash\)/)
  assert.match(sql, /create constraint trigger memory_items_verified_integrity/)
  assert.match(sql, /deferrable initially deferred/)
  assert.match(sql, /verified_user memory requires valid message provenance/)
  assert.match(sql, /derived_verified memory requires verified consolidation lineage/)
  assert.match(sql, /manual_confirmed memory requires valid manual provenance/)
})

test("M2B makes relation, import, embedding and operation invariants explicit", () => {
  assert.match(sql, /supersedes cycle rejected/)
  assert.match(sql, /uuid_generate_v5/)
  assert.match(sql, /legacy identity content hash conflict/)
  assert.match(sql, /memory_embeddings_one_active_idx/)
  assert.match(sql, /where rollout_status = 'active'/)
  assert.doesNotMatch(sql, /rollout_status[^\n]*'failed'/)
  assert.match(sql, /terminal operation cannot be changed/)
  assert.match(sql, /revoke insert, update, delete on public\.memory_relations from service_role/)
})

test("M2B does not add runtime API code or seed business data", () => {
  assert.doesNotMatch(sql, /insert into public\.(?:memories|messages|conversation_summary)\b/i)
  const firstProtectedFunction = sql.indexOf("create or replace function public.xiaoc_memory_capture_verified")
  assert.ok(firstProtectedFunction > 0)
  assert.doesNotMatch(sql.slice(0, firstProtectedFunction), /insert into public\.memory_items\b/i)
})
