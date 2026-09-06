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
  const cloudResponse = await fetchCloud();
  const cloudFavorites = Array.isArray(cloudResponse.favorites)
    ? mergeFavoriteCollections([cloudResponse.favorites], identityOf)
    : null;
  const cloudContainsLocal = cloudFavorites !== null
    && containsEveryLocalFavorite(localFavorites, cloudFavorites, identityOf);

  if (migrationComplete && cloudFavorites && cloudContainsLocal) {
    await saveLocal(cloudFavorites);
    return cloudFavorites;
  }

  const completeLocalCandidate = mergeFavoriteCollections(
    [localFavorites, cloudFavorites || []],
    identityOf,
  );
  const response = await mergeCloud(completeLocalCandidate);
  if (!Array.isArray(response.favorites)) {
    return localFavorites;
  }
  const mergedFavorites = mergeFavoriteCollections([response.favorites], identityOf);
  if (!containsEveryLocalFavorite(completeLocalCandidate, mergedFavorites, identityOf)) {
    return localFavorites;
  }

  await saveLocal(mergedFavorites);
  await markMigrationComplete();
  return mergedFavorites;
}
