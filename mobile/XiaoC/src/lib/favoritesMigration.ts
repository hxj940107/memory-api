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
  debug?: (field: string, value: string | number | boolean) => void;
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
  debug,
}: FavoritesMigrationOptions<T>) {
  debug?.("migration_entered", true);
  debug?.("merge_request_sent", false);
  debug?.("submitted_count", 0);
  debug?.("response_favorites_count", 0);
  debug?.("migration_verified", false);
  debug?.("local_saved", false);
  debug?.("migration_flag_written", false);
  const cloudResponse = await fetchCloud();
  const cloudFavorites = Array.isArray(cloudResponse.favorites)
    ? mergeFavoriteCollections([cloudResponse.favorites], identityOf)
    : null;
  const cloudContainsLocal = cloudFavorites !== null
    && containsEveryLocalFavorite(localFavorites, cloudFavorites, identityOf);

  if (migrationComplete && cloudFavorites && cloudContainsLocal) {
    await saveLocal(cloudFavorites);
    debug?.("local_saved", true);
    debug?.("migration_verified", true);
    return cloudFavorites;
  }

  const completeLocalCandidate = mergeFavoriteCollections(
    [localFavorites, cloudFavorites || []],
    identityOf,
  );
  debug?.("merge_request_sent", true);
  debug?.("submitted_count", completeLocalCandidate.length);
  const response = await mergeCloud(completeLocalCandidate);
  debug?.(
    "response_favorites_count",
    Array.isArray(response.favorites) ? response.favorites.length : 0,
  );
  if (!Array.isArray(response.favorites)) {
    debug?.("migration_verified", false);
    return localFavorites;
  }
  const mergedFavorites = mergeFavoriteCollections([response.favorites], identityOf);
  if (!containsEveryLocalFavorite(completeLocalCandidate, mergedFavorites, identityOf)) {
    debug?.("migration_verified", false);
    return localFavorites;
  }

  debug?.("migration_verified", true);
  await saveLocal(mergedFavorites);
  debug?.("local_saved", true);
  await markMigrationComplete();
  debug?.("migration_flag_written", true);
  return mergedFavorites;
}
