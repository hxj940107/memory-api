import AsyncStorage from "@react-native-async-storage/async-storage";

const FAVORITES_KEY = "xiaoc_favorites";

export type FavoriteItem = {
  id: string;
  text: string;
  role: "user" | "assistant";
  createdAt: string;
  conversationId?: string | null;
};

export async function getFavorites() {
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

export async function saveFavorite(
  favorite: Omit<FavoriteItem, "id" | "createdAt">,
) {
  const current = await getFavorites();
  const normalizedText = favorite.text.replace(/\s+/g, " ").trim();
  const alreadySaved = current.some(
    (item) =>
      item.role === favorite.role &&
      item.text.replace(/\s+/g, " ").trim() === normalizedText,
  );

  if (alreadySaved) {
    return current[0];
  }

  const nextFavorite: FavoriteItem = {
    ...favorite,
    id: `favorite_${Date.now()}`,
    createdAt: new Date().toISOString(),
  };

  await AsyncStorage.setItem(
    FAVORITES_KEY,
    JSON.stringify([nextFavorite, ...current]),
  );

  return nextFavorite;
}

export async function deleteFavorite(id: string) {
  const current = await getFavorites();

  await AsyncStorage.setItem(
    FAVORITES_KEY,
    JSON.stringify(current.filter((item) => item.id !== id)),
  );
}
