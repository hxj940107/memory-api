import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

import {
  filterMomentsForProfile,
  formatMomentProfileDate,
  getMomentAuthorType,
  getMomentProfileDayKey,
} from "../mobile/XiaoC/src/lib/momentProfile.ts"

test("structured moment author separates user and XiaoC profiles", () => {
  assert.equal(getMomentAuthorType("小C"), "xiaoc")
  assert.equal(getMomentAuthorType(undefined), "xiaoc")
  assert.equal(getMomentAuthorType("小天使"), "user")

  const moments = [
    { id: "user-old", author: "小天使", createdAt: "2026-06-01T08:00:00Z" },
    { id: "xiaoc", author: "小C", createdAt: "2026-06-03T08:00:00Z" },
    { id: "user-new", author: "小天使", createdAt: "2026-06-04T08:00:00Z" },
  ]

  assert.deepEqual(
    filterMomentsForProfile(moments, "user").map((moment) => moment.id),
    ["user-new", "user-old"],
  )
  assert.deepEqual(
    filterMomentsForProfile(moments, "xiaoc").map((moment) => moment.id),
    ["xiaoc"],
  )
})

test("timeline dates use real createdAt in Shanghai time", () => {
  const now = new Date("2026-08-30T04:00:00.000Z")

  assert.deepEqual(formatMomentProfileDate("2026-08-30T01:00:00.000Z", now), {
    primary: "今天",
    secondary: "",
  })
  assert.deepEqual(formatMomentProfileDate("2026-06-23T08:00:00.000Z", now), {
    primary: "23",
    secondary: "6月",
  })
  assert.deepEqual(formatMomentProfileDate("2025-06-19T08:00:00.000Z", now), {
    primary: "19",
    secondary: "2025年\n6月",
  })
  assert.equal(
    getMomentProfileDayKey("2026-08-29T16:30:00.000Z"),
    "2026-08-30",
  )
})

test("profile timeline is compact, navigable, and model-free", () => {
  const profileSource = readFileSync(
    "mobile/XiaoC/src/app/moments/profile/[author].tsx",
    "utf8",
  )
  const feedSource = readFileSync("mobile/XiaoC/src/app/moments.tsx", "utf8")
  const detailSource = readFileSync(
    "mobile/XiaoC/src/app/moments/[id].tsx",
    "utf8",
  )

  assert.match(profileSource, /<FlatList/)
  assert.match(profileSource, /numberOfLines=\{1\}/)
  assert.match(profileSource, /还没有动态/)
  assert.match(profileSource, /router\.push\(`\/moments\/\$\{item\.id\}`\)/)
  assert.match(feedSource, /openMomentProfile\(getMomentAuthorType\(moment\.author\)\)/)
  assert.match(feedSource, /openMomentProfile\("user"\)/)
  assert.match(detailSource, /\/moments\/profile\/\$\{getMomentAuthorType\(moment\.author\)\}/)
  assert.doesNotMatch(
    profileSource,
    /callLLM|openrouter|createEmbedding|judgeActive|update-summary/i,
  )
})

test("profile cover and signature stay lightweight and locally editable", () => {
  const profileSource = readFileSync(
    "mobile/XiaoC/src/app/moments/profile/[author].tsx",
    "utf8",
  )
  const profileStateSource = readFileSync(
    "mobile/XiaoC/src/lib/momentProfile.ts",
    "utf8",
  )

  assert.match(profileSource, /onPress=\{pickCover\}/)
  assert.match(profileSource, /launchImageLibraryAsync/)
  assert.match(profileSource, /saveMomentProfileCoverUri\(profile, savedUri\)/)
  assert.match(profileSource, /multiline/)
  assert.match(profileSource, /maxLength=\{MOMENT_PROFILE_BIO_MAX_LENGTH\}/)
  assert.match(profileSource, /saveMomentProfileBio\(profile, bioDraft\)/)
  assert.match(profileSource, /name="pencil"/)
  assert.doesNotMatch(profileSource, /coverEditHint/)
  assert.match(profileSource, /coverWrap: \{[\s\S]*height: 360/)
  assert.doesNotMatch(profileSource, /borderBottomWidth/)
  assert.match(profileSource, /color: "#FFFFFF"/)
  assert.match(profileSource, /size=\{68\}/)
  assert.match(profileStateSource, /MOMENT_PROFILE_BIO_MAX_LENGTH = 80/)
  assert.doesNotMatch(
    profileSource,
    /<Text style=\{styles\.timelineTitle\}>朋友圈<\/Text>/,
  )
})

test("Moments header avatars share the same borderless 68 point presentation", () => {
  const feedSource = readFileSync("mobile/XiaoC/src/app/moments.tsx", "utf8")
  const profileSource = readFileSync(
    "mobile/XiaoC/src/app/moments/profile/[author].tsx",
    "utf8",
  )
  const feedWrapper = feedSource.match(/profileAvatarWrap: \{([\s\S]*?)\n  \},/)
  const profileWrapper = profileSource.match(/avatarFrame: \{([\s\S]*?)\n  \},/)

  assert.match(feedSource, /profile="user"[\s\S]*size=\{68\}/)
  assert.match(profileSource, /size=\{68\}/)
  assert.ok(feedWrapper)
  assert.ok(profileWrapper)
  assert.doesNotMatch(feedWrapper[1], /padding|backgroundColor|border|shadow/)
  assert.doesNotMatch(profileWrapper[1], /padding|backgroundColor|border|shadow/)
})

test("Moments feed nickname moves down independently without moving its avatar", () => {
  const feedSource = readFileSync("mobile/XiaoC/src/app/moments.tsx", "utf8")
  const nameStyle = feedSource.match(/profileName: \{([\s\S]*?)\n  \},/)
  const avatarStyle = feedSource.match(/profileAvatarWrap: \{([\s\S]*?)\n  \},/)

  assert.ok(nameStyle)
  assert.ok(avatarStyle)
  assert.match(nameStyle[1], /maxWidth: "62%"/)
  assert.match(nameStyle[1], /marginRight: 14/)
  assert.match(nameStyle[1], /marginBottom: 34/)
  assert.match(avatarStyle[1], /width: 68/)
  assert.match(avatarStyle[1], /height: 68/)
})
