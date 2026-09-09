import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  LOW_ALLOWLIST, MANIFEST_SHA, SOURCE_SHA, applyPlan, artifactFor, assertWriteAuthorization,
  buildPlan, classificationDigest, executionOrderDigest, parseArgs,
} from "../scripts/xiaoc-memory-engine-historical-import.js"

const archivePath = "/Users/hxj/XiaoC-Backups/ombre-volume-snapshot-2026-09-08.tar.gz"
const manifestPath = new URL("../tmp/xiaoc-memory-engine-m2c-manifest.json", import.meta.url).pathname
let cached
const result = () => (cached ||= buildPlan({ archivePath, manifestPath }))

test("default mode is dry-run and writes require the exact second authorization", () => {
  assert.equal(parseArgs([]).mode, "dry-run")
  assert.equal(parseArgs(["--dry-run"]).mode, "dry-run")
  assert.throws(() => assertWriteAuthorization(parseArgs(["--apply"])), /CONFIRM_SOURCE_SHA_REQUIRED/)
  assert.throws(() => assertWriteAuthorization(parseArgs(["--apply", "--confirm-source-sha=wrong"])), /CONFIRM_SOURCE_SHA_REQUIRED/)
  assert.doesNotThrow(() => assertWriteAuthorization(parseArgs(["--apply", `--confirm-source-sha=${SOURCE_SHA}`])))
  assert.throws(() => parseArgs(["--dry-run", "--apply"]), /CONFLICTING_MODES/)
})

test("locked real source produces the exact 150-row plan and fixed classification", () => {
  const value = result()
  assert.equal(value.plan.length, 150)
  assert.deepEqual(value.counts, { active_legacy: 0, low_authority: 6, shadow_only: 95, disabled: 49 })
  assert.equal(LOW_ALLOWLIST.size, 6)
  assert.deepEqual(value.plan.map((x) => x.legacy_external_id), [...value.plan.map((x) => x.legacy_external_id)].sort())
  assert.equal(new Set(value.plan.map((x) => x.legacy_external_id)).size, 150)
  assert.equal(new Set(value.plan.map((x) => x.deterministic_memory_id)).size, 150)
  assert.deepEqual(value.missing, [])
  assert.deepEqual(value.unexpected, [])
})

test("digest implementation is stable and mirrors the hardening SQL byte contract", () => {
  const value = result()
  assert.equal(classificationDigest(value.plan), value.classification_digest)
  assert.equal(executionOrderDigest(value.plan), value.execution_order_digest)
  const sql = readFileSync(new URL("../supabase_xiaoc_memory_engine_m2d_hardening.sql", import.meta.url), "utf8")
  assert.match(sql, /legacy_external_id\|\|chr\(31\)\|\|content_hash\|\|chr\(31\)\|\|deterministic_memory_id::text\|\|chr\(31\)\|\|retrieval_tier\|\|chr\(31\)\|\|authority_tier/)
  assert.match(sql, /chr\(30\) order by legacy_external_id collate "C"/)
  assert.match(sql, /ordinal::text\|\|chr\(31\)\|\|legacy_external_id\|\|chr\(31\)\|\|content_hash\|\|chr\(31\)\|\|deterministic_memory_id::text/)
})

test("artifact contains no Memory body or private source metadata", () => {
  const artifact = artifactFor(result())
  const text = JSON.stringify(artifact)
  for (const forbidden of ["body", "canonical_content", "original_content", "original_metadata", "original_lifecycle_hints"]) {
    assert.equal(text.includes(`\"${forbidden}\"`), false)
  }
  assert.equal(artifact.source_sha256, SOURCE_SHA)
  assert.equal(artifact.manifest_sha256, MANIFEST_SHA)
  assert.equal(artifact.entries.length, 150)
})

function mockClient({ interruptAt = Infinity, initialStatus = "planned", rejectHash = null } = {}) {
  const calls = []
  let itemCalls = 0
  let status = initialStatus
  const client = {
    calls,
    async rpc(name, params) {
      calls.push({ kind: "rpc", name, params })
      if (name === "xiaoc_memory_create_import_run") return { data: "00000000-0000-0000-0000-000000000001", error: null }
      if (name === "xiaoc_memory_start_import_run") { status = "applying"; return { data: params.p_import_run_id, error: null } }
      if (name === "xiaoc_memory_import_legacy") {
        itemCalls += 1
        if (params.p_original_content_hash === rejectHash) return { data: null, error: { code: "HASH_CONFLICT" } }
        if (itemCalls === interruptAt) return { data: null, error: { code: "NETWORK_INTERRUPTION" } }
        const item = result().plan.find((x) => x.legacy_external_id === params.p_legacy_external_id)
        return { data: item.deterministic_memory_id, error: null }
      }
      if (name === "xiaoc_memory_finalize_import_run") { status = "complete"; return { data: "00000000-0000-0000-0000-000000000002", error: null } }
      return { data: null, error: { code: "UNEXPECTED_RPC" } }
    },
    from(table) {
      calls.push({ kind: "select", table })
      return { select() { return this }, eq() { return this }, async limit() { return { data: [{ run_status: status }], error: null } } }
    },
  }
  return client
}

test("apply uses protected RPCs only and resumes safely after a simulated interruption", async () => {
  const interrupted = mockClient({ interruptAt: 74 })
  await assert.rejects(() => applyPlan(interrupted, result()), /NETWORK_INTERRUPTION/)
  assert.equal(interrupted.calls.filter((x) => x.name === "xiaoc_memory_import_legacy").length, 74)
  const resumed = mockClient({ initialStatus: "applying" })
  const outcome = await applyPlan(resumed, result())
  assert.equal(outcome.status, "complete")
  assert.equal(resumed.calls.filter((x) => x.name === "xiaoc_memory_import_legacy").length, 150)
  assert.equal(resumed.calls.some((x) => x.name === "xiaoc_memory_start_import_run"), false)
  assert.deepEqual(new Set(resumed.calls.filter((x) => x.kind === "rpc").map((x) => x.name)), new Set([
    "xiaoc_memory_create_import_run", "xiaoc_memory_import_legacy", "xiaoc_memory_finalize_import_run",
  ]))
  assert.deepEqual(new Set(resumed.calls.filter((x) => x.kind === "select").map((x) => x.table)), new Set(["memory_import_runs"]))
})

test("a different-hash conflict fails closed before finalization", async () => {
  const conflict = result().plan[20].content_hash
  const client = mockClient({ rejectHash: conflict })
  await assert.rejects(() => applyPlan(client, result()), /HASH_CONFLICT/)
  assert.equal(client.calls.some((x) => x.name === "xiaoc_memory_finalize_import_run"), false)
})

test("source, manifest, count, allowlist and classification checks exist before client construction", () => {
  const source = readFileSync(new URL("../scripts/xiaoc-memory-engine-historical-import.js", import.meta.url), "utf8")
  for (const marker of ["SOURCE_SHA_MISMATCH", "MANIFEST_SHA_MISMATCH", "SOURCE_CONTRACT_MISMATCH", "ARCHIVE_MANIFEST_COVERAGE_MISMATCH", "LOW_ALLOWLIST_MISMATCH", "CLASSIFICATION_COUNT_MISMATCH", "DETERMINISTIC_ID_MISMATCH"]) assert.match(source, new RegExp(marker))
  assert.ok(source.indexOf("const result = buildPlan(args)") < source.indexOf("createClient(url, key"))
  assert.doesNotMatch(source, /\.from\([^)]*\)\.(?:insert|update|delete|upsert)\(/)
})
