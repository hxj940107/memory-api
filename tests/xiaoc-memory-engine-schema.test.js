import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const sql = readFileSync(
  new URL("../supabase_xiaoc_memory_engine_foundation.sql", import.meta.url),
  "utf8",
)

const questionContractMigration = readFileSync(
  new URL("../supabase_xiaoc_memory_capture_question_contract.sql", import.meta.url),
  "utf8",
)

function captureVerifiedDefinition(source) {
  const start = source.indexOf("create or replace function public.xiaoc_memory_capture_verified")
  const end = source.indexOf("$$;", start)
  assert.ok(start >= 0 && end > start)
  return source.slice(start, end + 3).replace(/\r\n/g, "\n").trim()
}

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

test("verified capture evidence types align across table, canonical RPC, and migration", () => {
  const allowedTypes = ["assertion", "confirmation", "correction", "question", "other"]
  for (const source of [sql, questionContractMigration]) {
    for (const evidenceType of allowedTypes) assert.match(source, new RegExp(`'${evidenceType}'`))
    assert.match(source, /p_evidence_type is null or p_evidence_type not in \(/)
    assert.match(source, /raise exception 'unsupported evidence type'/)
    assert.doesNotMatch(source, /question-only evidence is not admissible/)
  }
  assert.match(sql, /evidence_type in \('assertion', 'confirmation', 'correction', 'question', 'other'\)/)
  assert.equal(captureVerifiedDefinition(questionContractMigration), captureVerifiedDefinition(sql))
})

test("question contract migration changes only the verified capture function and preserves protections", () => {
  assert.equal((questionContractMigration.match(/create or replace function/g) || []).length, 1)
  assert.match(questionContractMigration, /^begin;/)
  assert.match(questionContractMigration, /commit;\s*$/)
  assert.match(questionContractMigration, /security definer/)
  assert.match(questionContractMigration, /set search_path = public, extensions, pg_catalog/)
  assert.match(questionContractMigration, /v_message\.user_id <> p_user_id/)
  assert.match(questionContractMigration, /v_message\.role <> 'user'/)
  assert.match(questionContractMigration, /v_message\.conversation_id is distinct from p_source_conversation_id/)
  assert.match(questionContractMigration, /position\(p_evidence_text in v_message\.content\) = 0/)
  assert.match(questionContractMigration, /on conflict \(user_id, operation_type, idempotency_key\) do nothing/)
  assert.match(questionContractMigration, /'xiaoc_native'/)
  assert.match(questionContractMigration, /'verified_user'/)
  assert.match(questionContractMigration, /'active'/)
  assert.match(questionContractMigration, /'native_verified'/)
  assert.match(questionContractMigration, /perform public\.xiaoc_memory_finish_operation/)
  assert.doesNotMatch(questionContractMigration, /\b(?:alter|drop|truncate)\s+table\b/i)
})
