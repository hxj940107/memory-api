// Exact legacy/current client defaults. Custom display names have no trusted role mapping.
export const USER_MOMENT_AUTHORS = Object.freeze(["小天使", "大天使长"])
export const MOMENT_ACTIVITY_COOLDOWN_MS = 90 * 60 * 1000

export function getUserMomentActivityDeferral(moment, { userId, scheduledAt, now, deadlineAt }) {
  if (!moment || moment.user_id !== userId || !USER_MOMENT_AUTHORS.includes(moment.author)) return null
  const created = Date.parse(moment.created_at)
  const scheduled = Date.parse(scheduledAt)
  const time = new Date(now).getTime()
  const deadline = Date.parse(deadlineAt)
  if (![created, scheduled, time, deadline].every(Number.isFinite)
    || created <= scheduled || created > time || time >= deadline) return null
  const until = Math.min(created + MOMENT_ACTIVITY_COOLDOWN_MS, deadline)
  return until > time ? new Date(until).toISOString() : null
}
