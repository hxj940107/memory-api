import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

import { evaluateCandidateEligibility } from "../lib/xiaocMemoryEligibility.js"
import {
  OWNED_MEMORY_UI_CATEGORIES,
  XIAOC_MEMORY_LIBRARY_MANAGEMENT_POLICY_VERSION,
  XIAOC_MEMORY_OWNED_LIFECYCLE_POLICY_VERSION,
  editOwnedMemory,
  listOwnedMemoryLibrary,
  listOwnedMemories,
  mutateOwnedMemories,
  normalizeOwnedMemoryLimit,
  normalizeOwnedMemoryListStatus,
  setOwnedMemoryPin,
} from "../lib/xiaocMemoryOwnedLifecycle.js"

const MEMORY_ID = "10000000-0000-4000-8000-000000000001"

function libraryClient(rows, relations = [], pins = []) {
  return { from(table) {
    const result = table === "memory_items" ? rows : table === "memory_relations" ? relations : pins
    const query = {
      select() { return query }, eq() { return query }, in() { return query },
      order() { return query }, async limit() { return { data: result, error: null } },
      then(resolve) { return resolve({ data: result, error: null }) },
    }
    return query
  } }
}

test("owned list defaults to active, is bounded, and maps only UI-safe canonical fields", async () => {
  const calls = []
  const client = { async rpc(name, params) {
    calls.push({ name, params })
    return { data: [{
      id: MEMORY_ID,
      canonical_content: "她喜欢在雨天散步",
      memory_class: "observation",
      category: "personal_fact",
      lifecycle_status: "active",
      importance: null,
      confidence: null,
      revision: 1,
      created_at: "2026-09-20T00:00:00Z",
      updated_at: "2026-09-20T00:00:00Z",
      archived_at: null,
      deleted_at: null,
    }], error: null }
  } }
  const rows = await listOwnedMemories({ client, userId: "user", limit: 9999 })
  assert.deepEqual(calls, [{
    name: "xiaoc_memory_list_owned",
    params: { p_user_id: "user", p_lifecycle_status: "active", p_limit: 200 },
  }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].content, "她喜欢在雨天散步")
  assert.equal(rows[0].category, "关于你")
  assert.equal(rows[0].pinned, false)
  assert.equal(rows[0].pinAvailable, true)
  assert.equal(rows[0].editAvailable, true)
  assert.equal(rows[0].revision, 1)
  assert.equal(Object.hasOwn(rows[0], "title"), false)
  assert.equal(Object.hasOwn(rows[0], "tags"), false)
  assert.equal(Object.hasOwn(rows[0], "importance"), false)
  assert.equal(Object.hasOwn(rows[0], "metadata"), false)
  assert.equal(Object.hasOwn(rows[0], "user_id"), false)
})

test("owned list returns a normal empty result", async () => {
  const rows = await listOwnedMemories({
    client: { async rpc() { return { data: [], error: null } } },
    userId: "user",
  })
  assert.deepEqual(rows, [])
})

test("Memory Library uses retrieval eligibility for native and approved historical rows", async () => {
  const base = {
    user_id: "user", canonical_content: "她喜欢在雨天散步", memory_class: "observation",
    category: "personal_fact", lifecycle_status: "active", claim_key: null,
    importance: null, confidence: null, event_time: null, valid_from: null,
    valid_until: null, resolved_at: null, revision: 1,
    created_at: "2026-09-20T00:00:00Z", updated_at: "2026-09-20T00:00:00Z",
    archived_at: null, deleted_at: null,
  }
  const rows = [
    { ...base, id: MEMORY_ID, origin_system: "xiaoc_native", provenance_status: "verified_user", retrieval_tier: null, authority_tier: "native_verified" },
    { ...base, id: "10000000-0000-4000-8000-000000000002", origin_system: "ombre_legacy", provenance_status: "legacy_unverified", retrieval_tier: "low_authority", authority_tier: "legacy_limited" },
    { ...base, id: "10000000-0000-4000-8000-000000000003", origin_system: "ombre_legacy", provenance_status: "legacy_unverified", retrieval_tier: "shadow_only", authority_tier: "none" },
    { ...base, id: "10000000-0000-4000-8000-000000000004", origin_system: "ombre_legacy", provenance_status: "legacy_unverified", retrieval_tier: "disabled", authority_tier: "none" },
  ]
  const result = await listOwnedMemoryLibrary({
    client: libraryClient(rows), userId: "user", retrievalTime: "2026-09-21T00:00:00Z",
  })
  assert.deepEqual(result.map(item => item.id), [rows[0].id, rows[1].id])
  assert.ok(result.every(item => item.pinAvailable === true && item.editAvailable === true))
  assert.ok(result.every(item => !Object.hasOwn(item, "provenance_status")))
})

