import { router, useFocusEffect } from "expo-router";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { useCallback, useState } from "react";

import { APP_USER_ID, apiJson } from "../config/api";

type WeMemory = {
  id: string;
  content: string;
  category: string;
  pinned?: boolean;
  pinAvailable?: boolean;
  editAvailable?: boolean;
  revision: number;
};

type WeCategory = { id: string; name: string; total: number; items: WeMemory[] };
type WeMemoryResponse = { source: string; total: number; pinnedTotal: number; categories: WeCategory[] };

const emptyData: WeMemoryResponse = { source: "empty", total: 0, pinnedTotal: 0, categories: [] };

function normalizeMemoryResponse(value: unknown): WeMemoryResponse {
  if (!value || typeof value !== "object") return emptyData;
  const response = value as Partial<WeMemoryResponse>;
  const categories = Array.isArray(response.categories)
    ? response.categories.map((category, index) => ({
        id: String(category?.id || `memory-category-${index}`),
        name: String(category?.name || "记忆"),
        total: Number.isFinite(Number(category?.total)) ? Number(category?.total) : 0,
        items: Array.isArray(category?.items) ? category.items : [],
      }))
    : [];

  return {
    source: String(response.source || "empty"),
    total: Number.isFinite(Number(response.total)) ? Number(response.total) : 0,
    pinnedTotal: Number.isFinite(Number(response.pinnedTotal)) ? Number(response.pinnedTotal) : 0,
    categories,
  };
}

function openMemory(memory: WeMemory) {
  router.push({
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
  });
}

function MemoryCard({ memory }: { memory: WeMemory }) {
  return (
    <Pressable
      style={({ pressed }) => [
        styles.memoryCard,
        memory.pinned && styles.pinnedCard,
        pressed && styles.memoryCardPressed,
      ]}
      onPress={() => openMemory(memory)}
    >
      <Text
        style={[styles.memoryContent, memory.pinned && styles.pinnedContent]}
        numberOfLines={2}
        ellipsizeMode="tail"
      >
        {memory.pinned ? "📌 " : ""}{memory.content}
      </Text>
    </Pressable>
  );
}

function MemorySection({ category }: { category: WeCategory }) {
  const items = Array.isArray(category?.items) ? category.items : [];
  const total = Number.isFinite(Number(category?.total)) ? Number(category.total) : items.length;

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{category.name}</Text>
        {total > items.length && (
          <Pressable
            hitSlop={10}
            onPress={() => router.push({ pathname: "/we/category", params: { category: category.name } })}
          >
            <Text style={styles.viewAllText}>查看全部  ›</Text>
          </Pressable>
        )}
      </View>

      {items.length > 0 ? items.map(memory => (
        <MemoryCard key={memory.id} memory={memory} />
      )) : (
        <Text style={styles.emptyCategoryText}>这里暂时没有记忆。</Text>
      )}
    </View>
  );
}

export default function WeScreen() {
  const [data, setData] = useState<WeMemoryResponse>(emptyData);
  const [loading, setLoading] = useState(false);

  const loadMemories = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiJson<WeMemoryResponse>("/api/memory", {
        query: { type: "we", user_id: APP_USER_ID },
        timeoutMs: 16000,
      });
      setData(normalizeMemoryResponse(response));
    } catch (error) {
      console.log("We memory load failed:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { loadMemories(); }, [loadMemories]));

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={<RefreshControl refreshing={loading} onRefresh={loadMemories} />}
      >
        <View style={styles.overviewCard}>
          <View style={styles.overviewItem}>
            <Text style={styles.overviewLabel}>记忆</Text>
            <Text style={styles.overviewValue}>{data.total}</Text>
          </View>
          <View style={styles.overviewDivider} />
          <View style={styles.overviewItem}>
            <Text style={styles.overviewLabel}>钉选</Text>
            <Text style={styles.overviewValue}>{data.pinnedTotal}</Text>
          </View>
        </View>

        {!loading && data.total === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>这里暂时没有记忆。</Text>
          </View>
        ) : data.categories.map(category => (
          <MemorySection key={category.id} category={category} />
        ))}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#FBF8F3" },
  header: { paddingTop: 58, paddingHorizontal: 24, paddingBottom: 8 },
  backButton: {
    width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
  },
  backText: { fontSize: 32, lineHeight: 34, color: "#555" },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 10, paddingBottom: 46 },
  overviewCard: {
    minHeight: 86, borderRadius: 24, paddingHorizontal: 20, paddingVertical: 16,
    backgroundColor: "rgba(255,255,255,0.82)", flexDirection: "row", alignItems: "center",
    shadowColor: "#B8AFA7", shadowOpacity: 0.08, shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
  },
  overviewItem: { flex: 1, alignItems: "center" },
  overviewLabel: { fontSize: 13, color: "#A69D98", marginBottom: 6 },
  overviewValue: { fontSize: 24, color: "#3F3A37", fontWeight: "500" },
  overviewDivider: { width: 1, height: 34, backgroundColor: "rgba(120,120,128,0.12)" },
  section: { marginTop: 24 },
  sectionHeader: {
    minHeight: 26, marginBottom: 10, flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  sectionTitle: { paddingHorizontal: 2, fontSize: 14, color: "#A69D98", fontWeight: "600" },
  viewAllText: { paddingHorizontal: 2, fontSize: 13, color: "#8A817C" },
  memoryCard: {
    borderRadius: 20, paddingHorizontal: 17, paddingVertical: 12, marginBottom: 10,
    backgroundColor: "rgba(255,255,255,0.62)", shadowColor: "#B8AFA7", shadowOpacity: 0.04,
    shadowRadius: 12, shadowOffset: { width: 0, height: 5 },
  },
  memoryCardPressed: { backgroundColor: "rgba(242,242,247,0.92)" },
  pinnedCard: { backgroundColor: "rgba(255,255,255,0.88)" },
  memoryContent: { fontSize: 15, lineHeight: 22, color: "#4D4743" },
  pinnedContent: { color: "#3F3A37" },
  emptyCategoryText: { paddingHorizontal: 2, paddingVertical: 10, fontSize: 13, color: "#B0AAA6" },
  emptyState: { paddingTop: 120, alignItems: "center" },
  emptyText: { fontSize: 17, color: "#777" },
});
