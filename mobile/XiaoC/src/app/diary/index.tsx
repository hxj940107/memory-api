import { router } from "expo-router";
import {
  Alert,
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

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>

        <Text style={styles.gentleLine}>关于她，我都想记得</Text>
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
});
