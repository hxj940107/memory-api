import { router, useFocusEffect } from "expo-router";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useCallback, useState } from "react";

import { APP_USER_ID, apiJson } from "../config/api";

type WeMemory = {
  id: string;
  title: string;
  content: string;
  tags?: string[];
  domains?: string[];
  type?: string;
  importance?: number;
  pinned?: boolean;
  score?: number;
  createdAt?: string;
  lastActiveAt?: string;
};

type WeCategory = {
  name: string;
  total: number;
  items: WeMemory[];
};

type WeMemoryResponse = {
  source: string;
  total: number;
  pinnedTotal: number;
  recentCount: number;
  recentWindowLabel: string;
  pinned: WeMemory[];
  categories: WeCategory[];
  recent: WeMemory[];
};

const emptyData: WeMemoryResponse = {
  source: "empty",
  total: 0,
  pinnedTotal: 0,
  recentCount: 0,
  recentWindowLabel: "最近 7 天",
  pinned: [],
  categories: [],
  recent: [],
};

const formatDate = (value?: string) => {
  if (!value) {
    return "";
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  })
    .format(date)
    .replaceAll("/", ".");
};

const trimContent = (content: string, max = 120) => {
  const text = String(content || "").replace(/\s+/g, " ").trim();

  if (text.length <= max) {
    return text;
  }

  return `${text.slice(0, max).trim()}…`;
};

