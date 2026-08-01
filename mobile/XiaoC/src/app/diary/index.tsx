import { router } from "expo-router";
import {
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

export default function ObservationDiaryScreen() {
  const [entries, setEntries] = useState<ObservationDiaryEntry[]>(
    observationDiaryEntries,
  );

  useEffect(() => {
    loadDiaryEntries();
  }, []);

  const loadDiaryEntries = async () => {
    try {
      const cloudEntries = await apiJson<ObservationDiaryEntry[]>("/api/diary", {
        query: {
          user_id: APP_USER_ID,
        },
      });

      if (cloudEntries.length > 0) {
        setEntries(cloudEntries);
      }
    } catch (error) {
      console.log("Diary load failed:", error);
    }
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
