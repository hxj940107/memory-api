import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL('../supabase_multi_user_m2c3_frozen_acl_snapshot_v1.sql', import.meta.url), 'utf8');
const normalized = sql.replace(/--.*$/gm, '').replace(/\s+/g, ' ').trim().toLowerCase();

test('snapshot is explicitly read-only and closes with rollback', () => {
  assert.match(normalized, /^begin transaction read only;/);
  assert.match(normalized, /rollback;$/);
});

test('snapshot contains no mutation statements', () => {
  assert.doesNotMatch(normalized, /\b(insert|update|delete|merge|truncate|alter|create|drop|grant|revoke|call|copy)\b/);
});

test('snapshot exposes the complete canonical tuple', () => {
  for (const column of [
    'object_type', 'schema_name', 'object_name', 'owner',
    'grantor', 'grantee', 'privilege', 'grantable',
  ]) {
    assert.match(normalized, new RegExp(`\\b${column}\\b`));
  }
});

test('snapshot covers public tables, sequences, functions, and default ACLs', () => {
  assert.match(normalized, /from pg_catalog\.pg_class/);
  assert.match(normalized, /c\.relkind in \('r', 'p', 's', 'v', 'm', 'f'\)/);
  assert.match(normalized, /from pg_catalog\.pg_proc/);
  assert.match(normalized, /from pg_catalog\.pg_default_acl/);
  assert.match(normalized, /d\.defaclobjtype in \('r', 's', 'f'\)/);
});

test('internal char catalog codes are cast before text concatenation', () => {
  assert.match(normalized, /'default_privilege_' \|\| d\.defaclobjtype::text/);
  assert.match(normalized, /owner_role\.rolname \|\| ':' \|\| d\.defaclobjtype::text/);
  assert.doesNotMatch(normalized, /\|\| d\.defaclobjtype\)(?!::text)/);
});

test('function overload identity is stable', () => {
  assert.match(normalized, /pg_catalog\.pg_get_function_identity_arguments\(p\.oid\)/);
});

test('PUBLIC and duplicate tuple normalization are explicit', () => {
  assert.match(normalized, /coalesce\(grantee_role\.rolname, 'public'\)/);
  assert.match(normalized, /select distinct object_type, schema_name, object_name, owner, grantor, grantee, privilege, grantable from acl_rows/);
});

test('canonical ordering covers all eight fields with C collation', () => {
  const order = normalized.slice(normalized.lastIndexOf('order by'));
  for (const column of [
    'object_type', 'schema_name', 'object_name', 'owner',
    'grantor', 'grantee', 'privilege',
  ]) {
    assert.match(order, new RegExp(`${column} collate "c"`));
  }
  assert.match(order, /privilege collate "c", grantable; rollback;$/);
});
