const IMMEDIATE_EVENT_TIME_TOLERANCE_MS = 15 * 60 * 1000

function toValidDate(value) {
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function formatMomentSourceTimes(value) {
  const source = toValidDate(value)
  if (!source) return { utc: null, shanghai: null }

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(source)
  const get = type => parts.find(part => part.type === type)?.value || ""

  return {
    utc: source.toISOString(),
    shanghai: `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+08:00`,
  }
}

export function normalizeMomentEventTime({
  shareMode,
  modelEventTime,
  sourceMessageCreatedAt,
}) {
  const source = toValidDate(sourceMessageCreatedAt)
  const model = toValidDate(modelEventTime)

  if (shareMode === "immediate" && source) {
    const differenceMs = model
      ? Math.abs(model.getTime() - source.getTime())
      : null
    const corrected = differenceMs === null || differenceMs > IMMEDIATE_EVENT_TIME_TOLERANCE_MS

    return {
      eventTime: source.toISOString(),
      modelEventTime: model?.toISOString() || null,
      sourceEventTime: source.toISOString(),
      differenceMs,
      corrected,
      correctionReason: corrected
        ? model
          ? "immediate_model_time_differs_from_source"
          : "immediate_model_time_missing"
        : null,
    }
  }

  return {
    eventTime: model?.toISOString() || null,
    modelEventTime: model?.toISOString() || null,
    sourceEventTime: source?.toISOString() || null,
    differenceMs: source && model
      ? Math.abs(model.getTime() - source.getTime())
      : null,
    corrected: false,
    correctionReason: null,
  }
}

function localDateKey(value) {
  const source = toValidDate(value)
  if (!source) return null

  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(source)
}

export function normalizeMomentCandidateForPublish(candidate, publishTime = new Date()) {
  const eventTime = toValidDate(candidate?.eventTime || candidate?.event_time)
  const target = toValidDate(publishTime)

  if (!eventTime || !target) {
    return { candidate: { ...candidate }, corrected: false, correctionReason: null }
  }

  const ageMs = Math.max(0, target.getTime() - eventTime.getTime())
  const requiresDelayedVoice = localDateKey(eventTime) !== localDateKey(target) ||
    ageMs > 3 * 60 * 60 * 1000

  if (!requiresDelayedVoice) {
    return {
      candidate: { ...candidate },
      corrected: false,
      correctionReason: null,
      requiresDelayedVoice: false,
    }
  }

  return {
    candidate: { ...candidate },
    corrected: false,
    correctionReason: "publish_window_requires_delayed_voice",
    requiresDelayedVoice: true,
  }
}
