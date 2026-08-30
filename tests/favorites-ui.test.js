import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync("mobile/XiaoC/src/app/favorites.tsx", "utf8")

test("favorites list keeps short text natural and truncates long text to two lines", () => {
  assert.match(
    source,
    /<Text style=\{styles\.text\} numberOfLines=\{2\} ellipsizeMode="tail">/,
  )
})

test("the whole favorite card opens a lightweight full-text detail", () => {
  assert.match(source, /setSelectedFavorite\(favorite\)/)
  assert.match(source, /presentationStyle="pageSheet"/)
  assert.match(source, /selectedFavorite\?\.role === "assistant"/)
  assert.match(source, /<MessageMarkdown text=\{selectedFavorite\.text\} variant="detail" \/>/)
  assert.match(source, /<Text style=\{styles\.detailText\}>\{selectedFavorite\?\.text \|\| ""\}<\/Text>/)
  assert.match(source, /onPress=\{\(\) => setSelectedFavorite\(null\)\}/)
})

test("favorites remain virtualized and long-press removal remains available", () => {
  assert.match(source, /<FlatList/)
  assert.match(source, /data=\{favorites\}/)
  assert.match(source, /keyExtractor=\{\(favorite\) => favorite\.id\}/)
  assert.match(source, /onLongPress=\{\(\) => \{[\s\S]*confirmDeleteFavorite\(favorite\)/)
  assert.match(source, /longPressHandledRef\.current = true/)
  assert.match(source, /await deleteFavorite\(favorite\.id\)/)
})

test("favorites data stays text-only without adding image or model behavior", () => {
  const stateSource = readFileSync(
    "mobile/XiaoC/src/lib/favoritesState.ts",
    "utf8",
  )

  assert.doesNotMatch(stateSource, /imageUrl|imageUri|attachment/)
  assert.doesNotMatch(source, /apiJson|postJson|callLLM|model/i)
})
