import { router, useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { APP_USER_ID, apiJson } from "../../config/api";

type WeMemory = {
  id: string;
  title: string;
  content: string;
  tags?: string[];
  domains?: string[];
  importance?: number;
  pinned?: boolean;
  createdAt?: string;
  lastActiveAt?: string;
};

type CategoryResponse = {
  category: string;
  total: number;
  items: WeMemory[];
};

const normalizeParam = (value?: string | string[]) =>
  String(Array.isArray(value) ? value[0] : value || "").trim();

const formatDate = (value?: string) => {
  if (!value) return "";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replaceAll("/", ".");
};

const trimContent = (content: string, max = 80) => {
  const text = String(content || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max).trim()}…` : text;
};

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
        query: {
          type: "we",
          category,
          user_id: APP_USER_ID,
        },
        timeoutMs: 16000,
      });

      setItems(response.items || []);
    } catch (error) {
      console.log("Memory category load failed:", error);
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, [category]);

  useFocusEffect(
    useCallback(() => {
      loadMemories();
    }, [loadMemories]),
  );

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>

        <Text style={styles.title}>{category || "记忆"}</Text>
        <Text style={styles.subtitle}>这些，我都还记得。</Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadMemories} />
        }
      >
        {failed && items.length === 0 ? (
          <Pressable style={styles.state} onPress={loadMemories}>
            <Text style={styles.stateText}>暂时没有读到，轻点再试一次。</Text>
          </Pressable>
        ) : !loading && items.length === 0 ? (
          <View style={styles.state}>
            <Text style={styles.stateText}>这里暂时没有记忆。</Text>
          </View>
        ) : (
          items.map((memory) => {
            const date = formatDate(memory.lastActiveAt || memory.createdAt);
            const chips = [...new Set([
              ...(memory.domains || []),
              ...(memory.tags || []),
            ].filter(Boolean))].slice(0, 2);

            return (
              <Pressable
                key={memory.id}
                style={({ pressed }) => [
                  styles.card,
                  pressed && styles.cardPressed,
                ]}
                onPress={() =>
                  router.push({
                    pathname: "/we/[id]",
                    params: {
                      id: memory.id,
                      title: memory.title,
                      content: memory.content,
                      tags: JSON.stringify(memory.tags || []),
                      domains: JSON.stringify(memory.domains || []),
                      pinned: memory.pinned ? "1" : "0",
                      importance: String(memory.importance ?? ""),
                      createdAt: memory.createdAt || "",
                      lastActiveAt: memory.lastActiveAt || "",
                    },
                  })
                }
              >
                <View style={styles.cardHeader}>
                  <Text style={styles.cardTitle}>{memory.title}</Text>
                  {!!date && <Text style={styles.date}>{date}</Text>}
                </View>

                <Text style={styles.body}>
                  {trimContent(memory.content || memory.title)}
                </Text>

                {chips.length > 0 && (
                  <View style={styles.chipRow}>
                    {chips.map((chip) => (
                      <Text key={`${memory.id}-chip-${chip}`} style={styles.chip}>
                        {chip}
                      </Text>
                    ))}
                  </View>
                )}
              </Pressable>
            );
          })
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#FBF8F3" },
  header: { paddingTop: 58, paddingHorizontal: 24, paddingBottom: 14 },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
    marginBottom: 22,
  },
  backText: { fontSize: 32, lineHeight: 34, color: "#555" },
  title: { fontSize: 24, lineHeight: 31, color: "#3F3A37", fontWeight: "600" },
  subtitle: { marginTop: 7, fontSize: 14, lineHeight: 21, color: "#9A918C" },
  scroll: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 46 },
  card: {
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 15,
    marginBottom: 12,
    backgroundColor: "rgba(255,255,255,0.66)",
    shadowColor: "#B8AFA7",
    shadowOpacity: 0.05,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
  },
  cardPressed: { backgroundColor: "rgba(242,242,247,0.92)" },
  cardHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 9,
  },
  cardTitle: { flex: 1, marginRight: 12, fontSize: 16, lineHeight: 22, color: "#3F3A37" },
  date: { fontSize: 12, color: "#B8B0AA" },
  body: { fontSize: 14, lineHeight: 21, color: "#615B57" },
  chipRow: { flexDirection: "row", flexWrap: "wrap", marginTop: 12, gap: 8 },
  chip: {
    overflow: "hidden",
    borderRadius: 13,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "rgba(120,120,128,0.08)",
    fontSize: 12,
    color: "#8A817C",
  },
  state: { paddingVertical: 100, alignItems: "center" },
  stateText: { fontSize: 14, color: "#9A918C" },
});
