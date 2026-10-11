type LatestHistoryItem = { id?: string; created_at?: string };
type HistoryAction = "latest" | "list";

// Old deployments have no latest action. Remember that response briefly without
// adding a timer; retry the lightweight endpoint after a backend release.
export function createLatestHistoryReader(now = Date.now) {
  let unsupportedUntil = 0;
  return async (fetchAction: (action: HistoryAction) => Promise<LatestHistoryItem[]>) => {
    if (now() >= unsupportedUntil) {
      try {
        return await fetchAction("latest");
      } catch (error) {
        const failure = error as { status?: number; message?: string };
        if (failure?.status !== 400 || failure?.message !== "unsupported history action") throw error;
        unsupportedUntil = now() + 60_000;
      }
    }
    const rows = await fetchAction("list");
    return rows.map(({ id, created_at }) => ({ id, created_at }));
  };
}
