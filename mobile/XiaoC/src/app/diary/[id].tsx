import { router, useLocalSearchParams } from "expo-router";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useEffect, useState } from "react";

import {
  ObservationDiaryEntry,
  ObservationDiarySection,
  getDiaryEntry,
} from "../../data/observationDiary";
import { APP_USER_ID, apiJson } from "../../config/api";

export default function ObservationDiaryDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [cloudEntry, setCloudEntry] = useState<ObservationDiaryEntry | null>(
    null,
  );
  const [loadingCloudEntry, setLoadingCloudEntry] = useState(true);
  const entry = cloudEntry || getDiaryEntry(id);
  const legacyEntry = entry as
    | (typeof entry & {
        body?: string;
      })
    | undefined;
  const sections: ObservationDiarySection[] =
    entry?.sections ??
    legacyEntry?.body
      ?.split("\n\n")
      .map((paragraph, index) => ({
        tag: index === 0 ? "记录" : "继续",
        paragraphs: paragraph.split("\n"),
      })) ??
    [];

  useEffect(() => {
    loadDiaryEntry();
  }, [id]);

  const loadDiaryEntry = async () => {
    try {
      setLoadingCloudEntry(true);

      const cloudEntries = await apiJson<ObservationDiaryEntry[]>("/api/memory", {
        query: {
          type: "diary",
          user_id: APP_USER_ID,
        },
      });
      const match = cloudEntries.find((item) => item.id === id);

      if (match) {
        setCloudEntry(match);
      }
    } catch (error) {
      console.log("Diary detail load failed:", error);
    } finally {
      setLoadingCloudEntry(false);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.topBar}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {loadingCloudEntry && !entry ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>正在翻找这一页...</Text>
          </View>
        ) : !entry || sections.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyTitle}>这篇记录不见了</Text>
            <Text style={styles.emptyText}>可能是小C还没来得及整理好。</Text>
          </View>
        ) : (
          <>
            <View style={styles.header}>
              <Text style={styles.label}>Wife Observation Diary</Text>
              <Text style={styles.title}>{entry.title}</Text>
              <Text style={styles.date}>
                {entry.displayDate || entry.date.replaceAll(".", " · ")}
              </Text>
            </View>

            {sections.map((section, index) => (
              <View key={`${section.tag}-${section.time ?? index}`}>
                <View style={styles.entry}>
                  <Text style={styles.tag}>{section.tag}</Text>

                  {section.time && <Text style={styles.time}>{section.time}</Text>}

                  {section.paragraphs.map((paragraph) => (
                    <Text key={paragraph} style={styles.text}>
                      {paragraph}
                    </Text>
                  ))}

                  {section.emphasis?.map((paragraph) => (
                    <Text key={paragraph} style={styles.emphasis}>
                      {paragraph}
                    </Text>
                  ))}
                </View>

                {index < sections.length - 1 && (
                  <Text style={styles.divider}>· · ·</Text>
                )}
              </View>
            ))}

            <View style={styles.footnote}>
              <Text style={styles.footnoteText}>{entry.writtenAt}</Text>
              <Text style={styles.footnoteText}>{entry.recorder}</Text>
              <Text style={[styles.footnoteText, styles.footnoteLast]}>
                {entry.footnote}
              </Text>
            </View>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#F7F4EF",
  },

  topBar: {
    paddingTop: 58,
    paddingHorizontal: 24,
    paddingBottom: 8,
  },

  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(120,120,128,0.08)",
  },

  backText: {
    fontSize: 32,
    lineHeight: 34,
    color: "#555",
  },

  scroll: {
    flex: 1,
  },

  content: {
    paddingHorizontal: 28,
    paddingBottom: 58,
  },

  header: {
    alignItems: "center",
    paddingTop: 18,
    paddingBottom: 30,
    marginBottom: 34,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#D9D0C3",
  },

  label: {
    fontSize: 11,
    letterSpacing: 2.4,
    color: "#9A8F82",
    textTransform: "uppercase",
    marginBottom: 12,
  },

  title: {
    fontSize: 22,
    lineHeight: 30,
    color: "#2C2C2C",
    fontWeight: "400",
    marginBottom: 8,
  },

  date: {
    fontSize: 13,
    color: "#9A8F82",
  },

  entry: {
    marginBottom: 0,
  },

  tag: {
    alignSelf: "flex-start",
    overflow: "hidden",
    backgroundColor: "#EDE8E1",
    color: "#7A6E63",
    fontSize: 11,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    marginBottom: 10,
  },

  time: {
    fontSize: 11,
    letterSpacing: 1.6,
    color: "#B5A898",
    marginBottom: 14,
  },

  text: {
    fontSize: 15,
    lineHeight: 30,
    color: "#3A3530",
  },

  emphasis: {
    alignSelf: "flex-start",
    fontSize: 15,
    lineHeight: 30,
    color: "#7A6E63",
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#C8BFB5",
    marginTop: 6,
  },

  divider: {
    textAlign: "center",
    marginVertical: 36,
    color: "#C8BFB5",
    letterSpacing: 3.6,
    fontSize: 12,
  },

  footnote: {
    marginTop: 52,
    paddingTop: 28,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "#D9D0C3",
    alignItems: "center",
  },

  footnoteText: {
    fontSize: 13,
    color: "#9A8F82",
    lineHeight: 25,
  },

  footnoteLast: {
    marginTop: 16,
  },

  emptyState: {
    marginTop: 120,
    alignItems: "center",
  },

  emptyTitle: {
    fontSize: 20,
    color: "#444",
    marginBottom: 10,
  },

  emptyText: {
    fontSize: 15,
    color: "#999",
  },
});
