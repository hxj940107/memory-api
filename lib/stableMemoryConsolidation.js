import { isContextuallyDuplicate } from "./mainChatContext.js"

const MIN_CLUSTER_SIZE = 3
const MAX_OBSERVATIONS = 60
const TRANSIENT_PATTERN = /今天|今晚|刚刚|这会儿|暂时|临时|一会儿|等下|现在有点|突然|这次|单次/
const TEMPORARY_EMOTION_PATTERN = /今天.*(?:难过|开心|烦|生气|焦虑)|现在.*(?:难过|开心|烦|生气|焦虑)|一时情绪/
const ASSISTANT_INFERENCE_PATTERN = /assistant|小C推断|模型推断|ai推断/i
const JOKE_PATTERN = /玩笑|开玩笑|比喻|打个比方|哈哈.*而已/
const ESSENCE_PATTERN = /本质上|骨子里|天生就是|人格本质|一定是个.*的人/

function metadataOf(row) {
  return row?.metadata && typeof row.metadata === "object" ? row.metadata : {}
}

function normalizeExact(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "").replace(/[，。！？、,.!?]/g, "")
}

function normalizeObservation(row) {
  const metadata = metadataOf(row)
  return {
    id: String(row?.id || ""),
    content: String(row?.content || "").trim(),
    createdAt: row?.created_at || metadata.created_at || null,
    sourceRole: metadata.source_role || metadata.role || null,
    sourceMessageId: metadata.source_message_id || null,
    sourceConversationId: metadata.source_conversation_id || null,
    type: metadata.type || null,
    consolidation: metadata.consolidation || null,
  }
}

export function isEligibleEpisodicObservation(row) {
  const item = normalizeObservation(row)
  if (!item.id || !item.content || item.type !== "episodic") return false
  if (item.sourceRole !== "user" || !item.sourceMessageId || !item.createdAt) return false
  if (ASSISTANT_INFERENCE_PATTERN.test(`${item.sourceRole} ${item.content}`)) return false
  if (TRANSIENT_PATTERN.test(item.content)) return false
  if (TEMPORARY_EMOTION_PATTERN.test(item.content)) return false
  if (JOKE_PATTERN.test(item.content)) return false
  if (ESSENCE_PATTERN.test(item.content)) return false
  return true
}

function buildConnectedCluster(seed, observations) {
  const cluster = [seed]
  const remaining = observations.filter(item => item.id !== seed.id)
  let changed = true

  while (changed) {
    changed = false
    for (const item of remaining) {
      if (cluster.includes(item)) continue
      if (cluster.some(member => isContextuallyDuplicate(member.content, item.content))) {
        cluster.push(item)
        changed = true
      }
    }
  }
  return cluster
}

function isIndependentCluster(cluster) {
  if (cluster.length < MIN_CLUSTER_SIZE) return false
  const messageIds = new Set(cluster.map(item => item.sourceMessageId).filter(Boolean))
  const timePoints = new Set(cluster.map(item => String(item.createdAt || "")).filter(Boolean))
  return messageIds.size >= MIN_CLUSTER_SIZE && timePoints.size >= MIN_CLUSTER_SIZE
}

export function findConsolidationClusters(rows, newMemoryId) {
  const observations = (rows || [])
    .filter(isEligibleEpisodicObservation)
    .map(normalizeObservation)
  const seed = observations.find(item => item.id === String(newMemoryId || ""))
  if (!seed) return []
  const cluster = buildConnectedCluster(seed, observations)
  return isIndependentCluster(cluster) ? [cluster] : []
}

function parseModelResult(value) {
  const raw = typeof value === "string" ? value : value?.reply
  const text = String(raw || "").replace(/```json|```/g, "").trim()
  if (!text.startsWith("{") || !text.endsWith("}")) return null
  try {
    const parsed = JSON.parse(text)
    return {
      shouldConsolidate: parsed.should_consolidate === true,
      proposedContent: String(parsed.proposed_content || "").trim(),
      confidence: Number(parsed.confidence),
      sourceMemoryIds: Array.isArray(parsed.source_memory_ids)
        ? [...new Set(parsed.source_memory_ids.map(String))]
        : [],
      supersedesStableId: parsed.supersedes_stable_id
        ? String(parsed.supersedes_stable_id)
        : null,
      conflict: parsed.conflict === true,
    }
  } catch {
    return null
  }
}

function buildPrompt(cluster, stableMemories) {
  return `你是 XiaoC 的 Stable Memory consolidation 判断器。只根据用户亲口形成的 observations 判断，不推断人格本质。\n\n` +
    `只输出严格 JSON，不要代码块：\n` +
    `{"should_consolidate":false,"proposed_content":"","confidence":0,"source_memory_ids":[],"supersedes_stable_id":null,"conflict":false}\n\n` +
    `规则：至少三条独立 observation 才能形成稳定事实；单次事件、临时情绪、玩笑、比喻和 assistant 推断不能 consolidation。` +
    `已有相同 stable 时 should_consolidate=false。明确更新旧事实时可填写 supersedes_stable_id；事实冲突时 conflict=true 且不得覆盖或合并。` +
    `proposed_content 使用“小C记得她”的自然关系视角，只记录 observations 直接支持的事实。\n\n` +
    `Observations:\n${cluster.map(item => `- id=${item.id} | ${item.content}`).join("\n")}\n\n` +
    `Existing Stable Memories:\n${stableMemories.map(item => `- id=${item.id} | ${item.content}`).join("\n") || "（无）"}`
}

