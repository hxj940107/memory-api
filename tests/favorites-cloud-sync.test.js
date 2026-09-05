import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const api = readFileSync("api/user-state.js", "utf8")
const state = readFileSync(
  "mobile/XiaoC/src/lib/favoritesState.ts",
  "utf8",
)

test("favorites reuse user-state without adding a serverless function", () => {
  assert.match(api, /action === "favorites"/)
  assert.match(api, /action === "merge-favorites"/)
  assert.match(api, /action === "delete-favorite"/)
  assert.match(api, /client_preferences: nextPreferences/)
})

test("each app sandbox merges its legacy local favorites once", () => {
  assert.match(state, /xiaoc_favorites_cloud_migration_v1/)
  assert.match(state, /favorites: local/)
  assert.match(state, /action: "merge-favorites"/)
  assert.match(state, /Favorite cloud sync failed; using local cache/)
})

test("offline saves remain cached for the next cloud merge", () => {
  assert.match(state, /await cacheFavorites\(localNext\)/)
  assert.match(state, /removeItem\(FAVORITES_CLOUD_MIGRATION_KEY\)/)
})
