import * as ImageManipulator from "expo-image-manipulator";

import { APP_USER_ID, apiJson, postJson } from "../config/api";
import {
  getAccountSettings,
  saveAccountDisplayName,
  saveUserMomentAvatar,
  saveUserMomentAvatarUri,
  saveXiaoCMomentAvatar,
  saveXiaoCMomentAvatarUri,
} from "./accountSettings";
import {
  getMomentProfileBio,
  getMomentProfileCoverUri,
  saveMomentProfileBio,
  saveMomentProfileCoverUri,
} from "./momentProfile";
import { getSelectedChatModel, saveSelectedChatModel } from "./modelSettings";

export type ClientPreferences = {
  display_name?: string | null;
  selected_chat_model?: string | null;
  user_moment_avatar?: string | null;
  xiaoc_moment_avatar?: string | null;
  user_moment_avatar_path?: string | null;
  xiaoc_moment_avatar_path?: string | null;
  user_moment_avatar_uri?: string | null;
  xiaoc_moment_avatar_uri?: string | null;
  user_moment_cover_path?: string | null;
  xiaoc_moment_cover_path?: string | null;
  user_moment_cover_uri?: string | null;
  xiaoc_moment_cover_uri?: string | null;
  user_moment_bio?: string | null;
  xiaoc_moment_bio?: string | null;
  migration_complete?: string | null;
};

type PreferencesResponse = {
  preferences: ClientPreferences;
  has_preferences?: boolean;
  schema_ready?: boolean;
};

type PreferenceImageKind =
  | "user_moment_avatar"
  | "xiaoc_moment_avatar"
  | "user_moment_cover"
  | "xiaoc_moment_cover";

export async function updateClientPreferences(preferences: ClientPreferences) {
  return postJson<PreferencesResponse>("/api/user-state", {
    action: "set-client-preferences",
    user_id: APP_USER_ID,
    preferences,
  });
}

export async function uploadClientPreferenceImage(
  kind: PreferenceImageKind,
  uri: string,
) {
  const isAvatar = kind.endsWith("_avatar");
  const manipulated = await ImageManipulator.manipulateAsync(
    uri,
    [{ resize: { width: isAvatar ? 512 : 1400 } }],
    {
      compress: isAvatar ? 0.82 : 0.86,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    },
  );
  if (!manipulated.base64) throw new Error("图片处理失败，请重新选择后再试。");
  return postJson<{ path: string; uri: string | null }>("/api/user-state", {
    action: "upload-client-preference-image",
    user_id: APP_USER_ID,
    kind,
    image_base64: manipulated.base64,
    image_mime_type: "image/jpeg",
  }, { timeoutMs: 40000 });
}

async function applyCloudPreferences(preferences: ClientPreferences) {
  const account = await getAccountSettings();
  if (preferences.user_moment_avatar) {
    await saveUserMomentAvatar(
      preferences.user_moment_avatar as typeof account.userMomentAvatar,
    );
  }
  if (preferences.xiaoc_moment_avatar) {
    await saveXiaoCMomentAvatar(
      preferences.xiaoc_moment_avatar as typeof account.xiaocMomentAvatar,
    );
  }
  await Promise.all([
    preferences.display_name
      ? saveAccountDisplayName(preferences.display_name)
      : Promise.resolve(),
    preferences.selected_chat_model
      ? saveSelectedChatModel(preferences.selected_chat_model)
      : Promise.resolve(),
    preferences.user_moment_avatar_uri
      ? saveUserMomentAvatarUri(preferences.user_moment_avatar_uri)
      : Promise.resolve(),
    preferences.xiaoc_moment_avatar_uri
      ? saveXiaoCMomentAvatarUri(preferences.xiaoc_moment_avatar_uri)
      : Promise.resolve(),
    preferences.user_moment_cover_uri
      ? saveMomentProfileCoverUri("user", preferences.user_moment_cover_uri)
      : Promise.resolve(),
    preferences.xiaoc_moment_cover_uri
      ? saveMomentProfileCoverUri("xiaoc", preferences.xiaoc_moment_cover_uri)
      : Promise.resolve(),
    preferences.user_moment_bio
      ? saveMomentProfileBio("user", preferences.user_moment_bio)
      : Promise.resolve(),
    preferences.xiaoc_moment_bio
      ? saveMomentProfileBio("xiaoc", preferences.xiaoc_moment_bio)
      : Promise.resolve(),
  ]);
}

async function seedCloudPreferencesFromLocal() {
  const [account, model, userCover, xiaocCover, userBio, xiaocBio] = await Promise.all([
    getAccountSettings(),
    getSelectedChatModel(),
    getMomentProfileCoverUri("user"),
    getMomentProfileCoverUri("xiaoc"),
    getMomentProfileBio("user"),
    getMomentProfileBio("xiaoc"),
  ]);
  const localImages: Array<[PreferenceImageKind, string | null]> = [
    ["user_moment_avatar", account.userMomentAvatarUri],
    ["xiaoc_moment_avatar", account.xiaocMomentAvatarUri],
    ["user_moment_cover", userCover],
    ["xiaoc_moment_cover", xiaocCover],
  ];
  for (const [kind, uri] of localImages) {
    if (!uri || /^https?:\/\//.test(uri)) continue;
    const uploaded = await uploadClientPreferenceImage(kind, uri);
    if (!uploaded.uri) continue;
    if (kind === "user_moment_avatar") await saveUserMomentAvatarUri(uploaded.uri);
    if (kind === "xiaoc_moment_avatar") await saveXiaoCMomentAvatarUri(uploaded.uri);
    if (kind === "user_moment_cover") await saveMomentProfileCoverUri("user", uploaded.uri);
    if (kind === "xiaoc_moment_cover") await saveMomentProfileCoverUri("xiaoc", uploaded.uri);
  }
  await updateClientPreferences({
    display_name: account.displayName,
    selected_chat_model: model.id,
    user_moment_avatar: account.userMomentAvatar,
    xiaoc_moment_avatar: account.xiaocMomentAvatar,
    user_moment_bio: userBio,
    xiaoc_moment_bio: xiaocBio,
    migration_complete: "1",
  });
}

let syncInFlight: Promise<{ synced: boolean; schemaReady: boolean }> | null = null;

async function runClientPreferencesSync() {
  const response = await apiJson<PreferencesResponse>("/api/user-state", {
    query: { user_id: APP_USER_ID, action: "client-preferences" },
    timeoutMs: 12000,
  });
  if (response.schema_ready === false) return { synced: false, schemaReady: false };
  if (response.has_preferences && response.preferences?.migration_complete === "1") {
    await applyCloudPreferences(response.preferences || {});
    return { synced: true, schemaReady: true };
  }
  await seedCloudPreferencesFromLocal();
  return { synced: true, schemaReady: true };
}

export function syncClientPreferences() {
  if (!syncInFlight) {
    syncInFlight = runClientPreferencesSync().finally(() => {
      syncInFlight = null;
    });
  }
  return syncInFlight;
}
