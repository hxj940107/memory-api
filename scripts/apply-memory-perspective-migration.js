import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { AI_ENDPOINTS } from "../lib/aiConfig.js"

const DEFAULT_PREVIEW = resolve("tmp", "memory-perspective-migration-preview-20260820.json")
const DEFAULT_RESULT = resolve("tmp", "memory-perspective-migration-result-20260820.json")
const DEFAULT_ROLLBACK_RESULT = resolve("tmp", "memory-perspective-migration-rollback-result-20260820.json")
const EXPECTED_RECORDS = 35

function loadEnvFile(filePath) {
  if (!filePath || !existsSync(filePath)) return

  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const clean = line.trim()
    if (!clean || clean.startsWith("#")) continue
    const separator = clean.indexOf("=")
    if (separator < 1) continue

    const key = clean.slice(0, separator).trim()
    let value = clean.slice(separator + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (!process.env[key]) process.env[key] = value
  }
}

function parseArgs(argv) {
  const options = {
    mode: "dry-run",
    preview: DEFAULT_PREVIEW,
    result: DEFAULT_RESULT,
    rollbackResult: null,
    envFile: resolve(".env.local"),
    resultExplicit: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--apply") options.mode = "apply"
    else if (arg === "--rollback") {
      options.mode = "rollback"
      options.rollbackResult = resolve(argv[++index])
    } else if (arg === "--preview") options.preview = resolve(argv[++index])
    else if (arg === "--result") {
      options.result = resolve(argv[++index])
      options.resultExplicit = true
    }
    else if (arg === "--env-file") options.envFile = resolve(argv[++index])
    else if (arg === "--help") options.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }

  if (options.mode === "rollback" && !options.rollbackResult) {
    throw new Error("--rollback requires a migration result artifact path")
  }
  if (options.mode === "rollback" && !options.resultExplicit) {
    options.result = DEFAULT_ROLLBACK_RESULT
  }

  return options
}

function normalizePreviewRecord(record) {
  return {
    bucket_id: String(record.bucket_id || "").trim(),
    old_content: String(record.old_content ?? record.original_content ?? ""),
    new_content: String(record.new_content ?? record.proposed_content ?? ""),
    needs_manual_review: Boolean(record.needs_manual_review),
  }
}

export function validatePreview(preview) {
  const records = (preview?.records || []).map(normalizePreviewRecord)
  const ids = records.map((record) => record.bucket_id)
  const errors = []

  if (records.length !== EXPECTED_RECORDS) errors.push(`Expected ${EXPECTED_RECORDS} records, found ${records.length}`)
  if (new Set(ids).size !== ids.length) errors.push("Preview contains duplicate bucket ids")
  if (records.some((record) => !record.bucket_id)) errors.push("Preview contains an empty bucket id")
  if (records.some((record) => !record.old_content || !record.new_content)) errors.push("Preview contains empty content")
  if (records.some((record) => record.needs_manual_review)) errors.push("Preview contains records requiring manual review")

  if (errors.length) throw new Error(errors.join("; "))
  return records
}

async function fetchCurrentMemories() {
  const readKey = process.env.XIAOC_MEMORY_READ_KEY
  const response = await fetch(new URL("/xiaoc/memories", AI_ENDPOINTS.memoryBaseUrl), {
    headers: readKey ? { "X-XiaoC-Key": readKey } : {},
  })
  const data = await response.json().catch(() => null)

  if (!response.ok || !Array.isArray(data?.memories)) {
    throw new Error(data?.error || `Unable to read Ombre memories: ${response.status}`)
  }

  return new Map(data.memories.map((memory) => [String(memory.id), memory]))
}

async function fetchCurrentMemory(bucketId) {
  const memories = await fetchCurrentMemories()
  return memories.get(bucketId) || null
}

