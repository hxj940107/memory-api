// Metadata-only retrieval. Matching ranks candidates, never authorizes a scene
// or changes the model's existing image/factual validation.
export const MOMENT_ALBUM_SCAN_LIMIT = 200
const SCENES = [
  /散.{0,2}步|走路|夜路|街景|街道|小路|路灯|小区/,
  /代码|编程|debug|电脑|书桌|工作台|调试/i,
  /咖啡|拿铁|美式/,
  /猫|橘猫/, /狗|博美|榴莲/,
  /海边|沙滩|海滩|海景/, /花|桂花|花枝/,
]
function normalize(value) { return String(value || '').normalize('NFKC').toLowerCase() }
function grams(value) {
  const result = new Set()
  for (const word of normalize(value).match(/[\p{L}\p{N}]+/gu) || []) {
    if (word.length < 2) continue
    for (let i = 0; i < word.length - 1; i++) result.add(word.slice(i, i + 2))
  }
  return result
}
export function selectMomentAlbumAssets(assets = [], { context = '', limit = 8, excludeIds = [] } = {}) {
  const source = normalize(context)
  const sourceGrams = grams(source)
  const excluded = new Set(excludeIds.map(Number))
  return assets.filter(asset => !excluded.has(Number(asset.id))).map((asset, index) => {
    const description = normalize(asset.description)
    const tags = normalize([asset.category, ...(asset.categories || [])].filter(Boolean).join(' '))
    let score = 0
    for (const gram of grams(description)) if (sourceGrams.has(gram)) score += 3
    for (const gram of grams(tags)) if (sourceGrams.has(gram)) score += 1
    for (const scene of SCENES) if (scene.test(source) && scene.test(description)) score += 4
    // Input retains existing least-used/newest order as the stable tie breaker.
    return { asset, score, index }
  }).sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map(item => item.asset)
}