function stableRows(rows) {
  const supersededIds = new Set(
    (rows || []).map(row => metadataOf(row).supersedes_stable_id).filter(Boolean).map(String)
  )
  return (rows || []).filter(row => {
    const type = metadataOf(row).type
    return type !== "episodic" && !supersededIds.has(String(row.id))
  })
}

function diagnostic(overrides = {}) {
  return {
    candidate_cluster_count: 0,
    llm_called: false,
    should_consolidate: false,
    stable_action: "skipped",
    reason: "no_candidate_cluster",
    ...overrides,
  }
}

export async function consolidateStableMemory({
  supabase,
  userId,
  newMemoryId,
  callSmallModel,
  now = () => new Date().toISOString(),
  logger = console,
}) {
  const { data: rows, error } = await supabase
    .from("memories")
    .select("id,content,metadata,created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(MAX_OBSERVATIONS)
  if (error) throw error

  const clusters = findConsolidationClusters(rows, newMemoryId)
  let audit = diagnostic({ candidate_cluster_count: clusters.length })
  if (!clusters.length) {
    logger.log("STABLE MEMORY CONSOLIDATION:", audit)
    return audit
  }

  const cluster = clusters[0]
  const existingStable = stableRows(rows)
  if (existingStable.some(item => (
    cluster.some(source => normalizeExact(item.content) === normalizeExact(source.content))
  ))) {
    audit = diagnostic({
      candidate_cluster_count: clusters.length,
      reason: "duplicate_existing_stable",
    })
    logger.log("STABLE MEMORY CONSOLIDATION:", audit)
    return audit
  }

  const modelOutput = await callSmallModel(buildPrompt(cluster, existingStable))
  const result = parseModelResult(modelOutput)
  audit = diagnostic({
    candidate_cluster_count: clusters.length,
    llm_called: true,
    reason: result ? "model_declined" : "invalid_json",
  })
  if (!result) {
    logger.log("STABLE MEMORY CONSOLIDATION:", audit)
    return audit
  }

  const clusterIds = new Set(cluster.map(item => item.id))
  if (result.conflict) {
    audit = { ...audit, should_consolidate: result.shouldConsolidate, reason: "conflict" }
    logger.log("STABLE MEMORY CONSOLIDATION:", audit)
    return audit
  }
  const validSources = result.sourceMemoryIds.length >= MIN_CLUSTER_SIZE
    && result.sourceMemoryIds.every(id => clusterIds.has(id))
  if (!result.shouldConsolidate || !result.proposedContent || !validSources) {
    audit = { ...audit, should_consolidate: result.shouldConsolidate, reason: validSources ? "model_declined" : "invalid_sources" }
    logger.log("STABLE MEMORY CONSOLIDATION:", audit)
    return audit
  }
  if (
    TRANSIENT_PATTERN.test(result.proposedContent)
    || TEMPORARY_EMOTION_PATTERN.test(result.proposedContent)
    || JOKE_PATTERN.test(result.proposedContent)
    || ESSENCE_PATTERN.test(result.proposedContent)
  ) {
    audit = { ...audit, reason: "unsafe_proposal" }
    logger.log("STABLE MEMORY CONSOLIDATION:", audit)
    return audit
  }
  if (!Number.isFinite(result.confidence) || result.confidence < 0 || result.confidence > 1) {
    audit = { ...audit, reason: "invalid_confidence" }
    logger.log("STABLE MEMORY CONSOLIDATION:", audit)
    return audit
  }
  if (existingStable.some(item => isContextuallyDuplicate(item.content, result.proposedContent))) {
    audit = { ...audit, reason: "duplicate_existing_stable" }
    logger.log("STABLE MEMORY CONSOLIDATION:", audit)
    return audit
  }

  const superseded = result.supersedesStableId
    ? existingStable.find(item => String(item.id) === result.supersedesStableId)
    : null
  if (result.supersedesStableId && !superseded) {
    audit = { ...audit, reason: "invalid_supersedes" }
    logger.log("STABLE MEMORY CONSOLIDATION:", audit)
    return audit
  }

  const sources = cluster.filter(item => result.sourceMemoryIds.includes(item.id))
  const consolidatedAt = now()
  const metadata = {
    type: "stable",
    consolidation: true,
    source_memory_ids: sources.map(item => item.id),
    source_message_ids: [...new Set(sources.map(item => item.sourceMessageId).filter(Boolean))],
    source_conversation_ids: [...new Set(sources.map(item => item.sourceConversationId).filter(Boolean))],
    consolidated_at: consolidatedAt,
    confidence: result.confidence,
    supersedes_stable_id: result.supersedesStableId,
  }
  const { data: created, error: insertError } = await supabase
    .from("memories")
    .insert({ user_id: userId, content: result.proposedContent, metadata })
    .select("id,content,metadata,created_at")
    .single()
  if (insertError) throw insertError

  audit = {
    ...audit,
    should_consolidate: true,
    stable_action: result.supersedesStableId ? "updated" : "created",
    reason: result.supersedesStableId ? "supersedes_created" : "stable_created",
    stable_id: created?.id || null,
  }
  logger.log("STABLE MEMORY CONSOLIDATION:", audit)
  return audit
}
