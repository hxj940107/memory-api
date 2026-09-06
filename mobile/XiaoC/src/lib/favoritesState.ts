import AsyncStorage from "@react-native-async-storage/async-storage";

import { API_BASE_URL, APP_USER_ID, apiJson, postJson } from "../config/api";
import {
  mergeFavoriteCollections,
  syncFavoritesForPage,
} from "./favoritesMigration";

const FAVORITES_KEY = "xiaoc_favorites";
const FAVORITES_CLOUD_MIGRATION_KEY = "xiaoc_favorites_cloud_migration_v2";
const FAVORITES_DEBUG_MARKER = "favorites-debug-20260906";

function favoritesDebug(field: string, value: string | number | boolean) {
  if (!__DEV__) return;
  console.log(`[FavoritesDebug] ${field}=${value}`);
}

function safeApiBase() {
  try {
    const url = new URL("/api/user-state", API_BASE_URL);
    return `${url.host}${url.pathname}`;
  } catch {
    return "invalid-api-base/api/user-state";
  }
}

export function logFavoritesPageMounted() {
  favoritesDebug("bundle_marker", FAVORITES_DEBUG_MARKER);
  favoritesDebug("page_mounted", true);
}

export type FavoriteItem = {
  id: string;
  text: string;
  role: "user" | "assistant";
  createdAt: string;
  conversationId?: string | null;
};

type FavoritesResponse = {
  favorites?: FavoriteItem[];
};

async function getLocalFavorites() {
  const raw = await AsyncStorage.getItem(FAVORITES_KEY);

  if (!raw) {
    return [];
  }

  try {
    const items = JSON.parse(raw);

    if (!Array.isArray(items)) {
      return [];
    }

    return items as FavoriteItem[];
  } catch {
    return [];
  }
}

async function cacheFavorites(items: FavoriteItem[]) {
  await AsyncStorage.setItem(FAVORITES_KEY, JSON.stringify(items));
}

function favoriteIdentity(item: FavoriteItem) {
  return `${item.role}:${item.text.replace(/\s+/g, " ").trim()}`;
}

export async function getFavorites() {
  const local = await getLocalFavorites();
  favoritesDebug("local_count", local.length);
  favoritesDebug("api_base", safeApiBase());

  try {
    const migrated = await AsyncStorage.getItem(FAVORITES_CLOUD_MIGRATION_KEY);
    favoritesDebug("migration_v2_flag", migrated === "1" ? "1" : "missing");
    return await syncFavoritesForPage({
      localFavorites: local,
      migrationComplete: migrated === "1",
      identityOf: favoriteIdentity,
      fetchCloud: () => apiJson<FavoritesResponse>("/api/user-state", {
        query: { user_id: APP_USER_ID, action: "favorites" },
        timeoutMs: 12000,
        onResponseStatus: (status) => favoritesDebug("http_status", status),
      }),
      mergeCloud: (favorites) => postJson<FavoritesResponse>("/api/user-state", {
        action: "merge-favorites",
        user_id: APP_USER_ID,
        favorites,
      }, {
        onResponseStatus: (status) => favoritesDebug("http_status", status),
      }),
      saveLocal: cacheFavorites,
      markMigrationComplete: () =>
        AsyncStorage.setItem(FAVORITES_CLOUD_MIGRATION_KEY, "1"),
      debug: favoritesDebug,
    });
  } catch (error) {
    console.log("Favorite cloud sync failed; using local cache:", error);
    return local;
  }
}

export async function saveFavorite(
  favorite: Omit<FavoriteItem, "id" | "createdAt">,
) {
  const current = await getLocalFavorites();
  const normalizedText = favorite.text.replace(/\s+/g, " ").trim();
  const alreadySaved = current.find(
    (item) =>
      item.role === favorite.role &&
      item.text.replace(/\s+/g, " ").trim() === normalizedText,
  );

  if (alreadySaved) {
    return alreadySaved;
  }

  const nextFavorite: FavoriteItem = {
    ...favorite,
    id: `favorite_${Date.now()}`,
    createdAt: new Date().toISOString(),
  };

  const localNext = [nextFavorite, ...current];
  await cacheFavorites(localNext);

  try {
    const migrationComplete =
      await AsyncStorage.getItem(FAVORITES_CLOUD_MIGRATION_KEY) === "1";
    const response = await postJson<FavoritesResponse>("/api/user-state", {
      action: "merge-favorites",
      user_id: APP_USER_ID,
      favorites: [nextFavorite],
    });
    const favorites = Array.isArray(response.favorites)
      ? migrationComplete
        ? response.favorites
        : mergeFavoriteCollections(
            [response.favorites, localNext],
            favoriteIdentity,
          )
      : localNext;
    await cacheFavorites(favorites);
  } catch (error) {
    await AsyncStorage.removeItem(FAVORITES_CLOUD_MIGRATION_KEY);
    console.log("Favorite saved locally and queued for cloud merge:", error);
  }

  return nextFavorite;
}

export async function deleteFavorite(id: string) {
  const response = await postJson<FavoritesResponse>("/api/user-state", {
    action: "delete-favorite",
    user_id: APP_USER_ID,
    favorite_id: id,
  });
  const favorites = Array.isArray(response.favorites)
    ? response.favorites
    : (await getLocalFavorites()).filter((item) => item.id !== id);
  await cacheFavorites(favorites);
}
