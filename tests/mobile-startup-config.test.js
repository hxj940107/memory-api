import assert from "node:assert/strict"
import fs from "node:fs"
import test from "node:test"

const appConfig = JSON.parse(
  fs.readFileSync("mobile/XiaoC/app.json", "utf8"),
)
const packageJson = JSON.parse(
  fs.readFileSync("mobile/XiaoC/package.json", "utf8"),
)
const rootLayout = fs.readFileSync(
  "mobile/XiaoC/src/app/_layout.tsx",
  "utf8",
)

test("standalone startup keeps a single SDK 54 audio implementation", () => {
  const pluginNames = appConfig.expo.plugins.map((plugin) =>
    Array.isArray(plugin) ? plugin[0] : plugin,
  )

  assert.ok(pluginNames.includes("expo-av"))
  assert.ok(!pluginNames.includes("expo-audio"))
  assert.equal(packageJson.dependencies["expo-av"], "~16.0.8")
  assert.equal(packageJson.dependencies["expo-audio"], undefined)
})

test("root navigator releases the native splash without waiting on startup IO", () => {
  assert.match(rootLayout, /SplashScreen\.preventAutoHideAsync\(\)/)
  assert.match(
    rootLayout,
    /useEffect\(\(\) => \{\s*SplashScreen\.hideAsync\(\)/,
  )
})