test("Memory Library maps the four canonical categories without exposing engineering labels or titles", async () => {
  assert.deepEqual(OWNED_MEMORY_UI_CATEGORIES, [
    { canonical: "personal_fact", label: "关于你" },
    { canonical: "relationship_memory", label: "我们之间" },
    { canonical: "meaningful_experience", label: "一起经历过" },
    { canonical: "relationship_preference", label: "相处方式" },
  ])
  const canonicalIds = new Map(OWNED_MEMORY_UI_CATEGORIES.map((entry, index) => [
    entry.canonical,
    `10000000-0000-4000-8000-00000000000${index + 1}`,
  ]))
  const rows = OWNED_MEMORY_UI_CATEGORIES.map(({ canonical }, index) => ({
    id: canonicalIds.get(canonical), user_id: "user", canonical_content: `完整正文 ${index + 1}`,
    origin_system: "xiaoc_native", memory_class: "observation", category: canonical,
    provenance_status: "verified_user", lifecycle_status: "active", retrieval_tier: null,
    authority_tier: "native_verified", claim_key: null, importance: 10, confidence: null,
    event_time: null, valid_from: null, valid_until: null, resolved_at: null, revision: 1,
    created_at: `2026-09-0${index + 1}T00:00:00Z`, updated_at: `2026-09-0${index + 1}T00:00:00Z`,
    archived_at: null, deleted_at: null,
  }))
  const result = await listOwnedMemoryLibrary({ client: libraryClient(rows), userId: "user" })
  assert.deepEqual(new Set(result.map(memory => memory.category)), new Set(OWNED_MEMORY_UI_CATEGORIES.map(entry => entry.label)))
  assert.ok(result.every(memory => !Object.hasOwn(memory, "title")))
  assert.ok(result.every(memory => !Object.hasOwn(memory, "importance")))
  assert.doesNotMatch(JSON.stringify(result), /legacy_|provenance|authority|embedding|hash/)
})

test("Memory Library sorts active pins first and otherwise remains stable", async () => {
  const row = {
    id: MEMORY_ID, user_id: "user", canonical_content: "正文",
    origin_system: "xiaoc_native", memory_class: "observation", category: "personal_fact",
    provenance_status: "verified_user", lifecycle_status: "active", retrieval_tier: null,
    authority_tier: "native_verified", claim_key: null, importance: null, confidence: null,
    event_time: null, valid_from: null, valid_until: null, resolved_at: null, revision: 1,
    created_at: "2026-09-09T00:00:00Z", updated_at: "2026-09-09T00:00:00Z",
    archived_at: null, deleted_at: null,
  }
  const newer = { ...row, id: "10000000-0000-4000-8000-000000000002", created_at: "2026-09-10T00:00:00Z", updated_at: "2026-09-10T00:00:00Z" }
  const pinned = { ...row, id: "10000000-0000-4000-8000-000000000003", created_at: "2026-09-08T00:00:00Z", updated_at: "2026-09-08T00:00:00Z" }
  const result = await listOwnedMemoryLibrary({
    client: libraryClient([row, newer, pinned], [], [{ memory_id: pinned.id, ordinal: 4 }]),
    userId: "user", retrievalTime: "2026-09-21T00:00:00Z",
  })
  assert.deepEqual(result.map(memory => memory.id), [pinned.id, newer.id, row.id])
  assert.equal(result[0].pinned, true)
  assert.equal(result[0].pinOrdinal, 4)

})

