import assert from "node:assert/strict"
import test from "node:test"
import { readFile } from "node:fs/promises"

import {
  bestEffortWriteXiaoCMemoryObservationAudit,
  buildXiaoCMemoryCorrelationHash,
  buildXiaoCMemoryNativeCaptureAuditRow,
  buildXiaoCMemoryRetrievalAuditRow,
  isXiaoCMemoryObservationAuditEnabled,
} from "../lib/xiaocMemoryObservationAudit.js"

const enabled = { XIAOC_MEMORY_OBSERVATION_AUDIT_ENABLED: "true" }
const hash = buildXiaoCMemoryCorrelationHash("10000000-0000-4000-8000-000000000001")

test("audit flag defaults off and correlation is deterministic without exposing UUID", () => {
  assert.equal(isXiaoCMemoryObservationAuditEnabled({}), false)
  assert.equal(hash, buildXiaoCMemoryCorrelationHash("10000000-0000-4000-8000-000000000001"))
  assert.match(hash, /^[0-9a-f]{64}$/)
  assert.equal(hash.includes("10000000"), false)
})

test("retrieval and native rows contain only bounded privacy-safe aggregates", () => {
  const retrieval = buildXiaoCMemoryRetrievalAuditRow({ userId: "user", telemetry: {
    correlation_id_hash: hash, eligible_opportunity: true, sampled: true, attempted: true,
    retrieval_mode: "normal_current", xiaoc: { candidate_count: 3, eligible_count: 2, selected_count: 1,
      origin_distribution: { xiaoc_native: 1 }, authority_distribution: { native_verified: 1 }, tier_distribution: { none: 1 } },
    latency: { shadow_total_ms: 12 },
  } })
  const native = buildXiaoCMemoryNativeCaptureAuditRow({ userId: "user", correlationIdHash: hash,
    eligibleOpportunity: true, attempted: true, outcome: "duplicate", totalLatencyMs: 8 })
  assert.equal(retrieval.event_kind, "retrieval_shadow")
  assert.equal(native.event_kind, "native_capture_shadow")
  assert.equal(native.outcome, "duplicate")
  const serialized = JSON.stringify([retrieval, native])
  for (const forbidden of ["raw_query", "message_uuid", "conversation_uuid", "canonical_content", "prompt", "vector", "10000000-0000"]) {
    assert.equal(serialized.includes(forbidden), false)
  }
})

test("missing table and arbitrary insert failures are swallowed", async () => {
  for (const code of ["PGRST205", "42501"]) {
    const client = { from: () => ({ insert: async () => ({ error: { code } }) }) }
    assert.equal(await bestEffortWriteXiaoCMemoryObservationAudit({ client, env: enabled,
      row: buildXiaoCMemoryNativeCaptureAuditRow({ userId: "user", correlationIdHash: hash, outcome: "skipped" }),
      logger: { warn() {} } }), false)
  }
})

test("migration locks schema, permissions, constraints, cleanup and 60-day retention", async () => {
  const sql = await readFile(new URL("../supabase_xiaoc_memory_observation_audit.sql", import.meta.url), "utf8")
  for (const value of ["retrieval_shadow", "native_capture_shadow", "duplicate", "correlation_id_hash ~ '^[0-9a-f]{64}$'",
    "enable row level security", "grant select, insert", "revoke update, delete, truncate", "default 60",
    "delete from public.xiaoc_memory_observation_audit"]) assert.ok(sql.includes(value), value)
  for (const forbidden of ["raw_query", "raw_message", "conversation_uuid", "memory_body", "prompt", "embedding", "vector", "jwt", "cookie"]) {
    assert.equal(sql.toLowerCase().includes(forbidden), false, forbidden)
  }
  assert.equal(/grant\s+(?:update|delete|truncate)/i.test(sql), false)
  const validation = await readFile(new URL("../supabase_xiaoc_memory_observation_audit_validation.sql", import.meta.url), "utf8")
  assert.ok(/begin;[\s\S]*rollback;/i.test(validation))
})
