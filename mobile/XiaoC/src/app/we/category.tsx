import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";

import { APP_USER_ID, apiJson } from "../../config/api";

type WeMemory = {
  id: string;
  content: string;
  category: string;
  pinned?: boolean;
  pinAvailable?: boolean;
  editAvailable?: boolean;
  revision: number;
};
type CategoryResponse = { category: string; total: number; items: WeMemory[] };

const normalizeParam = (value?: string | string[]) =>
  String(Array.isArray(value) ? value[0] : value || "").trim();

export default function WeMemoryCategoryScreen() {
  const params = useLocalSearchParams();
  const category = normalizeParam(params.category);
  const [items, setItems] = useState<WeMemory[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const loadMemories = useCallback(async () => {
    if (!category) return;
    setLoading(true);
    setFailed(false);
    try {
      const response = await apiJson<CategoryResponse>("/api/memory", {
        query: { type: "we", category, user_id: APP_USER_ID },
        timeoutMs: 16000,
      });
      setItems(Array.isArray(response?.items) ? response.items : []);
    } catch (error) {
      console.log("Memory category load failed:", error);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [category]);

  useFocusEffect(useCallback(() => { loadMemories(); }, [loadMemories]));

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <Text style={styles.title}>{category || "记忆"}</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadMemories} />}
      >
        {failed && items.length === 0 ? (
          <Pressable style={styles.state} onPress={loadMemories}>
            <Text style={styles.stateText}>暂时没有读到，轻点再试一次。</Text>
          </Pressable>
        ) : !loading && items.length === 0 ? (
          <View style={styles.state}><Text style={styles.stateText}>这里暂时没有记忆。</Text></View>
        ) : items.map(memory => (
          <Pressable
            key={memory.id}
            style={({ pressed }) => [styles.card, memory.pinned && styles.pinnedCard, pressed && styles.cardPressed]}
            onPress={() => router.push({
              pathname: "/we/[id]",
              params: {
                id: memory.id,
                content: memory.content,
                category: memory.category,
                pinned: memory.pinned ? "1" : "0",
                revision: String(memory.revision || 1),
                pinAvailable: memory.pinAvailable ? "1" : "0",
                editAvailable: memory.editAvailable ? "1" : "0",
              },
            })}
          >
            <Text style={styles.body} numberOfLines={2} ellipsizeMode="tail">
              {memory.pinned ? "📌 " : ""}{memory.content}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#FBF8F3" },
  header: { paddingTop: 58, paddingHorizontal: 24, paddingBottom: 14 },
  backButton: {
    width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)", marginBottom: 22,
  },
  backText: { fontSize: 32, lineHeight: 34, color: "#555" },
  title: { fontSize: 24, lineHeight: 31, color: "#3F3A37", fontWeight: "600" },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 46 },
  card: {
    borderRadius: 20, paddingHorizontal: 17, paddingVertical: 12, marginBottom: 10,
    backgroundColor: "rgba(255,255,255,0.66)", shadowColor: "#B8AFA7", shadowOpacity: 0.04,
    shadowRadius: 12, shadowOffset: { width: 0, height: 5 },
  },
  pinnedCard: { backgroundColor: "rgba(255,255,255,0.88)" },
  cardPressed: { backgroundColor: "rgba(242,242,247,0.92)" },
  body: { fontSize: 15, lineHeight: 22, color: "#4D4743" },
  state: { paddingVertical: 100, alignItems: "center" },
  stateText: { fontSize: 14, color: "#9A918C" },
});