function protectedMetadata(memory) {
  if (!memory) return null

  return {
    title: memory.title ?? null,
    category: memory.category ?? null,
    type: memory.type ?? null,
    domains: memory.domains ?? null,
    tags: memory.tags ?? null,
    importance: memory.importance ?? null,
    pinned: memory.pinned ?? null,
    resolved: memory.resolved ?? null,
    digested: memory.digested ?? null,
    created_at: memory.created_at ?? memory.createdAt ?? null,
  }
}

function sameMetadata(before, after) {
  return JSON.stringify(before) === JSON.stringify(after)
}

function cookieHeader(response) {
  if (typeof response.headers.getSetCookie === "function") {
    return response.headers.getSetCookie().map((cookie) => cookie.split(";", 1)[0]).join("; ")
  }

  return String(response.headers.get("set-cookie") || "")
    .split(/,(?=[^;,]+=)/)
    .map((cookie) => cookie.split(";", 1)[0])
    .join("; ")
}

async function createAdminSession() {
  if (process.env.OMBRE_SESSION_COOKIE) return process.env.OMBRE_SESSION_COOKIE
  if (!process.env.OMBRE_ADMIN_PASSWORD) {
    throw new Error("Apply/rollback requires OMBRE_ADMIN_PASSWORD or OMBRE_SESSION_COOKIE")
  }

  const response = await fetch(new URL("/auth/login", AI_ENDPOINTS.memoryBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: process.env.OMBRE_ADMIN_PASSWORD }),
  })
  const data = await response.json().catch(() => null)
  const cookie = cookieHeader(response)

  if (!response.ok || !cookie) {
    throw new Error(data?.error || `Ombre login failed: ${response.status}`)
  }

  return cookie
}

async function updateContent(bucketId, content, cookie) {
  const response = await fetch(new URL("/api/update-content", AI_ENDPOINTS.memoryBaseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Cookie: cookie,
    },
    body: JSON.stringify({ bucket_id: bucketId, content }),
  })
  const data = await response.json().catch(() => null)

  if (!response.ok || data?.success !== true) {
    throw new Error(data?.error || `Ombre update failed: ${response.status}`)
  }
}

function writeArtifact(filePath, artifact) {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8")
}

function summarize(records) {
  return records.reduce((counts, record) => {
    counts[record.status] = (counts[record.status] || 0) + 1
    return counts
  }, {})
}

async function runDryRun(previewRecords, previewPath, resultPath) {
  const current = await fetchCurrentMemories()
  const records = previewRecords.map((record) => {
    const liveMemory = current.get(record.bucket_id)
    const liveContent = liveMemory ? String(liveMemory.content || "") : undefined
    let status = "ready"
    let error = null

    if (liveContent === undefined) {
      status = "skipped_missing"
      error = "Bucket is missing from current Ombre memories"
    } else if (liveContent !== record.old_content) {
      status = "skipped_conflict"
      error = "Current content no longer matches preview old_content"
    }

    return {
      ...record,
      metadata_before: protectedMetadata(liveMemory),
      status,
      error,
    }
  })

  const artifact = {
    generated_at: new Date().toISOString(),
    mode: "dry-run",
    online_writes: false,
    source_preview: previewPath,
    counts: summarize(records),
    records,
  }
  writeArtifact(resultPath, artifact)
  return artifact
}

