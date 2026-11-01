import test from 'node:test'
import assert from 'node:assert/strict'
import { selectMomentAlbumAssets } from '../lib/momentAlbumSelection.js'
const recent = Array.from({ length: 33 }, (_, i) => ({ id: i + 30, description: '长滩岛旅行照片' }))
const photos = [...recent, { id: 23, description: '跑代码中' }, { id: 22, description: '小区夜路散步' }]
test('old scene matches reach the bounded pool ahead of newer unrelated photos', () => {
  const result = selectMomentAlbumAssets(photos, { context: '晚上散完步回来，继续 debug', limit: 8 })
  assert.deepEqual(new Set(result.slice(0, 2).map(x => x.id)), new Set([23, 22]))
  assert.equal(result.length, 8)
})
test('specific meal description outranks unrelated category and travel matches', () => {
  const result = selectMomentAlbumAssets([...photos, { id: 58, description: '牛排烤土豆' }], { context: '晚饭牛排和土豆', limit: 1 })
  assert.equal(result[0].id, 58)
})
test('recent-use exclusions apply before ranking and empty context preserves input order', () => {
  assert.ok(!selectMomentAlbumAssets(photos, {context:'跑代码',excludeIds:[23]}).some(x=>x.id===23))
  assert.deepEqual(selectMomentAlbumAssets(photos, {limit:6}), photos.slice(0,6))
  assert.deepEqual(selectMomentAlbumAssets([], {context:'散步'}), [])
})
