import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  mergeFavoriteCollections,
  syncFavoritesForPage,
} from "../mobile/XiaoC/src/lib/favoritesMigration.ts"

const api = readFileSync("api/user-state.js", "utf8")
const state = readFileSync("mobile/XiaoC/src/lib/favoritesState.ts", "utf8")

const favorite = (id, text = id) => ({
  id,
  text,
  role: "assistant",
  createdAt: "2026-09-05T12:00:00.000Z",
})
const identityOf = item => `${item.role}:${item.text.replace(/\s+/g, " ").trim()}`

function harness({ local = [], migrated = false, fetchResponse, mergeResponse }) {
  const calls = { fetched: 0, merged: [], saved: [], marked: 0 }
  return {
    calls,
    run: () => syncFavoritesForPage({
      localFavorites: local,
      migrationComplete: migrated,
      identityOf,
      fetchCloud: async () => {
        calls.fetched += 1
        if (fetchResponse instanceof Error) throw fetchResponse
        return fetchResponse ?? { favorites: [] }
      },
      mergeCloud: async items => {
        calls.merged.push(items)
        if (mergeResponse instanceof Error) throw mergeResponse
        return mergeResponse ?? { favorites: items }
      },
      saveLocal: async items => {
        calls.saved.push(items)
      },
      markMigrationComplete: async () => {
        calls.marked += 1
      },
    }),
  }
}

test("favorites reuse user-state without adding a serverless function", () => {
  assert.match(api, /action === "favorites"/)
  assert.match(api, /action === "merge-favorites"/)
  assert.match(api, /action === "delete-favorite"/)
  assert.match(api, /patchClientPreferences\(userId, \{[\s\S]*favorites:/)
})

test("v1 completion is ignored and v2 gets a full local migration opportunity", async () => {
  const local = [favorite("old-1"), favorite("old-2")]
  assert.match(state, /xiaoc_favorites_cloud_migration_v2/)
  assert.doesNotMatch(state, /xiaoc_favorites_cloud_migration_v1/)

  const { run, calls } = harness({ local })
  await run()
  assert.deepEqual(calls.merged, [local])
  assert.equal(calls.fetched, 0)
  assert.equal(calls.marked, 1)
})

test("saving one favorite never marks the full-history v2 migration complete", () => {
  const saveStart = state.indexOf("export async function saveFavorite")
  const deleteStart = state.indexOf("export async function deleteFavorite")
  const saveSource = state.slice(saveStart, deleteStart)

  assert.match(saveSource, /favorites: \[nextFavorite\]/)
  assert.doesNotMatch(saveSource, /setItem\(FAVORITES_CLOUD_MIGRATION_KEY/)
  assert.match(saveSource, /removeItem\(FAVORITES_CLOUD_MIGRATION_KEY\)/)
  assert.match(saveSource, /migrationComplete[\s\S]*mergeFavoriteCollections/)

  const oldLocal = favorite("old-local")
  const newFavorite = favorite("new-favorite")
  assert.deepEqual(
    mergeFavoriteCollections(
      [[newFavorite], [newFavorite, oldLocal]],
      identityOf,
    ),
    [newFavorite, oldLocal],
  )
})

test("missing cloud favorites cannot clear nonempty local data before migration", async () => {
  const local = [favorite("old-1")]
  const { run, calls } = harness({ local, mergeResponse: {} })
  assert.deepEqual(await run(), local)
  assert.deepEqual(calls.saved, [])
  assert.equal(calls.marked, 0)
})

test("an empty cloud merge cannot clear nonempty local data before migration", async () => {
  const local = [favorite("old-1")]
  const { run, calls } = harness({ local, mergeResponse: { favorites: [] } })
  assert.deepEqual(await run(), local)
  assert.deepEqual(calls.saved, [])
  assert.equal(calls.marked, 0)
})

test("v2 is marked only after the complete merged result is cached", async () => {
  const local = [favorite("old-1"), favorite("old-2")]
  const cloudOnly = favorite("cloud-1")
  const { run, calls } = harness({
    local,
    mergeResponse: { favorites: [cloudOnly, ...local] },
  })
  assert.deepEqual(await run(), [cloudOnly, ...local])
  assert.deepEqual(calls.saved, [[cloudOnly, ...local]])
  assert.equal(calls.marked, 1)

  const incomplete = harness({
    local,
    mergeResponse: { favorites: [local[0]] },
  })
  assert.deepEqual(await incomplete.run(), local)
  assert.equal(incomplete.calls.marked, 0)
})

test("local and cloud duplicates are deduped by stable favorite identity", async () => {
  const localCopy = favorite("local-id", "  同一句   收藏 ")
  const cloudCopy = favorite("cloud-id", "同一句 收藏")
  const unique = favorite("cloud-unique")
  const { run, calls } = harness({
    local: [localCopy],
    mergeResponse: { favorites: [cloudCopy, localCopy, unique] },
  })
  const result = await run()
  assert.deepEqual(result, [cloudCopy, unique])
  assert.deepEqual(calls.saved, [[cloudCopy, unique]])
  assert.equal(calls.marked, 1)
})

test("a completed sandbox restores all cloud favorites with GET", async () => {
  const cloud = [favorite("cloud-1"), favorite("cloud-2")]
  const { run, calls } = harness({
    local: [],
    migrated: true,
    fetchResponse: { favorites: cloud },
  })
  assert.deepEqual(await run(), cloud)
  assert.equal(calls.fetched, 1)
  assert.deepEqual(calls.merged, [])
  assert.deepEqual(calls.saved, [cloud])
  assert.equal(calls.marked, 0)
})

test("network failure preserves local data and never marks v2 complete", async () => {
  const local = [favorite("old-1")]
  const { run, calls } = harness({ local, mergeResponse: new Error("offline") })
  await assert.rejects(run, /offline/)
  assert.deepEqual(calls.saved, [])
  assert.equal(calls.marked, 0)
  assert.match(state, /Favorite cloud sync failed; using local cache/)
})

test("delete remains cloud-confirmed before changing the local cache", () => {
  const deleteStart = state.indexOf("export async function deleteFavorite")
  const deleteSource = state.slice(deleteStart)
  assert.ok(deleteSource.indexOf('action: "delete-favorite"') >= 0)
  assert.ok(deleteSource.indexOf("await cacheFavorites(favorites)") > deleteSource.indexOf('action: "delete-favorite"'))
  assert.doesNotMatch(deleteSource, /removeItem\(FAVORITES_KEY\)|AsyncStorage\.clear/)
})