async function runApply(previewRecords, previewPath, resultPath) {
  const cookie = await createAdminSession()
  const artifact = {
    generated_at: new Date().toISOString(),
    mode: "apply",
    online_writes: true,
    source_preview: previewPath,
    counts: {},
    records: [],
  }

  let stopped = false

  for (const record of previewRecords) {
    if (stopped) {
      artifact.records.push({
        ...record,
        status: "not_attempted_after_stop",
        error: "A previous record conflicted or failed",
      })
      continue
    }

    const result = { ...record, status: "pending", error: null, write_applied: false }

    try {
      const currentMemory = await fetchCurrentMemory(record.bucket_id)
      const currentContent = currentMemory ? String(currentMemory.content || "") : null
      result.metadata_before = protectedMetadata(currentMemory)

      if (currentMemory === null) {
        result.status = "skipped_missing"
        result.error = "Bucket is missing from current Ombre memories"
      } else if (currentContent !== record.old_content) {
        result.status = "skipped_conflict"
        result.error = "Current content no longer matches preview old_content"
      } else {
        await updateContent(record.bucket_id, record.new_content, cookie)
        result.write_applied = true
        const verifiedMemory = await fetchCurrentMemory(record.bucket_id)
        const verifiedContent = verifiedMemory ? String(verifiedMemory.content || "") : null
        result.metadata_after = protectedMetadata(verifiedMemory)
        if (verifiedContent !== record.new_content) throw new Error("Post-update content verification failed")
        if (!sameMetadata(result.metadata_before, result.metadata_after)) {
          throw new Error("Protected metadata changed during content update")
        }
        result.status = "updated"
      }
    } catch (error) {
      result.status = "failed"
      result.error = error instanceof Error ? error.message : String(error)
    }

    if (result.status !== "updated") stopped = true

    artifact.records.push(result)
    artifact.counts = summarize(artifact.records)
    writeArtifact(resultPath, artifact)
  }

  return artifact
}

async function runRollback(sourceResult, sourceResultPath, resultPath) {
  if (sourceResult?.mode !== "apply") throw new Error("Rollback source must be an apply result artifact")
  const eligible = (sourceResult.records || []).filter(
    (record) => record.status === "updated" || record.write_applied === true
  )
  const cookie = await createAdminSession()
  const artifact = {
    generated_at: new Date().toISOString(),
    mode: "rollback",
    online_writes: true,
    source_result: sourceResultPath,
    counts: {},
    records: [],
  }

  for (const source of eligible) {
    const record = normalizePreviewRecord(source)
    const result = { ...record, status: "pending", error: null }

    try {
      const currentMemory = await fetchCurrentMemory(record.bucket_id)
      const currentContent = currentMemory ? String(currentMemory.content || "") : null
      if (currentMemory === null) {
        result.status = "skipped_missing"
        result.error = "Bucket is missing from current Ombre memories"
      } else if (currentContent !== record.new_content) {
        result.status = "rollback_conflict"
        result.error = "Current content no longer matches the applied new_content"
      } else {
        await updateContent(record.bucket_id, record.old_content, cookie)
        const verifiedMemory = await fetchCurrentMemory(record.bucket_id)
        const verifiedContent = verifiedMemory ? String(verifiedMemory.content || "") : null
        if (verifiedContent !== record.old_content) throw new Error("Post-rollback content verification failed")
        result.status = "rolled_back"
      }
    } catch (error) {
      result.status = "rollback_failed"
      result.error = error instanceof Error ? error.message : String(error)
    }

    artifact.records.push(result)
    artifact.counts = summarize(artifact.records)
    writeArtifact(resultPath, artifact)
  }

  return artifact
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log("Dry-run: node scripts/apply-memory-perspective-migration.js")
    console.log("Apply:   node scripts/apply-memory-perspective-migration.js --apply")
    console.log("Rollback: node scripts/apply-memory-perspective-migration.js --rollback <apply-result.json> --result <rollback-result.json>")
    return
  }

  loadEnvFile(options.envFile)
  let artifact

  if (options.mode === "rollback") {
    const sourceResult = JSON.parse(readFileSync(options.rollbackResult, "utf8"))
    artifact = await runRollback(sourceResult, options.rollbackResult, options.result)
  } else {
    const preview = JSON.parse(readFileSync(options.preview, "utf8"))
    const records = validatePreview(preview)
    artifact = options.mode === "apply"
      ? await runApply(records, options.preview, options.result)
      : await runDryRun(records, options.preview, options.result)
  }

  console.log(JSON.stringify({ mode: artifact.mode, result: options.result, counts: artifact.counts }, null, 2))
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
