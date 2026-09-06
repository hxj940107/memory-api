type FavoritesResponse<T> = {
  favorites?: T[];
};

type FavoritesMigrationOptions<T> = {
  localFavorites: T[];
  migrationComplete: boolean;
  identityOf: (favorite: T) => string;
  fetchCloud: () => Promise<FavoritesResponse<T>>;
  mergeCloud: (favorites: T[]) => Promise<FavoritesResponse<T>>;
  saveLocal: (favorites: T[]) => Promise<void>;
  markMigrationComplete: () => Promise<void>;
};

function containsEveryLocalFavorite<T>(
  localFavorites: T[],
  cloudFavorites: T[],
  identityOf: (favorite: T) => string,
) {
  const cloudIdentities = new Set(cloudFavorites.map(identityOf));
  return localFavorites.every((favorite) => cloudIdentities.has(identityOf(favorite)));
}

export function mergeFavoriteCollections<T>(
  collections: T[][],
  identityOf: (favorite: T) => string,
) {
  const seen = new Set<string>();
  return collections.flat().filter((favorite) => {
    const identity = identityOf(favorite);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export async function syncFavoritesForPage<T>({
  localFavorites,
  migrationComplete,
  identityOf,
  fetchCloud,
  mergeCloud,
  saveLocal,
  markMigrationComplete,
}: FavoritesMigrationOptions<T>) {
  if (migrationComplete) {
    const response = await fetchCloud();
    if (!Array.isArray(response.favorites)) {
      throw new Error("Invalid cloud favorites response");
    }
    const cloudFavorites = mergeFavoriteCollections([response.favorites], identityOf);
    await saveLocal(cloudFavorites);
    return cloudFavorites;
  }

  const response = await mergeCloud(localFavorites);
  if (!Array.isArray(response.favorites)) {
    return localFavorites;
  }
  const mergedFavorites = mergeFavoriteCollections([response.favorites], identityOf);
  if (!containsEveryLocalFavorite(localFavorites, mergedFavorites, identityOf)) {
    return localFavorites;
  }

  await saveLocal(mergedFavorites);
  await markMigrationComplete();
  return mergedFavorites;
}