function MemoryCard({
  memory,
  pinned,
}: {
  memory: WeMemory;
  pinned?: boolean;
}) {
  const date = formatDate(memory.lastActiveAt || memory.createdAt);
  const preview = trimContent(memory.content || memory.title, 42);
  const chips = [
    ...(memory.domains || []),
    ...(memory.tags || []),
  ]
    .filter(Boolean)
    .slice(0, 2);

  return (
    <Pressable
      style={({ pressed }) => [
        styles.memoryCard,
        pinned && styles.pinnedCard,
        pressed && styles.memoryCardPressed,
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
      <View style={styles.memoryHeader}>
        <Text style={[styles.memoryTitle, pinned && styles.pinnedTitle]}>
          {pinned ? "📌 " : ""}
          {memory.title}
        </Text>

        {!!date && <Text style={styles.memoryDate}>{date}</Text>}
      </View>

      {!!preview && <Text style={styles.memoryContent}>{preview}</Text>}

      {chips.length > 0 && (
        <View style={styles.chipRow}>
          {chips.map((chip) => (
            <Text key={`${memory.id}-${chip}`} style={styles.chip}>
              {chip}
            </Text>
          ))}
        </View>
      )}
    </Pressable>
  );
}

function MemorySection({
  title,
  items,
  total,
}: {
  title: string;
  items: WeMemory[];
  total?: number;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>

        {typeof total === "number" && total > items.length && (
          <Pressable
            hitSlop={10}
            onPress={() =>
              router.push({
                pathname: "/we/category",
                params: { category: title },
              })
            }
          >
            <Text style={styles.viewAllText}>查看全部  ›</Text>
          </Pressable>
        )}
      </View>

      {items.map((memory) => (
        <MemoryCard key={memory.id} memory={memory} />
      ))}
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
        query: {
          type: "we",
          user_id: APP_USER_ID,
        },
        timeoutMs: 16000,
      });

      setData(response);
    } catch (error) {
      console.log("We memory load failed:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      loadMemories();
    }, [loadMemories]),
  );

  const hasAnyMemory =
    data.pinned.length > 0 ||
    data.categories.some((category) => category.items.length > 0) ||
    data.recent.length > 0;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>

        <Text style={styles.gentleLine}>
          我慢慢记得了你，也记得了我们。
        </Text>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl refreshing={loading} onRefresh={loadMemories} />
        }
      >
        <View style={styles.overviewCard}>
          <View>
            <Text style={styles.overviewLabel}>已留下</Text>
            <Text style={styles.overviewValue}>{data.total}</Text>
          </View>

          <View style={styles.overviewDivider} />

          <View>
            <Text style={styles.overviewLabel}>钉选</Text>
            <Text style={styles.overviewValue}>{data.pinnedTotal}</Text>
          </View>

          <View style={styles.overviewDivider} />

          <View>
            <Text style={styles.overviewLabel}>{data.recentWindowLabel}</Text>
            <Text style={styles.overviewValue}>{data.recentCount}</Text>
          </View>
        </View>

        {!data.source.startsWith("ombre") && hasAnyMemory && (
          <Text style={styles.sourceHint}>
            现在先显示小C能浮起来的记忆。等“我们”再接深一点，这里会慢慢变完整。
          </Text>
        )}

        {!hasAnyMemory ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>这里还没有浮出来的记忆。</Text>
            <Text style={styles.emptySubtext}>等小C多记住一点，我们再回来。</Text>
          </View>
        ) : (
          <>
            {data.pinned.length > 0 && (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, styles.standaloneSectionTitle]}>
                  最重要
                </Text>

                {data.pinned.map((memory) => (
                  <MemoryCard key={memory.id} memory={memory} pinned />
                ))}
              </View>
            )}

            {data.categories.map((category) => (
              <MemorySection
                key={category.name}
                title={category.name}
                items={category.items}
                total={category.total}
              />
            ))}

            <MemorySection title="最近留下" items={data.recent} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#FBF8F3",
  },

  header: {
    paddingTop: 58,
    paddingHorizontal: 24,
    paddingBottom: 10,
  },

  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
    marginBottom: 26,
  },

  backText: {
    fontSize: 32,
    lineHeight: 34,
    color: "#555",
  },

  gentleLine: {
    paddingHorizontal: 2,
    fontSize: 15,
    lineHeight: 22,
    color: "#8A8A8F",
  },

  scroll: {
    flex: 1,
  },

  content: {
    paddingHorizontal: 24,
    paddingTop: 10,
    paddingBottom: 46,
  },

  overviewCard: {
    minHeight: 86,
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 16,
    backgroundColor: "rgba(255,255,255,0.82)",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    shadowColor: "#B8AFA7",
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: {
      width: 0,
      height: 8,
    },
  },

  overviewLabel: {
    fontSize: 13,
    color: "#A69D98",
    marginBottom: 6,
  },

  overviewValue: {
    fontSize: 24,
    color: "#3F3A37",
    fontWeight: "500",
  },

  overviewDivider: {
    width: 1,
    height: 34,
    backgroundColor: "rgba(120,120,128,0.12)",
  },

  sourceHint: {
    marginTop: 14,
    paddingHorizontal: 4,
    fontSize: 13,
    lineHeight: 19,
    color: "#A69D98",
  },

  section: {
    marginTop: 24,
  },

  sectionTitle: {
    paddingHorizontal: 2,
    fontSize: 14,
    color: "#A69D98",
    fontWeight: "600",
  },

  sectionHeader: {
    minHeight: 26,
    marginBottom: 10,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  standaloneSectionTitle: {
    marginBottom: 10,
  },

  viewAllText: {
    paddingHorizontal: 2,
    fontSize: 13,
    color: "#8A817C",
  },

  memoryCard: {
    borderRadius: 22,
    paddingHorizontal: 18,
    paddingVertical: 15,
    marginBottom: 12,
    backgroundColor: "rgba(255,255,255,0.58)",
    shadowColor: "#B8AFA7",
    shadowOpacity: 0.05,
    shadowRadius: 14,
    shadowOffset: {
      width: 0,
      height: 6,
    },
  },

  memoryCardPressed: {
    backgroundColor: "rgba(242,242,247,0.92)",
  },

  pinnedCard: {
    backgroundColor: "rgba(255,255,255,0.9)",
    borderWidth: 1,
    borderColor: "rgba(206,196,184,0.46)",
  },

  memoryHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
    marginBottom: 9,
  },

  memoryTitle: {
    flex: 1,
    marginRight: 12,
    fontSize: 16,
    lineHeight: 22,
    color: "#3F3A37",
  },

  pinnedTitle: {
    fontWeight: "600",
  },

  memoryDate: {
    fontSize: 12,
    color: "#B8B0AA",
  },

  memoryContent: {
    fontSize: 14,
    lineHeight: 21,
    color: "#615B57",
  },

  chipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: 12,
    gap: 8,
  },

  chip: {
    overflow: "hidden",
    borderRadius: 13,
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: "rgba(120,120,128,0.08)",
    fontSize: 12,
    color: "#8A817C",
  },

  emptyState: {
    paddingTop: 120,
    alignItems: "center",
  },

  emptyText: {
    fontSize: 17,
    color: "#777",
  },

  emptySubtext: {
    marginTop: 10,
    fontSize: 14,
    color: "#B0AAA6",
  },
});
