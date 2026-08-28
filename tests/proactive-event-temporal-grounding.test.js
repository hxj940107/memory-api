import assert from "node:assert/strict"
import {
  buildProactiveJudgeTimeAuthority,
  normalizeProactiveEventWindow,
  resolveChineseWeekdayDate,
} from "../lib/proactiveEventTemporalGrounding.js"

const messageAt = "2026-08-27T05:45:19.133Z" // 13:45 Asia/Shanghai

{
  const grounded = normalizeProactiveEventWindow({
    local_interpreted_window: {
      start: "2026-08-27T15:30:00",
      end: null,
    },
    time_grounding_source: "relative_to_user_message",
  }, { userMessageCreatedAt: messageAt }).proposal
  assert.equal(grounded.expected_window.start, "2026-08-27T07:30:00.000Z")
  assert.equal(grounded.expected_window.end, null)
  assert.equal(grounded.time_grounding.user_message_local_time, "2026-08-27T13:45:19")
}

{
  const nextAfternoon = normalizeProactiveEventWindow({
    local_interpreted_window: {
      start: "2026-08-28T14:00:00",
      end: "2026-08-28T18:00:00",
    },
    time_grounding_source: "relative_to_user_message",
  }, { userMessageCreatedAt: messageAt }).proposal
  assert.deepEqual(nextAfternoon.expected_window, {
    start: "2026-08-28T06:00:00.000Z",
    end: "2026-08-28T10:00:00.000Z",
  })
}

{
  const friday = normalizeProactiveEventWindow({
    local_interpreted_window: {
      start: "2026-08-28T08:00:00",
      end: "2026-08-28T12:00:00",
    },
    time_grounding_source: "relative_to_user_message",
  }, { userMessageCreatedAt: messageAt }).proposal
  assert.equal(friday.expected_window.start, "2026-08-28T00:00:00.000Z")
  assert.equal(friday.expected_window.end, "2026-08-28T04:00:00.000Z")
}

{
  const none = normalizeProactiveEventWindow({
    local_interpreted_window: { start: null, end: null },
    time_grounding_source: "insufficient_time_evidence",
  }, { userMessageCreatedAt: messageAt }).proposal
  assert.deepEqual(none.expected_window, { start: null, end: null })
}

{
  const reversed = normalizeProactiveEventWindow({
    local_interpreted_window: {
      start: "2026-08-28T18:00:00",
      end: "2026-08-28T14:00:00",
    },
  }, { userMessageCreatedAt: messageAt })
  assert.equal(reversed.errorCode, "event_proposal_invalid_window_order")
  assert.deepEqual(reversed.proposal.expected_window, { start: null, end: null })
}

{
  const authority = buildProactiveJudgeTimeAuthority({
    serverNow: "2026-08-27T05:46:00.000Z",
    userMessageCreatedAt: messageAt,
  })
  assert.equal(authority.timezone, "Asia/Shanghai")
  assert.equal(authority.current_shanghai_time, "2026-08-27T13:46:00")
  assert.equal(authority.current_user_message_shanghai_time, "2026-08-27T13:45:19")
}

{
  const missing = normalizeProactiveEventWindow({
    local_interpreted_window: {
      start: "1970-01-01T08:00:00",
      end: "1970-01-01T09:00:00",
    },
    time_grounding_source: "relative_to_user_message",
  }, { userMessageCreatedAt: null })
  assert.equal(missing.errorCode, "missing_user_message_time")
  assert.deepEqual(missing.proposal.expected_window, { start: null, end: null })
  assert.equal(missing.proposal.time_grounding.user_message_created_at_utc, null)
  assert.equal(missing.proposal.time_grounding.user_message_local_time, null)
  assert.equal(missing.proposal.time_grounding.missing_user_message_time, true)

  const authority = buildProactiveJudgeTimeAuthority({ userMessageCreatedAt: null })
  assert.equal(authority.current_user_message_created_at_utc, null)
  assert.equal(authority.current_user_message_shanghai_time, null)
}

const fridayMorning = "2026-08-28T01:56:15.201Z" // Friday 09:56 Shanghai

for (const [text, expected] of [
  ["周六", "2026-08-29"],
  ["星期六", "2026-08-29"],
  ["礼拜六", "2026-08-29"],
  ["周日", "2026-08-30"],
  ["星期日", "2026-08-30"],
  ["礼拜天", "2026-08-30"],
  ["周一", "2026-08-31"],
  ["周二", "2026-09-01"],
  ["星期三", "2026-09-02"],
  ["礼拜四", "2026-09-03"],
  ["周五", "2026-08-28"],
  ["这周日", "2026-08-30"],
  ["本周日", "2026-08-30"],
  ["下周一", "2026-08-31"],
  ["下周星期日", "2026-09-06"],
  ["下周日", "2026-09-06"],
  ["下下周日", "2026-09-13"],
]) {
  const resolved = resolveChineseWeekdayDate({
    text,
    userMessageCreatedAt: fridayMorning,
  })
  assert.equal(resolved.resolved_local_date, expected, text)
  assert.equal(resolved.convention, "ISO_8601_MONDAY_1_SUNDAY_7")
}

