import { router } from "expo-router";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useEffect, useState } from "react";

import {
  ObservationDiaryEntry,
  observationDiaryEntries,
} from "../../data/observationDiary";
import { APP_USER_ID, apiJson } from "../../config/api";

type DiaryListEntry = ObservationDiaryEntry & {
  source: "cloud" | "local";
};

type DiaryGenerationResponse = {
  entry: ObservationDiaryEntry;
  replaced: boolean;
};

const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const getRecentDiaryDates = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());
  const value = (type: "year" | "month" | "day" | "hour") =>
    Number(parts.find((part) => part.type === type)?.value);
  const currentDiaryDate = new Date(
    Date.UTC(value("year"), value("month") - 1, value("day")),
  );
  if (value("hour") < 7) {
    currentDiaryDate.setUTCDate(currentDiaryDate.getUTCDate() - 1);
  }

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(currentDiaryDate);
    date.setUTCDate(date.getUTCDate() - index);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, "0");
    const day = String(date.getUTCDate()).padStart(2, "0");
    const dateKey = `${year}-${month}-${day}`;
    const weekday = new Intl.DateTimeFormat("zh-CN", {
      weekday: "short",
      timeZone: "UTC",
    }).format(date);

    return {
      dateKey,
      storedDate: `${year}.${month}.${day}`,
      label: index === 0 ? "今天" : index === 1 ? "昨天" : weekday,
      displayDate: `${month}月${day}日`,
    };
  });
};

const mergeDiaryEntries = (
  cloudEntries: ObservationDiaryEntry[],
  localEntries: ObservationDiaryEntry[],
) => {
  const seen = new Set<string>();

  return [
    ...cloudEntries.map((entry) => ({
      ...entry,
      source: "cloud" as const,
    })),
    ...localEntries.map((entry) => ({
      ...entry,
      source: "local" as const,
    })),
  ]
    .filter((entry) => {
      if (seen.has(entry.id)) {
        return false;
      }

      seen.add(entry.id);
      return true;
    })
    .sort((a, b) => {
      if (a.date === b.date) {
        return b.id.localeCompare(a.id);
      }

      return b.date.localeCompare(a.date);
    });
};

