import assert from "node:assert/strict"
import fs from "node:fs"
import { formatObservationDiaryTime } from "../mobile/XiaoC/src/data/observationDiary.ts"

assert.equal(formatObservationDiaryTime("2026-08-30 13:04–16:30"), "13:04–16:30")
assert.equal(formatObservationDiaryTime("2026-08-30 10:57"), "10:57")
assert.equal(formatObservationDiaryTime(""), "")

const detail = fs.readFileSync("mobile/XiaoC/src/app/diary/[id].tsx", "utf8")
assert.match(detail, /formatObservationDiaryTime\(section\.time\)/)
assert.match(detail, /entry\.footnote \? \(/)

console.log("diary presentation tests passed")
