import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const forward = readFileSync(new URL('../supabase_multi_user_m2c4_additive_uuid_foundation.sql', import.meta.url), 'utf8')
const validation = readFileSync(new URL('../supabase_multi_user_m2c4_additive_uuid_validation.sql', import.meta.url), 'utf8')
const rollback = readFileSync(new URL('../supabase_multi_user_m2c4_additive_uuid_rollback.sql', import.meta.url), 'utf8')

const coreTables = ['conversations', 'messages', 'memories', 'conversation_summary', 'user_state']
const executableTokens = (sql) => sql
  .replace(/--.*$/gm, '')
  .replace(/'(?:''|[^'])*'/g, "''")

test('forward is one bounded additive transaction', () => {
  assert.match(forward, /^--[\s\S]*\nbegin;/i)
  assert.match(forward, /commit;\s*$/i)
  assert.match(forward, /set local lock_timeout = '5s'/i)
  assert.match(forward, /set local statement_timeout = '30s'/i)
  assert.match(forward, /pg_advisory_xact_lock/i)
  const executable = executableTokens(forward)
  assert.doesNotMatch(executable, /^\s*(?:update|insert into|delete from|truncate)\b/im)
  assert.doesNotMatch(executable, /\benable row level security\b|\bforce row level security\b|\bcreate policy\b/i)
  assert.doesNotMatch(executable, /\bdrop\s+(?:table|column|constraint|index)\b/i)
})

test('companion_instances is an empty Auth UUID lifecycle root', () => {
  assert.match(forward, /create table public\.companion_instances\s*\([\s\S]*user_id uuid not null/i)
  assert.match(forward, /primary key \(user_id\)/i)
  assert.match(forward, /foreign key \(user_id\) references auth\.users\(id\)[\s\S]*on update restrict on delete restrict/i)
  for (const state of ['provisioning', 'active', 'suspended', 'pending_deletion']) {
    assert.match(forward, new RegExp(`'${state}'`))
  }
  assert.doesNotMatch(forward, /create\s+(?:or replace\s+)?trigger/i)
})

test('all five legacy tables receive only nullable default-free UUID bridges', () => {
  for (const table of coreTables) {
    assert.match(forward, new RegExp(`alter table public\\.${table} add column user_uuid uuid;`, 'i'))
    assert.doesNotMatch(forward, new RegExp(`alter table public\\.${table} add column user_uuid uuid[^;]*(?:not null|default)`, 'i'))
  }
  assert.equal((forward.match(/add column user_uuid uuid;/gi) || []).length, 5)
  assert.doesNotMatch(forward, /alter\s+column\s+user_id|drop\s+column\s+user_id/i)
})

test('root FKs are restrictive, NOT VALID, and symmetric with rollback', () => {
  for (const table of coreTables) {
    const prefix = table === 'conversation_summary' ? 'conversation_summary' : table
    const name = `${prefix}_user_uuid_fkey`
    assert.match(forward, new RegExp(`constraint ${name}[\\s\\S]{0,180}references public\\.companion_instances\\(user_id\\)[\\s\\S]{0,100}not valid`, 'i'))
    assert.match(rollback, new RegExp(`drop constraint ${name}`, 'i'))
  }
  assert.equal((forward.match(/references public\.companion_instances\(user_id\)/gi) || []).length, 5)
})

test('tenant-qualified unique keys prepare later composite FKs', () => {
  const keys = new Map([
    ['conversations_user_uuid_conversation_id_key', 'user_uuid, conversation_id'],
    ['messages_user_uuid_id_key', 'user_uuid, id'],
    ['memories_user_uuid_id_key', 'user_uuid, id'],
    ['conversation_summary_user_uuid_conversation_id_key', 'user_uuid, conversation_id'],
    ['user_state_user_uuid_key', 'user_uuid'],
  ])
  for (const [name, columns] of keys) {
    assert.match(forward, new RegExp(`constraint ${name}\\s+unique \\(${columns}\\)`, 'i'))
    assert.match(rollback, new RegExp(`drop constraint ${name}`, 'i'))
  }
  assert.doesNotMatch(forward, /foreign key \(user_uuid,\s*(?:conversation_id|last_conversation_id)\)/i)
})

test('tenant access indexes use only existing Production columns', () => {
  assert.match(forward, /conversations_user_uuid_created_at_idx[\s\S]*\(user_uuid, created_at desc, conversation_id\)/i)
  assert.match(forward, /messages_user_uuid_conversation_created_idx[\s\S]*\(user_uuid, conversation_id, created_at, id\)/i)
  assert.match(forward, /memories_user_uuid_created_at_idx[\s\S]*\(user_uuid, created_at desc, id\)/i)
  assert.doesNotMatch(forward, /conversations\s*\(user_uuid, updated_at/i)
})

test('validation is read-only and proves compatibility invariants', () => {
  assert.match(validation, /begin transaction read only;/i)
  assert.match(validation, /rollback;\s*$/i)
  assert.doesNotMatch(executableTokens(validation), /^\s*(?:grant|revoke|alter|create|drop|update|insert|delete|truncate)\b/im)
  for (const phrase of [
    'all UUID bridges remain empty',
    'legacy owner and identity columns remain unchanged',
    'legacy primary and Summary unique keys remain',
    'Core RLS remains disabled',
    'ordinary roles remain denied on root and Core',
    'service_role compatibility lane remains',
  ]) assert.match(validation, new RegExp(phrase, 'i'))
})

test('rollback fails closed after any UUID/root data and never cascades', () => {
  assert.match(rollback, /M2C4_ROLLBACK_REFUSED_UUID_DATA_EXISTS/i)
  assert.match(rollback, /exists \(select 1 from public\.companion_instances\)/i)
  for (const table of coreTables) {
    assert.match(rollback, new RegExp(`public\\.${table} where user_uuid is not null`, 'i'))
    assert.match(rollback, new RegExp(`alter table public\\.${table} drop column user_uuid`, 'i'))
  }
  assert.doesNotMatch(rollback, /\bcascade\b/i)
  assert.match(rollback, /drop table public\.companion_instances;/i)
})

test('forward preflight requires M2C.3 containment and detects partial apply', () => {
  assert.match(forward, /M2C4_PARTIAL_OR_ALREADY_APPLIED/i)
  assert.match(forward, /M2C4_LEGACY_TYPE_DRIFT/i)
  assert.match(forward, /M2C4_RLS_BASELINE_DRIFT/i)
  assert.match(forward, /M2C4_M2C3_CORE_CONTAINMENT_MISSING/i)
})