export default function ObservationDiaryScreen() {
  const [entries, setEntries] = useState<DiaryListEntry[]>(
    observationDiaryEntries.map((entry) => ({
      ...entry,
      source: "local",
    })),
  );
  const [writerVisible, setWriterVisible] = useState(false);
  const [selectedDate, setSelectedDate] = useState(
    () => getRecentDiaryDates()[0].dateKey,
  );
  const [generating, setGenerating] = useState(false);
  const recentDates = getRecentDiaryDates();

  useEffect(() => {
    loadDiaryEntries();
  }, []);

  const loadDiaryEntries = async () => {
    try {
      const cloudEntries = await apiJson<ObservationDiaryEntry[]>("/api/memory", {
        query: {
          type: "diary",
          user_id: APP_USER_ID,
        },
      });

      setEntries(mergeDiaryEntries(cloudEntries, observationDiaryEntries));
    } catch (error) {
      console.log("Diary load failed:", error);
    }
  };

  const deleteDiaryEntry = (entry: DiaryListEntry) => {
    if (entry.source !== "cloud") {
      Alert.alert("这篇先留着", "这是本地参考样本，暂时不从这里删除。");
      return;
    }

    Alert.alert(
      "删除这篇 Diary？",
      "删除后无法恢复，但不会影响小C已经记住的长期记忆。",
      [
        {
          text: "取消",
          style: "cancel",
        },
        {
          text: "删除",
          style: "destructive",
          onPress: async () => {
            try {
              await apiJson("/api/memory", {
                method: "DELETE",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  type: "diary",
                  user_id: APP_USER_ID,
                  id: entry.id,
                }),
              });

              setEntries((prev) =>
                prev.filter((item) => item.id !== entry.id),
              );
            } catch (error) {
              console.log("Diary delete failed:", error);
              Alert.alert("删除失败", "这篇 Diary 暂时没有删掉，等一下再试。");
            }
          },
        },
      ],
    );
  };

  const generateDiary = async (replaceExisting: boolean) => {
    setGenerating(true);
    try {
      const result = await apiJson<DiaryGenerationResponse>("/api/memory", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "diary",
          action: "generate_for_date",
          user_id: APP_USER_ID,
          target_date: selectedDate,
          replace_existing: replaceExisting,
        }),
        timeoutMs: 90000,
      });

      setEntries((previous) => {
        const cloudEntries = previous
          .filter(
            (entry) =>
              entry.source === "cloud" && entry.date !== result.entry.date,
          )
          .map(({ source: _source, ...entry }) => entry);
        return mergeDiaryEntries(
          [result.entry, ...cloudEntries],
          observationDiaryEntries,
        );
      });
      setWriterVisible(false);
      router.push({ pathname: "/diary/[id]", params: { id: result.entry.id } });
    } catch (error) {
      console.log("Diary generation failed:", error);
      Alert.alert(
        "这一页还没写好",
        error instanceof Error && error.message
          ? error.message
          : "旧日记没有改变，等一下再试。",
      );
    } finally {
      setGenerating(false);
    }
  };

  const requestDiaryGeneration = () => {
    const chosen = recentDates.find((item) => item.dateKey === selectedDate);
    const existing = entries.find(
      (entry) => entry.source === "cloud" && entry.date === chosen?.storedDate,
    );

    if (existing) {
      Alert.alert(
        "重写这一天？",
        "小C会重新读这一天的真实对话。新内容写成功后才会替换现在这一页。",
        [
          { text: "取消", style: "cancel" },
          { text: "重写", onPress: () => generateDiary(true) },
        ],
      );
      return;
    }

    generateDiary(false);
  };

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>

        <View style={styles.headerLine}>
          <Text style={styles.gentleLine}>关于她，我都想记得</Text>
          <Pressable
            style={({ pressed }) => [
              styles.writeButton,
              pressed && styles.writeButtonPressed,
            ]}
            onPress={() => {
              setSelectedDate(getRecentDiaryDates()[0].dateKey);
              setWriterVisible(true);
            }}
          >
            <Text style={styles.writeButtonText}>写一页</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {entries.map((entry) => (
          <Pressable
            key={entry.id}
            style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            onPress={() =>
              router.push({
                pathname: "/diary/[id]",
                params: {
                  id: entry.id,
                },
              })
            }
            onLongPress={() => deleteDiaryEntry(entry)}
          >
            <View>
              <Text style={styles.rowDate}>
                {entry.displayDate || entry.date.replaceAll(".", " · ")}
              </Text>
              <Text style={styles.rowTitle}>{entry.title}</Text>
            </View>

            <Text style={styles.rowMark}>›</Text>
          </Pressable>
        ))}
      </ScrollView>

      <Modal
        visible={writerVisible}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => !generating && setWriterVisible(false)}
      >
        <View style={styles.writerScreen}>
          <View style={styles.writerHeader}>
            <View>
              <Text style={styles.writerTitle}>写哪一天</Text>
              <Text style={styles.writerSubtitle}>一天从早上 7 点开始算</Text>
            </View>
            <Pressable
              disabled={generating}
              onPress={() => setWriterVisible(false)}
            >
              <Text style={styles.writerClose}>完成</Text>
            </Pressable>
          </View>

          <View style={styles.dateList}>
            {recentDates.map((item) => {
              const selected = selectedDate === item.dateKey;
              const hasEntry = entries.some(
                (entry) => entry.source === "cloud" && entry.date === item.storedDate,
              );
              return (
                <Pressable
                  key={item.dateKey}
                  disabled={generating}
                  style={({ pressed }) => [
                    styles.dateRow,
                    selected && styles.dateRowSelected,
                    pressed && styles.dateRowPressed,
                  ]}
                  onPress={() => setSelectedDate(item.dateKey)}
                >
                  <View>
                    <Text style={styles.dateLabel}>{item.label}</Text>
                    <Text style={styles.dateValue}>{item.displayDate}</Text>
                  </View>
                  <Text style={styles.dateState}>
                    {hasEntry ? "已有" : selected ? "✓" : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            disabled={generating}
            style={({ pressed }) => [
              styles.generateButton,
              pressed && !generating && styles.generateButtonPressed,
            ]}
            onPress={requestDiaryGeneration}
          >
            {generating ? (
              <View style={styles.generatingRow}>
                <ActivityIndicator size="small" color="#74685E" />
                <Text style={styles.generateButtonText}>小C正在翻这一天…</Text>
              </View>
            ) : (
              <Text style={styles.generateButtonText}>让小C写这一页</Text>
            )}
          </Pressable>
        </View>
      </Modal>
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
    fontSize: 15,
    lineHeight: 22,
    color: "#8A8A8F",
  },

  headerLine: {
    paddingHorizontal: 2,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  writeButton: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 14,
    backgroundColor: "rgba(120,120,128,0.07)",
  },

  writeButtonPressed: {
    backgroundColor: "rgba(120,120,128,0.13)",
  },

  writeButtonText: {
    fontSize: 14,
    color: "#786C62",
  },

  scroll: {
    flex: 1,
  },

  content: {
    paddingHorizontal: 24,
    paddingBottom: 40,
  },

  row: {
    backgroundColor: "rgba(255,255,255,0.42)",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 15,
    marginTop: 10,
    shadowColor: "#000",
    shadowOpacity: 0.025,
    shadowRadius: 12,
    shadowOffset: {
      width: 0,
      height: 5,
    },
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  rowPressed: {
    backgroundColor: "rgba(242,242,247,0.92)",
  },

  rowDate: {
    fontSize: 12,
    letterSpacing: 1.5,
    color: "#B5A898",
    marginBottom: 6,
  },

  rowTitle: {
    fontSize: 16,
    lineHeight: 22,
    color: "#3F3F3F",
    fontWeight: "400",
  },

  rowMark: {
    fontSize: 26,
    color: "#C8BFB5",
  },

  writerScreen: {
    flex: 1,
    backgroundColor: "#FBF8F3",
    paddingHorizontal: 24,
    paddingTop: 24,
    paddingBottom: 30,
  },

  writerHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: 22,
  },

  writerTitle: {
    fontSize: 22,
    lineHeight: 28,
    color: "#3F3F3F",
  },

  writerSubtitle: {
    marginTop: 5,
    fontSize: 13,
    color: "#A19A94",
  },

  writerClose: {
    paddingVertical: 4,
    fontSize: 16,
    color: "#75695F",
  },

  dateList: {
    gap: 8,
  },

  dateRow: {
    minHeight: 58,
    paddingHorizontal: 16,
    borderRadius: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(255,255,255,0.5)",
  },

  dateRowSelected: {
    backgroundColor: "rgba(222,213,202,0.42)",
  },

  dateRowPressed: {
    opacity: 0.72,
  },

  dateLabel: {
    fontSize: 16,
    color: "#47433F",
  },

  dateValue: {
    marginTop: 2,
    fontSize: 12,
    color: "#A39A91",
  },

  dateState: {
    fontSize: 13,
    color: "#988A7D",
  },

  generateButton: {
    minHeight: 50,
    marginTop: 20,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(215,205,194,0.58)",
  },

  generateButtonPressed: {
    backgroundColor: "rgba(205,194,182,0.72)",
  },

  generatingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },

  generateButtonText: {
    fontSize: 15,
    color: "#675E56",
  },
});