test("archived/deleted access must be explicit and invalid status fails closed", async () => {
  assert.equal(normalizeOwnedMemoryListStatus(), "active")
  assert.equal(normalizeOwnedMemoryListStatus("archived"), "archived")
  assert.equal(normalizeOwnedMemoryListStatus("deleted"), "deleted")
  assert.equal(normalizeOwnedMemoryListStatus("all"), "all")
  assert.throws(() => normalizeOwnedMemoryListStatus("superseded"), { code: "OWNED_MEMORY_INVALID_LIFECYCLE_STATUS" })
  assert.equal(normalizeOwnedMemoryLimit(0), 100)
  assert.equal(normalizeOwnedMemoryLimit(250), 200)
})

test("archive, delete, and clear use only protected lifecycle RPCs", async () => {
  const calls = []
  const client = { async rpc(name, params) {
    calls.push({ name, params })
    return { data: { changed: true }, error: null }
  } }
  await mutateOwnedMemories({ client, userId: "user", action: "archive", memoryId: MEMORY_ID, idempotencyKey: "archive-1" })
  await mutateOwnedMemories({ client, userId: "user", action: "delete", memoryId: MEMORY_ID, idempotencyKey: "delete-1" })
  await mutateOwnedMemories({ client, userId: "user", action: "clear", idempotencyKey: "clear-1" })
  assert.deepEqual(calls.map(call => call.name), [
    "xiaoc_memory_archive_owned",
    "xiaoc_memory_delete_owned",
    "xiaoc_memory_clear_owned_active",
  ])
  for (const { params } of calls) {
    assert.equal(params.p_user_id, "user")
    assert.equal(params.p_policy_version, XIAOC_MEMORY_OWNED_LIFECYCLE_POLICY_VERSION)
  }
})

test("edit uses the protected replacement RPC and pin/unpin uses the existing protected Core RPC", async () => {
  const rpcCalls = []
  const client = {
    from() {
      const query = {
        select() { return query }, eq() { return query }, order() { return query },
        async maybeSingle() { return { data: null, error: null } },
        async limit() { return { data: [], error: null } },
      }
      return query
    },
    async rpc(name, params) {
      rpcCalls.push({ name, params })
      if (name === "xiaoc_memory_edit_owned") return { data: [{ memory_id: "10000000-0000-4000-8000-000000000009", revision: 1 }], error: null }
      return { data: "20000000-0000-4000-8000-000000000001", error: null }
    },
  }
  const edited = await editOwnedMemory({
    client, userId: "user", memoryId: MEMORY_ID, content: "  更新后的正文  ", category: "相处方式",
    expectedRevision: 1, idempotencyKey: "edit-1",
  })
  const pinned = await setOwnedMemoryPin({ client, userId: "user", memoryId: MEMORY_ID, active: true, idempotencyKey: "pin-1" })
  assert.equal(edited.memory_id, "10000000-0000-4000-8000-000000000009")
  assert.equal(pinned.pinned, true)
  assert.deepEqual(rpcCalls[0], {
    name: "xiaoc_memory_edit_owned",
    params: {
      p_user_id: "user", p_memory_id: MEMORY_ID, p_canonical_content: "更新后的正文",
      p_category: "relationship_preference", p_expected_revision: 1,
      p_policy_version: XIAOC_MEMORY_LIBRARY_MANAGEMENT_POLICY_VERSION, p_idempotency_key: "edit-1",
    },
  })
  assert.equal(rpcCalls[1].name, "xiaoc_memory_set_pin")
  assert.equal(rpcCalls[1].params.p_active, true)
  assert.equal(rpcCalls[1].params.p_ordinal, 0)
})

