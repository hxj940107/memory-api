import assert from "node:assert/strict"
import {
  createSummarySegment,
  mergeCompressedSummarySegments,
  sanitizeSummaryEvidence,
  selectOldestSegmentsForCompression,
  selectSummarySegmentsForPrompt,
  selectUnsummarizedOutsideRecent,
  shouldCompressSummarySegments,
} from "../lib/summarySegments.js"

function message(id, role, content) {
  return { id: String(id), role, content, created_at: `2026-08-21T00:00:${String(id).padStart(2, "0")}.000Z` }
}

// 5. Segment provenance covers exact source message IDs and checkpoint.
{
  const source = [message(1, "user", "第一件事"), message(2, "assistant", "接住第一件事")]
  const segment = createSummarySegment({
    id: "segment-1",
    content: "第一段摘要",
    messages: source,
    createdAt: "2026-08-22T00:00:00.000Z",
  })
  assert.deepEqual(segment.covered_message_ids, ["1", "2"])
  assert.equal(segment.covered_until, source[1].created_at)
  assert.equal(segment.version, 1)
}

// 6, 8. Only uncovered messages outside recent are eligible for a new segment.
{
  const messages = [
    message(1, "user", "已经总结"),
    message(2, "assistant", "尚未总结且已离开 recent"),
    message(3, "user", "仍在 recent"),
  ]
  const segments = [{
    id: "old",
    version: 1,
    content: "旧摘要",
    covered_message_ids: ["1"],
    covered_until: messages[0].created_at,
    created_at: "2026-08-22T00:00:00.000Z",
  }]
  assert.deepEqual(
    selectUnsummarizedOutsideRecent(messages, segments, ["3"]).map(item => item.id),
    ["2"]
  )
}

// 7. A segment overlapping raw recent is omitted from prompt injection.
{
  const result = selectSummarySegmentsForPrompt([{
    id: "overlap",
    version: 1,
    content: "不能与 recent 重复加权",
    covered_message_ids: ["10", "11"],
    covered_until: "2026-08-21T00:00:11.000Z",
    created_at: "2026-08-22T00:00:00.000Z",
  }], ["11"], 1000)
  assert.equal(result.content, "")
}

// 9. A one-off assistant joke/error is not promoted as summary evidence.
{
  const source = [
    message(1, "assistant", "我之前其实从来没说过这句话，我刚才说错了。"),
    message(2, "user", "换个话题吧"),
  ]
  assert.deepEqual(sanitizeSummaryEvidence(source).map(item => item.id), ["2"])
}

// 10. Old segments compress once over budget and retain union coverage.
{
  const segments = Array.from({ length: 9 }, (_, index) => ({
    id: `s${index + 1}`,
    version: 1,
    content: `摘要${index + 1}`,
    covered_message_ids: [String(index * 2 + 1), String(index * 2 + 2)],
    covered_until: `2026-08-21T00:00:${String(index + 1).padStart(2, "0")}.000Z`,
    created_at: "2026-08-22T00:00:00.000Z",
  }))
  assert.equal(shouldCompressSummarySegments(segments), true)
  const oldest = selectOldestSegmentsForCompression(segments)
  const compressed = mergeCompressedSummarySegments(oldest, "更粗粒度的旧历史", {
    id: "compressed",
    createdAt: "2026-08-23T00:00:00.000Z",
  })
  assert.deepEqual(
    [...compressed.covered_message_ids].sort((a, b) => Number(a) - Number(b)),
    oldest.flatMap(item => item.covered_message_ids)
  )
  assert.equal(compressed.covered_until, oldest.at(-1).covered_until)
}

console.log("summary segment tests passed")
