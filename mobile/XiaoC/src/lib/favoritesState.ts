import AsyncStorage from "@react-native-async-storage/async-storage";

import { APP_USER_ID, apiJson, postJson } from "../config/api";

const FAVORITES_KEY = "xiaoc_favorites";
const FAVORITES_CLOUD_MIGRATION_KEY = "xiaoc_favorites_cloud_migration_v1";

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

export async function getFavorites() {
  const local = await getLocalFavorites();

  try {
    const migrated = await AsyncStorage.getItem(FAVORITES_CLOUD_MIGRATION_KEY);
    const response = migrated === "1"
      ? await apiJson<FavoritesResponse>("/api/user-state", {
          query: { user_id: APP_USER_ID, action: "favorites" },
          timeoutMs: 12000,
        })
      : await postJson<FavoritesResponse>("/api/user-state", {
          action: "merge-favorites",
          user_id: APP_USER_ID,
          favorites: local,
        });
    const favorites = Array.isArray(response.favorites) ? response.favorites : [];
    await Promise.all([
      cacheFavorites(favorites),
      AsyncStorage.setItem(FAVORITES_CLOUD_MIGRATION_KEY, "1"),
    ]);
    return favorites;
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
    const response = await postJson<FavoritesResponse>("/api/user-state", {
      action: "merge-favorites",
      user_id: APP_USER_ID,
      favorites: [nextFavorite],
    });
    const favorites = Array.isArray(response.favorites) ? response.favorites : localNext;
    await Promise.all([
      cacheFavorites(favorites),
      AsyncStorage.setItem(FAVORITES_CLOUD_MIGRATION_KEY, "1"),
    ]);
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
