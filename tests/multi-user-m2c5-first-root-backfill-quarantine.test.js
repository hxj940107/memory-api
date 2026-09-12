import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const forward = readFileSync(new URL('../supabase_multi_user_m2c5_first_root_backfill_quarantine.sql', import.meta.url), 'utf8')
const validation = readFileSync(new URL('../supabase_multi_user_m2c5_first_root_backfill_validation.sql', import.meta.url), 'utf8')
const recovery = readFileSync(new URL('../supabase_multi_user_m2c5_first_root_backfill_recovery.sql', import.meta.url), 'utf8')

test('package requires verified external identity and frozen manifest inputs', () => {
  for (const key of ['run_id', 'target_user_uuid', 'mapping_version', 'mapping_digest', 'summary_metadata_digest', 'expected_counts']) {
    assert.match(forward, new RegExp(`xiaoc\\.m2c5\\.${key}`))
  }
  assert.match(forward, /select 1 from auth\.users where id=v_target/i)
  assert.doesNotMatch(forward, /insert into auth\.users/i)
})

test('missing count keys and changed Summary metadata fail closed', () => {
  assert.match(forward, /M2C5_EXPECTED_COUNTS_INCOMPLETE/i)
  assert.match(forward, /is distinct from \(v_expected->a\.source_table->>'before'\)::bigint/i)
  assert.match(forward, /M2C5_SUMMARY_CORE_METADATA_DIGEST_CHANGED/i)
  assert.match(validation, /summary_metadata_digest/i)
  assert.doesNotMatch(forward, /coalesce\(summary,|core_memory_snapshot\s*[,)]/i)
})

test('only user is approved while small_c and test are quarantined', () => {
  assert.match(forward, /'private-current:user','user','private-current','approved-target',target_user_id/i)
  assert.match(forward, /'historical-valid:small_c','small_c','historical-valid','quarantine',null/i)
  assert.match(forward, /'test-prototype:test','test','test-prototype','quarantine',null/i)
  assert.match(validation, /small_c and test remain unassigned/i)
})

test('unknown, null, and wrong-owner children fail closed', () => {
  assert.match(forward, /M2C5_UNKNOWN_OR_NULL_CORE_OWNER/i)
  assert.match(forward, /M2C5_USER_MESSAGE_PARENT_MISSING_OR_CROSS_OWNER/i)
  assert.doesNotMatch(forward, /else\s+['"]?user['"]?/i)
})

test('Summary owner comes only from an unambiguous approved parent', () => {
  assert.match(forward, /select count\(\*\) from public\.conversations c where c\.conversation_id=s\.conversation_id and c\.user_id='user'\)\s*=\s*1/i)
  assert.match(forward, /not exists \(select 1 from public\.conversations c where c\.conversation_id=s\.conversation_id and c\.user_id<>'user'\)/i)
  assert.match(validation, /Summary ownership requires approved parent/i)
})

test('two-user collision and forged child owner remain isolated in the modeled rule', () => {
  const tenantA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const tenantB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const parents = [
    { userUuid: tenantA, conversationId: 'same-id' },
    { userUuid: tenantB, conversationId: 'same-id' },
  ]
  const valid = { userUuid: tenantA, conversationId: 'same-id' }
  const forged = { userUuid: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', conversationId: 'same-id' }
  const hasTenantParent = child => parents.some(parent =>
    parent.userUuid === child.userUuid && parent.conversationId === child.conversationId)

  assert.equal(new Set(parents.map(p => `${p.userUuid}:${p.conversationId}`)).size, 2)
  assert.equal(hasTenantParent(valid), true)
  assert.equal(hasTenantParent(forged), false)
})

test('audits reconcile every table and manifest bounds recovery', () => {
  for (const field of ['before_count', 'eligible_count', 'updated_count', 'quarantined_count', 'remaining_count']) {
    assert.match(forward, new RegExp(field))
  }
  assert.match(forward, /before_count=eligible_count\+quarantined_count/i)
  assert.match(recovery, /multi_user_m2c5_row_manifest/i)
  assert.match(recovery, /M2C5_RECOVERY_MANIFEST_ROW_DRIFT/i)
  assert.match(recovery, /M2C5_RECOVERY_UNMANIFESTED_UUID_ROW/i)
  assert.match(recovery, /set lifecycle_status='suspended'/i)
  assert.doesNotMatch(recovery, /delete from auth\.users|drop table|drop column/i)
})

test('migration registries are service-only and Core RLS is not changed', () => {
  assert.match(forward, /revoke all on table[\s\S]*from public,anon,authenticated/i)
  assert.match(forward, /to service_role/i)
  assert.doesNotMatch(forward, /alter table public\.(?:conversations|messages|memories|conversation_summary|user_state) enable row level security/i)
})

test('forward and recovery are bounded transactions and M2C4 rollback is permanently closed', () => {
  for (const sql of [forward, recovery]) {
    assert.match(sql, /\bbegin;/i)
    assert.match(sql, /set local lock_timeout\s*=\s*'5s'/i)
    assert.match(sql, /\bcommit;\s*$/i)
    assert.match(sql, /lock table public\.conversations,public\.messages,public\.memories,[\s\S]*in share row exclusive mode/i)
    assert.doesNotMatch(sql, /\bcascade\b/i)
  }
  assert.match(forward, /insert into public\.companion_instances/i)
  assert.doesNotMatch(recovery, /delete from public\.companion_instances/i)
})