test("owned lifecycle client rejects wrong owner, malformed IDs, missing idempotency, and RPC errors", async () => {
  const noCall = { async rpc() { assert.fail("RPC must not run") } }
  await assert.rejects(mutateOwnedMemories({
    client: noCall, userId: "other", action: "delete", memoryId: MEMORY_ID, idempotencyKey: "x",
  }), { code: "OWNED_MEMORY_OWNER_MISMATCH" })
  await assert.rejects(mutateOwnedMemories({
    client: noCall, userId: "user", action: "delete", memoryId: "bad", idempotencyKey: "x",
  }), { code: "OWNED_MEMORY_ID_REQUIRED" })
  await assert.rejects(mutateOwnedMemories({
    client: noCall, userId: "user", action: "clear",
  }), { code: "OWNED_MEMORY_IDEMPOTENCY_KEY_REQUIRED" })
  await assert.rejects(listOwnedMemories({
    client: { async rpc() { return { data: null, error: Object.assign(new Error("denied"), { code: "42501" }) } } },
    userId: "user",
  }), { code: "42501" })
})

test("migration is scoped to native rows, soft lifecycle updates, operations, and service-only execution", () => {
  const sql = fs.readFileSync("supabase_xiaoc_memory_owned_lifecycle.sql", "utf8")
  for (const fn of [
    "xiaoc_memory_list_owned", "xiaoc_memory_archive_owned",
    "xiaoc_memory_delete_owned", "xiaoc_memory_clear_owned_active",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${fn}\\(`))
    assert.match(sql, new RegExp(`revoke all on function public\\.${fn}\\([\\s\\S]*?from public, anon, authenticated;`))
    assert.match(sql, new RegExp(`grant execute on function public\\.${fn}\\([\\s\\S]*?to service_role;`))
  }
  assert.match(sql, /origin_system = 'xiaoc_native'/)
  assert.match(sql, /p_user_id is distinct from 'user'/)
  assert.match(sql, /lifecycle_status = 'archived'/)
  assert.match(sql, /lifecycle_status = 'deleted'/)
  assert.match(sql, /revision = revision \+ 1/)
  assert.match(sql, /xiaoc_memory_finish_operation/)
  assert.match(sql, /operation_type = 'archive_owned'/)
  assert.match(sql, /operation_type = 'delete_owned'/)
  assert.match(sql, /operation_type = 'clear_owned_active'/)
  assert.match(sql, /on conflict \(user_id, operation_type, idempotency_key\) do nothing/g)
  assert.match(sql, /if v_before_status = 'active' then/)
  assert.match(sql, /if v_before_status <> 'deleted' then/)
  assert.match(sql, /if v_before_status = 'superseded' then raise exception 'OWNED_MEMORY_SUPERSEDED'/)
  assert.match(sql, /origin_system = 'xiaoc_native' and lifecycle_status = 'active'/)
  assert.match(sql, /v_affected_count := coalesce\(array_length\(v_memory_ids, 1\), 0\)/)
  assert.doesNotMatch(sql, /delete\s+from\s+public\.memory_items/i)
  assert.doesNotMatch(sql, /ombre_legacy'\s+and\s+lifecycle_status\s*=\s*'active'/i)
  assert.doesNotMatch(sql, /canonical_content['"]?\s*[,)]\s*v_/i)
})

test("Memory Library lifecycle migration extends protected delete only to retrieval-eligible historical authority", () => {
  const sql = fs.readFileSync("supabase_xiaoc_memory_library_lifecycle.sql", "utf8")
  assert.match(sql, /create or replace function public\.xiaoc_memory_delete_owned\(/)
  assert.match(sql, /origin_system = 'xiaoc_native'/)
  assert.match(sql, /origin_system = 'ombre_legacy'/)
  assert.match(sql, /provenance_status = 'legacy_unverified'/)
  assert.match(sql, /retrieval_tier in \('active_legacy', 'low_authority'\)/)
  assert.match(sql, /authority_tier = 'legacy_limited'/)
  assert.match(sql, /lifecycle_status = 'deleted'/)
  assert.match(sql, /xiaoc_memory_finish_operation/)
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/)
  assert.match(sql, /grant execute on function[\s\S]*to service_role/)
  assert.doesNotMatch(sql, /delete\s+from\s+public\.memory_items/i)
  assert.doesNotMatch(sql, /shadow_only|retrieval_tier\s+in\s+\([^)]*disabled/i)
})

test("Memory Library management migration edits by immutable replacement and invalidates stale embeddings", () => {
  const sql = fs.readFileSync("supabase_xiaoc_memory_library_management.sql", "utf8")
  assert.match(sql, /create or replace function public\.xiaoc_memory_edit_owned\(/)
  assert.match(sql, /p_user_id is distinct from 'user'/)
  assert.match(sql, /p_expected_revision/)
  assert.match(sql, /lifecycle_status = 'active'/)
  assert.match(sql, /retrieval_tier in \('active_legacy', 'low_authority'\)/)
  assert.match(sql, /origin_system = 'xiaoc_native'/)
  assert.match(sql, /p_category, 'manual_confirmed', 'active', null, 'native_verified'/)
  assert.match(sql, /relation_type[\s\S]*?'supersedes'/)
  assert.match(sql, /lifecycle_status = 'superseded'/)
  assert.match(sql, /update public\.memory_embeddings[\s\S]*?rollout_status = 'stale'/)
  assert.match(sql, /insert into public\.memory_pins[\s\S]*?p_user_id, v_new_id, 'core'/)
  assert.match(sql, /revoke all on function[\s\S]*from public, anon, authenticated/)
  assert.match(sql, /grant execute on function[\s\S]*to service_role/)
  assert.doesNotMatch(sql, /delete\s+from\s+public\.memory_items/i)
  assert.doesNotMatch(sql, /update\s+public\.conversation_summary/i)
})

test("operation audit snapshots exclude content and list defaults exclude inactive lifecycle", () => {
  const sql = fs.readFileSync("supabase_xiaoc_memory_owned_lifecycle.sql", "utf8")
  const operationSnapshots = [...sql.matchAll(/jsonb_build_object\(([^;]+?)\)/gs)].map(match => match[1]).join("\n")
  assert.doesNotMatch(operationSnapshots, /canonical_content|evidence_text|metadata/)
  assert.match(sql, /p_lifecycle_status text default 'active'/)
  assert.match(sql, /p_lifecycle_status = 'all' or item\.lifecycle_status = p_lifecycle_status/)
  assert.match(sql, /limit least\(greatest\(coalesce\(p_limit, 100\), 1\), 200\)/)
})

test("archive/delete remain excluded from normal retrieval candidates", () => {
  const base = {
    id: MEMORY_ID,
    user_id: "user",
    origin_system: "xiaoc_native",
    provenance_status: "verified_user",
    authority_tier: "native_verified",
    retrieval_tier: null,
    canonical_content: "她喜欢在雨天散步",
    valid_from: null,
    valid_until: null,
    resolved_at: null,
  }
  assert.equal(evaluateCandidateEligibility({ ...base, lifecycle_status: "active" }, { userId: "user" }).eligible, true)
  for (const lifecycle_status of ["archived", "deleted"]) {
    assert.equal(evaluateCandidateEligibility({ ...base, lifecycle_status }, { userId: "user" }).eligible, false)
  }
})

test("clear is owner/native/active scoped and its resulting deleted rows are not retrievable", () => {
  const sql = fs.readFileSync("supabase_xiaoc_memory_owned_lifecycle.sql", "utf8")
  assert.match(sql, /where user_id = p_user_id and origin_system = 'xiaoc_native' and lifecycle_status = 'active'/)
  assert.match(sql, /lifecycle_status = 'deleted', deleted_at = now\(\), revision = revision \+ 1/)
  const cleared = {
    id: MEMORY_ID, user_id: "user", origin_system: "xiaoc_native",
    provenance_status: "verified_user", authority_tier: "native_verified",
    retrieval_tier: null, lifecycle_status: "deleted", canonical_content: "她喜欢在雨天散步",
  }
  assert.equal(evaluateCandidateEligibility(cleared, { userId: "user" }).eligible, false)
})

test("Memory API keeps Ombre authority unchanged and enables lifecycle only in fresh-owned mode", () => {
  const api = fs.readFileSync("api/memory.js", "utf8")
  assert.match(api, /if \(ownedMemoryAuthority\) \{[\s\S]*mutateOwnedMemories/)
  assert.match(api, /userId: req\.identity\.legacyUserId/)
  assert.match(api, /listOwnedMemoryLibrary/)
  assert.match(api, /postXiaoCMemoryAction\("\/xiaoc\/memory\/pin"/)
  assert.match(api, /postXiaoCMemoryAction\("\/xiaoc\/memory\/delete"/)
  assert.match(api, /setOwnedMemoryPin/)
  assert.match(api, /editOwnedMemory/)
  assert.match(api, /waitUntil\(ensureActiveMemoryEmbedding/)
  assert.match(api, /total: memories\.length/)
  assert.match(api, /pinnedTotal: pinned\.length/)
  assert.doesNotMatch(api, /recentCount/)
  assert.doesNotMatch(api, /owned_authoritative/)
  assert.ok(api.indexOf("requireRequestIdentity(req, res)") < api.indexOf('type === "we"'))

  const identity = fs.readFileSync("lib/requestIdentity.js", "utf8")
  assert.match(identity, /client_user_uuid_forbidden/)
  assert.match(identity, /legacy_user_id_mismatch/)
  assert.match(identity, /authentication_required/)
  assert.match(identity, /private_account_mismatch/)
})

test("Memory Library UI is four-category, body-only, two-line, and uses protected management actions", () => {
  const home = fs.readFileSync("mobile/XiaoC/src/app/we.tsx", "utf8")
  const category = fs.readFileSync("mobile/XiaoC/src/app/we/category.tsx", "utf8")
  const detail = fs.readFileSync("mobile/XiaoC/src/app/we/[id].tsx", "utf8")

  assert.doesNotMatch(home, /我慢慢记得了你，也记得了我们|现在先显示小C能浮起来的记忆|最近\s*7\s*天/)
  assert.match(home, />记忆<\/Text>/)
  assert.match(home, />钉选<\/Text>/)
  assert.match(home, /numberOfLines=\{2\}/)
  assert.match(category, /numberOfLines=\{2\}/)
  assert.match(home, /normalizeMemoryResponse\(response\)/)
  assert.match(home, /Array\.isArray\(response\.categories\)/)
  assert.match(home, /Array\.isArray\(category\?\.items\) \? category\.items : \[\]/)
  assert.match(category, /Array\.isArray\(response\?\.items\) \? response\.items : \[\]/)
  assert.doesNotMatch(`${home}\n${category}`, /memory\.title|item\.title/)
  assert.match(home, /memory\.pinned \? "📌 " : ""/)
  assert.match(detail, /编辑/)
  assert.match(detail, /删除这条记忆/)
  assert.match(detail, /Alert\.alert/)
  assert.match(detail, /action: "update"/)
  assert.match(detail, /action: "delete"/)
  assert.match(detail, /action: "pin"/)
  assert.match(detail, /已钉选，新对话开始生效/)
  assert.match(detail, /已取消钉选，新对话开始生效/)
  for (const label of ["关于你", "我们之间", "一起经历过", "相处方式"]) {
    assert.match(detail, new RegExp(label))
  }
  assert.doesNotMatch(`${home}\n${category}\n${detail}`, /importance|provenance|authority|embedding|hash/)
})
