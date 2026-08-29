import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("chat images can be manually handed to the existing shared album editor", () => {
  const chat = fs.readFileSync("mobile/XiaoC/src/app/chat.tsx", "utf8");
  const album = fs.readFileSync("mobile/XiaoC/src/app/album.tsx", "utf8");
  const handoff = fs.readFileSync(
    "mobile/XiaoC/src/lib/sharedAlbumImportDraft.ts",
    "utf8",
  );

  assert.match(chat, /onLongPress=.*openImageMenu/s);
  assert.match(chat, /保存至共享相册/);
  assert.match(chat, /stageSharedAlbumImport/);
  assert.match(album, /consumeSharedAlbumImport/);
  assert.match(album, /setEditorVisible\(true\)/);
  assert.match(handoff, /pendingDraft = null/);
});
