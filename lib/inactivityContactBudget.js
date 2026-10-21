import { randomUUID } from "node:crypto"
import { getInactivitySilenceState } from "./inactivityReachOut.js"

export const INACTIVITY_BUDGET_TYPE = "inactivity_contact_budget"
const LEASE_MS = 15 * 60 * 1000
const CANDIDATE_MS = 30 * 60 * 1000

export function getInactivitySoftFallbackAt(payload, anchorAt, now = new Date()) {
  if (!payload || payload.fallback_used || payload.ordinary + payload.ceiling < 4
    || !payload.soft_candidate || Date.parse(payload.soft_candidate.valid_until) <= new Date(now).getTime()) return null
  const at = Date.parse(anchorAt) + 12 * 60 * 60 * 1000
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

function identity(task) {
  const state = getInactivitySilenceState(task)
  if (!task.user_id || !state.anchor_message_id || !state.anchor_at) throw new Error("INACTIVITY_BUDGET_IDENTITY_INVALID")
  return state
}

export async function readInactivityBudget(client, task) {
  const state = identity(task)
  const { data, error } = await client.from("xiaoc_proactive_tasks").select("id,payload")
    .eq("user_id", task.user_id).eq("type", INACTIVITY_BUDGET_TYPE)
    .eq("source_type", "silence_anchor").eq("source_id", state.anchor_message_id).maybeSingle()
  if (error) throw error
  return data
}

async function swap(client, row, payload) {
  const { data, error } = await client.from("xiaoc_proactive_tasks")
    .update({ payload: { ...payload, revision: row.payload.revision + 1 }, updated_at: new Date().toISOString() })
    .eq("id", row.id).eq("type", INACTIVITY_BUDGET_TYPE)
    .eq("payload->>revision", String(row.payload.revision)).select("id,payload").maybeSingle()
  if (error) throw error
  return data
}

// One non-runnable ledger row per real message anchor. Task recreation never resets it.
export async function reserveInactivityContact(client, task, now = new Date()) {
  const state = identity(task)
  const at = new Date(now).getTime()
  // Legacy tasks did not distinguish paid rejection from other reconsideration.
  // Conservatively retain their progress instead of granting a fresh allowance.
  const previous = Math.max(0, Number(task.payload?.prior_decline_count || 0), Number(task.payload?.reconsideration_count || 0))
  const { error } = await client.from("xiaoc_proactive_tasks").upsert({
    user_id: task.user_id, conversation_id: task.conversation_id,
    type: INACTIVITY_BUDGET_TYPE, source_type: "silence_anchor", source_id: state.anchor_message_id,
    status: "completed", due_at: new Date(now).toISOString(),
    payload: { revision: 0, ordinary: Math.min(2, previous), ceiling: Math.min(2, Math.max(0, previous - 2)), anchor_at: state.anchor_at },
  }, { onConflict: "user_id,type,source_type,source_id", ignoreDuplicates: true })
  if (error) throw error
  const row = await readInactivityBudget(client, task)
  const p = row?.payload
  if (!p || !Number.isInteger(p.revision) || !Number.isInteger(p.ordinary) || !Number.isInteger(p.ceiling)
    || p.ordinary < 0 || p.ordinary > 2 || p.ceiling < 0 || p.ceiling > 2) {
    throw new Error("INACTIVITY_BUDGET_STATE_INVALID")
  }
  if (p.message_id) return { delivered: true, messageId: p.message_id, conversationId: p.conversation_id }
  if (p.last_failure === "delivery_outcome_unknown") return { blocked: true, reason: "inactivity_delivery_outcome_unknown" }
  if (p.lease_token && Date.parse(p.lease_until) > at) return { wait: true, dueAt: p.lease_until, reason: "inactivity_contact_in_flight" }
  // An abandoned delivery cannot safely be repeated while its insert outcome is unknown.
  if (p.lease_token && p.lease_kind === "delivery") return { blocked: true, reason: "inactivity_delivery_outcome_unknown" }
  let candidate = p.candidate && Date.parse(p.candidate.valid_until) > at ? p.candidate : null
  const fallbackAt = !candidate && getInactivitySoftFallbackAt(p, state.anchor_at, now)
  if (fallbackAt && at < Date.parse(fallbackAt)) {
    return { wait: true, dueAt: fallbackAt, reason: "inactivity_soft_fallback_waits_for_ceiling" }
  }
  const useFallback = Boolean(fallbackAt && at >= Date.parse(fallbackAt))
  if (useFallback) candidate = p.soft_candidate
  const freshCandidate = Boolean(candidate)
  const stage = getInactivitySilenceState(task, now).ceiling_contact_required ? "ceiling" : "ordinary"
  if (!freshCandidate && p[stage] >= 2) {
    return stage === "ordinary"
      ? { wait: true, dueAt: state.contact_deadline_at, reason: "inactivity_ordinary_budget_reserved_for_ceiling" }
      : { blocked: true, reason: "inactivity_paid_budget_exhausted" }
  }
  const token = randomUUID()
  const next = { ...p, candidate,
    ...(useFallback ? { fallback_used: true, soft_candidate: null } : {}),
    lease_token: token, lease_kind: freshCandidate ? "delivery" : "generation",
    lease_until: new Date(at + LEASE_MS).toISOString(),
    [stage]: p[stage] + (freshCandidate ? 0 : 1),
    delivery_task_id: p.delivery_task_id || task.id,
  }
  const claimed = await swap(client, row, next)
  if (!claimed) return { wait: true, dueAt: new Date(at + 60000).toISOString(), reason: "inactivity_budget_claim_raced" }
  return { row: claimed, token, generation: candidate?.generation || null,
    deliveryTask: { ...task, id: next.delivery_task_id } }
}

export async function updateInactivityContact(client, reservation, changes) {
  if (!reservation?.row) return
  const next = await swap(client, reservation.row, { ...reservation.row.payload, ...changes })
  if (!next) throw new Error("INACTIVITY_BUDGET_OWNERSHIP_LOST")
  reservation.row = next
}

export async function persistInactivityCandidate(client, reservation, generation, now = new Date()) {
  const at = new Date(now).getTime()
  const local = new Date(at + 8 * 3600000).toISOString().slice(0, 10)
  const quietStart = Date.parse(`${local}T23:30:00+08:00`)
  const validUntil = new Date(Math.min(at + CANDIDATE_MS, quietStart)).toISOString()
  if (!generation?.content || generation.skipped) {
    return updateInactivityContact(client, reservation, {
      lease_token: null, lease_until: null, lease_kind: null,
      last_failure: generation?.diagnostics?.skip_reason || "generation_failed",
      soft_candidate: generation?.softFallbackContent ? {
        valid_until: validUntil,
        generation: { content: generation.softFallbackContent,
          diagnostics: { ...generation.diagnostics, generated_content_accepted: true,
            fallback_applied: true, fallback_reason: generation.diagnostics?.skip_reason,
            skip_reason: null } },
      } : null,
    })
  }
  await updateInactivityContact(client, reservation, {
    candidate: { generation, valid_until: validUntil },
    soft_candidate: null,
    lease_kind: "delivery", last_failure: null,
  })
}

export async function releaseInactivityContact(client, reservation) {
  return updateInactivityContact(client, reservation, { lease_token: null, lease_until: null, lease_kind: null })
}
