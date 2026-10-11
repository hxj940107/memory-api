import test from "node:test"
import assert from "node:assert/strict"
import { resolveMomentImageIdentity } from "../lib/momentImageIdentity.js"
import { isMomentImageCompatible } from "../lib/momentImageLibrary.js"

const image = { id: "album-7", albumAssetId: 7, description: "一只宠物在睡觉", relations: ["Mochi"], timePeriods: [] }
const binding = { alias: "m10", sourceType: "album_asset", sourceRef: "album-7", albumAssetId: 7, user_id: "fixture-owner" }
function client(assetOwner = "fixture-owner", enabled = true) {
  return { from() {
    let rows = [{ id: 7, user_id: assetOwner, access_scope: "shared", enabled, archived_at: null }]
    const q = { select() { return q }, eq(k,v) { rows=rows.filter(r=>r[k]===v); return q },
      is(k,v) { return q.eq(k,v) }, order() { return q }, limit() { return q },
      then(resolve) { return Promise.resolve({ data: rows }).then(resolve) } }
    return q
  } }
}
const base = { images: [image], owner: "fixture-owner", client: client() }
test("unbound message aliases and fabricated IDs are rejected without guessing", async () => {
  for (const reference of ["m10", "album-999", "fictional-library-id"]) {
    assert.equal(await resolveMomentImageIdentity({ ...base, reference, materials: [{ alias: "m10", sourceType: "message" }] }), null)
  }
})
test("trusted authorized album binding resolves and still requires compatibility", async () => {
  const id = await resolveMomentImageIdentity({ ...base, reference: "m10", materials: [binding] })
  assert.equal(id, "album-7")
  assert.equal(isMomentImageCompatible(id, "A quiet moment", 12, [image], "Mochi is sleeping today"), true)
  assert.equal(isMomentImageCompatible(id, "A quiet moment", 12, [image], "A different topic"), false)
})
test("legal album and library IDs retain their own namespace", async () => {
  assert.equal(await resolveMomentImageIdentity({ ...base, reference: "album-7" }), "album-7")
  assert.equal(await resolveMomentImageIdentity({ ...base, reference: "fixture-library", images: [{ id: "fixture-library", file: "fixture.jpg" }] }), "fixture-library")
})
test("foreign owner binding, revoked permission and inconsistent binding fail closed", async () => {
  assert.equal(await resolveMomentImageIdentity({ ...base, reference: "m10", materials: [{ ...binding, user_id: "other" }] }), null)
  assert.equal(await resolveMomentImageIdentity({ ...base, reference: "m10", materials: [binding], client: client("other") }), null)
  assert.equal(await resolveMomentImageIdentity({ ...base, reference: "album-7", client: client("fixture-owner", false) }), null)
  assert.equal(await resolveMomentImageIdentity({ ...base, reference: "m10", materials: [{ ...binding, sourceRef: "album-8" }] }), null)
})
