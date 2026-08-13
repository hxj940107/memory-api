import AsyncStorage from "@react-native-async-storage/async-storage";

export type MomentInteraction = {
  id: string;
  type: "xiaoc_like" | "xiaoc_comment" | "xiaoc_reply";
  momentId: string;
  text: string;
  createdAt: string;
};

export const MOMENT_INTERACTIONS_SNAPSHOT_KEY =
  "xiaoc_moment_interactions_snapshot_v1";

export async function saveMomentInteractionSnapshot(
  interactions: MomentInteraction[],
) {
  await AsyncStorage.setItem(
    MOMENT_INTERACTIONS_SNAPSHOT_KEY,
    JSON.stringify(interactions),
  );
}

export async function loadMomentInteractionSnapshot() {
  const raw = await AsyncStorage.getItem(MOMENT_INTERACTIONS_SNAPSHOT_KEY);
  const data = raw ? JSON.parse(raw) : [];

  return Array.isArray(data) ? (data as MomentInteraction[]) : [];
}