{
  const productionCancellation = normalizeProactiveEventWindow({
    state: "cancelled",
    local_interpreted_window: {
      start: "2026-08-31T12:00:00",
      end: null,
    },
    time_grounding_source: "relative_to_user_message",
  }, {
    userMessageCreatedAt: fridayMorning,
    userMessage: "本来周日约了朋友吃饭的 取消了😑",
  }).proposal
  assert.equal(
    productionCancellation.time_grounding.local_interpreted_window.start,
    "2026-08-30T12:00:00",
  )
  assert.equal(
    productionCancellation.expected_window.start,
    "2026-08-30T04:00:00.000Z",
  )
  assert.equal(productionCancellation.time_grounding.weekday_grounding.corrected, true)
}

{
  const sundayMorning = "2026-08-30T00:00:00.000Z" // Sunday 08:00 Shanghai
  const sameSundayEvening = resolveChineseWeekdayDate({
    text: "周日晚上",
    userMessageCreatedAt: sundayMorning,
    targetLocalTime: { hour: 20, minute: 0, second: 0 },
  })
  assert.equal(sameSundayEvening.resolved_local_date, "2026-08-30")

  const nextSundayAfterPassedTime = resolveChineseWeekdayDate({
    text: "周日早上",
    userMessageCreatedAt: "2026-08-30T05:00:00.000Z", // Sunday 13:00 Shanghai
    targetLocalTime: { hour: 8, minute: 0, second: 0 },
  })
  assert.equal(nextSundayAfterPassedTime.resolved_local_date, "2026-09-06")
}

{
  const shanghaiAlreadyFriday = resolveChineseWeekdayDate({
    text: "周六",
    userMessageCreatedAt: "2026-08-27T17:30:00.000Z", // UTC Thursday, Shanghai Friday
  })
  assert.equal(shanghaiAlreadyFriday.anchor_local_date, "2026-08-28")
  assert.equal(shanghaiAlreadyFriday.resolved_local_date, "2026-08-29")
}

{
  const crossYear = resolveChineseWeekdayDate({
    text: "周五",
    userMessageCreatedAt: "2026-12-31T02:00:00.000Z", // Thursday Shanghai
  })
  assert.equal(crossYear.resolved_local_date, "2027-01-01")
}

{
  const explicitTime = normalizeProactiveEventWindow({
    state: "planned",
    local_interpreted_window: {
      start: "2026-08-31T15:00:00",
      end: "2026-08-31T17:00:00",
    },
    time_grounding_source: "relative_to_user_message",
  }, {
    userMessageCreatedAt: fridayMorning,
    userMessage: "周日下午3点去见朋友",
  }).proposal
  assert.deepEqual(explicitTime.time_grounding.local_interpreted_window, {
    start: "2026-08-30T15:00:00",
    end: "2026-08-30T17:00:00",
  })
  assert.deepEqual(explicitTime.expected_window, {
    start: "2026-08-30T07:00:00.000Z",
    end: "2026-08-30T09:00:00.000Z",
  })
}

{
  const overnightWindow = normalizeProactiveEventWindow({
    state: "planned",
    local_interpreted_window: {
      start: "2026-08-31T23:00:00",
      end: "2026-09-01T01:00:00",
    },
    time_grounding_source: "relative_to_user_message",
  }, {
    userMessageCreatedAt: fridayMorning,
    userMessage: "周日晚上参加活动",
  }).proposal
  assert.deepEqual(overnightWindow.time_grounding.local_interpreted_window, {
    start: "2026-08-30T23:00:00",
    end: "2026-08-31T01:00:00",
  })
}

{
  const dateOnly = resolveChineseWeekdayDate({
    text: "周日",
    userMessageCreatedAt: fridayMorning,
  })
  assert.equal(dateOnly.resolved_local_date, "2026-08-30")
}

{
  const earlySeptember = normalizeProactiveEventWindow({
    state: "planned",
    local_interpreted_window: {
      start: "2026-09-01T00:00:00",
      end: "2026-09-05T23:59:59",
    },
    time_grounding_source: "user_explicit_time",
  }, {
    userMessageCreatedAt: fridayMorning,
    userMessage: "九月初请假去医院",
  }).proposal
  assert.deepEqual(earlySeptember.time_grounding.local_interpreted_window, {
    start: "2026-09-01T00:00:00",
    end: "2026-09-05T23:59:59",
  })
  assert.deepEqual(earlySeptember.expected_window, {
    start: "2026-08-31T16:00:00.000Z",
    end: "2026-09-05T15:59:59.000Z",
  })
  assert.equal(earlySeptember.time_grounding.weekday_grounding, null)
}

console.log("proactive event temporal grounding tests passed")
