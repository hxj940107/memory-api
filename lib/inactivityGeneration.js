const TOPIC_STATES = new Set(["open", "ongoing", "waiting", "completed", "uncertain"])

export function parseInactivityGeneration(raw) {
  const source = String(raw || "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim()

  try {
    const data = JSON.parse(source)
    const topicState = TOPIC_STATES.has(data.topic_state)
      ? data.topic_state
      : null

    return {
      parseFailed: false,
      shouldSend: data.should_send === true,
      contactMotivation: String(data.contact_motivation || "").trim().slice(0, 120),
      topicState,
      temporalFit: data.temporal_fit === true,
      selfContinuity: data.self_continuity === true,
      shouldReferenceTopic: data.should_reference_topic === true,
      message: String(data.message || "").trim().slice(0, 90),
      errorSummary: null,
    }
  } catch (error) {
    return {
      parseFailed: true,
      shouldSend: false,
      contactMotivation: "",
      topicState: null,
      temporalFit: false,
      selfContinuity: false,
      shouldReferenceTopic: false,
      message: "",
      errorSummary: error?.message || "Invalid JSON",
    }
  }
}

export function validateInactivityGeneration(decision) {
  if (decision?.parseFailed) return { valid: false, reason: "invalid_structured_output" }
  if (!decision?.shouldSend) return { valid: false, reason: "model_declined" }
  if (!decision.contactMotivation) return { valid: false, reason: "missing_contact_motivation" }
  if (!decision.topicState) return { valid: false, reason: "invalid_topic_state" }
  if (!decision.selfContinuity) return { valid: false, reason: "self_continuity_failed" }
  if (decision.shouldReferenceTopic && !decision.temporalFit) {
    return { valid: false, reason: "referenced_topic_temporally_unfit" }
  }
  if (!decision.message) return { valid: false, reason: "empty_output" }
  return { valid: true, reason: null }
}
